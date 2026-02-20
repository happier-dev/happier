#!/usr/bin/env bash
set -euo pipefail

HSTACK_NPM_SPEC="${HSTACK_NPM_SPEC:-@happier-dev/stack@next}"
HSTACK_TGZ="${HSTACK_TGZ:-}"

HAPPIER_NPM_SPEC="${HAPPIER_NPM_SPEC:-@happier-dev/cli@next}"
HAPPIER_TGZ="${HAPPIER_TGZ:-}"
HAPPIER_CLI_INSTALL_MODE="${HAPPIER_CLI_INSTALL_MODE:-global}"

HAPPIER_SERVER_URL="${HAPPIER_SERVER_URL:-http://stack:3005}"
HAPPIER_PUBLIC_SERVER_URL="${HAPPIER_PUBLIC_SERVER_URL:-$HAPPIER_SERVER_URL}"
HAPPIER_WEBAPP_URL="${HAPPIER_WEBAPP_URL:-$HAPPIER_SERVER_URL}"
HAPPIER_ACTIVE_SERVER_ID="${HAPPIER_ACTIVE_SERVER_ID:-remote-smoke}"

REMOTE_SSH_TARGET="${REMOTE_SSH_TARGET:-happy@remote1}"
REMOTE_SSH_HOST="${REMOTE_SSH_HOST:-remote1}"
HSTACK_REMOTE_CHANNEL="${HSTACK_REMOTE_CHANNEL:-preview}"

APPROVER_HOME_DIR="${APPROVER_HOME_DIR:-/work/happier-approver-home-remote}"

ssh_key_src="/work/ssh/id_ed25519"

if [[ -n "$HSTACK_TGZ" && -f "$HSTACK_TGZ" ]]; then
  echo "[remote-daemon] installing hstack from tarball: $HSTACK_TGZ"
  npm install -g "$HSTACK_TGZ" >/dev/null
else
  echo "[remote-daemon] installing hstack from npm: $HSTACK_NPM_SPEC"
  npm install -g "$HSTACK_NPM_SPEC" >/dev/null
fi

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[remote-daemon] installing happier-cli from tarball: $HAPPIER_TGZ"
  npm install -g "$HAPPIER_TGZ" >/dev/null
  HAPPIER_PREFIX=(happier)
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[remote-daemon] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[remote-daemon] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  HAPPIER_PREFIX=(happier)
fi

if [[ ! -f "$ssh_key_src" ]]; then
  echo "[remote-daemon] missing ssh private key at $ssh_key_src" >&2
  exit 1
fi

echo "[remote-daemon] configuring ssh client..."
install -d -m 700 /root/.ssh
install -m 600 "$ssh_key_src" /root/.ssh/id_ed25519

cat > /root/.ssh/config <<EOF
Host ${REMOTE_SSH_HOST}
  HostName ${REMOTE_SSH_HOST}
  User happy
  IdentityFile /root/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
chmod 600 /root/.ssh/config

echo "[remote-daemon] waiting for server..."
for _ in $(seq 1 120); do
  if curl -fsS "${HAPPIER_SERVER_URL}/v1/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "${HAPPIER_SERVER_URL}/v1/version" >/dev/null 2>&1; then
  echo "[remote-daemon] server did not become ready at ${HAPPIER_SERVER_URL}/v1/version" >&2
  exit 1
fi

echo "[remote-daemon] waiting for ssh to remote host..."
for _ in $(seq 1 60); do
  if ssh -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! ssh -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
  echo "[remote-daemon] remote host did not become reachable via ssh: $REMOTE_SSH_TARGET" >&2
  exit 1
fi

echo "[remote-daemon] configuring local server profile..."
HAPPIER_HOME_DIR="$APPROVER_HOME_DIR" HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID" "${HAPPIER_PREFIX[@]}" server set \
  --server-url "$HAPPIER_SERVER_URL" \
  --webapp-url "$HAPPIER_WEBAPP_URL" \
  >/dev/null

echo "[remote-daemon] authenticating local approver identity (non-interactive terminal auth)..."
node /opt/happier-npm-e2e/bin/terminal-auth-approve.cjs \
  --server-url "$HAPPIER_SERVER_URL" \
  --home-dir "$APPROVER_HOME_DIR" \
  --active-server-id "$HAPPIER_ACTIVE_SERVER_ID" \
  >/dev/null

