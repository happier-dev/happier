#!/usr/bin/env bash
set -euo pipefail

# Install ultra-early traps so that a SIGTERM during script parsing still yields a summary.json.
# This must not depend on functions defined later in the file (large heredocs can delay parsing).
#
# Note: we optimistically seed VM_NAME from the first positional arg (skipping known flags)
# so the early summary has a stable vmName/reportRoot. Later argument parsing will override
# VM_NAME/SAFE_VM_NAME as needed.
VM_NAME="happier-wsrepl-qa"
for arg in "$@"; do
  case "${arg}" in
    --headed|--headless) ;;
    -h|--help) ;;
    *)
      VM_NAME="${arg}"
      break
      ;;
  esac
done
SAFE_VM_NAME="${VM_NAME//[^A-Za-z0-9._-]/_}"
FINALIZED=0
FAILURE_STAGE=""
FAILURE_REASON=""
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
REPORT_ROOT="${WSREPL_QA_OUTPUT_DIR:-output/wsrepl-lima-matrix/$(date +"%Y%m%d-%H%M%S")-${SAFE_VM_NAME}}"
PLAYWRIGHT_OUTDIR="${REPORT_ROOT}/playwright/attempt-01"
mkdir -p "${REPORT_ROOT}" >/dev/null 2>&1 || true
mkdir -p "${REPORT_ROOT}/daemon" >/dev/null 2>&1 || true
for name in \
  host.diag.txt \
  guest.diag.txt \
  lima.list.txt \
  lima.info.txt \
  vm.host-direct-peer.tcp.txt \
  daemon/host.daemon.start.txt \
  daemon/host.daemon.status.txt \
  daemon/host.daemon.log.path.txt \
  daemon/host.daemon.log.tail.txt \
  daemon/guest.daemon.start.txt \
  daemon/guest.daemon.status.txt \
  daemon/guest.daemon.log.path.txt \
  daemon/guest.daemon.log.tail.txt \
; do
  if [[ ! -f "${REPORT_ROOT}/${name}" ]]; then
    printf "%s\n" "(not collected)" > "${REPORT_ROOT}/${name}"
  fi
done

wsrepl_early_seed_summary_json_best_effort() {
  # If the wrapper is killed with an untrappable signal (SIGKILL), EXIT/TERM/INT traps will not
  # run. Seed a minimal summary.json up front so the report directory is still diagnosable.
  if [[ -f "${REPORT_ROOT}/summary.json" ]]; then
    return 0
  fi
  cat > "${REPORT_ROOT}/summary.json" <<EOF
{
  "kind": "wsrepl_lima_matrix_wrapper",
  "vmName": "${VM_NAME}",
  "reportRoot": "${REPORT_ROOT}",
  "playwrightOutDir": "${PLAYWRIGHT_OUTDIR}",
  "startedAt": "${STARTED_AT}",
  "endedAt": "${STARTED_AT}",
  "status": 1,
  "failureStage": "in_progress",
  "failureReason": "not_finalized"
}
EOF
}

wsrepl_early_seed_summary_json_best_effort >/dev/null 2>&1 || true

wsrepl_early_write_summary() {
  if [[ "${FINALIZED}" == "1" ]]; then
    return 0
  fi
  FINALIZED=1
  local status="${1:-1}"
  local ended_at
  ended_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [[ ( "${status}" == "126" || "${status}" == "127" ) && -z "${FAILURE_STAGE}" ]]; then
    FAILURE_STAGE="early_abort"
  fi
  if [[ ( "${status}" == "126" || "${status}" == "127" ) && -z "${FAILURE_REASON}" ]]; then
    if [[ "${status}" == "127" ]]; then
      FAILURE_REASON="command_not_found"
    else
      FAILURE_REASON="command_invocation_failed"
    fi
  fi
  local failure_stage_json="null"
  local failure_reason_json="null"
  if [[ -n "${FAILURE_STAGE}" ]]; then
    failure_stage_json="\"${FAILURE_STAGE}\""
  fi
  if [[ -n "${FAILURE_REASON}" ]]; then
    failure_reason_json="\"${FAILURE_REASON}\""
  fi
  cat > "${REPORT_ROOT}/summary.json" <<EOF
{
  "kind": "wsrepl_lima_matrix_wrapper",
  "vmName": "${VM_NAME}",
  "reportRoot": "${REPORT_ROOT}",
  "playwrightOutDir": "${PLAYWRIGHT_OUTDIR}",
  "startedAt": "${STARTED_AT}",
  "endedAt": "${ended_at}",
  "status": ${status},
  "failureStage": ${failure_stage_json},
  "failureReason": ${failure_reason_json}
}
EOF
}

wsrepl_early_terminate_due_to_signal() {
  local exit_code="${1:-143}"
  local signal_name="${2:-term}"
  FAILURE_STAGE="terminated"
  FAILURE_REASON="signal_${signal_name}"
  exit "${exit_code}"
}

trap 'status=$?; wsrepl_early_write_summary "${status}"; exit "${status}"' EXIT
trap 'wsrepl_early_terminate_due_to_signal 143 term' TERM
trap 'wsrepl_early_terminate_due_to_signal 130 int' INT

# Host↔Lima workspace replication/handoff QA harness (non-destructive).
#
# This runner:
# - ensures a Lima VM exists + has localhost port forwarding (via lima-vm.sh)
# - captures host + guest diagnostics into a timestamped report directory
# - runs a Playwright-driven session-handoff workspace-transfer matrix against a real stack UI
#
# Usage (macOS/Linux host, from the repo root or `packages/tests/`):
#   ./packages/tests/scripts/wsrepl-lima-matrix.sh [--headed|--headless] [vm-name] [vm-name-2 ...]
#
# Required env for the Playwright matrix:
#   HAPPIER_QA_SESSION_ID=...
#   HAPPIER_QA_STEPS_JSON='[{"targetMachineId":"...","strategy":"transfer_snapshot"},{"targetMachineId":"...","strategy":"sync_changes"}]'
#   (name-based selection is supported as a fallback, but ids are preferred for determinism)
#   HAPPIER_QA_STEPS_JSON='[{"targetMachineNamePattern":"lima-*","strategy":"transfer_snapshot"},{"targetMachineNamePattern":"my-host","strategy":"sync_changes"}]'
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
#   WSREPL_QA_DAEMON_START_RETRIES=...  # default: 1 (retry wrapper-managed host daemon restarts on transient failures)
#   WSREPL_QA_DAEMON_START_RETRY_DELAY_MS=...  # default: 250 (delay between host daemon start retries)
#   WSREPL_QA_HOST_DAEMON_START_POLL_RETRIES=...  # default: 30 (post-start health poll retries)
#   WSREPL_QA_HOST_DAEMON_START_POLL_DELAY_MS=...  # default: 500 (post-start health poll delay)
#   WSREPL_QA_HOST_DAEMON_STOP_POLL_RETRIES=...  # default: 40 (after `daemon stop`, poll until status is not running)
#   WSREPL_QA_HOST_DAEMON_STOP_POLL_DELAY_MS=...  # default: 250 (delay between stop polls)
#   WSREPL_QA_HOST_DAEMON_WATCHDOG=1  # enable a best-effort watchdog that restarts the host daemon while Playwright runs
#   WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS=...  # default: 1000 (how often the watchdog probes)
#   WSREPL_QA_MACHINE_ID_POLL_RETRIES=...  # default: 40 (poll daemon status until machineId is persisted)
#   WSREPL_QA_MACHINE_ID_POLL_DELAY_MS=...  # default: 250 (delay between machineId polls)
#   WSREPL_QA_HOST_HOME_REL=...  # if set, run the host daemon under $HOME/<rel> (isolated from stack-managed CLI home)
#   WSREPL_QA_HOST_DIRECT_PEER_ADVERTISED_HOSTS=...  # default: host.lima.internal (published by the host daemon for Lima guests)
#   WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT=...  # stable host direct-peer bind port; defaults to WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT_DEFAULT (13378)
#   WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT_DEFAULT=...  # default: 13378
#   WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK=0|1  # default: 1 (probe host.lima.internal:<hostBindPort> from inside the VM; diagnostic only)
#   WSREPL_QA_VM_DIRECT_PEER_BIND_PORT=...  # stable guest direct-peer bind port; when set, the wrapper forwards the same port through Lima
#   WSREPL_QA_VM_DIRECT_PEER_BIND_PORT_DEFAULT=...  # stable guest direct-peer bind port default for WSREPL runs; default: 13377
#   WSREPL_QA_VM_DIRECT_PEER_ADVERTISED_HOSTS=...  # guest direct-peer advertised hosts; defaults to 127.0.0.1 (or 127.0.0.1,host.lima.internal for multi-VM runs)
#   WSREPL_QA_HOST_HAPPIER_SOURCE=auto|stack_runtime|worktree_node|explicit:/abs/path  # default: auto
#   WSREPL_QA_FORCE_VM_RECONFIGURE=1  # force stop/reconfigure/start via lima-vm.sh (default is reuse-first)
#   WSREPL_QA_VM_HAPPIER_MODE=skip|require|autoupdate  # default: require (fail closed if the guest is running an unexpected Happier build)
#     - autoupdate builds a Linux CLI artifact from this repo and installs it into the VM
#   WSREPL_QA_VM_BUN_TARGET=bun-linux-arm64|bun-linux-x64-baseline  # override bun target for autoupdate
#
# Notes on guest version checks:
# - `require` mode is intended for dev QA and uses a build marker (git rev) when available.
# - If the worktree git rev is available but the guest does not have a wsrepl build marker installed,
#   `require` fails closed and instructs you to rerun with `WSREPL_QA_VM_HAPPIER_MODE=autoupdate`.

usage() {
  cat <<'EOF'
Usage:
  ./packages/tests/scripts/wsrepl-lima-matrix.sh [--headed|--headless] [vm-name] [vm-name-2 ...]

Examples:
  WSREPL_QA_OUTPUT_DIR=output/wsrepl-lima-matrix-local \
  HAPPIER_UI_URL="http://localhost:19364/?server=http%3A%2F%2Flocalhost%3A53288&happier_hmr=0" \
  HAPPIER_QA_SESSION_ID="..." \
  HAPPIER_QA_STEPS_JSON='[{"targetMachineId":"<vmMachineId>","strategy":"transfer_snapshot"},{"targetMachineId":"<hostMachineId>","strategy":"sync_changes"}]' \
  ./packages/tests/scripts/wsrepl-lima-matrix.sh happier-wsrepl-qa-0323

  # Or: let the wrapper derive the default 2-step host↔VM matrix.
  WSREPL_QA_HOST_MACHINE_ID="<hostMachineId>" \
  WSREPL_QA_VM_MACHINE_ID="<vmMachineId>" \
  HAPPIER_QA_SESSION_ID="..." \
  ./packages/tests/scripts/wsrepl-lima-matrix.sh happier-wsrepl-qa-0323
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

HOST_OS="$(uname -s)"
if [[ "${HOST_OS}" != "Darwin" && "${HOST_OS}" != "Linux" ]]; then
  echo "[wsrepl-qa] expected macOS (Darwin) or Linux host; got: ${HOST_OS}" >&2
  exit 1
fi

prepend_wsrepl_system_path_entry() {
  local entry="${1:-}"
  if [[ -z "${entry}" ]]; then
    return 0
  fi
  case "${PATH:-}" in
    "${entry}:"*|"${entry}") return 0 ;;
  esac
  PATH="${entry}${PATH:+:${PATH}}"
  export PATH
}

prepend_wsrepl_system_path_entry /sbin
prepend_wsrepl_system_path_entry /usr/sbin

for cmd in limactl python3 node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[wsrepl-qa] missing required command: $cmd" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
STACK_DIR="$(cd "${REPO_DIR}/apps/stack" && pwd)"
LIMA_VM_SCRIPT="${SCRIPT_DIR}/lima-vm.sh"
PAYLOAD_TAR_HELPER="${SCRIPT_DIR}/create-wsrepl-payload-tar.py"

if [[ ! -f "${LIMA_VM_SCRIPT}" ]]; then
  echo "[wsrepl-qa] missing tests-owned Lima helper: ${LIMA_VM_SCRIPT}" >&2
  exit 1
fi

if [[ ! -f "${PAYLOAD_TAR_HELPER}" ]]; then
  echo "[wsrepl-qa] missing WSREPL payload tar helper: ${PAYLOAD_TAR_HELPER}" >&2
  exit 1
fi

WSREPL_QA_PLAYWRIGHT_HEADLESS_MODE=""
WSREPL_QA_POSITIONAL_ARGS=()
for arg in "$@"; do
  case "${arg}" in
    --headed)
      WSREPL_QA_PLAYWRIGHT_HEADLESS_MODE="headed"
      ;;
    --headless)
      WSREPL_QA_PLAYWRIGHT_HEADLESS_MODE="headless"
      ;;
    *)
      WSREPL_QA_POSITIONAL_ARGS+=("${arg}")
      ;;
  esac
done

VM_NAMES=()
if [[ "${#WSREPL_QA_POSITIONAL_ARGS[@]}" -gt 0 ]]; then
  VM_NAMES=("${WSREPL_QA_POSITIONAL_ARGS[@]}")
else
  VM_NAMES=("happier-wsrepl-qa")
fi

VM_NAME="${VM_NAMES[0]}"
SAFE_VM_NAME="${VM_NAME//[^A-Za-z0-9._-]/_}"
EXTRA_VM_NAMES=("${VM_NAMES[@]:1}")

# Default Playwright to headless for CI/automation ergonomics; allow `--headed` for manual debugging.
#
# IMPORTANT: force the default regardless of the caller's ambient shell env. If a developer wants
# headed mode they should pass `--headed` explicitly so that accidental `HAPPIER_QA_HEADLESS=0`
# doesn't cause the runner to pop UI windows.
if [[ "${WSREPL_QA_PLAYWRIGHT_HEADLESS_MODE}" == "headed" ]]; then
  export HAPPIER_QA_HEADLESS="0"
else
  export HAPPIER_QA_HEADLESS="1"
fi

timestamp() {
  date +"%Y%m%d-%H%M%S"
}

resolve_host_machine_name_pattern_for_ui() {
  local explicit="${WSREPL_QA_HOST_MACHINE_NAME_PATTERN:-}"
  if [[ -n "${explicit}" ]]; then
    echo "${explicit}"
    return 0
  fi

  local name=""
  name="$(scutil --get LocalHostName 2>/dev/null || true)"
  if [[ -z "${name}" ]]; then
    name="$(hostname -s 2>/dev/null || true)"
  fi
  if [[ -z "${name}" ]]; then
    name="$(hostname 2>/dev/null || true)"
  fi
  echo "${name}"
  return 0
}

resolve_vm_machine_name_pattern_for_ui() {
  local explicit="${WSREPL_QA_VM_MACHINE_NAME_PATTERN:-}"
  if [[ -n "${explicit}" ]]; then
    echo "${explicit}"
    return 0
  fi
  # UI machine rows for Lima guests are typically prefixed (e.g. `lima-<vm-name>`). Prefer a
  # suffix glob so we match both prefixed and unprefixed variants if the UI naming changes.
  echo "*${VM_NAME}*"
  return 0
}

wsrepl_matrix_csv_has_value() {
  local csv="${1:-}"
  local token="${2:-}"
  if [[ -z "${csv}" || -z "${token}" ]]; then
    return 1
  fi
  case ",${csv}," in
    *",${token},"*) return 0 ;;
    *) return 1 ;;
  esac
}

seed_guest_fake_claude_cli_if_needed() {
  if ! wsrepl_matrix_csv_has_value "${HAPPIER_QA_PREFERRED_AGENT_ENGINES:-}" "claude"; then
    return 0
  fi

  # Prefer the `.js` wrapper: the Claude Agent SDK treats `.js` as a script entrypoint and will
  # spawn it via Node (whereas `.cjs` may be treated as an executable).
  local src="${REPO_DIR}/packages/tests/src/fixtures/fake-claude-code-cli.js"
  if [[ ! -f "${src}" ]]; then
    echo "[wsrepl-qa] missing expected fake Claude fixture: ${src}" >&2
    return 1
  fi

  local encoded
  encoded="$(python3 - <<'PY' "${src}"
import base64
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = path.read_bytes()
print(base64.b64encode(payload).decode("ascii"))
PY
)"

  # Best-effort. If this fails, the matrix will still surface the provider CLI error downstream.
  limactl shell "${VM_NAME}" -- bash -lc "set -euo pipefail;
    decode_base64() {
      if printf 'Zg==' | base64 -d >/dev/null 2>&1; then
        base64 -d
        return
      fi
      if printf 'Zg==' | base64 -D >/dev/null 2>&1; then
        base64 -D
        return
      fi
      base64 --decode
    }
    dst=\"\$HOME/.happier/wsrepl-qa/fixtures/fake-claude-code-cli.js\"
    mkdir -p \"\$(dirname \"\$dst\")\"
    printf '%s' '${encoded}' | decode_base64 > \"\$dst\"
    chmod 700 \"\$dst\" 2>/dev/null || true
  " >/dev/null 2>&1 || true

  return 0
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

FINALIZED=0
FAILURE_STAGE=""
FAILURE_REASON=""
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PLAYWRIGHT_OUTDIR="${REPORT_ROOT}/playwright"
DAEMON_DIAG_DIR="${REPORT_ROOT}/daemon"
PLAYWRIGHT_ATTEMPT=1
PLAYWRIGHT_ROOTDIR=""

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

ensure_summary() {
  if [[ "${FINALIZED}" == "1" ]]; then
    return 0
  fi
  FINALIZED=1
  local status="$1"
  local ended_at
  ended_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  # Early summary: keep it minimal, but always write a usable wrapper artifact even if we were
  # interrupted before later helper functions were defined.
  local payload
  payload="$(python3 - "$VM_NAME" "$REPORT_ROOT" "$PLAYWRIGHT_OUTDIR" "$STARTED_AT" "$ended_at" "$status" "$FAILURE_STAGE" "$FAILURE_REASON" <<'PY'
import json
import sys

vm_name, report_root, playwright_outdir, started_at, ended_at, status, failure_stage, failure_reason = sys.argv[1:]
payload = {
  "kind": "wsrepl_lima_matrix_wrapper",
  "vmName": vm_name,
  "reportRoot": report_root,
  "playwrightOutDir": playwright_outdir,
  "startedAt": started_at,
  "endedAt": ended_at,
  "status": int(status),
  "failureStage": (failure_stage or "").strip() or None,
  "failureReason": (failure_reason or "").strip() or None,
}
print(json.dumps(payload))
PY
)"

  write_json_file "${REPORT_ROOT}/summary.json" "${payload}"
}

terminate_due_to_signal() {
  local exit_code="${1:-143}"
  local signal_name="${2:-term}"
  FAILURE_STAGE="terminated"
  FAILURE_REASON="signal_${signal_name}"
  exit "${exit_code}"
}

# Install early traps so that a mid-run kill always yields a summary.json, even if the wrapper
# is terminated before it reaches the later trap installation.
trap 'status=$?; ensure_summary "${status}"; exit "${status}"' EXIT
trap 'terminate_due_to_signal 143 term' TERM
trap 'terminate_due_to_signal 130 int' INT

