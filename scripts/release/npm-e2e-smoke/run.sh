#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

mode="npm"
stack_spec="@happier-dev/stack@next"
cli_spec="@happier-dev/cli@next"
cli_install_mode="global"
keep="0"
monorepo_mode="github"
timeout_s="1800"
with_remote_daemon=""
with_remote_server=""
remote_installer=""
remote_auth_mode=""
remote_server_db=""
show_help="0"

usage() {
  cat <<EOF
Usage: $0 [--mode=npm|local] [--stack-spec <spec>] [--cli-spec <spec>] [--cli-install=global|npx] [--monorepo=github|local] [--timeout-s <seconds>] [--with-remote-daemon|--no-remote-daemon] [--with-remote-server|--no-remote-server] [--remote-server-db=postgres|sqlite] [--remote-installer=shim|official] [--remote-auth-mode=reuse-cli|bootstrap] [--keep]

Examples:
  $0
  $0 --mode=local
  $0 --stack-spec @happier-dev/stack@next --cli-spec @happier-dev/cli@next
  $0 --cli-install=npx
  $0 --monorepo=local
  $0 --mode=local --with-remote-daemon --with-remote-server --remote-server-db=postgres --remote-installer=shim --remote-auth-mode=reuse-cli
  $0 --mode=npm --with-remote-daemon --remote-installer=official --remote-auth-mode=bootstrap
EOF
}

for arg in "$@"; do
  case "$arg" in
    --mode=*) mode="${arg#*=}" ;;
    --stack-spec=*) stack_spec="${arg#*=}" ;;
    --cli-spec=*) cli_spec="${arg#*=}" ;;
    --cli-install=*) cli_install_mode="${arg#*=}" ;;
    --monorepo=*) monorepo_mode="${arg#*=}" ;;
    --timeout-s=*) timeout_s="${arg#*=}" ;;
    --with-remote-daemon) with_remote_daemon="1" ;;
    --no-remote-daemon) with_remote_daemon="0" ;;
    --with-remote-server) with_remote_server="1" ;;
    --no-remote-server) with_remote_server="0" ;;
    --remote-installer=*) remote_installer="${arg#*=}" ;;
    --remote-auth-mode=*) remote_auth_mode="${arg#*=}" ;;
    --remote-server-db=*) remote_server_db="${arg#*=}" ;;
    --keep) keep="1" ;;
    -h|--help) show_help="1" ;;
    *) echo "Unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

if [[ "$mode" != "npm" && "$mode" != "local" ]]; then
  echo "Invalid --mode=$mode (expected npm|local)" >&2
  exit 2
fi
if [[ "$cli_install_mode" != "global" && "$cli_install_mode" != "npx" ]]; then
  echo "Invalid --cli-install=$cli_install_mode (expected global|npx)" >&2
  exit 2
fi
if [[ "$monorepo_mode" != "github" && "$monorepo_mode" != "local" ]]; then
  echo "Invalid --monorepo=$monorepo_mode (expected github|local)" >&2
  exit 2
fi

if [[ -z "$with_remote_daemon" ]]; then
  if [[ "$mode" == "local" ]]; then
    with_remote_daemon="1"
  else
    with_remote_daemon="0"
  fi
fi
if [[ "$with_remote_daemon" != "0" && "$with_remote_daemon" != "1" ]]; then
  echo "Invalid remote daemon mode (expected --with-remote-daemon or --no-remote-daemon)" >&2
  exit 2
fi

if [[ -z "$with_remote_server" ]]; then
  if [[ "$mode" == "local" ]]; then
    with_remote_server="1"
  else
    with_remote_server="0"
  fi
fi
if [[ "$with_remote_server" != "0" && "$with_remote_server" != "1" ]]; then
  echo "Invalid remote server mode (expected --with-remote-server or --no-remote-server)" >&2
  exit 2
fi

if [[ -z "$remote_server_db" ]]; then
  remote_server_db="postgres"
