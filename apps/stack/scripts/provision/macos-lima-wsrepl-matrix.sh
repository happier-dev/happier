#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TARGET_SCRIPT="${REPO_DIR}/packages/tests/scripts/wsrepl-lima-matrix.sh"

if [[ ! -f "${TARGET_SCRIPT}" ]]; then
  echo "[wsrepl-qa] missing relocated tests-owned harness: ${TARGET_SCRIPT}" >&2
  exit 1
fi

exec "${TARGET_SCRIPT}" "$@"