write_wsrepl_build_marker() {
  local file_path="$1"
  local repo_dir="$2"
  python3 - "$file_path" "$repo_dir" <<'PY'
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

file_path = Path(sys.argv[1])
repo_dir = Path(sys.argv[2])

def run(cmd: list[str]) -> str:
  try:
    out = subprocess.check_output(cmd, cwd=str(repo_dir), stderr=subprocess.DEVNULL)
    return out.decode("utf-8", errors="replace").strip()
  except Exception:
    return ""

git_rev = run(["git", "rev-parse", "HEAD"])
version = ""
try:
  pkg = json.loads((repo_dir / "apps" / "cli" / "package.json").read_text(encoding="utf-8"))
  version = str(pkg.get("version") or "").strip()
except Exception:
  version = ""

payload = {
  "t": "happier_wsrepl_build_v1",
  "gitRev": git_rev,
  "cliVersion": version,
  "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}

file_path.parent.mkdir(parents=True, exist_ok=True)
file_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
}

run_with_timeout_ms() {
  local timeout_ms="$1"
  shift
  python3 - "$timeout_ms" "$@" <<'PY'
import os
import select
import signal
import subprocess
import sys
import time

timeout_ms = int(sys.argv[1])
cmd = sys.argv[2:]
if not cmd:
  raise SystemExit("missing command")

deadline = time.monotonic() + (timeout_ms / 1000.0 if timeout_ms > 0 else 365 * 24 * 3600)

proc = subprocess.Popen(
  cmd,
  stdout=subprocess.PIPE,
  stderr=subprocess.STDOUT,
  start_new_session=True,
)
assert proc.stdout is not None

def forward_available_output() -> None:
  while True:
    r, _, _ = select.select([proc.stdout], [], [], 0)
    if not r:
      return
    chunk = os.read(proc.stdout.fileno(), 8192)
    if not chunk:
      return
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()

try:
  while True:
    forward_available_output()
    status = proc.poll()
    if status is not None:
      forward_available_output()
      raise SystemExit(status)
    if time.monotonic() >= deadline:
      try:
        os.killpg(proc.pid, signal.SIGTERM)
      except Exception:
        pass
      try:
        proc.wait(timeout=2.0)
      except Exception:
        try:
          os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
          pass
        try:
          proc.wait(timeout=2.0)
        except Exception:
          pass
      sys.stderr.write(f"[wsrepl-qa] timed out after {timeout_ms}ms: {' '.join(cmd)}\n")
      sys.stderr.flush()
      raise SystemExit(124)
    time.sleep(0.05)
finally:
  try:
    forward_available_output()
  except Exception:
    pass
PY
}
init_daemon_diagnostic_placeholders() {
  mkdir -p "${DAEMON_DIAG_DIR}"
  for name in \
    host.daemon.start.txt \
    host.daemon.status.txt \
    host.daemon.log.path.txt \
    host.daemon.log.tail.txt \
    host.daemon.scope.json \
    guest.daemon.start.txt \
    guest.daemon.status.txt \
    guest.daemon.log.path.txt \
    guest.daemon.log.tail.txt \
  ; do
    if [[ ! -f "${DAEMON_DIAG_DIR}/${name}" ]]; then
      printf "%s\n" "(not collected)" > "${DAEMON_DIAG_DIR}/${name}"
    fi
  done
}

write_host_daemon_scope_diagnostics() {
  local canonical_stack_cli_root="${1:-}"
  local canonical_stack_active_server_id="${2:-}"
  local host_home_rel="${3:-}"
  local stack_access_key_src="${4:-}"
  local effective_host_daemon_home="${5:-}"
  local used_isolated_host_home="${6:-0}"
  local requested_host_home_dir=""
  local host_access_key_dst=""

  if [[ -n "${host_home_rel}" ]]; then
    requested_host_home_dir="$HOME/${host_home_rel}"
    if [[ -n "${canonical_stack_active_server_id}" ]]; then
      host_access_key_dst="${requested_host_home_dir}/servers/${canonical_stack_active_server_id}/access.key"
    fi
  fi

  python3 - "${DAEMON_DIAG_DIR}/host.daemon.scope.json" \
    "${canonical_stack_cli_root}" \
    "${canonical_stack_active_server_id}" \
    "${host_home_rel}" \
    "${stack_access_key_src}" \
    "${requested_host_home_dir}" \
    "${host_access_key_dst}" \
    "${effective_host_daemon_home}" \
    "${used_isolated_host_home}" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
canonical_stack_cli_root = (sys.argv[2] or "").strip() or None
canonical_stack_active_server_id = (sys.argv[3] or "").strip() or None
host_home_rel = (sys.argv[4] or "").strip() or None
stack_access_key_source = (sys.argv[5] or "").strip() or None
requested_host_home_dir = (sys.argv[6] or "").strip() or None
host_access_key_destination = (sys.argv[7] or "").strip() or None
effective_host_daemon_home = (sys.argv[8] or "").strip() or None
used_isolated_host_home = (sys.argv[9] or "").strip() == "1"

path.write_text(
    json.dumps(
        {
            "kind": "wsrepl_host_daemon_scope",
            "canonicalStackCliRoot": canonical_stack_cli_root,
            "canonicalStackActiveServerId": canonical_stack_active_server_id,
            "hostHomeRel": host_home_rel,
            "requestedHostHomeDir": requested_host_home_dir,
            "stackAccessKeySource": stack_access_key_source,
            "hostAccessKeyDestination": host_access_key_destination,
            "effectiveHostDaemonHome": effective_host_daemon_home,
            "usedIsolatedHostHome": used_isolated_host_home,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
}

read_wsrepl_daemon_log_tail_lines() {
  local raw="${WSREPL_QA_DAEMON_LOG_TAIL_LINES:-}"
  if [[ -z "${raw}" ]]; then
    echo "4000"
    return 0
  fi
  if [[ "${raw}" -lt 1 ]]; then
    echo "4000"
    return 0
  fi
  echo "${raw}"
  return 0
}

capture_vm_connectivity_to_host_direct_peer_port_best_effort() {
  local out_file="${REPORT_ROOT}/vm.host-direct-peer.tcp.txt"
  local enabled="${WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK:-1}"
  local host_port="${1:-}"
  if [[ -z "${host_port}" && "${enabled}" == "0" ]]; then
    printf "%s\n" "(skipped: WSREPL_QA_HOST_DIRECT_PEER_VM_CONNECTIVITY_CHECK=0)" > "${out_file}"
    return 0
  fi

  if [[ -z "${host_port}" ]]; then
    host_port="$(resolve_wsrepl_host_direct_peer_bind_port)"
  fi

  # Best-effort: do not fail the wrapper if the connectivity probe fails. The matrix itself
  # should fail closed if direct-peer is not viable.
  set +e
  limactl shell "${VM_NAME}" -- bash -lc "
    set -euo pipefail
    host='host.lima.internal'
    port='${host_port}'
    echo \"host=\${host}\"
    echo \"port=\${port}\"
    if command -v nc >/dev/null 2>&1; then
      if nc -z -w 2 \"\${host}\" \"\${port}\"; then
        echo \"result=ok\"
        exit 0
      fi
      rc=\$?
      echo \"result=failed rc=\${rc}\"
      exit \${rc}
    fi
    if command -v timeout >/dev/null 2>&1; then
      if timeout 2 bash -lc \"echo > /dev/tcp/\${host}/\${port}\" >/dev/null 2>&1; then
        echo \"result=ok\"
        exit 0
      fi
      rc=\$?
      echo \"result=failed rc=\${rc}\"
      exit \${rc}
    fi
    echo \"result=skipped missing_nc_or_timeout\"
    exit 0
  " > "${out_file}" 2>&1
  set -e

  return 0
}

read_wsrepl_host_daemon_start_poll_retries() {
  local raw="${WSREPL_QA_HOST_DAEMON_START_POLL_RETRIES:-}"
  if [[ -z "${raw}" ]]; then
    echo "30"
    return 0
  fi
  if [[ "${raw}" -lt 0 ]]; then
    echo "0"
    return 0
  fi
  echo "${raw}"
  return 0
}

read_wsrepl_host_daemon_start_poll_delay_s() {
  local raw="${WSREPL_QA_HOST_DAEMON_START_POLL_DELAY_MS:-}"
  if [[ -z "${raw}" ]]; then
    raw="500"
  fi
  python3 - <<'PY' "${raw}" 2>/dev/null || true
import sys
try:
  ms = int(sys.argv[1])
except Exception:
  ms = 500
if ms < 0:
  ms = 0
print(f"{ms/1000.0:.3f}")
PY
}

read_wsrepl_machine_id_poll_retries() {
  local raw="${WSREPL_QA_MACHINE_ID_POLL_RETRIES:-}"
  if [[ -z "${raw}" ]]; then
    echo "40"
    return 0
  fi
  if [[ "${raw}" -lt 0 ]]; then
    echo "0"
    return 0
  fi
  echo "${raw}"
  return 0
}

read_wsrepl_machine_id_poll_delay_s() {
  local raw="${WSREPL_QA_MACHINE_ID_POLL_DELAY_MS:-}"
  if [[ -z "${raw}" ]]; then
    raw="250"
  fi
  python3 - <<'PY' "${raw}" 2>/dev/null || true
import sys
try:
  ms = int(sys.argv[1])
except Exception:
  ms = 250
if ms < 0:
  ms = 0
print(f"{ms/1000.0:.3f}")
PY
}

read_wsrepl_host_daemon_watchdog_interval_s() {
  local raw="${WSREPL_QA_HOST_DAEMON_WATCHDOG_INTERVAL_MS:-}"
  if [[ -z "${raw}" ]]; then
    raw="1000"
  fi
  python3 - <<'PY' "${raw}" 2>/dev/null || true
import sys
try:
  ms = int(sys.argv[1])
except Exception:
  ms = 1000
if ms < 0:
  ms = 0
print(f"{ms/1000.0:.3f}")
PY
}

HOST_DAEMON_WATCHDOG_PID=""

extract_pid_from_daemon_status_output() {
  local status_out="${1:-}"
  if [[ -z "${status_out}" ]]; then
    echo ""
    return 0
  fi

  printf "%s\n" "${status_out}" | sed -nE 's/^[[:space:]]*PID:[[:space:]]*([0-9]+).*/\1/p' | head -n 1
}

host_daemon_pid_is_alive() {
  local pid="${1:-}"
  if [[ -z "${pid}" || ! "${pid}" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  kill -0 "${pid}" >/dev/null 2>&1
}

start_host_daemon_watchdog_background() {
  local outdir="${1:-}"
  local host_server_url="${2:-}"
  if [[ "${WSREPL_QA_HOST_DAEMON_WATCHDOG:-0}" != "1" ]]; then
    return 0
  fi
  if [[ -n "${HOST_DAEMON_WATCHDOG_PID}" ]]; then
    return 0
  fi

  mkdir -p "${outdir}" >/dev/null 2>&1 || true

  # The host daemon is normally run under a stack-scoped home directory so it shares credentials
  # with the UI. The watchdog must probe status using the same home+activeServerId or it will
  # report "Daemon is not running" and restart continuously.
  local watchdog_cli_root=""
  local watchdog_active_server_id=""
  local watchdog_stack_hint=""
  watchdog_stack_hint="$(resolve_stack_cli_home_and_active_server_id_for_ui_url "${host_server_url:-}" || true)"
  if [[ -n "${watchdog_stack_hint}" ]]; then
    watchdog_cli_root="$(printf "%s" "${watchdog_stack_hint}" | cut -d '|' -f 1)"
    watchdog_active_server_id="$(printf "%s" "${watchdog_stack_hint}" | cut -d '|' -f 2)"
  fi
  local host_home_rel="${WSREPL_QA_HOST_HOME_REL:-}"
  if [[ -n "${host_home_rel}" && -n "${watchdog_active_server_id}" ]]; then
    local overridden_home="$HOME/${host_home_rel}"
    if [[ -d "${overridden_home}" && -f "${overridden_home}/servers/${watchdog_active_server_id}/access.key" ]]; then
      watchdog_cli_root="${overridden_home}"
    fi
  fi

  local interval_s
  interval_s="$(read_wsrepl_host_daemon_watchdog_interval_s)"
  (
    set +e
    set +u
    set +o pipefail
    consecutive_not_running=0
    while true; do
      # `happier daemon status` can exit 0 even when unhealthy; treat explicit "not running" as unhealthy.
      if [[ -n "${watchdog_cli_root}" && -n "${watchdog_active_server_id}" ]]; then
        status_out="$(HAPPIER_SERVER_URL="${host_server_url:-}" HAPPIER_HOME_DIR="${watchdog_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${watchdog_active_server_id}" run_host_happier daemon status 2>&1)"
        status_code=$?
      else
        status_out="$(HAPPIER_SERVER_URL="${host_server_url:-}" run_host_happier daemon status 2>&1)"
        status_code=$?
      fi
      if [[ "${status_code}" != "0" ]]; then
        consecutive_not_running=0
        printf "%s\n" "[wsrepl-qa] host daemon watchdog: ensuring daemon is running (status_code=${status_code})" >> "${outdir}/host-daemon-watchdog.log" 2>&1 || true
        restart_host_daemon_and_capture_logs "${host_server_url:-}" ensure || true
        continue
      fi

      local reported_pid=""
      reported_pid="$(extract_pid_from_daemon_status_output "${status_out}")"
      if printf "%s" "${status_out}" | grep -qi "Daemon is running" && [[ -n "${reported_pid}" ]] && ! host_daemon_pid_is_alive "${reported_pid}"; then
        consecutive_not_running=0
        printf "%s\n" "[wsrepl-qa] host daemon watchdog: ensuring daemon is running (reported_pid_dead=${reported_pid})" >> "${outdir}/host-daemon-watchdog.log" 2>&1 || true
        restart_host_daemon_and_capture_logs "${host_server_url:-}" ensure || true
        continue
      fi

      if printf "%s" "${status_out}" | grep -qi "Daemon is not running"; then
        consecutive_not_running=$((consecutive_not_running + 1))
      else
        consecutive_not_running=0
      fi

      # Avoid flapping: a daemon can momentarily report "not running" during version restarts.
      if [[ "${consecutive_not_running}" -ge 3 ]]; then
        consecutive_not_running=0
        printf "%s\n" "[wsrepl-qa] host daemon watchdog: ensuring daemon is running (status_code=${status_code})" >> "${outdir}/host-daemon-watchdog.log" 2>&1 || true
        restart_host_daemon_and_capture_logs "${host_server_url:-}" ensure || true
      fi

      sleep "${interval_s}"
    done
  ) &
  HOST_DAEMON_WATCHDOG_PID="$!"
}

stop_host_daemon_watchdog_background() {
  if [[ -z "${HOST_DAEMON_WATCHDOG_PID}" ]]; then
    return 0
  fi
  kill "${HOST_DAEMON_WATCHDOG_PID}" >/dev/null 2>&1 || true
  wait "${HOST_DAEMON_WATCHDOG_PID}" >/dev/null 2>&1 || true
  HOST_DAEMON_WATCHDOG_PID=""
}

refresh_daemon_log_tail_best_effort() {
  local log_path_file="${1:-}"
  local log_tail_file="${2:-}"
  if [[ -z "${log_path_file}" || -z "${log_tail_file}" ]]; then
    return 0
  fi
  if [[ ! -f "${log_path_file}" ]]; then
    return 0
  fi
  local log_path
  log_path="$(head -n 1 "${log_path_file}" 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "${log_path}" || ! -f "${log_path}" ]]; then
    return 0
  fi
  local tail_lines
  tail_lines="$(read_wsrepl_daemon_log_tail_lines)"
  tail -n "${tail_lines}" "${log_path}" > "${log_tail_file}" 2>&1 || true
  return 0
}

refresh_host_daemon_status_best_effort() {
  local status_file="${1:-}"
  local server_url="${2:-}"
  local stack_cli_root="${3:-}"
  local stack_active_server_id="${4:-}"
  if [[ -z "${status_file}" ]]; then
    return 0
  fi
  if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
    if [[ -n "${server_url}" ]]; then
      HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
    else
      HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status >"${status_file}" 2>&1 || true
    fi
  else
    if [[ -n "${server_url}" ]]; then
      HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
    else
      run_host_happier daemon status >"${status_file}" 2>&1 || true
    fi
  fi
  return 0
}

wait_for_host_daemon_health_after_start() {
  local status_file="${1:-}"
  local log_path_file="${2:-}"
  local log_tail_file="${3:-}"
  local server_url="${4:-}"
  local stack_cli_root="${5:-}"
  local stack_active_server_id="${6:-}"
  local retries
  retries="$(read_wsrepl_host_daemon_start_poll_retries)"
  local delay_s
  delay_s="$(read_wsrepl_host_daemon_start_poll_delay_s)"

  local attempt=0
  while [[ "${attempt}" -lt "${retries}" ]]; do
    if [[ -s "${status_file}" ]] \
      && ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null \
      && ! grep -Eq "Cannot find module '.*/apps/cli/dist/index\\.mjs'" "${status_file}" 2>/dev/null; then
      refresh_daemon_log_tail_best_effort "${log_path_file}" "${log_tail_file}"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "${delay_s}" || true
    refresh_host_daemon_status_best_effort "${status_file}" "${server_url}" "${stack_cli_root}" "${stack_active_server_id}"
  done

  if [[ -s "${status_file}" ]] \
    && ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null \
    && ! grep -Eq "Cannot find module '.*/apps/cli/dist/index\\.mjs'" "${status_file}" 2>/dev/null; then
    refresh_daemon_log_tail_best_effort "${log_path_file}" "${log_tail_file}"
    return 0
  fi

  return 1
}

read_wsrepl_host_daemon_stop_poll_retries() {
  local raw="${WSREPL_QA_HOST_DAEMON_STOP_POLL_RETRIES:-}"
  if [[ -z "${raw}" ]]; then
    echo "40"
    return 0
  fi
  if [[ "${raw}" -lt 0 ]]; then
    echo "0"
    return 0
  fi
  echo "${raw}"
  return 0
}

read_wsrepl_host_daemon_stop_poll_delay_s() {
  local raw="${WSREPL_QA_HOST_DAEMON_STOP_POLL_DELAY_MS:-}"
  if [[ -z "${raw}" ]]; then
    raw="250"
  fi
  python3 - <<'PY' "${raw}" 2>/dev/null || true
import sys
try:
  ms = int(sys.argv[1])
except Exception:
  ms = 250
if ms < 0:
  ms = 0
print(f"{ms/1000.0:.3f}")
PY
}

capture_host_daemon_status_out_and_code() {
  local server_url="${1:-}"
  local stack_cli_root="${2:-}"
  local stack_active_server_id="${3:-}"
  local out_var="${4:-}"
  local code_var="${5:-}"

  local out=""
  local code=0
  set +e
  if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
    if [[ -n "${server_url}" ]]; then
      out="$(HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status 2>&1)"
      code=$?
    else
      out="$(HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status 2>&1)"
      code=$?
    fi
  else
    if [[ -n "${server_url}" ]]; then
      out="$(HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status 2>&1)"
      code=$?
    else
      out="$(run_host_happier daemon status 2>&1)"
      code=$?
    fi
  fi
  set -e

  if [[ -n "${out_var}" ]]; then
    printf -v "${out_var}" "%s" "${out}"
  fi
  if [[ -n "${code_var}" ]]; then
    printf -v "${code_var}" "%s" "${code}"
  fi
}

wait_for_host_daemon_stopped_after_stop() {
  local server_url="${1:-}"
  local stack_cli_root="${2:-}"
  local stack_active_server_id="${3:-}"
  local retries
  retries="$(read_wsrepl_host_daemon_stop_poll_retries)"
  local delay_s
  delay_s="$(read_wsrepl_host_daemon_stop_poll_delay_s)"

  local attempt=0
  while [[ "${attempt}" -lt "${retries}" ]]; do
    local status_out=""
    local status_code="0"
    capture_host_daemon_status_out_and_code "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" status_out status_code
    if [[ "${status_code}" != "0" ]] || printf "%s" "${status_out}" | grep -qi "Daemon is not running"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "${delay_s}" || true
  done

  local final_out=""
  local final_code="0"
  capture_host_daemon_status_out_and_code "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" final_out final_code
  if [[ "${final_code}" != "0" ]] || printf "%s" "${final_out}" | grep -qi "Daemon is not running"; then
    return 0
  fi

  return 1
}

refresh_post_playwright_diagnostics_best_effort() {
  # Refresh the daemon log tails at the end of the run so failure reports include the *actual*
  # handoff/transfer errors (initial tails are captured right after daemon start).
  refresh_daemon_log_tail_best_effort "${DAEMON_DIAG_DIR}/host.daemon.log.path.txt" "${DAEMON_DIAG_DIR}/host.daemon.log.tail.txt"
  refresh_daemon_log_tail_best_effort "${DAEMON_DIAG_DIR}/guest.daemon.log.path.txt" "${DAEMON_DIAG_DIR}/guest.daemon.log.tail.txt"

  if [[ -d "${REPORT_ROOT}/vms" ]]; then
    local candidate
    local diag_dir
    while IFS= read -r candidate; do
      diag_dir="$(dirname "${candidate}")"
      refresh_daemon_log_tail_best_effort "${candidate}" "${diag_dir}/guest.daemon.log.tail.txt"
    done < <(find "${REPORT_ROOT}/vms" -type f -path "*/daemon/guest.daemon.log.path.txt" 2>/dev/null || true)
  fi
}

resolve_expected_worktree_git_rev() {
  if ! command -v git >/dev/null 2>&1; then
    echo ""
    return 0
  fi
  (cd "${REPO_DIR}" && git rev-parse HEAD 2>/dev/null || true) | head -n 1 | tr -d '\r'
}

write_wsrepl_build_marker_files() {
  local payload_dir="$1"
  local cli_version="$2"
  local git_rev="$3"
  python3 - "${payload_dir}" "${cli_version}" "${git_rev}" <<'PY'
import json
import sys
from pathlib import Path

payload_dir = Path(sys.argv[1])
cli_version = sys.argv[2]
git_rev = sys.argv[3]

payload_dir.mkdir(parents=True, exist_ok=True)
(payload_dir / "wsrepl-build.json").write_text(
    json.dumps(
        {
            "kind": "wsrepl_build_marker",
            "cliVersion": cli_version or None,
            "gitRev": git_rev or None,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
(payload_dir / "wsrepl-build.version").write_text((cli_version or "") + "\n", encoding="utf-8")
(payload_dir / "wsrepl-build.gitrev").write_text((git_rev or "") + "\n", encoding="utf-8")
PY
}

resolve_stack_runtime_cli_bin() {
  local stack_name="${HAPPIER_QA_STACK_NAME:-}"
  if [[ -z "${stack_name}" ]]; then
    # Infer the stack name from the same UI-url-derived credentials path used elsewhere so the
    # wrapper can run on an existing runtime snapshot even when the worktree cannot build.
    local access_key_src=""
    access_key_src="$(resolve_stack_cli_access_key_path_for_ui_url || true)"
    if [[ -n "${access_key_src}" ]]; then
      stack_name="$(python3 - <<'PY' "${access_key_src}" "$HOME/.happier/stacks" 2>/dev/null || true
import sys
from pathlib import Path

raw = (sys.argv[1] or "").strip()
stacks_root = Path(sys.argv[2]).expanduser().resolve()
if not raw:
  print("")
  raise SystemExit(0)

try:
  path = Path(raw).expanduser().resolve()
  rel = path.relative_to(stacks_root)
  parts = rel.parts
  print(parts[0] if parts else "")
except Exception:
  print("")
PY
)"
    fi
  fi
  if [[ -z "${stack_name}" ]]; then
    echo ""
    return 0
  fi
  local candidate="$HOME/.happier/stacks/${stack_name}/runtime/current/cli/happier"
  if [[ -x "${candidate}" ]]; then
    echo "${candidate}"
    return 0
  fi
  echo ""
}

run_host_happier() {
  WSREPL_QA_HOST_HAPPIER_KIND=""
  local source="${WSREPL_QA_HOST_HAPPIER_SOURCE:-auto}"
  source="$(printf "%s" "${source}" | tr '[:upper:]' '[:lower:]')"

  local kind=""
  local resolved_path=""
  local version_output=""
  local -a invocation=()
  local -a cmd=()

  local write_resolution="${DAEMON_DIAG_DIR:-}/host.happier.resolve.json"

  write_resolution_once() {
    if [[ -n "${WSREPL_QA_HOST_HAPPIER_RESOLVE_WRITTEN:-}" ]]; then
      return 0
    fi
    if [[ -z "${DAEMON_DIAG_DIR:-}" ]]; then
      return 0
    fi
    mkdir -p "${DAEMON_DIAG_DIR}" >/dev/null 2>&1 || true
    python3 - "${write_resolution}" "${source}" "${kind}" "${resolved_path}" "${version_output}" "${invocation[@]}" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
source = (sys.argv[2] or "").strip() or None
host_kind = (sys.argv[3] or "").strip() or None
resolved_path = (sys.argv[4] or "").strip() or None
version = (sys.argv[5] or "").strip() or None
invocation = sys.argv[6:]

path.write_text(
    json.dumps(
        {
            "kind": "wsrepl_host_happier_resolution",
            "source": source,
            "hostHappierKind": host_kind,
            "resolvedPath": resolved_path,
            "version": version,
            "invocation": invocation,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
    WSREPL_QA_HOST_HAPPIER_RESOLVE_WRITTEN=1
    export WSREPL_QA_HOST_HAPPIER_RESOLVE_WRITTEN
  }

  if [[ "${source}" == explicit:* ]]; then
    local explicit_path="${WSREPL_QA_HOST_HAPPIER_SOURCE#explicit:}"
    explicit_path="$(printf "%s" "${explicit_path}" | tr -d '\r')"
    if [[ -z "${explicit_path}" || ! -x "${explicit_path}" ]]; then
      echo "[wsrepl-qa] invalid WSREPL_QA_HOST_HAPPIER_SOURCE (explicit path not executable): ${WSREPL_QA_HOST_HAPPIER_SOURCE}" >&2
      return 2
    fi
    kind="explicit"
    resolved_path="${explicit_path}"
    invocation=("${explicit_path}")
    version_output="$("${explicit_path}" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    cmd=("${explicit_path}" "$@")
    WSREPL_QA_HOST_HAPPIER_KIND="${kind}"
    write_resolution_once
    "${cmd[@]}"
    return $?
  fi

  if [[ "${source}" == "stack_runtime" ]]; then
    local runtime_cli_bin=""
    runtime_cli_bin="$(resolve_stack_runtime_cli_bin)"
    if [[ -z "${runtime_cli_bin}" ]]; then
      echo "[wsrepl-qa] WSREPL_QA_HOST_HAPPIER_SOURCE=stack_runtime but no stack runtime CLI was found" >&2
      return 2
    fi
    kind="stack_runtime"
    resolved_path="${runtime_cli_bin}"
    invocation=("${runtime_cli_bin}")
    version_output="$("${runtime_cli_bin}" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    cmd=("${runtime_cli_bin}" "$@")
    WSREPL_QA_HOST_HAPPIER_KIND="${kind}"
    write_resolution_once
    "${cmd[@]}"
    return $?
  fi

  if [[ "${source}" == "worktree_node" ]]; then
    kind="worktree_node"
    resolved_path="node ${REPO_DIR}/apps/cli/bin/happier.mjs"
    invocation=(node "${REPO_DIR}/apps/cli/bin/happier.mjs")
    version_output="$(node "${REPO_DIR}/apps/cli/bin/happier.mjs" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    cmd=(node "${REPO_DIR}/apps/cli/bin/happier.mjs" "$@")
    WSREPL_QA_HOST_HAPPIER_KIND="${kind}"
    write_resolution_once
    "${cmd[@]}"
    return $?
  fi

  if [[ "${source}" != "auto" && -n "${source}" ]]; then
    echo "[wsrepl-qa] invalid WSREPL_QA_HOST_HAPPIER_SOURCE: ${WSREPL_QA_HOST_HAPPIER_SOURCE} (expected auto|stack_runtime|worktree_node|explicit:/abs/path)" >&2
    return 2
  fi

  local runtime_cli_bin
  runtime_cli_bin="$(resolve_stack_runtime_cli_bin)"
  if [[ -n "${runtime_cli_bin}" ]]; then
    kind="stack_runtime"
    resolved_path="${runtime_cli_bin}"
    invocation=("${runtime_cli_bin}")
    version_output="$("${runtime_cli_bin}" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    cmd=("${runtime_cli_bin}" "$@")
    WSREPL_QA_HOST_HAPPIER_KIND="${kind}"
    write_resolution_once
    "${cmd[@]}"
    return $?
  fi

  if [[ -x "$HOME/.happier/bin/happier" ]]; then
    kind="user_install"
    resolved_path="$HOME/.happier/bin/happier"
    invocation=("$HOME/.happier/bin/happier")
    version_output="$("$HOME/.happier/bin/happier" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    cmd=("$HOME/.happier/bin/happier" "$@")
    WSREPL_QA_HOST_HAPPIER_KIND="${kind}"
    write_resolution_once
    "${cmd[@]}"
    return $?
  fi
  if command -v happier >/dev/null 2>&1; then
    kind="path"
    resolved_path="$(command -v happier 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    invocation=("happier")
    version_output="$(happier --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
    cmd=(happier "$@")
    WSREPL_QA_HOST_HAPPIER_KIND="${kind}"
    write_resolution_once
    "${cmd[@]}"
    return $?
  fi
  kind="worktree_node"
  resolved_path="node ${REPO_DIR}/apps/cli/bin/happier.mjs"
  invocation=(node "${REPO_DIR}/apps/cli/bin/happier.mjs")
  version_output="$(node "${REPO_DIR}/apps/cli/bin/happier.mjs" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
  cmd=(node "${REPO_DIR}/apps/cli/bin/happier.mjs" "$@")
  WSREPL_QA_HOST_HAPPIER_KIND="${kind}"
  write_resolution_once
  "${cmd[@]}"
  return $?
}

resolve_stack_cli_auth_scope_json_for_ui_url() {
  local server_url_hint="${1:-}"
  node --input-type=module - "${REPO_DIR}" "${server_url_hint}" <<'NODE' 2>/dev/null || true
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoDir = process.argv[2];
const serverUrlHint = String(process.argv[3] ?? '').trim();
const authPathsModuleUrl = pathToFileURL(path.join(repoDir, '.project/scripts/qa/resolveStackAuthPaths.mjs')).href;
const matrixCredentialsModuleUrl = pathToFileURL(path.join(repoDir, '.project/scripts/qa/wsreplMatrixCredentials.mjs')).href;
const { resolveQaStackName, resolveStackNameFromServerPort } = await import(authPathsModuleUrl);
const { resolveStackCliAccessKeyCandidatesForUi } = await import(matrixCredentialsModuleUrl);

const homeDir = String(process.env.HOME ?? '').trim() || os.homedir();
const explicitStackName = String(process.env.HAPPIER_QA_STACK_NAME ?? '').trim();
const explicitAccessKeyPath = String(process.env.HAPPIER_QA_ACCESS_KEY_PATH ?? '').trim();
const uiUrl = String(process.env.HAPPIER_UI_URL ?? '').trim();
const envServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '').trim();

function resolvePort(rawUrl) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return 0;
  try {
    const parsed = new URL(raw);
    const port = Number(parsed.port);
    return Number.isFinite(port) ? port : 0;
  } catch {
    return 0;
  }
}

let stackName = explicitStackName;
if (!stackName && serverUrlHint) {
  stackName = resolveStackNameFromServerPort({ serverPort: resolvePort(serverUrlHint), homeDir });
}
if (!stackName && envServerUrl) {
  stackName = resolveStackNameFromServerPort({ serverPort: resolvePort(envServerUrl), homeDir });
}
if (!stackName) {
  stackName = resolveQaStackName({ uiUrl, explicitStackName: '', homeDir });
}

const candidates = explicitAccessKeyPath
  ? [explicitAccessKeyPath]
  : resolveStackCliAccessKeyCandidatesForUi({
      uiUrl,
      explicitStackName: stackName,
      explicitAccessKeyPath: '',
      homeDir,
    });

const accessKeyPath = String(candidates[0] ?? '').trim();
let cliRoot = '';
let activeServerId = '';
let activeServerDir = '';
if (accessKeyPath) {
  const serverDir = path.dirname(accessKeyPath);
  const serversRoot = path.dirname(serverDir);
  if (path.basename(serversRoot) === 'servers') {
    cliRoot = path.dirname(serversRoot);
    activeServerId = path.basename(serverDir);
    activeServerDir = serverDir;
  }
}

process.stdout.write(JSON.stringify({
  kind: 'wsrepl_stack_auth_scope',
  stackName,
  accessKeyPath,
  cliRoot,
  activeServerId,
  activeServerDir,
  stackHomeDir: stackName ? path.join(homeDir, '.happier', 'stacks', stackName) : '',
  candidates,
}));
NODE
}

resolve_stack_cli_access_key_path_for_ui_url() {
  local server_url_hint="${1:-}"
  local scope_json=""
  scope_json="$(resolve_stack_cli_auth_scope_json_for_ui_url "${server_url_hint}")"
  if [[ -n "${scope_json}" ]]; then
    local parsed_access_key_path=""
    parsed_access_key_path="$(python3 - <<'PY' "${scope_json}" 2>/dev/null || true
import json
import sys

payload = json.loads(sys.argv[1])
print(str(payload.get("accessKeyPath") or "").strip())
PY
)"
    if [[ -n "${parsed_access_key_path}" ]]; then
      echo "${parsed_access_key_path}"
      return 0
    fi
  fi
  local explicit="${HAPPIER_QA_ACCESS_KEY_PATH:-}"
  if [[ -n "${explicit}" ]]; then
    # For watchdog stack hint resolution we only need the path shape to recover
    # `<cli_root>/servers/<serverId>/access.key`. Prefer explicit caller input
    # even if the file is not present yet (it may appear after the daemon seeds
    # credentials), but fail closed if the path doesn't look like an access key.
    if [[ -f "${explicit}" ]]; then
      echo "${explicit}"
      return 0
    fi
    if [[ "${explicit}" == */access.key ]]; then
      echo "${explicit}"
      return 0
    fi
  fi

  local stacks_root="$HOME/.happier/stacks"
  if [[ ! -d "${stacks_root}" ]]; then
    echo ""
    return 0
  fi

  local stack_name="${HAPPIER_QA_STACK_NAME:-}"
  local server_port=""
  if [[ -n "${server_url_hint}" ]]; then
    server_port="$(python3 - <<'PY' "${server_url_hint}" 2>/dev/null || true
import sys
from urllib.parse import urlparse

server = str(sys.argv[1] or "").strip()
if not server:
  raise SystemExit(0)
srv = urlparse(server)
print(srv.port or "")
PY
    )"
  fi
  if [[ -z "${server_port}" && -n "${HAPPIER_SERVER_URL:-}" ]]; then
    server_port="$(python3 - <<'PY' "${HAPPIER_SERVER_URL}" 2>/dev/null || true
import sys
from urllib.parse import urlparse

server = str(sys.argv[1] or "").strip()
if not server:
  raise SystemExit(0)
srv = urlparse(server)
print(srv.port or "")
PY
    )"
  fi
  if [[ -z "${server_port}" && -n "${HAPPIER_UI_URL:-}" ]]; then
    server_port="$(python3 - <<'PY' "${HAPPIER_UI_URL}" 2>/dev/null || true
import sys
from urllib.parse import urlparse, parse_qs, unquote

ui_url = sys.argv[1]
parsed = urlparse(ui_url)
qs = parse_qs(parsed.query)
server = unquote(qs.get("server", [""])[0])
if not server:
  raise SystemExit(0)
srv = urlparse(server)
print(srv.port or "")
PY
	)"
  fi

  if [[ -z "${stack_name}" && -z "${server_port}" ]]; then
    stack_name="$(python3 - <<'PY' "${stacks_root}" 2>/dev/null || true
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])

best = None
for entry in root.iterdir():
  if not entry.is_dir():
    continue
  runtime_path = entry / "stack.runtime.json"
  if not runtime_path.exists():
    continue
  updated_at_ms = 0
  try:
    payload = json.loads(runtime_path.read_text(encoding="utf-8"))
    updated_at = str(payload.get("updatedAt") or "").strip()
    if updated_at:
      try:
        from datetime import datetime
        updated_at_ms = int(datetime.fromisoformat(updated_at.replace("Z", "+00:00")).timestamp() * 1000)
      except Exception:
        updated_at_ms = 0
  except Exception:
    updated_at_ms = 0
  mtime_ms = 0
  try:
    mtime_ms = int(runtime_path.stat().st_mtime * 1000)
  except Exception:
    mtime_ms = 0

  if best is None:
    best = (updated_at_ms, mtime_ms, entry.name)
    continue
  if updated_at_ms != best[0]:
    if updated_at_ms > best[0]:
      best = (updated_at_ms, mtime_ms, entry.name)
    continue
  if mtime_ms != best[1]:
    if mtime_ms > best[1]:
      best = (updated_at_ms, mtime_ms, entry.name)
    continue
  if entry.name > best[2]:
    best = (updated_at_ms, mtime_ms, entry.name)

print(best[2] if best else "")
PY
)"
  fi

  if [[ -z "${stack_name}" && -n "${server_port}" ]]; then
    stack_name="$(python3 - <<'PY' "${stacks_root}" "${server_port}" 2>/dev/null || true
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
port = int(sys.argv[2])

best = None
for entry in root.iterdir():
  if not entry.is_dir():
    continue
  runtime_path = entry / "stack.runtime.json"
  if not runtime_path.exists():
    continue
  try:
    payload = json.loads(runtime_path.read_text(encoding="utf-8"))
  except Exception:
    continue
  runtime_port = payload.get("ports", {}).get("server")
  if runtime_port != port:
    continue
  mtime = runtime_path.stat().st_mtime
  if best is None or mtime > best[0]:
    best = (mtime, entry.name)
print(best[1] if best else "")
PY
)"
  fi

  if [[ -z "${stack_name}" ]]; then
    echo ""
    return 0
  fi

  local stack_root="${stacks_root}/${stack_name}/cli"
  if [[ ! -d "${stack_root}" ]]; then
    echo ""
    return 0
  fi

  python3 - <<'PY' "${stack_root}" 2>/dev/null || true
import os
import sys
from pathlib import Path

cli_root = Path(sys.argv[1])
server_scoped_candidates = []
servers_root = cli_root / "servers"
if servers_root.exists():
  for entry in servers_root.iterdir():
    if not entry.is_dir():
      continue
    server_scoped_candidates.append(entry / "access.key")

candidates = server_scoped_candidates if server_scoped_candidates else [cli_root / "access.key"]

best = None
for candidate in candidates:
  try:
    st = candidate.stat()
  except Exception:
    continue
  mtime = st.st_mtime
  if best is None or mtime > best[0]:
    best = (mtime, str(candidate))

print(best[1] if best else "")
PY
}

resolve_stack_cli_home_and_active_server_id_from_server_dir() {
  local server_dir="${1:-}"
  if [[ -z "${server_dir}" || ! -d "${server_dir}" ]]; then
    echo ""
    return 0
  fi

  local server_id
  server_id="$(basename "${server_dir}")"
  local servers_root
  servers_root="$(dirname "${server_dir}")"
  if [[ "$(basename "${servers_root}")" != "servers" ]]; then
    echo ""
    return 0
  fi

  local cli_root
  cli_root="$(dirname "${servers_root}")"
  if [[ ! -d "${cli_root}" ]]; then
    echo ""
    return 0
  fi

  echo "${cli_root}|${server_id}"
}

resolve_stack_cli_home_and_active_server_id_for_ui_url() {
  local server_url_hint="${1:-}"
  local active_server_dir="${HAPPIER_QA_ACTIVE_SERVER_DIR:-}"
  if [[ -n "${active_server_dir}" ]]; then
    local from_active_server_dir
    from_active_server_dir="$(resolve_stack_cli_home_and_active_server_id_from_server_dir "${active_server_dir}")"
    if [[ -n "${from_active_server_dir}" ]]; then
      echo "${from_active_server_dir}"
      return 0
    fi
  fi

  local access_key_path
  access_key_path="$(resolve_stack_cli_access_key_path_for_ui_url "${server_url_hint}")"
  if [[ -z "${access_key_path}" ]]; then
    echo ""
    return 0
  fi

  resolve_stack_cli_home_and_active_server_id_from_server_dir "$(dirname "${access_key_path}")"
}

resolve_machine_transfer_server_routed_max_bytes_seed_from_server_features() {
  local server_url="${1:-}"
  if [[ -n "${HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES:-}" ]]; then
    echo ""
    return 0
  fi
  if [[ -z "${server_url}" ]]; then
    echo ""
    return 0
  fi

  local features_url="${server_url%/}/v1/features"
  local resolved
  resolved="$(
    curl -fsSL "${features_url}" 2>/dev/null | python3 -c '
import json
import sys

try:
  payload = json.load(sys.stdin)
except Exception:
  raise SystemExit(0)

capabilities = payload.get("capabilities") if isinstance(payload, dict) else None
machines = capabilities.get("machines") if isinstance(capabilities, dict) else None
transfer = machines.get("transfer") if isinstance(machines, dict) else None
server_routed = transfer.get("serverRouted") if isinstance(transfer, dict) else None
max_bytes = server_routed.get("maxBytes") if isinstance(server_routed, dict) else None

value = None
if isinstance(max_bytes, bool):
  value = None
elif isinstance(max_bytes, (int, float)):
  value = int(max_bytes)
elif isinstance(max_bytes, str) and max_bytes.strip():
  try:
    value = int(float(max_bytes.strip()))
  except Exception:
    value = None

if isinstance(value, int) and value > 0:
  sys.stdout.write(str(value))
' 2>/dev/null || true
  )"

  if [[ -n "${resolved}" && "${resolved}" =~ ^[0-9]+$ && "${resolved}" -gt 0 ]]; then
    echo "${resolved}"
    return 0
  fi

  echo ""
  return 0
}

rewrite_server_url_for_lima_guest() {
  local server_url="${1:-}"
  if [[ -z "${server_url}" ]]; then
    echo ""
    return 0
  fi
  python3 - "${server_url}" <<'PY'
import sys
from urllib.parse import urlparse, urlunparse

raw = (sys.argv[1] or "").strip()
try:
  parsed = urlparse(raw)
except Exception:
  print(raw)
  raise SystemExit(0)

host = (parsed.hostname or "").strip()
if host in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
  port = parsed.port
  userinfo = ""
  if "@" in parsed.netloc:
    userinfo = parsed.netloc.split("@", 1)[0] + "@"
  netloc = f"{userinfo}host.lima.internal{(':' + str(port)) if port else ''}"
  parsed = parsed._replace(netloc=netloc)

print(urlunparse(parsed))
PY
}

extract_waiting_for_credentials_path_from_log_tail() {
  local log_tail_file="$1"
  if [[ ! -f "${log_tail_file}" ]]; then
    echo ""
    return 0
  fi
  # Example:
  #   [DAEMON RUN] Waiting for credentials at /Users/.../access.key...
  sed -n 's/.*Waiting for credentials at \([^ ]*access\.key\)\.\.\..*/\1/p' "${log_tail_file}" | head -n 1 | tr -d '\r'
}

extract_machine_id_from_daemon_status_file() {
  local status_file="$1"
  if [[ -z "${status_file}" || ! -f "${status_file}" ]]; then
    echo ""
    return 0
  fi
  python3 - "$status_file" <<'PY' 2>/dev/null || true
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace")
m = re.search(r'"machineId"\s*:\s*"([^"]+)"', text)
print((m.group(1) if m else "").strip())
PY
}

seed_host_daemon_access_key_if_possible() {
  local log_tail_file="$1"

  local access_key_src
  access_key_src="$(resolve_stack_cli_access_key_path_for_ui_url)"
  if [[ -z "${access_key_src}" || ! -f "${access_key_src}" ]]; then
    return 1
  fi

  local access_key_dst
  access_key_dst="$(extract_waiting_for_credentials_path_from_log_tail "${log_tail_file}")"
  if [[ -z "${access_key_dst}" ]]; then
    return 1
  fi

  mkdir -p "$(dirname "${access_key_dst}")"
  cp -f "${access_key_src}" "${access_key_dst}"
  chmod 600 "${access_key_dst}" 2>/dev/null || true
  return 0
}

seed_guest_daemon_access_key_if_possible() {
  local log_tail_file="$1"

  local access_key_src
  access_key_src="$(resolve_stack_cli_access_key_path_for_ui_url)"
  if [[ -z "${access_key_src}" || ! -f "${access_key_src}" ]]; then
    return 1
  fi

  local access_key_dst
  access_key_dst="$(extract_waiting_for_credentials_path_from_log_tail "${log_tail_file}")"
  if [[ -z "${access_key_dst}" ]]; then
    return 1
  fi

  local encoded
  encoded="$(python3 - <<'PY' "${access_key_src}"
import base64
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = path.read_bytes()
print(base64.b64encode(payload).decode("ascii"))
PY
)"

  limactl shell "${VM_NAME}" -- bash -lc "set -euo pipefail;
    decode_base64() {
      if printf 'Zg==' | base64 -d >/dev/null 2>&1; then
        base64 -d
        return
      fi
      if printf 'Zg==' | base64 -D >/dev/null 2>&1; then
        base64 -D
        return
      fi
      base64 --decode
    }
    mkdir -p \"$(dirname "${access_key_dst}")\"
    printf '%s' '${encoded}' | decode_base64 > \"${access_key_dst}\"
    chmod 600 \"${access_key_dst}\" 2>/dev/null || true
  "
  return 0
}

