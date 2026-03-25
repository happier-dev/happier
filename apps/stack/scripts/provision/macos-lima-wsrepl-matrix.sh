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
#   (or name-based, preferred for stability across stacks)
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
#   WSREPL_QA_FORCE_VM_RECONFIGURE=1  # force stop/reconfigure/start via macos-lima-vm.sh (default is reuse-first)
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

FINALIZED=0
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PLAYWRIGHT_OUTDIR="${REPORT_ROOT}/playwright"
DAEMON_DIAG_DIR="${REPORT_ROOT}/daemon"
FAILURE_STAGE=""
FAILURE_REASON=""

init_daemon_diagnostic_placeholders() {
  mkdir -p "${DAEMON_DIAG_DIR}"
  for name in \
    host.daemon.start.txt \
    host.daemon.status.txt \
    host.daemon.log.path.txt \
    host.daemon.log.tail.txt \
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
  local runtime_cli_bin
  runtime_cli_bin="$(resolve_stack_runtime_cli_bin)"
  if [[ -n "${runtime_cli_bin}" ]]; then
    WSREPL_QA_HOST_HAPPIER_KIND="stack_runtime"
    "${runtime_cli_bin}" "$@"
    return $?
  fi
  if [[ -x "$HOME/.happier/bin/happier" ]]; then
    WSREPL_QA_HOST_HAPPIER_KIND="user_install"
    "$HOME/.happier/bin/happier" "$@"
    return $?
  fi
  if command -v happier >/dev/null 2>&1; then
    WSREPL_QA_HOST_HAPPIER_KIND="path"
    happier "$@"
    return $?
  fi
  WSREPL_QA_HOST_HAPPIER_KIND="worktree_node"
  node "${REPO_DIR}/apps/cli/bin/happier.mjs" "$@"
}

