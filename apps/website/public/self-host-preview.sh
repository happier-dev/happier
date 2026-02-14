#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${HAPPIER_CHANNEL:-preview}"
MODE="${HAPPIER_SELF_HOST_MODE:-user}"
MODE_SOURCE="default"
if [[ -n "${HAPPIER_SELF_HOST_MODE:-}" ]]; then
  MODE_SOURCE="env"
fi
WITH_CLI="${HAPPIER_WITH_CLI:-1}"
NONINTERACTIVE="${HAPPIER_NONINTERACTIVE:-0}"
HAPPIER_HOME="${HAPPIER_HOME:-${HOME}/.happier}"
STACK_INSTALL_DIR="${HAPPIER_STACK_INSTALL_ROOT:-}"
STACK_BIN_DIR="${HAPPIER_STACK_BIN_DIR:-}"
GITHUB_REPO="${HAPPIER_GITHUB_REPO:-happier-dev/happier}"
DEFAULT_MINISIGN_PUBKEY="$(cat <<'EOF'
untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
EOF
)"
MINISIGN_PUBKEY="${HAPPIER_MINISIGN_PUBKEY:-${DEFAULT_MINISIGN_PUBKEY}}"
MINISIGN_PUBKEY_URL="${HAPPIER_MINISIGN_PUBKEY_URL:-https://happier.dev/happier-release.pub}"
MINISIGN_BIN="minisign"

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://happier.dev/self-host | bash

Mode:
  curl -fsSL https://happier.dev/self-host | bash -s -- --mode user
  curl -fsSL https://happier.dev/self-host | sudo bash -s -- --mode system

Preview channel:
  curl -fsSL https://happier.dev/self-host | bash -s -- --channel preview
  curl -fsSL https://happier.dev/self-host | HAPPIER_CHANNEL=preview bash
  curl -fsSL https://happier.dev/self-host-preview | bash

Windows (PowerShell):
  irm https://happier.dev/self-host-preview.ps1 | iex

Options:
  --mode <user|system>
  --user
  --system
  --channel <stable|preview>
  --stable
  --preview
  -h, --help
EOF
}

for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      usage
      exit 0
      ;;
  esac
done

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Missing value for --mode" >&2
        usage >&2
        exit 1
      fi
      MODE="${2}"
      MODE_SOURCE="arg"
      shift 2
      ;;
    --mode=*)
      MODE="${1#*=}"
      if [[ -z "${MODE}" ]]; then
        echo "Missing value for --mode" >&2
        usage >&2
        exit 1
      fi
      MODE_SOURCE="arg"
      shift 1
      ;;
    --user)
      MODE="user"
      MODE_SOURCE="arg"
      shift 1
      ;;
    --system)
      MODE="system"
      MODE_SOURCE="arg"
      shift 1
      ;;
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

if [[ "${MODE}" != "user" && "${MODE}" != "system" ]]; then
  echo "Invalid mode: ${MODE}. Expected user or system." >&2
  exit 1
fi

if [[ "${CHANNEL}" != "stable" && "${CHANNEL}" != "preview" ]]; then
  echo "Invalid HAPPIER_CHANNEL='${CHANNEL}'. Expected stable or preview." >&2
  exit 1
fi

UNAME="$(uname -s)"
OS=""
case "${UNAME}" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)
    echo "Happier Self-Host guided installer currently supports macOS and Linux only." >&2
    echo "On Windows, run the PowerShell installer instead:" >&2
    echo "  irm https://happier.dev/self-host-preview.ps1 | iex" >&2
    exit 1
    ;;
esac

if [[ -z "${STACK_INSTALL_DIR}" ]]; then
  if [[ "${MODE}" == "system" ]]; then
    STACK_INSTALL_DIR="${HAPPIER_INSTALL_DIR:-/opt/happier}"
  else
    STACK_INSTALL_DIR="${HAPPIER_HOME}/stack"
  fi
fi

if [[ -z "${STACK_BIN_DIR}" ]]; then
  if [[ "${MODE}" == "system" ]]; then
    STACK_BIN_DIR="${HAPPIER_BIN_DIR:-/usr/local/bin}"
  else
    STACK_BIN_DIR="${HAPPIER_HOME}/bin"
  fi
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

if [[ "${OS}" == "linux" && ! command -v systemctl >/dev/null 2>&1 ]]; then
  echo "systemctl is required for self-host installation on Linux." >&2
  exit 1
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: ${ARCH}" >&2
    exit 1
    ;;
esac

