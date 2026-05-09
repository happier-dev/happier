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
HAPPIER_ACTIVE_SERVER_ID="${HAPPIER_ACTIVE_SERVER_ID:-smoke}"

PRIMARY_CLI_HOME_DIR="${PRIMARY_CLI_HOME_DIR:-/work/primary-cli-home}"

REMOTE_SSH_TARGET="${REMOTE_SSH_TARGET:-happy@remote1}"
REMOTE_SSH_HOST="${REMOTE_SSH_HOST:-remote1}"
HSTACK_REMOTE_CHANNEL="${HSTACK_REMOTE_CHANNEL:-preview}"

ssh_key_src="/work/ssh/id_ed25519"

if [[ -n "$HSTACK_TGZ" && -f "$HSTACK_TGZ" ]]; then
  echo "[remote-daemon-reuse-cli] installing hstack from tarball: $HSTACK_TGZ"
  npm install -g "$HSTACK_TGZ" >/dev/null
else
  echo "[remote-daemon-reuse-cli] installing hstack from npm: $HSTACK_NPM_SPEC"
  npm install -g "$HSTACK_NPM_SPEC" >/dev/null
fi

if [[ -n "$HAPPIER_TGZ" && -f "$HAPPIER_TGZ" ]]; then
  echo "[remote-daemon-reuse-cli] installing happier-cli from tarball: $HAPPIER_TGZ"
  # `@happier-dev/stack` also exposes a `happier` shim, so installing the CLI
  # into the same global prefix can fail with EEXIST on the bin link.
  npm install -g --force "$HAPPIER_TGZ" >/dev/null
  HAPPIER_PREFIX=(happier)
elif [[ "$HAPPIER_CLI_INSTALL_MODE" == "npx" ]]; then
  echo "[remote-daemon-reuse-cli] running happier-cli via npx: $HAPPIER_NPM_SPEC"
  HAPPIER_PREFIX=(npx --yes -p "$HAPPIER_NPM_SPEC" happier)
else
  echo "[remote-daemon-reuse-cli] installing happier-cli from npm: $HAPPIER_NPM_SPEC"
  npm install -g "$HAPPIER_NPM_SPEC" >/dev/null
  HAPPIER_PREFIX=(happier)
fi

if [[ ! -f "$ssh_key_src" ]]; then
  echo "[remote-daemon-reuse-cli] missing ssh private key at $ssh_key_src" >&2
  exit 1
fi

echo "[remote-daemon-reuse-cli] configuring ssh client..."
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

echo "[remote-daemon-reuse-cli] waiting for server..."
for _ in $(seq 1 120); do
  if curl -fsS "${HAPPIER_SERVER_URL}/v1/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "${HAPPIER_SERVER_URL}/v1/version" >/dev/null 2>&1; then
  echo "[remote-daemon-reuse-cli] server did not become ready at ${HAPPIER_SERVER_URL}/v1/version" >&2
  exit 1
fi

echo "[remote-daemon-reuse-cli] waiting for ssh to remote host..."
for _ in $(seq 1 60); do
  if ssh -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! ssh -o ConnectTimeout=5 "$REMOTE_SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
  echo "[remote-daemon-reuse-cli] remote host did not become reachable via ssh: $REMOTE_SSH_TARGET" >&2
  exit 1
fi

echo "[remote-daemon-reuse-cli] checking primary CLI is already authenticated..."
cli_servers_dir="${PRIMARY_CLI_HOME_DIR}/servers"
preferred_access_key="${cli_servers_dir}/${HAPPIER_ACTIVE_SERVER_ID}/access.key"
access_keys=""
if [[ -f "$preferred_access_key" ]]; then
  access_keys="$preferred_access_key"
