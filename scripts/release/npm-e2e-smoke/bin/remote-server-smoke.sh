#!/usr/bin/env bash
set -euo pipefail

HSTACK_NPM_SPEC="${HSTACK_NPM_SPEC:-@happier-dev/stack@next}"
HSTACK_TGZ="${HSTACK_TGZ:-}"

HAPPIER_NPM_SPEC="${HAPPIER_NPM_SPEC:-@happier-dev/cli@next}"
HAPPIER_TGZ="${HAPPIER_TGZ:-}"
HAPPIER_CLI_INSTALL_MODE="${HAPPIER_CLI_INSTALL_MODE:-global}"

REMOTE_SSH_TARGET="${REMOTE_SSH_TARGET:-happy@remote-server1}"
REMOTE_SSH_HOST="${REMOTE_SSH_HOST:-remote-server1}"
HSTACK_REMOTE_CHANNEL="${HSTACK_REMOTE_CHANNEL:-preview}"

POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-happier}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-happier}"
POSTGRES_DB="${POSTGRES_DB:-happier_smoke}"
POSTGRES_APP_NAME="${POSTGRES_APP_NAME:-happier_npm_e2e_smoke}"

REMOTE_SERVER_DB="${REMOTE_SERVER_DB:-postgres}"
REMOTE_SERVER_PORT="${REMOTE_SERVER_PORT:-3999}"

ssh_key_src="/work/ssh/id_ed25519"

if [[ -n "$HSTACK_TGZ" && -f "$HSTACK_TGZ" ]]; then
  echo "[remote-server] installing hstack from tarball: $HSTACK_TGZ"
  npm install -g "$HSTACK_TGZ" >/dev/null
else
  echo "[remote-server] installing hstack from npm: $HSTACK_NPM_SPEC"
  npm install -g "$HSTACK_NPM_SPEC" >/dev/null
fi

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[remote-server] installing happier-cli from tarball: $HAPPIER_TGZ"
  npm install -g "$HAPPIER_TGZ" >/dev/null
  HAPPIER_PREFIX=(happier)
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[remote-server] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[remote-server] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  HAPPIER_PREFIX=(happier)
fi

if [[ ! -f "$ssh_key_src" ]]; then
  echo "[remote-server] missing ssh private key at $ssh_key_src" >&2
  exit 1
fi

echo "[remote-server] configuring ssh client..."
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

echo "[remote-server] waiting for ssh to remote host..."
for _ in $(seq 1 90); do
  if ssh -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! ssh -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
  echo "[remote-server] remote host did not become reachable via ssh: $REMOTE_SSH_TARGET" >&2
  exit 1
fi

db_env_args=()
if [[ "$REMOTE_SERVER_DB" == "postgres" ]]; then
  echo "[remote-server] waiting for postgres..."
  node - <<'NODE'
const net = require('net');
const host = process.env.POSTGRES_HOST || 'postgres';
const port = Number(process.env.POSTGRES_PORT || 5432);
const deadlineMs = Date.now() + 90_000;

function tryOnce() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(2_000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

(async () => {
  while (Date.now() < deadlineMs) {
    if (await tryOnce()) process.exit(0);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  process.exit(1);
})().catch(() => process.exit(1));
NODE

  database_url="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}?application_name=${POSTGRES_APP_NAME}"
  db_env_args+=(--env "HAPPIER_DB_PROVIDER=postgres" --env "DATABASE_URL=${database_url}")
elif [[ "$REMOTE_SERVER_DB" == "sqlite" ]]; then
  echo "[remote-server] using sqlite database (no postgres)..."
else
  echo "[remote-server] invalid REMOTE_SERVER_DB=$REMOTE_SERVER_DB (expected postgres|sqlite)" >&2
  exit 2
fi

remote_channel_args=()
remote_channel_flag="stable"
case "$HSTACK_REMOTE_CHANNEL" in
  preview) remote_channel_args+=(--preview); remote_channel_flag="preview" ;;
  stable) remote_channel_args+=(--stable); remote_channel_flag="stable" ;;
  *) echo "[remote-server] invalid HSTACK_REMOTE_CHANNEL=$HSTACK_REMOTE_CHANNEL (expected preview|stable)" >&2; exit 2 ;;
esac

echo "[remote-server] running: hstack remote server setup (db=${REMOTE_SERVER_DB})..."
hstack remote server setup \
  --ssh "$REMOTE_SSH_TARGET" \
  "${remote_channel_args[@]}" \
  --mode system \
  --env "PORT=${REMOTE_SERVER_PORT}" \
  "${db_env_args[@]}" \
  --json \
  >/dev/null

echo "[remote-server] checking remote server health..."
ssh "$REMOTE_SSH_TARGET" "curl -fsS http://127.0.0.1:${REMOTE_SERVER_PORT}/v1/version" >/dev/null

echo "[remote-server] checking remote server config reflects postgres..."
config_json="$(ssh "$REMOTE_SSH_TARGET" "sudo -E ~/.happier/bin/hstack self-host config view --mode=system --channel=${remote_channel_flag} --json")"

HSTACK_REMOTE_SERVER_CONFIG_JSON="$config_json" node - <<'NODE' >/dev/null
const raw = process.env.HSTACK_REMOTE_SERVER_CONFIG_JSON || '';
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error('[remote-server] expected JSON output from hstack self-host config view');
  const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  if (msg) console.error(`[remote-server] JSON parse error: ${msg}`);
  process.exit(1);
}
const env = parsed?.env || parsed?.config?.env || parsed?.data?.env || null;
const paths = parsed?.paths || parsed?.config?.paths || parsed?.data?.paths || null;
const provider = env?.HAPPIER_DB_PROVIDER || '';
const port = String(env?.PORT || '');
const expectedProvider = String(process.env.REMOTE_SERVER_DB || '').trim() || 'postgres';
if (expectedProvider === 'postgres') {
  if (String(provider).trim() !== 'postgres') {
    console.error(`[remote-server] expected HAPPIER_DB_PROVIDER=postgres, got: ${String(provider)}`);
    if (paths?.configEnvPath) console.error(`[remote-server] config env path: ${paths.configEnvPath}`);
    process.exit(1);
  }
} else if (expectedProvider === 'sqlite') {
  if (String(provider).trim() !== 'sqlite') {
    console.error(`[remote-server] expected HAPPIER_DB_PROVIDER=sqlite, got: ${String(provider)}`);
    if (paths?.configEnvPath) console.error(`[remote-server] config env path: ${paths.configEnvPath}`);
    process.exit(1);
  }
} else {
  console.error(`[remote-server] invalid REMOTE_SERVER_DB=${expectedProvider} (expected postgres|sqlite)`);
  process.exit(2);
}
if (!port || port !== String(process.env.REMOTE_SERVER_PORT || '')) {
  console.error(`[remote-server] expected PORT=${process.env.REMOTE_SERVER_PORT}, got: ${port || '(missing)'}`);
  process.exit(1);
}
process.exit(0);
NODE

echo "[remote-server] OK"
