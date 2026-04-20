#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${HAPPIER_CHANNEL:-dev}"
PRODUCT="${HAPPIER_PRODUCT:-cli}"
INSTALL_DIR="${HAPPIER_INSTALL_DIR:-$HOME/.happier}"
BIN_DIR="${HAPPIER_BIN_DIR:-$HOME/.local/bin}"
WITH_DAEMON="${HAPPIER_WITH_DAEMON-}"
WITH_DAEMON_EXPLICIT=0
if [[ -n "${HAPPIER_WITH_DAEMON+x}" ]]; then
  WITH_DAEMON_EXPLICIT=1
fi
NO_PATH_UPDATE="${HAPPIER_NO_PATH_UPDATE:-0}"
NONINTERACTIVE="${HAPPIER_NONINTERACTIVE:-0}"
ACTION="${HAPPIER_INSTALLER_ACTION:-install}" # install|reinstall|version|check|uninstall|restart
RUN_ACTION="${HAPPIER_INSTALLER_RUN_ACTION:-}"
SETUP_RELAY_SHORTCUT="0"
DEBUG_MODE="${HAPPIER_INSTALLER_DEBUG:-0}"
VERBOSE_MODE="${HAPPIER_INSTALLER_VERBOSE:-0}"
PURGE_INSTALL_DIR="${HAPPIER_INSTALLER_PURGE:-0}"
GITHUB_REPO="${HAPPIER_GITHUB_REPO:-happier-dev/happier}"
GITHUB_TOKEN="${HAPPIER_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
RELEASE_ASSETS_DIR="${HAPPIER_RELEASE_ASSETS_DIR:-}"
DEFAULT_MINISIGN_PUBKEY="$(cat <<'EOF'
untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
EOF
)"
MINISIGN_PUBKEY="${HAPPIER_MINISIGN_PUBKEY:-${DEFAULT_MINISIGN_PUBKEY}}"
MINISIGN_PUBKEY_URL="${HAPPIER_MINISIGN_PUBKEY_URL:-https://happier.dev/happier-release.pub}"
MINISIGN_BIN="minisign"

INSTALLER_COLOR_MODE="${HAPPIER_INSTALLER_COLOR:-auto}" # auto|always|never

