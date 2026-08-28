#!/usr/bin/env bash
set -euo pipefail

# Provision an Ubuntu machine with *dependencies only* so you can install/run Happier tools manually.
# This script intentionally does NOT install Happier/hstack itself.
#
# Intended usage (inside a VM):
#   curl -fsSL https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack/scripts/provision/linux-ubuntu-provision.sh -o /tmp/linux-ubuntu-provision.sh \
#     && chmod +x /tmp/linux-ubuntu-provision.sh \
#     && /tmp/linux-ubuntu-provision.sh --profile=happier
#
# Profiles:
# - happier   : build tools + Node + Corepack/Yarn (default)
# - installer : minimal base tooling (curl/ca-certs) to test the official installer on a mostly-empty box
# - bare      : do nothing (useful if you explicitly want an unprovisioned VM)
#
# Env overrides:
# - HAPPIER_PROVISION_NODE_MAJOR (default: 24)
# - HAPPIER_PROVISION_YARN_VERSION (default: 1.22.22)
# - HAPPIER_PROVISION_MUTAGEN_VERSION (default: 0.18.1)
# - HAPPIER_PROVISION_AGENT_BROWSER_VERSION (default: 0.34.0)
# - HAPPIER_PROVISION_PLAYWRIGHT_VERSION (default: 1.58.2; Linux ARM64 browser payload)
# - HAPPIER_PROVISION_BUN_VERSION (default: 1.3.5)

usage() {
  cat <<'EOF'
Usage:
  ./linux-ubuntu-provision.sh [--profile=happier|installer|bare]

Examples:
  ./linux-ubuntu-provision.sh --profile=happier
  ./linux-ubuntu-provision.sh --profile=installer
  ./linux-ubuntu-provision.sh --profile=bare
EOF
}

PROFILE="happier"
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --profile=*)
      PROFILE="${arg#--profile=}"
      ;;
    *)
      echo "[provision] unknown argument: ${arg}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
    return
  fi
  if require_cmd sudo; then
    sudo "$@"
    return
  fi
  echo "[provision] missing sudo; re-run as root" >&2
  exit 1
}

say() {
  echo ""
  echo "[provision] $*"
}

NODE_MAJOR="${HAPPIER_PROVISION_NODE_MAJOR:-24}"
YARN_VERSION="${HAPPIER_PROVISION_YARN_VERSION:-1.22.22}"
MUTAGEN_VERSION="${HAPPIER_PROVISION_MUTAGEN_VERSION:-0.18.1}"
AGENT_BROWSER_VERSION="${HAPPIER_PROVISION_AGENT_BROWSER_VERSION:-0.34.0}"
PLAYWRIGHT_VERSION="${HAPPIER_PROVISION_PLAYWRIGHT_VERSION:-1.58.2}"
BUN_VERSION="${HAPPIER_PROVISION_BUN_VERSION:-1.3.5}"

case "${PROFILE}" in
  happier|installer|bare) ;;
  *)
    echo "[provision] invalid --profile: ${PROFILE}" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "${PROFILE}" == "bare" ]]; then
  say "profile=bare (no changes)"
  echo ""
  echo "[provision] done."
  exit 0
fi

say "updating apt"
as_root apt-get update -y

if [[ "${PROFILE}" == "installer" ]]; then
  say "installing minimal packages (installer profile)"
  as_root apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils
  echo ""
  echo "[provision] done."
  echo ""
  echo "Next (example):"
  echo "  curl -fsSL https://happier.dev/install | bash"
  exit 0
fi

