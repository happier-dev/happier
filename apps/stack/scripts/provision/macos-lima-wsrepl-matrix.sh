#!/usr/bin/env bash
set -euo pipefail

# Host↔Lima workspace replication/handoff QA harness (non-destructive).
#
# This runner:
# - ensures a Lima VM exists + has localhost port forwarding (via macos-lima-vm.sh)
# - captures host + guest diagnostics into a timestamped report directory
# - runs a Playwright-driven session-handoff workspace-transfer matrix against a real stack UI
#
# Usage (macOS host, from apps/stack/):
#   ./scripts/provision/macos-lima-wsrepl-matrix.sh [vm-name]
#
# Required env for the Playwright matrix:
#   HAPPIER_QA_SESSION_ID=...
#   HAPPIER_QA_STEPS_JSON='[{"targetMachineId":"...","strategy":"transfer_snapshot"},{"targetMachineId":"...","strategy":"sync_changes"}]'
#
# Convenience env (repeatable matrix defaults):
#   WSREPL_QA_HOST_MACHINE_ID=...    # used to derive HAPPIER_QA_STEPS_JSON when omitted
#   WSREPL_QA_VM_MACHINE_ID=...      # used to derive HAPPIER_QA_STEPS_JSON when omitted
#   WSREPL_QA_LARGE_REPO_PATH=...    # sets HAPPIER_QA_SESSION_PATH when omitted
#
# Optional env:
#   HAPPIER_UI_URL="http://.../?server=..."
#   HAPPIER_QA_HEADLESS=1
#   HAPPIER_QA_RETRIES_PER_STEP=2
#   WSREPL_QA_OUTPUT_DIR=...  # default: output/wsrepl-lima-matrix/<ts>-<vm>
#   WSREPL_QA_TIMEOUT_MS=...  # default: 1800000 (30min) when HAPPIER_QA_TIMEOUT_MS is unset
#   WSREPL_QA_FORCE_VM_RECONFIGURE=1  # force stop/reconfigure/start via macos-lima-vm.sh (default is reuse-first)
#   WSREPL_QA_VM_HAPPIER_MODE=skip|require|autoupdate  # default: require (fail closed if the guest is running an unexpected Happier build)
#     - autoupdate builds a Linux CLI artifact from this repo and installs it into the VM
#   WSREPL_QA_VM_BUN_TARGET=bun-linux-arm64|bun-linux-x64-baseline  # override bun target for autoupdate

usage() {
  cat <<'EOF'
Usage:
  ./scripts/provision/macos-lima-wsrepl-matrix.sh [vm-name]

Examples:
  WSREPL_QA_OUTPUT_DIR=output/wsrepl-lima-matrix-local \
  HAPPIER_UI_URL="http://localhost:19364/?server=http%3A%2F%2Flocalhost%3A53288&happier_hmr=0" \
  HAPPIER_QA_SESSION_ID="..." \
  HAPPIER_QA_STEPS_JSON='[{"targetMachineId":"<vmMachineId>","strategy":"transfer_snapshot"},{"targetMachineId":"<hostMachineId>","strategy":"sync_changes"}]' \
  ./scripts/provision/macos-lima-wsrepl-matrix.sh happier-wsrepl-qa-0323

  # Or: let the wrapper derive the default 2-step host↔VM matrix.
  WSREPL_QA_HOST_MACHINE_ID="<hostMachineId>" \
  WSREPL_QA_VM_MACHINE_ID="<vmMachineId>" \
  HAPPIER_QA_SESSION_ID="..." \
  ./scripts/provision/macos-lima-wsrepl-matrix.sh happier-wsrepl-qa-0323
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[wsrepl-qa] expected macOS (Darwin); got: $(uname -s)" >&2
  exit 1
fi

for cmd in limactl python3 node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[wsrepl-qa] missing required command: $cmd" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VM_NAME="${1:-happier-wsrepl-qa}"
SAFE_VM_NAME="${VM_NAME//[^A-Za-z0-9._-]/_}"

timestamp() {
  date +"%Y%m%d-%H%M%S"
}

REPORT_ROOT="${WSREPL_QA_OUTPUT_DIR:-output/wsrepl-lima-matrix/$(timestamp)-${SAFE_VM_NAME}}"
REPORT_ROOT="$(python3 - "$REPORT_ROOT" <<'PY'
import sys
from pathlib import Path
print(str(Path(sys.argv[1]).expanduser().resolve()))
PY
)"

