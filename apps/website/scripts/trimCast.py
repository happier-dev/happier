#!/usr/bin/env python3
"""Trim leading dead time from an asciinema cast and normalize to v2.

Accepts asciicast v2 or v3 input and always writes v2 output (absolute
timestamps + flat header), since the marketing site's CastPlayer only
parses v2.

  - v2 events look like `[absolute_t, "o", "<bytes>"]`.
  - v3 events look like `[interval, "o", "<bytes>"]` (delta since prev).
  - v3 headers nest terminal info under `term: { cols, rows, theme, ... }`,
    while v2 has flat top-level `width`/`height`.

We:
  1. Detect the format from the header `version`.
  2. Convert to a normalized list of (absolute_t, "o", data) tuples.
  3. Find the first event whose output payload is "substantial"
     (>= --min-bytes; default 80) — this skips terminal init sequences
     during boot (they're typically <30 bytes each).
  4. Drop everything before `pivot_t - lead_in` (default 0.5s).
  5. Rebase timestamps so the first kept event lands at t=0.
  6. Emit a v2 cast with flat width/height pulled from v3's `term` block.

Usage:
    trimCast.py <cast.cast> [--out trimmed.cast] [--min-bytes 80] [--lead-in 0.5]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def normalize(cast_path: Path) -> tuple[dict, list[tuple[float, str, str]]]:
    """Parse v2 or v3 cast, return (v2-style header, absolute-timed events)."""
    raw_lines = cast_path.read_text().splitlines()
    if not raw_lines:
        raise SystemExit(f"empty cast: {cast_path}")

    header = json.loads(raw_lines[0])
    version = header.get("version")

    if version == 2:
        # v2: flat header, absolute timestamps already.
        events: list[tuple[float, str, str]] = []
        for raw in raw_lines[1:]:
            if not raw.strip():
                continue
            try:
                t, kind, data = json.loads(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            events.append((float(t), kind, data))
        return header, events

    if version == 3:
        # v3: nested term, intervals between events. Sum to absolute.
        term = header.get("term", {}) or {}
        v2_header = {
            "version": 2,
            "width": term.get("cols", 80),
            "height": term.get("rows", 24),
            "timestamp": header.get("timestamp"),
            "command": header.get("command"),
            "env": header.get("env", {}),
        }
        events = []
        clock = 0.0
        for raw in raw_lines[1:]:
            if not raw.strip():
                continue
            try:
                interval, kind, data = json.loads(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            clock += float(interval)
            events.append((clock, kind, data))
        return v2_header, events

    raise SystemExit(f"unsupported cast version: {version}")


def trim(
    cast_path: Path,
    out_path: Path,
    min_bytes: int,
    lead_in: float,
) -> tuple[float, int, int]:
    header, events = normalize(cast_path)
    if not events:
        raise SystemExit("no events in cast")

    # First substantive output. Large payloads are the "TUI rendered" signal —
    # control sequences during startup are typically <30 bytes each.
    pivot_idx = next(
        (
            i
            for i, (_, kind, data) in enumerate(events)
            if kind == "o" and len(data) >= min_bytes
        ),
        None,
    )
    if pivot_idx is None:
        raise SystemExit(
            f"no event with >= {min_bytes} bytes; cast is all silent setup"
        )

    pivot_t = events[pivot_idx][0]
    cutoff = max(0.0, pivot_t - lead_in)
    kept = [(t, k, d) for (t, k, d) in events if t >= cutoff]

    # Rebase timestamps so the first kept event starts at t=0.
    base = kept[0][0]
    rebased = [(round(t - base, 6), k, d) for (t, k, d) in kept]

    with out_path.open("w") as f:
        f.write(json.dumps(header) + "\n")
        for t, k, d in rebased:
            f.write(json.dumps([t, k, d]) + "\n")

    return base, len(events), len(rebased)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cast", type=Path, help="input .cast file (asciinema v2 or v3)")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output path; defaults to overwriting the input",
    )
    ap.add_argument(
        "--min-bytes",
        type=int,
        default=80,
        help="minimum output size to count as 'substantive' (default 80)",
    )
    ap.add_argument(
        "--lead-in",
        type=float,
        default=0.5,
        help="seconds to keep before the first substantive event (default 0.5)",
    )
    args = ap.parse_args()

    out = args.out or args.cast
    base, before, after = trim(args.cast, out, args.min_bytes, args.lead_in)
    print(
        f"trimmed {args.cast.name}: {before} → {after} events; "
        f"dropped {base:.1f}s of leading silence",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
