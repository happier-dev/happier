#!/usr/bin/env bash
set -euo pipefail

# Repeated Lima validation harness for hstack smoke runs.
#
# Usage (macOS host):
#   ./scripts/provision/macos-lima-hstack-repeat-validation.sh [vm-name]
#
# Env:
#   HSTACK_VERSION=latest            # @happier-dev/stack version to test (default: latest)
#   HSTACK_REPEAT_COUNT=3            # number of repeated smoke runs (default: 3)
#   HSTACK_REPEAT_OUTPUT_DIR=...     # host-side report dir (default: output/lima-validation-<ts>-<vm>)
#   HSTACK_RAW_BASE=...              # override raw github base (default: happier-dev/happier main)
#   HSTACK_PROVISION_PROFILE=happier # guest provisioning profile (default: happier)
#
# This script:
# - creates/configures a Lima VM (via macos-lima-vm.sh)
# - performs guest provisioning once on the first validation pass
# - runs repeated sandboxed `hstack` smoke tests inside the VM
# - writes per-run logs and JSON metadata under the report dir

usage() {
  cat <<'EOF'
Usage:
  ./scripts/provision/macos-lima-hstack-repeat-validation.sh [vm-name]

Examples:
  ./scripts/provision/macos-lima-hstack-repeat-validation.sh
  HSTACK_REPEAT_COUNT=5 ./scripts/provision/macos-lima-hstack-repeat-validation.sh happy-e2e
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[lima-repeat] expected macOS (Darwin); got: $(uname -s)" >&2
  exit 1
fi

for cmd in limactl python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[lima-repeat] missing required command: $cmd" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_NAME="${1:-happy-e2e}"
SAFE_VM_NAME="${VM_NAME//[^A-Za-z0-9._-]/_}"

HSTACK_VERSION="${HSTACK_VERSION:-latest}"
HSTACK_REPEAT_COUNT="${HSTACK_REPEAT_COUNT:-3}"
HSTACK_PROVISION_PROFILE="${HSTACK_PROVISION_PROFILE:-happier}"

timestamp() {
  date +"%Y%m%d-%H%M%S"
}

parse_positive_int() {
  local raw="${1:-}"
  local value
  value="$(printf '%s' "${raw}" | tr -d '[:space:]')"
  if [[ -z "${value}" || ! "${value}" =~ ^[0-9]+$ || "${value}" == "0" ]]; then
    return 1
  fi
  printf '%s' "${value}"
}

write_json_file() {
  local file_path="$1"
  shift
  python3 - "$file_path" "$@" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = json.loads(sys.argv[2])
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
PY
}

HSTACK_REPEAT_COUNT="$(parse_positive_int "${HSTACK_REPEAT_COUNT}")" || {
  echo "[lima-repeat] invalid HSTACK_REPEAT_COUNT: ${HSTACK_REPEAT_COUNT}" >&2
  exit 1
}

pick_raw_base() {
  if [[ -n "${HSTACK_RAW_BASE:-}" ]]; then
    echo "${HSTACK_RAW_BASE}"
    return 0
  fi
  local candidates=(
    "https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack"
  )
  local c
  for c in "${candidates[@]}"; do
    if curl -fsSL "${c}/scripts/provision/linux-ubuntu-provision.sh" -o /dev/null >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

HSTACK_RAW_BASE="$(pick_raw_base || true)"
if [[ -z "${HSTACK_RAW_BASE}" ]]; then
  echo "[lima-repeat] failed to auto-detect raw GitHub base URL for scripts." >&2
  echo "[lima-repeat] Fix: set HSTACK_RAW_BASE=https://raw.githubusercontent.com/<org>/<repo>/<ref>/apps/stack" >&2
  exit 1
fi

REPORT_ROOT="${HSTACK_REPEAT_OUTPUT_DIR:-output/lima-validation/$(timestamp)-${SAFE_VM_NAME}}"
REPORT_ROOT="$(python3 - "$REPORT_ROOT" <<'PY'
import os
import sys
from pathlib import Path

print(str(Path(sys.argv[1]).expanduser().resolve()))
PY
)"

GUEST_CACHE_DIR="/tmp/hstack-lima-repeat-${SAFE_VM_NAME}"
GUEST_PROVISION_SCRIPT="${GUEST_CACHE_DIR}/linux-ubuntu-provision.sh"
GUEST_SMOKE_SCRIPT="${GUEST_CACHE_DIR}/linux-ubuntu-hstack-smoke.sh"

mkdir -p "${REPORT_ROOT}/runs"

echo "[lima-repeat] vm: ${VM_NAME}"
echo "[lima-repeat] @happier-dev/stack: ${HSTACK_VERSION}"
echo "[lima-repeat] repeat count: ${HSTACK_REPEAT_COUNT}"
echo "[lima-repeat] report dir: ${REPORT_ROOT}"
echo "[lima-repeat] raw base: ${HSTACK_RAW_BASE}"

echo "[lima-repeat] ensure VM exists + port forwarding..."
"${SCRIPT_DIR}/macos-lima-vm.sh" "${VM_NAME}"

guest_command="$(cat <<'EOF'
set -euo pipefail
mkdir -p "$GUEST_CACHE_DIR"
if [[ ! -x "$GUEST_PROVISION_SCRIPT" || ! -x "$GUEST_SMOKE_SCRIPT" ]]; then
  echo '[lima-repeat] downloading guest scripts...'
  curl -fsSL "$HSTACK_RAW_BASE/scripts/provision/linux-ubuntu-provision.sh" -o "$GUEST_PROVISION_SCRIPT"
  chmod +x "$GUEST_PROVISION_SCRIPT"
  curl -fsSL "$HSTACK_RAW_BASE/scripts/provision/linux-ubuntu-hstack-smoke.sh" -o "$GUEST_SMOKE_SCRIPT"
  chmod +x "$GUEST_SMOKE_SCRIPT"
fi
if [[ "${HSTACK_REPEAT_BOOTSTRAP:-0}" == "1" ]]; then
  echo '[lima-repeat] guest provisioning...'
  "$GUEST_PROVISION_SCRIPT" --profile="$HSTACK_PROVISION_PROFILE"
fi
echo '[lima-repeat] guest smoke...'
"$GUEST_SMOKE_SCRIPT"
EOF
)"