mkdir -p "${REPORT_ROOT}"

echo "[wsrepl-qa] vm: ${VM_NAME}"
echo "[wsrepl-qa] report dir: ${REPORT_ROOT}"

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

FINALIZED=0
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PLAYWRIGHT_OUTDIR="${REPORT_ROOT}/playwright"
FAILURE_STAGE=""
FAILURE_REASON=""
ensure_summary() {
  if [[ "${FINALIZED}" == "1" ]]; then
    return 0
  fi
  FINALIZED=1
  local status="$1"
  local ended_at
  ended_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local steps_json="${HAPPIER_QA_STEPS_JSON:-}"
  local session_path="${HAPPIER_QA_SESSION_PATH:-}"
  local session_id="${HAPPIER_QA_SESSION_ID:-}"
  local source_machine_id="${HAPPIER_QA_SOURCE_MACHINE_ID:-}"
  local host_machine_id="${WSREPL_QA_HOST_MACHINE_ID:-}"
  local vm_machine_id="${WSREPL_QA_VM_MACHINE_ID:-}"

  local payload
  payload="$(python3 - "$VM_NAME" "$REPORT_ROOT" "$PLAYWRIGHT_OUTDIR" "$STARTED_AT" "$ended_at" "$status" "$session_id" "$session_path" "$steps_json" "$source_machine_id" "$host_machine_id" "$vm_machine_id" "$FAILURE_STAGE" "$FAILURE_REASON" <<'PY'
import json
import sys
from pathlib import Path

vm_name, report_root, playwright_outdir, started_at, ended_at, status, session_id, session_path, steps_json, source_machine_id, host_machine_id, vm_machine_id, failure_stage, failure_reason = sys.argv[1:]
status_int = int(status)

target_machine_ids = []
try:
  parsed_steps = json.loads(steps_json) if steps_json else None
  if isinstance(parsed_steps, list):
    for step in parsed_steps:
      if isinstance(step, dict):
        value = step.get("targetMachineId")
        if isinstance(value, str) and value.strip():
          target_machine_ids.append(value.strip())
except Exception:
  pass

fatal_message = None
try:
  fatal_path = Path(playwright_outdir) / "fatal.json"
  if fatal_path.exists():
    fatal_payload = json.loads(fatal_path.read_text(encoding="utf-8"))
    msg = fatal_payload.get("errorMessage") if isinstance(fatal_payload, dict) else None
    if isinstance(msg, str) and msg.strip():
      fatal_message = msg.strip()
except Exception:
  fatal_message = None

resolved_failure_stage = (failure_stage or "").strip() or None
resolved_failure_reason = (failure_reason or "").strip() or None
if status_int == 0:
  resolved_failure_stage = None
  resolved_failure_reason = None
elif resolved_failure_reason is None and fatal_message:
  resolved_failure_reason = fatal_message
  resolved_failure_stage = resolved_failure_stage or "playwright"
payload = {
  "kind": "wsrepl_lima_matrix_wrapper",
  "vmName": vm_name,
  "reportRoot": report_root,
  "playwrightOutDir": playwright_outdir,
  "startedAt": started_at,
  "endedAt": ended_at,
  "status": status_int,
  "sessionId": session_id or None,
  "sessionPath": session_path or None,
  "stepsJson": steps_json or None,
  "parameters": {
    "hostMachineId": (host_machine_id or "").strip() or None,
    "vmMachineId": (vm_machine_id or "").strip() or None,
    "sourceMachineId": (source_machine_id or "").strip() or None,
    "targetMachineIds": target_machine_ids,
  },
  "failureStage": resolved_failure_stage,
  "failureReason": resolved_failure_reason,
  "logs": {
    "ensureVmLog": f"{report_root}/ensure-vm.log",
    "hostDiag": f"{report_root}/host.diag.txt",
    "guestDiag": f"{report_root}/guest.diag.txt",
    "limaList": f"{report_root}/lima.list.txt",
    "limaInfo": f"{report_root}/lima.info.txt",
    "playwrightRunnerLog": f"{playwright_outdir}/runner.log",
    "playwrightMeta": f"{playwright_outdir}/meta.json",
  },
}
print(json.dumps(payload))
PY
)"
  write_json_file "${REPORT_ROOT}/summary.json" "${payload}"
}

