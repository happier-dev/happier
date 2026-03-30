#!/usr/bin/env bash
set -euo pipefail

# Website self-host installer (end-user friendly).
# Canonical path: ensure Happier CLI is installed, then run `happier relay host ...`.

CHANNEL="${HAPPIER_CHANNEL:-stable}"              # stable|preview|dev
MODE="${HAPPIER_SELF_HOST_MODE:-user}"            # user|system
WITH_CLI="${HAPPIER_WITH_CLI:-1}"                 # 1|0 (passed through to relay host install as --without-cli)
NONINTERACTIVE="${HAPPIER_NONINTERACTIVE:-0}"     # 1|0
ACTION="${HAPPIER_INSTALLER_ACTION:-install}"     # install|reinstall|version|check|uninstall|restart
DEBUG_MODE="${HAPPIER_INSTALLER_DEBUG:-0}"
VERBOSE_MODE="${HAPPIER_INSTALLER_VERBOSE:-0}"
PURGE_DATA="${HAPPIER_SELF_HOST_PURGE_DATA:-0}"

HAPPIER_HOME="${HAPPIER_HOME:-${HOME}/.happier}"
GITHUB_REPO="${HAPPIER_GITHUB_REPO:-happier-dev/happier}"
GITHUB_TOKEN="${HAPPIER_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"

DEFAULT_MINISIGN_PUBKEY="$(cat <<'EOF'
untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
EOF
)"
MINISIGN_PUBKEY="${HAPPIER_MINISIGN_PUBKEY:-${DEFAULT_MINISIGN_PUBKEY}}"
MINISIGN_PUBKEY_URL="${HAPPIER_MINISIGN_PUBKEY_URL:-https://happier.dev/happier-release.pub}"

INSTALLER_COLOR_MODE="${HAPPIER_INSTALLER_COLOR:-auto}" # auto|always|never

supports_color() {
  if [[ "${INSTALLER_COLOR_MODE}" == "never" ]]; then return 1; fi
  if [[ -n "${NO_COLOR:-}" ]]; then return 1; fi
  if [[ "${INSTALLER_COLOR_MODE}" == "always" ]]; then return 0; fi
  [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]]
}

if supports_color; then
  COLOR_RESET=$'\033[0m'
  COLOR_BOLD=$'\033[1m'
  COLOR_GREEN=$'\033[32m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_CYAN=$'\033[36m'
else
  COLOR_RESET=""
  COLOR_BOLD=""
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_CYAN=""
fi

say() { printf '%s\n' "$*"; }
info() { say "${COLOR_CYAN}$*${COLOR_RESET}"; }
success() { say "${COLOR_GREEN}$*${COLOR_RESET}"; }
warn() { say "${COLOR_YELLOW}$*${COLOR_RESET}"; }

usage() {
  cat <<EOF
${COLOR_BOLD}Happier Self-Host installer${COLOR_RESET}

Usage:
  curl -fsSL https://happier.dev/self-host | bash

Env knobs (selected):
  HAPPIER_CHANNEL=stable|preview|dev
  HAPPIER_SELF_HOST_MODE=user|system
  HAPPIER_WITH_CLI=1|0
  HAPPIER_NONINTERACTIVE=1|0
  HAPPIER_INSTALLER_ACTION=install|reinstall|version|check|uninstall|restart

This script installs/updates the Happier CLI (if needed), then runs:
  happier relay host <action>
EOF
}

normalize_channel() {
  local raw="${1:-}"
  case "${raw}" in
    ""|stable) echo "stable" ;;
    preview) echo "preview" ;;
    publicdev|dev) echo "publicdev" ;;
    *) echo "${raw}" ;;
  esac
}

display_channel_label() {
  case "$1" in
    publicdev|dev) echo "dev" ;;
    *) echo "$1" ;;
  esac
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --mode) MODE="${2:-}"; shift 2 ;;
      --mode=*) MODE="${1#--mode=}"; shift ;;
      --user) MODE="user"; shift ;;
      --system) MODE="system"; shift ;;
      --channel) CHANNEL="${2:-}"; shift 2 ;;
      --channel=*) CHANNEL="${1#--channel=}"; shift ;;
      --stable) CHANNEL="stable"; shift ;;
      --preview) CHANNEL="preview"; shift ;;
      --dev) CHANNEL="dev"; shift ;;
      --json) WANTS_JSON="1"; shift ;;
      --non-interactive) NONINTERACTIVE="1"; shift ;;
      --without-cli) WITH_CLI="0"; shift ;;
      --with-cli) WITH_CLI="1"; shift ;;
      --purge-data) PURGE_DATA="1"; shift ;;
      --reinstall) ACTION="reinstall"; shift ;;
      --check) ACTION="check"; shift ;;
      --uninstall) ACTION="uninstall"; shift ;;
      --restart) ACTION="restart"; shift ;;
      --version) ACTION="version"; shift ;;
      *) warn "Unknown argument: $1"; usage; exit 1 ;;
    esac
  done
}

WANTS_JSON="0"
parse_args "$@"

CHANNEL="$(normalize_channel "${CHANNEL}")"

if [[ "${DEBUG_MODE}" == "1" ]]; then
  VERBOSE_MODE="1"
  set -x
fi

if [[ "${MODE}" != "user" && "${MODE}" != "system" ]]; then
  echo "Invalid mode: ${MODE}. Expected user or system." >&2
  exit 1
