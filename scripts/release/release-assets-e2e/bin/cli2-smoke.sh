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

CLIENT_HOME_DIR="${CLIENT_HOME_DIR:-/work/happier-home-2}"
APPROVER_HOME_DIR="${APPROVER_HOME_DIR:-/work/primary-home}"

resolve_happier_prefix_from_npm_global_package() {
  local npm_global_root=""
  local npm_global_prefix=""
  npm_global_root="$(npm root -g 2>/dev/null || true)"
  npm_global_prefix="$(npm prefix -g 2>/dev/null || true)"

  if [[ -z "$npm_global_root" || "$npm_global_root" == "undefined" || "$npm_global_root" == "null" ]]; then
    echo "[cli2] failed to resolve npm global root (npm root -g)" >&2
    echo "[cli2] npm --version: $(npm --version 2>/dev/null || echo unknown)" >&2
    echo "[cli2] npm root -g: $(npm root -g 2>/dev/null || true)" >&2
    exit 1
  fi

  local expected_entrypoint="$npm_global_root/@happier-dev/cli/dist/index.mjs"
  if [[ ! -f "$expected_entrypoint" ]]; then
    echo "[cli2] expected packaged CLI entrypoint at: $expected_entrypoint" >&2
    echo "[cli2] npm --version: $(npm --version 2>/dev/null || echo unknown)" >&2
    echo "[cli2] npm root -g: ${npm_global_root:-}" >&2
    echo "[cli2] PATH: $PATH" >&2
    ls -la "$npm_global_root/@happier-dev/cli" >&2 || true
    ls -la "$npm_global_root/@happier-dev/cli/bin" >&2 || true
    exit 1
  fi

  local expected_bin="$npm_global_root/@happier-dev/cli/bin/happier.mjs"
  if [[ ! -f "$expected_bin" ]]; then
    echo "[cli2] expected packaged happier command entrypoint at: $expected_bin" >&2
    echo "[cli2] npm --version: $(npm --version 2>/dev/null || echo unknown)" >&2
    echo "[cli2] npm root -g: ${npm_global_root:-}" >&2
    echo "[cli2] PATH: $PATH" >&2
    ls -la "$npm_global_root/@happier-dev/cli/bin" >&2 || true
    exit 1
  fi

  if ! command -v happier >/dev/null 2>&1; then
    echo "[cli2] expected installed happier shim command, but it is not on PATH" >&2
    echo "[cli2] npm prefix -g: ${npm_global_prefix:-}" >&2
    echo "[cli2] npm root -g: ${npm_global_root:-}" >&2
    echo "[cli2] PATH: $PATH" >&2
    exit 1
  fi

  local command_path
  command_path="$(command -v happier)"
  local resolved_command_path
  resolved_command_path="$(readlink -f "$command_path" 2>/dev/null || echo "$command_path")"
  local resolved_expected_bin
  resolved_expected_bin="$(readlink -f "$expected_bin" 2>/dev/null || echo "$expected_bin")"
  if [[ "$resolved_command_path" != "$resolved_expected_bin" ]]; then
    echo "[cli2] expected happier command to resolve to packaged bin entrypoint" >&2
    echo "[cli2] command -v happier: $command_path" >&2
    echo "[cli2] resolved command path: $resolved_command_path" >&2
    echo "[cli2] expected packaged bin path: $resolved_expected_bin" >&2
    exit 1
  fi

  if ! happier --version >/dev/null 2>&1; then
    echo "[cli2] expected installed happier shim command to be runnable: happier --version" >&2
    echo "[cli2] command -v happier: $command_path" >&2
    echo "[cli2] resolved command path: $resolved_command_path" >&2
    exit 1
  fi

  echo "[cli2] installed happier shim proof: $command_path -> $resolved_command_path"
  HAPPIER_PREFIX=(happier)
}

# Reset client state so reruns cannot reuse stale tokens from previous stack instances.
mkdir -p "$CLIENT_HOME_DIR"
find "$CLIENT_HOME_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[cli2] installing happier-cli from tarball: $HAPPIER_TGZ"
  npm install -g "$HAPPIER_TGZ" >/dev/null
  resolve_happier_prefix_from_npm_global_package
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "preinstalled" ]]; then
  echo "[cli2] using preinstalled happier-cli"
  if ! command -v happier >/dev/null 2>&1; then
    echo "[cli2] expected happier to be preinstalled (HAPPIER_CLI_INSTALL_MODE=preinstalled), but it was not found in PATH" >&2
    exit 1
  fi
  HAPPIER_PREFIX=(happier)
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[cli2] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[cli2] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  resolve_happier_prefix_from_npm_global_package
fi