trap 'status=$?; ensure_summary "${status}"; exit "${status}"' EXIT

LIMA_HOME_DIR="${LIMA_HOME:-${HOME}/.lima}"
LIMA_DIR="${LIMA_HOME_DIR}/${VM_NAME}"
LIMA_YAML="${LIMA_DIR}/lima.yaml"

wait_for_vm_shell() {
  local tries="${1:-60}"
  local delay_s="${2:-1}"
  local attempt=0
  while [[ "${attempt}" -lt "${tries}" ]]; do
    if limactl shell "${VM_NAME}" -- bash -lc "true" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "${delay_s}"
  done
  return 1
}

ensure_vm_ready() {
  local force_reconfigure="${WSREPL_QA_FORCE_VM_RECONFIGURE:-}"

  # Default to reusing an existing VM (do not stop it) to avoid flake from killing guest daemons mid-matrix.
  # Set WSREPL_QA_FORCE_VM_RECONFIGURE=1 to force the full stop/reconfigure/start path via macos-lima-vm.sh.
  if [[ -n "${force_reconfigure}" && "${force_reconfigure}" != "0" ]]; then
    FAILURE_STAGE="ensure_vm"
    echo "[wsrepl-qa] ensure VM (forced reconfigure via macos-lima-vm.sh)..."
    "${SCRIPT_DIR}/macos-lima-vm.sh" "${VM_NAME}"
    return 0
  fi

  if [[ ! -f "${LIMA_YAML}" ]]; then
    FAILURE_STAGE="ensure_vm"
    echo "[wsrepl-qa] ensure VM (create/configure via macos-lima-vm.sh; no existing lima.yaml)..."
    "${SCRIPT_DIR}/macos-lima-vm.sh" "${VM_NAME}"
    return 0
  fi

  if ! grep -q "# --- happier port forwards (managed) ---" "${LIMA_YAML}" 2>/dev/null; then
    FAILURE_STAGE="ensure_vm"
    echo "[wsrepl-qa] ensure VM (configure port forwarding via macos-lima-vm.sh; missing managed markers)..."
    "${SCRIPT_DIR}/macos-lima-vm.sh" "${VM_NAME}"
    return 0
  fi

  if limactl shell "${VM_NAME}" -- bash -lc "true" >/dev/null 2>&1; then
    echo "[wsrepl-qa] ensure VM: reuse (already running + shell reachable)"
    return 0
  fi

  echo "[wsrepl-qa] ensure VM: starting (shell not reachable yet)..."
  FAILURE_STAGE="ensure_vm"
  limactl start "${VM_NAME}"
  if ! wait_for_vm_shell 90 1; then
    FAILURE_REASON="vm_shell_unreachable"
    echo "[wsrepl-qa] failed to reach VM shell after start: ${VM_NAME}" >&2
    return 1
  fi
  echo "[wsrepl-qa] ensure VM: ready"
}

resolve_expected_worktree_happier_version() {
  # For QA we want a stable, file-backed signal that is not sensitive to transient
  # dist snapshot churn (stack can temporarily rename apps/cli/dist during packaging).
  python3 - "${REPO_DIR}/apps/cli/package.json" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
print(str(payload.get("version") or "").strip())
PY
}

resolve_guest_happier_version() {
  limactl shell "${VM_NAME}" -- bash -lc "command -v happier >/dev/null 2>&1 && happier --version" 2>/dev/null | head -n 1 | tr -d '\r' || true
}

resolve_guest_wsrepl_installed_happier_version() {
  limactl shell "${VM_NAME}" -- bash -lc '[[ -x "$HOME/.happier/bin/happier" ]] && "$HOME/.happier/bin/happier" --version' \
    2>/dev/null | head -n 1 | tr -d '\r' || true
}

