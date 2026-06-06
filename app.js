const SW_RATIOS = [
  { label: "1:1", value: 1 },
  { label: "6:5", value: 6 / 5 },
  { label: "3:2", value: 3 / 2 },
  { label: "9:5", value: 9 / 5 },
  { label: "2:1", value: 2 },
  { label: "5:2", value: 5 / 2 },
  { label: "3:1", value: 3 }
];

const SPEED_UNITS = {
  "m/s": { toMps: 1, fromMps: 1 },
  "km/h": { toMps: 1 / 3.6, fromMps: 3.6 },
  "mph": { toMps: 0.44704, fromMps: 2.2369362921 },
  "knots": { toMps: 0.514444, fromMps: 1.9438461718 }
};

const MAX_STAGES = 4;
const STAGE_NAMES = ["A", "B", "C", "D"];
const GEARBOX_EFFICIENCY_PER_PASS = 0.95;
const BEAM_SIZE = 350;

const state = {
  selectedGear: "5",
  manual: false,
  manualBoxIds: []
};

const $ = (id) => document.getElementById(id);

function clamp(n, lo, hi) {
  const value = Number(n);
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function clampInt(n, lo, hi) {
  return Math.round(clamp(n, lo, hi));
}

function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 100) return n.toFixed(1);
  if (Math.abs(n) >= 10) return n.toFixed(digits);
  return n.toFixed(digits + 1);
}

function boolText(v) {
  return v ? "ON" : "OFF";
}

function speedToMps(value, unit) {
  return value * SPEED_UNITS[unit].toMps;
}

function mpsToSpeed(value, unit) {
  return value * SPEED_UNITS[unit].fromMps;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeBoxOptions() {
  const opts = [];
  let id = 0;

  for (const orientation of ["away", "toward"]) {
    for (let i = 0; i < SW_RATIOS.length; i++) {
      for (let j = i + 1; j < SW_RATIOS.length; j++) {
        const first = SW_RATIOS[i];
        const second = SW_RATIOS[j];
        const actualFirst = orientation === "away" ? first.value : 1 / first.value;
        const actualSecond = orientation === "away" ? second.value : 1 / second.value;
        const offIsFirst = actualFirst >= actualSecond;
        const off = offIsFirst ? first : second;
        const on = offIsFirst ? second : first;
        const offReduction = Math.max(actualFirst, actualSecond);
        const onReduction = Math.min(actualFirst, actualSecond);

        opts.push({
          id: id++,
          orientation,
          offUi: off.label,
          onUi: on.label,
          offReduction,
          onReduction,
          title: `${orientation === "away" ? "Torque" : "Speed"}: OFF ${off.label}, ON ${on.label}`
        });
      }
    }
  }

  return opts;
}

const BOX_OPTIONS = makeBoxOptions();

function optionById(id) {
  return BOX_OPTIONS.find((o) => o.id === Number(id)) || BOX_OPTIONS[0];
}

function defaultBoxId(stageIndex) {
  const defaults = [
    { orientation: "away", offUi: "3:1", onUi: "2:1" },
    { orientation: "away", offUi: "3:1", onUi: "1:1" },
    { orientation: "away", offUi: "3:2", onUi: "1:1" },
    { orientation: "toward", offUi: "1:1", onUi: "3:1" }
  ];
  const wanted = defaults[stageIndex] || defaults[defaults.length - 1];
  return BOX_OPTIONS.find((o) =>
    o.orientation === wanted.orientation &&
    o.offUi === wanted.offUi &&
    o.onUi === wanted.onUi
  )?.id ?? BOX_OPTIONS[0].id;
}

function makeGearTargets(topReduction, spread, count) {
  const safeCount = Math.max(1, count);
  const safeSpread = clamp(spread, 1.05, 20);
  if (safeCount === 1) return [topReduction];

  return Array.from({ length: safeCount }, (_, i) => {
    const position = (safeCount - 1 - i) / (safeCount - 1);
    return topReduction * Math.pow(safeSpread, position);
  });
}

function sampleTargets(targets, count) {
  if (count >= targets.length) return targets.slice();
  if (count <= 1) return [targets[targets.length - 1]];

  const sampled = [];
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (targets.length - 1)) / (count - 1));
    sampled.push(targets[index]);
  }
  return sampled;
}

function calcReductions(boxes) {
  let reductions = [1];

  for (const box of boxes) {
    const next = [];
    for (const reduction of reductions) {
      next.push(reduction * box.offReduction);
      next.push(reduction * box.onReduction);
    }
    reductions = next;
  }

  return uniqueReductions(reductions.sort((a, b) => b - a));
}

function calcStates(boxes) {
  let states = [{ reduction: 1, stages: [] }];

  for (const box of boxes) {
    const next = [];
    for (const stateItem of states) {
      next.push({
        reduction: stateItem.reduction * box.offReduction,
        stages: [...stateItem.stages, false]
      });
      next.push({
        reduction: stateItem.reduction * box.onReduction,
        stages: [...stateItem.stages, true]
      });
    }
    states = next;
  }

  return uniqueStates(states.sort((a, b) => b.reduction - a.reduction));
}

function sameReduction(a, b) {
  return Math.abs(Math.log(a / b)) < 1e-9;
}

