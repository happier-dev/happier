#!/bin/bash
set -euo pipefail

# Back-compat wrapper for SwiftBar menu actions.
# Historically this executed `pnpm`; now it delegates to `happys.sh`.

CANONICAL_HOME_DIR="${HAPPY_STACKS_CANONICAL_HOME_DIR:-${HAPPY_LOCAL_CANONICAL_HOME_DIR:-$HOME/.happy-stacks}}"
HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$CANONICAL_HOME_DIR}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HAPPY_STACKS_HOME_DIR}"

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/happys.sh" "$@"
