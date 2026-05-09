#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# Ensure dependency installs include devDependencies; the self-host installer builds from source
# and expects build tools (e.g. TypeScript) to be present.
unset NODE_ENV || true
unset npm_config_production || true
unset NPM_CONFIG_PRODUCTION || true
unset YARN_PRODUCTION || true

HSTACK_NPM_SPEC="${HSTACK_NPM_SPEC:-@happier-dev/stack@next}"
HSTACK_TGZ="${HSTACK_TGZ:-}"
HSTACK_HAPPIER_REPO="${HSTACK_HAPPIER_REPO:-}"
HSTACK_E2E_WITH_DAEMON="${HSTACK_E2E_WITH_DAEMON:-1}"
HSTACK_E2E_WITH_UI="${HSTACK_E2E_WITH_UI:-1}"

HAPPIER_NPM_SPEC="${HAPPIER_NPM_SPEC:-@happier-dev/cli@next}"
HAPPIER_TGZ="${HAPPIER_TGZ:-}"
HAPPIER_CLI_INSTALL_MODE="${HAPPIER_CLI_INSTALL_MODE:-global}"

STACK_INTERNAL_SERVER_URL="${STACK_INTERNAL_SERVER_URL:-http://127.0.0.1:3005}"
# In stack context, the daemon forces a stable active server id derived from stack + identity.
# Default to the same stable id to ensure non-interactive auth bootstrap writes credentials
# where the daemon will look for them.
STACK_CLI_ID="${STACK_CLI_ID:-stack_main__id_default}"

STACK_BASE_DIR="/root/.happier/stacks/main"
STACK_CLI_HOME_DIR="${STACK_BASE_DIR}/cli"
STACK_APPROVER_HOME_DIR="${STACK_BASE_DIR}/cli-approver"
STACK_NPM_RETRY_ATTEMPTS="${HAPPIER_RELEASE_ASSETS_NPM_RETRY_ATTEMPTS:-4}"
STACK_NPM_RETRY_SLEEP_SECONDS="${HAPPIER_RELEASE_ASSETS_NPM_RETRY_SLEEP_SECONDS:-5}"

is_npm_install_transient_error() {
  local text="$1"
  grep -Eiq 'ETIMEDOUT|ECONNRESET|network read ETIMEDOUT|503 Service Unavailable|504 Gateway Timeout' <<<"$text"
}

npm_install_with_retry() {
  local label="$1"
  shift
  local -a cmd=("$@")

  if ! [[ "$STACK_NPM_RETRY_ATTEMPTS" =~ ^[0-9]+$ ]] || [[ "$STACK_NPM_RETRY_ATTEMPTS" -lt 1 ]]; then
    echo "[stack] invalid HAPPIER_RELEASE_ASSETS_NPM_RETRY_ATTEMPTS=$STACK_NPM_RETRY_ATTEMPTS (expected integer >= 1)" >&2
    exit 2
  fi
  if ! [[ "$STACK_NPM_RETRY_SLEEP_SECONDS" =~ ^[0-9]+$ ]] || [[ "$STACK_NPM_RETRY_SLEEP_SECONDS" -lt 0 ]]; then
    echo "[stack] invalid HAPPIER_RELEASE_ASSETS_NPM_RETRY_SLEEP_SECONDS=$STACK_NPM_RETRY_SLEEP_SECONDS (expected integer >= 0)" >&2
    exit 2
  fi

  local attempt=1
  local output=""
  local status=0
  while (( attempt <= STACK_NPM_RETRY_ATTEMPTS )); do
    set +e
    output="$("${cmd[@]}" 2>&1)"
    status=$?
    set -e
    if [[ $status -eq 0 ]]; then
      [[ -n "$output" ]] && printf '%s\n' "$output"
      return 0
    fi
    if ! is_npm_install_transient_error "$output"; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi
    printf '%s\n' "$output" >&2
    if (( attempt == STACK_NPM_RETRY_ATTEMPTS )); then
      echo "[stack] npm install retry budget exhausted for ${label} (${attempt}/${STACK_NPM_RETRY_ATTEMPTS})" >&2
      return "$status"
    fi
    next_attempt=$((attempt + 1))
    sleep_seconds=$((STACK_NPM_RETRY_SLEEP_SECONDS * attempt))
    echo "[stack] transient npm install failure during ${label}; retrying (${next_attempt}/${STACK_NPM_RETRY_ATTEMPTS}) after ${sleep_seconds}s..." >&2
    sleep "$sleep_seconds"
    attempt=$next_attempt
  done
  return 1
}

