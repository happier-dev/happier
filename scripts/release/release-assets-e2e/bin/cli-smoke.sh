#!/usr/bin/env bash
set -euo pipefail

HAPPIER_NPM_SPEC="${HAPPIER_NPM_SPEC:-@happier-dev/cli@next}"
HAPPIER_TGZ="${HAPPIER_TGZ:-}"
HAPPIER_SERVER_URL="${HAPPIER_SERVER_URL:-http://stack:3005}"
HAPPIER_E2E_WITH_DAEMON="${HAPPIER_E2E_WITH_DAEMON:-1}"
HAPPIER_CLI_INSTALL_MODE="${HAPPIER_CLI_INSTALL_MODE:-global}"

HAPPIER_ACTIVE_SERVER_ID="${HAPPIER_ACTIVE_SERVER_ID:-smoke}"
HAPPIER_PUBLIC_SERVER_URL="${HAPPIER_PUBLIC_SERVER_URL:-$HAPPIER_SERVER_URL}"
HAPPIER_WEBAPP_URL="${HAPPIER_WEBAPP_URL:-$HAPPIER_SERVER_URL}"

CLIENT_HOME_DIR="${CLIENT_HOME_DIR:-/work/happier-home}"
APPROVER_HOME_DIR="${APPROVER_HOME_DIR:-/work/happier-approver-home}"

resolve_happier_prefix_from_npm_global_bin() {
  local npm_global_prefix=""
  npm_global_prefix="$(npm prefix -g 2>/dev/null || true)"
  if [[ -z "$npm_global_prefix" || "$npm_global_prefix" == "undefined" || "$npm_global_prefix" == "null" ]]; then
    npm_global_prefix="$(npm config get prefix 2>/dev/null || true)"
  fi

  if [[ -z "$npm_global_prefix" || "$npm_global_prefix" == "undefined" || "$npm_global_prefix" == "null" ]]; then
    echo "[cli] failed to resolve npm global prefix (npm prefix -g / npm config get prefix)" >&2
    echo "[cli] npm --version: $(npm --version 2>/dev/null || echo unknown)" >&2
    echo "[cli] npm prefix -g: $(npm prefix -g 2>/dev/null || true)" >&2
    echo "[cli] npm config get prefix: $(npm config get prefix 2>/dev/null || true)" >&2
    exit 1
  fi

  NPM_GLOBAL_BIN="$npm_global_prefix/bin"
  local expected="$NPM_GLOBAL_BIN/happier"
  if [[ ! -x "$expected" ]]; then
    local npm_global_root=""
    npm_global_root="$(npm root -g 2>/dev/null || true)"

    echo "[cli] expected happier to be installed globally, but it was not found at: $expected" >&2
    echo "[cli] npm --version: $(npm --version 2>/dev/null || echo unknown)" >&2
    echo "[cli] npm prefix -g: $(npm prefix -g 2>/dev/null || true)" >&2
    echo "[cli] npm config get prefix: $(npm config get prefix 2>/dev/null || true)" >&2
    echo "[cli] npm root -g: ${npm_global_root:-}" >&2
    echo "[cli] PATH: $PATH" >&2
    echo "[cli] listing npm global bin dir: $NPM_GLOBAL_BIN" >&2
    ls -la "$NPM_GLOBAL_BIN" >&2 || true
    if [[ -n "$npm_global_root" ]]; then
      echo "[cli] listing global @happier-dev/cli (if present): $npm_global_root/@happier-dev/cli" >&2
      ls -la "$npm_global_root/@happier-dev/cli" >&2 || true
      ls -la "$npm_global_root/@happier-dev/cli/bin" >&2 || true
    fi
    exit 1
  fi

  if ! "$expected" --version >/dev/null 2>&1; then
    echo "[cli] expected happier to be runnable, but version check failed: $expected --version" >&2
    echo "[cli] npm --version: $(npm --version 2>/dev/null || echo unknown)" >&2
    echo "[cli] npm prefix -g: $(npm prefix -g 2>/dev/null || true)" >&2
    echo "[cli] npm config get prefix: $(npm config get prefix 2>/dev/null || true)" >&2
    echo "[cli] PATH: $PATH" >&2
    ls -la "$expected" >&2 || true
    exit 1
  fi

  HAPPIER_PREFIX=("$expected")
  return 0

  # unreachable
}

