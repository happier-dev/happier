#!/bin/bash

shorten_text() {
  local s="$1"
  local max="${2:-44}"
  if [[ ${#s} -le $max ]]; then
    echo "$s"
    return
  fi
  echo "${s:0:$((max - 3))}..."
}

shorten_path() {
  local p="$1"
  local max="${2:-44}"
  local pretty="${p/#$HOME/~}"
  shorten_text "$pretty" "$max"
}

swiftbar_sum_metrics_cpu_mem() {
  # Usage: swiftbar_sum_metrics_cpu_mem <metrics...>
  # Each metrics is "cpu|mem_mb|etime" (as produced by get_process_metrics), or empty/"-".
  #
  # Output: "cpu_total|mem_total" where cpu_total has 1 decimal.
  # Notes:
  # - CPU is summed as a float and can exceed 100 on multi-core machines.
  # - Memory is summed as integer MB.
  printf '%s\n' "$@" | awk -F'|' '
    {
      cpu=$1; mem=$2;
      if (cpu ~ /^[0-9]+(\.[0-9]+)?$/) cpuSum += cpu;
      if (mem ~ /^[0-9]+$/) memSum += mem;
    }
    END {
      # Always print 1 decimal for CPU to keep it stable/readable.
      printf "%.1f|%.0f\n", cpuSum + 0.0, memSum + 0.0;
    }
  '
}

swiftbar_worktree_spec_from_path() {
  # Usage: swiftbar_worktree_spec_from_path <worktree_path> <repo_key>
  #
  # Returns:
  # - "default" for managed default checkouts at: */components/<repo_key>
  # - "<owner>/<branch...>" for managed worktrees at: */components/.worktrees/<repo_key>/<owner>/<branch...>
  # - "" otherwise (unmanaged path; menu should offer open-only actions)
  local wt_path="$1"
  local repo_key="$2"
  [[ -n "$wt_path" && -n "$repo_key" ]] || { echo ""; return; }

  if [[ "$wt_path" == *"/components/${repo_key}" || "$wt_path" == *"/components/${repo_key}/"* ]]; then
    echo "default"
    return
  fi
  if [[ "$wt_path" == *"/components/.worktrees/${repo_key}/"* ]]; then
    local rest="${wt_path#*"/components/.worktrees/${repo_key}/"}"
    echo "$rest"
    return
  fi
  echo ""
}

swiftbar_find_git_root_upwards() {
  # Usage: swiftbar_find_git_root_upwards <path>
  # Returns the nearest ancestor directory (including itself) that contains a .git dir/file.
  #
  # This is a fast filesystem-based check used during menu render, mainly to:
  # - avoid repeating a monorepo root path for package dirs (expo-app/cli/server)
  # - derive the "repo root" for "open repo root" actions
  local start="$1"
  [[ -n "$start" ]] || { echo ""; return; }
  [[ -d "$start" ]] || { echo ""; return; }

  local cur="$start"
  local i=0
  while [[ -n "$cur" && "$cur" != "/" && $i -lt 25 ]]; do
    if [[ -d "$cur/.git" || -f "$cur/.git" ]]; then
      echo "$cur"
      return
    fi
    cur="$(dirname "$cur")"
    i=$((i + 1))
  done
  if [[ "$cur" == "/" && ( -d "/.git" || -f "/.git" ) ]]; then
    echo "/"
    return
  fi
  echo ""
}

swiftbar_repo_key_from_path() {
  # Usage: swiftbar_repo_key_from_path <path>
  #
  # Heuristic for happy-stacks layouts:
  # - Worktrees: */components/.worktrees/<repoKey>/...
  # - Defaults:  */components/<repoKey>/...
  #
  # Returns "" when it can't be derived (unmanaged path).
  local p="$1"
  [[ -n "$p" ]] || { echo ""; return; }

  if [[ "$p" == *"/components/.worktrees/"* ]]; then
    local rest="${p#*"/components/.worktrees/"}"
    echo "${rest%%/*}"
    return
  fi
  if [[ "$p" == *"/components/"* ]]; then
    local rest="${p#*"/components/"}"
    echo "${rest%%/*}"
    return
  fi
  echo ""
}

swiftbar_is_sandboxed() {
  [[ -n "${HAPPY_STACKS_SANDBOX_DIR:-}" ]]
}

swiftbar_profile_enabled() {
  [[ "${HAPPY_STACKS_SWIFTBAR_PROFILE:-}" == "1" || "${HAPPY_LOCAL_SWIFTBAR_PROFILE:-}" == "1" ]]
}

swiftbar_now_ms() {
  # macOS `date` doesn't support %N, so use Time::HiRes when available.
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf("%.0f\n", time()*1000)'
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))'
    return
  fi
  # Fallback: seconds granularity.
  echo $(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
}

swiftbar_profile_log_file() {
  # Keep logs in the home install by default (stable across repos/worktrees).
  local canonical="${HAPPY_STACKS_CANONICAL_HOME_DIR:-${HAPPY_LOCAL_CANONICAL_HOME_DIR:-$HOME/.happy-stacks}}"
  local home="${HAPPY_STACKS_HOME_DIR:-${HAPPY_LOCAL_DIR:-$canonical}}"
  echo "${home}/cache/swiftbar/profile.log"
}

swiftbar_profile_log() {
  # Usage: swiftbar_profile_log "event" "k=v" "k2=v2" ...
  swiftbar_profile_enabled || return 0

  local log_file
  log_file="$(swiftbar_profile_log_file)"
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true

  local ts
  ts="$(swiftbar_now_ms)"
  {
    printf '%s\t%s' "$ts" "$1"
    shift || true
    for kv in "$@"; do
      printf '\t%s' "$kv"
    done
    printf '\n'
  } >>"$log_file" 2>/dev/null || true
}

swiftbar_profile_time() {
  # Usage: swiftbar_profile_time <label> -- <command...>
  swiftbar_profile_enabled || { shift; [[ "${1:-}" == "--" ]] && shift; "$@"; return $?; }
  local label="$1"
  shift
  [[ "${1:-}" == "--" ]] && shift

  local t0 t1 rc
  t0="$(swiftbar_now_ms)"
  "$@"
  rc=$?
  t1="$(swiftbar_now_ms)"
  swiftbar_profile_log "time" "label=${label}" "ms=$((t1 - t0))" "rc=${rc}"
  return $rc
}

swiftbar_cache_hash12() {
  # Usage: swiftbar_cache_hash12 "string"
  local s="$1"
  if command -v md5 >/dev/null 2>&1; then
    md5 -q -s "$s" 2>/dev/null | head -c 12
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$s" | shasum -a 256 2>/dev/null | awk '{print substr($1,1,12)}'
    return
  fi
  # Last resort (not cryptographic): length + a sanitized prefix.
  printf '%s' "${#s}-$(echo "$s" | tr -cd '[:alnum:]' | head -c 10)"
}

swiftbar_hash() {
  # Usage: swiftbar_hash "string"
  local s="$1"
  if command -v md5 >/dev/null 2>&1; then
    md5 -q -s "$s" 2>/dev/null || true
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$s" | shasum -a 256 2>/dev/null | awk '{print $1}'
    return
  fi
  printf '%s' "$(swiftbar_cache_hash12 "$s")"
}

swiftbar_run_cache_dir() {
  # Per-process (per-refresh) cache. Avoid persisting across SwiftBar refreshes.
  local base="${TMPDIR:-/tmp}"
  local dir="${base%/}/happy-stacks-swiftbar-cache-${UID:-0}-$$"
  mkdir -p "$dir" 2>/dev/null || true
  echo "$dir"
}

swiftbar_cache_file_for_key() {
  local key="$1"
  local dir
  dir="$(swiftbar_run_cache_dir)"
  echo "${dir}/$(swiftbar_cache_hash12 "$key").cache"
}

swiftbar_cache_get() {
  # Usage: swiftbar_cache_get <key>
  # Output: cached stdout (may be empty). Exit status: cached rc.
  local key="$1"
  local f
  f="$(swiftbar_cache_file_for_key "$key")"
  # Important: return a distinct code on cache-miss so callers can distinguish from cached rc=1.
  [[ -f "$f" ]] || return 111
  local rc_line rc
  rc_line="$(head -n 1 "$f" 2>/dev/null || true)"
  rc="${rc_line#rc:}"
  tail -n +2 "$f" 2>/dev/null || true
  [[ "$rc" =~ ^[0-9]+$ ]] || rc=0
  return "$rc"
}

swiftbar_cache_set() {
  # Usage: swiftbar_cache_set <key> <rc> <stdout>
  local key="$1"
  local rc="$2"
  local out="${3:-}"
  local f
  f="$(swiftbar_cache_file_for_key "$key")"
  {
    printf 'rc:%s\n' "${rc:-0}"
    printf '%s' "$out"
    # Keep files line-friendly.
    [[ "$out" == *$'\n' ]] || printf '\n'
  } >"$f" 2>/dev/null || true
}

dotenv_get() {
  # Usage: dotenv_get /path/to/env KEY
  # Notes:
  # - ignores blank lines and comments
  # - does not expand variables
  # - strips simple surrounding quotes
  local file="$1"
  local key="$2"
  if [[ -z "$file" ]] || [[ -z "$key" ]] || [[ ! -f "$file" ]]; then
    return
  fi
  awk -v k="$key" '
    BEGIN { FS="=" }
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    {
      kk=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", kk)
      if (kk != k) next

      vv=$0
      sub(/^[^=]*=/, "", vv)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", vv)

      if (vv ~ /^".*"$/) { sub(/^"/, "", vv); sub(/"$/, "", vv) }
      if (vv ~ /^'\''.*'\''$/) { sub(/^'\''/, "", vv); sub(/'\''$/, "", vv) }

      print vv
      exit
    }
  ' "$file" 2>/dev/null
}

expand_home_path() {
  local p="$1"
  if [[ "$p" == "~/"* ]]; then
    echo "$HOME/${p#~/}"
    return
  fi
  echo "$p"
}

resolve_happy_local_dir() {
  local canonical="${HAPPY_STACKS_CANONICAL_HOME_DIR:-${HAPPY_LOCAL_CANONICAL_HOME_DIR:-$HOME/.happy-stacks}}"
  local home="${HAPPY_STACKS_HOME_DIR:-${HAPPY_LOCAL_DIR:-$canonical}}"

  # If user provided a valid directory, keep it.
  if [[ -n "${HAPPY_LOCAL_DIR:-}" ]] && [[ -f "$HAPPY_LOCAL_DIR/extras/swiftbar/lib/utils.sh" ]]; then
    echo "$HAPPY_LOCAL_DIR"
    return
  fi

  # Canonical install location.
  if [[ -f "$home/extras/swiftbar/lib/utils.sh" ]]; then
    echo "$home"
    return
  fi

  # Fall back to home even if missing so the menu can show actionable errors.
  echo "$home"
}

resolve_stacks_storage_root() {
  # Priority:
  # 1) explicit env var
  # 2) home env.local
  # 3) home .env (canonical pointer file, written by `happys init`)
  # 4) default to ~/.happy/stacks
  if [[ -n "${HAPPY_STACKS_STORAGE_DIR:-}" ]]; then
    echo "$(expand_home_path "$HAPPY_STACKS_STORAGE_DIR")"
    return
  fi
  if [[ -n "${HAPPY_LOCAL_STORAGE_DIR:-}" ]]; then
    echo "$(expand_home_path "$HAPPY_LOCAL_STORAGE_DIR")"
    return
  fi

  local p
  p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_STORAGE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_STORAGE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_STORAGE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_STORAGE_DIR")"
  if [[ -n "$p" ]]; then
    echo "$(expand_home_path "$p")"
    return
  fi

  # In sandbox mode, avoid falling back to the user's real ~/.happy/stacks.
  if swiftbar_is_sandboxed; then
    echo "${HAPPY_STACKS_STORAGE_DIR:-${HAPPY_STACKS_SANDBOX_DIR%/}/storage}"
    return
  fi

  echo "$HOME/.happy/stacks"
}

resolve_stack_env_file() {
  local stack_name="${1:-main}"
  local storage_root
  storage_root="$(resolve_stacks_storage_root)"

  local primary="${storage_root}/${stack_name}/env"
  if [[ -f "$primary" ]]; then
    echo "$primary"
    return
  fi

  if ! swiftbar_is_sandboxed; then
    local legacy="$HOME/.happy/local/stacks/${stack_name}/env"
    if [[ -f "$legacy" ]]; then
      echo "$legacy"
      return
    fi
  fi

  # Very old single-stack location (best-effort).
  if ! swiftbar_is_sandboxed; then
    if [[ "$stack_name" == "main" ]]; then
      local legacy_single="$HOME/.happy/local/env"
      if [[ -f "$legacy_single" ]]; then
        echo "$legacy_single"
        return
      fi
    fi
  fi

  echo "$primary"
}

resolve_stack_base_dir() {
  local stack_name="${1:-main}"
  local env_file="${2:-}"
  if [[ -z "$env_file" ]]; then
    env_file="$(resolve_stack_env_file "$stack_name")"
  fi
  # If the env file exists, its parent directory is the stack base dir for all supported layouts.
  if [[ -n "$env_file" ]] && [[ -f "$env_file" ]]; then
    dirname "$env_file"
    return
  fi
  local storage_root
  storage_root="$(resolve_stacks_storage_root)"
  echo "${storage_root}/${stack_name}"
}

resolve_stack_cli_home_dir() {
  local stack_name="${1:-main}"
  local env_file="${2:-}"
  if [[ -z "$env_file" ]]; then
    env_file="$(resolve_stack_env_file "$stack_name")"
  fi
  local cli_home=""
  if [[ -n "$env_file" ]] && [[ -f "$env_file" ]]; then
    cli_home="$(dotenv_get "$env_file" "HAPPY_STACKS_CLI_HOME_DIR")"
    [[ -z "$cli_home" ]] && cli_home="$(dotenv_get "$env_file" "HAPPY_LOCAL_CLI_HOME_DIR")"
  fi
  if [[ -n "$cli_home" ]]; then
    echo "$(expand_home_path "$cli_home")"
    return
  fi
  local base_dir
  base_dir="$(resolve_stack_base_dir "$stack_name" "$env_file")"
  echo "${base_dir}/cli"
}

resolve_stack_label() {
  local stack_name="${1:-main}"
  local primary="com.happy.stacks"
  local legacy="com.happy.local"
  if [[ "$stack_name" != "main" ]]; then
    primary="com.happy.stacks.${stack_name}"
    legacy="com.happy.local.${stack_name}"
  fi
  if swiftbar_is_sandboxed; then
    # Never inspect global LaunchAgents in sandbox mode.
    echo "$primary"
    return
  fi
  local primary_plist="$HOME/Library/LaunchAgents/${primary}.plist"
  local legacy_plist="$HOME/Library/LaunchAgents/${legacy}.plist"
  if [[ -f "$primary_plist" ]]; then
    echo "$primary"
    return
  fi
  if [[ -f "$legacy_plist" ]]; then
    echo "$legacy"
    return
  fi
  echo "$primary"
}

resolve_pnpm_bin() {
  # Back-compat: historically this was "pnpm", but the plugin now runs `happys` via wrapper scripts.
  local wrapper="$HAPPY_LOCAL_DIR/extras/swiftbar/happys.sh"
  if [[ -x "$wrapper" ]]; then
    echo "$wrapper"
    return
  fi

  # Older installs.
  wrapper="$HAPPY_LOCAL_DIR/extras/swiftbar/pnpm.sh"
  if [[ -x "$wrapper" ]]; then
    echo "$wrapper"
    return
  fi

  local global_happys
  if ! swiftbar_is_sandboxed; then
    global_happys="$(command -v happys 2>/dev/null || true)"
    if [[ -n "$global_happys" ]]; then
      echo "$global_happys"
      return
    fi
  fi

  echo ""
}

resolve_node_bin() {
  # Prefer explicit env vars first.
  if [[ -n "${HAPPY_STACKS_NODE:-}" ]] && [[ -x "${HAPPY_STACKS_NODE:-}" ]]; then
    echo "$HAPPY_STACKS_NODE"
    return
  fi
  if [[ -n "${HAPPY_LOCAL_NODE:-}" ]] && [[ -x "${HAPPY_LOCAL_NODE:-}" ]]; then
    echo "$HAPPY_LOCAL_NODE"
    return
  fi

  # Fall back to reading the canonical pointer env (written by `happys init`).
  local canonical="${HAPPY_STACKS_CANONICAL_HOME_DIR:-${HAPPY_LOCAL_CANONICAL_HOME_DIR:-$HOME/.happy-stacks}}"
  local home="${HAPPY_STACKS_HOME_DIR:-${HAPPY_LOCAL_DIR:-$canonical}}"
  local env_file="$home/.env"
  if [[ -f "$env_file" ]]; then
    local v
    v="$(dotenv_get "$env_file" "HAPPY_STACKS_NODE")"
    if [[ -n "$v" ]] && [[ -x "$v" ]]; then
      echo "$v"
      return
    fi
    v="$(dotenv_get "$env_file" "HAPPY_LOCAL_NODE")"
    if [[ -n "$v" ]] && [[ -x "$v" ]]; then
      echo "$v"
      return
    fi
  fi

  command -v node 2>/dev/null || true
}

resolve_workspace_dir() {
  if [[ -n "${HAPPY_STACKS_WORKSPACE_DIR:-}" ]]; then
    echo "$HAPPY_STACKS_WORKSPACE_DIR"
    return
  fi
  local p
  p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_WORKSPACE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_WORKSPACE_DIR")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi
  echo "$HAPPY_LOCAL_DIR/workspace"
}

resolve_components_dir() {
  echo "$(resolve_workspace_dir)/components"
}

resolve_main_env_file() {
  local explicit="${HAPPY_STACKS_ENV_FILE:-${HAPPY_LOCAL_ENV_FILE:-}}"
  if [[ -n "$explicit" ]] && [[ -f "$explicit" ]]; then
    echo "$explicit"
    return
  fi

  local storage_root
  storage_root="$(resolve_stacks_storage_root)"
  local main="$storage_root/main/env"
  if [[ -f "$main" ]]; then
    echo "$main"
    return
  fi
  if ! swiftbar_is_sandboxed; then
    # Legacy stacks location (pre-migration).
    local legacy="$HOME/.happy/local/stacks/main/env"
    if [[ -f "$legacy" ]]; then
      echo "$legacy"
      return
    fi
    # Very old single-stack location (best-effort).
    local legacy_single="$HOME/.happy/local/env"
    if [[ -f "$legacy_single" ]]; then
      echo "$legacy_single"
      return
    fi
  fi
  echo ""
}

resolve_main_port() {
  # Priority:
  # 1) explicit env var
  # 2) main stack env
  # 3) home env.local
  # 4) home .env
  # 5) runtime state (ephemeral stacks)
  # 6) fallback to HAPPY_LOCAL_PORT / 3005
  if [[ -n "${HAPPY_LOCAL_SERVER_PORT:-}" ]]; then
    echo "$HAPPY_LOCAL_SERVER_PORT"
    return
  fi
  if [[ -n "${HAPPY_STACKS_SERVER_PORT:-}" ]]; then
    echo "$HAPPY_STACKS_SERVER_PORT"
    return
  fi

  local p
  local env_file
  env_file="$(resolve_main_env_file)"
  if [[ -n "$env_file" ]]; then
    p="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_PORT")"
    [[ -z "$p" ]] && p="$(dotenv_get "$env_file" "HAPPY_STACKS_SERVER_PORT")"
  fi
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi

  p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_SERVER_PORT")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_SERVER_PORT")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi

  p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_SERVER_PORT")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_SERVER_PORT")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi

  # Runtime-only port overlay (ephemeral stacks): best-effort.
  local base_dir state_file
  base_dir="$(resolve_stack_base_dir main "$env_file")"
  state_file="${base_dir}/stack.runtime.json"
  p="$(resolve_runtime_server_port_from_state_file "$state_file")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi

  echo "${HAPPY_LOCAL_PORT:-3005}"
}