function uniqueReductions(reductions) {
  const unique = [];
  for (const reduction of reductions) {
    if (!unique.some((existing) => sameReduction(existing, reduction))) unique.push(reduction);
  }
  return unique;
}

function uniqueStates(states) {
  const unique = [];
  for (const stateItem of states) {
    if (!unique.some((existing) => sameReduction(existing.reduction, stateItem.reduction))) unique.push(stateItem);
  }
  return unique;
}

function targetCost(reduction, target, index, count) {
  const err = Math.log(reduction / target);
  const topWeight = index === count - 1 ? 2.5 : 1;
  return err * err * topWeight;
}

function scoreReductions(reductions, targets) {
  if (reductions.length < targets.length) return Infinity;

  const count = targets.length;
  let dp = Array(count + 1).fill(Infinity);
  dp[0] = 0;

  for (let i = 0; i < reductions.length; i++) {
    const next = dp.slice();
    const limit = Math.min(i + 1, count);

    for (let chosen = 1; chosen <= limit; chosen++) {
      const cost = targetCost(reductions[i], targets[chosen - 1], chosen - 1, count);
      const candidate = dp[chosen - 1] + cost;
      if (candidate < next[chosen]) next[chosen] = candidate;
    }

    dp = next;
  }

  return dp[count];
}

function pickGears(states, targets) {
  if (states.length < targets.length) return null;

  const rowCount = states.length;
  const gearCount = targets.length;
  const dp = Array.from({ length: rowCount + 1 }, () => Array(gearCount + 1).fill(Infinity));
  const take = Array.from({ length: rowCount + 1 }, () => Array(gearCount + 1).fill(false));
  dp[0][0] = 0;

  for (let i = 1; i <= rowCount; i++) {
    dp[i][0] = 0;
    for (let chosen = 1; chosen <= gearCount; chosen++) {
      dp[i][chosen] = dp[i - 1][chosen];
      const cost = targetCost(states[i - 1].reduction, targets[chosen - 1], chosen - 1, gearCount);
      const candidate = dp[i - 1][chosen - 1] + cost;
      if (candidate < dp[i][chosen]) {
        dp[i][chosen] = candidate;
        take[i][chosen] = true;
      }
    }
  }

  if (!Number.isFinite(dp[rowCount][gearCount])) return null;

  const picked = [];
  let i = rowCount;
  let chosen = gearCount;

  while (i > 0 && chosen > 0) {
    if (take[i][chosen]) {
      picked.push(states[i - 1]);
      chosen--;
    }
    i--;
  }

  picked.reverse();
  return { score: dp[rowCount][gearCount], gears: picked };
}

function rankBoxes(boxes, forwardTargets, reverseTargets) {
  const reductions = calcReductions(boxes);
  const forwardSample = sampleTargets(forwardTargets, Math.min(forwardTargets.length, reductions.length));
  const reverseSample = sampleTargets(reverseTargets, Math.min(reverseTargets.length, reductions.length));
  const forwardScore = scoreReductions(reductions, forwardSample);
  const reverseScore = scoreReductions(reductions, reverseSample);

  return forwardScore * 1000 + reverseScore;
}

function scorePlanFromBoxes(boxes, forwardTargets, reverseTargets) {
  const states = calcStates(boxes);
  const forward = pickGears(states, forwardTargets);
  const reverse = pickGears(states, reverseTargets);

  if (!forward || !reverse) return null;

  return {
    score: forward.score * 1000 + reverse.score,
    forward,
    reverse
  };
}

function exhaustiveBoxes(stageCount, forwardTargets, reverseTargets) {
  let best = null;
  const current = [];

  function walk(depth) {
    if (depth === stageCount) {
      const scored = scorePlanFromBoxes(current, forwardTargets, reverseTargets);
      if (scored && (!best || scored.score < best.score)) best = { score: scored.score, boxes: current.slice() };
      return;
    }

    for (const option of BOX_OPTIONS) {
      current.push(option);
      walk(depth + 1);
      current.pop();
    }
  }

  walk(0);
  return best;
}

function beamBoxes(stageCount, forwardTargets, reverseTargets) {
  let beam = [{ boxes: [], score: 0 }];

  for (let depth = 0; depth < stageCount; depth++) {
    const candidates = [];

    for (const item of beam) {
      for (const option of BOX_OPTIONS) {
        const boxes = [...item.boxes, option];
        candidates.push({
          boxes,
          score: rankBoxes(boxes, forwardTargets, reverseTargets)
        });
      }
    }

    if (depth === stageCount - 1) {
      let best = null;
      for (const candidate of candidates) {
        const scored = scorePlanFromBoxes(candidate.boxes, forwardTargets, reverseTargets);
        if (scored && (!best || scored.score < best.score)) {
          best = { score: scored.score, boxes: candidate.boxes };
        }
      }
      return best;
    }

    candidates.sort((a, b) => a.score - b.score);
    beam = candidates.slice(0, BEAM_SIZE);
  }

  return beam[0] || null;
}

function findBestBoxes(stageCount, forwardTargets, reverseTargets) {
  if (stageCount <= 2) return exhaustiveBoxes(stageCount, forwardTargets, reverseTargets);
  return beamBoxes(stageCount, forwardTargets, reverseTargets);
}