echo "[cli2] authenticating via primary account (non-interactive terminal auth)..."
approver_servers_dir="$APPROVER_HOME_DIR/servers"
preferred_approver_access_key="$approver_servers_dir/$HAPPIER_ACTIVE_SERVER_ID/access.key"
approver_access_keys=""
if [[ -f "$preferred_approver_access_key" ]]; then
  approver_access_keys="$preferred_approver_access_key"
fi
discovered_approver_access_keys="$(find "$approver_servers_dir" -mindepth 2 -maxdepth 2 -type f -name 'access.key' | sort || true)"
if [[ -n "$discovered_approver_access_keys" ]]; then
  while IFS= read -r discovered_key; do
    [[ -n "$discovered_key" ]] || continue
    if [[ "$discovered_key" == "$preferred_approver_access_key" ]]; then
      continue
    fi
    if [[ -z "$approver_access_keys" ]]; then
      approver_access_keys="$discovered_key"
    else
      approver_access_keys="${approver_access_keys}"$'\n'"$discovered_key"
    fi
  done <<<"$discovered_approver_access_keys"
fi

selected_approver_access_key=""
selected_approver_server_id=""
while IFS= read -r candidate_access_key; do
  [[ -n "$candidate_access_key" ]] || continue
  candidate_token="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.token||""))' "$candidate_access_key")" || true
  if [[ -z "${candidate_token:-}" ]]; then
    continue
  fi
  if curl -fsS -H "Authorization: Bearer $candidate_token" "$HAPPIER_SERVER_URL/v1/machines" >/dev/null 2>&1; then
    selected_approver_access_key="$candidate_access_key"
    selected_approver_server_id="$(basename "$(dirname "$selected_approver_access_key")")"
    break
  fi
done <<<"$approver_access_keys"

if [[ -z "$selected_approver_access_key" ]]; then
  echo "[cli2] missing approver access key under $approver_servers_dir that authenticates against $HAPPIER_SERVER_URL/v1/machines" >&2
  if [[ -n "${discovered_approver_access_keys:-}" ]]; then
    echo "[cli2] discovered approver access keys:" >&2
    echo "$discovered_approver_access_keys" >&2
  fi
  exit 1
fi
if [[ -z "$selected_approver_server_id" ]]; then
  echo "[cli2] failed to derive server id from approver access key: $selected_approver_access_key" >&2
  exit 1
fi
if [[ "$selected_approver_server_id" != "$HAPPIER_ACTIVE_SERVER_ID" ]]; then
  echo "[cli2] aligning active server id from $HAPPIER_ACTIVE_SERVER_ID to $selected_approver_server_id (selected approver access key owner)"
fi

echo "[cli2] configuring server: $HAPPIER_SERVER_URL"
HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$selected_approver_server_id" "${HAPPIER_PREFIX[@]}" server set --server-url "$HAPPIER_SERVER_URL" --webapp-url "$HAPPIER_WEBAPP_URL" >/dev/null

req_json="$(HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$selected_approver_server_id" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth request --json)"
public_key="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.publicKey||""))' <<<"$req_json")"
if [[ -z "$public_key" ]]; then
  echo "[cli2] auth request did not return publicKey" >&2
  exit 1
fi

HAPPIER_HOME_DIR="$APPROVER_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$selected_approver_server_id" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth approve --json --public-key "$public_key" >/dev/null

wait_json="$(HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$selected_approver_server_id" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth wait --json --public-key "$public_key")"
token="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.token||""))' <<<"$wait_json")"
if [[ -z "$token" ]]; then
  echo "[cli2] auth wait did not return a token" >&2
  exit 1
fi

echo "[cli2] probing server via happier-cli..."
HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$selected_approver_server_id" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" server test >/dev/null

echo "[cli2] probing authenticated endpoint..."
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
  echo "[cli2] checking machine count before daemon start..."
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
    echo "[cli2] invalid machine_count_before=$machine_count_before" >&2
    exit 1
  fi

  echo "[cli2] starting daemon..."
  HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$selected_approver_server_id" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" daemon start >/dev/null

  echo "[cli2] daemon status..."
  HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$selected_approver_server_id" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" daemon status >/dev/null

  echo "[cli2] waiting for daemon to register a machine (connectivity check)..."
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
    echo "[cli2] expected /v1/machines to grow after daemon start (before=$machine_count_before after=$machine_count_after)" >&2
    exit 1
  fi
fi
