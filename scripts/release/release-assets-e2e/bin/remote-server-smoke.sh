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
REMOTE_SSH_WAIT_SECONDS="${REMOTE_SSH_WAIT_SECONDS:-180}"
REMOTE_SELF_HOST_SERVER_BINARY="${REMOTE_SELF_HOST_SERVER_BINARY:-}"
REMOTE_SELF_HOST_PRISMA_ENGINE_PATH="${REMOTE_SELF_HOST_PRISMA_ENGINE_PATH:-}"

ssh_key_src="/work/ssh/id_ed25519"
REMOTE_SSH_CONFIG_FILE="/root/.ssh/config"
REMOTE_SSH_KNOWN_HOSTS_FILE="/root/.ssh/known_hosts"

seed_strict_known_hosts_entry() {
  local host="$1"
  local known_hosts_file="$2"
  local port="${3:-22}"

  # Keep strict host-key verification deterministic across reruns by replacing
  # any stale entries for this host+port before scanning the current key.
  ssh-keygen -R "$host" -f "$known_hosts_file" >/dev/null 2>&1 || true
  if [[ -n "$port" && "$port" != "22" ]]; then
    ssh-keygen -R "[$host]:$port" -f "$known_hosts_file" >/dev/null 2>&1 || true
  fi

  local -a keyscan_args=(-T 5 -t ed25519)
  if [[ -n "$port" && "$port" != "22" ]]; then
    keyscan_args+=(-p "$port")
  fi

  local scanned_key=""
  scanned_key="$(ssh-keyscan "${keyscan_args[@]}" "$host" 2>/dev/null | head -n 1 || true)"
  if [[ -z "$scanned_key" ]]; then
    echo "[remote-server] failed to resolve ED25519 host key for strict trust seeding: ${host}:${port}" >&2
    return 1
  fi

  printf '%s\n' "$scanned_key" >>"$known_hosts_file"
}

resolve_happier_prefix_from_npm_global_package() {
  local npm_global_root=""
  npm_global_root="$(npm root -g 2>/dev/null || true)"

  if [[ -z "$npm_global_root" || "$npm_global_root" == "undefined" || "$npm_global_root" == "null" ]]; then
    echo "[remote-server] failed to resolve npm global root (npm root -g)" >&2
    exit 1
  fi

  local expected="$npm_global_root/@happier-dev/cli/dist/index.mjs"
  if [[ ! -f "$expected" ]]; then
    echo "[remote-server] expected packaged CLI entrypoint at: $expected" >&2
    exit 1
  fi

  if ! node "$expected" --version >/dev/null 2>&1; then
    echo "[remote-server] expected packaged CLI entrypoint to be runnable: node $expected --version" >&2
    exit 1
  fi

  HAPPIER_PREFIX=(node "$expected")
}

ensure_happier_command_from_global_cli_package() {
  local npm_global_root=""
  npm_global_root="$(npm root -g 2>/dev/null || true)"
  local expected="$npm_global_root/@happier-dev/cli/bin/happier.mjs"
  if [[ ! -f "$expected" ]]; then
    echo "[remote-server] expected packaged happier bin at: $expected" >&2
    exit 1
  fi
  chmod +x "$expected" >/dev/null 2>&1 || true
  ln -sf "$expected" /usr/local/bin/happier
}

ensure_happier_command_from_npx_spec() {
  cat > /usr/local/bin/happier <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec npx --yes -p "${HAPPIER_NPM_SPEC}" happier "\$@"
EOF
  chmod 755 /usr/local/bin/happier
}

if [[ -n "$HSTACK_TGZ" && -f "$HSTACK_TGZ" ]]; then
  echo "[remote-server] installing hstack from tarball: $HSTACK_TGZ"
  npm install -g "$HSTACK_TGZ" >/dev/null
else
  echo "[remote-server] installing hstack from npm: $HSTACK_NPM_SPEC"
  npm install -g "$HSTACK_NPM_SPEC" >/dev/null
fi

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[remote-server] installing happier-cli from tarball: $HAPPIER_TGZ"
  # `@happier-dev/stack` also exposes a `happier` shim, so installing the CLI
  # into the same global prefix can fail with EEXIST on the bin link.
  npm install -g --force "$HAPPIER_TGZ" >/dev/null
  resolve_happier_prefix_from_npm_global_package
  ensure_happier_command_from_global_cli_package
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[remote-server] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
  ensure_happier_command_from_npx_spec
else
  echo "[remote-server] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  resolve_happier_prefix_from_npm_global_package
  ensure_happier_command_from_global_cli_package
fi

if [[ ! -f "$ssh_key_src" ]]; then
  echo "[remote-server] missing ssh private key at $ssh_key_src" >&2
  exit 1
fi

echo "[remote-server] configuring ssh client..."
install -d -m 700 /root/.ssh
install -m 600 "$ssh_key_src" /root/.ssh/id_ed25519

cat > "$REMOTE_SSH_CONFIG_FILE" <<EOF
Host ${REMOTE_SSH_HOST}
  HostName ${REMOTE_SSH_HOST}
  User happy
  IdentityFile /root/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ${REMOTE_SSH_KNOWN_HOSTS_FILE}
  LogLevel ERROR