function buildPlanFromBoxes(boxes, forwardTargets, reverseTargets) {
  const scored = scorePlanFromBoxes(boxes, forwardTargets, reverseTargets);

  if (!scored) return null;

  return {
    stageCount: boxes.length,
    boxes,
    forwardGears: scored.forward.gears,
    reverseGears: scored.reverse.gears,
    score: scored.score
  };
}

function readInputs() {
  const engineRps = clamp($("engineRps").value, 0.1, 200);
  const targetSpeed = clamp($("targetSpeed").value, 0.01, 10000);
  const speedUnit = $("speedUnit").value;
  const wheelDiameter = clamp($("wheelDiameter").value, 0.01, 20);
  const forwardCount = clampInt($("forwardCount").value, 1, 16);
  const reverseCount = clampInt($("reverseCount").value, 1, 16);
  const forwardSpread = clamp($("forwardSpread").value, 1.05, 20);
  const reverseSpeedPercent = clamp($("reverseSpeedPercent").value, 1, 100);
  const reverseSpread = clamp($("reverseSpread").value, 1.05, 20);
  const targetMps = speedToMps(targetSpeed, speedUnit);
  const wheelRpsTarget = targetMps / (Math.PI * wheelDiameter);
  const targetTopReduction = engineRps / Math.max(0.0001, wheelRpsTarget);
  const reverseTargetSpeed = targetSpeed * (reverseSpeedPercent / 100);
  const forwardTargets = makeGearTargets(targetTopReduction, forwardSpread, forwardCount);
  const reverseTopReduction = targetTopReduction / Math.max(0.01, reverseSpeedPercent / 100);
  const reverseTargets = makeGearTargets(reverseTopReduction, reverseSpread, reverseCount);

  return {
    engineRps,
    targetSpeed,
    speedUnit,
    wheelDiameter,
    forwardCount,
    reverseCount,
    wheelRpsTarget,
    targetTopReduction,
    reverseTargetSpeed,
    forwardTargets,
    reverseTargets
  };
}

function targetsFitStage(targets, stageCount) {
  const minPossible = Math.pow(1 / 3, stageCount);
  const maxPossible = Math.pow(3, stageCount);
  const minTarget = Math.min(...targets);
  const maxTarget = Math.max(...targets);
  const rangePossible = Math.pow(9, stageCount);

  return minTarget >= minPossible &&
    maxTarget <= maxPossible &&
    maxTarget / Math.max(0.0001, minTarget) <= rangePossible;
}

function determineStageCount(input) {
  const targets = [...input.forwardTargets, ...input.reverseTargets];
  const requiredByCount = Math.max(1, Math.ceil(Math.log2(Math.max(input.forwardCount, input.reverseCount))));
  const start = Math.min(MAX_STAGES, requiredByCount);

  for (let stageCount = start; stageCount <= MAX_STAGES; stageCount++) {
    if (targetsFitStage(targets, stageCount)) {
      return { stageCount, warning: "" };
    }
  }

  return {
    stageCount: MAX_STAGES,
    warning: "The requested count or target ratio is outside the practical 4-range search. The calculator is using four ranges and showing the closest fit."
  };
}

function ensureManualBoxes(stageCount) {
  for (let i = 0; i < stageCount; i++) {
    if (state.manualBoxIds[i] === undefined) state.manualBoxIds[i] = defaultBoxId(i);
  }
  state.manualBoxIds = state.manualBoxIds.slice(0, stageCount);
}

function makeManualPlan(stageCount, forwardTargets, reverseTargets) {
  ensureManualBoxes(stageCount);
  const boxes = state.manualBoxIds.map(optionById);
  return buildPlanFromBoxes(boxes, forwardTargets, reverseTargets);
}

function makeAutoPlan(input, stageCount) {
  const best = findBestBoxes(stageCount, input.forwardTargets, input.reverseTargets);
  if (!best) return null;
  return buildPlanFromBoxes(best.boxes, input.forwardTargets, input.reverseTargets);
}

function planFromInputs(input) {
  const stageChoice = determineStageCount(input);
  const autoPlan = makeAutoPlan(input, stageChoice.stageCount);
  const manualPlan = state.manual
    ? makeManualPlan(stageChoice.stageCount, input.forwardTargets, input.reverseTargets)
    : null;

  return {
    plan: manualPlan || autoPlan,
    autoPlan,
    warning: stageChoice.warning
  };
}

function reverseLabels(count) {
  if (count === 1) return ["R"];
  return Array.from({ length: count }, (_, i) => `R${i + 1}`);
}

function gearLabels(input) {
  return [
    ...reverseLabels(input.reverseCount),
    "N",
    ...Array.from({ length: input.forwardCount }, (_, i) => String(i + 1))
  ];
}

function normalizeSelectedGear(input) {
  const labels = gearLabels(input);
  if (labels.includes(state.selectedGear)) return;

  if (/^\d+$/.test(state.selectedGear)) {
    state.selectedGear = String(Math.min(Number(state.selectedGear), input.forwardCount));
    return;
  }

  if (state.selectedGear === "R" || /^R\d+$/.test(state.selectedGear)) {
    state.selectedGear = reverseLabels(input.reverseCount)[0];
    return;
  }

  state.selectedGear = labels[labels.length - 1];
}

