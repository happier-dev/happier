#!/usr/bin/env python3
"""Sanitize personal info from an asciinema v2 cast.

Why byte-equal replacements: cast events contain ANSI escape sequences with
relative cursor moves like `\\x1b[5C` (cursor right 5). If we shorten the
visible text without compensating, every following cursor escape lands at
a column shifted by the difference, which scrambles box-drawing and
multi-column layouts. So every replacement here keeps the same number of
*visible characters* (escape sequences are invisible; we only count the
letters/digits/punct that move the cursor by 1).

The trailing padding shows up as a stretch of empty cells in the rendered
TUI — visually a bit more whitespace than the original, but layout intact.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


# (pattern, replacement-prefix). The script auto-pads the replacement with
# trailing spaces to match the original visible-char length.
SUBSTITUTIONS: list[tuple[str, str]] = [
    # Email: 23 chars including "'s" → 20 chars, pad 3 spaces.
    ("leeroy.brun@gmail.com's", "we-are@happier.dev's"),
    # Path segment: drop the demo-projects directory level. The project name
    # follows, so we replace `happier-demo-projects/<name>` with `<name>`
    # padded to the original length.
    # Handled dynamically below since <name> varies.
]

# Pattern that captures the project name after `happier-demo-projects/`.
# Some casts split the path across two events (e.g. Codex prints
# `happier-demo-projects/` then a cursor-move escape, then `atlas` in a
# later byte chunk). We handle both: with-name first, then bare prefix.
PATH_PATTERN_WITH_NAME = re.compile(r"happier-demo-projects/([a-zA-Z0-9_-]+)")
PATH_PATTERN_BARE = re.compile(r"happier-demo-projects/")


def visible_len(s: str) -> int:
    """Count visible (cursor-advancing) characters. We approximate by counting
    everything that's not part of an ANSI escape sequence — but the
    substitutions in this file only operate on plain text segments that
    contain no escape codes, so simple len() is fine."""
    return len(s)


def pad_to(replacement: str, target_len: int) -> str:
    diff = target_len - visible_len(replacement)
    if diff < 0:
        raise ValueError(
            f"replacement {replacement!r} is longer than target ({len(replacement)} > {target_len})"
        )
    return replacement + (" " * diff)


def apply_substitutions(data: str) -> str:
    out = data
    for old, new_prefix in SUBSTITUTIONS:
        if old in out:
            new = pad_to(new_prefix, len(old))
            out = out.replace(old, new)

    # Path with embedded project name. Replace `happier-demo-projects/<name>`
    # with `<name>` + spaces to match the full match length.
    def path_with_name(m: re.Match[str]) -> str:
        full = m.group(0)
        project = m.group(1)
        return pad_to(project, len(full))

    out = PATH_PATTERN_WITH_NAME.sub(path_with_name, out)

    # Bare `happier-demo-projects/` (22 chars) where the project name lands
    # in a separate event after an escape. Replace with 22 spaces — keeps
    # cursor position correct without surfacing a stray project name fragment.
    out = PATH_PATTERN_BARE.sub(" " * 22, out)
    return out


def sanitize(in_path: Path, out_path: Path) -> tuple[int, int]:
    """Returns (events_processed, events_modified)."""
    raw = in_path.read_text().splitlines()
    if not raw:
        raise SystemExit(f"empty cast: {in_path}")

    header_line = raw[0]
    out_lines = [header_line]
    processed = 0
    modified = 0

    for line in raw[1:]:
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            out_lines.append(line)
            continue
        processed += 1
        if len(e) >= 3 and e[1] == "o":
            new_data = apply_substitutions(e[2])
            if new_data != e[2]:
                modified += 1
                e[2] = new_data
        out_lines.append(json.dumps(e))

    out_path.write_text("\n".join(out_lines) + "\n")
    return processed, modified


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cast", type=Path, help="input .cast file (asciinema v2)")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output path; defaults to overwriting the input",
    )
    args = ap.parse_args()

    out = args.out or args.cast
    processed, modified = sanitize(args.cast, out)
    print(
        f"sanitized {args.cast.name}: {modified}/{processed} events modified",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
