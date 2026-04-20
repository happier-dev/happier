#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "usage: apt-install-with-retry.sh <package> [<package> ...]" >&2
    exit 64
fi

LOG_PATH="${APT_INSTALL_LOG_PATH:-${TMPDIR:-/tmp}/apt-install.log}"
MAX_ATTEMPTS="${APT_INSTALL_MAX_ATTEMPTS:-4}"
SLEEP_SECONDS="${APT_INSTALL_RETRY_SLEEP_SECONDS:-15}"
APT_RETRIES="${APT_INSTALL_APT_RETRIES:-3}"
APT_HTTP_TIMEOUT="${APT_INSTALL_HTTP_TIMEOUT_SECONDS:-30}"
APT_HTTPS_TIMEOUT="${APT_INSTALL_HTTPS_TIMEOUT_SECONDS:-30}"
APT_BY_HASH_MODE="${APT_INSTALL_BY_HASH_MODE:-force}"

APT_FLAGS=(
    -o "Acquire::Retries=${APT_RETRIES}"
    -o "Acquire::http::Timeout=${APT_HTTP_TIMEOUT}"
    -o "Acquire::https::Timeout=${APT_HTTPS_TIMEOUT}"
    -o "Acquire::By-Hash=${APT_BY_HASH_MODE}"
)

is_transient_apt_error() {
    local log_path="$1"
    grep -Eq 'Mirror sync in progress\?|File has unexpected size|Hash Sum mismatch' "$log_path" && return 0
    grep -Eq 'Temporary failure resolving|Could not resolve|Connection failed|Could not connect|Connection timed out|TLS handshake timeout' "$log_path" && return 0
    grep -Eq 'Failed to fetch .* (Connection failed|Could not connect|Connection timed out|Temporary failure resolving)' "$log_path" && return 0
    return 1
}

clear_apt_state() {
    apt-get clean >/dev/null 2>&1 || true
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/* 2>/dev/null || true
}

run_apt_install() {
    apt-get "${APT_FLAGS[@]}" update >"$LOG_PATH" 2>&1 || return $?
    apt-get "${APT_FLAGS[@]}" install -y --no-install-recommends "$@" >>"$LOG_PATH" 2>&1
}

export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if run_apt_install "$@"; then
        rm -f "$LOG_PATH" || true
        exit 0
    fi

    if is_transient_apt_error "$LOG_PATH"; then
        cat "$LOG_PATH" >&2
        if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
            clear_apt_state
            echo "apt-get failed due to transient mirror/network issue (attempt ${attempt}/${MAX_ATTEMPTS}), retrying..." >&2
            sleep "$SLEEP_SECONDS"
            attempt=$((attempt + 1))
            continue
        fi
        echo "apt-get failed with repeated transient mirror/network failures after ${attempt} attempts." >&2
        exit 1
    fi

    cat "$LOG_PATH" >&2
    echo "apt-get failed with a non-transient error (attempt ${attempt}); not retrying." >&2
    exit 1
done

echo "apt-get failed after ${MAX_ATTEMPTS} attempts." >&2
exit 1
