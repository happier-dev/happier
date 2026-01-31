#!/bin/bash
set -euo pipefail

# Usage:
#   ./set-interval.sh 10s|30s|1m|5m|10m|15m|30m|1h|2h|6h|12h
#
# Runs non-interactively from SwiftBar:
# - figures out SwiftBar's active plugin directory
# - renames (or installs) happy-stacks.<interval>.sh
# - restarts SwiftBar so the new schedule takes effect

INTERVAL="${1:-}"
if [[ -z "$INTERVAL" ]]; then
  echo "missing interval (example: 5m)" >&2
  exit 2
fi

if ! [[ "$INTERVAL" =~ ^[0-9]+[smhd]$ ]]; then
  echo "invalid interval: $INTERVAL (expected like 10s, 5m, 1h, 1d)" >&2
  exit 2
fi

PLUGIN_DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
if [[ -z "$PLUGIN_DIR" ]]; then
  PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
fi
mkdir -p "$PLUGIN_DIR"

PLUGIN_BASENAME="${HAPPY_STACKS_SWIFTBAR_PLUGIN_BASENAME:-${HAPPY_LOCAL_SWIFTBAR_PLUGIN_BASENAME:-happy-stacks}}"
TARGET="$PLUGIN_DIR/${PLUGIN_BASENAME}.${INTERVAL}.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOME_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

CANONICAL_HOME_DIR="${HAPPY_STACKS_CANONICAL_HOME_DIR:-${HAPPY_LOCAL_CANONICAL_HOME_DIR:-$DEFAULT_HOME_DIR}}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-${HAPPY_STACKS_HOME_DIR:-$CANONICAL_HOME_DIR}}"
HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HAPPY_LOCAL_DIR}"
SOURCE="${HAPPY_LOCAL_DIR}/extras/swiftbar/happy-stacks.5s.sh"

# If a happy-stacks plugin already exists, rename it into place; otherwise copy from repo source.
EXISTING="$(ls "$PLUGIN_DIR"/"${PLUGIN_BASENAME}".*.sh 2>/dev/null | head -1 || true)"
if [[ -n "$EXISTING" ]]; then
  if [[ "$EXISTING" != "$TARGET" ]]; then
    rm -f "$TARGET"
    mv "$EXISTING" "$TARGET"
  fi
else
  if [[ ! -f "$SOURCE" ]]; then
    echo "cannot find plugin source at: $SOURCE" >&2
    exit 1
  fi
  cp "$SOURCE" "$TARGET"
fi

# Remove any other intervals to avoid duplicates in SwiftBar.
for f in "$PLUGIN_DIR"/"${PLUGIN_BASENAME}".*.sh; do
  [[ "$f" == "$TARGET" ]] && continue
  rm -f "$f" || true
done

chmod +x "$TARGET"
touch "$TARGET"

# Restart SwiftBar so the new filename interval is picked up reliably.
killall SwiftBar 2>/dev/null || true
open -a SwiftBar

echo "ok: $TARGET"