restart_host_daemon_and_capture_logs() {
  local server_url="${1:-}"
  local restart_mode="${2:-restart}"
  local selected_host_direct_peer_bind_port="${3:-}"
  local should_stop="1"
  if [[ "${restart_mode}" == "ensure" ]]; then
    should_stop="0"
  fi
  init_daemon_diagnostic_placeholders

  local start_file="${DAEMON_DIAG_DIR}/host.daemon.start.txt"
  local build_file="${DAEMON_DIAG_DIR}/host.cli.build.txt"
  local status_file="${DAEMON_DIAG_DIR}/host.daemon.status.txt"
  local log_path_file="${DAEMON_DIAG_DIR}/host.daemon.log.path.txt"
  local log_tail_file="${DAEMON_DIAG_DIR}/host.daemon.log.tail.txt"
  local provider_install_file=""

  local stack_cli_root=""
  local stack_active_server_id=""
  local stack_home_hint
  stack_home_hint="$(resolve_stack_cli_home_and_active_server_id_for_ui_url "${server_url}")"
  if [[ -n "${stack_home_hint}" ]]; then
    stack_cli_root="$(printf "%s" "${stack_home_hint}" | cut -d '|' -f 1)"
    stack_active_server_id="$(printf "%s" "${stack_home_hint}" | cut -d '|' -f 2)"
  fi
  local canonical_stack_cli_root="${stack_cli_root}"
  local canonical_stack_active_server_id="${stack_active_server_id}"

  # Optionally run the host daemon in an isolated home directory so other stack tooling (or other QA
  # runs) does not stop it mid-matrix. When enabled, we pre-seed the stack server credentials into
  # the isolated home so the daemon registers under the same account as the UI.
  local host_home_rel="${WSREPL_QA_HOST_HOME_REL:-}"
  local stack_access_key_src=""
  local used_isolated_host_home="0"
  if [[ -n "${host_home_rel}" ]]; then
    local host_home_dir="$HOME/${host_home_rel}"
    if [[ -n "${stack_active_server_id}" ]]; then
      local host_server_dir="${host_home_dir}/servers/${stack_active_server_id}"
      local host_access_key_dst="${host_server_dir}/access.key"
      stack_access_key_src="$(resolve_stack_cli_access_key_path_for_ui_url "${server_url}" || true)"
      if [[ -n "${stack_access_key_src}" && -f "${stack_access_key_src}" ]]; then
        mkdir -p "${host_server_dir}"
        cp "${stack_access_key_src}" "${host_access_key_dst}"
        chmod 600 "${host_access_key_dst}" 2>/dev/null || true
      fi
      if [[ -n "${canonical_stack_cli_root}" ]]; then
        local canonical_settings_src="${canonical_stack_cli_root}/settings.json"
        local host_settings_dst="${host_home_dir}/settings.json"
        if [[ -f "${canonical_settings_src}" ]]; then
          mkdir -p "${host_home_dir}"
          cp -f "${canonical_settings_src}" "${host_settings_dst}"
          chmod 600 "${host_settings_dst}" 2>/dev/null || true
        fi
      fi
      if [[ -f "${host_access_key_dst}" ]]; then
        stack_cli_root="${host_home_dir}"
        used_isolated_host_home="1"
      fi
    fi
  fi
  write_host_daemon_scope_diagnostics "${canonical_stack_cli_root}" "${canonical_stack_active_server_id}" "${host_home_rel}" "${stack_access_key_src}" "${stack_cli_root}" "${used_isolated_host_home}"
  if [[ -n "${host_home_rel}" && "${used_isolated_host_home}" != "1" ]]; then
    FAILURE_STAGE="host_daemon"
    FAILURE_REASON="host_daemon_scope_resolution_failed"
    echo "[wsrepl-qa] isolated host home requested via WSREPL_QA_HOST_HOME_REL=${host_home_rel}, but the wrapper could not resolve/copy the stack-scoped host daemon credentials. Refusing to start the host daemon against the default home." >&2
    return 1
  fi

  # For host↔Lima direct-peer transfers, the guest can always resolve `host.lima.internal` but may not
  # be able to reach the host's LAN/VPN interface IPs. Publish `host.lima.internal` by default so the
  # host advertises at least one direct-peer endpoint candidate that is reachable from the Lima VM.
  local host_direct_peer_advertised_hosts="${WSREPL_QA_HOST_DIRECT_PEER_ADVERTISED_HOSTS:-host.lima.internal}"
  local host_direct_peer_bind_port="${selected_host_direct_peer_bind_port}"
  if [[ -z "${host_direct_peer_bind_port}" ]]; then
    host_direct_peer_bind_port="$(resolve_wsrepl_host_direct_peer_bind_port)"
  fi
  local host_direct_peer_feature_enabled="${WSREPL_QA_HOST_DIRECT_PEER_FEATURE_ENABLED:-true}"
  local host_direct_peer_server_enabled="${WSREPL_QA_HOST_DIRECT_PEER_SERVER_ENABLED:-true}"
  local server_routed_max_bytes_seed=""
  server_routed_max_bytes_seed="$(resolve_machine_transfer_server_routed_max_bytes_seed_from_server_features "${server_url}")"

  local host_provider_install_id=""
  host_provider_install_id="${HAPPIER_QA_PREFERRED_AGENT_ENGINES%%,*}"
  if [[ -z "${host_provider_install_id}" ]]; then
    host_provider_install_id="codex"
  fi
  provider_install_file="${DAEMON_DIAG_DIR}/host.provider.install.${host_provider_install_id}.txt"

  if [[ "${WSREPL_QA_SKIP_HOST_PROVIDER_INSTALL:-0}" != "1" ]]; then
    echo "[wsrepl-qa] ensure host provider installed: ${host_provider_install_id}..."
    set +e
    if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
      if [[ -n "${server_url}" ]]; then
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" \
          run_host_happier install provider "${host_provider_install_id}" >"${provider_install_file}" 2>&1
      else
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" \
          run_host_happier install provider "${host_provider_install_id}" >"${provider_install_file}" 2>&1
      fi
    else
      if [[ -n "${server_url}" ]]; then
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
        HAPPIER_SERVER_URL="${server_url}" \
          run_host_happier install provider "${host_provider_install_id}" >"${provider_install_file}" 2>&1
      else
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
          run_host_happier install provider "${host_provider_install_id}" >"${provider_install_file}" 2>&1
      fi
    fi
    local provider_install_status=$?
    set -e
    if [[ "${provider_install_status}" != "0" ]]; then
      FAILURE_STAGE="host_provider_install"
      FAILURE_REASON="host_provider_install_failed"
      echo "[wsrepl-qa] failed to install host provider ${host_provider_install_id}; see ${provider_install_file}" >&2
      return 1
    fi
  fi

  local daemon_start_retries="${WSREPL_QA_DAEMON_START_RETRIES:-1}"
  local daemon_start_retry_delay_ms="${WSREPL_QA_DAEMON_START_RETRY_DELAY_MS:-250}"
  if [[ -z "${daemon_start_retries}" || "${daemon_start_retries}" -lt 1 ]]; then
    daemon_start_retries=1
  fi
  if [[ -z "${daemon_start_retry_delay_ms}" || "${daemon_start_retry_delay_ms}" -lt 0 ]]; then
    daemon_start_retry_delay_ms=250
  fi
  local daemon_start_retry_delay_s
  daemon_start_retry_delay_s="$(python3 - <<'PY' "${daemon_start_retry_delay_ms}"
import sys
try:
  ms = int(sys.argv[1])
except Exception:
  ms = 250
if ms < 0:
  ms = 0
print(f"{ms/1000.0:.3f}")
PY
  )"

  run_host_daemon_start_with_matrix_env() {
    local output_file="${1:-}"
    local run_server_url="${2:-}"
    local run_stack_cli_root="${3:-}"
    local run_stack_active_server_id="${4:-}"
    local run_server_routed_max_bytes_seed="${5:-}"
    local run_host_direct_peer_feature_enabled="${6:-}"
    local run_host_direct_peer_bind_port="${7:-}"
    local run_host_direct_peer_advertised_hosts="${8:-}"
    local run_host_direct_peer_server_enabled="${9:-}"

    local effective_server_routed_max_bytes="${HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES:-${run_server_routed_max_bytes_seed}}"
    local effective_host_direct_peer_feature_enabled="${HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED:-${run_host_direct_peer_feature_enabled}}"
    # Prefer the wrapper-resolved port so stale ambient env cannot override the scanned port for this run.
    local effective_host_direct_peer_bind_port="${run_host_direct_peer_bind_port:-${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT:-}}"
    local effective_host_direct_peer_advertised_hosts="${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS:-${run_host_direct_peer_advertised_hosts}}"
    local effective_host_direct_peer_server_enabled="${HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED:-${run_host_direct_peer_server_enabled}}"

    (
      export HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}"
      export HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED="${effective_host_direct_peer_feature_enabled}"
      export HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS="${effective_host_direct_peer_advertised_hosts}"
      export HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED="${effective_host_direct_peer_server_enabled}"
      export HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK=1
      export HAPPIER_DAEMON_WAIT_FOR_AUTH=1
      export HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}"

      if [[ -n "${effective_server_routed_max_bytes}" ]]; then
        export HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES="${effective_server_routed_max_bytes}"
      else
        unset HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES
      fi

      if [[ -n "${effective_host_direct_peer_bind_port}" ]]; then
        export HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT="${effective_host_direct_peer_bind_port}"
      else
        unset HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT
      fi

      if [[ -n "${run_server_url}" ]]; then
        export HAPPIER_SERVER_URL="${run_server_url}"
      else
        unset HAPPIER_SERVER_URL
      fi

      if [[ -n "${run_stack_cli_root}" && -n "${run_stack_active_server_id}" ]]; then
        export HAPPIER_HOME_DIR="${run_stack_cli_root}"
        export HAPPIER_ACTIVE_SERVER_ID="${run_stack_active_server_id}"
      else
        unset HAPPIER_HOME_DIR
        unset HAPPIER_ACTIVE_SERVER_ID
      fi

      run_host_happier daemon start >"${output_file}" 2>&1
    )
  }

	  local start_status=0
	  if [[ -n "${server_url}" ]]; then
	    if [[ "${should_stop}" == "1" ]]; then
	      if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
	        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon stop >/dev/null 2>&1 || true
	      else
	        HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon stop >/dev/null 2>&1 || true
	      fi
	      if ! wait_for_host_daemon_stopped_after_stop "${server_url}" "${stack_cli_root}" "${stack_active_server_id}"; then
	        FAILURE_STAGE="host_daemon"
	        FAILURE_REASON="host_daemon_stop_failed"
	        echo "[wsrepl-qa] host daemon stop did not take effect (status remained running); refusing to restart with potentially stale env. Set WSREPL_QA_HOST_DAEMON_STOP_POLL_RETRIES/DELAY_MS to tune." >&2
	        return 1
	      fi
	    fi
	    set +e
      run_host_daemon_start_with_matrix_env "${start_file}" "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" "${server_routed_max_bytes_seed}" "${host_direct_peer_feature_enabled}" "${host_direct_peer_bind_port}" "${host_direct_peer_advertised_hosts}" "${host_direct_peer_server_enabled}"
      start_status=$?
      set -e
      if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      else
        HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
        HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      fi
  else
	    if [[ "${should_stop}" == "1" ]]; then
	      if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
	        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon stop >/dev/null 2>&1 || true
	      else
	        run_host_happier daemon stop >/dev/null 2>&1 || true
	      fi
	      if ! wait_for_host_daemon_stopped_after_stop "" "${stack_cli_root}" "${stack_active_server_id}"; then
	        FAILURE_STAGE="host_daemon"
	        FAILURE_REASON="host_daemon_stop_failed"
	        echo "[wsrepl-qa] host daemon stop did not take effect (status remained running); refusing to restart with potentially stale env. Set WSREPL_QA_HOST_DAEMON_STOP_POLL_RETRIES/DELAY_MS to tune." >&2
	        return 1
	      fi
	    fi
	    set +e
      run_host_daemon_start_with_matrix_env "${start_file}" "" "${stack_cli_root}" "${stack_active_server_id}" "${server_routed_max_bytes_seed}" "${host_direct_peer_feature_enabled}" "${host_direct_peer_bind_port}" "${host_direct_peer_advertised_hosts}" "${host_direct_peer_server_enabled}"
      start_status=$?
      set -e
      if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status >"${status_file}" 2>&1 || true
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      else
        run_host_happier daemon status >"${status_file}" 2>&1 || true
        run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      fi
  fi

  local log_path
  log_path="$(head -n 1 "${log_path_file}" 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "${log_path}" && -f "${log_path}" ]]; then
    tail -n 400 "${log_path}" > "${log_tail_file}" 2>&1 || true
  else
    printf "%s\n" "(no daemon log file found)" > "${log_tail_file}"
  fi

  wait_for_host_daemon_health_after_start "${status_file}" "${log_path_file}" "${log_tail_file}" "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" || true

  local cli_dist_rebuild_attempted=0
  if [[ "${WSREPL_QA_HOST_HAPPIER_KIND:-}" == "worktree_node" ]] && grep -Eq "Cannot find module '.*/apps/cli/(dist|package-dist)/index\\.mjs'|Daemon packaged entrypoint is missing: .*/apps/cli/package-dist/index\\.mjs" "${start_file}" "${status_file}" "${log_tail_file}" 2>/dev/null; then
    cli_dist_rebuild_attempted=1
    echo "[wsrepl-qa] host daemon start/status reported a missing CLI dist entrypoint; rebuilding and retrying..." >&2
    (
      cd "${REPO_DIR}"
      yarn workspace @happier-dev/cli build
    ) >"${build_file}" 2>&1 || true

	    set +e
      run_host_daemon_start_with_matrix_env "${start_file}" "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" "${server_routed_max_bytes_seed}" "${host_direct_peer_feature_enabled}" "${host_direct_peer_bind_port}" "${host_direct_peer_advertised_hosts}" "${host_direct_peer_server_enabled}"
      start_status=$?
      set -e

    if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
      if [[ -n "${server_url}" ]]; then
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      else
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status >"${status_file}" 2>&1 || true
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      fi
    else
      if [[ -n "${server_url}" ]]; then
        HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
        HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      else
        run_host_happier daemon status >"${status_file}" 2>&1 || true
        run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      fi
    fi

    log_path="$(head -n 1 "${log_path_file}" 2>/dev/null | tr -d '\r' || true)"
    if [[ -n "${log_path}" && -f "${log_path}" ]]; then
      tail -n 400 "${log_path}" > "${log_tail_file}" 2>&1 || true
    else
      printf "%s\n" "(no daemon log file found)" > "${log_tail_file}"
    fi
  fi

  refresh_host_daemon_status_only_best_effort() {
    if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
      if [[ -n "${server_url}" ]]; then
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
      else
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status >"${status_file}" 2>&1 || true
      fi
    else
      if [[ -n "${server_url}" ]]; then
        HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
      else
        run_host_happier daemon status >"${status_file}" 2>&1 || true
      fi
    fi
  }

  poll_host_machine_id_if_needed_best_effort() {
    local machine_id
    machine_id="$(extract_machine_id_from_daemon_status_file "${status_file}")"
    if [[ -n "${machine_id}" ]]; then
      return 0
    fi

    local retries
    retries="$(read_wsrepl_machine_id_poll_retries)"
    if [[ -z "${retries}" || "${retries}" -lt 1 ]]; then
      return 0
    fi

    local delay_s
    delay_s="$(read_wsrepl_machine_id_poll_delay_s)"
    local attempt=0
    while [[ "${attempt}" -lt "${retries}" ]]; do
      attempt=$((attempt + 1))
      sleep "${delay_s}"
      refresh_host_daemon_status_only_best_effort
      machine_id="$(extract_machine_id_from_daemon_status_file "${status_file}")"
      if [[ -n "${machine_id}" ]]; then
        return 0
      fi
    done
    return 0
  }

  # `machineId` is persisted asynchronously by the daemon after it registers with the server.
  # Poll best-effort only when the caller did not already pin the host/source machine id, and
  # only when we will need it for step derivation or new-session creation.
  local should_poll_host_machine_id="0"
  if [[ "${WSREPL_QA_DERIVE_STEPS_LATER:-0}" == "1" ]]; then
    should_poll_host_machine_id="1"
  fi
  case "$(printf "%s" "${HAPPIER_QA_CREATE_SESSION:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y)
      should_poll_host_machine_id="1"
      ;;
    *)
      ;;
  esac

  if [[ -n "${WSREPL_QA_MACHINE_ID_POLL_RETRIES:-}" ]]; then
    local raw_poll_retries="${WSREPL_QA_MACHINE_ID_POLL_RETRIES:-}"
    if [[ "${raw_poll_retries}" =~ ^[0-9]+$ ]] && [[ "${raw_poll_retries}" -ge 1 ]]; then
      should_poll_host_machine_id="1"
    fi
  fi

  if [[ "${should_poll_host_machine_id}" == "1" && -z "${WSREPL_QA_HOST_MACHINE_ID:-}" && -z "${HAPPIER_QA_SOURCE_MACHINE_ID:-}" && -s "${status_file}" ]] && ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null; then
    poll_host_machine_id_if_needed_best_effort
  fi

  if [[ "${start_status}" == "0" ]]; then
    return 0
  fi

  # `daemon start` can return non-zero even if the daemon is up (for example if the daemon is
  # already running but still writing its new state). Prefer status output over exit codes.
  if [[ -s "${status_file}" ]] && ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null; then
    return 0
  fi

  if [[ "${start_status}" != "0" ]]; then
    # In dev worktrees the CLI entrypoint depends on `apps/cli/dist/**`. If another process is
    # rebuilding the CLI (or the dist folder is missing), `daemon start` can fail with a missing
    # entrypoint. Recover by rebuilding once and retrying so the QA harness doesn't fail flakily.
    if [[ "${cli_dist_rebuild_attempted}" != "1" && "${WSREPL_QA_HOST_HAPPIER_KIND:-}" == "worktree_node" ]] && grep -Eq "Cannot find module '.*/apps/cli/(dist|package-dist)/index\\.mjs'|Daemon packaged entrypoint is missing: .*/apps/cli/package-dist/index\\.mjs" "${start_file}" "${log_tail_file}" 2>/dev/null; then
      echo "[wsrepl-qa] host daemon start failed due to missing CLI dist entrypoint; rebuilding and retrying..." >&2
      (
        cd "${REPO_DIR}"
        yarn workspace @happier-dev/cli build
      ) >"${build_file}" 2>&1 || true

      set +e
      run_host_daemon_start_with_matrix_env "${start_file}" "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" "${server_routed_max_bytes_seed}" "${host_direct_peer_feature_enabled}" "${host_direct_peer_bind_port}" "${host_direct_peer_advertised_hosts}" "${host_direct_peer_server_enabled}"
      start_status=$?
      set -e

      if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
      else
        if [[ -n "${server_url}" ]]; then
          HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
          HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
        else
          run_host_happier daemon status >"${status_file}" 2>&1 || true
          run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
        fi
      fi

      log_path="$(head -n 1 "${log_path_file}" 2>/dev/null | tr -d '\r' || true)"
      if [[ -n "${log_path}" && -f "${log_path}" ]]; then
        tail -n 400 "${log_path}" > "${log_tail_file}" 2>&1 || true
      else
        printf "%s\n" "(no daemon log file found)" > "${log_tail_file}"
      fi

      if [[ "${start_status}" == "0" ]]; then
        return 0
      fi
    fi

    # `daemon start` can return non-zero when the daemon is running but waiting for credentials
    # (common in this harness before Playwright injects auth tokens). Treat that as non-fatal.
    if grep -qi "Waiting for credentials" "${log_tail_file}" 2>/dev/null; then
      # If we can find stack CLI credentials, seed them and retry once so the daemon comes online
      # before Playwright starts. (The Playwright harness does not perform terminal connect.)
      if seed_host_daemon_access_key_if_possible "${log_tail_file}"; then
        set +e
        run_host_daemon_start_with_matrix_env "${start_file}" "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" "${server_routed_max_bytes_seed}" "${host_direct_peer_feature_enabled}" "${host_direct_peer_bind_port}" "${host_direct_peer_advertised_hosts}" "${host_direct_peer_server_enabled}"
        start_status=$?
        if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
          if [[ -n "${server_url}" ]]; then
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          else
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          fi
        else
          if [[ -n "${server_url}" ]]; then
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          else
            run_host_happier daemon status >"${status_file}" 2>&1 || true
            run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          fi
        fi
        set -e
      fi
      if [[ "${start_status}" == "0" ]]; then
        return 0
      fi
      # If we can’t make the daemon healthy after seeding, fail fast so the Playwright matrix
      # doesn’t hang indefinitely on offline machines.
      FAILURE_STAGE="host_daemon"
      FAILURE_REASON="host_daemon_waiting_for_credentials"
      echo "[wsrepl-qa] host daemon is waiting for credentials and could not be started automatically; see ${log_tail_file}" >&2
      return 1
    fi

    if [[ "${daemon_start_retries}" -gt 1 ]]; then
      local attempt=2
      while [[ "${attempt}" -le "${daemon_start_retries}" ]]; do
        echo "[wsrepl-qa] host daemon start failed (exit=${start_status}); retrying (${attempt}/${daemon_start_retries})..." >&2

        if [[ "${should_stop}" == "1" ]]; then
          if [[ -n "${server_url}" ]]; then
            if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
              HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon stop >/dev/null 2>&1 || true
            else
              HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon stop >/dev/null 2>&1 || true
            fi
          else
            if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
              HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon stop >/dev/null 2>&1 || true
            else
              run_host_happier daemon stop >/dev/null 2>&1 || true
            fi
          fi
        fi

        sleep "${daemon_start_retry_delay_s}" || true

        set +e
        run_host_daemon_start_with_matrix_env "${start_file}" "${server_url}" "${stack_cli_root}" "${stack_active_server_id}" "${server_routed_max_bytes_seed}" "${host_direct_peer_feature_enabled}" "${host_direct_peer_bind_port}" "${host_direct_peer_advertised_hosts}" "${host_direct_peer_server_enabled}"
        start_status=$?
        set -e

        if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
          if [[ -n "${server_url}" ]]; then
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          else
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          fi
        else
          if [[ -n "${server_url}" ]]; then
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          else
            run_host_happier daemon status >"${status_file}" 2>&1 || true
            run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          fi
        fi

        log_path="$(head -n 1 "${log_path_file}" 2>/dev/null | tr -d '\r' || true)"
        if [[ -n "${log_path}" && -f "${log_path}" ]]; then
          tail -n 400 "${log_path}" > "${log_tail_file}" 2>&1 || true
        else
          printf "%s\n" "(no daemon log file found)" > "${log_tail_file}"
        fi

        if [[ "${start_status}" == "0" ]]; then
          return 0
        fi
        if [[ -s "${status_file}" ]] && ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null; then
          return 0
        fi

        attempt=$((attempt + 1))
      done
    fi

    FAILURE_STAGE="host_daemon"
    FAILURE_REASON="host_daemon_start_failed"
    echo "[wsrepl-qa] failed to start host daemon (exit=${start_status}); see ${start_file}" >&2
    return 1
  fi
}