EOF
chmod 600 "$REMOTE_SSH_CONFIG_FILE"
touch "$REMOTE_SSH_KNOWN_HOSTS_FILE"
chmod 600 "$REMOTE_SSH_KNOWN_HOSTS_FILE"

echo "[remote-server] waiting for ssh to remote host..."
if ! [[ "$REMOTE_SSH_WAIT_SECONDS" =~ ^[0-9]+$ ]] || [[ "$REMOTE_SSH_WAIT_SECONDS" -le 0 ]]; then
  echo "[remote-server] invalid REMOTE_SSH_WAIT_SECONDS=$REMOTE_SSH_WAIT_SECONDS (expected positive integer)" >&2
  exit 2
fi
for _ in $(seq 1 "$REMOTE_SSH_WAIT_SECONDS"); do
  if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
  echo "[remote-server] remote host did not become reachable via ssh: $REMOTE_SSH_TARGET" >&2
  exit 1
fi

# `hstack remote server setup` executes relay-host install with strict host key checking.
# Seed known_hosts explicitly so strict checks can pass in isolated smoke containers.
resolved_ssh_port="$(ssh -G -F "$REMOTE_SSH_CONFIG_FILE" "$REMOTE_SSH_TARGET" 2>/dev/null | awk '$1=="port"{print $2; exit}' || true)"
if [[ -z "$resolved_ssh_port" || ! "$resolved_ssh_port" =~ ^[0-9]+$ ]]; then
  resolved_ssh_port="22"
fi
if ! seed_strict_known_hosts_entry "$REMOTE_SSH_HOST" "$REMOTE_SSH_KNOWN_HOSTS_FILE" "$resolved_ssh_port"; then
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
setup_args=(
  --ssh "$REMOTE_SSH_TARGET"
  --ssh-config-file "$REMOTE_SSH_CONFIG_FILE"
  --known-hosts-path "$REMOTE_SSH_KNOWN_HOSTS_FILE"
  "${remote_channel_args[@]}"
  --mode system
  --env "PORT=${REMOTE_SERVER_PORT}"
  "${db_env_args[@]}"
)

if [[ -n "$REMOTE_SELF_HOST_SERVER_BINARY" ]]; then
  if [[ ! -f "$REMOTE_SELF_HOST_SERVER_BINARY" ]]; then
    echo "[remote-server] missing REMOTE_SELF_HOST_SERVER_BINARY at $REMOTE_SELF_HOST_SERVER_BINARY" >&2
    exit 1
  fi
  setup_args+=(--server-binary "$REMOTE_SELF_HOST_SERVER_BINARY")
fi

if [[ -n "$REMOTE_SELF_HOST_PRISMA_ENGINE_PATH" ]]; then
  if [[ ! -f "$REMOTE_SELF_HOST_PRISMA_ENGINE_PATH" ]]; then
    echo "[remote-server] missing REMOTE_SELF_HOST_PRISMA_ENGINE_PATH at $REMOTE_SELF_HOST_PRISMA_ENGINE_PATH" >&2
    exit 1
  fi
  setup_args+=(--env "PRISMA_CLIENT_ENGINE_TYPE=library")
  setup_args+=(--env "PRISMA_QUERY_ENGINE_LIBRARY=${REMOTE_SELF_HOST_PRISMA_ENGINE_PATH}")
fi

set +e
setup_output="$(hstack remote server setup "${setup_args[@]}" --json 2>&1)"
setup_status=$?
set -e
if [[ $setup_status -ne 0 ]]; then
  echo "[remote-server] hstack remote server setup failed (exit=${setup_status})" >&2
  echo "$setup_output" >&2
  exit "$setup_status"
fi

echo "[remote-server] checking remote server health..."
ssh "$REMOTE_SSH_TARGET" "curl -fsS http://127.0.0.1:${REMOTE_SERVER_PORT}/v1/version" >/dev/null

echo "[remote-server] checking remote server config reflects postgres..."
remote_config_env_path="/etc/happier/server.env"
if [[ "$remote_channel_flag" == "preview" ]]; then
  remote_config_env_path="/etc/happier-preview/server.env"
fi

remote_config_env_text="$(ssh "$REMOTE_SSH_TARGET" "bash -lc 'sudo -n cat \"$remote_config_env_path\"'")"
if [[ -z "${remote_config_env_text:-}" ]]; then
  echo "[remote-server] expected remote config env at $remote_config_env_path, but it was empty or unreadable" >&2
  exit 1
fi

REMOTE_SERVER_CONFIG_ENV_TEXT="$remote_config_env_text" node - <<'NODE' >/dev/null
const raw = process.env.REMOTE_SERVER_CONFIG_ENV_TEXT || '';
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx <= 0) continue;
  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1);
  env[key] = value;
}
const provider = env.HAPPIER_DB_PROVIDER || '';
const port = String(env.PORT || '');
const expectedProvider = String(process.env.REMOTE_SERVER_DB || '').trim() || 'postgres';
if (expectedProvider === 'postgres') {
  if (String(provider).trim() !== 'postgres') {
    console.error(`[remote-server] expected HAPPIER_DB_PROVIDER=postgres, got: ${String(provider)}`);
    process.exit(1);
  }
} else if (expectedProvider === 'sqlite') {
  if (String(provider).trim() !== 'sqlite') {
    console.error(`[remote-server] expected HAPPIER_DB_PROVIDER=sqlite, got: ${String(provider)}`);
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
