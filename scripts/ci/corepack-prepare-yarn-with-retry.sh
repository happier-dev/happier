#!/usr/bin/env bash

set -euo pipefail

yarn_version="1.22.22"
max_attempts="${HAPPIER_COREPACK_MAX_ATTEMPTS:-4}"
retry_delay_seconds="${HAPPIER_COREPACK_RETRY_DELAY_SECONDS:-5}"
log_path="${HAPPIER_COREPACK_LOG_PATH:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/corepack-prepare-yarn.log}"

if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "HAPPIER_COREPACK_MAX_ATTEMPTS must be a positive integer." >&2
  exit 2
fi
if [[ ! "$retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "HAPPIER_COREPACK_RETRY_DELAY_SECONDS must be a non-negative integer." >&2
  exit 2
fi

corepack enable

is_transient_corepack_error() {
  grep -Eqi 'Error when performing the request|HTTP[^0-9]*(408|429|5[0-9]{2})|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network connection|AssertionError \[ERR_ASSERTION\]: assert\(!this\.paused\)' "$1"
}

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  if corepack prepare "yarn@${yarn_version}" --activate >"$log_path" 2>&1; then
    rm -f "$log_path" || true
    exit 0
  fi

  cat "$log_path" >&2
  if ! is_transient_corepack_error "$log_path"; then
    echo "Corepack failed to prepare Yarn ${yarn_version} with a non-transient error; not retrying." >&2
    exit 1
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
