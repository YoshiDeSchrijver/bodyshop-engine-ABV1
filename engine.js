const fs = require('fs');
const path = require('path');

let benchmarks = {};
let thresholds = {};

try {
  const filePath = path.join(__dirname, 'formulas.json');

  if (!fs.existsSync(filePath)) {
    throw new Error('formulas.json not found');
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  benchmarks = parsed.benchmarks;
  thresholds = parsed.thresholds;

  console.log("formulas.json loaded successfully");

} catch (err) {
  console.error("Error loading formulas.json:", err.message);

  // Optional: fallback defaults (keeps engine stable)
  benchmarks = benchmarks || {};
  thresholds = thresholds || {};
}

// ── Mode detection ────────────────────────────────────────────────────────────
function detectMode(input) {
  const required = [
    'company_product_usage_per_repair',
    'company_product_price_per_unit',
    'improvement_factor',
    'investment_cost',
  ];
  return required.every(f => input[f] !== undefined && input[f] !== null) ? 'B' : 'A';
}

// ── Resolve inputs against benchmark defaults ─────────────────────────────────
function resolveInputs(userInput) {
  const resolved = {};
  const sources  = {};

  const overridable = [
    'average_preparation_time_per_repair',
    'average_paint_time_per_repair',
    'average_booth_cycle_time_per_repair',
    'working_days_per_year',
    'labour_available_hours',
    'booth_available_hours',
    'fte_hours_per_year',
    'labour_cost_per_hour',
    'benchmark_usage_per_repair',
  ];

  for (const key of overridable) {
    if (userInput[key] !== undefined) {
      resolved[key] = userInput[key];
      sources[key]  = 'user';
    } else if (benchmarks[key] !== undefined) {
      resolved[key] = benchmarks[key];
      sources[key]  = 'benchmark';
    }
  }

  // Required user inputs
  for (const key of ['repairs_per_year', 'preparation_workers', 'spray_painters', 'amount_spraybooths']) {
    resolved[key] = userInput[key];
    sources[key]  = 'user';
  }

  // User current product — optional, enables consumption layer
  resolved.user_product_usage_per_repair = userInput.user_product_usage_per_repair ?? null;
  resolved.user_product_price_per_unit   = userInput.user_product_price_per_unit   ?? null;
  sources.user_product_usage_per_repair  = resolved.user_product_usage_per_repair ? 'user' : 'not provided';
  sources.user_product_price_per_unit    = resolved.user_product_price_per_unit   ? 'user' : 'not provided';

  // Company product — Mode B only
  resolved.company_product_usage_per_repair = userInput.company_product_usage_per_repair ?? null;
  resolved.company_product_price_per_unit   = userInput.company_product_price_per_unit   ?? null;
  resolved.improvement_factor               = userInput.improvement_factor               ?? null;
  resolved.prep_improvement_factor          = userInput.prep_improvement_factor          ?? null;
  resolved.paint_improvement_factor         = userInput.paint_improvement_factor         ?? null;
  resolved.booth_improvement_factor         = userInput.booth_improvement_factor         ?? null;
  resolved.investment_cost                  = userInput.investment_cost                  ?? null;

  // ── Derived — always computed from resolved values, never hardcoded ────────
  resolved.average_labour_time_per_repair =
    resolved.average_preparation_time_per_repair +
    resolved.average_paint_time_per_repair;

  resolved.current_cycle_time_per_repair =
    resolved.average_preparation_time_per_repair +
    resolved.average_paint_time_per_repair +
    resolved.average_booth_cycle_time_per_repair;

  resolved.labour_fraction =
    resolved.average_labour_time_per_repair /
    resolved.current_cycle_time_per_repair;

  return { resolved, sources };
}

// ── MODE A ────────────────────────────────────────────────────────────────────
function runModeA(input) {
  const { resolved, sources } = resolveInputs(input);
  const r       = resolved;
  const results = {};
  const missing = [];

  // Demand
  results.repairs_per_day = r.repairs_per_year / r.working_days_per_year;

  // Capacity hours
  results.prep_capacity_hours  = r.preparation_workers * r.labour_available_hours;
  results.paint_capacity_hours = r.spray_painters      * r.labour_available_hours;
  results.booth_capacity_hours = r.amount_spraybooths  * r.booth_available_hours;

  // Labour availability + demand
  results.labour_hours_available = (r.preparation_workers + r.spray_painters) * r.labour_available_hours;
  results.labour_hours_used      = r.repairs_per_year * r.average_labour_time_per_repair;

  // Utilisation
  results.utilisation      = results.labour_hours_used / results.labour_hours_available;
  results.booth_hours_used  = r.repairs_per_year * r.average_booth_cycle_time_per_repair;
  results.booth_utilisation = results.booth_hours_used / results.booth_capacity_hours;

  // Bottleneck layer — runs before flow efficiency
  results.prep_repairs_possible  = results.prep_capacity_hours  / r.average_preparation_time_per_repair;
  results.paint_repairs_possible = results.paint_capacity_hours / r.average_paint_time_per_repair;
  results.booth_repairs_possible = results.booth_capacity_hours / r.average_booth_cycle_time_per_repair;

  results.system_throughput_per_year = Math.min(
    results.prep_repairs_possible,
    results.paint_repairs_possible,
    results.booth_repairs_possible
  );

  const stageValues = {
    Preparation: results.prep_repairs_possible,
    Painting:    results.paint_repairs_possible,
    Booth:       results.booth_repairs_possible,
  };
  results.bottleneck_process = Object.keys(stageValues)
    .filter(k => stageValues[k] === results.system_throughput_per_year);

  results.capacity_gap             = results.system_throughput_per_year - r.repairs_per_year;
  results.actual_repairs_completed = Math.min(r.repairs_per_year, results.system_throughput_per_year);

  // Flow efficiency
  results.flow_efficiency = results.system_throughput_per_year / r.repairs_per_year;

  // Consumption layer — requires user product data
  const canRunConsumption = r.user_product_usage_per_repair !== null &&
                            r.user_product_price_per_unit   !== null;

  if (canRunConsumption) {
    const vol = results.actual_repairs_completed;
    results.annual_material_usage        = vol * r.user_product_usage_per_repair;
    results.cost_per_repair              = r.user_product_usage_per_repair * r.user_product_price_per_unit;
    results.total_material_cost_per_year = results.cost_per_repair * vol;

    // Workload distribution (model 4 — must precede model 5)
    results.prep_workload_hours  = vol * r.average_preparation_time_per_repair;
    results.paint_workload_hours = vol * r.average_paint_time_per_repair;
    results.booth_workload_hours = vol * r.average_booth_cycle_time_per_repair;
    results.total_workload_hours = results.prep_workload_hours + results.paint_workload_hours;

    results.prep_workload_pct  = (results.prep_workload_hours  / results.total_workload_hours) * 100;
    results.paint_workload_pct = (results.paint_workload_hours / results.total_workload_hours) * 100;

    // Process cost contribution (model 5)
    results.prep_cost_contribution  = results.prep_workload_pct;
    results.paint_cost_contribution = results.paint_workload_pct;

    // Benchmark deviation
    if (r.benchmark_usage_per_repair) {
      results.deviation_pct =
        ((r.user_product_usage_per_repair - r.benchmark_usage_per_repair) /
          r.benchmark_usage_per_repair) * 100;
    }
  } else {
    missing.push({
      layer:  'Consumption',
      reason: 'user_product_usage_per_repair and user_product_price_per_unit not provided',
      unlock: 'Add your current product usage and price per unit',
    });
  }

  // Scenario classification
  const u = results.utilisation;
  results.utilisation_scenario =
    u < thresholds.utilisation_underutilised ? 'Underutilised' :
    u <= thresholds.utilisation_overloaded   ? 'Balanced'      : 'Overloaded';

  const bu = results.booth_utilisation;
  results.booth_utilisation_scenario =
    bu < thresholds.utilisation_underutilised ? 'Underutilised' :
    bu <= thresholds.utilisation_overloaded   ? 'Balanced'      : 'Overloaded';

  results.system_status = results.capacity_gap >= 0 ? 'Excess capacity' : 'Under capacity';

  results.savings_type = results.utilisation >= thresholds.savings_type_threshold
    ? 'Cost saving' : 'Capacity gain';

    // Mode A savings range — conservative (1.1) to optimistic (1.3)
const _ct  = r.current_cycle_time_per_repair;
const _lf  = r.labour_fraction;
const _vol = results.actual_repairs_completed;
const _lc  = r.labour_cost_per_hour;

results.savings_range = {
  low:  Math.round((_ct - _ct / 1.1) * _lf * _vol * _lc),
  mid:  Math.round((_ct - _ct / 1.2) * _lf * _vol * _lc),
  high: Math.round((_ct - _ct / 1.3) * _lf * _vol * _lc),
  factor_low:  1.1,
  factor_high: 1.3,
  note: 'Mode A estimate — range based on 10%–30% process improvement scenarios',
};

  if (results.deviation_pct !== undefined) {
    results.consumption_scenario =
      results.deviation_pct > 0 ? 'Consumption-heavy' : 'Efficient';
  }

  if (canRunConsumption && results.deviation_pct !== undefined) {
    const over  = results.utilisation > thresholds.utilisation_overloaded;
    const under = results.utilisation < thresholds.utilisation_underutilised;
    const waste = results.deviation_pct > 0;
    results.combined_scenario =
      under && waste  ? 'Low utilisation + high waste' :
      over  && waste  ? 'Overloaded + inefficient'     :
      !under && !waste ? 'Optimised operation'          : 'Mixed signals';
  }

  return { mode: 'A', inputs_used: resolved, data_sources: sources, results, missing };
}

// ── MODE B ────────────────────────────────────────────────────────────────────
function runModeB(input) {
  const modeAOutput            = runModeA(input);
  const { resolved, sources }  = resolveInputs(input);
  const r                      = resolved;
  const results                = { ...modeAOutput.results };
  const missing                = [...modeAOutput.missing];

  // Hard requirement: user product data must exist for cost comparison
  if (results.cost_per_repair === undefined) {
    missing.push({
      layer:  'Mode B — Cost comparison',
      reason: 'user_product_usage_per_repair and user_product_price_per_unit required for cost delta',
      unlock: 'Provide your current product usage and price per unit',
    });
  }

  // Guard: confirm all Mode B inputs present
  if (!r.improvement_factor || !r.company_product_usage_per_repair || !r.company_product_price_per_unit) {
    missing.push({ layer: 'Mode B', reason: 'Company data incomplete', unlock: 'Provide all company product fields' });
    return { ...modeAOutput, missing };
  }

  // ── Stage-specific improvement factors — fall back to uniform if not set ──
  const prepFactor  = r.prep_improvement_factor  ?? r.improvement_factor;
  const paintFactor = r.paint_improvement_factor ?? r.improvement_factor;
  const boothFactor = r.booth_improvement_factor ?? r.improvement_factor;

  const optimized_prep_time  = r.average_preparation_time_per_repair / prepFactor;
  const optimized_paint_time = r.average_paint_time_per_repair        / paintFactor;
  const optimized_booth_time = r.average_booth_cycle_time_per_repair  / boothFactor;

  results.optimized_cycle_time_per_repair =
    optimized_prep_time + optimized_paint_time + optimized_booth_time;

  // ── Optimized throughput — recalculate with improved stage times ───────────
  const opt_prep_max  = r.preparation_workers * r.labour_available_hours / optimized_prep_time;
  const opt_paint_max = r.spray_painters      * r.labour_available_hours / optimized_paint_time;
  const opt_booth_max = r.amount_spraybooths  * r.booth_available_hours  / optimized_booth_time;
  results.optimized_throughput_per_year = Math.min(opt_prep_max, opt_paint_max, opt_booth_max);
  const optimized_actual = Math.min(r.repairs_per_year, results.optimized_throughput_per_year);
  results.optimized_actual_repairs = optimized_actual;

  // ── Optimized labour time — derived from stage factors, not uniform ────────
  results.optimized_labour_time_per_repair = optimized_prep_time + optimized_paint_time;
  // Use repairs_per_year (not optimized_actual) so utilisation delta reflects
  // pure efficiency gain, not a volume switch
  results.optimized_labour_hours_used =
    r.repairs_per_year * results.optimized_labour_time_per_repair;
  results.optimized_utilisation =
    results.optimized_labour_hours_used / results.labour_hours_available;

  const ou = results.optimized_utilisation;
  results.optimized_utilisation_scenario =
    ou < thresholds.utilisation_underutilised ? 'Underutilised' :
    ou <= thresholds.utilisation_overloaded   ? 'Balanced'      : 'Overloaded';

  // ── Time savings ──────────────────────────────────────────────────────────
  results.cycle_time_saved_per_repair =
    r.current_cycle_time_per_repair - results.optimized_cycle_time_per_repair;
  // Derived from stage times directly — correct for both uniform and stage-specific factors
  results.labour_time_saved_per_repair =
    r.average_labour_time_per_repair - results.optimized_labour_time_per_repair;

  results.total_cycle_time_saved_per_year  =
    results.cycle_time_saved_per_repair  * optimized_actual;
  results.total_labour_time_saved_per_year =
    results.labour_time_saved_per_repair * optimized_actual;

  // ── FTE — uses labour time only, per spec ─────────────────────────────────
  // FIX: was using total_cycle_time_saved_per_year — corrected to labour time
  results.fte_saved = results.total_labour_time_saved_per_year / r.fte_hours_per_year;

  // ── Financial savings — labour fraction already applied ───────────────────
  results.financial_savings_per_year =
    results.total_labour_time_saved_per_year * r.labour_cost_per_hour;

  // ── Cost comparison ───────────────────────────────────────────────────────
  results.optimized_cost_per_repair =
    r.company_product_usage_per_repair * r.company_product_price_per_unit;

  // FIX: hard-require cost_per_repair — no silent zero fallback
  const currentCost = results.cost_per_repair;
  if (currentCost !== undefined) {
    results.additional_product_cost_per_year =
      (results.optimized_cost_per_repair - currentCost) * optimized_actual;
    results.net_value =
      results.financial_savings_per_year - results.additional_product_cost_per_year;

    // ROI
    if (!r.investment_cost || r.investment_cost === 0) {
      results.roi_pct        = null;
      results.recommendation = results.net_value > 0
        ? 'Adopt — no switching cost, positive net value'
        : 'Do not adopt — no benefit';
    } else {
      results.roi_pct        = (results.net_value / r.investment_cost) * 100;
      results.recommendation = results.roi_pct > 0
        ? 'Positive ROI — recommend adoption'
        : 'Negative ROI — do not recommend';
    }
  }

  return { mode: 'B', inputs_used: resolved, data_sources: sources, results, missing };
}

// ── Main entry point — auto-detects mode ─────────────────────────────────────
function run(userInput) {
  return detectMode(userInput) === 'B' ? runModeB(userInput) : runModeA(userInput);
}

module.exports = { detectMode, resolveInputs, runModeA, runModeB, run };
