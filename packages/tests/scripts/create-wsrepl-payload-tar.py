#!/usr/bin/env python3
from __future__ import annotations

import sys
import tarfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: create-wsrepl-payload-tar.py <source-dir> <output-tar>", file=sys.stderr)
        return 2

    source_dir = Path(sys.argv[1]).expanduser().resolve()
    output_tar = Path(sys.argv[2]).expanduser().resolve()

    if not source_dir.is_dir():
        print(f"[wsrepl-qa] payload source dir does not exist: {source_dir}", file=sys.stderr)
        return 2

    output_tar.parent.mkdir(parents=True, exist_ok=True)
    if output_tar.exists():
        output_tar.unlink()

    with tarfile.open(output_tar, "w") as archive:
        archive.add(source_dir, arcname=".", recursive=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