resolve_stack_cli_access_key_path_for_ui_url() {
  local explicit="${HAPPIER_QA_ACCESS_KEY_PATH:-}"
  if [[ -n "${explicit}" && -f "${explicit}" ]]; then
    echo "${explicit}"
    return 0
  fi

  local stacks_root="$HOME/.happier/stacks"
  if [[ ! -d "${stacks_root}" ]]; then
    echo ""
    return 0
  fi

  local stack_name="${HAPPIER_QA_STACK_NAME:-}"
  local server_port=""
  if [[ -n "${HAPPIER_UI_URL:-}" ]]; then
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
candidates = []
candidates.append(cli_root / "access.key")
servers_root = cli_root / "servers"
if servers_root.exists():
  for entry in servers_root.iterdir():
    if not entry.is_dir():
      continue
    candidates.append(entry / "access.key")

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

resolve_stack_cli_home_and_active_server_id_for_ui_url() {
  local access_key_path
  access_key_path="$(resolve_stack_cli_access_key_path_for_ui_url)"
  if [[ -z "${access_key_path}" || ! -f "${access_key_path}" ]]; then
    echo ""
    return 0
  fi

  local server_dir
  server_dir="$(dirname "${access_key_path}")"
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
  init_daemon_diagnostic_placeholders

  local start_file="${DAEMON_DIAG_DIR}/host.daemon.start.txt"
  local build_file="${DAEMON_DIAG_DIR}/host.cli.build.txt"
  local status_file="${DAEMON_DIAG_DIR}/host.daemon.status.txt"
  local log_path_file="${DAEMON_DIAG_DIR}/host.daemon.log.path.txt"
  local log_tail_file="${DAEMON_DIAG_DIR}/host.daemon.log.tail.txt"

  local stack_cli_root=""
  local stack_active_server_id=""
  local stack_home_hint
  stack_home_hint="$(resolve_stack_cli_home_and_active_server_id_for_ui_url)"
  if [[ -n "${stack_home_hint}" ]]; then
    stack_cli_root="$(printf "%s" "${stack_home_hint}" | cut -d '|' -f 1)"
    stack_active_server_id="$(printf "%s" "${stack_home_hint}" | cut -d '|' -f 2)"
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

  local start_status=0
  if [[ -n "${server_url}" ]]; then
    if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
      HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon stop >/dev/null 2>&1 || true
    else
      HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon stop >/dev/null 2>&1 || true
    fi
    set +e
    if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
      HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
      HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
      HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
    else
      HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
      HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
      HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
    fi
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
    if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
      HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon stop >/dev/null 2>&1 || true
    else
      run_host_happier daemon stop >/dev/null 2>&1 || true
    fi
    set +e
    if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
      HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
      HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
      HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon start >"${start_file}" 2>&1
    else
      HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
      HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
      run_host_happier daemon start >"${start_file}" 2>&1
    fi
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

  local cli_dist_rebuild_attempted=0
  if [[ "${WSREPL_QA_HOST_HAPPIER_KIND:-}" == "worktree_node" ]] && grep -Eq "Cannot find module '.*/apps/cli/dist/index\\.mjs'" "${start_file}" "${status_file}" "${log_tail_file}" 2>/dev/null; then
    cli_dist_rebuild_attempted=1
    echo "[wsrepl-qa] host daemon start/status reported a missing CLI dist entrypoint; rebuilding and retrying..." >&2
    (
      cd "${REPO_DIR}"
      yarn workspace @happier-dev/cli build
    ) >"${build_file}" 2>&1 || true

    set +e
    if [[ -n "${server_url}" ]]; then
      if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
        HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
        HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
      else
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
        HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
        HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
        HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
      fi
    else
      if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
        HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
        HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
        HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon start >"${start_file}" 2>&1
      else
        HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
        HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
        HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
        run_host_happier daemon start >"${start_file}" 2>&1
      fi
    fi
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
    if [[ "${cli_dist_rebuild_attempted}" != "1" && "${WSREPL_QA_HOST_HAPPIER_KIND:-}" == "worktree_node" ]] && grep -Eq "Cannot find module '.*/apps/cli/dist/index\\.mjs'" "${start_file}" "${log_tail_file}" 2>/dev/null; then
      echo "[wsrepl-qa] host daemon start failed due to missing CLI dist entrypoint; rebuilding and retrying..." >&2
      (
        cd "${REPO_DIR}"
        yarn workspace @happier-dev/cli build
      ) >"${build_file}" 2>&1 || true

      set +e
      if [[ -n "${server_url}" ]]; then
        if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
          HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
          HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
          HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
        else
          HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
          HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
          HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
        fi
      else
        if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
          HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
          HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
          HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon start >"${start_file}" 2>&1
        else
          HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
          HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
          run_host_happier daemon start >"${start_file}" 2>&1
        fi
      fi
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
        if [[ -n "${server_url}" ]]; then
          if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
          else
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
          fi
          start_status=$?
          if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          else
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
          fi
        else
          if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon start >"${start_file}" 2>&1
          else
            run_host_happier daemon start >"${start_file}" 2>&1
          fi
          start_status=$?
          if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon status >"${status_file}" 2>&1 || true
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon logs >"${log_path_file}" 2>&1 || true
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

        sleep "${daemon_start_retry_delay_s}" || true

        set +e
        if [[ -n "${server_url}" ]]; then
          if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
            HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
            HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
            HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
          else
            HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
            HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
            HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
            HAPPIER_SERVER_URL="${server_url}" run_host_happier daemon start >"${start_file}" 2>&1
          fi
        else
          if [[ -n "${stack_cli_root}" && -n "${stack_active_server_id}" ]]; then
            HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
            HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
            HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
            HAPPIER_HOME_DIR="${stack_cli_root}" HAPPIER_ACTIVE_SERVER_ID="${stack_active_server_id}" run_host_happier daemon start >"${start_file}" 2>&1
          else
            HAPPIER_CLAUDE_PATH="${HAPPIER_CLAUDE_PATH:-}" \
            HAPPIER_DAEMON_WAIT_FOR_AUTH=1 \
            HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS="${HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS:-600000}" \
            run_host_happier daemon start >"${start_file}" 2>&1
          fi
        fi
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
  local stack_home_hint
  stack_home_hint="$(resolve_stack_cli_home_and_active_server_id_for_ui_url)"
  if [[ -n "${stack_home_hint}" ]]; then
    guest_active_server_id="$(printf "%s" "${stack_home_hint}" | cut -d '|' -f 2)"
  fi
  guest_access_key_src="$(resolve_stack_cli_access_key_path_for_ui_url || true)"
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

      # `happier daemon status` is a doctor-style command and may exit 0 even when the daemon
      # isn't running. Detect health from the rendered output we captured above.
      if ! grep -qi "Daemon is not running" "${status_file}" 2>/dev/null; then
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
  # Avoid macOS-specific extended attribute headers that spam stderr during Linux tar extraction.
  # This wrapper is macOS-only, so we fail closed if bsdtar doesn't accept these flags.
  COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 \
    tar --no-xattrs --no-acls --no-fflags -C "${payload_dir}" -cf "${payload_tar}" .

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

# Default to creating a fresh QA session unless the caller pins a specific sessionId.
if [[ -z "${HAPPIER_QA_SESSION_ID:-}" && -z "${HAPPIER_QA_CREATE_SESSION:-}" ]]; then
  export HAPPIER_QA_CREATE_SESSION="1"
fi

  # Default the matrix to a deterministic engine choice (and allow override).
  if [[ -z "${HAPPIER_QA_PREFERRED_AGENT_ENGINES:-}" ]]; then
    # Default to an engine that does not require a system-installed provider CLI inside the Lima guest.
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

# Default the Playwright source machine id once we know the host daemon machine id.
#
# In practice the wsrepl matrix needs the initial session to be created on the host machine, not the
# Lima guest. Relying on picker auto-resolution can pick the wrong machine (for example if the VM
# row is first or if machine ordering changes), which makes the matrix unstable.

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

WSREPL_QA_DERIVE_STEPS_LATER=0
if [[ -z "${HAPPIER_QA_STEPS_JSON:-}" ]]; then
  host_machine_id="${WSREPL_QA_HOST_MACHINE_ID:-}"
  vm_machine_id="${WSREPL_QA_VM_MACHINE_ID:-}"
  if [[ -n "${host_machine_id}" && -n "${vm_machine_id}" ]]; then
    vm_machine_name_pattern="$(resolve_vm_machine_name_pattern_for_ui)"
    host_machine_name_pattern="$(resolve_host_machine_name_pattern_for_ui)"
    export HAPPIER_QA_STEPS_JSON
    HAPPIER_QA_STEPS_JSON="$(python3 - "$vm_machine_id" "$host_machine_id" "$vm_machine_name_pattern" "$host_machine_name_pattern" "$step_out_strategy" "$step_back_strategy" <<'PY'
import json
import sys

vm_machine_id, host_machine_id, vm_name_pattern, host_name_pattern, out_strategy, back_strategy = sys.argv[1:]

def build_step(machine_id: str, name_pattern: str, strategy: str) -> dict:
  if (name_pattern or "").strip():
    return {"targetMachineNamePattern": name_pattern.strip(), "strategy": strategy}
  return {"targetMachineId": machine_id.strip(), "strategy": strategy}

steps = [
  build_step(vm_machine_id, vm_name_pattern, out_strategy),
  build_step(host_machine_id, host_name_pattern, back_strategy),
]
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

echo "[wsrepl-qa] restart host daemon and capture logs..."
restart_host_daemon_and_capture_logs "${host_server_url}"

guest_server_url="$(rewrite_server_url_for_lima_guest "${host_server_url}")"

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

  if [[ "${WSREPL_QA_VM_HAPPIER_MODE}" == "autoupdate" ]]; then
    if ! autoupdate_guest_happier_from_worktree "${expected_version}" "${expected_git_rev}"; then
      FAILURE_STAGE="guest_version_check"
      FAILURE_REASON="guest_autoupdate_failed"
      echo "[wsrepl-qa] guest autoupdate failed" >&2
      exit 2
    fi
    guest_marker_git_rev="$(resolve_guest_wsrepl_build_marker_git_rev)"
    guest_marker_version="$(resolve_guest_wsrepl_build_marker_cli_version)"
  else
    guest_marker_git_rev="$(resolve_guest_wsrepl_build_marker_git_rev)"
    guest_marker_version="$(resolve_guest_wsrepl_build_marker_cli_version)"
    guest_version="$(resolve_guest_happier_version)"
  fi

  # Prefer a build marker comparison when the worktree is a git checkout.
  if [[ -n "${expected_git_rev}" ]]; then
    if [[ -z "${guest_marker_git_rev}" ]]; then
      FAILURE_STAGE="guest_version_check"
      FAILURE_REASON="guest_build_marker_missing"
      echo "[wsrepl-qa] guest wsrepl build marker is missing, but the worktree git rev is available (mode=${WSREPL_QA_VM_HAPPIER_MODE})." >&2
      echo "[wsrepl-qa] expected git rev: ${expected_git_rev}" >&2
      echo "[wsrepl-qa] expected marker path: $HOME/.happier/wsrepl-dev/payload/wsrepl-build.json" >&2
      echo "[wsrepl-qa] Fix: rerun with WSREPL_QA_VM_HAPPIER_MODE=autoupdate (installs a matching build marker), or set WSREPL_QA_VM_HAPPIER_MODE=skip to bypass this guard." >&2
      exit 2
    fi
    if [[ "${guest_marker_git_rev}" != "${expected_git_rev}" ]]; then
      FAILURE_STAGE="guest_version_check"
      FAILURE_REASON="guest_build_mismatch"
      echo "[wsrepl-qa] guest wsrepl build marker does not match the current worktree (mode=${WSREPL_QA_VM_HAPPIER_MODE})." >&2
      echo "[wsrepl-qa] expected git rev: ${expected_git_rev}" >&2
      echo "[wsrepl-qa] guest git rev:    ${guest_marker_git_rev}" >&2
      echo "[wsrepl-qa] Fix: rerun with WSREPL_QA_VM_HAPPIER_MODE=autoupdate, or set WSREPL_QA_VM_HAPPIER_MODE=skip to bypass this guard." >&2
      exit 2
    fi
    if [[ -n "${guest_marker_version}" && "${guest_marker_version}" != "${expected_version}" ]]; then
      FAILURE_STAGE="guest_version_check"
      FAILURE_REASON="guest_version_mismatch"
      echo "[wsrepl-qa] guest wsrepl build marker version does not match the worktree version." >&2
      echo "[wsrepl-qa] expected version: ${expected_version}" >&2
      echo "[wsrepl-qa] guest version:    ${guest_marker_version}" >&2
      exit 2
    fi
  else
    if [[ -z "${guest_version}" ]]; then
      FAILURE_STAGE="guest_version_check"
      FAILURE_REASON="guest_version_unresolved"
      echo "[wsrepl-qa] failed to resolve guest Happier version; ensure happier is installed in the VM and reachable from PATH" >&2
      exit 2
    fi
    if [[ "${guest_version}" != "${expected_version}" ]]; then
      FAILURE_STAGE="guest_version_check"
      FAILURE_REASON="guest_version_mismatch"
      echo "[wsrepl-qa] guest Happier CLI version does not match the current worktree (mode=${WSREPL_QA_VM_HAPPIER_MODE})." >&2
      echo "[wsrepl-qa] expected: ${expected_version}" >&2
      echo "[wsrepl-qa] guest:    ${guest_version}" >&2
      echo "[wsrepl-qa] Fix: update the VM's Happier install to the same commit/build, rerun with WSREPL_QA_VM_HAPPIER_MODE=autoupdate, or set WSREPL_QA_VM_HAPPIER_MODE=skip to bypass this guard." >&2
      exit 2
    fi
  fi
fi

echo "[wsrepl-qa] restart guest daemon and capture logs..."
restart_guest_daemon_and_capture_logs "${guest_server_url}"

guest_provider_install_id="${WSREPL_QA_GUEST_PROVIDER_ID:-}"
if [[ -z "${guest_provider_install_id}" ]]; then
  guest_provider_install_id="${HAPPIER_QA_PREFERRED_AGENT_ENGINES%%,*}"
fi
guest_provider_install_log="${DAEMON_DIAG_DIR}/guest.provider.install.${guest_provider_install_id}.txt"
echo "[wsrepl-qa] ensure guest provider installed: ${guest_provider_install_id}..."
ensure_guest_provider_cli_installed "${guest_provider_install_id}" "${guest_provider_install_log}"

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
  HAPPIER_QA_STEPS_JSON="$(python3 - "$vm_machine_id" "$host_machine_id" "$vm_machine_name_pattern" "$host_machine_name_pattern" "$step_out_strategy" "$step_back_strategy" <<'PY'
import json
import sys

vm_machine_id, host_machine_id, vm_name_pattern, host_name_pattern, out_strategy, back_strategy = sys.argv[1:]

def build_step(machine_id: str, name_pattern: str, strategy: str) -> dict:
  if (name_pattern or "").strip():
    return {"targetMachineNamePattern": name_pattern.strip(), "strategy": strategy}
  return {"targetMachineId": machine_id.strip(), "strategy": strategy}

steps = [
  build_step(vm_machine_id, vm_name_pattern, out_strategy),
  build_step(host_machine_id, host_name_pattern, back_strategy),
]
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
limactl info "${VM_NAME}" 2>&1 | tee "${REPORT_ROOT}/lima.info.txt" >/dev/null
limactl shell "${VM_NAME}" -- bash -lc "set -euo pipefail; uname -a; id; df -h; command -v node >/dev/null 2>&1 && node --version || true; command -v free >/dev/null 2>&1 && free -m || true" \
  2>&1 | tee "${REPORT_ROOT}/guest.diag.txt" >/dev/null
set -e

echo "[wsrepl-qa] run Playwright matrix (artifacts under report dir)..."
mkdir -p "${PLAYWRIGHT_OUTDIR}"

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
set +e
HAPPIER_QA_OUTDIR="${PLAYWRIGHT_OUTDIR}" \
run_with_timeout_ms "${HAPPIER_QA_TIMEOUT_MS}" \
  node "${REPO_DIR}/.project/scripts/qa/playwright-session-handoff-wsrepl-matrix.mjs" \
  2>&1 | tee "${PLAYWRIGHT_OUTDIR}/runner.log"
playwright_status="${PIPESTATUS[0]}"
set -e
if [[ "${playwright_status}" == "124" ]]; then
  FAILURE_REASON="timeout"
  exit 124
fi
if [[ "${playwright_status}" != "0" ]]; then
  exit "${playwright_status}"
fi

echo ""
echo "[wsrepl-qa] done"
echo "[wsrepl-qa] report dir: ${REPORT_ROOT}"