supports_color() {
  if [[ "${INSTALLER_COLOR_MODE}" == "never" ]]; then
    return 1
  fi
  if [[ -n "${NO_COLOR:-}" ]]; then
    return 1
  fi
  if [[ "${INSTALLER_COLOR_MODE}" == "always" ]]; then
    return 0
  fi
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

say() {
  printf '%s\n' "$*"
}

info() {
  say "${COLOR_CYAN}$*${COLOR_RESET}"
}

success() {
  say "${COLOR_GREEN}$*${COLOR_RESET}"
}

warn() {
  say "${COLOR_YELLOW}$*${COLOR_RESET}"
}

section() {
  echo
  say "${COLOR_BOLD}$*${COLOR_RESET}"
}

installer_bullet() {
  say "  • $*"
}

installer_has_tty_output() {
  [[ -t 1 ]] && [[ -t 2 ]]
}

installer_step_pending_symbol() {
  printf '%s' "${COLOR_CYAN}..${COLOR_RESET}"
}

installer_step_success_symbol() {
  printf '%s' "${COLOR_GREEN}✓${COLOR_RESET}"
}

installer_step_failure_symbol() {
  printf '%s' "${COLOR_YELLOW}x${COLOR_RESET}"
}

run_installer_step() {
  local label="$1"
  shift

  if ! installer_has_tty_output; then
    local tmp_output=""
    if [[ -n "${TMP_DIR:-}" ]]; then
      tmp_output="${TMP_DIR}/installer-step.$$.log"
    else
      tmp_output="$(mktemp)"
    fi

    say "- [..] ${label}"
    if "$@" >"${tmp_output}" 2>&1; then
      say "- [$(installer_step_success_symbol)] ${label}"
      rm -f "${tmp_output}" >/dev/null 2>&1 || true
      return 0
    fi

    say "- [$(installer_step_failure_symbol)] ${label}"
    if [[ -s "${tmp_output}" ]]; then
      cat "${tmp_output}" >&2
    fi
    rm -f "${tmp_output}" >/dev/null 2>&1 || true
    return 1
  fi

  local spinner_frames=('|' '/' '-' '\')
  local frame_index=0
  local tmp_output=""
  if [[ -n "${TMP_DIR:-}" ]]; then
    tmp_output="${TMP_DIR}/installer-step.$$.log"
  else
    tmp_output="$(mktemp)"
  fi

  "$@" >"${tmp_output}" 2>&1 &
  local step_pid=$!

  while kill -0 "${step_pid}" 2>/dev/null; do
    local frame="${spinner_frames[$((frame_index % ${#spinner_frames[@]}))]}"
    printf '\r- [%s] %s' "${COLOR_CYAN}${frame}${COLOR_RESET}" "${label}" >&2
    frame_index=$((frame_index + 1))
    sleep 0.12
  done

  wait "${step_pid}"
  local status=$?
  if [[ "${status}" -eq 0 ]]; then
    printf '\r- [%s] %s\n' "$(installer_step_success_symbol)" "${label}" >&2
    rm -f "${tmp_output}" >/dev/null 2>&1 || true
    return 0
  fi

  printf '\r- [%s] %s\n' "$(installer_step_failure_symbol)" "${label}" >&2
  if [[ -s "${tmp_output}" ]]; then
    cat "${tmp_output}" >&2
  fi
  rm -f "${tmp_output}" >/dev/null 2>&1 || true
  return "${status}"
}

capture_installer_step_output() {
  local label="$1"
  local __resultvar="$2"
  shift 2

  local tmp_output=""
  local tmp_error=""
  if [[ -n "${TMP_DIR:-}" ]]; then
    tmp_output="${TMP_DIR}/installer-capture.$$.out"
    tmp_error="${TMP_DIR}/installer-capture.$$.err"
  else
    tmp_output="$(mktemp)"
    tmp_error="$(mktemp)"
  fi

  if ! installer_has_tty_output; then
    say "- [..] ${label}"
    if "$@" >"${tmp_output}" 2>"${tmp_error}"; then
      say "- [$(installer_step_success_symbol)] ${label}"
      printf -v "${__resultvar}" '%s' "$(cat "${tmp_output}")"
      rm -f "${tmp_output}" "${tmp_error}" >/dev/null 2>&1 || true
      return 0
    fi
    say "- [$(installer_step_failure_symbol)] ${label}" >&2
    cat "${tmp_error}" >&2
    rm -f "${tmp_output}" "${tmp_error}" >/dev/null 2>&1 || true
    return 1
  fi

  local spinner_frames=('|' '/' '-' '\')
  local frame_index=0

  "$@" >"${tmp_output}" 2>"${tmp_error}" &
  local step_pid=$!

  while kill -0 "${step_pid}" 2>/dev/null; do
    local frame="${spinner_frames[$((frame_index % ${#spinner_frames[@]}))]}"
    printf '\r- [%s] %s' "${COLOR_CYAN}${frame}${COLOR_RESET}" "${label}" >&2
    frame_index=$((frame_index + 1))
    sleep 0.12
  done

  if wait "${step_pid}"; then
    printf '\r- [%s] %s\n' "$(installer_step_success_symbol)" "${label}" >&2
    printf -v "${__resultvar}" '%s' "$(cat "${tmp_output}")"
    rm -f "${tmp_output}" "${tmp_error}" >/dev/null 2>&1 || true
    return 0
  fi

  printf '\r- [%s] %s\n' "$(installer_step_failure_symbol)" "${label}" >&2
  if [[ -s "${tmp_error}" ]]; then
    cat "${tmp_error}" >&2
  fi
  rm -f "${tmp_output}" "${tmp_error}" >/dev/null 2>&1 || true
  return 1
}

shell_command_cache_hint() {
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  if [[ "${shell_name}" == "zsh" ]]; then
    say "  rehash"
  else
    say "  hash -r"
  fi
}

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

json_lookup_asset_url() {
  local json="$1"
  local name_regex="$2"
  # GitHub API JSON is typically pretty-printed (newlines + spaces). Avoid "minifying" into one
  # giant line (which can overflow awk line-length limits on some platforms) and instead parse
  # line-by-line within the assets array. We intentionally return the *last* match to support
  # rolling tags that may contain multiple versions: newest assets are appended later in the JSON.
  printf '%s' "$json" | tr '{},' '\n\n\n' | awk -v re="$name_regex" '
    BEGIN {
      in_assets = 0
      name = ""
      last = ""
    }
    {
      raw = $0
      if (in_assets == 0) {
        if (raw ~ /"assets"[[:space:]]*:[[:space:]]*\[/) {
          in_assets = 1
        }
        next
      }

      # End of the assets array. The GitHub API pretty-prints `],` on its own line.
      if (raw ~ /^[[:space:]]*][[:space:]]*,?[[:space:]]*$/) {
        in_assets = 0
        next
      }

      if (raw ~ /"name"[[:space:]]*:[[:space:]]*"/) {
        v = raw
        sub(/^.*"name"[[:space:]]*:[[:space:]]*"/, "", v)
        q = index(v, "\"")
        if (q > 0) {
          name = substr(v, 1, q - 1)
        }
      }

      if (raw ~ /"browser_download_url"[[:space:]]*:[[:space:]]*"/) {
        v = raw
        sub(/^.*"browser_download_url"[[:space:]]*:[[:space:]]*"/, "", v)
        q = index(v, "\"")
        url = ""
        if (q > 0) {
          url = substr(v, 1, q - 1)
        }
        if (name ~ re && url != "") {
          last = url
        }
      }
    }
    END {
      if (last != "") {
        print last
      }
    }
  '
}

find_local_release_asset_path() {
  local name_regex="$1"
  if [[ -z "${RELEASE_ASSETS_DIR}" ]]; then
    return 1
  fi
  if [[ ! -d "${RELEASE_ASSETS_DIR}" ]]; then
    echo "HAPPIER_RELEASE_ASSETS_DIR does not exist: ${RELEASE_ASSETS_DIR}" >&2
    return 1
  fi

  local matched=""
  while IFS= read -r -d '' path; do
    local name
    name="$(basename "${path}")"
    if [[ "${name}" =~ ${name_regex} ]]; then
      matched="${path}"
    fi
  done < <(find "${RELEASE_ASSETS_DIR}" -maxdepth 1 -type f -print0 2>/dev/null)

  if [[ -z "${matched}" ]]; then
    return 1
  fi
  printf '%s' "${matched}"
}

resolve_release_asset_source() {
  local release_json="$1"
  local name_regex="$2"
  if [[ -n "${RELEASE_ASSETS_DIR}" ]]; then
    find_local_release_asset_path "${name_regex}"
    return
  fi
  json_lookup_asset_url "${release_json}" "${name_regex}"
}

download_release_asset_with_retry() {
  local output_path="$1"
  local source="$2"
  local attempts="${HAPPIER_INSTALLER_DOWNLOAD_RETRY_ATTEMPTS:-3}"
  local retry_delay="${HAPPIER_INSTALLER_DOWNLOAD_RETRY_DELAY_SECONDS:-2}"
  local attempt=1
  while true; do
    rm -f "${output_path}"
    if curl_auth -o "${output_path}" "${source}"; then
      return 0
    fi
    if [[ "${attempt}" -ge "${attempts}" ]]; then
      return 1
    fi
    attempt=$((attempt + 1))
    sleep "${retry_delay}"
  done
}

stage_release_asset() {
  local label="$1"
  local output_path="$2"
  local source="$3"
  if [[ -f "${source}" ]]; then
    run_installer_step "${label}" cp "${source}" "${output_path}"
    return
  fi
  run_installer_step "${label}" download_release_asset_with_retry "${output_path}" "${source}"
}

resolve_exe_name() {
  if [[ "${PRODUCT}" == "server" ]]; then
    echo "happier-server"
    return
  fi
  if [[ "${PRODUCT}" == "stack" ]]; then
    echo "hstack"
    return
  fi
  echo "happier"
}

resolve_install_name() {
  if [[ "${PRODUCT}" == "server" ]]; then
    echo "Happier Server"
    return
  fi
  if [[ "${PRODUCT}" == "stack" ]]; then
    echo "Happier Stack"
    return
  else
    echo "Happier CLI"
  fi
}

resolve_shim_name() {
  if [[ "${PRODUCT}" == "cli" ]]; then
    cli_shim_name "${CHANNEL}"
    return
  fi

  local exe
  exe="$(resolve_exe_name)"
  case "${CHANNEL}" in
    stable) echo "${exe}" ;;
    preview) echo "${exe}-preview" ;;
    publicdev) echo "${exe}-dev" ;;
    *) return 1 ;;
  esac
}

resolve_installed_binary() {
  local exe
  exe="$(resolve_shim_name)"
  local candidate="${INSTALL_DIR}/bin/${exe}"
  if [[ -x "${candidate}" ]]; then
    printf '%s' "${candidate}"
    return 0
  fi
  local from_path
  from_path="$(command -v "${exe}" 2>/dev/null || true)"
  if [[ -n "${from_path}" ]] && [[ -x "${from_path}" ]]; then
    printf '%s' "${from_path}"
    return 0
  fi
  return 1
}

action_check() {
  local exe
  exe="$(resolve_exe_name)"
  local shim
  shim="$(resolve_shim_name)"
  local name
  name="$(resolve_install_name)"

  local ok="1"
  local binary_path="${INSTALL_DIR}/bin/${shim}"
  local shim_path="${BIN_DIR}/${shim}"

  info "${name} check"
  say "- product: ${PRODUCT}"
  say "- binary: ${binary_path}"
  say "- shim: ${shim_path}"

  if [[ ! -x "${binary_path}" ]]; then
    warn "Missing binary: ${binary_path}"
    ok="0"
  fi

  if [[ ! -e "${shim_path}" ]]; then
    warn "Missing shim: ${shim_path}"
  fi

  local resolved=""
  resolved="$(command -v "${shim}" 2>/dev/null || true)"
  if [[ -n "${resolved}" ]]; then
    say "- command: ${resolved}"
  else
    warn "Command not found on PATH: ${shim}"
  fi

  local resolved_binary=""
  resolved_binary="$(resolve_installed_binary 2>/dev/null || true)"
  if [[ -n "${resolved_binary}" ]]; then
    local version_out=""
    version_out="$("${resolved_binary}" --version 2>/dev/null || true)"
    if [[ -n "${version_out}" ]]; then
      say "- version: ${version_out}"
    else
      warn "Failed to execute: ${resolved_binary}"
      ok="0"
    fi
  fi

  if command -v file >/dev/null 2>&1 && [[ -x "${binary_path}" ]]; then
    say
    say "file:"
    file "${binary_path}" || true
  fi
  if command -v xattr >/dev/null 2>&1 && [[ -e "${binary_path}" ]]; then
    say
    say "xattr:"
    xattr -l "${binary_path}" 2>/dev/null || true
  fi

  say
  say "Shell tip (if PATH changed in this session):"
  shell_command_cache_hint

  if [[ "${ok}" == "1" ]]; then
    success "OK"
    return 0
  fi
  warn "${name} is not installed correctly."
  return 1
}

action_restart() {
  local exe
  exe="$(resolve_exe_name)"
  local name
  name="$(resolve_install_name)"

  local binary=""
  binary="$(resolve_installed_binary 2>/dev/null || true)"
  if [[ -z "${binary}" ]]; then
    warn "${name} is not installed."
    return 1
  fi
  if [[ "${PRODUCT}" != "cli" ]]; then
    warn "Restart is only supported for the CLI daemon."
    return 1
  fi

  info "Restarting background service (best-effort)..."
  if ! "${binary}" service restart >/dev/null 2>&1; then
    warn "Background service restart failed (it may not be installed)."
    warn "Try: ${binary} service install"
    return 1
  fi
  success "Background service restarted."
  return 0
}

action_uninstall() {
  local exe
  exe="$(resolve_exe_name)"
  local shim
  shim="$(resolve_shim_name)"
  local name
  name="$(resolve_install_name)"

  local binary=""
  binary="$(resolve_installed_binary 2>/dev/null || true)"
  if [[ -n "${binary}" && "${PRODUCT}" == "cli" ]] && ! daemon_service_operations_are_explicitly_disabled; then
    "${binary}" service uninstall >/dev/null 2>&1 || true
  fi

  rm -f "${BIN_DIR}/${shim}" "${INSTALL_DIR}/bin/${shim}.new" "${INSTALL_DIR}/bin/${shim}.previous" || true
  rm -f "${INSTALL_DIR}/bin/${shim}" || true
  if [[ "${PRODUCT}" == "cli" ]]; then
    local root=""
    root="$(cli_managed_install_root "${CHANNEL}")" || {
      echo "Unsupported CLI channel: ${CHANNEL}" >&2
      exit 1
    }
    rm -rf "${INSTALL_DIR}/${root}" || true
  elif [[ "${PRODUCT}" == "server" ]]; then
    local root=""
    root="$(server_managed_install_root "${CHANNEL}")" || {
      echo "Unsupported server channel: ${CHANNEL}" >&2
      exit 1
    }
    rm -rf "${INSTALL_DIR}/${root}" || true
  elif [[ "${PRODUCT}" == "stack" ]]; then
    local root=""
    root="$(stack_managed_install_root "${CHANNEL}")" || {
      echo "Unsupported stack channel: ${CHANNEL}" >&2
      exit 1
    }
    rm -rf "${INSTALL_DIR}/${root}" || true
  fi
  if [[ "${PURGE_INSTALL_DIR}" == "1" ]]; then
    rm -rf "${INSTALL_DIR}" || true
  fi

  success "${name} uninstalled."
  say "Tip: if your shell still can't find changes, run:"
  shell_command_cache_hint
  return 0
}

tar_extract_gz() {
  local archive_path="$1"
  local dest_dir="$2"
  mkdir -p "${dest_dir}"
  # GNU tar on Linux emits noisy, non-actionable warnings when extracting archives created by bsdtar/libarchive:
  #   "Ignoring unknown extended header keyword 'LIBARCHIVE.xattr...'"
  # Filter those while preserving real errors.
  if [[ "${VERBOSE_MODE}" == "1" ]]; then
    tar -xzf "${archive_path}" -C "${dest_dir}"
    return
  fi
  tar -xzf "${archive_path}" -C "${dest_dir}" 2> >(grep -v -E "^tar: Ignoring unknown extended header keyword" >&2 || true)
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

rolling_suffix_for_channel() {
  case "$1" in
    stable) echo "stable" ;;
    preview) echo "preview" ;;
    publicdev) echo "dev" ;;
    *) return 1 ;;
  esac
}

