#!/usr/bin/env python3
"""Build a VIP-unlocked iPoGo .deb from the latest upstream release.

The patch is deliberately minimal:
  1. re-encode the 37-byte activation URL blob to point at
     https://ipogo.alexspac.es/vip?abcdefg
  2. NOP the server-time sync branch in the VIP response handler

No RSA-verify patch, no injected dylib, no swizzles.
"""
from __future__ import annotations

import bz2
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UPSTREAM = "https://ipogo.app/repo"
SALT = b"UITableViewNSObject"
PACKAGE = "com.iteam.ipogo"
NEW_URL = b"https://ipogo.alexspac.es/vip?abcdefg"
URL_LEN = 37
NOP = bytes.fromhex("1f2003d5")
TIME_OFFSETS = {
    "4.2.3": 0x2FB2B4,
    "4.2.4": 0x2FB1B0,
    "4.3.3": 0x3018AC,
    "4.3.4": 0x301630,
    "4.3.5": 0x305E38,
}
# The gate rejects a VIP response whose signed timestamp is older than the
# local clock.  Its branch sits inside this straight-line sequence:
#     lsl   xN, xN, #shift
#     scvtf sN, wN
#     cmp   wN, wN, <shift>
#     b.vs  <...>
#     add   wN, wN, #<seconds>
#     subs  wzr, wN, #0x43
#     b.hi  <expired>
# Register allocation, stack layout and every PC-relative displacement move
# between releases (all three moved in 4.3.5), so compare opcode shape only.
TIME_SHAPE = (
    (-24, 0xFFFFFC00, 0xD360FC00),  # lsl (immediate)
    (-20, 0xFFFFFC00, 0x1E780000),  # scvtf
    (-16, 0xFFE0FC00, 0x6B000000),  # add/sub (shifted register)
    (-12, 0xFF00000F, 0x54000006),  # b.vs
    (-8, 0xFFC00000, 0x11000000),   # add (immediate)
    (-4, 0xFFC0001F, 0x7100001F),   # subs wzr, wN, #imm
)
TIME_BRANCH_MASK = 0xFF00000F
TIME_BRANCH_HI = 0x54000008  # b.hi; imm19 displacement not compared
DYLIB_REL = "var/jb/Library/MobileSubstrate/DynamicLibraries/ipogotweak.dylib"
RELEASE_URL = "https://github.com/AlexSpaces/ipogo-mirror/releases/download/vip-latest"
OUT = Path("out")
LEGACY_FILE = Path("legacy.json")


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "ipogo-mirror-vip-builder/1.0"})
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.read()


def parse_records(text: str) -> list[dict[str, str]]:
    records = []
    for block in re.split(r"\n\s*\n", text.strip()):
        record = {}
        for line in block.splitlines():
            if ": " in line:
                key, value = line.split(": ", 1)
                record[key] = value
        if record:
            records.append(record)
    return records


def latest_ipogo(records: list[dict[str, str]]) -> dict[str, str]:
    matches = [record for record in records if record.get("Package") == PACKAGE]
    if not matches:
        raise SystemExit("upstream Packages has no com.iteam.ipogo record")
    return matches[-1]


def xor_mask(data: bytes) -> bytes:
    return bytes(byte ^ SALT[index % len(SALT)] for index, byte in enumerate(data))


def find_url_offset(data: bytes, salt: bytes) -> tuple[int, str]:
    prefix = bytes(byte ^ salt[index % len(salt)] for index, byte in enumerate(b"https://"))
    cursor = 0
    while True:
        offset = data.find(prefix, cursor)
        if offset < 0:
            break
        decoded = bytes(
            data[offset + index] ^ salt[index % len(salt)]
            for index in range(min(96, len(data) - offset))
        )
        if decoded.startswith(b"https://") and b"vip_activate" in decoded:
            end = decoded.find(b"vip_activate") + len(b"vip_activate")
            return offset, decoded[:end].decode("utf-8", "strict")
        cursor = offset + 1
    raise SystemExit("could not locate the activation URL blob")