resolve_vm_bun_target() {
  local override="${WSREPL_QA_VM_BUN_TARGET:-}"
  if [[ -n "${override}" ]]; then
    echo "${override}"
    return 0
  fi

  local arch
  arch="$(limactl shell "${VM_NAME}" -- bash -lc "uname -m" 2>/dev/null | head -n 1 | tr -d '\r' || true)"
  case "${arch}" in
    aarch64|arm64)
      echo "bun-linux-arm64"
      return 0
      ;;
    x86_64|amd64)
      echo "bun-linux-x64-baseline"
      return 0
      ;;
    *)
      echo ""
      return 1
      ;;
  esac
}

autoupdate_guest_happier_from_worktree() {
  local bun_target
  bun_target="$(resolve_vm_bun_target)"
  if [[ -z "${bun_target}" ]]; then
    echo "[wsrepl-qa] failed to resolve VM bun target (set WSREPL_QA_VM_BUN_TARGET=...)" >&2
    return 2
  fi

  local payload_root="${REPORT_ROOT}/vm-happier"
  local payload_dir="${payload_root}/payload.tmp"
  rm -rf "${payload_root}" 2>/dev/null || true
  mkdir -p "${payload_root}"

  echo "[wsrepl-qa] building VM Happier artifact from worktree (bunTarget=${bun_target})..."
  if ! WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR="${payload_dir}" \
    node - "${REPO_DIR}" "${payload_dir}" "${bun_target}" <<'NODE'
import { buildCliBinaryArtifactPayload, CLI_BINARY_TARGETS } from '@happier-dev/cli-common/componentArtifacts';

const [repoRoot, payloadDir, bunTarget] = process.argv.slice(2);
const target = CLI_BINARY_TARGETS.find((value) => value.bunTarget === bunTarget);
if (!target) {
  throw new Error(`[wsrepl-qa] unsupported bun target: ${bunTarget}`);
}

await buildCliBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target,
});
NODE
  then
    echo "[wsrepl-qa] failed to build VM Happier artifact from worktree" >&2
    return 2
  fi

  echo "[wsrepl-qa] installing VM Happier artifact..."
  local guest_home
  guest_home="$(limactl shell "${VM_NAME}" -- bash -lc 'printf "%s" "$HOME"' 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "${guest_home}" ]]; then
    echo "[wsrepl-qa] failed to resolve guest $HOME for ${VM_NAME}" >&2
    return 2
  fi

  limactl shell "${VM_NAME}" -- bash -lc 'set -euo pipefail; mkdir -p "$HOME/.happier/wsrepl-dev"; rm -rf "$HOME/.happier/wsrepl-dev/payload.tmp"; rm -rf "$HOME/.happier/wsrepl-dev/payload"'
  limactl copy --backend=scp --recursive "${payload_dir}" "${VM_NAME}:${guest_home}/.happier/wsrepl-dev/"

  limactl shell "${VM_NAME}" -- bash -lc 'set -euo pipefail;
    if command -v happier >/dev/null 2>&1; then
      happier daemon stop >/dev/null 2>&1 || true
    fi
    mkdir -p "$HOME/.happier/bin"
    mv "$HOME/.happier/wsrepl-dev/payload.tmp" "$HOME/.happier/wsrepl-dev/payload"
    if [[ -e "$HOME/.happier/bin/happier" && ! -L "$HOME/.happier/bin/happier" ]]; then
      mv "$HOME/.happier/bin/happier" "$HOME/.happier/bin/happier.wsrepl-backup.$(date +%Y%m%d-%H%M%S)" || true
    fi
    ln -sf "$HOME/.happier/wsrepl-dev/payload/happier" "$HOME/.happier/bin/happier"
    "$HOME/.happier/bin/happier" daemon start >/dev/null 2>&1 || true
  '
}

if [[ -z "${HAPPIER_QA_SESSION_PATH:-}" && -n "${WSREPL_QA_LARGE_REPO_PATH:-}" ]]; then
  export HAPPIER_QA_SESSION_PATH="${WSREPL_QA_LARGE_REPO_PATH}"
fi