function gearInfo(label) {
  if (label === "N") return { type: "neutral", index: -1 };
  if (label === "R") return { type: "reverse", index: 0 };
  if (/^R\d+$/.test(label)) return { type: "reverse", index: Number(label.slice(1)) - 1 };
  return { type: "forward", index: Number(label) - 1 };
}

function stateForGear(plan, gear) {
  if (!plan) return null;

  const info = gearInfo(gear);
  if (info.type === "neutral") {
    return {
      clutch: 0,
      reverse: false,
      stages: Array(plan.stageCount).fill(false),
      reduction: 0
    };
  }

  if (info.type === "reverse") {
    const selected = plan.reverseGears[info.index] || plan.reverseGears[0];
    return {
      clutch: 1,
      reverse: true,
      stages: selected.stages,
      reduction: -selected.reduction
    };
  }

  const selected = plan.forwardGears[info.index] || plan.forwardGears[plan.forwardGears.length - 1];
  return {
    clutch: 1,
    reverse: false,
    stages: selected.stages,
    reduction: selected.reduction
  };
}

function outputForReduction(engineRps, wheelDiameter, reduction) {
  const wheelRps = reduction === 0 ? 0 : engineRps / reduction;
  const mps = wheelRps * Math.PI * wheelDiameter;
  return { wheelRps, mps };
}

function renderManualControls(stageCount) {
  ensureManualBoxes(stageCount);
  const root = $("manualRanges");
  root.innerHTML = "";

  for (let i = 0; i < stageCount; i++) {
    const field = document.createElement("div");
    field.className = "field";

    const label = document.createElement("label");
    label.htmlFor = `manualRange${i}`;
    label.textContent = `Range ${STAGE_NAMES[i]}`;

    const row = document.createElement("div");
    row.className = "field-row select-row";

    const select = document.createElement("select");
    select.id = `manualRange${i}`;
    for (const option of BOX_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = option.id;
      opt.textContent = option.title;
      select.appendChild(opt);
    }
    select.value = state.manualBoxIds[i];
    select.addEventListener("change", () => {
      state.manualBoxIds[i] = Number(select.value);
      render();
    });

    row.appendChild(select);
    field.appendChild(label);
    field.appendChild(row);
    root.appendChild(field);
  }
}

function renderAutoSummary(plan) {
  if (!plan) {
    $("autoSummary").innerHTML = "";
    return;
  }

  $("autoSummary").innerHTML = plan.boxes.map((box, index) => `
    <div class="range-chip">
      <span class="label">Range ${STAGE_NAMES[index]}</span>
      <strong>${escapeHtml(box.offUi)} / ${escapeHtml(box.onUi)}</strong>
    </div>
  `).join("");
}

function renderGearButtons(input) {
  const labels = gearLabels(input);
  const root = $("gearButtons");
  root.innerHTML = "";

  for (const label of labels) {
    const info = gearInfo(label);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gear-button";
    btn.textContent = label;
    btn.dataset.gear = label;
    if (label === state.selectedGear) {
      btn.classList.add("active");
      btn.classList.add(info.type === "reverse" ? "reverse" : info.type === "neutral" ? "neutral" : "forward");
    }
    btn.addEventListener("click", () => {
      state.selectedGear = label;
      render();
    });
    root.appendChild(btn);
  }
}

function stageHtml(title, sub, pills, mode) {
  const classes = ["stage"];
  if (mode === "forward") classes.push("live");
  if (mode === "reverse") classes.push("reverse");

  return `
    <div class="${classes.join(" ")}">
      <div class="stage-title">${escapeHtml(title)}</div>
      <div class="stage-sub">${escapeHtml(sub)}</div>
      ${pills}
    </div>
  `;
}

function pillHtml(text, active, reverse) {
  const classes = ["pill"];
  if (active) classes.push(reverse ? "reverse" : "active");
  return `<div class="${classes.join(" ")}">${escapeHtml(text)}</div>`;
}

function arrowHtml(live, reverse) {
  const classes = ["flow-arrow"];
  if (live) classes.push(reverse ? "reverse" : "live");
  return `<div class="${classes.join(" ")}"></div>`;
}

function renderChain(plan, input, current, currentOut, currentSpeed) {
  const live = current.clutch > 0;
  const mode = live ? (current.reverse ? "reverse" : "forward") : "";
  const parts = [];

  parts.push(stageHtml("Engine", `${fmt(input.engineRps, 2)} RPS`, pillHtml("Source", live, current.reverse), mode));
  parts.push(arrowHtml(live, current.reverse));
  parts.push(stageHtml("Clutch", "neutral control", pillHtml(live ? "ENGAGED" : "OPEN", live, false), live ? "forward" : ""));
  parts.push(arrowHtml(live, current.reverse));
  parts.push(stageHtml(
    "Direction",
    "1:1 / -1:1",
    pillHtml("OFF / FWD", !current.reverse, false) + pillHtml("ON / REV", current.reverse, true),
    live ? (current.reverse ? "reverse" : "forward") : ""
  ));

  for (let i = 0; i < plan.stageCount; i++) {
    const box = plan.boxes[i];
    const on = current.stages[i];
    parts.push(arrowHtml(live, current.reverse));
    parts.push(stageHtml(
      `Range ${STAGE_NAMES[i]}`,
      box.orientation === "away" ? "arrows away" : "arrows toward",
      pillHtml(`OFF / ${box.offUi}`, !on, current.reverse) + pillHtml(`ON / ${box.onUi}`, on, current.reverse),
      mode
    ));
  }

  parts.push(arrowHtml(live, current.reverse));
  parts.push(stageHtml("Output", `${fmt(currentOut.wheelRps, 2)} RPS`, pillHtml(`${fmt(currentSpeed, 2)} ${input.speedUnit}`, live, current.reverse), mode));
  $("chain").innerHTML = parts.join("");
}

