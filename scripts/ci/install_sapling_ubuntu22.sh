#!/usr/bin/env bash
set -euo pipefail

SAPLING_TAG='0.2.20250521-115337+25ed6ac4'
SAPLING_ASSET='sapling_0.2.20250521-115337+25ed6ac4_amd64.Ubuntu22.04.deb'
SAPLING_SHA256='4f623cb28fe0b56aa7e6dc31968970f73e4a68dcdf23864527d980f4784d01a9'
SAPLING_TAG_URL="${SAPLING_TAG//+/%2B}"
SAPLING_DOWNLOAD_URL="https://github.com/facebook/sapling/releases/download/${SAPLING_TAG_URL}/${SAPLING_ASSET}"
SAPLING_ASSET_PATH="/tmp/${SAPLING_ASSET}"

curl -fsSL -o "${SAPLING_ASSET_PATH}" "${SAPLING_DOWNLOAD_URL}"
echo "${SAPLING_SHA256}  ${SAPLING_ASSET_PATH}" | sha256sum --check --strict

if command -v sudo >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "${SAPLING_ASSET_PATH}"
else
  apt-get update
  apt-get install -y --no-install-recommends "${SAPLING_ASSET_PATH}"
fi
