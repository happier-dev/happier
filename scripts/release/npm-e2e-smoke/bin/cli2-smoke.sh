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

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[cli2] installing happier-cli from tarball: $HAPPIER_TGZ"
  npm install -g "$HAPPIER_TGZ" >/dev/null
  HAPPIER_PREFIX=(happier)
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[cli2] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[cli2] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  HAPPIER_PREFIX=(happier)
fi

echo "[cli2] configuring server: $HAPPIER_SERVER_URL"
HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" "${HAPPIER_PREFIX[@]}" server set --server-url "$HAPPIER_SERVER_URL" --webapp-url "$HAPPIER_WEBAPP_URL" >/dev/null

echo "[cli2] authenticating via primary account (non-interactive terminal auth)..."
if [[ ! -f "$APPROVER_HOME_DIR/servers/$HAPPIER_ACTIVE_SERVER_ID/access.key" ]]; then
  echo "[cli2] missing approver access key at $APPROVER_HOME_DIR/servers/$HAPPIER_ACTIVE_SERVER_ID/access.key" >&2
  exit 1
fi

req_json="$(HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth request --json)"
public_key="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.publicKey||""))' <<<"$req_json")"
if [[ -z "$public_key" ]]; then
  echo "[cli2] auth request did not return publicKey" >&2
  exit 1
fi

HAPPIER_HOME_DIR="$APPROVER_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth approve --json --public-key "$public_key" >/dev/null

wait_json="$(HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" auth wait --json --public-key "$public_key")"
token="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(j.token||""))' <<<"$wait_json")"
if [[ -z "$token" ]]; then
  echo "[cli2] auth wait did not return a token" >&2
  exit 1
fi

echo "[cli2] probing server via happier-cli..."
HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" server test >/dev/null

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
  HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" daemon start >/dev/null

  echo "[cli2] daemon status..."
  HAPPIER_HOME_DIR="$CLIENT_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" "${HAPPIER_PREFIX[@]}" daemon status >/dev/null

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
