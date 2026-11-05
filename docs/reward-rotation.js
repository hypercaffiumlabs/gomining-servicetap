// Shared by setup.html and settings.html: the optional TH / GOMINING reward rotation.
//
// The settings live in the user's repo as GitHub Actions *Variables* (not secrets: none of
// this is sensitive), one set per account label:
//   REWARD_TH_DAYS_<LABEL>, REWARD_GMT_DAYS_<LABEL>, REWARD_START_<LABEL>, REWARD_TH_MINER_<LABEL>
// gomining_maintenance.py reads them (reward_rotation_config) and does the switching. The day
// math below MUST match reward_mode_for() / reward_day() there.
"use strict";

const RewardRotation = (() => {
  const NAMES = ["REWARD_TH_DAYS", "REWARD_GMT_DAYS", "REWARD_START", "REWARD_TH_MINER"];
  const MAX_DAYS = 365;
  const DAY_MS = 86400000;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function dayNumber(isoDate) { return Math.round(Date.parse(isoDate + "T00:00:00Z") / DAY_MS); }
  function isoFromDayNumber(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }

  // The date whose payout the coming nightly runs set up: UTC date one hour from now.
  function rewardDay(now = new Date()) { return new Date(now.getTime() + 3600000).toISOString().slice(0, 10); }

  // { mode: "TH" | "GMT", n, length } -- same as reward_mode_for() in the script.
  function modeFor(isoDay, th, gmt, isoStart) {
    if (gmt === 0) return { mode: "TH", n: 1, length: 1 };
    if (th === 0) return { mode: "GMT", n: 1, length: 1 };
    const cycle = th + gmt;
    const pos = (((dayNumber(isoDay) - dayNumber(isoStart)) % cycle) + cycle) % cycle;
    return pos < th ? { mode: "TH", n: pos + 1, length: th } : { mode: "GMT", n: pos - th + 1, length: gmt };
  }

  // The account's current settings from a {NAME: value} map, or null when off.
  function configFrom(vars, label) {
    const get = (n) => (vars[`${n}_${label}`] ?? "").trim();
    if (!get("REWARD_TH_DAYS") && !get("REWARD_GMT_DAYS")) return null;
    return {
      th: parseInt(get("REWARD_TH_DAYS") || "0", 10) || 0,
      gmt: parseInt(get("REWARD_GMT_DAYS") || "0", 10) || 0,
      start: get("REWARD_START") || "2026-01-01",
      miner: get("REWARD_TH_MINER"),
    };
  }

  function describe(cfg) {
    if (!cfg) return "Off: rewards stay on whatever you choose in GoMining.";
    const m = modeFor(rewardDay(), cfg.th, cfg.gmt, cfg.start);
    const name = (x) => (x === "TH" ? "TH" : "GOMINING");
    if (cfg.th === 0 || cfg.gmt === 0) return `Always ${name(m.mode)}.`;
    return `${cfg.th} day${cfg.th === 1 ? "" : "s"} TH, then ${cfg.gmt} day${cfg.gmt === 1 ? "" : "s"} GOMINING. ` +
      `Next payout: ${name(m.mode)} (day ${m.n} of ${m.length}).`;
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
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`saving ${name} failed (HTTP ${res.status})`);
    }
  }
  async function deleteVar(gh, owner, repo, name) {
    const res = await gh(`/repos/${owner}/${repo}/actions/variables/${name}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204 && res.status !== 404) throw new Error(`removing ${name} failed (HTTP ${res.status})`);
  }

  // ---- The form fields, one set per account ----
  // `current` (optional) is the account's existing config, so the page can offer "keep the cycle".
  function fieldsHtml(current) {
    const keep = current ? `<option value="keep" selected>Keep the current cycle</option>` : "";
    return `
      <div class="rr-fields">
        <div class="row rr-days">
          <label class="field rr-num"><span>TH days</span>
            <input type="number" class="rr-th" min="0" max="${MAX_DAYS}" step="1" inputmode="numeric" value="${current ? esc(current.th) : ""}"></label>
          <label class="field rr-num"><span>GOMINING days</span>
            <input type="number" class="rr-gmt" min="0" max="${MAX_DAYS}" step="1" inputmode="numeric" value="${current ? esc(current.gmt) : ""}"></label>
        </div>
        <label class="field"><span>Miner that gets the TH (optional, its number, e.g. 123456; blank = your biggest miner). Miners on GoMining's monthly TH subscription can't receive reinvested TH, so pick one that isn't.</span>
          <input type="text" class="rr-miner" inputmode="numeric" placeholder="biggest miner" value="${current ? esc(current.miner) : ""}"></label>
        <label class="field"><span>Start with</span>
          <select class="rr-start">${keep}
            <option value="TH" ${current ? "" : "selected"}>TH (from the next payout)</option>
            <option value="GMT">GOMINING (from the next payout)</option>
          </select></label>
        <p class="dim rr-preview"></p>
      </div>`;
  }

  // Validated values from a block's fields: null when both day boxes are blank (= off).
  function readFields(block) {
    const th = block.querySelector(".rr-th").value.trim();
    const gmt = block.querySelector(".rr-gmt").value.trim();
    const miner = block.querySelector(".rr-miner").value.trim().replace(/^#/, "");
    const startWith = block.querySelector(".rr-start").value;
    if (!th && !gmt) return null;
    const toDays = (s) => (s === "" ? 0 : (/^\d{1,3}$/.test(s) && +s <= MAX_DAYS ? +s : NaN));
    const out = { th: toDays(th), gmt: toDays(gmt), miner, startWith };
    if (Number.isNaN(out.th) || Number.isNaN(out.gmt)) throw new Error(`days must be whole numbers from 0 to ${MAX_DAYS}`);
    if (out.th === 0 && out.gmt === 0) throw new Error("TH days and GOMINING days can't both be 0 (clear both to turn it off)");
    if (miner && !/^\d{1,12}$/.test(miner)) throw new Error("the miner should be just its number, like 123456");
    return out;
  }

  // Live "what will happen" line under the fields.
  function wirePreview(block, current) {
    const update = () => {
      const p = block.querySelector(".rr-preview");
      try {
        const v = readFields(block);
        p.textContent = v ? describe({ ...v, start: startFor(v, current) }) : describe(null);
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

  // The start date to store: keep the old one, or anchor the next payout as day 1 of TH (or of
  // GOMINING, which means the TH stretch "ended" just before it).
  function startFor(values, current) {
    if (values.startWith === "keep" && current) return current.start;
    const next = dayNumber(rewardDay());
    return isoFromDayNumber(values.startWith === "GMT" && values.th > 0 && values.gmt > 0 ? next - values.th : next);
  }

  // Write (or clear) one account's Variables. `values` from readFields (null = turn off).
  async function save(gh, owner, repo, label, values, current) {
    if (!values) {
      for (const n of NAMES) await deleteVar(gh, owner, repo, `${n}_${label}`);
      return "turned off";
    }
    await writeVar(gh, owner, repo, `REWARD_TH_DAYS_${label}`, values.th);
    await writeVar(gh, owner, repo, `REWARD_GMT_DAYS_${label}`, values.gmt);
    await writeVar(gh, owner, repo, `REWARD_START_${label}`, startFor(values, current));
    if (values.miner) await writeVar(gh, owner, repo, `REWARD_TH_MINER_${label}`, values.miner);
    else await deleteVar(gh, owner, repo, `REWARD_TH_MINER_${label}`);
    return describe({ ...values, start: startFor(values, current) });
  }

  return { modeFor, rewardDay, configFrom, describe, readVars, fieldsHtml, readFields, wirePreview, save };
})();