display_channel_label() {
  case "$1" in
    publicdev|dev) echo "dev" ;;
    *) echo "$1" ;;
  esac
}

normalize_installer_boolean() {
  local raw
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "${raw}" in
    1|true|yes|on) echo "1" ;;
    0|false|no|off|'') echo "0" ;;
    *)
      echo "Invalid boolean value '${1}' for background service installation. Expected 0/1, true/false, yes/no, or on/off." >&2
      exit 1
      ;;
  esac
}

default_daemon_install_choice() {
  if [[ "${NONINTERACTIVE}" == "1" ]]; then
    echo "0"
    return
  fi
  case "${CHANNEL}" in
    stable) echo "1" ;;
    *) echo "0" ;;
  esac
}

prompt_for_daemon_install_choice() {
  local default_choice="$1"
  local has_existing_services="${2:-0}"

  if ! installer_has_controlling_tty; then
    echo "0"
    return
  fi

  local channel_label
  channel_label="$(display_channel_label "${CHANNEL}")"
  local default_hint="y/N"
  local recommended_note="recommended: no"
  if [[ "${default_choice}" == "1" ]]; then
    default_hint="Y/n"
    recommended_note="recommended: yes"
  fi

  while true; do
    local prompt_text=""
    if [[ "${has_existing_services}" == "1" ]]; then
      prompt_text="Update background service startup after installing the ${channel_label} release-channel CLI?"
    else
      prompt_text="Install background service for automatic startup on the ${channel_label} release-channel?"
    fi
    printf '%s [%s] (%s) ' \
      "${prompt_text}" \
      "${default_hint}" \
      "${recommended_note}" >/dev/tty
    local answer=""
    if ! IFS= read -r answer </dev/tty; then
      echo "0"
      return
    fi
    answer="$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "${answer}" in
      '')
        echo "${default_choice}"
        return
        ;;
      y|yes)
        echo "1"
        return
        ;;
      n|no)
        echo "0"
        return
        ;;
    esac
    warn "Please answer yes or no."
  done
}

resolve_with_daemon_choice() {
  local services_json="${1:-}"

  if [[ "${PRODUCT}" != "cli" ]] || [[ "${ACTION}" != "install" ]]; then
    echo "0"
    return
  fi

  if [[ "${WITH_DAEMON_EXPLICIT}" == "1" ]]; then
    normalize_installer_boolean "${WITH_DAEMON}"
    return
  fi

  local default_choice
  default_choice="$(default_daemon_install_choice)"
  local has_existing_services="0"
  if background_service_inventory_is_supported "${services_json}" && ! background_service_inventory_is_empty "${services_json}"; then
    has_existing_services="1"
  fi

  if [[ "${NONINTERACTIVE}" == "1" ]]; then
    if [[ "${has_existing_services}" == "1" ]]; then
      echo "1"
      return
    fi
    echo "${default_choice}"
    return
  fi

  prompt_for_daemon_install_choice "${default_choice}" "${has_existing_services}"
}