restart_guest_daemon_and_capture_logs() {
  local server_url="${1:-}"
  local server_routed_max_bytes_seed="${2:-}"
  init_daemon_diagnostic_placeholders

  local start_file="${DAEMON_DIAG_DIR}/guest.daemon.start.txt"
  local status_file="${DAEMON_DIAG_DIR}/guest.daemon.status.txt"
  local log_path_file="${DAEMON_DIAG_DIR}/guest.daemon.log.path.txt"
  local log_tail_file="${DAEMON_DIAG_DIR}/guest.daemon.log.tail.txt"

  # Prefer running the guest daemon in an isolated home so we can deterministically seed the same
  # stack credentials used by the host/UI (guest VMs often carry stale credentials for other stacks).
  local guest_happier_home_rel=""
  local guest_active_server_id=""
  local guest_access_key_src=""
  local guest_direct_peer_bind_port=""
  local guest_direct_peer_advertised_hosts=""
  local guest_direct_peer_feature_enabled=""
  local guest_direct_peer_server_enabled=""
  local guest_server_routed_max_bytes=""
  local stack_home_hint
  stack_home_hint="$(resolve_stack_cli_home_and_active_server_id_for_ui_url)"
  if [[ -n "${stack_home_hint}" ]]; then
    guest_active_server_id="$(printf "%s" "${stack_home_hint}" | cut -d '|' -f 2)"
  fi
  guest_access_key_src="$(resolve_stack_cli_access_key_path_for_ui_url || true)"
  if [[ -z "${server_routed_max_bytes_seed}" ]]; then
    server_routed_max_bytes_seed="$(resolve_machine_transfer_server_routed_max_bytes_seed_from_server_features "${server_url}")"
  fi
  guest_server_routed_max_bytes="${HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES:-${server_routed_max_bytes_seed}}"
  guest_direct_peer_bind_port="$(resolve_wsrepl_vm_direct_peer_bind_port_for_vm "${VM_NAME}")"
  if [[ -n "${guest_direct_peer_bind_port}" ]]; then
    guest_direct_peer_advertised_hosts="$(resolve_wsrepl_vm_direct_peer_advertised_hosts)"
    guest_direct_peer_feature_enabled="${WSREPL_QA_VM_DIRECT_PEER_FEATURE_ENABLED:-true}"
    guest_direct_peer_server_enabled="${WSREPL_QA_VM_DIRECT_PEER_SERVER_ENABLED:-true}"
  fi
  if [[ -n "${guest_active_server_id}" && -n "${guest_access_key_src}" && -f "${guest_access_key_src}" ]]; then
    guest_happier_home_rel=".happier/wsrepl-qa"
  fi

  # If the guest does not have Happier installed yet (common in local harness tests, or when mode=skip),
  # keep the wrapper non-fatal and leave the placeholder diagnostics in place.
  if ! limactl shell "${VM_NAME}" -- bash -lc '[[ -x "$HOME/.happier/bin/happier" ]] || command -v happier >/dev/null 2>&1' >/dev/null 2>&1; then
    printf "%s\n" "(guest happier not found; skipping daemon restart)" > "${start_file}"
    printf "%s\n" "(guest happier not found)" > "${status_file}"
    printf "%s\n" "" > "${log_path_file}"
    printf "%s\n" "(no daemon log file found)" > "${log_tail_file}"
    return 0
  fi

  # Seed stack credentials into the isolated guest home before starting the daemon so the guest
  # machine registers under the same account as the UI.
  if [[ -n "${guest_happier_home_rel}" && -n "${guest_active_server_id}" && -n "${guest_access_key_src}" && -f "${guest_access_key_src}" ]]; then
    local encoded_key
    encoded_key="$(python3 - <<'PY' "${guest_access_key_src}"
import base64
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = path.read_bytes()
print(base64.b64encode(payload).decode("ascii"))
PY
)"
    limactl shell "${VM_NAME}" -- bash -lc "set -euo pipefail;
      decode_base64() {
        if printf 'Zg==' | base64 -d >/dev/null 2>&1; then
          base64 -d
          return
        fi
        if printf 'Zg==' | base64 -D >/dev/null 2>&1; then
          base64 -D
          return
        fi
        base64 --decode
      }
      home_dir=\"\$HOME/${guest_happier_home_rel}\"
      dst=\"\$home_dir/servers/${guest_active_server_id}/access.key\"
      mkdir -p \"\$(dirname \"\$dst\")\"
      printf '%s' '${encoded_key}' | decode_base64 > \"\$dst\"
      chmod 600 \"\$dst\" 2>/dev/null || true
    " >/dev/null 2>&1 || true
  fi

  set +e
  limactl shell "${VM_NAME}" -- env \
    HAPPIER_SERVER_URL="${server_url}" \
    ${guest_happier_home_rel:+WSREPL_QA_GUEST_HOME_REL="${guest_happier_home_rel}"} \
    ${guest_active_server_id:+HAPPIER_ACTIVE_SERVER_ID="${guest_active_server_id}"} \
    ${guest_server_routed_max_bytes:+HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES="${guest_server_routed_max_bytes}"} \
    ${guest_direct_peer_bind_port:+HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT="${guest_direct_peer_bind_port}"} \
    ${guest_direct_peer_advertised_hosts:+HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS="${guest_direct_peer_advertised_hosts}"} \
    ${guest_direct_peer_feature_enabled:+HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED="${guest_direct_peer_feature_enabled}"} \
    ${guest_direct_peer_server_enabled:+HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED="${guest_direct_peer_server_enabled}"} \
    bash -lc '
    set -euo pipefail
    if [[ -n "${WSREPL_QA_GUEST_HOME_REL:-}" ]]; then
      export HAPPIER_HOME_DIR="$HOME/${WSREPL_QA_GUEST_HOME_REL}"
    fi
    if [[ -z "${HAPPIER_CLAUDE_PATH:-}" && -f "$HOME/.happier/wsrepl-qa/fixtures/fake-claude-code-cli.js" ]]; then
      export HAPPIER_CLAUDE_PATH="$HOME/.happier/wsrepl-qa/fixtures/fake-claude-code-cli.js"
    fi
    HAPPY=""
    if [[ -x "$HOME/.happier/bin/happier" ]]; then
      HAPPY="$HOME/.happier/bin/happier"
    elif command -v happier >/dev/null 2>&1; then
      HAPPY="happier"
	    fi
	    if [[ -z "$HAPPY" ]]; then
	      echo "missing guest happier binary (expected $HOME/.happier/bin/happier or PATH happier)" >&2
	      exit 2
	    fi
	    "$HAPPY" daemon stop >/dev/null 2>&1 || true
	    set +e
	    HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
	    HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
	    "$HAPPY" daemon start 2>&1
	    start_status=$?
	    set -e
	    exit "$start_status"
	  ' >"${start_file}" 2>&1
	  local start_status=$?
	  set -e

	  limactl shell "${VM_NAME}" -- env \
      HAPPIER_SERVER_URL="${server_url}" \
      ${guest_happier_home_rel:+WSREPL_QA_GUEST_HOME_REL="${guest_happier_home_rel}"} \
      ${guest_active_server_id:+HAPPIER_ACTIVE_SERVER_ID="${guest_active_server_id}"} \
      bash -lc '
	    set -euo pipefail
      if [[ -n "${WSREPL_QA_GUEST_HOME_REL:-}" ]]; then
        export HAPPIER_HOME_DIR="$HOME/${WSREPL_QA_GUEST_HOME_REL}"
      fi
      if [[ -z "${HAPPIER_CLAUDE_PATH:-}" && -f "$HOME/.happier/wsrepl-qa/fixtures/fake-claude-code-cli.js" ]]; then
        export HAPPIER_CLAUDE_PATH="$HOME/.happier/wsrepl-qa/fixtures/fake-claude-code-cli.js"
      fi
	    HAPPY=""
    if [[ -x "$HOME/.happier/bin/happier" ]]; then
      HAPPY="$HOME/.happier/bin/happier"
    elif command -v happier >/dev/null 2>&1; then
      HAPPY="happier"
    fi
    if [[ -z "$HAPPY" ]]; then exit 0; fi
    "$HAPPY" daemon status 2>&1 || true
  ' >"${status_file}" 2>&1 || true

  limactl shell "${VM_NAME}" -- env \
    HAPPIER_SERVER_URL="${server_url}" \
    ${guest_happier_home_rel:+WSREPL_QA_GUEST_HOME_REL="${guest_happier_home_rel}"} \
    ${guest_active_server_id:+HAPPIER_ACTIVE_SERVER_ID="${guest_active_server_id}"} \
    bash -lc '
    set -euo pipefail
    if [[ -n "${WSREPL_QA_GUEST_HOME_REL:-}" ]]; then
      export HAPPIER_HOME_DIR="$HOME/${WSREPL_QA_GUEST_HOME_REL}"
    fi
    if [[ -z "${HAPPIER_CLAUDE_PATH:-}" && -f "$HOME/.happier/wsrepl-qa/fixtures/fake-claude-code-cli.js" ]]; then
      export HAPPIER_CLAUDE_PATH="$HOME/.happier/wsrepl-qa/fixtures/fake-claude-code-cli.js"
    fi
    HAPPY=""
    if [[ -x "$HOME/.happier/bin/happier" ]]; then
      HAPPY="$HOME/.happier/bin/happier"
    elif command -v happier >/dev/null 2>&1; then
      HAPPY="happier"
    fi
    if [[ -z "$HAPPY" ]]; then exit 0; fi
    "$HAPPY" daemon logs 2>&1 || true
  ' >"${log_path_file}" 2>&1 || true

	  local log_path
	  log_path="$(head -n 1 "${log_path_file}" 2>/dev/null | tr -d '\r' || true)"
	  if [[ -n "${log_path}" ]]; then
	    limactl shell "${VM_NAME}" -- bash -lc "set -euo pipefail; if [[ -f \"${log_path}\" ]]; then tail -n 400 \"${log_path}\"; else echo \"(no daemon log file found)\"; fi" \
	      > "${log_tail_file}" 2>&1 || true
	  else
	    printf "%s\n" "(no daemon log file found)" > "${log_tail_file}"
	  fi

	  poll_guest_machine_id_if_needed_best_effort() {
	    local machine_id
	    machine_id="$(extract_machine_id_from_daemon_status_file "${status_file}")"
	    if [[ -n "${machine_id}" ]]; then
	      return 0
	    fi

	    local retries
	    retries="$(read_wsrepl_machine_id_poll_retries)"
	    if [[ -z "${retries}" || "${retries}" -lt 1 ]]; then
	      return 0
	    fi

	    local delay_s
	    delay_s="$(read_wsrepl_machine_id_poll_delay_s)"
	    local attempt=0
	    while [[ "${attempt}" -lt "${retries}" ]]; do
	      attempt=$((attempt + 1))
	      sleep "${delay_s}"
	      limactl shell "${VM_NAME}" -- env \
	        HAPPIER_SERVER_URL="${server_url}" \
	        ${guest_happier_home_rel:+WSREPL_QA_GUEST_HOME_REL="${guest_happier_home_rel}"} \
	        ${guest_active_server_id:+HAPPIER_ACTIVE_SERVER_ID="${guest_active_server_id}"} \
	        bash -lc '
	        set -euo pipefail
	        if [[ -n "${WSREPL_QA_GUEST_HOME_REL:-}" ]]; then
	          export HAPPIER_HOME_DIR="$HOME/${WSREPL_QA_GUEST_HOME_REL}"
	        fi
	        HAPPY=""
	        if [[ -x "$HOME/.happier/bin/happier" ]]; then
	          HAPPY="$HOME/.happier/bin/happier"
	        elif command -v happier >/dev/null 2>&1; then
	          HAPPY="happier"
	        fi
	        if [[ -z "$HAPPY" ]]; then exit 0; fi
	        "$HAPPY" daemon status 2>&1 || true
	      ' >"${status_file}" 2>&1 || true
	      machine_id="$(extract_machine_id_from_daemon_status_file "${status_file}")"
	      if [[ -n "${machine_id}" ]]; then
	        return 0
	      fi
	    done
	    return 0
	  }

	  # `happier daemon status` is a doctor-style command and may exit 0 even when the daemon
	  # isn't running. Detect health from the rendered output we captured above.
	  if ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null; then
	    if [[ -z "${WSREPL_QA_VM_MACHINE_ID:-}" && "${WSREPL_QA_DERIVE_STEPS_LATER:-0}" == "1" ]]; then
	      poll_guest_machine_id_if_needed_best_effort
	    fi
	    return 0
	  fi

      # Guest daemon can be waiting for credentials (same as host). That is non-fatal for the
      # harness, but the matrix itself requires the daemon to actually come online.
      if grep -qi "Waiting for credentials" "${log_tail_file}" 2>/dev/null; then
        if ! seed_guest_daemon_access_key_if_possible "${log_tail_file}"; then
          FAILURE_STAGE="guest_daemon"
          FAILURE_REASON="guest_daemon_waiting_for_credentials"
          echo "[wsrepl-qa] guest daemon is waiting for credentials and could not be seeded automatically; see ${log_tail_file}" >&2
          return 1
        fi

        # Retry once after seeding, and require status to be healthy so the matrix does not hang.
        limactl shell "${VM_NAME}" -- env HAPPIER_SERVER_URL="${server_url}" bash -lc '
          set -euo pipefail
          HAPPY=""
          if [[ -x "$HOME/.happier/bin/happier" ]]; then
            HAPPY="$HOME/.happier/bin/happier"
          elif command -v happier >/dev/null 2>&1; then
            HAPPY="happier"
          fi
          if [[ -z "$HAPPY" ]]; then exit 2; fi
          "$HAPPY" daemon start >/dev/null 2>&1 || true
          "$HAPPY" daemon status 2>&1 || true
        ' >"${status_file}" 2>&1 || true

        if ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null; then
          return 0
        fi

        FAILURE_STAGE="guest_daemon"
        FAILURE_REASON="guest_daemon_start_failed"
        echo "[wsrepl-qa] guest daemon did not become healthy after seeding credentials; see ${status_file}" >&2
        return 1
      fi

      FAILURE_STAGE="guest_daemon"
      FAILURE_REASON="guest_daemon_start_failed"
      if [[ "${start_status}" != "0" ]]; then
        echo "[wsrepl-qa] failed to start guest daemon (exit=${start_status}); see ${start_file}" >&2
      else
        echo "[wsrepl-qa] guest daemon did not become healthy; see ${status_file}" >&2
      fi
      return 1
	}

