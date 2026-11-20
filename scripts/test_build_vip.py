import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build_vip.py")
SPEC = importlib.util.spec_from_file_location("build_vip", SCRIPT)
BUILD_VIP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD_VIP)


class FindTimeOffsetTests(unittest.TestCase):
    def test_unknown_version_with_unique_branch(self):
        data = b"\x11\x22\x33\x44" + BUILD_VIP.TIME_BRANCH + b"\xaa\xbb"

        offset = BUILD_VIP.find_time_offset(data, "4.3.3")

        self.assertEqual(offset, 4)

    def test_known_signature(self):
        data = BUILD_VIP.TIME_BEFORE + BUILD_VIP.TIME_BRANCH + BUILD_VIP.TIME_AFTER

        offset = BUILD_VIP.find_time_offset(data, "4.2.3")

        self.assertEqual(offset, len(BUILD_VIP.TIME_BEFORE))


if __name__ == "__main__":
    unittest.main()