provision_happier_user_resource_slices() {
  local unit_dir="${HOME}/.config/systemd/user"
  mkdir -p "${unit_dir}"

  # Slice names establish the hierarchy: happier-jobs.slice is a child of
  # happier.slice. Keep session work lower priority without imposing a memory
  # ceiling or an OOM policy on the agent process tree.
  cat > "${unit_dir}/happier.slice" <<'EOF'
[Unit]
Description=Happier user workload
EOF
  chmod 0644 "${unit_dir}/happier.slice"

  cat > "${unit_dir}/happier-critical.slice" <<'EOF'
[Unit]
Description=Happier control plane

[Slice]
# Keep the daemon and future control-plane descendants alive through guest
# pressure. This is a protection floor, not an agent/session memory cap.
MemoryLow=4G
EOF
  chmod 0644 "${unit_dir}/happier-critical.slice"

  cat > "${unit_dir}/happier-jobs.slice" <<'EOF'
[Unit]
Description=Happier session jobs

[Slice]
CPUWeight=50
IOWeight=50
EOF
  chmod 0644 "${unit_dir}/happier-jobs.slice"

  # A non-interactive provision may not have a user bus yet. The unit files
  # remain durable and systemd will discover them when the manager is active.
  if require_cmd systemctl && [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

say "installing base packages"
as_root apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  ripgrep \
  unzip \
  xz-utils \
  bubblewrap \
  build-essential \
  python3

say "provisioning user systemd resource slices"
provision_happier_user_resource_slices

# Ubuntu 24.04 restricts unprofiled applications from creating unprivileged
# user namespaces. Happier's Linux agent sandbox uses Bubblewrap for that
# boundary, including an isolated loopback network. Grant only Bubblewrap the
# standard AppArmor `userns` permission instead of disabling the host-wide
# restriction.
if command -v apparmor_parser >/dev/null 2>&1; then
  BWRAP_APPARMOR_TMP="$(mktemp)"
  printf '%s\n' \
    'abi <abi/4.0>,' \
    'include <tunables/global>' \
    '' \
    'profile happier-bwrap /usr/bin/bwrap flags=(unconfined) {' \
    '  userns,' \
    '}' > "${BWRAP_APPARMOR_TMP}"
  as_root install -m 0644 "${BWRAP_APPARMOR_TMP}" /etc/apparmor.d/happier-bwrap
  rm -f -- "${BWRAP_APPARMOR_TMP}"
  as_root apparmor_parser -r /etc/apparmor.d/happier-bwrap
fi

if [[ ! "${MUTAGEN_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[provision] invalid Mutagen version: ${MUTAGEN_VERSION}" >&2
  exit 2
fi

MUTAGEN_ARCH=""
case "$(uname -m)" in
  aarch64|arm64) MUTAGEN_ARCH="arm64" ;;
  x86_64|amd64) MUTAGEN_ARCH="amd64" ;;
  *)
    echo "[provision] unsupported Mutagen architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

CURRENT_MUTAGEN_VERSION="$(mutagen version 2>/dev/null || true)"
if [[ "${CURRENT_MUTAGEN_VERSION}" != "${MUTAGEN_VERSION}" ]]; then
  say "installing Mutagen ${MUTAGEN_VERSION} (${MUTAGEN_ARCH})"
  MUTAGEN_TMP_DIR="$(mktemp -d)"
  MUTAGEN_ARCHIVE="${MUTAGEN_TMP_DIR}/mutagen.tar.gz"
  curl -fsSL \
    "https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_linux_${MUTAGEN_ARCH}_v${MUTAGEN_VERSION}.tar.gz" \
    -o "${MUTAGEN_ARCHIVE}"
  tar -xzf "${MUTAGEN_ARCHIVE}" -C "${MUTAGEN_TMP_DIR}"
  as_root install -m 0755 "${MUTAGEN_TMP_DIR}/mutagen" /usr/local/bin/mutagen
  as_root install -m 0644 "${MUTAGEN_TMP_DIR}/mutagen-agents.tar.gz" /usr/local/bin/mutagen-agents.tar.gz
  rm -rf -- "${MUTAGEN_TMP_DIR}"
fi

say "mutagen: $(mutagen version)"

if [[ ! "${BUN_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[provision] invalid Bun version: ${BUN_VERSION}" >&2
  exit 2
fi

BUN_ARCH=""
case "$(uname -m)" in
  aarch64|arm64) BUN_ARCH="aarch64" ;;
  x86_64|amd64) BUN_ARCH="x64" ;;
  *)
    echo "[provision] unsupported Bun architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

