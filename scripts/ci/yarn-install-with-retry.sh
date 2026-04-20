#!/bin/sh
set -eu

LOG_PATH="${YARN_INSTALL_LOG_PATH:-${TMPDIR:-/tmp}/yarn-install.log}"
MAX_ATTEMPTS="${YARN_INSTALL_MAX_ATTEMPTS:-3}"
SLEEP_SECONDS="${YARN_INSTALL_RETRY_SLEEP_SECONDS:-5}"
DEFAULT_REGISTRY="${YARN_INSTALL_REGISTRY:-https://registry.npmjs.org}"

is_transient_yarn_error() {
    log_path="$1"
    # Retry only when the failure is very likely transient (registry/network throttling).
    # Do not retry on lockfile/schema/package errors.
    grep -Eq 'Request failed "(5[0-9]{2}|429)' "$log_path" && return 0
    grep -Eq 'EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up' "$log_path" && return 0
    grep -Eq 'trouble with your network connection' "$log_path" && return 0
    return 1
}

configure_registry() {
    current_registry="${npm_config_registry:-}"
    if [ -z "$current_registry" ] || [ "$current_registry" = "https://registry.yarnpkg.com" ] || [ "$current_registry" = "https://registry.yarnpkg.com/" ]; then
        npm_config_registry="${DEFAULT_REGISTRY}"
    fi
    export npm_config_registry
    : "${NPM_CONFIG_REGISTRY:=${npm_config_registry}}"
    export NPM_CONFIG_REGISTRY
    yarn config set registry "${npm_config_registry%/}/" >/dev/null
}

clear_cache_after_transient_failure() {
    yarn cache clean >/dev/null 2>&1 || true
}

configure_registry

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if yarn install "$@" >"$LOG_PATH" 2>&1; then
        rm -f "$LOG_PATH" || true
        exit 0
    fi

    if is_transient_yarn_error "$LOG_PATH"; then
        cat "$LOG_PATH" >&2
        if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
            clear_cache_after_transient_failure
            echo "yarn install failed due to transient network/registry issue (attempt ${attempt}/${MAX_ATTEMPTS}), retrying..." >&2
            sleep "$SLEEP_SECONDS"
            attempt=$((attempt + 1))
            continue
        fi
        echo "yarn install failed with repeated transient network/registry failures after ${attempt} attempts." >&2
        exit 1
    fi

    cat "$LOG_PATH" >&2
    echo "yarn install failed with a non-transient error (attempt ${attempt}); not retrying." >&2
    exit 1
done

echo "yarn install failed after ${MAX_ATTEMPTS} attempts." >&2
exit 1