fi
discovered_access_keys="$(find "$cli_servers_dir" -mindepth 2 -maxdepth 2 -type f -name 'access.key' | sort || true)"
if [[ -n "$discovered_access_keys" ]]; then
  while IFS= read -r discovered_key; do
    [[ -n "$discovered_key" ]] || continue
    if [[ "$discovered_key" == "$preferred_access_key" ]]; then
      continue
    fi
    if [[ -z "$access_keys" ]]; then
      access_keys="$discovered_key"
    else
      access_keys="${access_keys}"$'\n'"$discovered_key"
    fi
  done <<<"$discovered_access_keys"
fi

token=""
machine_count_before=""
selected_access_key=""
selected_server_id=""
while IFS= read -r access_key; do
  [[ -n "$access_key" ]] || continue
  candidate_token="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.token||''))" "$access_key")" || true
  if [[ -z "${candidate_token:-}" ]]; then
    continue
  fi
  candidate_machine_count="$(curl -fsS -H "Authorization: Bearer $candidate_token" "${HAPPIER_SERVER_URL}/v1/machines" | node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(String(Array.isArray(j)?j.length:0))")" || true
  if [[ "$candidate_machine_count" =~ ^[0-9]+$ ]]; then
    token="$candidate_token"
    machine_count_before="$candidate_machine_count"
    selected_access_key="$access_key"
    selected_server_id="$(basename "$(dirname "$selected_access_key")")"
    break
  fi
done <<<"$access_keys"

if [[ -z "$token" ]]; then
  echo "[remote-daemon-reuse-cli] expected at least one primary cli access key under ${cli_servers_dir} that can authenticate against ${HAPPIER_SERVER_URL}/v1/machines" >&2
  echo "[remote-daemon-reuse-cli] hint: ensure the cli smoke ran first and wrote credentials for HAPPIER_ACTIVE_SERVER_ID=$HAPPIER_ACTIVE_SERVER_ID" >&2
  if [[ -n "${discovered_access_keys:-}" ]]; then
    echo "[remote-daemon-reuse-cli] discovered access keys:" >&2
    echo "$discovered_access_keys" >&2
  fi
  exit 1
fi
if [[ -z "${selected_server_id:-}" ]]; then
  echo "[remote-daemon-reuse-cli] failed to derive active server id from selected access key path: ${selected_access_key:-<none>}" >&2
  exit 1
fi

echo "[remote-daemon-reuse-cli] using primary cli access key: ${selected_access_key}"
if [[ -n "${selected_server_id:-}" && "$selected_server_id" != "$HAPPIER_ACTIVE_SERVER_ID" ]]; then
  echo "[remote-daemon-reuse-cli] aligning active server id from ${HAPPIER_ACTIVE_SERVER_ID} to ${selected_server_id} (selected access key owner)"
fi

echo "[remote-daemon-reuse-cli] running: hstack remote daemon setup (approver=primary cli home)..."
export HAPPIER_HOME_DIR="$PRIMARY_CLI_HOME_DIR"
export HAPPIER_ACTIVE_SERVER_ID="$selected_server_id"
export HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL"
export HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL"
export HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL"
export HAPPIER_NO_BROWSER_OPEN=1

remote_channel_args=()
case "$HSTACK_REMOTE_CHANNEL" in
  preview) remote_channel_args+=(--preview) ;;
  stable) remote_channel_args+=(--stable) ;;
  *) echo "[remote-daemon-reuse-cli] invalid HSTACK_REMOTE_CHANNEL=$HSTACK_REMOTE_CHANNEL (expected preview|stable)" >&2; exit 2 ;;
esac