fi

if [[ "${CHANNEL}" != "stable" && "${CHANNEL}" != "preview" && "${CHANNEL}" != "publicdev" ]]; then
  echo "Invalid HAPPIER_CHANNEL='${CHANNEL}'. Expected stable, preview, or dev." >&2
  exit 1
fi

if [[ "${MODE}" == "system" && "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    if [[ -f "${0}" ]]; then
      echo "Re-running with sudo for system-level install..."
      exec sudo -E bash "$0" "$@"
    fi
    echo "This installer requires root for --mode system. Re-run with sudo:" >&2
    echo "  curl -fsSL https://happier.dev/self-host | sudo bash -s -- $*" >&2
    exit 1
  fi
  echo "Please run as root (or install sudo) for --mode system." >&2
  exit 1
fi

resolve_cli_install_dirs() {
  if [[ "${MODE}" == "system" ]]; then
    CLI_INSTALL_DIR="${HAPPIER_INSTALL_DIR:-/opt/happier}"
    CLI_BIN_DIR="${HAPPIER_BIN_DIR:-/usr/local/bin}"
  else
    CLI_INSTALL_DIR="${HAPPIER_INSTALL_DIR:-${HAPPIER_HOME}}"
    CLI_BIN_DIR="${HAPPIER_BIN_DIR:-${HAPPIER_HOME}/bin}"
  fi
}

ensure_happier_cli() {
  resolve_cli_install_dirs
  export PATH="${CLI_BIN_DIR}:${CLI_INSTALL_DIR}/bin:${PATH}"

  if command -v happier >/dev/null 2>&1; then
    if happier relay host --help >/dev/null 2>&1; then
      return 0
    fi
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install Happier CLI." >&2
    exit 1
  fi

  info "Installing Happier CLI..."

  # Delegate artifact fetching + minisign verification to the canonical CLI installer.
  env \
    HAPPIER_CHANNEL="$(display_channel_label "${CHANNEL}")" \
    HAPPIER_PRODUCT="cli" \
    HAPPIER_WITH_DAEMON="0" \
    HAPPIER_INSTALL_DIR="${CLI_INSTALL_DIR}" \
    HAPPIER_BIN_DIR="${CLI_BIN_DIR}" \
    HAPPIER_NONINTERACTIVE="${NONINTERACTIVE}" \
    HAPPIER_INSTALLER_ACTION="install" \
    HAPPIER_INSTALLER_DEBUG="${DEBUG_MODE}" \
    HAPPIER_INSTALLER_VERBOSE="${VERBOSE_MODE}" \
    HAPPIER_GITHUB_REPO="${GITHUB_REPO}" \
    HAPPIER_GITHUB_TOKEN="${GITHUB_TOKEN}" \
    HAPPIER_MINISIGN_PUBKEY="${MINISIGN_PUBKEY}" \
    HAPPIER_MINISIGN_PUBKEY_URL="${MINISIGN_PUBKEY_URL}" \
    curl -fsSL "https://happier.dev/install" | bash

  export PATH="${CLI_BIN_DIR}:${CLI_INSTALL_DIR}/bin:${PATH}"
  if ! command -v happier >/dev/null 2>&1; then
    echo "happier is still not available after install. Ensure ${CLI_BIN_DIR} is on PATH." >&2
    exit 1
  fi

  if ! happier relay host --help >/dev/null 2>&1; then
    echo "Installed happier does not support 'relay host' yet." >&2
    exit 1
  fi
}

run_relay_host() {
  local sub="$1"; shift || true
  local args=(relay host "${sub}" --channel "$(display_channel_label "${CHANNEL}")" --mode "${MODE}")
  if [[ "${NONINTERACTIVE}" == "1" ]]; then
    args+=(--non-interactive)
  fi
  if [[ "${WANTS_JSON}" == "1" ]]; then
    args+=(--json)
  fi
  if [[ "$#" -gt 0 ]]; then
    args+=("$@")
  fi
  happier "${args[@]}"
}

ensure_happier_cli

case "${ACTION}" in
  version)
    happier --version
    ;;
  check)
    run_relay_host status || true
    run_relay_host doctor
    ;;
  uninstall)
    extra=(--yes)
    if [[ "${PURGE_DATA}" == "1" ]]; then
      extra+=(--purge-data)
    fi
    run_relay_host uninstall "${extra[@]}"
    ;;
  restart)
    # Prefer CLI surface; if not available, fall back to systemctl (still no hstack).
    if happier relay host restart --help >/dev/null 2>&1; then
      run_relay_host restart
    else
      service="${HAPPIER_SELF_HOST_SERVICE_NAME:-happier-server}"
      if [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1; then
        info "Restarting ${service}..."
        if [[ "${MODE}" == "system" ]]; then
          systemctl restart "${service}.service"
        else
          systemctl --user restart "${service}.service"
        fi
      fi
      run_relay_host status || true
    fi
    ;;
  install|reinstall)
    extra=()
    if [[ "${WITH_CLI}" != "1" ]]; then
      extra+=(--without-cli)
    fi
    if [[ "${ACTION}" == "reinstall" ]]; then
      extra+=(--reinstall)
    fi
    run_relay_host install "${extra[@]}"
    ;;
  *)
    echo "Unsupported action: ${ACTION}" >&2
    exit 1
    ;;
esac

