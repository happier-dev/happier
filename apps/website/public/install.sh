#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${HAPPIER_CHANNEL:-stable}"
INSTALL_DIR="${HAPPIER_INSTALL_DIR:-$HOME/.happier}"
BIN_DIR="${HAPPIER_BIN_DIR:-$HOME/.local/bin}"
NO_PATH_UPDATE="${HAPPIER_NO_PATH_UPDATE:-0}"
NONINTERACTIVE="${HAPPIER_NONINTERACTIVE:-0}"
GITHUB_REPO="${HAPPIER_GITHUB_REPO:-happier-dev/happier}"
DEFAULT_MINISIGN_PUBKEY="$(cat <<'EOF'
untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
EOF
)"
MINISIGN_PUBKEY="${HAPPIER_MINISIGN_PUBKEY:-${DEFAULT_MINISIGN_PUBKEY}}"
MINISIGN_PUBKEY_URL="${HAPPIER_MINISIGN_PUBKEY_URL:-https://happier.dev/happier-release.pub}"

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
  printf '%s' "$json" | awk -v re="$name_regex" '
    BEGIN { RS="{"; ORS="\n" }
    {
      name=""; url="";
      for (i = 1; i <= NF; i++) {
        line = $i;
        if (line ~ /"name"[[:space:]]*:/) {
          sub(/.*"name"[[:space:]]*:[[:space:]]*"/, "", line);
          sub(/".*/, "", line);
          name = line;
        }
        if (line ~ /"browser_download_url"[[:space:]]*:/) {
          sub(/.*"browser_download_url"[[:space:]]*:[[:space:]]*"/, "", line);
          sub(/".*/, "", line);
          url = line;
        }
      }
      if (name ~ re && url != "") {
        print url;
        exit;
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

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  return 1
}

ensure_minisign() {
  if command -v minisign >/dev/null 2>&1; then
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    brew install minisign && return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update -y && run_privileged apt-get install -y minisign && return 0
  fi

  if command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y minisign && return 0
  fi

  if command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y minisign && return 0
  fi

  if command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --noconfirm minisign && return 0
  fi

  if command -v apk >/dev/null 2>&1; then
    run_privileged apk add --no-cache minisign && return 0
  fi

  if command -v zypper >/dev/null 2>&1; then
    run_privileged zypper --non-interactive install minisign && return 0
  fi

  return 1
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
  local rc_file
  case "${shell_name}" in
    zsh) rc_file="$HOME/.zshrc" ;;
    bash) rc_file="$HOME/.bashrc" ;;
    *) rc_file="$HOME/.profile" ;;
  esac
  local export_line="export PATH=\"${BIN_DIR}:\$PATH\""
  if [[ ! -f "${rc_file}" ]] || ! grep -Fq "${export_line}" "${rc_file}"; then
    printf '\n%s\n' "${export_line}" >> "${rc_file}"
    echo "Added ${BIN_DIR} to PATH in ${rc_file}"
  fi
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
if [[ "${OS}" == "unsupported" || "${ARCH}" == "unsupported" ]]; then
  echo "Unsupported platform: $(uname -s)/$(uname -m)" >&2
  echo "Fallback: npm install -g @happier-dev/cli" >&2
  exit 1
fi

TAG="cli-stable"
if [[ "${CHANNEL}" == "preview" ]]; then
  TAG="cli-preview"
fi

API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
echo "Fetching ${TAG} release metadata..."
RELEASE_JSON="$(curl -fsSL "${API_URL}")"

ASSET_REGEX="^happier-v.*-${OS}-${ARCH}\\.tar\\.gz$"
CHECKSUMS_REGEX="^checksums-happier-v.*\\.txt$"
SIG_REGEX="^checksums-happier-v.*\\.txt\\.minisig$"

ASSET_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "${ASSET_REGEX}")"
CHECKSUMS_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "${CHECKSUMS_REGEX}")"
SIG_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "${SIG_REGEX}")"
if [[ -z "${ASSET_URL}" || -z "${CHECKSUMS_URL}" || -z "${SIG_URL}" ]]; then
  echo "Unable to locate release assets for ${OS}-${ARCH} on tag ${TAG}." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_PATH="${TMP_DIR}/happier.tar.gz"
CHECKSUMS_PATH="${TMP_DIR}/checksums.txt"
curl -fsSL "${ASSET_URL}" -o "${ARCHIVE_PATH}"
curl -fsSL "${CHECKSUMS_URL}" -o "${CHECKSUMS_PATH}"

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
echo "Checksum verified."

if ! ensure_minisign; then
  echo "minisign is required for installer signature verification." >&2
  echo "Install minisign manually and rerun, or set HAPPIER_MINISIGN_PUBKEY with a trusted key." >&2
  exit 1
fi

PUBKEY_PATH="${TMP_DIR}/minisign.pub"
SIG_PATH="${TMP_DIR}/checksums.txt.minisig"
write_minisign_public_key "${PUBKEY_PATH}"
curl -fsSL "${SIG_URL}" -o "${SIG_PATH}"
minisign -Vm "${CHECKSUMS_PATH}" -x "${SIG_PATH}" -p "${PUBKEY_PATH}" >/dev/null
echo "Signature verified."

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"

BINARY_PATH="$(find "${EXTRACT_DIR}" -type f -name happier -perm -u+x | head -n 1 || true)"
if [[ -z "${BINARY_PATH}" ]]; then
  echo "Failed to find extracted happier binary." >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}/bin" "${BIN_DIR}"
cp "${BINARY_PATH}" "${INSTALL_DIR}/bin/happier"
chmod +x "${INSTALL_DIR}/bin/happier"
ln -sf "${INSTALL_DIR}/bin/happier" "${BIN_DIR}/happier"

append_path_hint

echo
echo "Happier CLI installed:"
echo "  binary: ${INSTALL_DIR}/bin/happier"
echo "  shim:   ${BIN_DIR}/happier"
echo
if [[ "${NONINTERACTIVE}" != "1" ]]; then
  "${INSTALL_DIR}/bin/happier" --version || true
fi