resolve_runtime_server_port_from_state_file() {
  # Reads stack.runtime.json and returns ports.server, but only if ownerPid is alive.
  # Output: port number or empty.
  local state_file="$1"
  [[ -n "$state_file" && -f "$state_file" ]] || return 0

  local owner="" port=""

  # Fast-path: parse our own JSON shape without spawning node (best-effort).
  if command -v grep >/dev/null 2>&1; then
    owner="$(grep -oE '"ownerPid"[[:space:]]*:[[:space:]]*[0-9]+' "$state_file" 2>/dev/null | head -1 | grep -oE '[0-9]+' || true)"
    port="$(grep -oE '"server"[[:space:]]*:[[:space:]]*[0-9]+' "$state_file" 2>/dev/null | head -1 | grep -oE '[0-9]+' || true)"
  fi

  if [[ -z "$owner" || -z "$port" ]]; then
    local node_bin
    node_bin="$(resolve_node_bin)"
    if [[ -n "$node_bin" && -x "$node_bin" ]]; then
      local out
      out="$(
        "$node_bin" -e '
          const fs=require("fs");
          try {
            const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
            const owner=String(s?.ownerPid ?? "");
            const port=String(s?.ports?.server ?? "");
            process.stdout.write(owner + "\t" + port);
          } catch { process.stdout.write("\t"); }
        ' "$state_file" 2>/dev/null || true
      )"
      IFS=$'\t' read -r owner port <<<"$out"
    elif command -v python3 >/dev/null 2>&1; then
      local out
      out="$(
        python3 -c 'import json,sys; 