function gearRow(label, gearState, input, selectedClass) {
  const absReduction = Math.abs(gearState.reduction);
  const out = outputForReduction(input.engineRps, input.wheelDiameter, absReduction);
  const sign = gearState.reverse ? -1 : 1;
  const speed = sign * mpsToSpeed(out.mps, input.speedUnit);
  const wheelRps = sign * out.wheelRps;
  const reductionText = `${gearState.reverse ? "-" : ""}${fmt(absReduction, 3)}:1`;
  const stageCells = gearState.stages
    .map((on, index) => `<td data-label="${STAGE_NAMES[index]}">${boolText(on)}</td>`)
    .join("");

  return `
    <tr class="${selectedClass}">
      <td data-label="Gear"><strong>${escapeHtml(label)}</strong></td>
      ${stageCells}
      <td class="num" data-label="Reduction">${reductionText}</td>
      <td class="num" data-label="Wheel RPS">${fmt(wheelRps, 3)}</td>
      <td class="num" data-label="Speed">${fmt(speed, 2)} ${escapeHtml(input.speedUnit)}</td>
    </tr>
  `;
}

function renderGearTable(plan, input) {
  $("gearTableHead").innerHTML = [
    "<th>Gear</th>",
    ...STAGE_NAMES.slice(0, plan.stageCount).map((name) => `<th>${name}</th>`),
    "<th class=\"num\">Reduction</th>",
    "<th class=\"num\">Wheel RPS</th>",
    "<th class=\"num\">Speed</th>"
  ].join("");

  const rows = [];
  for (let i = 0; i < plan.forwardGears.length; i++) {
    const label = String(i + 1);
    const gearState = stateForGear(plan, label);
    rows.push(gearRow(label, gearState, input, state.selectedGear === label ? "selected-forward" : ""));
  }

  const revLabels = reverseLabels(input.reverseCount);
  for (let i = 0; i < revLabels.length; i++) {
    const label = revLabels[i];
    const gearState = stateForGear(plan, label);
    rows.push(gearRow(label, gearState, input, state.selectedGear === label ? "selected-reverse" : ""));
  }

  $("gearTable").innerHTML = rows.join("");
}

function renderOutputs(plan) {
  const rangeOutputs = STAGE_NAMES.slice(0, plan.stageCount).map((name, index) => `
    <div class="out">
      <span class="label">Composite out B${index + 2}</span>
      <strong>Range ${name}</strong>
    </div>
  `).join("");

  $("outputGrid").innerHTML = `
    <div class="out wide">
      <span class="label">MCU wiring</span>
      <strong>Seat to composite input 1, panel to composite input 2, then inject panel B1/B2 into the Lua input composite</strong>
    </div>
    <div class="out">
      <span class="label">Composite in N4</span>
      <strong>Seat up/down axis</strong>
    </div>
    <div class="out">
      <span class="label">Composite in B1/B2</span>
      <strong>Panel gear up/down</strong>
    </div>
    <div class="out">
      <span class="label">Composite out N1</span>
      <strong>Panel gear gauge (-1 = R1)</strong>
    </div>
    <div class="out">
      <span class="label">Composite out B1</span>
      <strong>Reverse light / direction</strong>
    </div>
    ${rangeOutputs}
    <div class="out">
      <span class="label">Composite out N2</span>
      <strong>Clutch target</strong>
    </div>
    <div class="out optional">
      <span class="label">Composite out N3</span>
      <strong>Current reduction</strong>
    </div>
    <div class="out wide">
      <span class="label">Video out</span>
      <strong>Seven-segment gear display</strong>
    </div>
  `;
}

function luaBool(value) {
  return value ? "true" : "false";
}

function luaNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(digits)).toString();
}

function luaRanges(stages) {
  return `{ ${stages.map(luaBool).join(", ")} }`;
}