resolve_remote_happier_command() {
  local candidates=()
  case "$HSTACK_REMOTE_CHANNEL" in
    preview)
      candidates=(hprev '~/.happier/bin/hprev' '~/.happier/cli-preview/current/happier' happier '~/.happier/bin/happier' '~/.happier/cli/current/happier' hdev '~/.happier/bin/hdev' '~/.happier/cli-dev/current/happier')
      ;;
    stable)
      candidates=(happier '~/.happier/bin/happier' '~/.happier/cli/current/happier' hprev '~/.happier/bin/hprev' '~/.happier/cli-preview/current/happier' hdev '~/.happier/bin/hdev' '~/.happier/cli-dev/current/happier')
      ;;
    *)
      candidates=(happier '~/.happier/bin/happier' '~/.happier/cli/current/happier' hprev '~/.happier/bin/hprev' '~/.happier/cli-preview/current/happier' hdev '~/.happier/bin/hdev' '~/.happier/cli-dev/current/happier')
      ;;
  esac

  local candidate=""
  for candidate in "${candidates[@]}"; do
    if [[ "$candidate" == *"/"* ]]; then
      if ssh "$REMOTE_SSH_TARGET" "test -x $candidate" >/dev/null 2>&1; then
        echo "$candidate"
        return 0
      fi
    else
      if ssh "$REMOTE_SSH_TARGET" "command -v $candidate >/dev/null 2>&1" >/dev/null 2>&1; then
        echo "$candidate"
        return 0
      fi
    fi
  done

  return 1
}

probe_machine_count() {
  curl -fsS -H "Authorization: Bearer $token" "${HAPPIER_SERVER_URL}/v1/machines" \
    | node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(String(Array.isArray(j)?j.length:0))"
}

wait_for_machine_growth() {
  local before="$1"
  local attempts="${2:-90}"
  local after="$before"
  for _ in $(seq 1 "$attempts"); do
    after="$(probe_machine_count)" || true
    if [[ "$after" =~ ^[0-9]+$ ]] && [[ "$after" -gt "$before" ]]; then
      printf '%s' "$after"
      return 0
    fi
    sleep 1
  done
  printf '%s' "$after"
  return 1
}

remote_auth_status_is_authenticated() {
  node -e "const fs=require('fs');const raw=String(fs.readFileSync(0,'utf8')||'').trim();if(!raw)process.exit(1);try{const j=JSON.parse(raw);process.exit(j&&j.authenticated===true?0:1);}catch{process.exit(/authenticated[^a-z]*true/i.test(raw)?0:1);}"
}

ensure_remote_auth_credentials() {
  local remote_happier_command="$1"
  local remote_auth_status=""
  remote_auth_status="$(ssh "$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='$selected_server_id' HAPPIER_SERVER_URL='$HAPPIER_SERVER_URL' HAPPIER_PUBLIC_SERVER_URL='$HAPPIER_PUBLIC_SERVER_URL' HAPPIER_WEBAPP_URL='$HAPPIER_WEBAPP_URL' $remote_happier_command auth status --json" 2>/dev/null || true)"
  if remote_auth_status_is_authenticated <<<"$remote_auth_status"; then
    echo "[remote-daemon-reuse-cli] remote auth already present; skipping auth bootstrap"
    return 0
  fi

  echo "[remote-daemon-reuse-cli] remote auth missing; bootstrapping via request/approve/wait..."
  local remote_auth_request_json=""
  remote_auth_request_json="$(ssh "$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='$selected_server_id' HAPPIER_SERVER_URL='$HAPPIER_SERVER_URL' HAPPIER_PUBLIC_SERVER_URL='$HAPPIER_PUBLIC_SERVER_URL' HAPPIER_WEBAPP_URL='$HAPPIER_WEBAPP_URL' $remote_happier_command auth request --json --persist" 2>/dev/null || true)"
  local remote_public_key=""
  remote_public_key="$(node -e "const fs=require('fs');const raw=String(fs.readFileSync(0,'utf8')||'').trim();let key='';try{const j=JSON.parse(raw);key=String(j.publicKey||'').trim();}catch{};process.stdout.write(key);" <<<"$remote_auth_request_json")"
  if [[ -z "$remote_public_key" ]]; then
    echo "[remote-daemon-reuse-cli] remote auth request did not return publicKey; raw output:" >&2
    echo "$remote_auth_request_json" >&2
    return 1
  fi

  HAPPIER_HOME_DIR="$PRIMARY_CLI_HOME_DIR" \
  HAPPIER_ACTIVE_SERVER_ID="$selected_server_id" \
  HAPPIER_SERVER_URL="$HAPPIER_SERVER_URL" \
  HAPPIER_PUBLIC_SERVER_URL="$HAPPIER_PUBLIC_SERVER_URL" \
  HAPPIER_WEBAPP_URL="$HAPPIER_WEBAPP_URL" \
  "${HAPPIER_PREFIX[@]}" auth approve --json --public-key "$remote_public_key" >/dev/null

  local remote_auth_wait_json=""
  remote_auth_wait_json="$(ssh "$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='$selected_server_id' HAPPIER_SERVER_URL='$HAPPIER_SERVER_URL' HAPPIER_PUBLIC_SERVER_URL='$HAPPIER_PUBLIC_SERVER_URL' HAPPIER_WEBAPP_URL='$HAPPIER_WEBAPP_URL' $remote_happier_command auth wait --public-key '$remote_public_key' --json --persist" 2>/dev/null || true)"
  local remote_wait_token=""
  remote_wait_token="$(node -e "const fs=require('fs');const raw=String(fs.readFileSync(0,'utf8')||'').trim();let token='';try{const j=JSON.parse(raw);token=String(j.token||'').trim();}catch{};process.stdout.write(token);" <<<"$remote_auth_wait_json")"
  if [[ -z "$remote_wait_token" ]]; then
    echo "[remote-daemon-reuse-cli] remote auth wait did not return token; raw output:" >&2
    echo "$remote_auth_wait_json" >&2
    return 1
  fi

  echo "[remote-daemon-reuse-cli] remote auth bootstrap complete"
}