try:
  s=json.load(open(sys.argv[1],"r"))
  owner=str(s.get("ownerPid",""))
  port=str((s.get("ports") or {}).get("server",""))
  print(owner+"\\t"+port,end="")
except Exception:
  print("\\t",end="")' "$state_file" 2>/dev/null || true
      )"
      IFS=$'\t' read -r owner port <<<"$out"
    fi
  fi

  [[ "$owner" =~ ^[0-9]+$ ]] || owner=""
  [[ "$port" =~ ^[0-9]+$ ]] || port=""
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    echo "$port"
  fi
}

resolve_stack_server_port() {
  # Usage: resolve_stack_server_port <stack_name> <env_file>
  # Priority:
  # - pinned port in env file
  # - runtime port in stack.runtime.json (only if ownerPid alive)
  local stack_name="${1:-main}"
  local env_file="${2:-}"

  local p=""
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    p="$(dotenv_get "$env_file" "HAPPY_STACKS_SERVER_PORT")"
    [[ -z "$p" ]] && p="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_PORT")"
  fi
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi

  local base_dir state_file
  base_dir="$(resolve_stack_base_dir "$stack_name" "$env_file")"
  state_file="${base_dir}/stack.runtime.json"
  p="$(resolve_runtime_server_port_from_state_file "$state_file")"
  echo "$p"
}