TAG="stack-stable"
if [[ "${CHANNEL}" == "preview" ]]; then
  TAG="stack-preview"
fi

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

ensure_minisign() {
  if command -v minisign >/dev/null 2>&1; then
    MINISIGN_BIN="minisign"
    return 0
  fi

  # Self-contained fallback: download a known minisign release asset into TMP_DIR.
  local minisign_version="0.12"
  local asset=""
  local expected_sha=""
  if [[ "${OS}" == "linux" ]]; then
    asset="minisign-${minisign_version}-linux.tar.gz"
    expected_sha="9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73"
  elif [[ "${OS}" == "darwin" ]]; then
    asset="minisign-${minisign_version}-macos.zip"
    expected_sha="89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63"
  else
    echo "minisign bootstrap is not supported on this platform." >&2
    return 1
  fi
  local url_base="https://github.com/jedisct1/minisign/releases/download/${minisign_version}"

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
    tar -xzf "${archive_path}" -C "${extract_dir}"
  else
    if command -v unzip >/dev/null 2>&1; then
      unzip -q "${archive_path}" -d "${extract_dir}"
    elif command -v ditto >/dev/null 2>&1; then
      ditto -x -k "${archive_path}" "${extract_dir}"
    else
      echo "unzip (or ditto) is required to bootstrap minisign on macOS." >&2
      return 1
    fi
  fi
  local bin_path
  bin_path="$(find "${extract_dir}" -type f -name minisign | head -n 1 || true)"
  if [[ -z "${bin_path}" ]]; then
    echo "Failed to locate minisign binary in bootstrap archive." >&2
    return 1
  fi
  chmod +x "${bin_path}" || true
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

API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
echo "Fetching ${TAG} release metadata..."
if ! RELEASE_JSON="$(curl -fsSL "${API_URL}")"; then
  if [[ "${CHANNEL}" == "stable" ]]; then
    echo "No stable releases found for Happier Stack." >&2
  else
    echo "No preview releases found for Happier Stack." >&2
  fi
  exit 1
fi
ASSET_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "^hstack-v.*-${OS}-${ARCH}\\.tar\\.gz$")"
CHECKSUMS_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "^checksums-hstack-v.*\\.txt$")"
SIG_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "^checksums-hstack-v.*\\.txt\\.minisig$")"
if [[ -z "${ASSET_URL}" ]]; then
  echo "Unable to find hstack binary for ${OS}-${ARCH} in ${TAG}." >&2
  exit 1
fi
if [[ -z "${CHECKSUMS_URL}" ]]; then
  echo "Unable to find checksums for hstack in ${TAG}." >&2
  exit 1
fi
if [[ -z "${SIG_URL}" ]]; then
  echo "Unable to find minisign signature for hstack checksums in ${TAG}." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_PATH="${TMP_DIR}/hstack.tar.gz"
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
"${MINISIGN_BIN}" -Vm "${CHECKSUMS_PATH}" -x "${SIG_PATH}" -p "${PUBKEY_PATH}" >/dev/null
echo "Signature verified."

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"
BINARY_PATH="$(find "${EXTRACT_DIR}" -type f -name hstack -perm -u+x | head -n 1 || true)"
if [[ -z "${BINARY_PATH}" ]]; then
  echo "Failed to locate extracted hstack binary." >&2
  exit 1
fi

mkdir -p "${STACK_INSTALL_DIR}/bin" "${STACK_BIN_DIR}"
cp "${BINARY_PATH}" "${STACK_INSTALL_DIR}/bin/hstack"
chmod +x "${STACK_INSTALL_DIR}/bin/hstack"
ln -sf "${STACK_INSTALL_DIR}/bin/hstack" "${STACK_BIN_DIR}/hstack"

echo "Installed hstack to ${STACK_INSTALL_DIR}/bin/hstack"

SELF_HOST_ARGS=(self-host install --non-interactive --channel="${CHANNEL}" --mode="${MODE}")
if [[ "${WITH_CLI}" != "1" ]]; then
  SELF_HOST_ARGS+=(--without-cli)
fi

export HAPPIER_NONINTERACTIVE="${NONINTERACTIVE}"

if [[ "${NONINTERACTIVE}" != "1" ]]; then
  echo "Starting Happier Self-Host guided installation..."
fi
"${STACK_INSTALL_DIR}/bin/hstack" "${SELF_HOST_ARGS[@]}"

echo
echo "Happier Self-Host installation completed."
echo "Run: ${STACK_BIN_DIR}/hstack self-host status"
