#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${HAPPIER_CHANNEL:-stable}"
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
ACTION="${HAPPIER_INSTALLER_ACTION:-install}" # install|reinstall|version|check|uninstall|restart|rollback
INSTALL_VERSION="${HAPPIER_INSTALL_VERSION:-}"
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
  COLOR_DIM=$'\033[2m'
  COLOR_GREEN=$'\033[32m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_CYAN=$'\033[36m'
else
  COLOR_RESET=""
  COLOR_BOLD=""
  COLOR_DIM=""
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

installer_detail_bullet() {
  local label="$1"
  local value="$2"
  say "    ${COLOR_DIM}• ${label}:${COLOR_RESET} ${value}"
}

installer_subheading() {
  say "  $*"
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
    say "- [..] ${label}"
    "$@"
    say "- [$(installer_step_success_symbol)] ${label}"
    return
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

release_asset_version_from_name() {
  local name="$1"
  local version=""
  if [[ "${name}" =~ ^checksums-.+-v(.+)[.]txt[.]minisig$ ]]; then
    version="${BASH_REMATCH[1]}"
  elif [[ "${name}" =~ ^checksums-.+-v(.+)[.]txt$ ]]; then
    version="${BASH_REMATCH[1]}"
  elif [[ "${name}" =~ ^.+-v(.+)-(linux|darwin|win32)-[^-]+[.]tar[.]gz$ ]]; then
    version="${BASH_REMATCH[1]}"
  fi
  printf '%s' "${version}"
}

release_asset_version_sort_key() {
  local name="$1"
  local version
  version="$(release_asset_version_from_name "${name}")"

  local version_without_build
  version_without_build="${version%%+*}"

  local core
  local prerelease=""
  core="${version_without_build%%-*}"
  if [[ "${version_without_build}" == *-* ]]; then
    prerelease="${version_without_build#*-}"
  fi

  local major=0
  local minor=0
  local patch=0
  IFS='.' read -r major minor patch _ <<< "${core}"
  major="${major:-0}"
  minor="${minor:-0}"
  patch="${patch:-0}"
  [[ "${major}" =~ ^[0-9]+$ ]] || major=0
  [[ "${minor}" =~ ^[0-9]+$ ]] || minor=0
  [[ "${patch}" =~ ^[0-9]+$ ]] || patch=0

  local sort_key
  sort_key="$(printf '%09d|%09d|%09d|' "${major}" "${minor}" "${patch}")"

  local prerelease_rank="1|stable|"
  if [[ -n "${prerelease}" ]]; then
    prerelease_rank="0|"
    local part
    local prerelease_parts=()
    IFS='.' read -r -a prerelease_parts <<< "${prerelease}"
    for part in "${prerelease_parts[@]}"; do
      if [[ "${part}" =~ ^[0-9]+$ ]]; then
        prerelease_rank+="$(printf '1|0|%09d|' "${part}")"
      else
        prerelease_rank+="1|1|${part}|"
      fi
    done
    prerelease_rank+="0|"
  fi

  printf '%s' "${sort_key}${prerelease_rank}${name}"
}

json_lookup_asset_url() {
  local json="$1"
  local name_regex="$2"
  local matched=""
  local matched_sort_key=""
  # GitHub API JSON is typically pretty-printed (newlines + spaces). Avoid "minifying" into one
  # giant line (which can overflow awk line-length limits on some platforms) and instead parse
  # line-by-line within the assets array. Select by semantic version instead of provider order so
  # rolling tags remain deterministic even when GitHub returns older assets last.
  while IFS=$'\t' read -r name url; do
    if [[ -z "${name}" || -z "${url}" ]]; then
      continue
    fi
    local sort_key
    sort_key="$(release_asset_version_sort_key "${name}")"
    if [[ -z "${matched}" || "${sort_key}" > "${matched_sort_key}" ]]; then
      matched="${url}"
      matched_sort_key="${sort_key}"
    fi
  done < <(printf '%s' "$json" | tr '{},' '\n\n\n' | awk -v re="$name_regex" '
    BEGIN {
      in_assets = 0
      name = ""
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
          printf "%s\t%s\n", name, url
        }
      }
    }
  ')
  if [[ -n "${matched}" ]]; then
    printf '%s' "${matched}"
  fi
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
  local matched_sort_key=""
  while IFS= read -r -d '' path; do
    local name
    name="$(basename "${path}")"
    if [[ "${name}" =~ ${name_regex} ]]; then
      local sort_key
      sort_key="$(release_asset_version_sort_key "${name}")"
      if [[ -z "${matched}" || "${sort_key}" > "${matched_sort_key}" ]]; then
        matched="${path}"
        matched_sort_key="${sort_key}"
      fi
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

escape_regex_literal() {
  printf '%s' "$1" | sed 's/[][\\.^$*+?{}()|]/\\&/g'
}

validate_requested_install_version() {
  local version="$1"
  if [[ -z "${version}" ]]; then
    echo "Missing value for --version" >&2
    return 1
  fi
  if [[ ! "${version}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
    echo "Invalid install version '${version}'. Expected a release version such as 0.2.1." >&2
    return 1
  fi
  return 0
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
  local name
  name="$(resolve_install_name)"

  local binary=""
  binary="$(resolve_installed_binary 2>/dev/null || true)"
  if [[ -n "${binary}" && "${PRODUCT}" == "cli" ]] && ! daemon_service_operations_are_explicitly_disabled; then
    "${binary}" service uninstall >/dev/null 2>&1 || true
  fi

  # CLI uninstall has two shim concepts:
  # - channel shim (`hprev` / `hdev`) that is always channel-scoped
  # - default shim (`happier`) that follows `default-cli-release-channel.json` and must persist
  #   as long as *any* CLI channel remains installed.
  local shim=""
  shim="$(resolve_shim_name)"
  if [[ "${PRODUCT}" == "cli" ]]; then
    if [[ "${CHANNEL}" != "stable" ]]; then
      rm -f "${BIN_DIR}/${shim}" "${INSTALL_DIR}/bin/${shim}.new" "${INSTALL_DIR}/bin/${shim}.previous" || true
      rm -f "${INSTALL_DIR}/bin/${shim}" || true
    fi
  else
    rm -f "${BIN_DIR}/${shim}" "${INSTALL_DIR}/bin/${shim}.new" "${INSTALL_DIR}/bin/${shim}.previous" || true
    rm -f "${INSTALL_DIR}/bin/${shim}" || true
  fi
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

  # If the user previously selected this channel as the default (the unsuffixed `happier` shim),
  # uninstalling it must restore the default shim back to a remaining channel to avoid leaving
  # a broken/dangling `happier` command on PATH. This applies to *all* channels (including stable).
  if [[ "${PRODUCT}" == "cli" ]]; then
    local default_state_path="${INSTALL_DIR}/default-cli-release-channel.json"
    local should_repoint_default="0"

    if [[ -f "${default_state_path}" ]]; then
      if grep -Eq "\"releaseChannel\"[[:space:]]*:[[:space:]]*\"${CHANNEL}\"" "${default_state_path}"; then
        should_repoint_default="1"
      fi
    else
      # Back-compat: older installs may not have a default state file. Treat stable as the
      # implicit default.
      if [[ "${CHANNEL}" == "stable" ]]; then
        should_repoint_default="1"
      fi
    fi

    local default_shim_path="${INSTALL_DIR}/bin/happier"
    local default_path_shim="${BIN_DIR}/happier"

    if [[ "${should_repoint_default}" == "1" ]]; then
      local fallback_channel=""
      local fallback_root=""

      if [[ -x "${INSTALL_DIR}/cli/current/happier" ]]; then
        fallback_channel="stable"
        fallback_root="cli"
      elif [[ -x "${INSTALL_DIR}/cli-preview/current/happier" ]]; then
        fallback_channel="preview"
        fallback_root="cli-preview"
      elif [[ -x "${INSTALL_DIR}/cli-dev/current/happier" ]]; then
        fallback_channel="publicdev"
        fallback_root="cli-dev"
      else
        fallback_channel=""
      fi

      if [[ -n "${fallback_channel}" ]]; then
        rm -f "${default_shim_path}" || true
        ln -sfn "${INSTALL_DIR}/${fallback_root}/current/happier" "${default_shim_path}" || true
        printf '%s\n' "{\"releaseChannel\":\"${fallback_channel}\"}" > "${default_state_path}" || true
        # Ensure the PATH shim still points at the default shim when it exists.
        if [[ -n "${BIN_DIR:-}" ]]; then
          rm -f "${default_path_shim}" || true
          ln -sfn "${default_shim_path}" "${default_path_shim}" || true
        fi
      else
        rm -f "${default_shim_path}" || true
        rm -f "${default_state_path}" || true
        rm -f "${default_path_shim}" || true
      fi
    fi
  fi

  if [[ "${PURGE_INSTALL_DIR}" == "1" ]]; then
    rm -rf "${INSTALL_DIR}" || true
  fi

  success "${name} uninstalled."
  say "Tip: if your shell still can't find changes, run:"
  shell_command_cache_hint
  return 0
}

read_installer_marker_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    return 1
  fi
  local value=""
  IFS= read -r value < "${path}" || true
  printf '%s' "${value}"
}

cli_default_channel_matches_selected_channel() {
  local state_path="${INSTALL_DIR}/default-cli-release-channel.json"
  if [[ -f "${state_path}" ]]; then
    grep -Eq "\"releaseChannel\"[[:space:]]*:[[:space:]]*\"${CHANNEL}\"" "${state_path}"
    return $?
  fi
  [[ "${CHANNEL}" == "stable" ]]
}

sync_cli_rollback_shim() {
  local shim_name="$1"
  local managed_root="$2"
  local install_shim_path="${INSTALL_DIR}/bin/${shim_name}"
  local path_shim_path="${BIN_DIR}/${shim_name}"

  mkdir -p "${INSTALL_DIR}/bin" "${BIN_DIR}"
  rm -f "${install_shim_path}" || true
  ln -sfn "${INSTALL_DIR}/${managed_root}/current/happier" "${install_shim_path}"
  rm -f "${path_shim_path}" || true
  ln -sfn "${install_shim_path}" "${path_shim_path}"
}

action_rollback() {
  if [[ "${PRODUCT}" != "cli" ]]; then
    echo "Rollback is only supported for the CLI installer." >&2
    return 1
  fi

  local managed_root=""
  managed_root="$(cli_managed_install_root "${CHANNEL}")" || {
    echo "Unsupported CLI channel: ${CHANNEL}" >&2
    return 1
  }
  local shim_name=""
  shim_name="$(cli_shim_name "${CHANNEL}")" || {
    echo "Unsupported CLI shim channel: ${CHANNEL}" >&2
    return 1
  }

  local install_root="${INSTALL_DIR}/${managed_root}"
  local previous_version=""
  previous_version="$(read_installer_marker_file "${install_root}/previous.version" 2>/dev/null || true)"
  if [[ -z "${previous_version}" ]]; then
    echo "No previous ${shim_name} version is available for rollback." >&2
    return 1
  fi

  local previous_dir="${install_root}/versions/${previous_version}"
  if [[ ! -x "${previous_dir}/happier" ]]; then
    echo "Rollback target is missing or incomplete: ${previous_dir}" >&2
    return 1
  fi

  local current_version=""
  current_version="$(read_installer_marker_file "${install_root}/current.version" 2>/dev/null || true)"
  local current_dir=""
  if [[ -n "${current_version}" ]]; then
    current_dir="${install_root}/versions/${current_version}"
  fi

  rm -rf "${install_root}/current"
  ln -sfn "versions/${previous_version}" "${install_root}/current"
  printf '%s\n' "${previous_version}" > "${install_root}/current.version"

  if [[ -n "${current_version}" && -d "${current_dir}" ]]; then
    rm -rf "${install_root}/previous"
    ln -sfn "versions/${current_version}" "${install_root}/previous"
    printf '%s\n' "${current_version}" > "${install_root}/previous.version"
  else
    rm -rf "${install_root}/previous"
    rm -f "${install_root}/previous.version"
  fi

  sync_cli_rollback_shim "${shim_name}" "${managed_root}"
  if [[ "${shim_name}" != "happier" ]] && cli_default_channel_matches_selected_channel; then
    sync_cli_rollback_shim "happier" "${managed_root}"
  fi

  success "Rolled back ${shim_name} from ${current_version:-current} to ${previous_version}."
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

default_release_asset_version_regex() {
  case "$1" in
    preview) printf '%s' '[^-]+-preview([.][0-9A-Za-z.+-]+)?' ;;
    publicdev) printf '%s' '[^-]+-dev([.][0-9A-Za-z.+-]+)?' ;;
    *) printf '%s' '[^-]+' ;;
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
      prompt_text="Update automatic startup for the ${channel_label} CLI?"
    else
      prompt_text="Set up automatic startup for the ${channel_label} CLI?"
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

  if [[ "${has_existing_services}" == "1" ]] && background_service_inventory_has_matching_default_following "${services_json}"; then
    echo "0"
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

doctor_repair_preflight_looks_like_plain_doctor_report() {
  local output="${1:-}"
  printf '%s' "${output}" | grep -Eq 'Happier CLI Doctor'
}

read_background_service_preflight_json() {
  local cli_bin="$1"
  local repair_json=""
  local repair_error=""
  local repair_status=0
  local repair_error_path=""

  DOCTOR_REPAIR_PREFLIGHT_SUPPORTED="0"
  repair_error_path="$(mktemp)"
  set +e
  repair_json="$(invoke_installer_command_with_daemon_service_context "${cli_bin}" doctor repair --json 2>"${repair_error_path}")"
  repair_status=$?
  set -e
  repair_error="$(cat "${repair_error_path}" 2>/dev/null || true)"
  rm -f "${repair_error_path}" >/dev/null 2>&1 || true

  if doctor_repair_preflight_looks_like_plain_doctor_report "${repair_json}" \
    || doctor_repair_preflight_looks_like_plain_doctor_report "${repair_error}"; then
    read_installed_background_service_inventory_json "${cli_bin}"
    return
  fi

  if installer_command_failure_looks_unsupported "${repair_error}"; then
    read_installed_background_service_inventory_json "${cli_bin}"
    return
  fi

  if background_service_inventory_json_is_supported "${repair_json}"; then
    DOCTOR_REPAIR_PREFLIGHT_SUPPORTED="1"
    printf '%s' "${repair_json}"
    return
  fi

  read_installed_background_service_inventory_json "${cli_bin}"
}

print_background_service_report_text_if_supported() {
  local cli_bin="$1"

  if [[ "${DOCTOR_REPAIR_PREFLIGHT_SUPPORTED:-0}" != "1" ]]; then
    return
  fi

  # When the installer has a controlling tty (even if stdin is a pipe from
  # `curl | bash`), hand off to the CLI's interactive `doctor repair` with
  # stdin redirected from /dev/tty so it can render the report AND prompt the
  # user for each finding. Otherwise fall back to the read-only report, which
  # prints the CTA `To handle these interactively: happier doctor repair`
  # footer so the user still knows the next step.
  if installer_has_controlling_tty; then
    invoke_installer_command_with_daemon_service_context "${cli_bin}" doctor repair </dev/tty || true
  else
    invoke_installer_command_with_daemon_service_context "${cli_bin}" doctor repair --report-only 2>/dev/null || true
  fi
}

installer_command_failure_looks_unsupported() {
  local output="${1:-}"
  printf '%s' "${output}" | grep -Eqi "unknown (option|command|subcommand)|invalid option|usage: happier <command>|does not support"
}

background_service_install_manual_command() {
  local cli_bin="$1"
  printf '%s service install' "${cli_bin}"
}

run_background_service_install_compatibly() {
  local cli_bin="$1"
  local tmp_output=""
  tmp_output="$(mktemp)"
  if invoke_installer_command_with_daemon_service_context "${cli_bin}" service install --yes >"${tmp_output}" 2>&1; then
    rm -f "${tmp_output}" >/dev/null 2>&1 || true
    return 0
  fi

  local install_output=""
  install_output="$(cat "${tmp_output}" 2>/dev/null || true)"
  if installer_command_failure_looks_unsupported "${install_output}"; then
    if invoke_installer_command_with_daemon_service_context "${cli_bin}" service install >"${tmp_output}" 2>&1; then
      rm -f "${tmp_output}" >/dev/null 2>&1 || true
      return 0
    fi
    install_output="$(cat "${tmp_output}" 2>/dev/null || true)"
  fi

  printf '%s' "${install_output}" >&2
  rm -f "${tmp_output}" >/dev/null 2>&1 || true
  return 1
}

run_background_service_repair_if_supported() {
  local cli_bin="$1"
  if [[ "${DOCTOR_REPAIR_PREFLIGHT_SUPPORTED:-0}" != "1" ]]; then
    return 2
  fi
  local tmp_output=""
  tmp_output="$(mktemp)"
  if invoke_installer_command_with_daemon_service_context "${cli_bin}" doctor repair --yes >"${tmp_output}" 2>&1; then
    rm -f "${tmp_output}" >/dev/null 2>&1 || true
    return 0
  fi

  local repair_output=""
  repair_output="$(cat "${tmp_output}" 2>/dev/null || true)"
  rm -f "${tmp_output}" >/dev/null 2>&1 || true
  if installer_command_failure_looks_unsupported "${repair_output}"; then
    return 2
  fi

  printf '%s' "${repair_output}" >&2
  return 1
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

  # Fail closed: the preflight must be a single JSON object emitted on stdout.
  # Older CLIs can interpret `doctor repair ...` as `doctor ...` and print a large
  # report that includes JSON fragments; don't treat that as supported.
  local trimmed=""
  trimmed="$(trim_installer_text "${services_json}")"
  if [[ -z "${trimmed}" ]]; then
    return 1
  fi
  [[ "${trimmed}" == \{* ]] || return 1
  [[ "${trimmed}" == *\} ]] || return 1

  printf '%s' "${trimmed}" | grep -Eq '"(entries|services|existingServices)"[[:space:]]*:'
}

background_service_inventory_is_empty() {
  local services_json="$1"
  background_service_inventory_json_is_empty "${services_json}"
}

background_service_inventory_json_is_empty() {
  local services_json="$1"
  if [[ -z "${services_json}" ]]; then
    return 0
  fi
  local trimmed=""
  trimmed="$(trim_installer_text "${services_json}")"
  [[ -z "${trimmed}" ]] || printf '%s' "${trimmed}" | grep -Eq '"(entries|services|existingServices)"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]'
}

background_service_inventory_has_default_following() {
  local services_json="$1"
  background_service_inventory_json_has_default_following "${services_json}"
}

background_service_inventory_json_has_default_following() {
  local services_json="$1"
  printf '%s' "${services_json}" | grep -Eq '"targetMode"[[:space:]]*:[[:space:]]*"default-following"'
}

background_service_inventory_daemon_is_running() {
  local services_json="$1"
  printf '%s' "${services_json}" | grep -Eq '"daemonRunning"[[:space:]]*:[[:space:]]*true'
}

background_service_inventory_default_following_channel() {
  local services_json="$1"
  local compact_json=""
  compact_json="$(printf '%s' "${services_json}" | tr '\n' ' ')"
  local entry_jsons=""
  entry_jsons="$(printf '%s' "${compact_json}" | grep -oE '\{[^{}]*"targetMode"[[:space:]]*:[[:space:]]*"default-following"[^{}]*\}' || true)"
  while IFS= read -r entry_json; do
    if [[ -z "${entry_json}" ]]; then
      continue
    fi
    local service_channel=""
    service_channel="$(json_first_string_value "${entry_json}" 'releaseChannel')"
    if [[ -n "${service_channel}" ]]; then
      display_channel_label "${service_channel}"
      return
    fi
  done <<< "${entry_jsons}"
}

background_service_inventory_has_matching_default_following() {
  local services_json="$1"

  # Prefer the explicit boolean computed by `doctor repair --json` when available, as
  # parsing nested JSON reliably in pure shell is brittle.
  local repair_match=""
  repair_match="$(json_first_boolean_value "${services_json}" 'defaultFollowingMatchesSelectedReleaseChannel')"
  if [[ "${repair_match}" == "true" ]]; then
    return 0
  fi
  if [[ "${repair_match}" == "false" ]]; then
    return 1
  fi

  local current_channel_label=""
  current_channel_label="$(display_channel_label "${CHANNEL}")"
  local default_channel_label=""
  default_channel_label="$(background_service_inventory_default_following_channel "${services_json}")"
  [[ -n "${default_channel_label}" ]] && [[ "${default_channel_label}" == "${current_channel_label}" ]]
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
    printf 'sudo %s doctor repair --yes' "${cli_bin}"
    return
  fi
  printf '%s doctor repair --yes' "${cli_bin}"
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

trim_installer_text() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
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

  local replace_prompt="Use this installation for automatic startup?"
  if background_service_inventory_has_default_following "${services_json}"; then
    replace_prompt="Use this installation for automatic startup?"
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
  local default_version_regex=""
  default_version_regex="$(default_release_asset_version_regex "${CHANNEL}")"
  local asset_regex="^happier-v${default_version_regex}-${os}-${arch}[.]tar[.]gz$"
  local version_prefix="happier-v"
  if [[ "${PRODUCT}" == "server" ]]; then
    asset_regex="^happier-server-v${default_version_regex}-${os}-${arch}[.]tar[.]gz$"
    version_prefix="happier-server-v"
  fi
  if [[ "${PRODUCT}" == "stack" ]]; then
    asset_regex="^hstack-v${default_version_regex}-${os}-${arch}[.]tar[.]gz$"
    version_prefix="hstack-v"
  fi
  if [[ -n "${INSTALL_VERSION}" ]]; then
    local requested_version_regex=""
    requested_version_regex="$(escape_regex_literal "${INSTALL_VERSION}")"
    asset_regex="^${version_prefix}${requested_version_regex}-${os}-${arch}[.]tar[.]gz$"
  fi
  tag="$(resolve_release_tag "${PRODUCT}" "${CHANNEL}")" || {
    echo "Unsupported product/channel combination: ${PRODUCT}/${CHANNEL}" >&2
    return 1
  }

  local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}"
  info "Fetching ${tag} release metadata..."
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
    if ! release_json="$(curl_auth "${api_url}")"; then
      echo "Failed to fetch release metadata for ${name}." >&2
      return 1
    fi
  fi
  local asset_source=""
  asset_source="$(resolve_release_asset_source "${release_json}" "${asset_regex}")"
  if [[ -z "${asset_source}" ]]; then
    echo "Unable to locate release assets for ${os}-${arch} on tag ${tag}." >&2
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
  --version [version]
  --rollback
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
      if [[ $# -ge 2 && -n "${2:-}" && "${2}" != --* ]]; then
        INSTALL_VERSION="${2}"
        ACTION="install"
        shift 2
      else
        ACTION="version"
        shift 1
      fi
      ;;
    --version=*)
      INSTALL_VERSION="${1#*=}"
      ACTION="install"
      shift 1
      ;;
    --rollback)
      ACTION="rollback"
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

if [[ -n "${INSTALL_VERSION}" ]]; then
  validate_requested_install_version "${INSTALL_VERSION}" || {
    usage >&2
    exit 1
  }
fi

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

filter_supported_setup_relay_default_args() {
  local cli_bin="$1"
  local help_output=""
  help_output="$("${cli_bin}" relay host install --help 2>/dev/null || true)"
  if [[ -z "${help_output}" ]]; then
    printf '%s\n' "${RUN_ACTION_DEFAULT_ARGS[@]}"
    return
  fi

  if printf '%s\n' "${help_output}" | grep -Fq -- '--mode'; then
    printf '%s\n' '--mode' 'user'
  fi
  if printf '%s\n' "${help_output}" | grep -Fq -- '--yes'; then
    printf '%s\n' '--yes'
  fi
  if printf '%s\n' "${help_output}" | grep -Fq -- '--channel'; then
    printf '%s\n' '--channel' "$(display_channel_label "${CHANNEL}")"
  fi
  if printf '%s\n' "${help_output}" | grep -Fq -- '--preserve-active-server'; then
    printf '%s\n' '--preserve-active-server'
  fi
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
    if [[ "${op}" == "setup-relay" ]]; then
      while IFS= read -r arg; do
        args+=("${arg}")
      done < <(filter_supported_setup_relay_default_args "${cli_bin}")
    else
      args+=("${RUN_ACTION_DEFAULT_ARGS[@]}")
    fi
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
if [[ "${ACTION}" == "rollback" ]]; then
  action_rollback
  exit $?
fi

if [[ -n "${RUN_ACTION}" ]]; then
  if [[ "${PRODUCT}" != "cli" ]]; then
    echo "--run is only supported when installing the CLI." >&2
    exit 1
  fi
  if [[ "${ACTION}" != "install" ]]; then
    echo "--run cannot be combined with installer actions like --check/--version/--rollback/--uninstall." >&2
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
DEFAULT_VERSION_REGEX="$(default_release_asset_version_regex "${CHANNEL}")"
ASSET_REGEX="^happier-v${DEFAULT_VERSION_REGEX}-${OS}-${ARCH}[.]tar[.]gz$"
CHECKSUMS_REGEX="^checksums-happier-v${DEFAULT_VERSION_REGEX}[.]txt$"
SIG_REGEX="^checksums-happier-v${DEFAULT_VERSION_REGEX}[.]txt[.]minisig$"
EXE_NAME="happier"
INSTALL_NAME="Happier CLI"
VERSION_PREFIX="happier-v"
CHECKSUMS_PREFIX="checksums-happier-v"

if [[ "${PRODUCT}" == "server" ]]; then
  ASSET_REGEX="^happier-server-v${DEFAULT_VERSION_REGEX}-${OS}-${ARCH}[.]tar[.]gz$"
  CHECKSUMS_REGEX="^checksums-happier-server-v${DEFAULT_VERSION_REGEX}[.]txt$"
  SIG_REGEX="^checksums-happier-server-v${DEFAULT_VERSION_REGEX}[.]txt[.]minisig$"
  EXE_NAME="happier-server"
  INSTALL_NAME="Happier Server"
  VERSION_PREFIX="happier-server-v"
  CHECKSUMS_PREFIX="checksums-happier-server-v"
fi

if [[ "${PRODUCT}" == "stack" ]]; then
  ASSET_REGEX="^hstack-v${DEFAULT_VERSION_REGEX}-${OS}-${ARCH}[.]tar[.]gz$"
  CHECKSUMS_REGEX="^checksums-hstack-v${DEFAULT_VERSION_REGEX}[.]txt$"
  SIG_REGEX="^checksums-hstack-v${DEFAULT_VERSION_REGEX}[.]txt[.]minisig$"
  EXE_NAME="hstack"
  INSTALL_NAME="Happier Stack"
  VERSION_PREFIX="hstack-v"
  CHECKSUMS_PREFIX="checksums-hstack-v"
fi

if [[ -n "${INSTALL_VERSION}" ]]; then
  REQUESTED_VERSION_REGEX="$(escape_regex_literal "${INSTALL_VERSION}")"
  ASSET_REGEX="^${VERSION_PREFIX}${REQUESTED_VERSION_REGEX}-${OS}-${ARCH}[.]tar[.]gz$"
  CHECKSUMS_REGEX="^${CHECKSUMS_PREFIX}${REQUESTED_VERSION_REGEX}[.]txt$"
  SIG_REGEX="^${CHECKSUMS_PREFIX}${REQUESTED_VERSION_REGEX}[.]txt[.]minisig$"
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
  echo "Failed to resolve checksum for $(basename "${ASSET_URL}")" >&2
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
	if should_read_background_service_preflight; then
	  tmp_services_json="$(mktemp)"
	  read_background_service_preflight_json "${DISPLAY_SHIM_PATH}" >"${tmp_services_json}" 2>/dev/null || true
	  services_json="$(cat "${tmp_services_json}" 2>/dev/null || true)"
	  rm -f "${tmp_services_json}" >/dev/null 2>&1 || true
	  # `doctor repair --json` preflight can include additional inventory such as daemon status.
	  if background_service_inventory_is_supported "${services_json}"; then
	    DAEMON_RUNNING_FROM_PREFLIGHT="0"
	    if background_service_inventory_daemon_is_running "${services_json}"; then
	      DAEMON_RUNNING_FROM_PREFLIGHT="1"
	    fi
	  fi
	  if [[ "${NONINTERACTIVE}" != "1" ]]; then
	    print_background_service_report_text_if_supported "${DISPLAY_SHIM_PATH}"
    fi
  fi

WITH_DAEMON="$(resolve_with_daemon_choice "${services_json}")"

if [[ "${PRODUCT}" == "cli" && "${WITH_DAEMON}" == "1" ]]; then
  if background_service_inventory_is_supported "${services_json}"; then
    install_strategy="$(resolve_existing_background_service_install_strategy "${services_json}")"
    skip_background_service_install="0"
    echo
    repair_command="$(background_service_repair_manual_command "${DISPLAY_SHIM_PATH}" "${services_json}")"
    install_command="$(background_service_install_manual_command "${DISPLAY_SHIM_PATH}")"
    case "${install_strategy}" in
      replace-all)
        if run_background_service_repair_if_supported "${DISPLAY_SHIM_PATH}"; then
          info "Updating automatic startup to this release channel..."
        else
          repair_status=$?
          if [[ "${repair_status}" == "2" ]]; then
            info "Setting up automatic startup (user-mode)..."
            if ! run_background_service_install_compatibly "${DISPLAY_SHIM_PATH}" >/dev/null 2>&1; then
              echo "Warning: background service install failed. You can retry manually:" >&2
              echo "  ${install_command}" >&2
            fi
          elif background_service_repair_requires_sudo "${services_json}"; then
            echo "Warning: system background services require sudo to repair or switch:" >&2
            echo "  ${repair_command}" >&2
            skip_background_service_install="1"
          else
            echo "Warning: background service install failed. You can retry manually:" >&2
            echo "  ${repair_command}" >&2
          fi
        fi
        ;;
      add)
        info "Setting up automatic startup (additional service, user-mode)..."
        if ! run_background_service_install_compatibly "${DISPLAY_SHIM_PATH}" >/dev/null 2>&1; then
          echo "Warning: background service install failed. You can retry manually:" >&2
          echo "  ${install_command}" >&2
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
            if run_background_service_repair_if_supported "${DISPLAY_SHIM_PATH}"; then
              info "Repairing automatic startup (best-effort)..."
              echo
            else
              repair_status=$?
              if [[ "${repair_status}" == "2" ]]; then
                skip_background_service_install="0"
              else
                info "Repairing automatic startup (best-effort)..."
                echo "Warning: background service repair failed. You can retry manually:" >&2
                echo "  ${repair_command}" >&2
                echo
                skip_background_service_install="1"
              fi
            fi
          fi
        fi
        if [[ "${skip_background_service_install}" != "1" ]]; then
          info "Setting up automatic startup (user-mode)..."
          if ! run_background_service_install_compatibly "${DISPLAY_SHIM_PATH}" >/dev/null 2>&1; then
            echo "Warning: background service install failed. You can retry manually:" >&2
            echo "  ${install_command}" >&2
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

# PATH reload guidance. The shim dir may already be on PATH from a previous
# install (common), in which case the user can run `happier`/`hdev` right
# away. If it is NOT yet on PATH (fresh install), we direct the user to a
# simple shell reload or provide the absolute path.
display_shim_dir="$(dirname "${DISPLAY_SHIM_PATH}")"
display_shim_basename="$(basename "${DISPLAY_SHIM_PATH}")"
shim_on_current_path="0"
case ":${PATH}:" in
  *":${display_shim_dir}:"*)
    shim_on_current_path="1"
    ;;
esac
echo
if [[ "${shim_on_current_path}" == "1" ]]; then
  echo "You can run \`${display_shim_basename}\` right away."
else
  echo "To use \`${display_shim_basename}\` from any new shell, ${display_shim_dir} has been added to your PATH."
  echo "In THIS shell, reload with one of:"
  echo "  source ~/.bashrc   # bash"
  echo "  source ~/.zshrc    # zsh"
  echo "Or run directly using the absolute path: ${DISPLAY_SHIM_PATH}"
fi
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
