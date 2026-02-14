#!/usr/bin/env bash
set -euo pipefail

minisign_version="0.12"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m | tr '[:upper:]' '[:lower:]')"

if command -v minisign >/dev/null 2>&1; then
  echo "minisign already present: $(command -v minisign)" >&2
  exit 0
fi

tmp_root="${RUNNER_TEMP:-}"
if [[ -z "${tmp_root}" ]]; then
  tmp_root="$(mktemp -d 2>/dev/null || mktemp -d -t happier-minisign)"
fi

work_dir="${tmp_root}/happier-minisign-${minisign_version}"
mkdir -p "${work_dir}"

url_base="https://github.com/jedisct1/minisign/releases/download/${minisign_version}"
asset=""
expected_sha=""

case "${os}" in
  linux)
    asset="minisign-${minisign_version}-linux.tar.gz"
    expected_sha="9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73"
    ;;
  darwin)
    asset="minisign-${minisign_version}-macos.zip"
    expected_sha="89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63"
    ;;
  msys*|mingw*|cygwin*)
    # Only used if someone runs this composite action on Windows.
    asset="minisign-${minisign_version}-win64.zip"
    expected_sha="37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479"
    ;;
  *)
    echo "Unsupported OS for minisign bootstrap: ${os} (arch=${arch})" >&2
    exit 1
    ;;
esac

archive_path="${work_dir}/${asset}"
curl -fsSL "${url_base}/${asset}" -o "${archive_path}"

actual_sha=""
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "${archive_path}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha="$(shasum -a 256 "${archive_path}" | awk '{print $1}')"
else
  echo "Neither sha256sum nor shasum is available to verify minisign bootstrap." >&2
  exit 1
fi

if [[ "${actual_sha}" != "${expected_sha}" ]]; then
  echo "minisign bootstrap checksum mismatch (expected ${expected_sha}, got ${actual_sha})." >&2
  exit 1
fi

extract_dir="${work_dir}/extract"
mkdir -p "${extract_dir}"

case "${asset}" in
  *.tar.gz)
    tar -xzf "${archive_path}" -C "${extract_dir}"
    ;;
  *.zip)
    if command -v unzip >/dev/null 2>&1; then
      unzip -q "${archive_path}" -d "${extract_dir}"
    else
      echo "unzip is required to extract ${asset} but was not found." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unexpected minisign asset type: ${asset}" >&2
    exit 1
    ;;
esac

bin_path="$(find "${extract_dir}" -type f \( -name minisign -o -name minisign.exe \) 2>/dev/null | head -n 1 || true)"
if [[ -z "${bin_path}" ]]; then
  echo "Failed to locate minisign binary in bootstrap archive." >&2
  exit 1
fi
chmod +x "${bin_path}" || true

bin_dir="$(dirname "${bin_path}")"
echo "Bootstrapped minisign: ${bin_path}" >&2

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${bin_dir}" >> "${GITHUB_PATH}"
else
  echo "${bin_dir}"
fi