function makeLuaMap(plan, input) {
  if (!plan) return "-- no valid plan";

  const rangeOutputChannels = STAGE_NAMES.slice(0, plan.stageCount).map((_, index) => index + 2);
  const neutralRanges = luaRanges(Array(plan.stageCount).fill(false));
  const gearRows = [];
  const revLabels = reverseLabels(input.reverseCount);

  for (let i = 0; i < revLabels.length; i++) {
    const gearState = stateForGear(plan, revLabels[i]);
    gearRows.push({
      command: -(i + 1),
      name: revLabels[i],
      reverse: true,
      clutch: 1,
      reduction: Math.abs(gearState.reduction),
      ranges: gearState.stages
    });
  }

  for (let i = 0; i < plan.forwardGears.length; i++) {
    const label = String(i + 1);
    const gearState = stateForGear(plan, label);
    gearRows.push({
      command: i + 1,
      name: label,
      reverse: false,
      clutch: 1,
      reduction: gearState.reduction,
      ranges: gearState.stages
    });
  }

  const gearTable = [
    `  [0] = { label = "N", reverse = false, clutch = CLUTCH_NEUTRAL, reduction = 0, ranges = ${neutralRanges} }`,
    ...gearRows.map((row) =>
      `  [${row.command}] = { label = "${row.name}", reverse = ${luaBool(row.reverse)}, clutch = CLUTCH_DRIVE, reduction = ${luaNumber(row.reduction)}, ranges = ${luaRanges(row.ranges)} }`
    )
  ].join(",\n");

  return [
    "-- Stormworks gearbox controller",
    "-- Seat: map up/down arrows to axis N4; reset or sticky works.",
    "-- Wire: seat composite -> input 1 -> main composite -> Lua.",
    "-- Wire: panel composite -> input 2; inject panel B1/B2 into main composite.",
    "-- Panel: B1 gear up, B2 gear down, N1 gauge (-1=R1), B1 reverse light.",
    "-- Output: B1 reverse, B2+ ranges, N2 clutch, video gear display.",
    "",
    `local MIN_GEAR = -${input.reverseCount}`,
    `local MAX_GEAR = ${input.forwardCount}`,
    "",
    "local SEAT_UP_DOWN_AXIS_N = 4",
    "local PANEL_UP_B = 1",
    "local PANEL_DOWN_B = 2",
    "",
    "local PANEL_GEAR_N = 1",
    "local REVERSE_B = 1",
    `local OUT_RANGE_BOOL = { ${rangeOutputChannels.join(", ")} }`,
    "local CLUTCH_N = 2",
    "local REDUCTION_N = 3",
    "",
    "local SEAT_AXIS_EPS = 0.02",
    "",
    "local BG_RGB = { 10, 10, 10 }",
    "local FG_RGB = { 255, 255, 255 }",
    "",
    "local CLUTCH_DRIVE = 1",
    "local CLUTCH_NEUTRAL = 0",
    "",
    "local GEAR = {",
    gearTable,
    "}",
    "",
    "local selectedGear = 0",
    "local displayNumber = \"0\"",
    "local displayMode = \"NEUTRAL\"",
    "local displayReverse = false",
    "local lastPanelUp = false",
    "local lastPanelDown = false",
    "local seatAxisLatch = 0",
    "",
    "local function channelOn(channel)",
    "  return channel ~= nil and channel > 0",
    "end",
    "",
    "local function clamp(value, low, high)",
    "  return math.max(low, math.min(high, value))",
    "end",
    "",
    "local function axisSign(value)",
    "  if value > SEAT_AXIS_EPS then return 1 end",
    "  if value < -SEAT_AXIS_EPS then return -1 end",
    "  return 0",
    "end",
    "",
    "local function shiftGear(amount)",
    "  selectedGear = clamp(selectedGear + amount, MIN_GEAR, MAX_GEAR)",
    "end",
    "",
    "local function readPanelShift()",
    "  local up = input.getBool(PANEL_UP_B)",
    "  local down = input.getBool(PANEL_DOWN_B)",
    "  local upEdge = up and not lastPanelUp",
    "  local downEdge = down and not lastPanelDown",
    "  local shift = 0",
    "",
    "  if upEdge ~= downEdge then",
    "    shift = upEdge and 1 or -1",
    "  end",
    "",
    "  lastPanelUp = up",
    "  lastPanelDown = down",
    "  return shift",
    "end",
    "",
    "local function readSeatShift()",
    "  local axis = clamp(input.getNumber(SEAT_UP_DOWN_AXIS_N), -1, 1)",
    "  local sign = axisSign(axis)",
    "",
    "  if sign == 0 then",
    "    seatAxisLatch = 0",
    "    return 0",
    "  end",
    "",
    "  if sign ~= seatAxisLatch then",
    "    seatAxisLatch = sign",
    "    return sign",
    "  end",
    "",
    "  return 0",
    "end",
    "",
    "local function gearForSelected()",
    "  return GEAR[selectedGear] or GEAR[0]",
    "end",
    "",
    "local function setBool(channel, value)",
    "  if channelOn(channel) then",
    "    output.setBool(channel, value)",
    "  end",
    "end",
    "",
    "local function setNumber(channel, value)",
    "  if channelOn(channel) then",
    "    output.setNumber(channel, value)",
    "  end",
    "end",
    "",
    "local SEGMENT = {",
    "  [\"0\"] = { 1, 1, 1, 1, 1, 1, 0 },",
    "  [\"1\"] = { 0, 1, 1, 0, 0, 0, 0 },",
    "  [\"2\"] = { 1, 1, 0, 1, 1, 0, 1 },",
    "  [\"3\"] = { 1, 1, 1, 1, 0, 0, 1 },",
    "  [\"4\"] = { 0, 1, 1, 0, 0, 1, 1 },",
    "  [\"5\"] = { 1, 0, 1, 1, 0, 1, 1 },",
    "  [\"6\"] = { 1, 0, 1, 1, 1, 1, 1 },",
    "  [\"7\"] = { 1, 1, 1, 0, 0, 0, 0 },",
    "  [\"8\"] = { 1, 1, 1, 1, 1, 1, 1 },",
    "  [\"9\"] = { 1, 1, 1, 1, 0, 1, 1 },",
    "  [\"-\"] = { 0, 0, 0, 0, 0, 0, 1 },",
    "  [\" \"] = { 0, 0, 0, 0, 0, 0, 0 }",
    "}",
    "",
    "local function colorBlend(amount)",
    "  local function mix(bg, fg)",
    "    return math.floor(bg + (fg - bg) * amount)",
    "  end",
    "  screen.setColor(mix(BG_RGB[1], FG_RGB[1]), mix(BG_RGB[2], FG_RGB[2]), mix(BG_RGB[3], FG_RGB[3]))",
    "end",
    "",
    "local function rect(x, y, w, h)",
    "  if w >= 1 and h >= 1 then",
    "    screen.drawRectF(math.floor(x), math.floor(y), math.floor(w), math.floor(h))",
    "  end",
    "end",
    "",
    "local function segmentRects(x, y, w, h, t)",
    "  local midY = y + math.floor((h - t) / 2)",
    "  local bottomY = y + h - t",
    "  local upperH = math.max(1, midY - (y + t))",
    "  local lowerH = math.max(1, bottomY - (midY + t))",
    "  return {",
    "    { x + t, y, w - 2 * t, t },",
    "    { x + w - t, y + t, t, upperH },",
    "    { x + w - t, midY + t, t, lowerH },",
    "    { x + t, bottomY, w - 2 * t, t },",
    "    { x, midY + t, t, lowerH },",
    "    { x, y + t, t, upperH },",
    "    { x + t, midY, w - 2 * t, t }",
    "  }",
    "end",
    "",
    "local function drawSevenChar(character, x, y, w, h)",
    "  local map = SEGMENT[character] or SEGMENT[\" \"]",
    "  local t = math.max(1, math.floor(math.min(w, h) / 6))",
    "  local parts = segmentRects(x, y, w, h, t)",
    "",
    "  for index = 1, 7 do",
    "    colorBlend(map[index] == 1 and 1 or 0.05)",
    "    rect(parts[index][1], parts[index][2], parts[index][3], parts[index][4])",
    "  end",
    "end",
    "",
    "local function drawSevenText(text, x, y, w, h)",
    "  local count = math.max(1, string.len(text))",
    "  local maxCharW = math.max(4, math.floor(h * 0.58))",
    "  local gap = math.max(1, math.floor(maxCharW * 0.18))",
    "  local availableCharW = math.floor((w - gap * (count - 1)) / count)",
    "  local charW = math.max(3, math.min(maxCharW, availableCharW))",
    "  local totalW = charW * count + gap * (count - 1)",
    "  local startX = x + math.floor((w - totalW) / 2)",
    "",
    "  for index = 1, count do",
    "    local character = string.sub(text, index, index)",
    "    drawSevenChar(character, startX + (index - 1) * (charW + gap), y, charW, h)",
    "  end",
    "end",
    "",
    "function onTick()",
    "  local shift = readPanelShift() + readSeatShift()",
    "  if shift > 0 then",
    "    shiftGear(1)",
    "  elseif shift < 0 then",
    "    shiftGear(-1)",
    "  end",
    "",
    "  local gear = gearForSelected()",
    "  displayNumber = tostring(selectedGear)",
    "  displayMode = gear.reverse and \"REV\" or selectedGear == 0 and \"COAST\" or \"DRIVE\"",
    "  displayReverse = gear.reverse",
    "",
    "  setNumber(PANEL_GEAR_N, selectedGear)",
    "  setBool(REVERSE_B, gear.reverse)",
    "  for index = 1, #OUT_RANGE_BOOL do",
    "    setBool(OUT_RANGE_BOOL[index], gear.ranges[index] or false)",
    "  end",
    "",
    "  setNumber(CLUTCH_N, gear.clutch)",
    "  setNumber(REDUCTION_N, gear.reduction)",
    "end",
    "",
    "function onDraw()",
    "  local w = screen.getWidth()",
    "  local h = screen.getHeight()",
    "  local topH = math.max(5, math.floor(h * 0.2))",
    "  local bottomH = math.max(6, math.floor(h * 0.22))",
    "  local digitY = topH",
    "  local digitH = math.max(10, h - topH - bottomH)",
    "",
    "  screen.setColor(BG_RGB[1], BG_RGB[2], BG_RGB[3])",
    "  screen.drawClear()",
    "  screen.setColor(FG_RGB[1], FG_RGB[2], FG_RGB[3])",
    "  screen.drawTextBox(0, 0, w, topH, \"GEAR\", 0, 0)",
    "  drawSevenText(displayNumber, 2, digitY, math.max(1, w - 4), digitH)",
    "  screen.setColor(FG_RGB[1], FG_RGB[2], FG_RGB[3])",
    "  screen.drawTextBox(0, h - bottomH, w, bottomH, displayMode, 0, 0)",
    "",
    "  if displayReverse then",
    "    rect(0, h - 1, w, 1)",
    "  end",
    "end"
  ].join("\n");
}