resolve_happier_prefix_from_npm_global_package() {
  local npm_global_root=""
  npm_global_root="$(npm root -g 2>/dev/null || true)"
  if [[ -z "$npm_global_root" || "$npm_global_root" == "undefined" || "$npm_global_root" == "null" ]]; then
    echo "[stack] failed to resolve npm global root (npm root -g)" >&2
    exit 1
  fi

  local expected="$npm_global_root/@happier-dev/cli/dist/index.mjs"
  if [[ ! -f "$expected" ]]; then
    echo "[stack] expected packaged CLI entrypoint at: $expected" >&2
    exit 1
  fi

  if ! node "$expected" --version >/dev/null 2>&1; then
    echo "[stack] expected packaged CLI entrypoint to be runnable: node $expected --version" >&2
    exit 1
  fi

  # Do not rely on `happier` shims in this container: `@happier-dev/stack` also installs one
  # that rewrites HAPPIER_HOME_DIR, which breaks the bootstrap approver identity path.
  HAPPIER_PREFIX=(node "$expected")
}

setup_args=(
  setup
  --profile=selfhost
  --server=happier-server-light
  --non-interactive
  --no-tailscale
  --no-autostart
  --no-menubar
  --no-auth
  --no-start-now
)

if [[ -n "$HSTACK_HAPPIER_REPO" ]]; then
  setup_args+=( "--happier-repo=$HSTACK_HAPPIER_REPO" )
fi

if [[ "$HSTACK_E2E_WITH_UI" != "1" ]]; then
  setup_args+=( --no-ui-deps --no-ui-build )
fi

start_args=(
  start
  --no-browser
  --restart
)

if [[ -n "$HSTACK_TGZ" && -f "$HSTACK_TGZ" ]]; then
  echo "[stack] installing hstack from tarball: $HSTACK_TGZ"
  npm_install_with_retry "install hstack from tarball" npm install -g "$HSTACK_TGZ" >/dev/null
  HSTACK_PREFIX=(hstack)
else
  echo "[stack] installing hstack from npm: $HSTACK_NPM_SPEC"
  npm_install_with_retry "install hstack from npm" npm install -g "$HSTACK_NPM_SPEC" >/dev/null
  HSTACK_PREFIX=(hstack)
fi

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[stack] installing happier-cli from tarball: $HAPPIER_TGZ"
  # `@happier-dev/stack` also exposes a `happier` shim. When we test installing the CLI
  # tarball in the same environment, npm can fail with EEXIST on the `happier` bin link.
  # Use --force so the CLI wins (this is an isolated e2e container).
  npm_install_with_retry "install happier-cli from tarball" npm install -g --force "$HAPPIER_TGZ" >/dev/null
  resolve_happier_prefix_from_npm_global_package
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[stack] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[stack] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm_install_with_retry "install happier-cli from npm" npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  resolve_happier_prefix_from_npm_global_package
fi

bootstrap_stack_credentials() {

  echo "[stack] bootstrapping credentials (non-interactive)..."

  export HAPPIER_SERVER_URL="$STACK_INTERNAL_SERVER_URL"
  export HAPPIER_PUBLIC_SERVER_URL="$STACK_INTERNAL_SERVER_URL"
  export HAPPIER_WEBAPP_URL="$STACK_INTERNAL_SERVER_URL"
  export HAPPIER_ACTIVE_SERVER_ID="$STACK_CLI_ID"

  # Create an approver identity (writes credentials to STACK_APPROVER_HOME_DIR).
  node /opt/happier-npm-e2e/bin/terminal-auth-approve.cjs \
    --server-url "$STACK_INTERNAL_SERVER_URL" \
    --home-dir "$STACK_APPROVER_HOME_DIR" \
    --active-server-id "$STACK_CLI_ID" \
    >/dev/null

  # Request a terminal auth handshake for the main stack daemon identity.
  local req_json
  req_json="$(HAPPIER_HOME_DIR="$STACK_CLI_HOME_DIR" "${HAPPIER_PREFIX[@]}" auth request --json)"

  local public_key
  public_key="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.publicKey||""))' <<<"$req_json")"
  if [[ -z "$public_key" ]]; then
    echo "[stack] auth request did not return publicKey" >&2
    exit 1
  fi

  # Approve using the bootstrap token.
  HAPPIER_HOME_DIR="$STACK_APPROVER_HOME_DIR" "${HAPPIER_PREFIX[@]}" auth approve --json --public-key "$public_key" >/dev/null

  # Claim and write real credentials to STACK_CLI_HOME_DIR.
  HAPPIER_HOME_DIR="$STACK_CLI_HOME_DIR" "${HAPPIER_PREFIX[@]}" auth wait --json --public-key "$public_key" >/dev/null
}

