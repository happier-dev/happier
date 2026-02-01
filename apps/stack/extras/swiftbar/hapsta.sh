#!/bin/bash
set -euo pipefail

# SwiftBar menu action wrapper.
# Runs `hapsta` using the stable shim installed under <homeDir>/bin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOME_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Prefer explicit env vars, but default to the install location inferred from this script path.
CANONICAL_HOME_DIR="${HAPPIER_STACK_CANONICAL_HOME_DIR:-$DEFAULT_HOME_DIR}"
CANONICAL_ENV_FILE="${CANONICAL_HOME_DIR%/}/.env"

HOME_DIR="${HAPPIER_STACK_HOME_DIR:-}"
if [[ -z "$HOME_DIR" && -f "$CANONICAL_ENV_FILE" ]]; then
  HOME_DIR="$(grep -E '^HAPPIER_STACK_HOME_DIR=' "$CANONICAL_ENV_FILE" 2>/dev/null | head -n 1 | sed 's/^HAPPIER_STACK_HOME_DIR=//' || true)"
fi
HOME_DIR="${HOME_DIR:-$DEFAULT_HOME_DIR}"

export HAPPIER_STACK_HOME_DIR="$HOME_DIR"
export HAPPIER_STACK_CANONICAL_HOME_DIR="$CANONICAL_HOME_DIR"

HAPSTA_BIN="$HOME_DIR/bin/hapsta"
if [[ ! -x "$HAPSTA_BIN" ]]; then
  # Allow installs that used the alias name as the shim.
  HAPSTA_BIN="$HOME_DIR/bin/happier-stack"
fi

if [[ ! -x "$HAPSTA_BIN" ]]; then
  # Fall back to PATH (best-effort).
  HAPSTA_BIN="$(command -v hapsta 2>/dev/null || true)"
fi

if [[ -z "${HAPSTA_BIN:-}" ]]; then
  echo "hapsta not found. Run: npx @happier-dev/stack@latest init" >&2
  exit 1
fi

exec "$HAPSTA_BIN" "$@"