function fallbackCopy(text) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents($("luaMap"));
  selection.removeAllRanges();
  selection.addRange(range);
  const copied = document.execCommand("copy");
  selection.removeAllRanges();
  return copied;
}

function setCopyStatus(text) {
  $("copyStatus").textContent = text;
  window.clearTimeout(setCopyStatus.timer);
  setCopyStatus.timer = window.setTimeout(() => {
    $("copyStatus").textContent = "";
  }, 1600);
}

async function copyLua() {
  const text = $("luaMap").textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!fallbackCopy(text)) {
      throw new Error("copy failed");
    }
    setCopyStatus("Copied");
  } catch {
    setCopyStatus("Select text");
  }
}

function renderWarning(warning, plan) {
  const messages = [];
  if (warning) messages.push(warning);
  if (!plan) messages.push("No valid gearbox fit found for these inputs.");

  $("fitWarning").classList.toggle("hidden", messages.length === 0);
  $("fitWarning").textContent = messages.join(" ");
}

function clearRenderedOutputs() {
  $("stageReadout").textContent = "-";
  $("targetWheelRps").textContent = "-";
  $("gearboxEfficiency").textContent = "-";
  $("topError").textContent = "-";
  $("reverseTopSpeed").textContent = "-";
  $("selectedSpeed").textContent = "-";
  $("manualRanges").innerHTML = "";
  $("autoSummary").innerHTML = "";
  $("gearButtons").innerHTML = "";
  $("chain").innerHTML = "";
  $("gearTableHead").innerHTML = "";
  $("gearTable").innerHTML = "";
  $("outputGrid").innerHTML = "";
  $("luaMap").textContent = "-- no valid gearbox fit for these inputs";
}

