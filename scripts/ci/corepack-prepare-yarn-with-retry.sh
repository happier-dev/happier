#!/usr/bin/env bash

set -euo pipefail

yarn_version="1.22.22"
max_attempts="${HAPPIER_COREPACK_MAX_ATTEMPTS:-4}"
retry_delay_seconds="${HAPPIER_COREPACK_RETRY_DELAY_SECONDS:-5}"

if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "HAPPIER_COREPACK_MAX_ATTEMPTS must be a positive integer." >&2
  exit 2
fi
if [[ ! "$retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "HAPPIER_COREPACK_RETRY_DELAY_SECONDS must be a non-negative integer." >&2
  exit 2
fi

corepack enable

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  if corepack prepare "yarn@${yarn_version}" --activate; then
    exit 0
  fi
  if ((attempt >= max_attempts)); then
    echo "Corepack failed to prepare Yarn ${yarn_version} after ${max_attempts} attempts." >&2
    exit 1
  fi

  delay_seconds=$((retry_delay_seconds * (2 ** (attempt - 1))))
  echo "Corepack failed to prepare Yarn ${yarn_version}; retrying in ${delay_seconds}s (attempt $((attempt + 1))/${max_attempts})." >&2
  sleep "$delay_seconds"
done

exit 1