invoke_installer_command_with_daemon_service_context() {
  local cli_bin="$1"
  shift

  local channel_label=""
  channel_label="$(display_channel_label "${CHANNEL}")"
  local installer_strategy="${HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-}"
  local state_home_dir="${HAPPIER_HOME_DIR:-${INSTALL_DIR}}"

  local -a env_cmd=(env
    "HAPPIER_HOME_DIR=${state_home_dir}"
    "HAPPIER_PUBLIC_RELEASE_CHANNEL=${channel_label}"
    "HAPPIER_DAEMON_SERVICE_CHANNEL=${channel_label}"
    ${installer_strategy:+"HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY=${installer_strategy}"}
  )
  if [[ -n "${HAPPIER_NONINTERACTIVE:-}" ]]; then
    env_cmd+=("HAPPIER_NONINTERACTIVE=${HAPPIER_NONINTERACTIVE}")
  fi
  env_cmd+=("${cli_bin}")
  if [[ $# -gt 0 ]]; then
    env_cmd+=("$@")
  fi

  "${env_cmd[@]}"
}

read_installed_background_service_inventory_json() {
  local cli_bin="$1"
  invoke_installer_command_with_daemon_service_context "${cli_bin}" service list --json 2>/dev/null || true
}

read_background_service_status_json() {
  local cli_bin="$1"
  invoke_installer_command_with_daemon_service_context "${cli_bin}" service status --json 2>/dev/null || true
}

read_background_service_preflight_json() {
  local cli_bin="$1"
  local repair_json=""
  repair_json="$(invoke_installer_command_with_daemon_service_context "${cli_bin}" service repair --json 2>/dev/null || true)"
  if background_service_inventory_json_is_supported "${repair_json}"; then
    printf '%s' "${repair_json}"
    return
  fi
  read_installed_background_service_inventory_json "${cli_bin}"
}

daemon_service_operations_are_explicitly_disabled() {
  if [[ "${WITH_DAEMON_EXPLICIT}" != "1" ]]; then
    return 1
  fi

  local daemon_choice
  daemon_choice="$(normalize_installer_boolean "${WITH_DAEMON}")"
  [[ "${daemon_choice}" == "0" ]]
}

should_read_background_service_preflight() {
  if [[ "${PRODUCT}" != "cli" ]] || [[ "${ACTION}" != "install" ]]; then
    return 1
  fi

  if daemon_service_operations_are_explicitly_disabled; then
    return 1
  fi

  return 0
}

background_service_inventory_is_supported() {
  local services_json="$1"
  background_service_inventory_json_is_supported "${services_json}"
}

background_service_inventory_json_is_supported() {
  local services_json="$1"
  if [[ -z "${services_json}" ]]; then
    return 1
  fi
  printf '%s' "${services_json}" | grep -Eq '^[[:space:]]*{' || return 1
  printf '%s' "${services_json}" | grep -Eq '"(entries|services|existingServices)"[[:space:]]*:'
}

background_service_inventory_is_empty() {
  local services_json="$1"
  background_service_inventory_json_is_empty "${services_json}"
}

background_service_inventory_json_is_empty() {
  local services_json="$1"
  [[ -z "${services_json}" ]] || printf '%s' "${services_json}" | grep -Eq '"(entries|services|existingServices)"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]'
}

background_service_inventory_has_default_following() {
  local services_json="$1"
  background_service_inventory_json_has_default_following "${services_json}"
}

background_service_inventory_json_has_default_following() {
  local services_json="$1"
  printf '%s' "${services_json}" | grep -Eq '"targetMode"[[:space:]]*:[[:space:]]*"default-following"'
}

background_service_inventory_has_system_services() {
  local services_json="$1"
  background_service_inventory_json_has_system_services "${services_json}"
}

background_service_inventory_json_has_system_services() {
  local services_json="$1"
  printf '%s' "${services_json}" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"system"'
}

background_service_repair_requires_sudo() {
  local services_json="$1"
  if [[ "$(detect_os)" != "linux" ]]; then
    return 1
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    return 1
  fi
  background_service_inventory_has_system_services "${services_json}"
}

background_service_repair_manual_command() {
  local cli_bin="$1"
  local services_json="$2"
  if background_service_repair_requires_sudo "${services_json}"; then
    printf 'sudo %s service repair --yes' "${cli_bin}"
    return
  fi
  printf '%s service repair --yes' "${cli_bin}"
}

json_first_string_value() {
  local json="$1"
  local key="$2"
  printf '%s' "${json}" | sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" | head -n 1
}

json_first_boolean_value() {
  local json="$1"
  local key="$2"
  printf '%s' "${json}" | sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*(true|false|null).*/\\1/p" | head -n 1
}

json_first_integer_value() {
  local json="$1"
  local key="$2"
  printf '%s' "${json}" | sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+|null).*/\\1/p" | head -n 1
}

print_installed_background_service_status_summary() {
  local status_json="$1"

  if [[ -z "${status_json}" ]] || [[ "${status_json}" != *'"owner"'* ]]; then
    return
  fi

  local daemon_running=""
  daemon_running="$(json_first_boolean_value "${status_json}" 'running')"
  local daemon_pid=""
  daemon_pid="$(json_first_integer_value "${status_json}" 'pid')"
  if [[ "${daemon_running}" == "true" && "${daemon_pid}" != "null" && -n "${daemon_pid}" ]]; then
    installer_bullet "Running now: yes (pid ${daemon_pid})"
  elif [[ "${daemon_running}" == "true" ]]; then
    installer_bullet "Running now: yes"
  else
    installer_bullet "Running now: no"
  fi

  local owner_is_null=""
  owner_is_null="$(json_first_boolean_value "${status_json}" 'owner')"
  if [[ "${owner_is_null}" == "null" ]]; then
    return
  fi

  local service_managed=""
  service_managed="$(json_first_boolean_value "${status_json}" 'serviceManaged')"
  if [[ "${service_managed}" == "true" ]]; then
    installer_bullet "Current owner: background service"
  elif [[ "${service_managed}" == "false" ]]; then
    installer_bullet "Current owner: manual relay runtime"
  else
    installer_bullet "Current owner: relay owner"
  fi

  local owner_ring=""
  owner_ring="$(json_first_string_value "${status_json}" 'startedWithPublicReleaseChannel')"
  local owner_version=""
  owner_version="$(json_first_string_value "${status_json}" 'startedWithCliVersion')"
  if [[ -n "${owner_ring}" || -n "${owner_version}" ]]; then
    installer_bullet "Owner CLI: ${owner_ring:-unknown} • ${owner_version:-unknown}"
  fi

  local invocation_matches=""
  invocation_matches="$(json_first_boolean_value "${status_json}" 'currentInvocationMatches')"
  if [[ "${invocation_matches}" == "false" ]]; then
    if [[ "${service_managed}" == "true" ]]; then
      warn "Current CLI differs from the running background service. Use \`happier service restart\` if you want automatic startup to switch to this installation."
    elif [[ "${service_managed}" == "false" ]]; then
      warn "Current CLI differs from the running manual relay runtime. Use \`happier daemon restart\` if you want the manual relay runtime to switch to this installation."
    else
      warn "Current CLI differs from the running relay owner. Restart the current relay owner before trying to switch this installation."
    fi
  fi
}

print_installed_background_service_entries() {
  local services_text="$1"
  if [[ -z "${services_text}" ]]; then
    return
  fi

  while IFS= read -r line; do
    if [[ -z "${line}" ]]; then
      continue
    fi
    if [[ "${line}" == "  "* ]]; then
      say "    ${line#"  "}"
      continue
    fi
    installer_bullet "${line}"
  done <<< "${services_text}"
}

print_installed_background_service_summary() {
  local cli_bin="$1"
  local services_json="$2"
  local status_json="$3"

  if ! background_service_inventory_is_supported "${services_json}" || background_service_inventory_is_empty "${services_json}"; then
    return
  fi

  section "Background Service"
  local services_text=""
  services_text="$(invoke_installer_command_with_daemon_service_context "${cli_bin}" service list 2>/dev/null || true)"
  print_installed_background_service_entries "${services_text}"
  print_installed_background_service_status_summary "${status_json}"

  if background_service_repair_requires_sudo "${services_json}"; then
    echo
    warn "${COLOR_BOLD}System background services are installed.${COLOR_RESET}"
    installer_bullet "Repairing or switching automatic startup for these services requires sudo on Linux."
  fi

  echo
  if background_service_inventory_has_default_following "${services_json}"; then
    warn "${COLOR_BOLD}Automatic startup still follows the current managed default release-channel.${COLOR_RESET}"
    installer_bullet "Switch it to this release-channel only if you want automatic startup to follow this CLI."
    installer_bullet "Keep it unchanged if you only want to use this CLI interactively."
    installer_bullet "Interactive session commands will not replace the current relay owner unless you explicitly switch or take it over."
    return
  fi

  warn "${COLOR_BOLD}Pinned background services keep their current release-channels and relay targets until you replace them.${COLOR_RESET}"
  installer_bullet "Installing this CLI alone does not move automatic startup to this lane."
  installer_bullet "Interactive session commands will not replace the current relay owner unless you explicitly switch or take it over."
}

installer_has_controlling_tty() {
  if [[ ! -t 0 && ! -t 1 && ! -t 2 ]]; then
    return 1
  fi
  if exec 3<>/dev/tty 2>/dev/null; then
    exec 3>&-
    exec 3<&-
    return 0
  fi
  return 1
}

resolve_existing_background_service_install_strategy() {
  local services_json="$1"

  if [[ "${PRODUCT}" != "cli" ]] || [[ "${ACTION}" != "install" ]]; then
    echo ""
    return
  fi

  if [[ "${NONINTERACTIVE}" == "1" ]]; then
    echo ""
    return
  fi

  if background_service_inventory_is_empty "${services_json}"; then
    echo ""
    return
  fi

  if ! installer_has_controlling_tty; then
    echo "skip"
    return
  fi

  local replace_prompt="Existing background services detected. Replace them with this installation?"
  if background_service_inventory_has_default_following "${services_json}"; then
    replace_prompt="A default background service is already installed. Switch the managed default background service to this release-channel?"
  fi

  while true; do
    printf '%s [Y/n] (recommended: yes) ' "${replace_prompt}" >/dev/tty
    local replace_answer=""
    if ! IFS= read -r replace_answer </dev/tty; then
      echo ""
      return
    fi
    replace_answer="$(printf '%s' "${replace_answer}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "${replace_answer}" in
      ''|y|yes)
        echo "replace-all"
        return
        ;;
      n|no)
        break
        ;;
    esac
    warn "Please answer yes or no."
  done

  if background_service_inventory_has_default_following "${services_json}"; then
    echo "skip"
    return
  fi

  while true; do
    printf 'Install an additional background service alongside the existing one(s)? [y/N] (recommended: no) ' >/dev/tty
    local add_answer=""
    if ! IFS= read -r add_answer </dev/tty; then
      echo "skip"
      return
    fi
    add_answer="$(printf '%s' "${add_answer}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "${add_answer}" in
      y|yes)
        echo "add"
        return
        ;;
      ''|n|no)
        echo "skip"
        return
        ;;
    esac
    warn "Please answer yes or no."
  done
}

resolve_release_tag() {
  local product="$1"
  local channel="$2"
  local suffix=""
  suffix="$(rolling_suffix_for_channel "${channel}")" || return 1
  case "${product}" in
    cli) echo "cli-${suffix}" ;;
    server) echo "server-${suffix}" ;;
    stack) echo "stack-${suffix}" ;;
    *) return 1 ;;
  esac
}

cli_managed_install_root() {
  case "$1" in
    stable) echo "cli" ;;
    preview) echo "cli-preview" ;;
    publicdev) echo "cli-dev" ;;
    *) return 1 ;;
  esac
}

cli_shim_name() {
  case "$1" in
    stable) echo "happier" ;;
    preview) echo "hprev" ;;
    publicdev) echo "hdev" ;;
    *) return 1 ;;
  esac
}

server_managed_install_root() {
  case "$1" in
    stable) echo "server" ;;
    preview) echo "server-preview" ;;
    publicdev) echo "server-dev" ;;
    *) return 1 ;;
  esac
}

stack_managed_install_root() {
  case "$1" in
    stable) echo "stack" ;;
    preview) echo "stack-preview" ;;
    publicdev) echo "stack-dev" ;;
    *) return 1 ;;
  esac
}

action_version() {
  local name
  name="$(resolve_install_name)"

  if [[ "${CHANNEL}" != "stable" && "${CHANNEL}" != "preview" && "${CHANNEL}" != "publicdev" ]]; then
    echo "Invalid HAPPIER_CHANNEL='${CHANNEL}'. Expected stable, preview, or dev." >&2
    return 1
  fi

  local os=""
  local arch=""
  os="$(detect_os)"
  arch="$(detect_arch)"
  if [[ "${os}" == "unsupported" || "${arch}" == "unsupported" ]]; then
    echo "Unsupported platform: $(uname -s)/$(uname -m)" >&2
    return 1
  fi

  local tag=""
  local asset_regex="^happier-v.*-${os}-${arch}[.]tar[.]gz$"
  local version_prefix="happier-v"
  if [[ "${PRODUCT}" == "server" ]]; then
    asset_regex="^happier-server-v.*-${os}-${arch}[.]tar[.]gz$"
    version_prefix="happier-server-v"
  fi
  if [[ "${PRODUCT}" == "stack" ]]; then
    asset_regex="^hstack-v.*-${os}-${arch}[.]tar[.]gz$"
    version_prefix="hstack-v"
  fi
  tag="$(resolve_release_tag "${PRODUCT}" "${CHANNEL}")" || {
    echo "Unsupported product/channel combination: ${PRODUCT}/${CHANNEL}" >&2
    return 1
  }

  local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}"
  curl_auth() {
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
      curl -fsSL \
        -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "$@"
      return
    fi
    curl -fsSL "$@"
  }

  local release_json=""
  if [[ -z "${RELEASE_ASSETS_DIR}" ]]; then
    info "Fetching ${tag} release metadata..."
    if ! release_json="$(curl_auth "${api_url}")"; then
      echo "Failed to fetch release metadata for ${name}." >&2
      return 1
    fi
  fi
  local asset_source=""
  asset_source="$(resolve_release_asset_source "${release_json}" "${asset_regex}")"
  if [[ -z "${asset_source}" ]]; then
    echo "Unable to locate release assets for ${OS}-${ARCH} on tag ${tag}." >&2
    return 1
  fi
  local asset_name=""
  asset_name="$(basename "${asset_source}")"
  local version=""
  version="${asset_name#${version_prefix}}"
  version="${version%-${os}-${arch}.tar.gz}"
  if [[ -z "${version}" || "${version}" == "${asset_name}" ]]; then
    echo "Failed to infer release version from asset name: ${asset_name}" >&2
    return 1
  fi

  say "${name} installer version check"
  say "- channel: $(display_channel_label "${CHANNEL}")"
  say "- product: ${PRODUCT}"
  say "- platform: ${os}-${arch}"
  say "- version: ${version}"
  return 0
}

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://happier.dev/install | bash