ensure_guest_provider_cli_installed() {
  local provider_id="$1"
  local out_file="$2"

  if [[ "${WSREPL_QA_SKIP_GUEST_PROVIDER_INSTALL:-0}" == "1" ]]; then
    return 0
  fi

  if [[ -z "${provider_id}" ]]; then
    return 0
  fi

  # If the guest does not have Happier installed, keep this best-effort and let the matrix fail
  # on its own (common in local harness tests with WSREPL_QA_VM_HAPPIER_MODE=skip).
  if ! limactl shell "${VM_NAME}" -- bash -lc '[[ -x "$HOME/.happier/bin/happier" ]] || command -v happier >/dev/null 2>&1' >/dev/null 2>&1; then
    printf "%s\n" "(guest happier not found; skipping provider install)" > "${out_file}"
    return 0
  fi

  set +e
  limactl shell "${VM_NAME}" -- bash -lc '
    set -euo pipefail
    HAPPY=""
    if [[ -x "$HOME/.happier/bin/happier" ]]; then
      HAPPY="$HOME/.happier/bin/happier"
    elif command -v happier >/dev/null 2>&1; then
      HAPPY="happier"
    fi
    if [[ -z "$HAPPY" ]]; then
      echo "missing guest happier binary (expected $HOME/.happier/bin/happier or PATH happier)" >&2
      exit 2
    fi
    "$HAPPY" install provider "'"${provider_id}"'" 2>&1
  ' > "${out_file}" 2>&1
  local status=$?
  set -e

  if [[ "${status}" != "0" ]]; then
    FAILURE_STAGE="guest_provider_install"
    FAILURE_REASON="guest_provider_install_failed"
    echo "[wsrepl-qa] failed to install guest provider ${provider_id}; see ${out_file}" >&2
    return 1
  fi
  return 0
}

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
target_machine_name_patterns = []
try:
  parsed_steps = json.loads(steps_json) if steps_json else None
  if isinstance(parsed_steps, list):
    for step in parsed_steps:
      if isinstance(step, dict):
        value = step.get("targetMachineId")
        if isinstance(value, str) and value.strip():
          target_machine_ids.append(value.strip())
        pattern = step.get("targetMachineNamePattern")
        if isinstance(pattern, str) and pattern.strip():
          target_machine_name_patterns.append(pattern.strip())
except Exception:
  pass

meta_session_id = None
meta_session_path = None
try:
  meta_path = Path(playwright_outdir) / "meta.json"
  if meta_path.exists():
    meta_payload = json.loads(meta_path.read_text(encoding="utf-8"))
    if isinstance(meta_payload, dict):
      raw_session_id = meta_payload.get("sessionId")
      if isinstance(raw_session_id, str) and raw_session_id.strip():
        meta_session_id = raw_session_id.strip()
      raw_session_path = meta_payload.get("sessionPath")
      if isinstance(raw_session_path, str) and raw_session_path.strip():
        meta_session_path = raw_session_path.strip()
except Exception:
  meta_session_id = None
  meta_session_path = None

