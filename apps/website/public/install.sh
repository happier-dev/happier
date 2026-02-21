#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${HAPPIER_CHANNEL:-stable}"
PRODUCT="${HAPPIER_PRODUCT:-cli}"
INSTALL_DIR="${HAPPIER_INSTALL_DIR:-$HOME/.happier}"
BIN_DIR="${HAPPIER_BIN_DIR:-$HOME/.local/bin}"
WITH_DAEMON="${HAPPIER_WITH_DAEMON:-1}"
NO_PATH_UPDATE="${HAPPIER_NO_PATH_UPDATE:-0}"
NONINTERACTIVE="${HAPPIER_NONINTERACTIVE:-0}"
ACTION="${HAPPIER_INSTALLER_ACTION:-install}" # install|check|uninstall|restart
DEBUG_MODE="${HAPPIER_INSTALLER_DEBUG:-0}"
PURGE_INSTALL_DIR="${HAPPIER_INSTALLER_PURGE:-0}"
GITHUB_REPO="${HAPPIER_GITHUB_REPO:-happier-dev/happier}"
GITHUB_TOKEN="${HAPPIER_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
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

shell_command_cache_hint() {
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  if [[ "${shell_name}" == "zsh" ]]; then
    say "  rehash"
  else
    say "  hash -r"
  fi
}

resolve_exe_name() {
  if [[ "${PRODUCT}" == "server" ]]; then
    echo "happier-server"
  else
    echo "happier"
  fi
}

resolve_install_name() {
  if [[ "${PRODUCT}" == "server" ]]; then
    echo "Happier Server"
  else
    echo "Happier CLI"
  fi
}

resolve_installed_binary() {
  local exe
  exe="$(resolve_exe_name)"
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
  local name
  name="$(resolve_install_name)"

  local ok="1"
  local binary_path="${INSTALL_DIR}/bin/${exe}"
  local shim_path="${BIN_DIR}/${exe}"

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
  resolved="$(command -v "${exe}" 2>/dev/null || true)"
  if [[ -n "${resolved}" ]]; then
    say "- command: ${resolved}"
  else
    warn "Command not found on PATH: ${exe}"
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

  info "Restarting daemon service (best-effort)..."
  if ! "${binary}" daemon service restart >/dev/null 2>&1; then
    warn "Daemon service restart failed (it may not be installed)."
    warn "Try: ${binary} daemon service install"
    return 1
  fi
  success "Daemon service restarted."
  return 0
}

action_uninstall() {
  local exe
  exe="$(resolve_exe_name)"
  local name
  name="$(resolve_install_name)"

  local binary=""
  binary="$(resolve_installed_binary 2>/dev/null || true)"
  if [[ -n "${binary}" && "${PRODUCT}" == "cli" ]]; then
    "${binary}" daemon service uninstall >/dev/null 2>&1 || true
  fi

  rm -f "${BIN_DIR}/${exe}" "${INSTALL_DIR}/bin/${exe}.new" "${INSTALL_DIR}/bin/${exe}.previous" || true
  rm -f "${INSTALL_DIR}/bin/${exe}" || true
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
  tar -xzf "${archive_path}" -C "${dest_dir}" 2> >(grep -v -E "^tar: Ignoring unknown extended header keyword" >&2 || true)
}

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://happier.dev/install | bash

Preview channel:
  curl -fsSL https://happier.dev/install | bash -s -- --channel preview
  curl -fsSL https://happier.dev/install | HAPPIER_CHANNEL=preview bash
  curl -fsSL https://happier.dev/install-preview | bash

Options:
  --channel <stable|preview>
  --stable
  --preview
  --with-daemon
  --without-daemon
  --check
  --restart
  --uninstall [--purge]
  --reset
  --debug
  -h, --help
EOF
}

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
    --with-daemon)
      WITH_DAEMON="1"
      shift 1
      ;;
    --without-daemon)
      WITH_DAEMON="0"
      shift 1
      ;;
    --check)
      ACTION="check"
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
    --debug)
      DEBUG_MODE="1"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift 1
      break
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${DEBUG_MODE}" == "1" ]]; then
  set -x
fi

if [[ "${PRODUCT}" != "cli" && "${PRODUCT}" != "server" ]]; then
  echo "Invalid HAPPIER_PRODUCT='${PRODUCT}'. Expected cli or server." >&2
  exit 1
fi

if [[ "${ACTION}" == "check" ]]; then
  action_check
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

if [[ "${CHANNEL}" != "stable" && "${CHANNEL}" != "preview" ]]; then
  echo "Invalid HAPPIER_CHANNEL='${CHANNEL}'. Expected stable or preview." >&2
  exit 1
fi

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
  printf '%s' "$json" | awk -v re="$name_regex" '
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
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  local export_line="export PATH=\"${BIN_DIR}:\$PATH\""
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
  done

  if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    echo
    say "${COLOR_BOLD}Next steps${COLOR_RESET}"
    say "To use ${EXE_NAME} in your current shell:"
    say "  export PATH=\"${BIN_DIR}:\$PATH\""
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
  else
    echo "Fallback: npx --yes --package @happier-dev/relay-server happier-server --help" >&2
  fi
  exit 1
fi

TAG="cli-stable"
ASSET_REGEX="^happier-v.*-${OS}-${ARCH}[.]tar[.]gz$"
CHECKSUMS_REGEX="^checksums-happier-v.*[.]txt$"
SIG_REGEX="^checksums-happier-v.*[.]txt[.]minisig$"
EXE_NAME="happier"
INSTALL_NAME="Happier CLI"
VERSION_PREFIX="happier-v"
CHECKSUMS_PREFIX="checksums-happier-v"