remote_setup_output="$(mktemp -t remote-daemon-reuse-cli-setup-XXXXXX)"
run_remote_daemon_setup_with_public_flag() {
  hstack remote daemon setup \
    --ssh "$REMOTE_SSH_TARGET" \
    "${remote_channel_args[@]}" \
    --yes \
    --service none \
    --server-url "$HAPPIER_SERVER_URL" \
    --webapp-url "$HAPPIER_WEBAPP_URL" \
    --public-server-url "$HAPPIER_PUBLIC_SERVER_URL" \
    --json
}

if ! run_remote_daemon_setup_with_public_flag \
  >"$remote_setup_output" 2>&1; then
  echo "[remote-daemon-reuse-cli] remote daemon setup failed; tailing captured output..." >&2
  tail -n 200 "$remote_setup_output" >&2 || true
  rm -f "$remote_setup_output"
  exit 1
fi
rm -f "$remote_setup_output"

echo "[remote-daemon-reuse-cli] checking remote daemon connectivity after setup..."
machine_count_after="$machine_count_before"
if machine_count_after="$(wait_for_machine_growth "$machine_count_before" 45)"; then
  echo "[remote-daemon-reuse-cli] already registered a machine after setup; skipping manual start"
else
  echo "[remote-daemon-reuse-cli] setup did not register a machine yet; starting remote daemon manually..."
  remote_happier_command="$(resolve_remote_happier_command || true)"
  if [[ -z "$remote_happier_command" ]]; then
    echo "[remote-daemon-reuse-cli] failed to resolve remote happier command for channel=$HSTACK_REMOTE_CHANNEL" >&2
    ssh "$REMOTE_SSH_TARGET" "echo PATH=\$PATH; command -v happier || true; command -v hprev || true; command -v hdev || true; ls -la ~/.happier ~/.happier/bin ~/.happier/cli ~/.happier/cli-preview ~/.happier/cli-dev 2>/dev/null || true" >&2 || true
    exit 1
  fi

  if ! ensure_remote_auth_credentials "$remote_happier_command"; then
    echo "[remote-daemon-reuse-cli] failed to bootstrap remote auth credentials before daemon start" >&2
    exit 1
  fi

  daemon_start_output=""
  set +e
  daemon_start_output="$(ssh "$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='$selected_server_id' HAPPIER_SERVER_URL='$HAPPIER_SERVER_URL' HAPPIER_PUBLIC_SERVER_URL='$HAPPIER_PUBLIC_SERVER_URL' HAPPIER_WEBAPP_URL='$HAPPIER_WEBAPP_URL' $remote_happier_command daemon start" 2>&1)"
  daemon_start_status=$?
  set -e
  if [[ "$daemon_start_status" -ne 0 ]]; then
    echo "$daemon_start_output" >&2
    daemon_log_path="$(printf '%s\n' "$daemon_start_output" | sed -n 's/^Latest daemon log: //p' | tail -n 1)"
    if [[ -n "$daemon_log_path" ]]; then
      echo "[remote-daemon-reuse-cli] tailing remote daemon log: $daemon_log_path" >&2
      ssh "$REMOTE_SSH_TARGET" "test -f '$daemon_log_path' && tail -n 200 '$daemon_log_path' || true" >&2 || true
    fi
    remote_auth_status_after_fail="$(ssh "$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='$selected_server_id' HAPPIER_SERVER_URL='$HAPPIER_SERVER_URL' HAPPIER_PUBLIC_SERVER_URL='$HAPPIER_PUBLIC_SERVER_URL' HAPPIER_WEBAPP_URL='$HAPPIER_WEBAPP_URL' $remote_happier_command auth status --json" 2>/dev/null || true)"
    if [[ -n "$remote_auth_status_after_fail" ]]; then
      echo "[remote-daemon-reuse-cli] remote auth status after daemon start failure:" >&2
      echo "$remote_auth_status_after_fail" >&2
    fi
    exit "$daemon_start_status"
  fi

  echo "[remote-daemon-reuse-cli] checking remote daemon status..."
  status_out="$(ssh "$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='$selected_server_id' HAPPIER_SERVER_URL='$HAPPIER_SERVER_URL' HAPPIER_PUBLIC_SERVER_URL='$HAPPIER_PUBLIC_SERVER_URL' HAPPIER_WEBAPP_URL='$HAPPIER_WEBAPP_URL' $remote_happier_command daemon status --json" 2>/dev/null || ssh "$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='$selected_server_id' HAPPIER_SERVER_URL='$HAPPIER_SERVER_URL' HAPPIER_PUBLIC_SERVER_URL='$HAPPIER_PUBLIC_SERVER_URL' HAPPIER_WEBAPP_URL='$HAPPIER_WEBAPP_URL' $remote_happier_command daemon status" 2>/dev/null || true)"
  if ! node -e "const fs=require('fs');const s=String(fs.readFileSync(0,'utf8')).trim();try{const j=JSON.parse(s);const daemonRunning=Boolean(j&&j.daemon&&j.daemon.running===true);const st=String((j&&j.status)||((j&&j.daemon&&j.daemon.status)||''));if(!daemonRunning&&!/running/i.test(st))process.exit(1);process.exit(0);}catch{}; if(!/running/i.test(s))process.exit(1);" <<<"$status_out" >/dev/null 2>&1; then
    echo "[remote-daemon-reuse-cli] remote daemon status not running; raw:" >&2
    echo "$status_out" >&2
    exit 1
  fi

  echo "[remote-daemon-reuse-cli] waiting for remote daemon to register a machine..."
  machine_count_after="$(wait_for_machine_growth "$machine_count_before" 90)" || true
fi

if ! [[ "$machine_count_after" =~ ^[0-9]+$ ]] || [[ "$machine_count_after" -le "$machine_count_before" ]]; then
  echo "[remote-daemon-reuse-cli] expected /v1/machines to grow after remote daemon setup/start (before=$machine_count_before after=$machine_count_after)" >&2
  exit 1
fi

echo "[remote-daemon-reuse-cli] OK (before=$machine_count_before after=$machine_count_after)"