def find_time_offset(data: bytes, base: str) -> int:
    for offset in range(0, len(data) - 3, 4):
        word = int.from_bytes(data[offset:offset + 4], "little")
        if word & TIME_BRANCH_MASK != TIME_BRANCH_HI:
            continue
        if all(
            offset + delta >= 0
            and int.from_bytes(data[offset + delta:offset + delta + 4], "little") & mask == value
            for delta, mask, value in TIME_SHAPE
        ):
            return offset

    fallback = TIME_OFFSETS.get(base)
    if fallback is not None:
        word = int.from_bytes(data[fallback:fallback + 4], "little")
        if word & TIME_BRANCH_MASK == TIME_BRANCH_HI:
            return fallback
    raise SystemExit(f"could not locate the server-time check for iPoGo {base}")


def patch_deb(deb_path: Path, version: str, base_version: str, upstream_sha: str) -> dict:
    work = Path(tempfile.mkdtemp(prefix="ipogo-vip-"))
    root = work / "root"
    root.mkdir()
    subprocess.run(["dpkg-deb", "-R", str(deb_path), str(root)], check=True)

    dylib = root / DYLIB_REL
    if not dylib.exists():
        raise SystemExit(f"dylib not found in package: {DYLIB_REL}")
    data = bytearray(dylib.read_bytes())

    url_offset, old_url = find_url_offset(bytes(data), SALT)
    if len(old_url.encode()) != URL_LEN or len(NEW_URL) != URL_LEN:
        raise SystemExit(f"URL length mismatch: old={len(old_url.encode())} new={len(NEW_URL)}")
    data[url_offset:url_offset + URL_LEN] = xor_mask(NEW_URL)

    base = base_version.split("-", 1)[0]
    time_offset = find_time_offset(bytes(data), base)
    found = int.from_bytes(bytes(data[time_offset:time_offset + 4]), "little")
    if found & TIME_BRANCH_MASK != TIME_BRANCH_HI:
        raise SystemExit(f"unexpected time-check instruction at 0x{time_offset:X}: {found:08x}")
    data[time_offset:time_offset + 4] = NOP

    dylib.write_bytes(data)
    print(f"patched URL at 0x{url_offset:X}: {old_url} -> {NEW_URL.decode()}")
    print(f"patched time check at 0x{time_offset:X}: {found:08x} -> {NOP.hex()}")

    control = root / "DEBIAN" / "control"
    control_text = control.read_text()
    control_text = re.sub(r"^Version: .*$", f"Version: {version}", control_text, count=1, flags=re.M)
    control.write_text(control_text)

    md5sums = root / "DEBIAN" / "md5sums"
    digest = hashlib.md5(data).hexdigest()
    if md5sums.exists():
        lines = md5sums.read_text().splitlines()
        replaced = False
        for index, line in enumerate(lines):
            if line.endswith("  " + DYLIB_REL):
                lines[index] = f"{digest}  {DYLIB_REL}"
                replaced = True
        if not replaced:
            lines.append(f"{digest}  {DYLIB_REL}")
        md5sums.write_text("\n".join(lines) + "\n")

    OUT.mkdir(exist_ok=True)
    output = OUT / "ipogo_vip_latest.deb"
    if output.exists():
        output.unlink()
    subprocess.run(["dpkg-deb", "--root-owner-group", "-b", str(root), str(output)], check=True)
    shutil.rmtree(work, ignore_errors=True)

    blob = output.read_bytes()
    sha256 = hashlib.sha256(blob).hexdigest()
    md5 = hashlib.md5(blob).hexdigest()
    sha1 = hashlib.sha1(blob).hexdigest()

    record = {
        "Package": PACKAGE,
        "Version": version,
        "Architecture": "iphoneos-arm64",
        "Maintainer": "iTeam",
        "Depends": "firmware (>=15.0)",
        "Conflicts": "sx.pokego.bypass, sx.pokego.me, sx.pokegobeta.me, sx.pokegovip.me,  com.spooferpro.jb",
        "Filename": "./debs/ipogo_vip_latest.deb",
        "Size": str(len(blob)),
        "MD5sum": md5,
        "SHA1": sha1,
        "SHA256": sha256,
        "Section": "Tweaks",
        "Description": "An awesome Pokémon GO tweak!",
        "Author": "iTeam",
        "Depiction": "https://ipogo.app/repo/depictions/?p=com.iteam.ipogo",
        "Name": "iPoGo",
    }
    record_text = "\n".join(f"{key}: {value}" for key, value in record.items())

    manifest = {
        "version": version,
        "base_version": base_version,
        "base_sha256": upstream_sha,
        "filename": output.name,
        "sha256": sha256,
        "size": len(blob),
        "url": f"{RELEASE_URL}/{output.name}",
        "record": record_text,
        "built_at": datetime.now(timezone.utc).isoformat(),
    }
    print(f"built {output} ({len(blob)} bytes, sha256 {sha256})")
    return manifest