kill_phase1_no_ui_supervisor() {
  # Phase1 runs hstack in a foreground/supervisor mode (no-daemon/no-ui) so we can bootstrap auth.
  # In Docker, that supervisor can linger even after `hstack stop`, keeping the no-UI server alive.
  local pids_raw
  local pids
  pids_raw="$(ps -eo pid,args -ww | awk '/@happier-dev\\/stack\\/scripts\\/run\\.mjs/ && /--no-daemon/ && /--no-ui/ {print $1}' || true)"
  if [[ -z "$pids_raw" ]]; then
    # More robust than ps parsing in some environments; procps provides pgrep.
    pids_raw="$(pgrep -f '@happier-dev/stack/scripts/run\\.mjs.*--no-daemon.*--no-ui' || true)"
  fi
  pids="$(echo "$pids_raw" | tr '\n' ' ' | xargs echo 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    # Fall back to an anchored pkill to avoid accidentally matching the current shell.
    if pkill -9 -f '^/usr/local/bin/node .*@happier-dev/stack/scripts/run\.mjs .*--no-daemon .*--no-ui' >/dev/null 2>&1; then
      echo "[stack] killing phase1 supervisor (pkill fallback)"
      sleep 1
    fi
    return 0
  fi
  echo "[stack] killing phase1 supervisor: $pids"
  kill $pids >/dev/null 2>&1 || true
  sleep 1
  kill -9 $pids >/dev/null 2>&1 || true
}

kill_phase1_server_light() {
  # If the phase1 supervisor is killed abruptly, the server-light process can linger and keep the port busy.
  local pids_raw
  local pids
  pids_raw="$(ps -eo pid,args -ww | awk '/--import tsx \.\/sources\/main\.light\.ts/ {print $1}' || true)"
  pids="$(echo "$pids_raw" | tr '\n' ' ' | xargs echo 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "[stack] killing phase1 server-light: $pids"
  kill $pids >/dev/null 2>&1 || true
  sleep 1
  kill -9 $pids >/dev/null 2>&1 || true
}

echo "[stack] running: hstack ${setup_args[*]}"
"${HSTACK_PREFIX[@]}" "${setup_args[@]}"

cleanup() {
  echo "[stack] stopping stack..."
  "${HSTACK_PREFIX[@]}" stop --yes --aggressive --sweep-owned --no-service >/dev/null 2>&1 || true
}
trap cleanup INT TERM

if [[ "$HSTACK_E2E_WITH_DAEMON" == "1" ]]; then
  # Phase 1: start server-only so we can complete the auth handshake in a headless environment.
  echo "[stack] starting server (phase 1: no-daemon, no-ui)..."
  "${HSTACK_PREFIX[@]}" start --no-daemon --no-ui --no-browser --restart &
  phase1_pid="$!"

  # Wait for server.
  for _ in $(seq 1 120); do
    if curl -fsS "${STACK_INTERNAL_SERVER_URL}/v1/version" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fsS "${STACK_INTERNAL_SERVER_URL}/v1/version" >/dev/null 2>&1; then
    echo "[stack] server did not become ready for auth bootstrap" >&2
    kill "$phase1_pid" >/dev/null 2>&1 || true
    exit 1
  fi

  bootstrap_stack_credentials

  echo "[stack] stopping phase 1..."
  "${HSTACK_PREFIX[@]}" stop --yes --aggressive --sweep-owned --no-service || true
  kill "$phase1_pid" >/dev/null 2>&1 || true
  kill_phase1_no_ui_supervisor
  kill_phase1_server_light
  sleep 1

  export HAPPIER_ACTIVE_SERVER_ID="$STACK_CLI_ID"
  export HAPPIER_HOME_DIR="$STACK_CLI_HOME_DIR"
fi

if [[ "$HSTACK_E2E_WITH_UI" != "1" ]]; then
  start_args+=( --no-ui )
fi
if [[ "$HSTACK_E2E_WITH_DAEMON" != "1" ]]; then
  start_args+=( --no-daemon )
fi

echo "[stack] starting stack (phase 2)..."
"${HSTACK_PREFIX[@]}" "${start_args[@]}"

echo "[stack] keeping container alive (stack start daemonizes processes)..."
while true; do
  if ! curl -fsS "${STACK_INTERNAL_SERVER_URL}/v1/version" >/dev/null 2>&1; then
    echo "[stack] server healthcheck failed (${STACK_INTERNAL_SERVER_URL}/v1/version)" >&2
    exit 1
  fi
  sleep 5
done
