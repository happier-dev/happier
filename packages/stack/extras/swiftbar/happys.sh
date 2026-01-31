#!/bin/bash
set -euo pipefail

# SwiftBar menu action wrapper.
# Runs `happys` using the stable shim installed under <homeDir>/bin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOME_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Treat presence of HAPPY_STACKS_SANDBOX_DIR as sandbox mode.
is_sandboxed() {
  [[ -n "${HAPPY_STACKS_SANDBOX_DIR:-}" ]]
}

# Prefer explicit env vars, but default to the install location inferred from this script path.
CANONICAL_HOME_DIR="${HAPPY_STACKS_CANONICAL_HOME_DIR:-${HAPPY_LOCAL_CANONICAL_HOME_DIR:-$DEFAULT_HOME_DIR}}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-${HAPPY_STACKS_HOME_DIR:-$CANONICAL_HOME_DIR}}"
HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HAPPY_LOCAL_DIR}"

HAPPYS_BIN="$HAPPY_LOCAL_DIR/bin/happys"
if [[ ! -x "$HAPPYS_BIN" ]]; then
  if is_sandboxed; then
    echo "happys not found in sandbox home: $HAPPYS_BIN" >&2
    echo "Tip: re-run: happys init (inside the sandbox) then re-install the menubar plugin." >&2
    exit 1
  fi
  HAPPYS_BIN="$(command -v happys 2>/dev/null || true)"
fi

if [[ -z "${HAPPYS_BIN:-}" ]]; then
  echo "happys not found (run: npx happy-stacks init, or npm i -g happy-stacks)" >&2
  exit 1
fi

exec "$HAPPYS_BIN" "$@"