def main() -> None:
    packages = fetch(f"{UPSTREAM}/Packages").decode("utf-8")
    stock = latest_ipogo(parse_records(packages))
    base_version = stock["Version"]
    filename = stock["Filename"].lstrip("./")
    upstream_sha = stock.get("SHA256", "")
    print(f"latest upstream: {base_version} ({filename})")

    OUT.mkdir(exist_ok=True)
    deb_path = OUT / "upstream.deb"
    deb_path.write_bytes(fetch(f"{UPSTREAM}/{filename}"))
    if upstream_sha and hashlib.sha256(deb_path.read_bytes()).hexdigest() != upstream_sha:
        raise SystemExit("upstream deb SHA256 does not match Packages")

    manifest = patch_deb(deb_path, f"{base_version}+vip", base_version, upstream_sha)
    deb_path.unlink(missing_ok=True)

    legacy = json.loads(LEGACY_FILE.read_text()) if LEGACY_FILE.exists() else []
    merged = packages.rstrip()
    for item in legacy:
        if f"Version: {item['version']}" not in packages:
            merged += "\n\n" + item["record"].strip()
    merged += "\n\n" + manifest["record"].strip() + "\n"
    packages_bytes = merged.encode("utf-8")
    gz_bytes = gzip.compress(packages_bytes, mtime=0)
    bz2_bytes = bz2.compress(packages_bytes)
    (OUT / "Packages").write_bytes(packages_bytes)
    (OUT / "Packages.gz").write_bytes(gz_bytes)
    (OUT / "Packages.bz2").write_bytes(bz2_bytes)

    release = (
        "Origin: iPoGoRepo\n"
        "Label: iPoGoRepo\n"
        "Suite: stable\n"
        f"Version: {base_version}\n"
        "Codename: ios\n"
        "Architectures: iphoneos-arm iphoneos-arm64\n"
        "Components: main\n"
        "Description: iPoGoRepo - An awesome Pokémon GO tweak!\n"
        f"Date: {datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')}\n"
        "SHA256:\n"
        f" {hashlib.sha256(packages_bytes).hexdigest()} {len(packages_bytes)} Packages\n"
        f" {hashlib.sha256(gz_bytes).hexdigest()} {len(gz_bytes)} Packages.gz\n"
        f" {hashlib.sha256(bz2_bytes).hexdigest()} {len(bz2_bytes)} Packages.bz2\n"
    )
    (OUT / "Release").write_text(release)

    manifest.update({
        "packages_url": f"{RELEASE_URL}/Packages",
        "packages_gz_url": f"{RELEASE_URL}/Packages.gz",
        "packages_bz2_url": f"{RELEASE_URL}/Packages.bz2",
        "release_url": f"{RELEASE_URL}/Release",
        "legacy": {
            item["filename"]: item["url"]
            for item in legacy
            if item.get("filename") and item.get("url")
        },
    })
    (OUT / "vip.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {OUT / 'Packages'} ({len(packages_bytes)} bytes), Packages.gz, Packages.bz2, Release, vip.json")


if __name__ == "__main__":
    main()