Preview channel:
  curl -fsSL https://happier.dev/install | bash -s -- --channel preview
  curl -fsSL https://happier.dev/install | HAPPIER_CHANNEL=preview bash
  curl -fsSL https://happier.dev/install-preview | bash

Dev channel:
  curl -fsSL https://happier.dev/install | bash -s -- --channel dev
  curl -fsSL https://happier.dev/install | HAPPIER_CHANNEL=dev bash
  curl -fsSL https://happier.dev/install-dev | bash

Relay setup (install CLI if needed, then host a relay locally):
  curl -fsSL https://happier.dev/install | bash -s -- --setup-relay
  curl -fsSL https://happier.dev/install | bash -s -- --channel dev --setup-relay

Options:
  --channel <stable|preview|dev>
  --stable
  --preview
  --dev
  --run <setup-relay|setup|auth-login|service-install|providers-setup>
  --setup-relay
  --with-daemon
  --without-daemon
  --check
  --version
  --reinstall
  --restart
  --uninstall [--purge]
  --reset
  --verbose
  --debug
  -h, --help
EOF
}

RUN_ACTION_DEFAULT_ARGS=()
RUN_ACTION_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Missing value for --channel" >&2
        usage >&2
        exit 1
      fi
      CHANNEL="${2}"
      shift 2
      ;;
    --channel=*)
      CHANNEL="${1#*=}"
      if [[ -z "${CHANNEL}" ]]; then
        echo "Missing value for --channel" >&2
        usage >&2
        exit 1
      fi
      shift 1
      ;;
    --stable)
      CHANNEL="stable"
      shift 1
      ;;
    --preview)
      CHANNEL="preview"
      shift 1
      ;;
    --dev)
      CHANNEL="dev"
      shift 1
      ;;
    --with-daemon)
      WITH_DAEMON="1"
      WITH_DAEMON_EXPLICIT=1
      shift 1
      ;;
    --without-daemon)
      WITH_DAEMON="0"
      WITH_DAEMON_EXPLICIT=1
      shift 1
      ;;
    --run)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Missing value for --run" >&2
        usage >&2
        exit 1
      fi
      RUN_ACTION="${2}"
      shift 2
      ;;
    --run=*)
      RUN_ACTION="${1#*=}"
      if [[ -z "${RUN_ACTION}" ]]; then
        echo "Missing value for --run" >&2
        usage >&2
        exit 1
      fi
      shift 1
      ;;
    --setup-relay)
      RUN_ACTION="setup-relay"
      SETUP_RELAY_SHORTCUT="1"
      shift 1
      ;;
    --check)
      ACTION="check"
      shift 1
      ;;
    --version)
      ACTION="version"
      shift 1
      ;;
    --reinstall)
      ACTION="install"
      shift 1
      ;;
    --restart)
      ACTION="restart"
      shift 1
      ;;
    --uninstall)
      ACTION="uninstall"
      shift 1
      ;;
    --reset)
      ACTION="uninstall"
      PURGE_INSTALL_DIR="1"
      shift 1
      ;;
    --purge)
      PURGE_INSTALL_DIR="1"
      shift 1
      ;;
    --verbose)
      VERBOSE_MODE="1"
      shift 1
      ;;
    --debug)
      DEBUG_MODE="1"
      VERBOSE_MODE="1"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift 1
      RUN_ACTION_ARGS+=("$@")
      break
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

CHANNEL="$(normalize_channel "${CHANNEL}")"