# Reset state so reruns cannot reuse stale tokens from previous stack instances.
mkdir -p "$CLIENT_HOME_DIR" "$APPROVER_HOME_DIR"
find "$CLIENT_HOME_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find "$APPROVER_HOME_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[cli] installing happier-cli from tarball: $HAPPIER_TGZ"
  npm_config_bin_links=true npm install -g "$HAPPIER_TGZ" >/dev/null
  resolve_happier_prefix_from_npm_global_bin
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "preinstalled" ]]; then
  echo "[cli] using preinstalled happier-cli"
  if ! command -v happier >/dev/null 2>&1; then
    echo "[cli] expected happier to be preinstalled (HAPPIER_CLI_INSTALL_MODE=preinstalled), but it was not found in PATH" >&2
    exit 1
  fi
  HAPPIER_PREFIX=(happier)
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[cli] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[cli] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm_config_bin_links=true npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  resolve_happier_prefix_from_npm_global_bin
fi

echo "[cli] configuring server: $HAPPIER_SERVER_URL"
HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" "${HAPPIER_PREFIX[@]}" server set --server-url "$HAPPIER_SERVER_URL" --webapp-url "$HAPPIER_WEBAPP_URL" >/dev/null

echo "[cli] authenticating (non-interactive terminal auth)..."
node /opt/happier-npm-e2e/bin/terminal-auth-approve.cjs \
  --server-url "$HAPPIER_SERVER_URL" \
  --home-dir "$APPROVER_HOME_DIR" \
  --active-server-id "$HAPPIER_ACTIVE_SERVER_ID" \
  >/dev/null

req_json="$(HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth request --json)"
public_key="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.publicKey||""))' <<<"$req_json")"
if [[ -z "$public_key" ]]; then
  echo "[cli] auth request did not return publicKey" >&2
  exit 1
fi

HAPPIER_HOME_DIR="$APPROVER_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth approve --json --public-key "$public_key" >/dev/null

wait_json="$(HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth wait --json --public-key "$public_key")"
token="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.token||""))' <<<"$wait_json")"
if [[ -z "$token" ]]; then
  echo "[cli] auth wait did not return a token" >&2
  exit 1
fi

echo "[cli] probing server via happier-cli..."
HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" server test

echo "[cli] probing authenticated endpoint..."
HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_TOKEN="$token" node -e '
  const base = String(process.env.HAPPIER_SERVER_URL || "").replace(/\/+$/, "");
  const token = String(process.env.HAPPIER_TOKEN || "");
  const url = base + "/v1/account/profile";
  fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => {
      if (!r.ok) throw new Error("http_" + r.status);
      process.stdout.write("ok\n");
    })
    .catch((e) => {
      console.error(e && e.message ? e.message : String(e));
      process.exit(1);
    });
' >/dev/null

if [[ "$HAPPIER_E2E_WITH_DAEMON" == "1" ]]; then
  echo "[cli] checking machine count before daemon start..."
  machine_count_before="$(HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_TOKEN="$token" node -e '
    const base = String(process.env.HAPPIER_SERVER_URL || "").replace(/\/+$/, "");
    const token = String(process.env.HAPPIER_TOKEN || "");
    const url = base + "/v1/machines";
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error("http_" + r.status);
        const j = await r.json();
        process.stdout.write(String(Array.isArray(j) ? j.length : 0));
      })
      .catch((e) => {
        console.error(e && e.message ? e.message : String(e));
        process.exit(1);
      });
  ')"
  if ! [[ "$machine_count_before" =~ ^[0-9]+$ ]]; then
    echo "[cli] invalid machine_count_before=$machine_count_before" >&2
    exit 1
  fi

  echo "[cli] starting daemon..."
  HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" daemon start
  echo "[cli] daemon status..."
  HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" daemon status >/dev/null

  echo "[cli] waiting for daemon to register a machine (connectivity check)..."
  machine_count_after="$machine_count_before"
  for _ in $(seq 1 60); do
    machine_count_after="$(HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_TOKEN="$token" node -e '
      const base = String(process.env.HAPPIER_SERVER_URL || "").replace(/\/+$/, "");
      const token = String(process.env.HAPPIER_TOKEN || "");
      const url = base + "/v1/machines";
      fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (r) => {
          if (!r.ok) throw new Error("http_" + r.status);
          const j = await r.json();
          process.stdout.write(String(Array.isArray(j) ? j.length : 0));
        })
        .catch((e) => {
          console.error(e && e.message ? e.message : String(e));
          process.exit(1);
        });
    ')" || true

    if [[ "$machine_count_after" =~ ^[0-9]+$ ]] && [[ "$machine_count_after" -gt "$machine_count_before" ]]; then
      break
    fi
    sleep 1
  done

  if ! [[ "$machine_count_after" =~ ^[0-9]+$ ]] || [[ "$machine_count_after" -le "$machine_count_before" ]]; then
    echo "[cli] expected /v1/machines to grow after daemon start (before=$machine_count_before after=$machine_count_after)" >&2
    exit 1
  fi
fi