fatal_message = None
try:
  fatal_path = Path(playwright_outdir) / "fatal.json"
  if fatal_path.exists():
    fatal_payload = json.loads(fatal_path.read_text(encoding="utf-8"))
    if isinstance(fatal_payload, dict):
      # Keep wrapper in sync with playwright-session-handoff-wsrepl-matrix.mjs fatal.json schema:
      # it writes "error" (not "errorMessage") plus an optional "uiHint".
      raw_ui_hint = fatal_payload.get("uiHint")
      raw_error = fatal_payload.get("error") or fatal_payload.get("errorMessage")
      msg = raw_ui_hint if isinstance(raw_ui_hint, str) and raw_ui_hint.strip() else raw_error
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

resolved_session_id = (session_id or "").strip() or meta_session_id
resolved_session_path = (session_path or "").strip() or meta_session_path
payload = {
  "kind": "wsrepl_lima_matrix_wrapper",
  "vmName": vm_name,
  "reportRoot": report_root,
  "playwrightOutDir": playwright_outdir,
  "startedAt": started_at,
  "endedAt": ended_at,
  "status": status_int,
  "sessionId": resolved_session_id or None,
  "sessionPath": resolved_session_path or None,
  "stepsJson": steps_json or None,
  "parameters": {
    "hostMachineId": (host_machine_id or "").strip() or None,
    "vmMachineId": (vm_machine_id or "").strip() or None,
    "sourceMachineId": (source_machine_id or "").strip() or None,
    "targetMachineIds": target_machine_ids,
    "targetMachineNamePatterns": target_machine_name_patterns,
  },
  "failureStage": resolved_failure_stage,
  "failureReason": resolved_failure_reason,
	  "logs": {
	    "ensureVmLog": f"{report_root}/ensure-vm.log",
	    "hostDiag": f"{report_root}/host.diag.txt",
	    "guestDiag": f"{report_root}/guest.diag.txt",
	    "limaList": f"{report_root}/lima.list.txt",
	    "limaInfo": f"{report_root}/lima.info.txt",
	    "hostDaemonStart": f"{report_root}/daemon/host.daemon.start.txt",
	    "hostDaemonStatus": f"{report_root}/daemon/host.daemon.status.txt",
	    "hostDaemonLogPath": f"{report_root}/daemon/host.daemon.log.path.txt",
	    "hostDaemonLogTail": f"{report_root}/daemon/host.daemon.log.tail.txt",
	    "hostDaemonScope": f"{report_root}/daemon/host.daemon.scope.json",
	    "guestDaemonStart": f"{report_root}/daemon/guest.daemon.start.txt",
	    "guestDaemonStatus": f"{report_root}/daemon/guest.daemon.status.txt",
	    "guestDaemonLogPath": f"{report_root}/daemon/guest.daemon.log.path.txt",
	    "guestDaemonLogTail": f"{report_root}/daemon/guest.daemon.log.tail.txt",
	    "playwrightRunnerLog": f"{playwright_outdir}/runner.log",
	    "playwrightMeta": f"{playwright_outdir}/meta.json",
	  },
	}
print(json.dumps(payload))
PY
)"
  write_json_file "${REPORT_ROOT}/summary.json" "${payload}"
}

resolve_playwright_session_id_best_effort() {
  python3 - "$PLAYWRIGHT_OUTDIR" "${HAPPIER_QA_SESSION_ID:-}" <<'PY'
import json
import sys
from pathlib import Path

playwright_outdir = Path(sys.argv[1])
explicit = (sys.argv[2] or "").strip()
if explicit:
  print(explicit)
  raise SystemExit(0)

meta_path = playwright_outdir / "meta.json"
if not meta_path.exists():
  print("")
  raise SystemExit(0)

try:
  payload = json.loads(meta_path.read_text(encoding="utf-8"))
except Exception:
  print("")
  raise SystemExit(0)

raw = payload.get("sessionId") if isinstance(payload, dict) else None
if isinstance(raw, str) and raw.strip():
  print(raw.strip())
else:
  print("")
PY
}

resolve_final_status() {
  local status="$1"
  RESOLVED_FINAL_STATUS="${status}"
  if [[ "${status}" == "126" || "${status}" == "127" ]]; then
    if [[ -z "${FAILURE_STAGE}" ]]; then
      FAILURE_STAGE="early_abort"
    fi
    if [[ -z "${FAILURE_REASON}" ]]; then
      if [[ "${status}" == "127" ]]; then
        FAILURE_REASON="command_not_found"
      else
        FAILURE_REASON="command_invocation_failed"
      fi
    fi
    return 0
  fi

  # Some Playwright runs can write a fully green summary (ok:true + steps) but still exit nonzero
  # due to cleanup/interrupt noise. Prefer the harness summary as the source of truth so the
  # wrapper doesn't report a false-negative failure.
  if [[ "${status}" != "0" ]]; then
    if playwright_attempt_wrote_success_summary "${PLAYWRIGHT_OUTDIR}"; then
      RESOLVED_FINAL_STATUS="0"
      FAILURE_STAGE=""
      FAILURE_REASON=""
      return 0
    fi
  fi

  local resolved_session_id
  resolved_session_id="$(resolve_playwright_session_id_best_effort || true)"
  resolved_session_id="$(printf "%s" "${resolved_session_id}" | tr -d '\n' | tr -d '\r')"

  if [[ -z "${resolved_session_id}" ]]; then
    FAILURE_STAGE="${FAILURE_STAGE:-playwright}"
    if [[ -z "${FAILURE_REASON}" && -f "${PLAYWRIGHT_OUTDIR}/fatal.json" ]]; then
      FAILURE_REASON="playwright_fatal_json"
    else
      FAILURE_REASON="${FAILURE_REASON:-missing_session_id}"
    fi
    RESOLVED_FINAL_STATUS="1"
    return 0
  fi

  RESOLVED_FINAL_STATUS="${status}"
  return 0
}

RESOLVED_FINAL_STATUS=""
trap 'status=$?; resolve_final_status "${status}"; final_status="${RESOLVED_FINAL_STATUS:-${status}}"; stop_host_daemon_watchdog_background || true; refresh_post_playwright_diagnostics_best_effort || true; ensure_summary "${final_status}"; exit "${final_status}"' EXIT

terminate_due_to_signal() {
  local exit_code="${1:-143}"
  local signal_name="${2:-term}"
  # Ensure the wrapper records a nonzero summary status when interrupted, instead of
  # accidentally reporting success based on the last successful command.
  FAILURE_STAGE="terminated"
  FAILURE_REASON="signal_${signal_name}"

  # Best-effort: stop any background jobs (watchdogs, etc.) so we don't leak processes.
  local bg_pids
  bg_pids="$(jobs -pr 2>/dev/null || true)"
  if [[ -n "${bg_pids}" ]]; then
    kill ${bg_pids} >/dev/null 2>&1 || true
    wait ${bg_pids} >/dev/null 2>&1 || true
  fi

  exit "${exit_code}"
}

trap 'terminate_due_to_signal 143 term' TERM
trap 'terminate_due_to_signal 130 int' INT

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
  # Set WSREPL_QA_FORCE_VM_RECONFIGURE=1 to force the full stop/reconfigure/start path via lima-vm.sh.
  if [[ -n "${force_reconfigure}" && "${force_reconfigure}" != "0" ]]; then
    FAILURE_STAGE="ensure_vm"
    echo "[wsrepl-qa] ensure VM (forced reconfigure via lima-vm.sh)..."
    "${LIMA_VM_SCRIPT}" "${VM_NAME}"
    return 0
  fi

  if [[ ! -f "${LIMA_YAML}" ]]; then
    FAILURE_STAGE="ensure_vm"
    echo "[wsrepl-qa] ensure VM (create/configure via lima-vm.sh; no existing lima.yaml)..."
    "${LIMA_VM_SCRIPT}" "${VM_NAME}"
    return 0
  fi

  if ! grep -q "# --- happier port forwards (managed) ---" "${LIMA_YAML}" 2>/dev/null; then
    FAILURE_STAGE="ensure_vm"
    echo "[wsrepl-qa] ensure VM (configure port forwarding via lima-vm.sh; missing managed markers)..."
    "${LIMA_VM_SCRIPT}" "${VM_NAME}"
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

resolve_wsrepl_vm_direct_peer_bind_port() {
  local raw_bind_port="${WSREPL_QA_VM_DIRECT_PEER_BIND_PORT:-}"
  if [[ -z "${raw_bind_port}" ]]; then
    raw_bind_port="${WSREPL_QA_VM_DIRECT_PEER_BIND_PORT_DEFAULT:-13377}"
  fi

  if [[ ! "${raw_bind_port}" =~ ^[0-9]+$ ]] || [[ "${raw_bind_port}" -lt 1 ]] || [[ "${raw_bind_port}" -gt 65535 ]]; then
    FAILURE_STAGE="ensure_vm"
    FAILURE_REASON="invalid_vm_direct_peer_bind_port"
    echo "[wsrepl-qa] invalid WSREPL_QA_VM_DIRECT_PEER_BIND_PORT(_DEFAULT): ${raw_bind_port} (expected 1-65535)" >&2
    return 1
  fi

  echo "${raw_bind_port}"
  return 0
}

resolve_wsrepl_vm_index() {
  local vm_name="${1:-${VM_NAME}}"
  local index=0
  local candidate=""
  for candidate in "${VM_NAMES[@]}"; do
    if [[ "${candidate}" == "${vm_name}" ]]; then
      echo "${index}"
      return 0
    fi
    index=$((index + 1))
  done
  echo "0"
  return 0
}

resolve_wsrepl_vm_direct_peer_bind_port_for_vm() {
  local vm_name="${1:-${VM_NAME}}"
  local base_bind_port=""
  base_bind_port="$(resolve_wsrepl_vm_direct_peer_bind_port)"
  if [[ -z "${base_bind_port}" ]]; then
    return 0
  fi
  if [[ "${#VM_NAMES[@]}" -le 1 ]]; then
    echo "${base_bind_port}"
    return 0
  fi

  local host_bind_port=""
  host_bind_port="$(resolve_wsrepl_host_direct_peer_bind_port)"
  local vm_index=""
  vm_index="$(resolve_wsrepl_vm_index "${vm_name}")"

  local candidate="${base_bind_port}"
  local current_index=0
  while true; do
    if [[ "${candidate}" == "${host_bind_port}" ]]; then
      candidate=$((candidate + 1))
      continue
    fi
    if [[ "${current_index}" == "${vm_index}" ]]; then
      echo "${candidate}"
      return 0
    fi
    current_index=$((current_index + 1))
    candidate=$((candidate + 1))
  done
}

resolve_wsrepl_vm_direct_peer_advertised_hosts() {
  local configured_hosts="${WSREPL_QA_VM_DIRECT_PEER_ADVERTISED_HOSTS:-}"
  if [[ -n "${configured_hosts}" ]]; then
    echo "${configured_hosts}"
    return 0
  fi
  if [[ "${#VM_NAMES[@]}" -gt 1 ]]; then
    echo "127.0.0.1,host.lima.internal"
    return 0
  fi
  echo "127.0.0.1"
  return 0
}

wsrepl_is_tcp_port_listening() {
  local port="${1:-}"
  if [[ -z "${port}" ]]; then
    return 1
  fi

  local lsof_path=""
  local system_lsof_path=""
  local path_entry=""
  local candidate_path=""
  local old_ifs="${IFS}"
  IFS=':'
  for path_entry in ${PATH:-}; do
    if [[ -z "${path_entry}" ]]; then
      continue
    fi
    candidate_path="${path_entry}/lsof"
    if [[ ! -x "${candidate_path}" ]]; then
      continue
    fi
    case "${candidate_path}" in
      /usr/sbin/lsof|/bin/lsof)
        if [[ -z "${system_lsof_path}" ]]; then
          system_lsof_path="${candidate_path}"
        fi
        ;;
      *)
        lsof_path="${candidate_path}"
        break
        ;;
    esac
  done
  IFS="${old_ifs}"

  if [[ -z "${lsof_path}" ]]; then
    if [[ -n "${system_lsof_path}" ]]; then
      lsof_path="${system_lsof_path}"
    elif [[ -x /usr/sbin/lsof ]]; then
      lsof_path="/usr/sbin/lsof"
    elif [[ -x /bin/lsof ]]; then
      lsof_path="/bin/lsof"
    fi
  fi

  if [[ -n "${lsof_path}" ]]; then
    if "${lsof_path}" -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v nc >/dev/null 2>&1; then
    if nc -z -w 1 127.0.0.1 "${port}" >/dev/null 2>&1; then
      return 0
    fi
    if nc -z -w 1 host.lima.internal "${port}" >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "${port}" <<'PY' >/dev/null 2>&1
import socket
import sys

port = int(sys.argv[1])
for host in ("127.0.0.1", "host.lima.internal"):
  try:
    with socket.create_connection((host, port), timeout=1):
      raise SystemExit(0)
  except Exception:
    pass
raise SystemExit(1)
PY
    return $?
  fi

  # Fail closed when we cannot verify availability.
  return 1
}

resolve_wsrepl_host_direct_peer_bind_port() {
  local raw_bind_port="${WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT:-}"
  if [[ -z "${raw_bind_port}" ]]; then
    raw_bind_port="${WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT_DEFAULT:-13378}"
  fi

  if [[ ! "${raw_bind_port}" =~ ^[0-9]+$ ]] || [[ "${raw_bind_port}" -lt 1 ]] || [[ "${raw_bind_port}" -gt 65535 ]]; then
    FAILURE_STAGE="host_daemon"
    FAILURE_REASON="invalid_host_direct_peer_bind_port"
    echo "[wsrepl-qa] invalid WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT(_DEFAULT): ${raw_bind_port} (expected 1-65535)" >&2
    return 1
  fi

  local candidate_port="${raw_bind_port}"
  local attempt=0
  local max_attempts="${WSREPL_QA_HOST_DIRECT_PEER_BIND_PORT_SCAN_LIMIT:-64}"
  if [[ ! "${max_attempts}" =~ ^[0-9]+$ ]] || [[ "${max_attempts}" -lt 1 ]]; then
    max_attempts=64
  fi

  while [[ "${attempt}" -lt "${max_attempts}" ]]; do
    if ! wsrepl_is_tcp_port_listening "${candidate_port}"; then
      echo "${candidate_port}"
      return 0
    fi

    local next_candidate_port="$((candidate_port + 1))"
    echo "[wsrepl-qa] host direct-peer bind port ${candidate_port} is already in use; trying ${next_candidate_port}" >&2
    candidate_port="${next_candidate_port}"
    if [[ "${candidate_port}" -gt 65535 ]]; then
      break
    fi
    attempt="$((attempt + 1))"
  done

  FAILURE_STAGE="host_daemon"
  FAILURE_REASON="host_direct_peer_bind_port_unavailable"
  echo "[wsrepl-qa] unable to find a free host direct-peer bind port starting from ${raw_bind_port} after ${max_attempts} attempts" >&2
  return 1
}

ensure_vm_direct_peer_port_forwarding() {
  local direct_peer_bind_port="${1:-}"
  if [[ -z "${direct_peer_bind_port}" ]]; then
    return 0
  fi

  local direct_peer_advertised_hosts="${WSREPL_QA_VM_DIRECT_PEER_ADVERTISED_HOSTS:-}"
  if [[ -z "${direct_peer_advertised_hosts}" ]]; then
    direct_peer_advertised_hosts="127.0.0.1"
  fi

  local update_output=""
  update_output="$(
    python3 - "${LIMA_YAML}" "${direct_peer_bind_port}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
port = int(sys.argv[2])

begin = "  # --- wsrepl direct peer port forward (managed) ---"
end = "  # --- /wsrepl direct peer port forward ---"
entry = (
    f"{begin}\n"
    f"  - guestPortRange: [{port}, {port}]\n"
    f"    hostPortRange:  [{port}, {port}]\n"
    f"{end}\n"
)

text = path.read_text(encoding="utf-8")
pattern = re.compile(
    r"(?ms)^  # --- wsrepl direct peer port forward \(managed\) ---\n"
    r"  - guestPortRange: \[[0-9]+, [0-9]+\]\n"
    r"    hostPortRange:  \[[0-9]+, [0-9]+\]\n"
    r"  # --- /wsrepl direct peer port forward ---\n?"
)
if pattern.search(text):
    updated = pattern.sub(entry, text, count=1)
elif "# --- /happier port forwards ---" in text:
    updated = text.replace("# --- /happier port forwards ---", f"{entry}# --- /happier port forwards ---", 1)
else:
    updated = text.rstrip() + "\n" + entry

if updated != text:
    path.write_text(updated, encoding="utf-8")
    print("updated")
PY
  )"

  if [[ "${update_output}" == *"updated"* ]]; then
    echo "[wsrepl-qa] ensure VM: applying direct-peer port forward ${direct_peer_bind_port} via Lima..."
    limactl stop "${VM_NAME}" >/dev/null 2>&1 || true
    limactl start "${VM_NAME}" >/dev/null 2>&1
    if ! wait_for_vm_shell 90 1; then
      FAILURE_STAGE="ensure_vm"
      FAILURE_REASON="vm_shell_unreachable"
      echo "[wsrepl-qa] failed to reach VM shell after reconfiguring direct-peer port forward: ${VM_NAME}" >&2
      return 1
    fi
  fi

  return 0
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
  limactl shell "${VM_NAME}" -- bash -lc 'if [[ -x "$HOME/.happier/bin/happier" ]]; then "$HOME/.happier/bin/happier" --version; elif command -v happier >/dev/null 2>&1; then happier --version; fi' \
    2>/dev/null | head -n 1 | tr -d '\r' || true
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
  local expected_cli_version="${1:-}"
  local expected_git_rev="${2:-}"

  local bun_target
  bun_target="$(resolve_vm_bun_target)"
  if [[ -z "${bun_target}" ]]; then
    echo "[wsrepl-qa] failed to resolve VM bun target (set WSREPL_QA_VM_BUN_TARGET=...)" >&2
    return 2
  fi

  local payload_root="${REPORT_ROOT}/vm-happier"
  local payload_dir="${payload_root}/payload.tmp"
  local build_log="${payload_root}/build.log"
  rm -rf "${payload_root}" 2>/dev/null || true
  mkdir -p "${payload_root}"

  echo "[wsrepl-qa] building VM Happier artifact from worktree (bunTarget=${bun_target})..."
  # Run the payload builder from the repo root so `node -` ESM resolution is stable (it otherwise
  # resolves relative to the current working directory, which can be a temp dir or `apps/stack`).
  if ! (
    cd "${REPO_DIR}"
    WSREPL_QA_VM_HAPPIER_PAYLOAD_DIR="${payload_dir}" \
      node --input-type=module - "${REPO_DIR}" "${payload_dir}" "${bun_target}" <<'NODE'
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
  ) 2>&1 | tee "${build_log}"
  then
    echo "[wsrepl-qa] failed to build VM Happier artifact from worktree; see ${build_log}" >&2
    return 2
  fi

  # Write a build marker into the payload so `require` mode can compare against the worktree identity
  # that was frozen at the start of this wrapper run (avoid HEAD drift during long builds).
  write_wsrepl_build_marker_files "${payload_dir}" "${expected_cli_version}" "${expected_git_rev}"

  echo "[wsrepl-qa] installing VM Happier artifact..."
  local guest_home
  guest_home="$(limactl shell "${VM_NAME}" -- bash -lc 'printf "%s" "$HOME"' 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "${guest_home}" ]]; then
    echo "[wsrepl-qa] failed to resolve guest $HOME for ${VM_NAME}" >&2
    return 2
  fi

  # `limactl copy --recursive` uses an scp backend that can fail to create nested directories
  # reliably on some hosts/guests. Ship a single tarball and extract it in the guest to ensure
  # directory creation is deterministic.
  local payload_tar="${payload_root}/payload.tar"
  rm -f "${payload_tar}" 2>/dev/null || true
  python3 "${PAYLOAD_TAR_HELPER}" "${payload_dir}" "${payload_tar}"

  limactl shell "${VM_NAME}" -- bash -lc 'set -euo pipefail;
    mkdir -p "$HOME/.happier/wsrepl-dev"
    rm -rf "$HOME/.happier/wsrepl-dev/payload.tmp"
    rm -f "$HOME/.happier/wsrepl-dev/payload.tar"
  '

  limactl copy --backend=scp "${payload_tar}" "${VM_NAME}:${guest_home}/.happier/wsrepl-dev/payload.tar"

  limactl shell "${VM_NAME}" -- bash -lc 'set -euo pipefail;
    mkdir -p "$HOME/.happier/wsrepl-dev/payload.tmp"
    tar -xf "$HOME/.happier/wsrepl-dev/payload.tar" -C "$HOME/.happier/wsrepl-dev/payload.tmp"
    rm -f "$HOME/.happier/wsrepl-dev/payload.tar"
  '

  limactl shell "${VM_NAME}" -- bash -lc 'set -euo pipefail;
    export PATH="$HOME/.happier/bin:$PATH"

    # Stop any existing daemon before swapping binaries. Some Lima images can end up with multiple
    # daemon processes (PATH + ~/.happier/bin) which causes mismatched transfer-id contracts.
    if [[ -d "$HOME/.happier/servers" ]]; then
      python3 - "$HOME" <<'"'"'PY'"'"' || true
import json
import os
import signal
from pathlib import Path

