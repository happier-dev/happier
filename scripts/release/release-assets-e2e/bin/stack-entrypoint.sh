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
  npm install -g "$HSTACK_TGZ" >/dev/null
  HSTACK_PREFIX=(hstack)
else
  echo "[stack] installing hstack from npm: $HSTACK_NPM_SPEC"
  npm install -g "$HSTACK_NPM_SPEC" >/dev/null
  HSTACK_PREFIX=(hstack)
fi

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[stack] installing happier-cli from tarball: $HAPPIER_TGZ"
  npm install -g "$HAPPIER_TGZ" >/dev/null
  HAPPIER_PREFIX=(happier)
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[stack] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[stack] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  HAPPIER_PREFIX=(happier)
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
