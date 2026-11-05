"""Tests for the pure parts of the TH/GOMINING reward rotation.

Run with:  python -m unittest discover tests
Works without the real dependencies installed: sentry_sdk and playwright are stubbed if missing,
since only the pure functions are exercised here (the page-driving part is proven live).
"""
import importlib.util
import os
import sys
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path


def _load_script():
    for name in ("sentry_sdk", "sentry_sdk.crons", "sentry_sdk.crons.consts", "playwright", "playwright.sync_api"):
        try:
            importlib.import_module(name)
        except ImportError:
            sys.modules[name] = types.ModuleType(name)
    stubs = {
        "sentry_sdk.crons": {"capture_checkin": None},
        "sentry_sdk.crons.consts": {"MonitorStatus": None},
        "playwright.sync_api": {"TimeoutError": TimeoutError, "sync_playwright": None},
    }
    for module, attrs in stubs.items():
        for attr, value in attrs.items():
            if not hasattr(sys.modules[module], attr):
                setattr(sys.modules[module], attr, value)
    path = Path(__file__).resolve().parent.parent / "gomining_maintenance.py"
    spec = importlib.util.spec_from_file_location("gomining_maintenance", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gm = _load_script()


class RewardModeFor(unittest.TestCase):
    start = date(2026, 11, 5)

    def modes(self, th, gmt, days):
        return [gm.reward_mode_for(date.fromordinal(self.start.toordinal() + d), th, gmt, self.start)[0]
                for d in range(days)]

    def test_five_and_five(self):
        self.assertEqual(self.modes(5, 5, 12), ["TH"] * 5 + ["GMT"] * 5 + ["TH"] * 2)

    def test_uneven_split(self):
        self.assertEqual(self.modes(7, 3, 11), ["TH"] * 7 + ["GMT"] * 3 + ["TH"])

    def test_zero_means_always_the_other(self):
        self.assertEqual(set(self.modes(0, 4, 9)), {"GMT"})
        self.assertEqual(set(self.modes(4, 0, 9)), {"TH"})

    def test_days_before_start_continue_the_cycle(self):
        before = date(2026, 11, 4)
        self.assertEqual(gm.reward_mode_for(before, 5, 5, self.start), ("GMT", 5, 5))

    def test_position_is_reported(self):
        self.assertEqual(gm.reward_mode_for(date(2026, 11, 7), 5, 5, self.start), ("TH", 3, 5))
        self.assertEqual(gm.reward_mode_for(date(2026, 11, 11), 5, 5, self.start), ("GMT", 2, 5))

    def test_leap_day_counts_as_a_day(self):
        start = date(2028, 2, 27)
        self.assertEqual(gm.reward_mode_for(date(2028, 3, 1), 3, 3, start), ("GMT", 1, 3))


class RewardDay(unittest.TestCase):
    def test_late_evening_utc_run_works_for_next_day(self):
        self.assertEqual(gm.reward_day(datetime(2026, 11, 5, 23, 15, tzinfo=timezone.utc)), date(2026, 11, 6))

    def test_after_midnight_run_same_day(self):
        self.assertEqual(gm.reward_day(datetime(2026, 11, 6, 0, 15, tzinfo=timezone.utc)), date(2026, 11, 6))


class RewardRotationConfig(unittest.TestCase):
    def setUp(self):
        self._env = {k: v for k, v in os.environ.items() if k.startswith("REWARD_")}
        for k in self._env:
            del os.environ[k]

    def tearDown(self):
        os.environ.update(self._env)

    def test_off_when_unset(self):
        self.assertIsNone(gm.reward_rotation_config("MAIN", {}))

    def test_full_config(self):
        cfg = gm.reward_rotation_config("main", {
            "REWARD_TH_DAYS_MAIN": "5", "REWARD_GMT_DAYS_MAIN": "5",
            "REWARD_START_MAIN": "2026-11-05", "REWARD_TH_MINER_MAIN": "#123456",
        })
        self.assertEqual(cfg, {"th_days": 5, "gmt_days": 5, "start": date(2026, 11, 5), "miner": "123456"})

    def test_one_side_blank_means_zero_and_default_start(self):
        cfg = gm.reward_rotation_config("MAIN", {"REWARD_GMT_DAYS_MAIN": "3"})
        self.assertEqual((cfg["th_days"], cfg["gmt_days"], cfg["start"]), (0, 3, date(2026, 1, 1)))

    def test_rejects_bad_values(self):
        for bad in ({"REWARD_TH_DAYS_MAIN": "five"}, {"REWARD_TH_DAYS_MAIN": "-1"},
                    {"REWARD_TH_DAYS_MAIN": "999"},
                    {"REWARD_TH_DAYS_MAIN": "0", "REWARD_GMT_DAYS_MAIN": "0"},
                    {"REWARD_TH_DAYS_MAIN": "5", "REWARD_START_MAIN": "next week"},
                    {"REWARD_TH_DAYS_MAIN": "5", "REWARD_TH_MINER_MAIN": "the big one"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                gm.reward_rotation_config("MAIN", bad)

    def test_environment_wins_over_variables(self):
        os.environ["REWARD_TH_DAYS_MAIN"] = "2"
        cfg = gm.reward_rotation_config("MAIN", {"REWARD_TH_DAYS_MAIN": "9", "REWARD_GMT_DAYS_MAIN": "1"})
        self.assertEqual(cfg["th_days"], 2)

    def test_reads_gh_vars_json(self):
        os.environ["GH_VARS"] = '{"REWARD_TH_DAYS_MAIN": "4", "REWARD_GMT_DAYS_MAIN": "6"}'
        try:
            self.assertEqual(gm.reward_rotation_config("MAIN")["gmt_days"], 6)
        finally:
            del os.environ["GH_VARS"]


class ChooseMinerOption(unittest.TestCase):
    options = ["The Mine Box #654321 1 TH 12 W/TH", "The Mine Box #123456 9 TH 12 W/TH", "Other #1 4.88 TH"]

    def test_picks_the_named_miner(self):
        self.assertEqual(gm.choose_miner_option(self.options, "654321"), (0, "the miner you chose"))

    def test_defaults_to_biggest(self):
        self.assertEqual(gm.choose_miner_option(self.options)[0], 1)

    def test_falls_back_to_biggest_when_named_miner_missing(self):
        index, note = gm.choose_miner_option(self.options, "999")
        self.assertEqual(index, 1)
        self.assertIn("isn't in GoMining's list", note)

    def test_empty_list(self):
        self.assertIsNone(gm.choose_miner_option([])[0])

    def test_unreadable_sizes_pick_first(self):
        self.assertEqual(gm.choose_miner_option(["Miner A", "Miner B"])[0], 0)


if __name__ == "__main__":
    unittest.main()
