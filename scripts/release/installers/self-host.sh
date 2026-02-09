#!/usr/bin/env bash
set -euo pipefail

CHANNEL="${HAPPIER_CHANNEL:-stable}"
WITH_CLI="${HAPPIER_WITH_CLI:-1}"
NONINTERACTIVE="${HAPPIER_NONINTERACTIVE:-0}"
STACK_INSTALL_DIR="${HAPPIER_SELF_HOST_INSTALL_ROOT:-${HAPPIER_INSTALL_DIR:-/opt/happier}}"
STACK_BIN_DIR="${HAPPIER_SELF_HOST_BIN_DIR:-${HAPPIER_BIN_DIR:-/usr/local/bin}}"
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

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Happier Self-Host guided installer currently supports Linux only." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required for self-host installation." >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    echo "Re-running with sudo for system-level install..."
    exec sudo -E bash "$0" "$@"
  fi
  echo "Please run as root (or install sudo)." >&2
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
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y minisign && return 0
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y minisign && return 0
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y minisign && return 0
  fi

  if command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm minisign && return 0
  fi

  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache minisign && return 0
  fi

  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install minisign && return 0
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

API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
echo "Fetching ${TAG} release metadata..."
RELEASE_JSON="$(curl -fsSL "${API_URL}")"
ASSET_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "^hstack-v.*-linux-${ARCH}\\.tar\\.gz$")"
CHECKSUMS_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "^checksums-hstack-v.*\\.txt$")"
SIG_URL="$(json_lookup_asset_url "${RELEASE_JSON}" "^checksums-hstack-v.*\\.txt\\.minisig$")"
if [[ -z "${ASSET_URL}" ]]; then
  echo "Unable to find hstack binary for linux-${ARCH} in ${TAG}." >&2
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
minisign -Vm "${CHECKSUMS_PATH}" -x "${SIG_PATH}" -p "${PUBKEY_PATH}" >/dev/null
echo "Signature verified."

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"
BINARY_PATH="$(find "${EXTRACT_DIR}" -type f -name hstack -perm -u+x | head -n 1 || true)"
if [[ -z "${BINARY_PATH}" ]]; then
  echo "Failed to locate extracted hstack binary." >&2
  exit 1
fi

mkdir -p "${STACK_INSTALL_DIR}/bin" "${STACK_BIN_DIR}" /etc/happier /var/lib/happier /var/log/happier
cp "${BINARY_PATH}" "${STACK_INSTALL_DIR}/bin/hstack"
chmod +x "${STACK_INSTALL_DIR}/bin/hstack"
ln -sf "${STACK_INSTALL_DIR}/bin/hstack" "${STACK_BIN_DIR}/hstack"

echo "Installed hstack to ${STACK_INSTALL_DIR}/bin/hstack"

SELF_HOST_ARGS=(self-host install --non-interactive --channel="${CHANNEL}")
if [[ "${WITH_CLI}" != "1" ]]; then
  SELF_HOST_ARGS+=(--without-cli)
fi

export HAPPIER_SELF_HOST_INSTALL_ROOT="${STACK_INSTALL_DIR}"
export HAPPIER_SELF_HOST_BIN_DIR="${STACK_BIN_DIR}"
export HAPPIER_NONINTERACTIVE="${NONINTERACTIVE}"

if [[ "${NONINTERACTIVE}" != "1" ]]; then
  echo "Starting Happier Self-Host guided installation..."
fi
"${STACK_INSTALL_DIR}/bin/hstack" "${SELF_HOST_ARGS[@]}"

echo
echo "Happier Self-Host installation completed."
echo "Run: hstack self-host status"