fi
if [[ "$remote_server_db" != "postgres" && "$remote_server_db" != "sqlite" ]]; then
  echo "Invalid --remote-server-db=$remote_server_db (expected postgres|sqlite)" >&2
  exit 2
fi

if [[ -z "$remote_installer" ]]; then
  if [[ "$mode" == "local" ]]; then
    remote_installer="shim"
  else
    remote_installer="official"
  fi
fi
if [[ "$remote_installer" != "shim" && "$remote_installer" != "official" ]]; then
  echo "Invalid --remote-installer=$remote_installer (expected shim|official)" >&2
  exit 2
fi

if [[ -z "$remote_auth_mode" ]]; then
  remote_auth_mode="reuse-cli"
fi
if [[ "$remote_auth_mode" != "reuse-cli" && "$remote_auth_mode" != "bootstrap" ]]; then
  echo "Invalid --remote-auth-mode=$remote_auth_mode (expected reuse-cli|bootstrap)" >&2
  exit 2
fi

if [[ "$show_help" == "1" ]]; then
  usage
  exit 0
fi

project_name="happier-npm-e2e-smoke"
compose=(docker compose --project-name "$project_name" -f "$here/compose.yml")
compose_remote=()
with_any_remote="0"
if [[ "$with_remote_daemon" == "1" || "$with_remote_server" == "1" ]]; then
  with_any_remote="1"
fi