if [[ "${RUN_ACTION}" == "setup-relay" && ${#RUN_ACTION_DEFAULT_ARGS[@]} -eq 0 ]]; then
  RUN_ACTION_DEFAULT_ARGS=(--mode user --yes --channel "$(display_channel_label "${CHANNEL}")" --preserve-active-server)
fi

if [[ "${DEBUG_MODE}" == "1" ]]; then
  VERBOSE_MODE="1"
  set -x
fi

if [[ "${PRODUCT}" != "cli" && "${PRODUCT}" != "server" && "${PRODUCT}" != "stack" ]]; then
  echo "Invalid HAPPIER_PRODUCT='${PRODUCT}'. Expected cli, server, or stack." >&2
  exit 1
fi

resolve_installed_cli_invoker_for_channel() {
  local channel="$1"
  local shim_name=""
  shim_name="$(cli_shim_name "${channel}" 2>/dev/null || true)"
  if [[ -z "${shim_name}" ]]; then
    return 1
  fi

  local managed_root=""
  managed_root="$(cli_managed_install_root "${channel}" 2>/dev/null || true)"
  if [[ -n "${managed_root}" ]]; then
    local managed_bin="${INSTALL_DIR}/${managed_root}/current/happier"
    if [[ -x "${managed_bin}" ]]; then
      printf '%s' "${managed_bin}"
      return 0
    fi
  fi

  local installed_shim="${INSTALL_DIR}/bin/${shim_name}"
  if [[ -x "${installed_shim}" ]]; then
    printf '%s' "${installed_shim}"
    return 0
  fi

  local global_shim="${BIN_DIR}/${shim_name}"
  if [[ -x "${global_shim}" ]]; then
    printf '%s' "${global_shim}"
    return 0
  fi

  local from_path=""
  from_path="$(command -v "${shim_name}" 2>/dev/null || true)"
  if [[ -n "${from_path}" ]] && [[ -x "${from_path}" ]]; then
    printf '%s' "${from_path}"
    return 0
  fi

  return 1
}

run_post_install_action() {
  local cli_bin="$1"

  if [[ "${PRODUCT}" != "cli" ]]; then
    echo "--run is only supported when installing the CLI." >&2
    return 1
  fi

  local op="${RUN_ACTION}"
  local -a cmd=()
  local required_subcommand=""
  case "${op}" in
    setup-relay|relay-host-install)
      cmd=(relay host install)
      required_subcommand="relay"
      ;;
    setup)
      cmd=(setup)
      required_subcommand="setup"
      ;;
    auth-login)
      cmd=(auth login)
      required_subcommand="auth"
      ;;
    service-install|daemon-install)
      cmd=(service install)
      required_subcommand="service"
      ;;
    providers-setup)
      cmd=(providers setup)
      required_subcommand="providers"
      ;;
    *)
      echo "Unknown --run action: ${op}" >&2
      echo "Expected one of: setup-relay, setup, auth-login, service-install, providers-setup" >&2
      return 1
      ;;
  esac

  # Guard against older CLI builds where unknown subcommands fall through into the
  # default "start a session" path (which can prompt for authentication).
  # We fail fast with a clear message instead of launching an unrelated flow.
  if [[ -n "${required_subcommand}" ]]; then
    local help_output=""
    if [[ "${required_subcommand}" == "relay" ]]; then
      help_output="$("${cli_bin}" relay --help 2>/dev/null || true)"
    else
      help_output="$("${cli_bin}" --help 2>/dev/null || true)"
    fi
    local help_prefix=""
    help_prefix="$(basename "${cli_bin}" 2>/dev/null || true)"
    if [[ -z "${help_prefix}" ]]; then
      help_prefix="happier"
    fi
    if ! printf '%s\n' "${help_output}" | grep -Eq "^[[:space:]]*(${help_prefix}|happier)[[:space:]]+${required_subcommand}\\b"; then
      echo "Installed Happier CLI does not support the '${required_subcommand}' command surface required for --run ${op}." >&2
      echo "Update your Happier CLI (or switch installer channel) and try again." >&2
      return 1
    fi
  fi

  local -a args=()
  if [[ ${#RUN_ACTION_DEFAULT_ARGS[@]} -gt 0 ]]; then
    args+=("${RUN_ACTION_DEFAULT_ARGS[@]}")
  fi
  if [[ ${#RUN_ACTION_ARGS[@]} -gt 0 ]]; then
    args+=("${RUN_ACTION_ARGS[@]}")
  fi

  local -a command_args=("${cmd[@]}")
  if [[ ${#args[@]} -gt 0 ]]; then
    command_args+=("${args[@]}")
  fi

  invoke_installer_command_with_daemon_service_context "${cli_bin}" "${command_args[@]}"
}

if [[ "${ACTION}" == "check" ]]; then
  action_check
  exit $?
fi
if [[ "${ACTION}" == "version" ]]; then
  action_version
  exit $?
fi
if [[ "${ACTION}" == "restart" ]]; then
  action_restart
  exit $?
fi
if [[ "${ACTION}" == "uninstall" ]]; then
  action_uninstall
  exit $?
fi

if [[ -n "${RUN_ACTION}" ]]; then
  if [[ "${PRODUCT}" != "cli" ]]; then
    echo "--run is only supported when installing the CLI." >&2
    exit 1
  fi
  if [[ "${ACTION}" != "install" ]]; then
    echo "--run cannot be combined with installer actions like --check/--version/--uninstall." >&2
    exit 1
  fi
  INSTALLED_CLI_BIN="$(resolve_installed_cli_invoker_for_channel "${CHANNEL}" 2>/dev/null || true)"
  if [[ -n "${INSTALLED_CLI_BIN}" && ! ( "${SETUP_RELAY_SHORTCUT}" == "1" && "${RUN_ACTION}" == "setup-relay" ) ]]; then
    run_post_install_action "${INSTALLED_CLI_BIN}"
    exit $?
  fi
fi

if [[ "${CHANNEL}" != "stable" && "${CHANNEL}" != "preview" && "${CHANNEL}" != "publicdev" ]]; then
  echo "Invalid HAPPIER_CHANNEL='${CHANNEL}'. Expected stable, preview, or dev." >&2
  exit 1
fi

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
    return
  fi
  echo "Neither sha256sum nor shasum is available." >&2
  exit 1
}

ensure_minisign() {
  if command -v minisign >/dev/null 2>&1; then
    MINISIGN_BIN="minisign"
    return 0
  fi

  # Self-contained fallback: download a known minisign release asset into TMP_DIR.
  # We pin checksums to avoid relying on OS package managers.
  local minisign_version="0.12"
  local os="$(detect_os)"
  local asset=""
  local expected_sha=""
  local url_base="https://github.com/jedisct1/minisign/releases/download/${minisign_version}"

  if [[ "${os}" == "linux" ]]; then
    asset="minisign-${minisign_version}-linux.tar.gz"
    expected_sha="9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73"
  elif [[ "${os}" == "darwin" ]]; then
    asset="minisign-${minisign_version}-macos.zip"
    expected_sha="89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63"
  else
    return 1
  fi

  local archive_path="${TMP_DIR}/${asset}"
  curl -fsSL "${url_base}/${asset}" -o "${archive_path}"
  local actual_sha
  actual_sha="$(sha256_file "${archive_path}")"
  if [[ "${actual_sha}" != "${expected_sha}" ]]; then
    echo "minisign bootstrap checksum mismatch (expected ${expected_sha}, got ${actual_sha})." >&2
    return 1
  fi

  local extract_dir="${TMP_DIR}/minisign-extract"
  mkdir -p "${extract_dir}"
  if [[ "${asset}" == *.tar.gz ]]; then
    tar_extract_gz "${archive_path}" "${extract_dir}"
  else
    # Prefer built-in macOS tooling to avoid requiring unzip.
    if command -v ditto >/dev/null 2>&1; then
      if ! ditto -x -k "${archive_path}" "${extract_dir}" >/dev/null 2>&1; then
        echo "ditto failed to extract minisign archive; falling back to unzip if available." >&2
      fi
    fi
    local extracted_bin=""
    extracted_bin="$(find "${extract_dir}" -type f -name minisign 2>/dev/null | head -n 1 || true)"
    if [[ -n "${extracted_bin}" ]]; then
      chmod +x "${extracted_bin}" || true
    fi
    if [[ -z "${extracted_bin}" ]] || [[ ! -x "${extracted_bin}" ]]; then
      if ! command -v unzip >/dev/null 2>&1; then
        echo "Failed to bootstrap minisign on macOS: ditto failed and unzip is not available." >&2
        return 1
      fi
      unzip -q "${archive_path}" -d "${extract_dir}"
    fi
  fi

  local bin_path=""
  if [[ "${os}" == "linux" ]]; then
    local minisign_arch=""
    case "$(uname -m)" in
      x86_64|amd64) minisign_arch="x86_64" ;;
      arm64|aarch64) minisign_arch="aarch64" ;;
      *) minisign_arch="" ;;
    esac
    if [[ -n "${minisign_arch}" ]]; then
      bin_path="$(find "${extract_dir}" -type f -path "*/minisign-linux/${minisign_arch}/minisign" 2>/dev/null | head -n 1 || true)"
    fi
  fi
  if [[ -z "${bin_path}" ]]; then
    bin_path="$(find "${extract_dir}" -type f -name minisign 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -n "${bin_path}" ]]; then
    chmod +x "${bin_path}" || true
  fi
  if [[ -z "${bin_path}" ]] || [[ ! -x "${bin_path}" ]]; then
    echo "Failed to locate minisign binary in bootstrap archive." >&2
    return 1
  fi
  MINISIGN_BIN="${bin_path}"
  return 0
}

write_minisign_public_key() {
  local target_path="$1"
  if [[ -n "${MINISIGN_PUBKEY}" ]]; then
    printf '%s\n' "${MINISIGN_PUBKEY}" > "${target_path}"
    return
  fi
  if [[ -z "${MINISIGN_PUBKEY_URL}" ]]; then
    echo "HAPPIER_MINISIGN_PUBKEY_URL is empty; cannot fetch minisign public key." >&2
    exit 1
  fi
  curl -fsSL "${MINISIGN_PUBKEY_URL}" -o "${target_path}"
}

append_path_hint() {
  if [[ "${NO_PATH_UPDATE}" == "1" ]]; then
    return
  fi
  upsert_shell_export_line() {
    local rc_file="$1"
    local export_key="$2"
    local export_line="$3"
    local tmp_file="${rc_file}.happier-tmp.$$"

    if [[ ! -f "${rc_file}" ]]; then
      printf '\n%s\n' "${export_line}" >> "${rc_file}"
      return
    fi

    awk -v export_key="${export_key}" -v export_line="${export_line}" '
      BEGIN {
        replaced = 0
      }
      $0 ~ ("^[[:space:]]*export[[:space:]]+" export_key "=") {
        if (replaced == 0) {
          print export_line
          replaced = 1
        }
        next
      }
      {
        print
      }
      END {
        if (replaced == 0) {
          print ""
          print export_line
        }
      }
    ' "${rc_file}" > "${tmp_file}"
    mv "${tmp_file}" "${rc_file}"
  }
  remove_shell_export_line() {
    local rc_file="$1"
    local export_key="$2"
    local tmp_file="${rc_file}.happier-tmp.$$"

    if [[ ! -f "${rc_file}" ]]; then
      return
    fi

    awk -v export_key="${export_key}" '
      $0 ~ ("^[[:space:]]*export[[:space:]]+" export_key "=") {
        next
      }
      {
        print
      }
    ' "${rc_file}" > "${tmp_file}"
    mv "${tmp_file}" "${rc_file}"
  }
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  local export_line="export PATH=\"${BIN_DIR}:\$PATH\""
  local home_export_line=""
  local default_install_dir="${HOME}/.happier"
  if [[ "${INSTALL_DIR}" != "${default_install_dir}" ]]; then
    home_export_line="export HAPPIER_HOME_DIR=\"${INSTALL_DIR}\""
  fi
  local rc_files=()
  case "${shell_name}" in
    zsh)
      rc_files+=("$HOME/.zshrc")
      rc_files+=("$HOME/.zprofile")
      ;;
    bash)
      rc_files+=("$HOME/.bashrc")
      if [[ -f "$HOME/.bash_profile" ]]; then
        rc_files+=("$HOME/.bash_profile")
      else
        rc_files+=("$HOME/.profile")
      fi
      ;;
    *)
      rc_files+=("$HOME/.profile")
      ;;
  esac

  local updated=0
  for rc_file in "${rc_files[@]}"; do
    if [[ ! -f "${rc_file}" ]] || ! grep -Fq "${export_line}" "${rc_file}"; then
      printf '\n%s\n' "${export_line}" >> "${rc_file}"
      info "Added ${BIN_DIR} to PATH in ${rc_file}"
      updated=1
    fi
    if [[ -n "${home_export_line}" ]]; then
      if [[ ! -f "${rc_file}" ]] || ! grep -Eq "^[[:space:]]*export[[:space:]]+HAPPIER_HOME_DIR=" "${rc_file}"; then
        printf '\n%s\n' "${home_export_line}" >> "${rc_file}"
        info "Persisted HAPPIER_HOME_DIR=${INSTALL_DIR} in ${rc_file}"
        updated=1
      elif ! grep -Fxq "${home_export_line}" "${rc_file}" || [[ "$(grep -Ec "^[[:space:]]*export[[:space:]]+HAPPIER_HOME_DIR=" "${rc_file}")" -ne 1 ]]; then
        upsert_shell_export_line "${rc_file}" "HAPPIER_HOME_DIR" "${home_export_line}"
        info "Persisted HAPPIER_HOME_DIR=${INSTALL_DIR} in ${rc_file}"
        updated=1
      fi
    elif [[ -f "${rc_file}" ]] && grep -Eq "^[[:space:]]*export[[:space:]]+HAPPIER_HOME_DIR=" "${rc_file}"; then
      remove_shell_export_line "${rc_file}" "HAPPIER_HOME_DIR"
      info "Removed stale HAPPIER_HOME_DIR from ${rc_file}"
      updated=1
    fi
  done

  if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    echo
    say "${COLOR_BOLD}Next steps${COLOR_RESET}"
    say "To use ${EXE_NAME} in your current shell:"
    say "  export PATH=\"${BIN_DIR}:\$PATH\""
    if [[ -n "${home_export_line}" ]]; then
      say "  export HAPPIER_HOME_DIR=\"${INSTALL_DIR}\""
    fi
    if [[ "${shell_name}" == "bash" ]]; then
      say "  source \"$HOME/.bashrc\""
      if [[ -f "$HOME/.bash_profile" ]]; then
        say "  source \"$HOME/.bash_profile\""
      else
        say "  source \"$HOME/.profile\""
      fi
    elif [[ "${shell_name}" == "zsh" ]]; then
      say "  source \"$HOME/.zshrc\""
    else
      say "  source \"$HOME/.profile\""
    fi
    say "If your shell still can't find ${EXE_NAME}, run:"
    shell_command_cache_hint
    say "Or open a new terminal."
  elif [[ "${updated}" == "1" ]]; then
    echo
    say "PATH is already configured in this shell."
  fi
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
if [[ "${OS}" == "unsupported" || "${ARCH}" == "unsupported" ]]; then
  echo "Unsupported platform: $(uname -s)/$(uname -m)" >&2
  if [[ "${PRODUCT}" == "cli" ]]; then
    echo "Fallback: npm install -g @happier-dev/cli" >&2
  elif [[ "${PRODUCT}" == "stack" ]]; then
    echo "Fallback: npx --yes -p @happier-dev/stack@latest hstack --help" >&2
  else
    echo "Fallback: npx --yes --package @happier-dev/relay-server happier-server --help" >&2
  fi
  exit 1
fi

TAG=""
ASSET_REGEX="^happier-v.*-${OS}-${ARCH}[.]tar[.]gz$"
CHECKSUMS_REGEX="^checksums-happier-v.*[.]txt$"
SIG_REGEX="^checksums-happier-v.*[.]txt[.]minisig$"
EXE_NAME="happier"
INSTALL_NAME="Happier CLI"
VERSION_PREFIX="happier-v"
CHECKSUMS_PREFIX="checksums-happier-v"

if [[ "${PRODUCT}" == "server" ]]; then
  ASSET_REGEX="^happier-server-v.*-${OS}-${ARCH}[.]tar[.]gz$"
  CHECKSUMS_REGEX="^checksums-happier-server-v.*[.]txt$"
  SIG_REGEX="^checksums-happier-server-v.*[.]txt[.]minisig$"
  EXE_NAME="happier-server"
  INSTALL_NAME="Happier Server"
  VERSION_PREFIX="happier-server-v"
  CHECKSUMS_PREFIX="checksums-happier-server-v"
fi

if [[ "${PRODUCT}" == "stack" ]]; then
  ASSET_REGEX="^hstack-v.*-${OS}-${ARCH}[.]tar[.]gz$"
  CHECKSUMS_REGEX="^checksums-hstack-v.*[.]txt$"
  SIG_REGEX="^checksums-hstack-v.*[.]txt[.]minisig$"
  EXE_NAME="hstack"
  INSTALL_NAME="Happier Stack"
  VERSION_PREFIX="hstack-v"
  CHECKSUMS_PREFIX="checksums-hstack-v"
fi

TAG="$(resolve_release_tag "${PRODUCT}" "${CHANNEL}")" || {
  echo "Unsupported product/channel combination: ${PRODUCT}/${CHANNEL}" >&2
  exit 1
}

API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
curl_auth() {
  local -a curl_args
  curl_args=(-fsSL --show-error)
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl "${curl_args[@]}" \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$@"
    return
  fi
  curl "${curl_args[@]}" "$@"
}

RELEASE_JSON=""
if [[ -z "${RELEASE_ASSETS_DIR}" ]]; then
  if ! capture_installer_step_output "Fetching ${TAG} release metadata" RELEASE_JSON curl_auth "${API_URL}"; then
    if [[ "${CHANNEL}" == "stable" ]]; then
      echo "No stable releases found for ${INSTALL_NAME}." >&2
    elif [[ "${CHANNEL}" == "publicdev" ]]; then
      echo "No dev releases found for ${INSTALL_NAME}." >&2
    else
      echo "No preview releases found for ${INSTALL_NAME}." >&2
    fi
    exit 1
  fi
fi

ASSET_SOURCE="$(resolve_release_asset_source "${RELEASE_JSON}" "${ASSET_REGEX}")"
if [[ -z "${ASSET_SOURCE}" ]]; then
  echo "Unable to locate release assets for ${OS}-${ARCH} on tag ${TAG}." >&2
  exit 1
fi

ASSET_NAME="$(basename "${ASSET_SOURCE}")"
VERSION="${ASSET_NAME#${VERSION_PREFIX}}"
VERSION="${VERSION%-${OS}-${ARCH}.tar.gz}"
if [[ -z "${VERSION}" || "${VERSION}" == "${ASSET_NAME}" ]]; then
  echo "Failed to infer release version from asset name: ${ASSET_NAME}" >&2
  exit 1
fi

CHECKSUMS_REGEX="^${CHECKSUMS_PREFIX}${VERSION}[.]txt$"
SIG_REGEX="^${CHECKSUMS_PREFIX}${VERSION}[.]txt[.]minisig$"
CHECKSUMS_SOURCE="$(resolve_release_asset_source "${RELEASE_JSON}" "${CHECKSUMS_REGEX}")"
SIG_SOURCE="$(resolve_release_asset_source "${RELEASE_JSON}" "${SIG_REGEX}")"
if [[ -z "${CHECKSUMS_SOURCE}" || -z "${SIG_SOURCE}" ]]; then
  echo "Unable to locate release assets for ${OS}-${ARCH} on tag ${TAG}." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  if [[ "${DEBUG_MODE}" == "1" || "${VERBOSE_MODE}" == "1" ]]; then
    return
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_PATH="${TMP_DIR}/happier.tar.gz"
CHECKSUMS_PATH="${TMP_DIR}/checksums.txt"
stage_release_asset "Downloading release archive" "${ARCHIVE_PATH}" "${ASSET_SOURCE}"
stage_release_asset "Downloading checksums" "${CHECKSUMS_PATH}" "${CHECKSUMS_SOURCE}"

EXPECTED_SHA="$(grep -E "  $(basename "${ASSET_SOURCE}")$" "${CHECKSUMS_PATH}" | awk '{print $1}' | head -n 1)"
if [[ -z "${EXPECTED_SHA}" ]]; then
  echo "Failed to resolve checksum for $(basename "${ASSET_SOURCE}")" >&2
  exit 1
fi
ACTUAL_SHA="$(sha256_file "${ARCHIVE_PATH}")"
if [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
  echo "Checksum verification failed." >&2
  exit 1
fi
success "Checksum verified."

if ! ensure_minisign; then
  echo "minisign is required for installer signature verification." >&2
  echo "Install minisign manually and rerun, or set HAPPIER_MINISIGN_PUBKEY with a trusted key." >&2
  exit 1
fi

PUBKEY_PATH="${TMP_DIR}/minisign.pub"
SIG_PATH="${TMP_DIR}/checksums.txt.minisig"
write_minisign_public_key "${PUBKEY_PATH}"
stage_release_asset "Downloading minisign signature" "${SIG_PATH}" "${SIG_SOURCE}"
"${MINISIGN_BIN}" -Vm "${CHECKSUMS_PATH}" -x "${SIG_PATH}" -p "${PUBKEY_PATH}" >/dev/null
success "Signature verified."

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"
run_installer_step "Extracting payload" tar_extract_gz "${ARCHIVE_PATH}" "${EXTRACT_DIR}"

PAYLOAD_ROOT="${EXTRACT_DIR}/${VERSION_PREFIX}${VERSION}-${OS}-${ARCH}"
if [[ ! -d "${PAYLOAD_ROOT}" ]]; then
  echo "Failed to find extracted payload root: ${PAYLOAD_ROOT}" >&2
  exit 1
fi

PAYLOAD_BINARY_PATH="${PAYLOAD_ROOT}/${EXE_NAME}"
if [[ ! -x "${PAYLOAD_BINARY_PATH}" ]]; then
  echo "Failed to find extracted ${EXE_NAME} binary." >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}/bin" "${BIN_DIR}"
TARGET_BIN="${INSTALL_DIR}/bin/${EXE_NAME}"
DISPLAY_BINARY_PATH="${TARGET_BIN}"
DISPLAY_SHIM_PATH="${BIN_DIR}/${EXE_NAME}"
INSTALL_SHIM_PATH="${TARGET_BIN}"
CLI_USED_LEGACY_FALLBACK="0"

if [[ "${PRODUCT}" == "cli" ]]; then
  CLI_MANAGED_ROOT="$(cli_managed_install_root "${CHANNEL}")" || {
    echo "Unsupported CLI channel: ${CHANNEL}" >&2
    exit 1
  }
  CLI_SHIM_NAME="$(cli_shim_name "${CHANNEL}")" || {
    echo "Unsupported CLI shim channel: ${CHANNEL}" >&2
    exit 1
  }
  DISPLAY_BINARY_PATH="${INSTALL_DIR}/${CLI_MANAGED_ROOT}/current/${EXE_NAME}"
  DISPLAY_SHIM_PATH="${BIN_DIR}/${CLI_SHIM_NAME}"
  PROMOTION_OUTPUT=""
  if ! PROMOTION_OUTPUT="$(
    HAPPIER_HOME_DIR="${INSTALL_DIR}" "${PAYLOAD_BINARY_PATH}" self __install-payload \
      --component happier-cli \
      --payload-root "${PAYLOAD_ROOT}" \
      --version "${VERSION}" \
      --channel "${CHANNEL}" \
      2>&1
  )"; then
    if printf '%s' "${PROMOTION_OUTPUT}" | grep -Eq 'Unknown self subcommand: __install-payload'; then
      warn "Falling back to legacy binary install because the extracted CLI does not support payload promotion."
      CLI_USED_LEGACY_FALLBACK="1"
      DISPLAY_BINARY_PATH="${TARGET_BIN}"
    else
      printf '%s\n' "${PROMOTION_OUTPUT}" >&2
      exit 1
    fi
    STAGED_BIN="${TARGET_BIN}.new"
    PREVIOUS_BIN="${TARGET_BIN}.previous"
    cp "${PAYLOAD_BINARY_PATH}" "${STAGED_BIN}"
    chmod +x "${STAGED_BIN}"
    if [[ -f "${TARGET_BIN}" ]]; then
      cp "${TARGET_BIN}" "${PREVIOUS_BIN}" >/dev/null 2>&1 || true
      chmod +x "${PREVIOUS_BIN}" >/dev/null 2>&1 || true
    fi
    mv -f "${STAGED_BIN}" "${TARGET_BIN}"
    chmod +x "${TARGET_BIN}"
  fi
else
  SHIM_NAME="$(resolve_shim_name)" || {
    echo "Unsupported channel: ${CHANNEL}" >&2
    exit 1
  }
  DISPLAY_SHIM_PATH="${BIN_DIR}/${SHIM_NAME}"
  INSTALL_SHIM_PATH="${INSTALL_DIR}/bin/${SHIM_NAME}"

  if [[ "${PRODUCT}" == "server" || "${PRODUCT}" == "stack" ]]; then
    MANAGED_ROOT=""
    if [[ "${PRODUCT}" == "server" ]]; then
      MANAGED_ROOT="$(server_managed_install_root "${CHANNEL}")" || {
        echo "Unsupported server channel: ${CHANNEL}" >&2
        exit 1
      }
    else
      MANAGED_ROOT="$(stack_managed_install_root "${CHANNEL}")" || {
        echo "Unsupported stack channel: ${CHANNEL}" >&2
        exit 1
      }
    fi

    VERSION_DIR="${INSTALL_DIR}/${MANAGED_ROOT}/versions/${VERSION}"
    mkdir -p "${VERSION_DIR}"
    PAYLOAD_DIRNAME="$(basename "${PAYLOAD_ROOT}")"
    PAYLOAD_DEST="${VERSION_DIR}/${PAYLOAD_DIRNAME}"
    rm -rf "${PAYLOAD_DEST}" || true
    cp -R "${PAYLOAD_ROOT}" "${VERSION_DIR}/"

    mkdir -p "${INSTALL_DIR}/${MANAGED_ROOT}"
    ln -sfn "${PAYLOAD_DEST}" "${INSTALL_DIR}/${MANAGED_ROOT}/current"

    DISPLAY_BINARY_PATH="${INSTALL_DIR}/${MANAGED_ROOT}/current/${EXE_NAME}"

    cat > "${INSTALL_SHIM_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${INSTALL_DIR}/${MANAGED_ROOT}/current"
exec "./${EXE_NAME}" "\$@"
EOF
    chmod +x "${INSTALL_SHIM_PATH}"
  else
    STAGED_BIN="${TARGET_BIN}.new"
    PREVIOUS_BIN="${TARGET_BIN}.previous"
    cp "${PAYLOAD_BINARY_PATH}" "${STAGED_BIN}"
    chmod +x "${STAGED_BIN}"
    if [[ -f "${TARGET_BIN}" ]]; then
      cp "${TARGET_BIN}" "${PREVIOUS_BIN}" >/dev/null 2>&1 || true
      chmod +x "${PREVIOUS_BIN}" >/dev/null 2>&1 || true
    fi
    # Avoid ETXTBSY when replacing a running executable: swap the directory entry atomically.
    mv -f "${STAGED_BIN}" "${TARGET_BIN}"
    chmod +x "${TARGET_BIN}"
    INSTALL_SHIM_PATH="${TARGET_BIN}"
  fi
fi

if [[ "${PRODUCT}" == "cli" && "${CLI_USED_LEGACY_FALLBACK}" != "1" ]]; then
  CLI_INSTALLED_SHIM_PATH="${INSTALL_DIR}/bin/${CLI_SHIM_NAME}"
  if [[ -x "${CLI_INSTALLED_SHIM_PATH}" ]]; then
    ln -sf "${CLI_INSTALLED_SHIM_PATH}" "${DISPLAY_SHIM_PATH}"
  else
    ln -sf "${DISPLAY_BINARY_PATH}" "${DISPLAY_SHIM_PATH}"
  fi
else
  ln -sf "${INSTALL_SHIM_PATH}" "${DISPLAY_SHIM_PATH}"
fi

append_path_hint

services_json=""
status_json=""
if should_read_background_service_preflight; then
  services_json="$(read_background_service_preflight_json "${DISPLAY_SHIM_PATH}")"
  status_json="$(read_background_service_status_json "${DISPLAY_SHIM_PATH}")"
  if [[ "${NONINTERACTIVE}" != "1" ]]; then
    print_installed_background_service_summary "${DISPLAY_SHIM_PATH}" "${services_json}" "${status_json}"
  fi
fi

WITH_DAEMON="$(resolve_with_daemon_choice "${services_json}")"

if [[ "${PRODUCT}" == "cli" && "${WITH_DAEMON}" == "1" ]]; then
  if background_service_inventory_is_supported "${services_json}"; then
    install_strategy="$(resolve_existing_background_service_install_strategy "${services_json}")"
    skip_background_service_install="0"
    echo
    repair_command="$(background_service_repair_manual_command "${DISPLAY_SHIM_PATH}" "${services_json}")"
    case "${install_strategy}" in
      replace-all)
        if background_service_repair_requires_sudo "${services_json}"; then
          echo "Warning: system background services require sudo to repair or switch:" >&2
          echo "  ${repair_command}" >&2
          skip_background_service_install="1"
        else
          info "Switching managed background-service startup to this release-channel..."
          if ! invoke_installer_command_with_daemon_service_context "${DISPLAY_SHIM_PATH}" service repair --yes >/dev/null 2>&1; then
            echo "Warning: background service install failed. You can retry manually:" >&2
            echo "  ${repair_command}" >&2
          fi
        fi
        ;;
      add)
        info "Installing an additional background service (user-mode)..."
        if ! invoke_installer_command_with_daemon_service_context "${DISPLAY_SHIM_PATH}" service install --yes >/dev/null 2>&1; then
          echo "Warning: background service install failed. You can retry manually:" >&2
          echo "  ${DISPLAY_SHIM_PATH} service install --yes" >&2
        fi
        ;;
      skip)
        info "Keeping existing background services unchanged."
        ;;
      *)
        if [[ "${NONINTERACTIVE}" == "1" ]]; then
          if background_service_repair_requires_sudo "${services_json}"; then
            echo "Warning: system background services require sudo to repair or switch:" >&2
            echo "  ${repair_command}" >&2
            echo
            skip_background_service_install="1"
          else
            info "Reconciling existing background services (best-effort)..."
            if ! invoke_installer_command_with_daemon_service_context "${DISPLAY_SHIM_PATH}" service repair --yes >/dev/null 2>&1; then
              echo "Warning: background service repair failed. You can retry manually:" >&2
              echo "  ${repair_command}" >&2
              echo
              skip_background_service_install="1"
            fi
            if [[ "${skip_background_service_install}" != "1" ]]; then
              echo
            fi
          fi
        fi
        if [[ "${skip_background_service_install}" != "1" ]]; then
          info "Installing background service (user-mode)..."
          if ! invoke_installer_command_with_daemon_service_context "${DISPLAY_SHIM_PATH}" service install --yes >/dev/null 2>&1; then
            echo "Warning: background service install failed. You can retry manually:" >&2
            echo "  ${DISPLAY_SHIM_PATH} service install --yes" >&2
          fi
        fi
        ;;
    esac
  fi
fi

echo
echo "${INSTALL_NAME} installed:"
echo "  binary: ${DISPLAY_BINARY_PATH}"
echo "  shim:   ${DISPLAY_SHIM_PATH}"
echo
if [[ "${NONINTERACTIVE}" != "1" ]]; then
  if [[ "${PRODUCT}" == "server" ]]; then
    "${DISPLAY_BINARY_PATH}" --help >/dev/null 2>&1 || true
  else
    "${DISPLAY_BINARY_PATH}" --version || true
  fi
fi

if [[ -n "${RUN_ACTION}" ]]; then
  echo
  run_post_install_action "${DISPLAY_SHIM_PATH}"
fi
