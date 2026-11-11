#!/usr/bin/env bash
set -euo pipefail

SAPLING_TAG='0.2.20250521-115337+25ed6ac4'
SAPLING_ASSET='sapling_0.2.20250521-115337+25ed6ac4_amd64.Ubuntu22.04.deb'
SAPLING_SHA256='4f623cb28fe0b56aa7e6dc31968970f73e4a68dcdf23864527d980f4784d01a9'
# Release asset id of SAPLING_ASSET in meta/sapling (formerly facebook/sapling).
# The github.com/.../releases/download URL for this repository answers 504, while the
# release-asset API serves the same bytes; the checksum below pins them either way.
SAPLING_ASSET_ID='256794240'
SAPLING_DOWNLOAD_URL="https://api.github.com/repos/meta/sapling/releases/assets/${SAPLING_ASSET_ID}"
SAPLING_ASSET_PATH="/tmp/${SAPLING_ASSET}"

curl_args=(-fsSL -H 'Accept: application/octet-stream')
github_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -n "${github_token}" ]; then
  # Anonymous API downloads share a per-IP rate limit across runners.
  curl_args+=(-H "Authorization: Bearer ${github_token}")
fi
curl "${curl_args[@]}" -o "${SAPLING_ASSET_PATH}" "${SAPLING_DOWNLOAD_URL}"
echo "${SAPLING_SHA256}  ${SAPLING_ASSET_PATH}" | sha256sum --check --strict

if command -v sudo >/dev/null 2>&1; then
  # The pinned local archive and Ubuntu runner metadata already identify its dependencies.
  # Refreshing every mirror here can stall installation before any dependency is needed.
  sudo apt-get install -y --no-install-recommends "${SAPLING_ASSET_PATH}"
else
  apt-get install -y --no-install-recommends "${SAPLING_ASSET_PATH}"
fi
