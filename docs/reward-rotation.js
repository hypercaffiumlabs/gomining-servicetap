// Shared by setup.html and settings.html: the optional reward plan (TH / GOMINING / BTC, kept
// fixed or alternating) and mining pool.
//
// The settings live in the user's repo as GitHub Actions *Variables* (not secrets: none of
// this is sensitive), one set per account label:
//   REWARD_PLAN_<LABEL>      "GMT" (keep one) or "TH:5,GMT:5,BTC:3" (alternate, in that order)
//   REWARD_START_<LABEL>     YYYY-MM-DD, day 1 of the plan's first stretch
//   REWARD_TH_MINER_<LABEL>  optional miner number for TH
//   REWARD_POOL_<LABEL>      optional pool name, e.g. Antpool
// v15/v16 wrote REWARD_TH_DAYS_<LABEL> / REWARD_GMT_DAYS_<LABEL>; they're read as a plan and
// removed on the next save. gomining_maintenance.py does the switching; the day math below MUST
// match reward_mode_for() / reward_day() / parse_reward_plan() there.
"use strict";

const RewardRotation = (() => {
  const NAMES = ["REWARD_PLAN", "REWARD_START", "REWARD_TH_MINER", "REWARD_POOL"];
  const LEGACY = ["REWARD_TH_DAYS", "REWARD_GMT_DAYS"];
  const MODES = ["TH", "GMT", "BTC"];
  const MODE_NAME = { TH: "TH", GMT: "GOMINING", BTC: "BTC" };
  const POOLS = ["Antpool", "SpiderPool"]; // what GoMining offered in Nov 2026; "Other" covers new ones
  const MAX_DAYS = 365;
  const DAY_MS = 86400000;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function dayNumber(isoDate) { return Math.round(Date.parse(isoDate + "T00:00:00Z") / DAY_MS); }

  // The date whose payout the coming nightly runs set up: UTC date one hour from now.
  function rewardDay(now = new Date()) { return new Date(now.getTime() + 3600000).toISOString().slice(0, 10); }

  // [[mode, days], ...] from "GMT" or "TH:5,GMT:5,BTC:3" -- same rules as parse_reward_plan().
  function parsePlan(raw) {
    const parts = String(raw).split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
    if (parts.length < 1 || parts.length > 3) throw new Error("a plan needs one to three choices");
    const plan = parts.map((part) => {
      const m = part.match(/^(TH|GMT|BTC)(?::(\d{1,3}))?$/);
      if (!m) throw new Error(`"${part}" isn't TH, GMT or BTC`);
      const days = m[2] ? +m[2] : (parts.length === 1 ? 1 : 0);
      if (days < 1 || days > MAX_DAYS) throw new Error(`each choice needs 1 to ${MAX_DAYS} days`);
      return [m[1], days];
    });
    if (new Set(plan.map((p) => p[0])).size !== plan.length) throw new Error("each choice can only be used once");
    return plan;
  }
  function planToString(plan) { return plan.length === 1 ? plan[0][0] : plan.map(([m, d]) => `${m}:${d}`).join(","); }

  // { mode, n, length } -- same as reward_mode_for() in the script.
  function modeFor(isoDay, plan, isoStart) {
    if (plan.length === 1) return { mode: plan[0][0], n: 1, length: 1 };
    const cycle = plan.reduce((t, [, d]) => t + d, 0);
    let pos = (((dayNumber(isoDay) - dayNumber(isoStart)) % cycle) + cycle) % cycle;
    for (const [mode, days] of plan) {
      if (pos < days) return { mode, n: pos + 1, length: days };
      pos -= days;
    }
  }

  // The account's current settings from a {NAME: value} map, or null when none are set.
  function configFrom(vars, label) {
    const get = (n) => String(vars[`${n}_${label}`] ?? "").trim();
    let plan = [];
    if (get("REWARD_PLAN")) {
      try { plan = parsePlan(get("REWARD_PLAN")); } catch (e) { plan = []; }
    } else if (get("REWARD_TH_DAYS") || get("REWARD_GMT_DAYS")) {
      const th = parseInt(get("REWARD_TH_DAYS") || "0", 10) || 0;
      const gmt = parseInt(get("REWARD_GMT_DAYS") || "0", 10) || 0;
      plan = [["TH", th], ["GMT", gmt]].filter(([, d]) => d > 0);
      if (plan.length === 1) plan = [[plan[0][0], 1]];
    }
    const pool = get("REWARD_POOL");
    if (!plan.length && !pool) return null;
    return { plan, start: get("REWARD_START") || "2026-01-01", miner: get("REWARD_TH_MINER"), pool };
  }

  function describe(cfg) {
    if (!cfg) return "Off: ServiceTap leaves your GoMining reward settings alone.";
    const out = [];
    if (!cfg.plan.length) out.push("Reward destination: left as you set it in GoMining.");
    else if (cfg.plan.length === 1) out.push(`Always ${MODE_NAME[cfg.plan[0][0]]}.`);
    else {
      const m = modeFor(rewardDay(), cfg.plan, cfg.start);
      out.push(cfg.plan.map(([mode, d]) => `${d} day${d === 1 ? "" : "s"} ${MODE_NAME[mode]}`).join(", then ") +
        `, repeating. Next payout: ${MODE_NAME[m.mode]} (day ${m.n} of ${m.length}).`);
    }
    if (cfg.pool) out.push(`Pool: ${cfg.pool}.`);
    return out.join(" ");
  }

  // ---- GitHub Variables API (gh = the page's authenticated fetch helper) ----
  async function readVars(gh, owner, repo) {
    const out = {};
    for (let page = 1; page <= 10; page++) {
      const res = await gh(`/repos/${owner}/${repo}/actions/variables?per_page=30&page=${page}`);
      if (!res.ok) throw new Error(`could not read your repo's Variables (HTTP ${res.status})`);
      const data = await res.json();
      for (const v of data.variables || []) out[v.name] = v.value;
      if ((data.variables || []).length < 30) break;
    }
    return out;
  }
  async function writeVar(gh, owner, repo, name, value) {
    const body = JSON.stringify({ name, value: String(value) });
    let res = await gh(`/repos/${owner}/${repo}/actions/variables/${name}`, { method: "PATCH", body });
    if (res.status === 404) res = await gh(`/repos/${owner}/${repo}/actions/variables`, { method: "POST", body });
    if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error(`saving ${name} failed (HTTP ${res.status})`);
  }
  async function deleteVar(gh, owner, repo, name) {
    const res = await gh(`/repos/${owner}/${repo}/actions/variables/${name}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204 && res.status !== 404) throw new Error(`removing ${name} failed (HTTP ${res.status})`);
  }

  // ---- The form fields, one set per account ----
  function modeOptions(selected, allowNone) {
    return (allowNone ? `<option value="">(none)</option>` : "") +
      MODES.map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${MODE_NAME[m]}</option>`).join("");
  }
  // `current` (optional) is the account's existing config, so the page can offer "keep the cycle".
  function fieldsHtml(current) {
    const plan = current ? current.plan : [];
    const kind = !plan.length ? "off" : plan.length === 1 ? "one" : "alt";
    const row = (i) => `
      <div class="row rr-row">
        <label class="field rr-num"><span>${i === 0 ? "First" : i === 1 ? "Then" : "Then (optional)"}</span>
          <select class="rr-alt-mode">${modeOptions(kind === "alt" && plan[i] ? plan[i][0] : "", true)}</select></label>
        <label class="field rr-num"><span>Days</span>
          <input type="number" class="rr-alt-days" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric" value="${kind === "alt" && plan[i] ? plan[i][1] : ""}"></label>
      </div>`;
    const pool = current ? current.pool : "";
    const poolIsOther = pool && !POOLS.includes(pool);
    return `
      <div class="rr-fields">
        <label class="field"><span>Where each day's reward goes</span>
          <select class="rr-kind">
            <option value="off" ${kind === "off" ? "selected" : ""}>Leave it as I set it in GoMining</option>
            <option value="one" ${kind === "one" ? "selected" : ""}>Keep one choice until I change it</option>
            <option value="alt" ${kind === "alt" ? "selected" : ""}>Alternate between two or three</option>
          </select></label>
        <div class="rr-one" hidden>
          <label class="field"><span>Always</span><select class="rr-one-mode">${modeOptions(kind === "one" ? plan[0][0] : "GMT", false)}</select></label>
        </div>
        <div class="rr-alt" hidden>
          ${row(0)}${row(1)}${row(2)}
          <label class="field"><span>Start</span>
            <select class="rr-start">
              ${kind === "alt" ? `<option value="keep" selected>Keep the current cycle</option>` : ""}
              <option value="next" ${kind === "alt" ? "" : "selected"}>From the next payout, with the first choice</option>
            </select></label>
        </div>
        <label class="field rr-miner-wrap" hidden><span>Miner that gets the TH (optional, its number, e.g. 123456; blank = your biggest miner). Miners on GoMining's monthly TH subscription can't receive reinvested TH, so pick one that isn't.</span>
          <input type="text" class="rr-miner" inputmode="numeric" placeholder="biggest miner" value="${current ? esc(current.miner) : ""}"></label>
        <div class="row rr-pool-row">
          <label class="field rr-num"><span>Mining pool</span>
            <select class="rr-pool">
              <option value="" ${pool ? "" : "selected"}>Leave it as it is</option>
              ${POOLS.map((p) => `<option value="${p}" ${p === pool ? "selected" : ""}>${p}</option>`).join("")}
              <option value="other" ${poolIsOther ? "selected" : ""}>Other…</option>
            </select></label>
          <label class="field rr-num rr-pool-other-wrap" hidden><span>Pool name, as GoMining shows it</span>
            <input type="text" class="rr-pool-other" value="${poolIsOther ? esc(pool) : ""}"></label>
        </div>
        <p class="dim">BTC means Reinvestment switched off, so rewards arrive as BTC. ServiceTap switches Reinvestment off for BTC days and back on for TH or GOMINING days.</p>
        <p class="dim rr-preview"></p>
      </div>`;
  }

  // Validated values from a block's fields. plan: null = leave the reward destination alone.
  function readFields(block) {
    const kind = block.querySelector(".rr-kind").value;
    let plan = null, startWith = "next";
    if (kind === "one") {
      plan = [[block.querySelector(".rr-one-mode").value, 1]];
    } else if (kind === "alt") {
      const modes = [...block.querySelectorAll(".rr-alt-mode")].map((s) => s.value);
      const days = [...block.querySelectorAll(".rr-alt-days")].map((s) => s.value.trim());
      plan = [];
      modes.forEach((m, i) => {
        if (!m) return;
        if (!/^\d{1,3}$/.test(days[i]) || +days[i] < 1 || +days[i] > MAX_DAYS) throw new Error(`days must be whole numbers from 1 to ${MAX_DAYS}`);
        plan.push([m, +days[i]]);
      });
      if (plan.length < 2) throw new Error("pick at least two choices to alternate (or choose \"Keep one choice\")");
      if (new Set(plan.map((p) => p[0])).size !== plan.length) throw new Error("each choice can only be used once");
      startWith = block.querySelector(".rr-start").value;
    }
    const miner = block.querySelector(".rr-miner").value.trim().replace(/^#/, "");
    if (miner && !/^\d{1,12}$/.test(miner)) throw new Error("the miner should be just its number, like 123456");
    let pool = block.querySelector(".rr-pool").value;
    if (pool === "other") pool = block.querySelector(".rr-pool-other").value.trim();
    if (pool && (pool.length > 40 || !/^[A-Za-z0-9 ()._-]+$/.test(pool))) throw new Error("the pool name should be as GoMining shows it, like Antpool");
    return { plan, miner, pool, startWith };
  }

  function startFor(values, current) {
    const keep = values.startWith === "keep" && current && current.plan.length > 1;
    return keep ? current.start : rewardDay();
  }
  function asConfig(values, current) {
    if (!values.plan && !values.pool) return null;
    return { plan: values.plan || [], start: startFor(values, current), miner: values.miner, pool: values.pool };
  }

  // Show/hide the parts that apply, and keep the "what will happen" line current.
  function wirePreview(block, current) {
    const update = () => {
      const kind = block.querySelector(".rr-kind").value;
      block.querySelector(".rr-one").hidden = kind !== "one";
      block.querySelector(".rr-alt").hidden = kind !== "alt";
      block.querySelector(".rr-pool-other-wrap").hidden = block.querySelector(".rr-pool").value !== "other";
      const p = block.querySelector(".rr-preview");
      try {
        const v = readFields(block);
        block.querySelector(".rr-miner-wrap").hidden = !(v.plan || []).some(([m]) => m === "TH");
        p.textContent = describe(asConfig(v, current));
        p.style.color = "";
      } catch (e) {
        p.textContent = "⚠️ " + e.message[0].toUpperCase() + e.message.slice(1) + ".";
        p.style.color = "var(--red)";
      }
    };
    for (const el of block.querySelectorAll(".rr-fields input, .rr-fields select")) {
      el.addEventListener("input", update);
      el.addEventListener("change", update);
    }
    update();
  }

  // Write (or clear) one account's Variables. Returns a one-line summary.
  async function save(gh, owner, repo, label, values, current) {
    for (const n of LEGACY) await deleteVar(gh, owner, repo, `${n}_${label}`);
    const cfg = asConfig(values, current);
    if (!cfg) {
      for (const n of NAMES) await deleteVar(gh, owner, repo, `${n}_${label}`);
      return "turned off";
    }
    const set = async (n, v) => (v ? writeVar(gh, owner, repo, `${n}_${label}`, v) : deleteVar(gh, owner, repo, `${n}_${label}`));
    await set("REWARD_PLAN", cfg.plan.length ? planToString(cfg.plan) : "");
    await set("REWARD_START", cfg.plan.length > 1 ? cfg.start : "");
    await set("REWARD_TH_MINER", cfg.miner); // kept even when TH isn't in the plan, for switching back
    await set("REWARD_POOL", cfg.pool);
    return describe(cfg);
  }

  return { modeFor, parsePlan, rewardDay, configFrom, describe, readVars, fieldsHtml, readFields, wirePreview, save };
})();