export PATH="/usr/local/bin:${PATH}"
CURRENT_BUN_VERSION="$(bun --version 2>/dev/null || true)"
if [[ "${CURRENT_BUN_VERSION}" != "${BUN_VERSION}" ]]; then
  say "installing Bun ${BUN_VERSION} (${BUN_ARCH})"
  BUN_TMP_DIR="$(mktemp -d)"
  BUN_ARCHIVE="${BUN_TMP_DIR}/bun.zip"
  curl -fsSL \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
    -o "${BUN_ARCHIVE}"
  unzip -q "${BUN_ARCHIVE}" -d "${BUN_TMP_DIR}"
  as_root install -m 0755 "${BUN_TMP_DIR}/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun
  rm -rf -- "${BUN_TMP_DIR}"
fi

say "bun: $(bun --version)"

if ! require_cmd node; then
  say "installing Node.js (NodeSource ${NODE_MAJOR}.x)"
  as_root bash -lc "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
  as_root apt-get install -y nodejs
fi

say "node: $(node --version)"

if ! require_cmd corepack; then
  echo "[provision] corepack not found (expected with Node >=16)." >&2
  exit 1
fi

say "enabling Corepack shims (root)"
as_root corepack enable

say "preparing Yarn ${YARN_VERSION} (root; system cache)"
as_root mkdir -p /usr/local/share/corepack
as_root env COREPACK_HOME=/usr/local/share/corepack corepack prepare "yarn@${YARN_VERSION}" --activate

say "yarn: $(yarn --version)"