home = os.environ.get("HOME") or ""
servers = Path(home) / ".happier" / "servers"
for state_path in sorted(servers.glob("*/daemon.state.json")):
  try:
    payload = json.loads(state_path.read_text(encoding="utf-8"))
  except Exception:
    continue
  pid = payload.get("pid")
  if isinstance(pid, int) and pid > 0:
    try:
      os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
      continue
    except Exception:
      continue
PY
    fi
    if [[ -x "$HOME/.happier/bin/happier" ]]; then
      if command -v timeout >/dev/null 2>&1; then
        timeout 5s "$HOME/.happier/bin/happier" daemon stop >/dev/null 2>&1 || true
      else
        "$HOME/.happier/bin/happier" daemon stop >/dev/null 2>&1 || true
      fi
    fi
    if command -v happier >/dev/null 2>&1; then
      if command -v timeout >/dev/null 2>&1; then
        timeout 5s happier daemon stop >/dev/null 2>&1 || true
      else
        happier daemon stop >/dev/null 2>&1 || true
      fi
    fi
    # Best-effort hard stop: ensure no stale worker keeps running with the old binary.
    if command -v pkill >/dev/null 2>&1; then
      # Avoid killing this shell (its argv contains the pattern). Use a regex trick (`happie[r]`)
      # so the pattern matches "happier" in the target process but not itself.
      pkill -f "/\\.happier/bin/happie[r] daemon start-sync" >/dev/null 2>&1 || true
      pkill -f "package-dist/index\\.mjs daemon start-syn[c]" >/dev/null 2>&1 || true
    fi

    mkdir -p "$HOME/.happier/bin"
    if [[ -d "$HOME/.happier/wsrepl-dev/payload.tmp" ]]; then
      if [[ -d "$HOME/.happier/wsrepl-dev/payload" ]]; then
        mv "$HOME/.happier/wsrepl-dev/payload" "$HOME/.happier/wsrepl-dev/payload.wsrepl-backup.$(date +%Y%m%d-%H%M%S)" || true
      fi
      mv "$HOME/.happier/wsrepl-dev/payload.tmp" "$HOME/.happier/wsrepl-dev/payload"
    fi
    if [[ ! -x "$HOME/.happier/wsrepl-dev/payload/happier" ]]; then
      echo "[wsrepl-qa] guest payload install failed (missing payload/happier)" >&2
      exit 2
    fi
    if [[ -e "$HOME/.happier/bin/happier" && ! -L "$HOME/.happier/bin/happier" ]]; then
      mv "$HOME/.happier/bin/happier" "$HOME/.happier/bin/happier.wsrepl-backup.$(date +%Y%m%d-%H%M%S)" || true
    fi
    ln -sf "$HOME/.happier/wsrepl-dev/payload/happier" "$HOME/.happier/bin/happier"

    "$HOME/.happier/bin/happier" daemon start >/dev/null 2>&1 || true
    # `daemon start` can legitimately fail or remain unhealthy while the daemon is waiting for
    # credentials (Playwright injects auth later in this harness). Do a short best-effort poll to
    # catch obvious "daemon is up" cases, but never fail autoupdate solely on daemon health.
    set +e
    for attempt in {1..20}; do
      status_out="$("$HOME/.happier/bin/happier" daemon status 2>&1)"
      status_code=$?
      if [[ "$status_code" == "0" ]]; then
        exit 0
      fi
      if echo "$status_out" | grep -qi "Waiting for credentials"; then
        exit 0
      fi
      sleep 0.25
    done
    set -e
    echo "[wsrepl-qa] guest daemon status not healthy after autoupdate (non-fatal; likely waiting for credentials)" >&2
    exit 0
  '
}

resolve_guest_wsrepl_build_marker_git_rev() {
  limactl shell "${VM_NAME}" -- bash -lc 'cat "$HOME/.happier/wsrepl-dev/payload/wsrepl-build.gitrev" 2>/dev/null || true' \
    2>/dev/null | head -n 1 | tr -d '\r' || true
}

resolve_guest_wsrepl_build_marker_cli_version() {
  limactl shell "${VM_NAME}" -- bash -lc 'cat "$HOME/.happier/wsrepl-dev/payload/wsrepl-build.version" 2>/dev/null || true' \
    2>/dev/null | head -n 1 | tr -d '\r' || true
}

ensure_current_vm_happier_matches_worktree() {
  local expected_version="${1:-}"
  local expected_git_rev="${2:-}"
  local guest_marker_git_rev=""
  local guest_marker_version=""
  local guest_version=""

  if [[ "${WSREPL_QA_VM_HAPPIER_MODE}" == "autoupdate" ]]; then
    if ! autoupdate_guest_happier_from_worktree "${expected_version}" "${expected_git_rev}"; then
      echo "[wsrepl-qa] guest autoupdate failed" >&2
      return 2
    fi
    guest_marker_git_rev="$(resolve_guest_wsrepl_build_marker_git_rev)"
    guest_marker_version="$(resolve_guest_wsrepl_build_marker_cli_version)"
  else
    guest_marker_git_rev="$(resolve_guest_wsrepl_build_marker_git_rev)"
    guest_marker_version="$(resolve_guest_wsrepl_build_marker_cli_version)"
    guest_version="$(resolve_guest_happier_version)"
  fi

  if [[ -n "${expected_git_rev}" ]]; then
    if [[ -z "${guest_marker_git_rev}" ]]; then
      echo "[wsrepl-qa] guest wsrepl build marker is missing, but the worktree git rev is available (mode=${WSREPL_QA_VM_HAPPIER_MODE})." >&2
      echo "[wsrepl-qa] expected git rev: ${expected_git_rev}" >&2
      echo "[wsrepl-qa] expected marker path: \$HOME/.happier/wsrepl-dev/payload/wsrepl-build.json" >&2
      echo "[wsrepl-qa] Fix: rerun with WSREPL_QA_VM_HAPPIER_MODE=autoupdate (installs a matching build marker), or set WSREPL_QA_VM_HAPPIER_MODE=skip to bypass this guard." >&2
      return 2
    fi
    if [[ "${guest_marker_git_rev}" != "${expected_git_rev}" ]]; then
      echo "[wsrepl-qa] guest wsrepl build marker does not match the current worktree (mode=${WSREPL_QA_VM_HAPPIER_MODE})." >&2
      echo "[wsrepl-qa] expected git rev: ${expected_git_rev}" >&2
      echo "[wsrepl-qa] guest git rev:    ${guest_marker_git_rev}" >&2
      echo "[wsrepl-qa] Fix: rerun with WSREPL_QA_VM_HAPPIER_MODE=autoupdate, or set WSREPL_QA_VM_HAPPIER_MODE=skip to bypass this guard." >&2
      return 2
    fi
    if [[ -n "${guest_marker_version}" && "${guest_marker_version}" != "${expected_version}" ]]; then
      echo "[wsrepl-qa] guest wsrepl build marker version does not match the worktree version." >&2
      echo "[wsrepl-qa] expected version: ${expected_version}" >&2
      echo "[wsrepl-qa] guest version:    ${guest_marker_version}" >&2
      return 2
    fi
  else
    if [[ -z "${guest_version}" ]]; then
      echo "[wsrepl-qa] failed to resolve guest Happier version; ensure happier is installed in the VM and reachable from PATH" >&2
      return 2
    fi
    if [[ "${guest_version}" != "${expected_version}" ]]; then
      echo "[wsrepl-qa] guest Happier CLI version does not match the current worktree (mode=${WSREPL_QA_VM_HAPPIER_MODE})." >&2
      echo "[wsrepl-qa] expected: ${expected_version}" >&2
      echo "[wsrepl-qa] guest:    ${guest_version}" >&2
      echo "[wsrepl-qa] Fix: update the VM's Happier install to the same commit/build, rerun with WSREPL_QA_VM_HAPPIER_MODE=autoupdate, or set WSREPL_QA_VM_HAPPIER_MODE=skip to bypass this guard." >&2
      return 2
    fi
  fi

  return 0
}

if [[ -z "${HAPPIER_QA_SESSION_PATH:-}" && -n "${WSREPL_QA_LARGE_REPO_PATH:-}" ]]; then
  export HAPPIER_QA_SESSION_PATH="${WSREPL_QA_LARGE_REPO_PATH}"
fi

# Prefer the canonical large-repo fixture when available so “unset session path” runs
# still exercise the intended large-repo handoff matrix (but keep the repo fallback
# for dev/smoke runs when the fixture is not present).
if [[ -z "${HAPPIER_QA_SESSION_PATH:-}" && -z "${WSREPL_QA_LARGE_REPO_PATH:-}" ]]; then
  # Prefer a non-hidden fixture location when present. Lima guests mount the macOS home directory,
  # but cannot reliably traverse host `chmod 700` parents like `.happier` due to UID/GID/perms
  # mapping, which can surface as ENOENT during target staging.
  SAFE_WSREPL_QA_LARGE_REPO_PATH="${HOME}/wsrepl-qa-fixtures/large-repo-k8s"
  LEGACY_WSREPL_QA_LARGE_REPO_PATH="${HOME}/.happier/wsrepl-qa-fixtures/large-repo-k8s"
  if [[ -d "${SAFE_WSREPL_QA_LARGE_REPO_PATH}" ]]; then
    export HAPPIER_QA_SESSION_PATH="${SAFE_WSREPL_QA_LARGE_REPO_PATH}"
  elif [[ -d "${LEGACY_WSREPL_QA_LARGE_REPO_PATH}" ]]; then
    export HAPPIER_QA_SESSION_PATH="${LEGACY_WSREPL_QA_LARGE_REPO_PATH}"
  fi
fi

# Default session path to the repo worktree so the Playwright harness never falls back to its
# own hardcoded default (keeps wrapper summary + runner behavior aligned).
if [[ -z "${HAPPIER_QA_SESSION_PATH:-}" ]]; then
  export HAPPIER_QA_SESSION_PATH="${REPO_DIR}"
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

# Default to creating a fresh QA session unless the caller pins a specific sessionId.
if [[ -z "${HAPPIER_QA_SESSION_ID:-}" && -z "${HAPPIER_QA_CREATE_SESSION:-}" ]]; then
  export HAPPIER_QA_CREATE_SESSION="1"
fi

  # Default the matrix to a deterministic engine choice (and allow override).
  #
  # IMPORTANT: keep the wrapper default aligned with the Playwright harness default to avoid
  # “hidden claude” drift where the wrapper silently forces `claude` even when the stack/UI
  # hides/disables it.
  if [[ -z "${HAPPIER_QA_PREFERRED_AGENT_ENGINES:-}" ]]; then
    # Default to the fake Claude CLI fixture for stable, non-authenticated session creation in QA.
    # `codex` can require real provider auth and otherwise fail silently at session creation time,
    # which would prevent the matrix from exercising workspace replication at all.
    export HAPPIER_QA_PREFERRED_AGENT_ENGINES="claude"
  fi

  # The matrix needs a deterministic, non-authenticated provider CLI so session creation is stable.
  # The daemon process does not consult the Playwright env, so we must inject any provider overrides
  # into the daemon's own process environment (see restart_host_daemon_and_capture_logs below).
  if wsrepl_matrix_csv_has_value "${HAPPIER_QA_PREFERRED_AGENT_ENGINES:-}" "claude"; then
    if [[ -z "${HAPPIER_CLAUDE_PATH:-}" || ! -f "${HAPPIER_CLAUDE_PATH:-}" ]]; then
      export HAPPIER_CLAUDE_PATH="${REPO_DIR}/packages/tests/src/fixtures/fake-claude-code-cli.js"
    fi
  fi

  # The handoff path exports a provider bundle and requires a vendor handoff id. Ensure the initial
  # QA session actually starts the provider runtime so the vendor resume id is persisted into session
  # metadata before the first handoff step.
  if [[ -z "${HAPPIER_QA_SESSION_SEED_PROMPT:-}" ]]; then
    export HAPPIER_QA_SESSION_SEED_PROMPT="ping"
  fi

# Default the Playwright source machine id once we know the host daemon machine id.
#
# In practice the wsrepl matrix needs the initial session to be created on the host machine, not the
# Lima guest. Relying on picker auto-resolution can pick the wrong machine (for example if the VM
# row is first or if machine ordering changes), which makes the matrix unstable.

step_out_strategy="${WSREPL_QA_STEP_OUT_STRATEGY:-transfer_snapshot}"
# Fresh environments do not have a baseline for the reverse direction, so a default "handoff back"
# `sync_changes` will correctly fail with "baseline missing". Default the back step to
# `transfer_snapshot`, and then run a third step back to the VM with `sync_changes` to exercise
# the incremental path on a real baseline.
step_back_strategy="${WSREPL_QA_STEP_BACK_STRATEGY:-transfer_snapshot}"
step_out_after_back_strategy="${WSREPL_QA_STEP_OUT_AFTER_BACK_STRATEGY:-sync_changes}"
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
if [[ -n "${step_out_after_back_strategy}" && "${step_out_after_back_strategy}" != "transfer_snapshot" && "${step_out_after_back_strategy}" != "sync_changes" ]]; then
  FAILURE_STAGE="preflight"
  FAILURE_REASON="invalid_step_out_after_back_strategy"
  echo "[wsrepl-qa] invalid WSREPL_QA_STEP_OUT_AFTER_BACK_STRATEGY: ${step_out_after_back_strategy} (expected transfer_snapshot|sync_changes|<empty>)" >&2
  exit 2
fi

WSREPL_QA_DERIVE_STEPS_LATER=0
if [[ -z "${HAPPIER_QA_STEPS_JSON:-}" ]]; then
  host_machine_id="${WSREPL_QA_HOST_MACHINE_ID:-}"
  vm_machine_id="${WSREPL_QA_VM_MACHINE_ID:-}"
  if [[ -n "${host_machine_id}" && -n "${vm_machine_id}" ]]; then
    vm_machine_name_pattern="$(resolve_vm_machine_name_pattern_for_ui)"
    host_machine_name_pattern="$(resolve_host_machine_name_pattern_for_ui)"
    export HAPPIER_QA_STEPS_JSON
    HAPPIER_QA_STEPS_JSON="$(python3 - "$vm_machine_id" "$host_machine_id" "$vm_machine_name_pattern" "$host_machine_name_pattern" "$step_out_strategy" "$step_back_strategy" "$step_out_after_back_strategy" <<-'PY'
import json
import sys

vm_machine_id, host_machine_id, vm_name_pattern, host_name_pattern, out_strategy, back_strategy, out_after_back_strategy = sys.argv[1:]

def build_step(machine_id: str, name_pattern: str, strategy: str) -> dict:
  # Prefer explicit ids for determinism: name patterns can match multiple online machines in a dev
  # environment with multiple VMs registered under the same account.
  mid = (machine_id or "").strip()
  if mid:
    return {"targetMachineId": mid, "strategy": strategy}
  pat = (name_pattern or "").strip()
  if pat:
    return {"targetMachineNamePattern": pat, "strategy": strategy}
  return {"targetMachineId": "", "strategy": strategy}

steps = [
  build_step(vm_machine_id, vm_name_pattern, out_strategy),
  build_step(host_machine_id, host_name_pattern, back_strategy),
]

if (out_after_back_strategy or "").strip():
  steps.append(build_step(vm_machine_id, vm_name_pattern, out_after_back_strategy))
print(json.dumps(steps))
PY
)"
  else
    WSREPL_QA_DERIVE_STEPS_LATER=1
  fi
fi

init_daemon_diagnostic_placeholders

echo "[wsrepl-qa] ensure VM exists + port forwarding (reuse-first)..."
{
  echo "date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "vm: ${VM_NAME}"
  echo "lima_home: ${LIMA_HOME_DIR}"
  echo "lima_yaml: ${LIMA_YAML}"
  ensure_vm_ready
} 2>&1 | tee "${REPORT_ROOT}/ensure-vm.log"

wsrepl_vm_direct_peer_bind_port="$(resolve_wsrepl_vm_direct_peer_bind_port_for_vm "${VM_NAME}")"
ensure_vm_direct_peer_port_forwarding "${wsrepl_vm_direct_peer_bind_port}"

if [[ "${#EXTRA_VM_NAMES[@]}" -gt 0 ]]; then
  for extra_vm in "${EXTRA_VM_NAMES[@]}"; do
    safe_extra_vm="${extra_vm//[^A-Za-z0-9._-]/_}"
    extra_root="${REPORT_ROOT}/vms/${safe_extra_vm}"
    mkdir -p "${extra_root}"
    echo "[wsrepl-qa] ensure additional VM exists + port forwarding (reuse-first): ${extra_vm}"
    (
      VM_NAME="${extra_vm}"
      LIMA_HOME_DIR="${LIMA_HOME:-${HOME}/.lima}"
      LIMA_DIR="${LIMA_HOME_DIR}/${VM_NAME}"
      LIMA_YAML="${LIMA_DIR}/lima.yaml"
      ensure_vm_ready
      extra_vm_direct_peer_bind_port="$(resolve_wsrepl_vm_direct_peer_bind_port_for_vm "${VM_NAME}")"
      ensure_vm_direct_peer_port_forwarding "${extra_vm_direct_peer_bind_port}"
    ) 2>&1 | tee "${extra_root}/ensure-vm.log"

    # Best-effort: seed any provider fixtures needed by the Playwright matrix.
    (
      VM_NAME="${extra_vm}"
      seed_guest_fake_claude_cli_if_needed
    ) >/dev/null 2>&1 || true
  done
fi

echo "[wsrepl-qa] seed guest fake Claude CLI (if needed)..."
seed_guest_fake_claude_cli_if_needed

if [[ -z "${HAPPIER_UI_URL:-}" ]]; then
  # Keep the wrapper's stack selection in lock-step with the Playwright runner: it uses
  # `.project/scripts/qa/resolveQaUiUrl.mjs` under the same env surface. Without this, the
  # wrapper can restart daemons against one stack while Playwright targets another.
  HAPPIER_UI_URL="$(cd "${REPO_DIR}" && node --input-type=module -e \
    "import { resolveQaUiUrl, ensureQaUiUrlHasHmrDisabled } from './.project/scripts/qa/resolveQaUiUrl.mjs'; console.log(ensureQaUiUrlHasHmrDisabled(resolveQaUiUrl()));" \
    2>/dev/null || true)"
  export HAPPIER_UI_URL
fi
if [[ -n "${HAPPIER_UI_URL:-}" ]]; then
  echo "[wsrepl-qa] ui url: ${HAPPIER_UI_URL}"
fi

host_server_url="${HAPPIER_SERVER_URL:-}"
if [[ -z "${host_server_url}" && -n "${HAPPIER_UI_URL:-}" ]]; then
  host_server_url="$(python3 - <<'PY' "${HAPPIER_UI_URL}" 2>/dev/null || true
import sys
from urllib.parse import urlparse, parse_qs, unquote

ui_url = sys.argv[1]
parsed = urlparse(ui_url)
qs = parse_qs(parsed.query)
server = qs.get("server", [""])[0]
print(unquote(server))
PY
)"
fi
if [[ -z "${host_server_url}" ]]; then
  # When the wrapper is invoked without HAPPIER_UI_URL, derive the server port from the most-recent
  # stack.runtime.json (same heuristic as resolveQaUiUrl.mjs) so the host daemon is started against
  # the same local stack server that Playwright will later resolve.
  host_server_url="$(python3 - <<'PY' "$HOME/.happier/stacks" "${HAPPIER_QA_STACK_NAME:-}" 2>/dev/null || true
import json
import sys
from pathlib import Path

stacks_root = Path(sys.argv[1])
explicit_stack_name = str(sys.argv[2] or "").strip()

def safe_json(path: Path):
  try:
    return json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    return None

runtime_path = None
if explicit_stack_name:
  candidate = stacks_root / explicit_stack_name / "stack.runtime.json"
  if candidate.exists():
    runtime_path = candidate

if runtime_path is None:
  best = None
  for entry in stacks_root.iterdir() if stacks_root.exists() else []:
    if not entry.is_dir():
      continue
    candidate = entry / "stack.runtime.json"
    if not candidate.exists():
      continue
    payload = safe_json(candidate) or {}
    updated_at = str(payload.get("updatedAt") or "").strip()
    updated_at_ms = 0
    if updated_at:
      try:
        from datetime import datetime
        updated_at_ms = int(datetime.fromisoformat(updated_at.replace("Z", "+00:00")).timestamp() * 1000)
      except Exception:
        updated_at_ms = 0
    mtime_ms = 0
    try:
      mtime_ms = int(candidate.stat().st_mtime * 1000)
    except Exception:
      mtime_ms = 0
    key = (updated_at_ms, mtime_ms, entry.name)
    if best is None or key > best[0]:
      best = (key, candidate)
  runtime_path = best[1] if best else None

server_port = 0
if runtime_path is not None and runtime_path.exists():
  payload = safe_json(runtime_path) or {}
  server_port = int(payload.get("ports", {}).get("server") or payload.get("runtime", {}).get("ports", {}).get("server") or 0)

if server_port:
  print(f"http://127.0.0.1:{server_port}")
else:
  print("")
PY
)"
fi
if [[ -n "${host_server_url:-}" ]]; then
  echo "[wsrepl-qa] host server url: ${host_server_url}"