if [[ -n "${HAPPIER_QA_SESSION_PATH:-}" ]]; then
  if [[ ! -d "${HAPPIER_QA_SESSION_PATH}" ]]; then
    echo "[wsrepl-qa] HAPPIER_QA_SESSION_PATH does not exist or is not a directory: ${HAPPIER_QA_SESSION_PATH}" >&2
    exit 2
  fi
fi

if [[ -z "${HAPPIER_QA_TIMEOUT_MS:-}" ]]; then
  export HAPPIER_QA_TIMEOUT_MS="${WSREPL_QA_TIMEOUT_MS:-1800000}"
fi

# If the wrapper knows the host machine id, default the source machine id to it unless explicitly set.
if [[ -z "${HAPPIER_QA_SOURCE_MACHINE_ID:-}" && -n "${WSREPL_QA_HOST_MACHINE_ID:-}" ]]; then
  export HAPPIER_QA_SOURCE_MACHINE_ID="${WSREPL_QA_HOST_MACHINE_ID}"
fi

if [[ -z "${HAPPIER_QA_STEPS_JSON:-}" ]]; then
  host_machine_id="${WSREPL_QA_HOST_MACHINE_ID:-}"
  vm_machine_id="${WSREPL_QA_VM_MACHINE_ID:-}"
  if [[ -z "${host_machine_id}" || -z "${vm_machine_id}" ]]; then
    FAILURE_STAGE="preflight"
    FAILURE_REASON="missing_steps_json"
    echo "[wsrepl-qa] missing required env: HAPPIER_QA_STEPS_JSON" >&2
    echo "[wsrepl-qa] Or set WSREPL_QA_HOST_MACHINE_ID + WSREPL_QA_VM_MACHINE_ID to derive the default host↔VM 2-step matrix." >&2
    exit 2
  fi
  step_out_strategy="${WSREPL_QA_STEP_OUT_STRATEGY:-transfer_snapshot}"
  step_back_strategy="${WSREPL_QA_STEP_BACK_STRATEGY:-sync_changes}"
  if [[ "${step_out_strategy}" != "transfer_snapshot" && "${step_out_strategy}" != "sync_changes" ]]; then
    FAILURE_STAGE="preflight"
    FAILURE_REASON="invalid_step_out_strategy"
    echo "[wsrepl-qa] invalid WSREPL_QA_STEP_OUT_STRATEGY: ${step_out_strategy} (expected transfer_snapshot|sync_changes)" >&2
    exit 2
  fi
  if [[ "${step_back_strategy}" != "transfer_snapshot" && "${step_back_strategy}" != "sync_changes" ]]; then
    FAILURE_STAGE="preflight"
    FAILURE_REASON="invalid_step_back_strategy"
    echo "[wsrepl-qa] invalid WSREPL_QA_STEP_BACK_STRATEGY: ${step_back_strategy} (expected transfer_snapshot|sync_changes)" >&2
    exit 2
  fi
  # Default session creation should happen on the host machine so the initial
  # handoff step (host -> VM) can start from a real host filesystem path.
  if [[ -z "${HAPPIER_QA_SOURCE_MACHINE_ID:-}" ]]; then
    export HAPPIER_QA_SOURCE_MACHINE_ID="${host_machine_id}"
  fi
  export HAPPIER_QA_STEPS_JSON
  HAPPIER_QA_STEPS_JSON="$(python3 - "$vm_machine_id" "$host_machine_id" "$step_out_strategy" "$step_back_strategy" <<'PY'
import json
import sys

vm_machine_id, host_machine_id, out_strategy, back_strategy = sys.argv[1:]
steps = [
  {"targetMachineId": vm_machine_id, "strategy": out_strategy},
  {"targetMachineId": host_machine_id, "strategy": back_strategy},
]
print(json.dumps(steps))
PY
)"
fi

echo "[wsrepl-qa] ensure VM exists + port forwarding (reuse-first)..."
{
  echo "date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "vm: ${VM_NAME}"
  echo "lima_home: ${LIMA_HOME_DIR}"
  echo "lima_yaml: ${LIMA_YAML}"
  ensure_vm_ready
} 2>&1 | tee "${REPORT_ROOT}/ensure-vm.log"