resolve_main_server_component() {
  if [[ -n "${HAPPY_LOCAL_SERVER_COMPONENT:-}" ]]; then
    echo "$HAPPY_LOCAL_SERVER_COMPONENT"
    return
  fi
  if [[ -n "${HAPPY_STACKS_SERVER_COMPONENT:-}" ]]; then
    echo "$HAPPY_STACKS_SERVER_COMPONENT"
    return
  fi

  local c
  local env_file
  env_file="$(resolve_main_env_file)"
  if [[ -n "$env_file" ]]; then
    c="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_COMPONENT")"
    [[ -z "$c" ]] && c="$(dotenv_get "$env_file" "HAPPY_STACKS_SERVER_COMPONENT")"
  fi
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi

  c="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_SERVER_COMPONENT")"
  [[ -z "$c" ]] && c="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_SERVER_COMPONENT")"
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi

  c="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_SERVER_COMPONENT")"
  [[ -z "$c" ]] && c="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_SERVER_COMPONENT")"
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi

  echo "happy-server-light"
}

resolve_menubar_mode() {
  # selfhost | dev (default: dev)
  local raw=""
  if [[ -n "${HAPPY_LOCAL_MENUBAR_MODE:-}" ]]; then
    raw="$HAPPY_LOCAL_MENUBAR_MODE"
  elif [[ -n "${HAPPY_STACKS_MENUBAR_MODE:-}" ]]; then
    raw="$HAPPY_STACKS_MENUBAR_MODE"
  fi

  local env_file
  env_file="$(resolve_main_env_file)"
  if [[ -z "$raw" && -n "$env_file" ]]; then
    raw="$(dotenv_get "$env_file" "HAPPY_LOCAL_MENUBAR_MODE")"
    [[ -z "$raw" ]] && raw="$(dotenv_get "$env_file" "HAPPY_STACKS_MENUBAR_MODE")"
  fi

  if [[ -z "$raw" ]]; then
    raw="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_MENUBAR_MODE")"
    [[ -z "$raw" ]] && raw="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_MENUBAR_MODE")"
  fi
  if [[ -z "$raw" ]]; then
    raw="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_MENUBAR_MODE")"
    [[ -z "$raw" ]] && raw="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_MENUBAR_MODE")"
  fi

  raw="$(echo "${raw:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$raw" in
    selfhost|self-host|self_host|host) echo "selfhost" ;;
    *) echo "dev" ;;
  esac
}