if [[ ! "${AGENT_BROWSER_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[provision] invalid agent-browser version: ${AGENT_BROWSER_VERSION}" >&2
  exit 2
fi

CURRENT_AGENT_BROWSER_VERSION="$(agent-browser --version 2>/dev/null | awk '{print $NF}' || true)"
if [[ "${CURRENT_AGENT_BROWSER_VERSION}" != "${AGENT_BROWSER_VERSION}" ]]; then
  say "installing agent-browser ${AGENT_BROWSER_VERSION}"
  as_root corepack npm install --global --no-audit --no-fund \
    --allow-scripts=agent-browser \
    "agent-browser@${AGENT_BROWSER_VERSION}"
fi

# Google does not publish Chrome for Testing for Linux ARM64, and Ubuntu's
# snap-backed Chromium hides its dynamic DevTools files in a private /tmp. Use
# Playwright's native ARM64 headless shell in a persistent guest cache instead.
# Other architectures retain the upstream browser installer, which is idempotent.
case "$(uname -m)" in
  aarch64|arm64)
    if [[ ! "${PLAYWRIGHT_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "[provision] invalid Playwright version: ${PLAYWRIGHT_VERSION}" >&2
      exit 2
    fi
    PLAYWRIGHT_BROWSERS_PATH="${HOME}/.cache/happier/agent-browser-browsers"
    export PLAYWRIGHT_BROWSERS_PATH
    COREPACK_ENABLE_PROJECT_SPEC=0 corepack npm exec --yes \
      --package="playwright@${PLAYWRIGHT_VERSION}" -- \
      playwright install chromium-headless-shell
    AGENT_BROWSER_EXECUTABLE="$(find "${PLAYWRIGHT_BROWSERS_PATH}" \
      -type f -path '*/chrome-linux/headless_shell' -print -quit)"
    if [[ -z "${AGENT_BROWSER_EXECUTABLE}" || ! -x "${AGENT_BROWSER_EXECUTABLE}" ]]; then
      echo "[provision] Playwright did not install an executable ARM64 headless shell" >&2
      exit 1
    fi
    mkdir -p "${HOME}/.agent-browser"
    AGENT_BROWSER_CONFIG_TMP="$(mktemp)"
    jq -n --arg executablePath "${AGENT_BROWSER_EXECUTABLE}" \
      '{ executablePath: $executablePath, args: "--no-sandbox" }' > "${AGENT_BROWSER_CONFIG_TMP}"
    install -m 0644 "${AGENT_BROWSER_CONFIG_TMP}" "${HOME}/.agent-browser/config.json"
    rm -f -- "${AGENT_BROWSER_CONFIG_TMP}"
    ;;
  *)
    # Chrome for Testing and its libraries live on the persistent guest disk.
    agent-browser install --with-deps
    ;;
esac
say "agent-browser: $(agent-browser --version)"

say "converging Codex configuration"
mkdir -p "${HOME}/.codex"
chmod 0700 "${HOME}/.codex"
python3 - "${HOME}/.codex/config.toml" <<'PY'
import os
import pathlib
import re
import stat
import sys
import tomllib

path = pathlib.Path(sys.argv[1])
desired = {
    "": {
        "model": '"gpt-5.6-sol"',
        "model_reasoning_effort": '"medium"',
        "cli_auth_credentials_store": '"file"',
        "project_doc_max_bytes": "81920",
        "startup_timeout_sec": "20",
        "web_search": '"live"',
        "preferred_auth_method": '"chatgpt"',
        "personality": '"pragmatic"',
        "approval_policy": '"never"',
        "sandbox_mode": '"danger-full-access"',
        "service_tier": '"default"',
    },
    "features": {
        "hooks": "true",
        "unified_exec": "true",
        "shell_snapshot": "true",
        "multi_agent": "true",
        "goals": "true",
        "terminal_resize_reflow": "false",
        "js_repl": "false",
    },
    "features.multi_agent_v2": {
        "hide_spawn_agent_metadata": "false",
        "tool_namespace": '"agents"',
        "max_concurrent_threads_per_session": "42",
    },
    "agents": {
        "max_threads": "100",
    },
    "sandbox_workspace_write": {
        "network_access": "true",
    },
}

original = path.read_text(encoding="utf-8") if path.exists() else ""
tomllib.loads(original)
lines = original.splitlines()
output = []
current_section = ""
seen_sections = {""}
seen_keys = {section: set() for section in desired}
table_header = re.compile(r"^\s*\[([^\[\]]+)\]\s*(?:#.*)?$")
array_table_header = re.compile(r"^\s*\[\[([^\[\]]+)\]\]\s*(?:#.*)?$")
assignment = re.compile(r"^\s*([A-Za-z0-9_-]+)\s*=")

def append_missing(section):
    if section not in desired:
        return
    for key, value in desired[section].items():
        if key not in seen_keys[section]:
            output.append(f"{key} = {value}")
            seen_keys[section].add(key)

for line in lines:
    array_header = array_table_header.match(line)
    if array_header:
        append_missing(current_section)
        current_section = f"[[{array_header.group(1).strip()}]]"
        output.append(line)
        continue
    header = table_header.match(line)
    if header:
        append_missing(current_section)
        current_section = header.group(1).strip()
        seen_sections.add(current_section)
        output.append(line)
        continue
    match = assignment.match(line)
    if current_section in desired and match and match.group(1) in desired[current_section]:
        key = match.group(1)
        output.append(f"{key} = {desired[current_section][key]}")
        seen_keys[current_section].add(key)
    else:
        output.append(line)

append_missing(current_section)
for section in desired:
    if not section or section in seen_sections:
        continue
    if output and output[-1] != "":
        output.append("")
    output.append(f"[{section}]")
    append_missing(section)

updated = "\n".join(output).rstrip("\n") + "\n"
tomllib.loads(updated)
if updated != original:
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(updated, encoding="utf-8")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
PY

echo ""
echo "[provision] done."
echo ""
echo "Next:"
echo "  npx --yes -p @happier-dev/stack@latest hstack setup-from-source --profile=dev --bind=loopback"