if [[ "${PRODUCT}" == "server" ]]; then
  if [[ "${OS}" != "linux" ]]; then
    echo "Happier server runtime binaries are currently published for Linux only." >&2
    exit 1
  fi
  TAG="server-stable"
  ASSET_REGEX="^happier-server-v.*-${OS}-${ARCH}[.]tar[.]gz$"
  CHECKSUMS_REGEX="^checksums-happier-server-v.*[.]txt$"
  SIG_REGEX="^checksums-happier-server-v.*[.]txt[.]minisig$"
  EXE_NAME="happier-server"
  INSTALL_NAME="Happier Server"
  VERSION_PREFIX="happier-server-v"
  CHECKSUMS_PREFIX="checksums-happier-server-v"
fi

if [[ "${CHANNEL}" == "preview" ]]; then
  if [[ "${PRODUCT}" == "server" ]]; then
    TAG="server-preview"
  else
    TAG="cli-preview"
  fi
fi

API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
info "Fetching ${TAG} release metadata..."
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

if ! RELEASE_JSON="$(curl_auth "${API_URL}")"; then
  if [[ "${CHANNEL}" == "stable" ]]; then
    echo "No stable releases found for ${INSTALL_NAME}." >&2
  else
    echo "No preview releases found for ${INSTALL_NAME}." >&2
  fi
  exit 1
fi

ASSET_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "${ASSET_REGEX}")"
if [[ -z "${ASSET_URL}" ]]; then
  echo "Unable to locate release assets for ${OS}-${ARCH} on tag ${TAG}." >&2
  exit 1
fi

ASSET_NAME="$(basename "${ASSET_URL}")"
VERSION="${ASSET_NAME#${VERSION_PREFIX}}"
VERSION="${VERSION%-${OS}-${ARCH}.tar.gz}"
if [[ -z "${VERSION}" || "${VERSION}" == "${ASSET_NAME}" ]]; then
  echo "Failed to infer release version from asset name: ${ASSET_NAME}" >&2
  exit 1
fi

CHECKSUMS_REGEX="^${CHECKSUMS_PREFIX}${VERSION}[.]txt$"
SIG_REGEX="^${CHECKSUMS_PREFIX}${VERSION}[.]txt[.]minisig$"
CHECKSUMS_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "${CHECKSUMS_REGEX}")"
SIG_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "${SIG_REGEX}")"
if [[ -z "${CHECKSUMS_URL}" || -z "${SIG_URL}" ]]; then
  echo "Unable to locate release assets for ${OS}-${ARCH} on tag ${TAG}." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  if [[ "${DEBUG_MODE}" == "1" ]]; then
    return
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_PATH="${TMP_DIR}/happier.tar.gz"
CHECKSUMS_PATH="${TMP_DIR}/checksums.txt"
curl_auth -o "${ARCHIVE_PATH}" "${ASSET_URL}"
curl_auth -o "${CHECKSUMS_PATH}" "${CHECKSUMS_URL}"

EXPECTED_SHA="$(grep -E "  $(basename "${ASSET_URL}")$" "${CHECKSUMS_PATH}" | awk '{print $1}' | head -n 1)"
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
curl_auth -o "${SIG_PATH}" "${SIG_URL}"
"${MINISIGN_BIN}" -Vm "${CHECKSUMS_PATH}" -x "${SIG_PATH}" -p "${PUBKEY_PATH}" >/dev/null
success "Signature verified."

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"
tar_extract_gz "${ARCHIVE_PATH}" "${EXTRACT_DIR}"

BINARY_PATH="$(find "${EXTRACT_DIR}" -type f -name "${EXE_NAME}" -perm -u+x | head -n 1 || true)"
if [[ -z "${BINARY_PATH}" ]]; then
  echo "Failed to find extracted ${EXE_NAME} binary." >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}/bin" "${BIN_DIR}"
TARGET_BIN="${INSTALL_DIR}/bin/${EXE_NAME}"
STAGED_BIN="${TARGET_BIN}.new"
PREVIOUS_BIN="${TARGET_BIN}.previous"
cp "${BINARY_PATH}" "${STAGED_BIN}"
chmod +x "${STAGED_BIN}"
if [[ -f "${TARGET_BIN}" ]]; then
  cp "${TARGET_BIN}" "${PREVIOUS_BIN}" >/dev/null 2>&1 || true
  chmod +x "${PREVIOUS_BIN}" >/dev/null 2>&1 || true
fi
# Avoid ETXTBSY when replacing a running executable: swap the directory entry atomically.
mv -f "${STAGED_BIN}" "${TARGET_BIN}"
chmod +x "${TARGET_BIN}"
ln -sf "${INSTALL_DIR}/bin/${EXE_NAME}" "${BIN_DIR}/${EXE_NAME}"

append_path_hint

if [[ "${PRODUCT}" == "cli" && "${WITH_DAEMON}" == "1" ]]; then
  echo
  info "Installing daemon service (user-mode)..."
  if ! "${INSTALL_DIR}/bin/${EXE_NAME}" daemon service install >/dev/null 2>&1; then
    echo "Warning: daemon service install failed. You can retry manually:" >&2
    echo "  ${INSTALL_DIR}/bin/${EXE_NAME} daemon service install" >&2
  fi
fi

echo
echo "${INSTALL_NAME} installed:"
echo "  binary: ${INSTALL_DIR}/bin/${EXE_NAME}"
echo "  shim:   ${BIN_DIR}/${EXE_NAME}"
echo
if [[ "${NONINTERACTIVE}" != "1" ]]; then
  if [[ "${PRODUCT}" == "server" ]]; then
    "${INSTALL_DIR}/bin/${EXE_NAME}" --help >/dev/null 2>&1 || true
  else
    "${INSTALL_DIR}/bin/${EXE_NAME}" --version || true
  fi
fi