run_meta_paths=()
run_descriptions=()

for i in $(seq 1 "${HSTACK_REPEAT_COUNT}"); do
  run_id="$(printf '%02d' "${i}")"
  run_dir="${REPORT_ROOT}/runs/${run_id}"
  guest_log="${run_dir}/guest.log"
  meta_path="${run_dir}/meta.json"
  guest_smoke_dir="/tmp/hstack-smoke-${SAFE_VM_NAME}-$(timestamp)-${run_id}"
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  bootstrap_flag=0
  if [[ "${i}" == "1" ]]; then
    bootstrap_flag=1
  fi

  echo "[lima-repeat] run ${run_id}/${HSTACK_REPEAT_COUNT}: ${guest_smoke_dir}"

  mkdir -p "${run_dir}"
  set +e
  limactl shell "${VM_NAME}" -- env \
    GUEST_CACHE_DIR="${GUEST_CACHE_DIR}" \
    GUEST_PROVISION_SCRIPT="${GUEST_PROVISION_SCRIPT}" \
    GUEST_SMOKE_SCRIPT="${GUEST_SMOKE_SCRIPT}" \
    HSTACK_RAW_BASE="${HSTACK_RAW_BASE}" \
    HSTACK_PROVISION_PROFILE="${HSTACK_PROVISION_PROFILE}" \
    HSTACK_REPEAT_BOOTSTRAP="${bootstrap_flag}" \
    HSTACK_VERSION="${HSTACK_VERSION}" \
    HSTACK_SMOKE_KEEP="1" \
    HSTACK_SMOKE_DIR="${guest_smoke_dir}" \
    bash -lc "${guest_command}" 2>&1 | tee "${guest_log}"
  status="${PIPESTATUS[0]}"
  set -e

  ended_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_json_file "${meta_path}" "$(python3 - "$run_id" "$HSTACK_REPEAT_COUNT" "$status" "$guest_smoke_dir" "$guest_log" "$meta_path" "$started_at" "$ended_at" "$bootstrap_flag" "$VM_NAME" "$REPORT_ROOT" <<'PY'
import json
import sys

run_id, repeat_count, status, guest_smoke_dir, guest_log, meta_path, started_at, ended_at, bootstrap_flag, vm_name, report_root = sys.argv[1:]
payload = {
    'runId': run_id,
    'repeatCount': int(repeat_count),
    'status': int(status),
    'guestSmokeDir': guest_smoke_dir,
    'logPath': guest_log,
    'metaPath': meta_path,
    'startedAt': started_at,
    'endedAt': ended_at,
    'bootstrap': bootstrap_flag == '1',
    'vmName': vm_name,
    'reportRoot': report_root,
}
print(json.dumps(payload))
PY
)"
  run_meta_paths+=("${meta_path}")
  run_descriptions+=("${run_id}:${status}:${guest_smoke_dir}")

  if [[ "${status}" != "0" ]]; then
    echo "[lima-repeat] run ${run_id} failed; inspect ${guest_log} and ${meta_path}" >&2
    break
  fi
done

summary_path="${REPORT_ROOT}/summary.json"
write_json_file "${summary_path}" "$(python3 - "$VM_NAME" "$HSTACK_REPEAT_COUNT" "$REPORT_ROOT" "${run_meta_paths[@]}" <<'PY'
import json
import sys
from pathlib import Path

vm_name = sys.argv[1]
repeat_count = int(sys.argv[2])
report_root = sys.argv[3]
meta_paths = [Path(p) for p in sys.argv[4:]]
runs = []
for path in meta_paths:
    if path.exists():
      runs.append(json.loads(path.read_text(encoding='utf-8')))

payload = {
    'vmName': vm_name,
    'repeatCount': repeat_count,
    'reportRoot': report_root,
    'runs': runs,
}
print(json.dumps(payload))
PY
)"

if [[ "${#run_meta_paths[@]}" -eq 0 ]]; then
  echo "[lima-repeat] no runs executed" >&2
  exit 1
fi

if [[ "${status:-0}" != "0" ]]; then
  exit "${status}"
fi

echo "[lima-repeat] done"
echo "[lima-repeat] summary: ${summary_path}"
for description in "${run_descriptions[@]}"; do
  echo "[lima-repeat] run ${description}"
done