fi
server_routed_max_bytes_seed=""
server_routed_max_bytes_seed="$(resolve_machine_transfer_server_routed_max_bytes_seed_from_server_features "${host_server_url}")"
host_direct_peer_bind_port=""
host_direct_peer_bind_port="$(resolve_wsrepl_host_direct_peer_bind_port)"

echo "[wsrepl-qa] restart host daemon and capture logs..."
restart_host_daemon_and_capture_logs "${host_server_url}" restart "${host_direct_peer_bind_port}"
  capture_vm_connectivity_to_host_direct_peer_port_best_effort "${host_direct_peer_bind_port}" || true

# Keep the host daemon under observation while the wrapper builds/installs the guest artifact
# and while Playwright runs. If the host daemon is restarted or exits during long guest setup,
# the watchdog will bring it back before the UI tries to create the matrix session.
start_host_daemon_watchdog_background "${PLAYWRIGHT_OUTDIR}" "${host_server_url:-}"

guest_server_url="$(rewrite_server_url_for_lima_guest "${host_server_url}")"
if [[ -n "${guest_server_url:-}" ]]; then
  echo "[wsrepl-qa] guest server url: ${guest_server_url}"
fi

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
  expected_version="$(resolve_expected_worktree_happier_version)"
  expected_git_rev="$(resolve_expected_worktree_git_rev)"
  if [[ -z "${expected_version}" ]]; then
    FAILURE_STAGE="guest_version_check"
    FAILURE_REASON="missing_worktree_version"
    echo "[wsrepl-qa] failed to resolve expected Happier version from worktree; expected ${REPO_DIR}/apps/cli/package.json to contain a version string" >&2
    exit 2
  fi

  if ! ensure_current_vm_happier_matches_worktree "${expected_version}" "${expected_git_rev}"; then
    FAILURE_STAGE="guest_version_check"
    FAILURE_REASON="$(
      if [[ "${WSREPL_QA_VM_HAPPIER_MODE}" == "autoupdate" ]]; then
        printf "%s" "guest_autoupdate_failed"
      elif [[ -n "${expected_git_rev}" ]]; then
        printf "%s" "guest_build_mismatch"
      else
        printf "%s" "guest_version_mismatch"
      fi
    )"
    exit 2
  fi

  if [[ "${#EXTRA_VM_NAMES[@]}" -gt 0 ]]; then
    for extra_vm in "${EXTRA_VM_NAMES[@]}"; do
      safe_extra_vm="${extra_vm//[^A-Za-z0-9._-]/_}"
      extra_root="${REPORT_ROOT}/vms/${safe_extra_vm}"
      mkdir -p "${extra_root}"
      echo "[wsrepl-qa] ensure additional VM Happier build matches worktree: ${extra_vm}"
      if ! (
        VM_NAME="${extra_vm}"
        ensure_current_vm_happier_matches_worktree "${expected_version}" "${expected_git_rev}"
      ) 2>&1 | tee "${extra_root}/guest.happier.version.txt" >/dev/null; then
        FAILURE_STAGE="guest_version_check"
        FAILURE_REASON="$(
          if [[ "${WSREPL_QA_VM_HAPPIER_MODE}" == "autoupdate" ]]; then
            printf "%s" "guest_autoupdate_failed"
          elif [[ -n "${expected_git_rev}" ]]; then
            printf "%s" "guest_build_mismatch"
          else
            printf "%s" "guest_version_mismatch"
          fi
        )"
        exit 2
      fi
    done
  fi
fi

echo "[wsrepl-qa] restart guest daemon and capture logs..."
restart_guest_daemon_and_capture_logs "${guest_server_url}" "${server_routed_max_bytes_seed}"

guest_provider_install_id="${WSREPL_QA_GUEST_PROVIDER_ID:-}"
if [[ -z "${guest_provider_install_id}" ]]; then
  guest_provider_install_id="${HAPPIER_QA_PREFERRED_AGENT_ENGINES%%,*}"
fi
guest_provider_install_log="${DAEMON_DIAG_DIR}/guest.provider.install.${guest_provider_install_id}.txt"
echo "[wsrepl-qa] ensure guest provider installed: ${guest_provider_install_id}..."
ensure_guest_provider_cli_installed "${guest_provider_install_id}" "${guest_provider_install_log}"

if [[ "${#EXTRA_VM_NAMES[@]}" -gt 0 ]]; then
  for extra_vm in "${EXTRA_VM_NAMES[@]}"; do
    safe_extra_vm="${extra_vm//[^A-Za-z0-9._-]/_}"
    extra_daemon_dir="${REPORT_ROOT}/vms/${safe_extra_vm}/daemon"
    mkdir -p "${extra_daemon_dir}"
    echo "[wsrepl-qa] restart additional guest daemon and capture logs: ${extra_vm}"
    (
      VM_NAME="${extra_vm}"
      DAEMON_DIAG_DIR="${extra_daemon_dir}"
      restart_guest_daemon_and_capture_logs "${guest_server_url}" "${server_routed_max_bytes_seed}" || true

      # Best-effort only: do not fail the whole wrapper if an additional VM lacks Happier/provider tooling.
      if limactl shell "${VM_NAME}" -- bash -lc '[[ -x "$HOME/.happier/bin/happier" ]] || command -v happier >/dev/null 2>&1' >/dev/null 2>&1; then
        extra_provider_log="${DAEMON_DIAG_DIR}/guest.provider.install.${guest_provider_install_id}.txt"
        ensure_guest_provider_cli_installed "${guest_provider_install_id}" "${extra_provider_log}" || true
      fi
    )
  done
fi

if [[ -z "${WSREPL_QA_HOST_MACHINE_ID:-}" ]]; then
  derived_host_machine_id="$(extract_machine_id_from_daemon_status_file "${DAEMON_DIAG_DIR}/host.daemon.status.txt")"
  if [[ -n "${derived_host_machine_id}" ]]; then
    export WSREPL_QA_HOST_MACHINE_ID="${derived_host_machine_id}"
  fi
fi

if [[ -z "${WSREPL_QA_VM_MACHINE_ID:-}" ]]; then
  derived_vm_machine_id="$(extract_machine_id_from_daemon_status_file "${DAEMON_DIAG_DIR}/guest.daemon.status.txt")"
  if [[ -n "${derived_vm_machine_id}" ]]; then
    export WSREPL_QA_VM_MACHINE_ID="${derived_vm_machine_id}"
  fi
fi

if [[ -z "${HAPPIER_QA_SOURCE_MACHINE_ID:-}" && -n "${WSREPL_QA_HOST_MACHINE_ID:-}" ]]; then
  export HAPPIER_QA_SOURCE_MACHINE_ID="${WSREPL_QA_HOST_MACHINE_ID}"
fi

if [[ "${WSREPL_QA_DERIVE_STEPS_LATER:-0}" == "1" && -z "${HAPPIER_QA_STEPS_JSON:-}" ]]; then
  host_machine_id="${WSREPL_QA_HOST_MACHINE_ID:-}"
  vm_machine_id="${WSREPL_QA_VM_MACHINE_ID:-}"
  if [[ -z "${host_machine_id}" ]]; then
    host_machine_id="$(extract_machine_id_from_daemon_status_file "${DAEMON_DIAG_DIR}/host.daemon.status.txt")"
    if [[ -n "${host_machine_id}" ]]; then
      export WSREPL_QA_HOST_MACHINE_ID="${host_machine_id}"
    fi
  fi
  if [[ -z "${vm_machine_id}" ]]; then
    vm_machine_id="$(extract_machine_id_from_daemon_status_file "${DAEMON_DIAG_DIR}/guest.daemon.status.txt")"
    if [[ -n "${vm_machine_id}" ]]; then
      export WSREPL_QA_VM_MACHINE_ID="${vm_machine_id}"
    fi
  fi
  if [[ -z "${host_machine_id}" || -z "${vm_machine_id}" ]]; then
    FAILURE_STAGE="preflight"
    FAILURE_REASON="missing_steps_json"
    echo "[wsrepl-qa] missing required env: HAPPIER_QA_STEPS_JSON" >&2
    echo "[wsrepl-qa] Fix: set WSREPL_QA_HOST_MACHINE_ID + WSREPL_QA_VM_MACHINE_ID, or ensure the host+guest daemons are reachable so the wrapper can auto-derive them." >&2
    exit 2
  fi
  vm_machine_name_pattern="$(resolve_vm_machine_name_pattern_for_ui)"
  host_machine_name_pattern="$(resolve_host_machine_name_pattern_for_ui)"
  export HAPPIER_QA_STEPS_JSON
  HAPPIER_QA_STEPS_JSON="$(python3 - "$vm_machine_id" "$host_machine_id" "$vm_machine_name_pattern" "$host_machine_name_pattern" "$step_out_strategy" "$step_back_strategy" "$step_out_after_back_strategy" <<'PY'
import json
import sys

vm_machine_id, host_machine_id, vm_name_pattern, host_name_pattern, out_strategy, back_strategy, out_after_back_strategy = sys.argv[1:]

def build_step(machine_id: str, name_pattern: str, strategy: str) -> dict:
  # Prefer explicit ids for determinism: name patterns can match multiple online machines in a dev
  # environment with multiple VMs registered under the same account.
  mid = (machine_id or "").strip()
  if mid:
    return {"targetMachineId": mid, "strategy": strategy}
  pat = (name_pattern or "").strip()
  if pat:
    return {"targetMachineNamePattern": pat, "strategy": strategy}
  return {"targetMachineId": "", "strategy": strategy}

steps = [
  build_step(vm_machine_id, vm_name_pattern, out_strategy),
  build_step(host_machine_id, host_name_pattern, back_strategy),
]

if (out_after_back_strategy or "").strip():
  steps.append(build_step(vm_machine_id, vm_name_pattern, out_after_back_strategy))
print(json.dumps(steps))
PY
)"
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
limactl list --all-fields --json "${VM_NAME}" 2>&1 | tee "${REPORT_ROOT}/lima.info.txt" >/dev/null
limactl shell "${VM_NAME}" -- bash -lc "set -euo pipefail; uname -a; id; df -h; command -v node >/dev/null 2>&1 && node --version || true; command -v free >/dev/null 2>&1 && free -m || true" \
  2>&1 | tee "${REPORT_ROOT}/guest.diag.txt" >/dev/null
if [[ "${#EXTRA_VM_NAMES[@]}" -gt 0 ]]; then
  for extra_vm in "${EXTRA_VM_NAMES[@]}"; do
    safe_extra_vm="${extra_vm//[^A-Za-z0-9._-]/_}"
    extra_root="${REPORT_ROOT}/vms/${safe_extra_vm}"
    mkdir -p "${extra_root}"
    limactl list --all-fields --json "${extra_vm}" 2>&1 | tee "${extra_root}/lima.info.txt" >/dev/null
    limactl shell "${extra_vm}" -- bash -lc "set -euo pipefail; uname -a; id; df -h; command -v node >/dev/null 2>&1 && node --version || true; command -v free >/dev/null 2>&1 && free -m || true" \
      2>&1 | tee "${extra_root}/guest.diag.txt" >/dev/null
  done
fi
set -e

echo "[wsrepl-qa] run Playwright matrix (artifacts under report dir)..."
PLAYWRIGHT_ROOTDIR="${REPORT_ROOT}/playwright"
PLAYWRIGHT_ATTEMPT=1
PLAYWRIGHT_OUTDIR="${PLAYWRIGHT_ROOTDIR}/attempt-01"
mkdir -p "${PLAYWRIGHT_OUTDIR}"

# Best-effort: expose the stack activeServerDir to the Playwright harness so it can capture
# `session-handoff/*` durable records for each failed attempt.
infer_stack_name_for_wsrepl() {
  local stacks_root="${1:-}"
  local server_url="${2:-}"
  if [[ -z "${stacks_root}" || -z "${server_url}" ]]; then
    return 1
  fi
  python3 - "$stacks_root" "$server_url" <<'PY'
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

stacks_root = Path(sys.argv[1]).expanduser()
server_url = sys.argv[2]

port = 0
try:
  parsed = urlparse(server_url)
  port = int(parsed.port or 0)
except Exception:
  port = 0

def safe_json(path: Path):
  try:
    return json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    return None

best = None
if port and stacks_root.exists():
  for entry in stacks_root.iterdir():
    if not entry.is_dir():
      continue
    runtime_path = entry / "stack.runtime.json"
    if not runtime_path.exists():
      continue
    payload = safe_json(runtime_path) or {}
    ports = payload.get("ports", {}) or {}
    runtime_port = int(ports.get("server") or 0)
    if runtime_port != port:
      continue
    updated_at = str(payload.get("updatedAt") or "").strip()
    updated_at_ms = 0
    if updated_at:
      try:
        from datetime import datetime
        updated_at_ms = int(datetime.fromisoformat(updated_at.replace("Z", "+00:00")).timestamp() * 1000)
      except Exception:
        updated_at_ms = 0
    mtime_ms = 0
    try:
      mtime_ms = int(runtime_path.stat().st_mtime * 1000)
    except Exception:
      mtime_ms = 0
    key = (updated_at_ms, mtime_ms, entry.name)
    if best is None or key > best[0]:
      best = (key, payload.get("stackName") or entry.name)

print((best[1] if best else "") or "")
PY
}

resolve_stack_server_slug_for_active_dir() {
  local stack_name="${1:-}"
  if [[ -z "${stack_name}" ]]; then
    return 1
  fi
  python3 - "$stack_name" <<'PY'
import re
import sys

name = sys.argv[1].strip()
match = re.match(r"^(?P<prefix>.+)-(?P<date>[0-9]{8})$", name)
print((match.group("prefix") if match else name) or "")
PY
}

if [[ -z "${HAPPIER_QA_STACK_NAME:-}" ]]; then
  inferred_stack_name="$(infer_stack_name_for_wsrepl "$HOME/.happier/stacks" "${host_server_url:-}" 2>/dev/null || true)"
  if [[ -n "${inferred_stack_name}" ]]; then
    export HAPPIER_QA_STACK_NAME="${inferred_stack_name}"
  fi
fi

if [[ -n "${HAPPIER_QA_STACK_NAME:-}" && -z "${HAPPIER_QA_ACTIVE_SERVER_DIR:-}" ]]; then
  stack_server_slug="$(resolve_stack_server_slug_for_active_dir "${HAPPIER_QA_STACK_NAME}" 2>/dev/null || true)"
  stack_home_dir="$HOME/.happier/stacks/${HAPPIER_QA_STACK_NAME}"
  candidate_active_server_dir="${stack_home_dir}/cli/servers/${stack_server_slug}"
  if [[ -d "${candidate_active_server_dir}" ]]; then
    export HAPPIER_QA_STACK_HOME_DIR="${stack_home_dir}"
    export HAPPIER_QA_ACTIVE_SERVER_DIR="${candidate_active_server_dir}"
  fi
fi

# Ensure the Playwright runner uses the same storage scope token as the stack UI.
# Without a consistent EXPO_PUBLIC_HAPPY_STORAGE_SCOPE, the UI can ignore the seeded
# server profile/tab selection and fall back to a different preconfigured server id,
# which triggers "server-switch" request aborts.
if [[ -z "${EXPO_PUBLIC_HAPPY_STORAGE_SCOPE:-}" && -n "${HAPPIER_QA_STACK_NAME:-}" ]]; then
  export EXPO_PUBLIC_HAPPY_STORAGE_SCOPE="${HAPPIER_QA_STACK_NAME}"
fi
if [[ -z "${EXPO_PUBLIC_HAPPY_SERVER_CONTEXT:-}" ]]; then
  export EXPO_PUBLIC_HAPPY_SERVER_CONTEXT="stack"
fi
if [[ -z "${EXPO_PUBLIC_HAPPIER_SERVER_URL:-}" && -n "${host_server_url:-}" ]]; then
  export EXPO_PUBLIC_HAPPIER_SERVER_URL="${host_server_url}"
fi

FAILURE_STAGE="playwright"
run_playwright_attempt() {
  local outdir="${1:-}"
  if [[ -z "${outdir}" ]]; then
    echo "[wsrepl-qa] internal error: missing outdir for Playwright attempt" >&2
    return 2
  fi
  mkdir -p "${outdir}"

  start_host_daemon_watchdog_background "${outdir}" "${host_server_url:-}"

  HAPPIER_QA_OUTDIR="${outdir}" \
    run_with_timeout_ms "${HAPPIER_QA_TIMEOUT_MS}" \
      node "${REPO_DIR}/.project/scripts/qa/playwright-session-handoff-wsrepl-matrix.mjs" \
      2>&1 | tee "${outdir}/runner.log"
  local status="${PIPESTATUS[0]}"

  return "${status}"
}

playwright_attempt_wrote_fatal_json() {
  local outdir="${1:-}"
  if [[ -z "${outdir}" ]]; then
    return 1
  fi
  local fatal_path="${outdir}/fatal.json"
  if [[ ! -f "${fatal_path}" ]]; then
    return 1
  fi
  python3 - "${fatal_path}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
  payload = json.loads(path.read_text(encoding="utf-8"))
except Exception:
  raise SystemExit(1)

ok = payload.get("ok")
if ok is False:
  raise SystemExit(0)
raise SystemExit(1)
PY
}

playwright_attempt_wrote_success_summary() {
  local outdir="${1:-}"
  if [[ -z "${outdir}" ]]; then
    return 1
  fi
  local summary_path="${outdir}/summary.json"
  if [[ ! -f "${summary_path}" ]]; then
    return 1
  fi
  python3 - "${summary_path}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
  payload = json.loads(path.read_text(encoding="utf-8"))
except Exception:
  raise SystemExit(1)

if payload.get("ok") is True:
  raise SystemExit(0)
raise SystemExit(1)
PY
}

should_retry_for_daemon_rpc_unavailable() {
  local outdir="${1:-}"
  if [[ -z "${outdir}" ]]; then
    return 1
  fi
  local fatal_path="${outdir}/fatal.json"
  if [[ ! -f "${fatal_path}" ]]; then
    # The Playwright harness writes fatal.json at failure time; on some systems the file can land
    # slightly after the process exits due to buffering. Poll briefly before giving up.
    local attempt=0
    while [[ "${attempt}" -lt 20 && ! -f "${fatal_path}" ]]; do
      attempt=$((attempt + 1))
      sleep 0.05
    done
    if [[ ! -f "${fatal_path}" ]]; then
      return 1
    fi
  fi
  if grep -q "Daemon RPC is not available" "${fatal_path}" && grep -q "RPC method not available" "${fatal_path}"; then
    return 0
  fi
  return 1
}

playwright_status=0
set +e
run_playwright_attempt "${PLAYWRIGHT_OUTDIR}"
playwright_status="$?"
set -e
if [[ "${playwright_status}" == "124" ]]; then
  FAILURE_REASON="timeout"
  exit 124
fi
# The Playwright harness can fail while still exiting 0 (it writes fatal.json/meta.json and relies
# on the wrapper to fail closed). Treat this as a failure so we don't publish a green summary.
if [[ "${playwright_status}" == "0" ]]; then
  if playwright_attempt_wrote_fatal_json "${PLAYWRIGHT_OUTDIR}"; then
    FAILURE_STAGE="playwright"
    FAILURE_REASON="playwright_fatal_json"
    playwright_status=1
  fi
fi
  if [[ "${playwright_status}" != "0" ]]; then
  if should_retry_for_daemon_rpc_unavailable "${PLAYWRIGHT_OUTDIR}"; then
    echo "[wsrepl-qa] Playwright failed with daemon RPC unavailable; restarting daemons and retrying once..." >&2
    restart_host_daemon_and_capture_logs "${host_server_url}" restart "${host_direct_peer_bind_port}"
    restart_guest_daemon_and_capture_logs "${guest_server_url}" "${server_routed_max_bytes_seed}"

    PLAYWRIGHT_ATTEMPT=2
    PLAYWRIGHT_OUTDIR="${PLAYWRIGHT_ROOTDIR}/attempt-02"
    playwright_status=0
    set +e
    run_playwright_attempt "${PLAYWRIGHT_OUTDIR}"
    playwright_status="$?"
    set -e
    if [[ "${playwright_status}" == "124" ]]; then
      FAILURE_REASON="timeout"
      exit 124
    fi
    if [[ "${playwright_status}" != "0" ]]; then
      exit "${playwright_status}"
    fi
    if [[ ! -f "${PLAYWRIGHT_OUTDIR}/meta.json" ]]; then
      FAILURE_STAGE="playwright"
      FAILURE_REASON="playwright_missing_meta_json_after_retry"
      echo "[wsrepl-qa] Playwright attempt succeeded but did not write meta.json: ${PLAYWRIGHT_OUTDIR}/meta.json" >&2
      exit 2
    fi
  else
    exit "${playwright_status}"
  fi
fi

if [[ ! -f "${PLAYWRIGHT_OUTDIR}/meta.json" ]]; then
  FAILURE_STAGE="playwright"
  FAILURE_REASON="playwright_missing_meta_json"
  echo "[wsrepl-qa] Playwright attempt succeeded but did not write meta.json: ${PLAYWRIGHT_OUTDIR}/meta.json" >&2
  exit 2
fi

echo ""
echo "[wsrepl-qa] done"
echo "[wsrepl-qa] report dir: ${REPORT_ROOT}"