function render() {
  const input = readInputs();
  normalizeSelectedGear(input);
  const { plan, autoPlan, warning } = planFromInputs(input);

  renderWarning(warning, plan);
  if (!plan || !autoPlan) {
    $("layoutSummary").textContent = "Dynamic gearbox layout for Stormworks vehicles.";
    $("targetReduction").textContent = fmt(input.targetTopReduction, 3);
    clearRenderedOutputs();
    return;
  }

  renderManualControls(plan.stageCount);
  renderAutoSummary(autoPlan);
  renderGearButtons(input);

  const current = stateForGear(plan, state.selectedGear);
  const currentOut = outputForReduction(input.engineRps, input.wheelDiameter, Math.abs(current.reduction || 0));
  const currentSpeed = current.reverse ? -mpsToSpeed(currentOut.mps, input.speedUnit) : mpsToSpeed(currentOut.mps, input.speedUnit);
  const topGear = plan.forwardGears[plan.forwardGears.length - 1];
  const topOut = outputForReduction(input.engineRps, input.wheelDiameter, topGear.reduction);
  const topSpeedActual = mpsToSpeed(topOut.mps, input.speedUnit);
  const topError = topSpeedActual ? ((topSpeedActual - input.targetSpeed) / input.targetSpeed) * 100 : 0;
  const passPower = Math.pow(GEARBOX_EFFICIENCY_PER_PASS, plan.stageCount + 1) * 100;

  $("layoutSummary").textContent = "Dynamic gearbox layout for Stormworks vehicles.";
  $("targetReduction").textContent = fmt(input.targetTopReduction, 3);
  $("stageReadout").textContent = `${plan.stageCount} ranges`;
  $("targetWheelRps").textContent = fmt(input.wheelRpsTarget, 3);
  $("gearboxEfficiency").textContent = `${fmt(passPower, 1)}%`;
  $("topError").textContent = `${fmt(topError, 1)}%`;
  $("reverseTopSpeed").textContent = `${fmt(input.reverseTargetSpeed, 2)} ${input.speedUnit}`;
  $("selectedGearLabel").textContent = state.selectedGear;
  $("selectedSpeed").textContent = `${fmt(currentSpeed, 2)} ${input.speedUnit}`;

  $("modeToggle").textContent = state.manual ? "Manual" : "Auto-fit";
  $("modeToggle").classList.toggle("manual", state.manual);
  $("autoBox").classList.toggle("hidden", state.manual);
  $("manualBox").classList.toggle("hidden", !state.manual);

  renderChain(plan, input, current, currentOut, currentSpeed);
  renderGearTable(plan, input);
  renderOutputs(plan);
  $("luaMap").textContent = makeLuaMap(plan, input);
}

function bindInputs() {
  const inputIds = [
    "engineRps",
    "targetSpeed",
    "speedUnit",
    "wheelDiameter",
    "forwardCount",
    "reverseCount",
    "forwardSpread",
    "reverseSpeedPercent",
    "reverseSpread"
  ];

  for (const id of inputIds) {
    $(id).addEventListener("input", render);
    $(id).addEventListener("change", render);
  }

  $("modeToggle").addEventListener("click", () => {
    state.manual = !state.manual;
    render();
  });

  $("loadAuto").addEventListener("click", () => {
    const input = readInputs();
    const { autoPlan } = planFromInputs(input);
    if (!autoPlan) return;
    state.manualBoxIds = autoPlan.boxes.map((box) => box.id);
    render();
  });

  $("copyLua").addEventListener("click", copyLua);

  window.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    if (active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;

    const input = readInputs();
    const key = e.key.toLowerCase();
    if (key === "n") state.selectedGear = "N";
    else if (key === "r") state.selectedGear = reverseLabels(input.reverseCount)[0];
    else if (/^\d$/.test(key) && Number(key) >= 1 && Number(key) <= input.forwardCount) state.selectedGear = key;
    else return;

    render();
  });
}

bindInputs();
render();