cleanup() {
  if [[ "$keep" == "1" ]]; then
    echo "[npm-e2e-smoke] keeping containers/volumes (use: ${compose[*]} down -v)" >&2
    return
  fi
  env_args=()
  if [[ -f "${env_file:-}" ]]; then
    env_args=(--env-file "$env_file")
  fi

  compose_down=("${compose[@]}")
  if [[ "$with_any_remote" == "1" ]] && [[ ${#compose_remote[@]} -gt 0 ]]; then
    compose_down=("${compose_remote[@]}")
  fi

  set +e
  "${compose_down[@]}" "${env_args[@]}" down -v >/dev/null 2>&1 &
  down_pid="$!"

  # Avoid hanging forever (Docker can sometimes leave "Dead" containers around that keep volumes in-use).
  for _ in $(seq 1 120); do
    if ! kill -0 "$down_pid" >/dev/null 2>&1; then
      wait "$down_pid" >/dev/null 2>&1 || true
      set -e
      return
    fi
    sleep 1
  done

  echo "[npm-e2e-smoke] cleanup timed out; forcing teardown" >&2
  kill "$down_pid" >/dev/null 2>&1 || true
  sleep 2
  kill -9 "$down_pid" >/dev/null 2>&1 || true

  # Best-effort: clear any leftover *dead* containers that can keep volumes in-use.
  dead_ids="$(docker ps -aq --filter "label=com.docker.compose.project=${project_name}" --filter "status=dead" 2>/dev/null || true)"
  if [[ -n "${dead_ids:-}" ]]; then
    docker rm -f $dead_ids >/dev/null 2>&1 || true
  fi
  docker volume rm $(docker volume ls -q --filter "name=${project_name}" 2>/dev/null) >/dev/null 2>&1 || true
  docker network rm "${project_name}_default" >/dev/null 2>&1 || true
  set -e
}
trap cleanup EXIT

echo "[npm-e2e-smoke] docker sanity check..."
docker version >/dev/null

env_file="$repo_root/output/npm-e2e-smoke.env"
rm -f "$env_file" || true

packs_dir="$repo_root/output/npm-e2e-smoke"
mkdir -p "$packs_dir"

ssh_dir="$repo_root/output/npm-e2e-smoke-ssh"
mkdir -p "$ssh_dir"
rm -f "$ssh_dir/id_ed25519" "$ssh_dir/id_ed25519.pub" >/dev/null 2>&1 || true
umask 077
ssh-keygen -t ed25519 -N '' -f "$ssh_dir/id_ed25519" >/dev/null

  {
    echo "REPO_ROOT=$repo_root"
    echo "PACKS_DIR=$packs_dir"
    echo "SSH_PRIVATE_KEY_PATH=$ssh_dir/id_ed25519"
    echo "SSH_PUBLIC_KEY_PATH=$ssh_dir/id_ed25519.pub"
    echo "HSTACK_NPM_SPEC=$stack_spec"
    echo "HAPPIER_NPM_SPEC=$cli_spec"
    echo "HAPPIER_CLI_INSTALL_MODE=$cli_install_mode"
    echo "HAPPIER_SERVER_URL=http://stack:3005"
    if [[ "$remote_installer" == "shim" ]]; then
      echo "REMOTE_SHIM_HAPPIER_INSTALLER=1"
    else
      echo "REMOTE_SHIM_HAPPIER_INSTALLER=0"
    fi

    # Remote server smoke defaults. Kept in env so we can parameterize without editing compose files.
    echo "REMOTE_SERVER_PORT=3999"
    echo "REMOTE_SERVER_DB=$remote_server_db"
	    echo "POSTGRES_HOST=postgres"
	    echo "POSTGRES_PORT=5432"
	    echo "POSTGRES_USER=happier"
	    echo "POSTGRES_PASSWORD=happier"
	    echo "POSTGRES_DB=happier_smoke"
	    echo "POSTGRES_APP_NAME=happier_npm_e2e_smoke"
	  } > "$env_file"

if [[ "$mode" == "npm" ]] && [[ "$remote_installer" == "shim" ]] && ([[ "$with_remote_daemon" == "1" ]] || [[ "$with_remote_server" == "1" ]]); then
  echo "[npm-e2e-smoke] packing remote shim tarballs from npm..."
  rm -f \
    "$packs_dir/stack.tgz" \
    "$packs_dir/cli.tgz" \
    "$packs_dir"/happier-dev-stack-*.tgz \
    "$packs_dir"/happier-dev-cli-*.tgz \
    >/dev/null 2>&1 || true

  npm_config_loglevel=silent npm pack "$stack_spec" --pack-destination "$packs_dir" >/dev/null
  stack_packed="$(ls -t "$packs_dir"/happier-dev-stack-*.tgz 2>/dev/null | head -n 1 || true)"
  if [[ -z "$stack_packed" || ! -f "$stack_packed" ]]; then
    echo "[npm-e2e-smoke] failed to produce stack tarball under $packs_dir (remote-installer=shim)" >&2
    exit 1
  fi
  mv "$stack_packed" "$packs_dir/stack.tgz"

  npm_config_loglevel=silent npm pack "$cli_spec" --pack-destination "$packs_dir" >/dev/null
  cli_packed="$(ls -t "$packs_dir"/happier-dev-cli-*.tgz 2>/dev/null | head -n 1 || true)"
  if [[ -z "$cli_packed" || ! -f "$cli_packed" ]]; then
    echo "[npm-e2e-smoke] failed to produce cli tarball under $packs_dir (remote-installer=shim)" >&2
    exit 1
  fi
  mv "$cli_packed" "$packs_dir/cli.tgz"
fi

if [[ "$mode" == "local" ]]; then
  echo "[npm-e2e-smoke] packing local tarballs..."
  rm -f \
    "$packs_dir/stack.tgz" \
    "$packs_dir/cli.tgz" \
    "$packs_dir"/happier-dev-stack-*.tgz \
    "$packs_dir"/happier-dev-cli-*.tgz \
    >/dev/null 2>&1 || true

  (cd "$repo_root/apps/stack" && npm_config_loglevel=silent npm pack --pack-destination "$packs_dir" >/dev/null)
  stack_packed="$(ls -t "$packs_dir"/happier-dev-stack-*.tgz 2>/dev/null | head -n 1 || true)"
  if [[ -z "$stack_packed" || ! -f "$stack_packed" ]]; then
    echo "[npm-e2e-smoke] failed to produce stack tarball under $packs_dir" >&2
    exit 1
  fi
  mv "$stack_packed" "$packs_dir/stack.tgz"

  (cd "$repo_root/apps/cli" && npm_config_loglevel=silent npm pack --pack-destination "$packs_dir" >/dev/null)
  cli_packed="$(ls -t "$packs_dir"/happier-dev-cli-*.tgz 2>/dev/null | head -n 1 || true)"
  if [[ -z "$cli_packed" || ! -f "$cli_packed" ]]; then
    echo "[npm-e2e-smoke] failed to produce cli tarball under $packs_dir" >&2
    exit 1
  fi
  mv "$cli_packed" "$packs_dir/cli.tgz"

  {
    echo "HSTACK_TGZ=/packs/stack.tgz"
    echo "HAPPIER_TGZ=/packs/cli.tgz"
  } >> "$env_file"
fi

if [[ "$monorepo_mode" == "local" ]]; then
  echo "[npm-e2e-smoke] using local monorepo as clone source..."
  echo "[npm-e2e-smoke] preparing a self-contained git clone for docker mount (worktree-safe)..."

  local_monorepo_dir="$repo_root/output/npm-e2e-smoke.monorepo"
  rm -rf "$local_monorepo_dir" >/dev/null 2>&1 || true
  mkdir -p "$local_monorepo_dir"

  git clone --quiet --no-hardlinks "$repo_root" "$local_monorepo_dir"
  # Apply any local changes from this checkout (worktree-safe). We intentionally avoid copying the full
  # working tree, since it may contain large untracked directories (e.g. nested node_modules).
  # NOTE: this does not copy untracked files; that is usually fine for stack bootstrap/build.
  git -C "$repo_root" diff --binary | git -C "$local_monorepo_dir" apply --allow-empty --whitespace=nowarn
  git -C "$repo_root" diff --cached --binary | git -C "$local_monorepo_dir" apply --allow-empty --whitespace=nowarn
  # hstack's local installer expects a "main" branch to exist in the remote it clones from.
  git -C "$local_monorepo_dir" branch -f main HEAD

  echo "LOCAL_MONOREPO_MOUNT=$local_monorepo_dir" >> "$env_file"
  echo "HSTACK_HAPPIER_REPO=/repo" >> "$env_file"
  compose=(docker compose --project-name "$project_name" -f "$here/compose.yml" -f "$here/compose.local-monorepo.yml")
fi

compose_remote=("${compose[@]}" -f "$here/compose.remote.yml")
compose_run=("${compose[@]}")
if [[ "$with_any_remote" == "1" ]]; then
  compose_run=("${compose_remote[@]}")
fi

echo "[npm-e2e-smoke] building images..."
if [[ "$with_any_remote" == "1" ]]; then
  build_targets=(stack cli cli2)
  if [[ "$with_remote_daemon" == "1" ]]; then
    build_targets+=(remote1 remote-daemon-smoke remote-daemon-authenticated-cli-smoke)
  fi
  if [[ "$with_remote_server" == "1" ]]; then
    build_targets+=(remote-server1 remote-server-smoke)
  fi
  "${compose_remote[@]}" --env-file "$env_file" build "${build_targets[@]}" >/dev/null
else
  "${compose[@]}" --env-file "$env_file" build stack cli cli2 >/dev/null
fi

echo "[npm-e2e-smoke] starting stack..."
 "${compose[@]}" --env-file "$env_file" up -d --build \
  --no-deps \
  --force-recreate \
  --renew-anon-volumes \
  --remove-orphans \
  stack \
  >/dev/null

echo "[npm-e2e-smoke] waiting for server..."
if ! [[ "$timeout_s" =~ ^[0-9]+$ ]] || [[ "$timeout_s" -le 0 ]]; then
  echo "Invalid --timeout-s=$timeout_s (expected a positive integer seconds)" >&2
  exit 2
fi
start_ts="$(date +%s)"
while true; do
  if "${compose[@]}" exec -T stack bash -lc 'curl -fsS http://127.0.0.1:3005/v1/version >/dev/null && curl -fsS http://127.0.0.1:3005/ | head -c 4096 | grep -qi "<html"' >/dev/null 2>&1; then
    break
  fi
  now_ts="$(date +%s)"
  if (( now_ts - start_ts > timeout_s )); then
    echo "[npm-e2e-smoke] server did not become ready in ${timeout_s}s" >&2
    "${compose[@]}" --env-file "$env_file" logs --no-color stack >&2 || true
    exit 1
  fi
  sleep 2
done

echo "[npm-e2e-smoke] checking stack daemon..."
"${compose[@]}" exec -T stack bash -lc 'hstack daemon status --json | node -e "const fs=require(\"fs\");const j=JSON.parse(fs.readFileSync(0,\"utf8\"));const s=String(j.status||\"\"); if(!/running/i.test(s)){console.error(s||\"missing status\"); process.exit(1)}"' >/dev/null

echo "[npm-e2e-smoke] checking stack daemon connectivity (machine registration)..."
"${compose[@]}" exec -T stack bash -lc '
  set -euo pipefail

  access_key="/root/.happier/stacks/main/cli/servers/stack_main__id_default/access.key"
  if [[ ! -f "$access_key" ]]; then
    echo "[npm-e2e-smoke] missing access key at $access_key" >&2
    exit 1
  fi

  token="$(node -e "const fs=require(\"fs\");const j=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));process.stdout.write(String(j.token||\"\"))" "$access_key")"
  if [[ -z "$token" ]]; then
    echo "[npm-e2e-smoke] access.key did not contain a token" >&2
    exit 1
  fi

  base="http://127.0.0.1:3005"
  for _ in $(seq 1 60); do
    count="$(curl -fsS -H "Authorization: Bearer $token" "$base/v1/machines" | node -e "const fs=require(\"fs\");const j=JSON.parse(fs.readFileSync(0,\"utf8\"));process.stdout.write(String(Array.isArray(j)?j.length:0))")" || true
    if [[ "$count" =~ ^[0-9]+$ ]] && [[ "$count" -ge 1 ]]; then
      exit 0
    fi
    sleep 1
  done

  echo "[npm-e2e-smoke] expected stack daemon to register a machine (GET /v1/machines)" >&2
  exit 1
' >/dev/null

echo "[npm-e2e-smoke] running happier-cli smoke..."
set +e
"${compose_run[@]}" --env-file "$env_file" run --rm --no-deps cli
status=$?
set -e

if [[ $status -ne 0 ]]; then
  echo "[npm-e2e-smoke] cli smoke failed (exit $status)" >&2
  echo "[npm-e2e-smoke] stack logs:" >&2
  "${compose_run[@]}" --env-file "$env_file" logs --no-color stack >&2 || true
  if [[ "$keep" != "1" ]]; then
    echo "[npm-e2e-smoke] tip: re-run with --keep to debug inside the containers" >&2
  fi
  exit $status
fi

if [[ "$with_any_remote" == "1" ]]; then
  echo "[npm-e2e-smoke] starting remote hosts..."
  remote_up_services=()
  if [[ "$with_remote_daemon" == "1" ]]; then
    remote_up_services+=(remote1)
  fi
  if [[ "$with_remote_server" == "1" ]]; then
    remote_up_services+=(remote-server1)
    if [[ "$remote_server_db" == "postgres" ]]; then
      remote_up_services+=(postgres)
    fi
  fi
  "${compose_remote[@]}" --env-file "$env_file" up -d --no-deps --force-recreate --renew-anon-volumes "${remote_up_services[@]}" >/dev/null

  if [[ "$with_remote_server" == "1" ]]; then
    if [[ "$remote_server_db" == "postgres" ]]; then
      echo "[npm-e2e-smoke] running remote server setup smoke (db=postgres)..."
    else
      echo "[npm-e2e-smoke] running remote server setup smoke (db=sqlite)..."
    fi

    set +e
    "${compose_remote[@]}" --env-file "$env_file" run --rm --no-deps remote-server-smoke
    status=$?
    set -e

    if [[ $status -ne 0 ]]; then
      echo "[npm-e2e-smoke] remote server smoke failed (exit $status)" >&2
      echo "[npm-e2e-smoke] remote-server1 logs:" >&2
      "${compose_remote[@]}" --env-file "$env_file" logs --no-color remote-server1 >&2 || true
      if [[ "$remote_server_db" == "postgres" ]]; then
        echo "[npm-e2e-smoke] postgres logs:" >&2
        "${compose_remote[@]}" --env-file "$env_file" logs --no-color postgres >&2 || true
      fi
      if [[ "$keep" != "1" ]]; then
        echo "[npm-e2e-smoke] tip: re-run with --keep to debug inside the containers" >&2
      fi
      exit $status
    fi

	    if [[ "$remote_server_db" == "postgres" ]]; then
	      echo "[npm-e2e-smoke] validating postgres connectivity..."
	      for _ in $(seq 1 60); do
	        conn_count="$("${compose_remote[@]}" --env-file "$env_file" exec -T postgres sh -lc "psql -U \"${POSTGRES_USER:-happier}\" -d \"${POSTGRES_DB:-happier_smoke}\" -tAc \"select count(*) from pg_stat_activity where datname='${POSTGRES_DB:-happier_smoke}' and application_name='${POSTGRES_APP_NAME:-happier_npm_e2e_smoke}';\" 2>/dev/null | tr -d '[:space:]' | head -n 1" || true)"
	        if [[ "$conn_count" =~ ^[0-9]+$ ]] && [[ "$conn_count" -ge 1 ]]; then
	          break
	        fi
	        sleep 1
	      done
	      if ! [[ "${conn_count:-}" =~ ^[0-9]+$ ]] || [[ "$conn_count" -lt 1 ]]; then
	        echo "[npm-e2e-smoke] expected at least one postgres connection from server (application_name=${POSTGRES_APP_NAME:-missing}, got: ${conn_count:-missing})" >&2
	        exit 1
	      fi
	    fi
	  fi

  if [[ "$with_remote_daemon" == "1" ]]; then
    if [[ "$remote_auth_mode" == "bootstrap" ]]; then
      echo "[npm-e2e-smoke] running remote daemon setup smoke (auth=bootstrap)..."
      remote_service="remote-daemon-smoke"
    else
      echo "[npm-e2e-smoke] running remote daemon setup smoke (auth=reuse-cli)..."
      remote_service="remote-daemon-authenticated-cli-smoke"
    fi

    set +e
    "${compose_remote[@]}" --env-file "$env_file" run --rm --no-deps "$remote_service"
    status=$?
    set -e

    if [[ $status -ne 0 ]]; then
      echo "[npm-e2e-smoke] remote daemon smoke failed (exit $status)" >&2
      echo "[npm-e2e-smoke] stack logs:" >&2
      "${compose_remote[@]}" --env-file "$env_file" logs --no-color stack >&2 || true
      echo "[npm-e2e-smoke] remote1 logs:" >&2
      "${compose_remote[@]}" --env-file "$env_file" logs --no-color remote1 >&2 || true
      if [[ "$keep" != "1" ]]; then
        echo "[npm-e2e-smoke] tip: re-run with --keep to debug inside the containers" >&2
      fi
      exit $status
    fi
  fi
fi

echo "[npm-e2e-smoke] running second CLI machine smoke..."
set +e
"${compose_run[@]}" --env-file "$env_file" run --rm --no-deps cli2
status=$?
set -e

if [[ $status -ne 0 ]]; then
  echo "[npm-e2e-smoke] cli2 smoke failed (exit $status)" >&2
  echo "[npm-e2e-smoke] stack logs:" >&2
  "${compose_run[@]}" --env-file "$env_file" logs --no-color stack >&2 || true
  if [[ "$keep" != "1" ]]; then
    echo "[npm-e2e-smoke] tip: re-run with --keep to debug inside the containers" >&2
  fi
  exit $status
fi

echo "[npm-e2e-smoke] OK"