WSREPL_QA_VM_HAPPIER_MODE="${WSREPL_QA_VM_HAPPIER_MODE:-require}"
case "${WSREPL_QA_VM_HAPPIER_MODE}" in
  skip|require|autoupdate)
    ;;
  *)
    echo "[wsrepl-qa] invalid WSREPL_QA_VM_HAPPIER_MODE: ${WSREPL_QA_VM_HAPPIER_MODE} (expected skip|require|autoupdate)" >&2
    exit 2
    ;;
esac

if [[ "${WSREPL_QA_VM_HAPPIER_MODE}" != "skip" ]]; then
  FAILURE_STAGE="guest_version_check"
  expected_version="$(resolve_expected_worktree_happier_version)"
  if [[ -z "${expected_version}" ]]; then
    FAILURE_REASON="missing_worktree_version"
    echo "[wsrepl-qa] failed to resolve expected Happier version from worktree; expected ${REPO_DIR}/apps/cli/package.json to contain a version string" >&2
    exit 2
  fi

  if [[ "${WSREPL_QA_VM_HAPPIER_MODE}" == "autoupdate" ]]; then
    autoupdate_guest_happier_from_worktree || exit $?
    guest_version="$(resolve_guest_wsrepl_installed_happier_version)"
    if [[ -z "${guest_version}" ]]; then
      echo "[wsrepl-qa] failed to resolve guest Happier version after autoupdate; expected $HOME/.happier/bin/happier --version to succeed" >&2
      exit 2
    fi
  else
    guest_version="$(resolve_guest_happier_version)"
    if [[ -z "${guest_version}" ]]; then
      echo "[wsrepl-qa] failed to resolve guest Happier version; ensure happier is installed in the VM and reachable from PATH" >&2
      exit 2
    fi
  fi

  if [[ "${guest_version}" != "${expected_version}" ]]; then
    FAILURE_REASON="guest_version_mismatch"
    echo "[wsrepl-qa] guest Happier CLI version does not match the current worktree (mode=${WSREPL_QA_VM_HAPPIER_MODE})." >&2
    echo "[wsrepl-qa] expected: ${expected_version}" >&2
    echo "[wsrepl-qa] guest:    ${guest_version}" >&2
    echo "[wsrepl-qa] Fix: update the VM's Happier install to the same commit/build, rerun with WSREPL_QA_VM_HAPPIER_MODE=autoupdate, or set WSREPL_QA_VM_HAPPIER_MODE=skip to bypass this guard." >&2
    exit 2
  fi
fi

echo "[wsrepl-qa] capture host diagnostics..."
{
  echo "date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "uname: $(uname -a)"
  echo "repo_dir: ${REPO_DIR}"
  echo "stack_dir: ${STACK_DIR}"
  echo "git_rev: $(cd "${REPO_DIR}" && git rev-parse HEAD 2>/dev/null || true)"
  echo "git_status:"
  (cd "${REPO_DIR}" && git status --porcelain=v1 2>/dev/null || true)
} > "${REPORT_ROOT}/host.diag.txt"

echo "[wsrepl-qa] capture guest diagnostics..."
set +e
limactl list 2>&1 | tee "${REPORT_ROOT}/lima.list.txt" >/dev/null
limactl info "${VM_NAME}" 2>&1 | tee "${REPORT_ROOT}/lima.info.txt" >/dev/null
limactl shell "${VM_NAME}" -- bash -lc "set -euo pipefail; uname -a; id; df -h; command -v node >/dev/null 2>&1 && node --version || true; command -v free >/dev/null 2>&1 && free -m || true" \
  2>&1 | tee "${REPORT_ROOT}/guest.diag.txt" >/dev/null
set -e

echo "[wsrepl-qa] run Playwright matrix (artifacts under report dir)..."
mkdir -p "${PLAYWRIGHT_OUTDIR}"

FAILURE_STAGE="playwright"
HAPPIER_QA_OUTDIR="${PLAYWRIGHT_OUTDIR}" \
node "${REPO_DIR}/.project/scripts/qa/playwright-session-handoff-wsrepl-matrix.mjs" \
  2>&1 | tee "${PLAYWRIGHT_OUTDIR}/runner.log"

echo ""
echo "[wsrepl-qa] done"
echo "[wsrepl-qa] report dir: ${REPORT_ROOT}"