approver_access_key="$APPROVER_HOME_DIR/servers/$HAPPIER_ACTIVE_SERVER_ID/access.key"
if [[ ! -f "$approver_access_key" ]]; then
  echo "[remote-daemon] missing approver access key at $approver_access_key" >&2
  exit 1
fi

token="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.token||''))" "$approver_access_key")"
if [[ -z "$token" ]]; then
  echo "[remote-daemon] approver access.key did not contain a token" >&2
  exit 1
fi

echo "[remote-daemon] measuring machine count before remote daemon..."
machine_count_before="$(curl -fsS -H "Authorization: Bearer $token" "${HAPPIER_SERVER_URL}/v1/machines" | node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(String(Array.isArray(j)?j.length:0))")"
if ! [[ "$machine_count_before" =~ ^[0-9]+$ ]]; then
  echo "[remote-daemon] invalid machine_count_before=$machine_count_before" >&2
  exit 1
fi

echo "[remote-daemon] running: hstack remote daemon setup --ssh $REMOTE_SSH_TARGET --service none ..."
export HAPPIER_HOME_DIR="$APPROVER_HOME_DIR"
export HAPPIER_ACTIVE_SERVER_ID="$HAPPIER_ACTIVE_SERVER_ID"
export HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL"
export HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL"
export HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL"
export HAPPIER_NO_BROWSER_OPEN=1

remote_channel_args=()
case "$HSTACK_REMOTE_CHANNEL" in
  preview) remote_channel_args+=(--preview) ;;
  stable) remote_channel_args+=(--stable) ;;
  *) echo "[remote-daemon] invalid HSTACK_REMOTE_CHANNEL=$HSTACK_REMOTE_CHANNEL (expected preview|stable)" >&2; exit 2 ;;
esac

hstack remote daemon setup \
  --ssh "$REMOTE_SSH_TARGET" \
  "${remote_channel_args[@]}" \
  --service none \
  --server-url "$HAPPIER_SERVER_URL" \
  --webapp-url "$HAPPIER_WEBAPP_URL" \
  --public-server-url "$HAPPIER_PUBLIC_SERVER_URL" \
  --json \
  >/dev/null

echo "[remote-daemon] starting remote daemon (non-service)..."
ssh "$REMOTE_SSH_TARGET" "~/.happier/bin/happier daemon start" >/dev/null

echo "[remote-daemon] checking remote daemon status..."
status_out="$(ssh "$REMOTE_SSH_TARGET" "~/.happier/bin/happier daemon status --json" 2>/dev/null || ssh "$REMOTE_SSH_TARGET" "~/.happier/bin/happier daemon status" 2>/dev/null || true)"
if ! node -e "const fs=require('fs');const s=String(fs.readFileSync(0,'utf8')).trim();try{const j=JSON.parse(s);const st=String(j.status||'');if(!/running/i.test(st))process.exit(1);process.exit(0);}catch{}; if(!/running/i.test(s))process.exit(1);" <<<"$status_out" >/dev/null 2>&1; then
  echo "[remote-daemon] remote daemon status not running; raw:" >&2
  echo "$status_out" >&2
  exit 1
fi

echo "[remote-daemon] waiting for remote daemon to register a machine..."
machine_count_after="$machine_count_before"
for _ in $(seq 1 90); do
  machine_count_after="$(curl -fsS -H "Authorization: Bearer $token" "${HAPPIER_SERVER_URL}/v1/machines" | node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(String(Array.isArray(j)?j.length:0))")" || true
  if [[ "$machine_count_after" =~ ^[0-9]+$ ]] && [[ "$machine_count_after" -gt "$machine_count_before" ]]; then
    break
  fi
  sleep 1
done

if ! [[ "$machine_count_after" =~ ^[0-9]+$ ]] || [[ "$machine_count_after" -le "$machine_count_before" ]]; then
  echo "[remote-daemon] expected /v1/machines to grow after remote daemon start (before=$machine_count_before after=$machine_count_after)" >&2
  exit 1
fi

echo "[remote-daemon] OK (before=$machine_count_before after=$machine_count_after)"
