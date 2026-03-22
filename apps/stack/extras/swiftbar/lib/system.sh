#!/bin/bash

get_process_metrics() {
  local pid="$1"
  if [[ -z "$pid" ]]; then
    echo ""
    return
  fi
  # Output: cpu|mem_mb|etime
  local line
  line="$(ps -p "$pid" -o %cpu= -o rss= -o etime= 2>/dev/null | head -1 | tr -s ' ' | sed 's/^ //')"
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  local cpu rss etime
  IFS=' ' read -r cpu rss etime <<<"$line"
  local mem_mb
  mem_mb="$(awk -v rss="$rss" 'BEGIN { printf "%.0f", (rss/1024.0) }')"
  echo "$cpu|$mem_mb|$etime"
}

get_port_listener_pid() {
  local port="$1"
  if [[ -z "$port" ]]; then
    echo ""
    return
  fi
  if ! command -v lsof >/dev/null 2>&1; then
    echo ""
    return
  fi
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

# Cached launchctl output for speed across many stacks.
LAUNCHCTL_LIST_CACHE=""

resolve_daemon_state_helper_module() {
  local repo_root="${HAPPIER_STACK_CLI_ROOT_DIR:-}"
  if [[ -z "$repo_root" ]]; then
    repo_root="${HAPPIER_STACK_REPO_DIR:-}"
  fi
  if [[ -z "$repo_root" ]] && [[ -n "${HAPPIER_STACK_ENV_FILE:-}" ]] && [[ -f "${HAPPIER_STACK_ENV_FILE:-}" ]]; then
    repo_root="$(dotenv_get "${HAPPIER_STACK_ENV_FILE:-}" "HAPPIER_STACK_REPO_DIR")"
  fi

  local install_root
  install_root="$(resolve_hstack_root_dir)"

  local helper=""
  local candidates=()
  if [[ -n "$repo_root" ]]; then
    candidates+=("$repo_root/apps/stack/scripts/utils/auth/credentials_paths.mjs")
    candidates+=("$repo_root/scripts/utils/auth/credentials_paths.mjs")
  fi
  if [[ -n "$install_root" ]]; then
    candidates+=("$install_root/scripts/utils/auth/credentials_paths.mjs")
    candidates+=("$install_root/runtime/node_modules/@happier-dev/stack/scripts/utils/auth/credentials_paths.mjs")
    candidates+=("$install_root/node_modules/@happier-dev/stack/scripts/utils/auth/credentials_paths.mjs")
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      helper="$candidate"
      break
    fi
  done

  [[ -n "$helper" ]] || return
  echo "$helper"
}

resolve_preferred_daemon_state_pair() {
  local cli_home_dir="$1"
  if [[ -z "$cli_home_dir" ]]; then
    return
  fi

  local node_bin
  node_bin="$(resolve_node_bin)"
  if [[ -z "$node_bin" ]] || [[ ! -x "$node_bin" ]]; then
    echo "$cli_home_dir/daemon.state.json|$cli_home_dir/daemon.state.json.lock"
    return
  fi

  local helper
  helper="$(resolve_daemon_state_helper_module)"
  if [[ ! -f "$helper" ]]; then
    echo "$cli_home_dir/daemon.state.json|$cli_home_dir/daemon.state.json.lock"
    return
  fi

  local resolved
  resolved="$("$node_bin" --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const helperUrl = pathToFileURL(process.argv[1]).href;
    const { resolvePreferredStackDaemonStatePaths } = await import(helperUrl);
    const out = resolvePreferredStackDaemonStatePaths({ cliHomeDir: process.argv[2], env: process.env });
    process.stdout.write(`${out.statePath}|${out.lockPath}`);
  ' "$helper" "$cli_home_dir" 2>/dev/null || true)"
  if [[ -n "$resolved" ]]; then
    echo "$resolved"
    return
  fi

  echo "$cli_home_dir/daemon.state.json|$cli_home_dir/daemon.state.json.lock"
}

ensure_launchctl_cache() {
  if [[ -n "$LAUNCHCTL_LIST_CACHE" ]]; then
    return
  fi
  if command -v launchctl >/dev/null 2>&1; then
    local t0 t1
    t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"
    LAUNCHCTL_LIST_CACHE="$(launchctl list 2>/dev/null || true)"
    t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
    swiftbar_profile_log "time" "label=launchctl_list" "ms=$((t1 - t0))"
  fi
}

check_launchagent_status() {
  local label="${1:-com.happier.stacks}"
  local plist="${2:-$HOME/Library/LaunchAgents/${label}.plist}"
  if [[ ! -f "$plist" ]]; then
    echo "not_installed"
    return
  fi

  ensure_launchctl_cache
  # Match the label column exactly (avoid substring false positives).
  if echo "$LAUNCHCTL_LIST_CACHE" | awk -v lbl="$label" '$3==lbl{found=1} END{exit found?0:1}'; then
    echo "loaded"
    return
  fi
  echo "unloaded"
}

launchagent_pid_for_label() {
  local label="$1"
  if [[ -z "$label" ]]; then
    return
  fi
  ensure_launchctl_cache
  if [[ -z "$LAUNCHCTL_LIST_CACHE" ]]; then
    return
  fi
  local pid
  pid="$(echo "$LAUNCHCTL_LIST_CACHE" | awk -v lbl="$label" '$3==lbl{print $1}' | head -1)"
  if [[ "$pid" == "-" ]]; then
    return
  fi
  echo "$pid"
}

check_server_health() {
  local port="$1"
  if [[ -z "$port" ]]; then
    echo "stopped"
    return
  fi
  local response
  # Tight timeouts to keep menus snappy even with many stacks.
  local t0 t1
  t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  response="$(curl -s --connect-timeout 0.2 --max-time 0.6 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  swiftbar_profile_log "time" "label=curl_health" "port=${port}" "ms=$((t1 - t0))" "bytes=${#response}"
  if [[ "$response" == *"ok"* ]] || [[ "$response" == *"Welcome"* ]]; then
    echo "running"
    return
  fi
  echo "stopped"
}

check_daemon_status() {
  local cli_home_dir="$1"
  local resolved state_file lock_file
  resolved="$(resolve_preferred_daemon_state_pair "$cli_home_dir")"
  state_file="${resolved%%|*}"
  lock_file="${resolved#*|}"
  local t0 t1
  t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  if [[ -z "$cli_home_dir" ]] || [[ ! -f "$state_file" ]]; then
    # If the daemon is starting but hasn't written daemon.state.json yet, we can still detect it
    # via the lock file PID.
    if [[ -f "$lock_file" ]]; then
      local lock_pid
      lock_pid="$(cat "$lock_file" 2>/dev/null | tr -d '[:space:]')"
      if [[ -n "$lock_pid" ]] && [[ "$lock_pid" =~ ^[0-9]+$ ]]; then
        if kill -0 "$lock_pid" 2>/dev/null; then
          # Best-effort: classify "auth required" by inspecting the latest daemon log.
          local latest_log
          latest_log="$(ls -1t "$cli_home_dir"/logs/*-daemon.log 2>/dev/null | head -1 || true)"
          if [[ -n "$latest_log" ]]; then
            if tail -n 120 "$latest_log" 2>/dev/null | grep -Eq "No credentials found|starting authentication flow|Waiting for credentials"; then
              echo "auth_required:$lock_pid"
              return
            fi
          fi
          echo "starting:$lock_pid"
          return
        fi
        echo "stale"
        return
      fi
    fi

    echo "stopped"
    return
  fi

  local node_bin
  node_bin="$(resolve_node_bin)"
  if [[ -z "$node_bin" ]] || [[ ! -x "$node_bin" ]]; then
    echo "unknown"
    return
  fi

  local pid httpPort
  pid="$("$node_bin" -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(s.pid ?? ""));' "$state_file" 2>/dev/null || true)"
  httpPort="$("$node_bin" -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(s.httpPort ?? ""));' "$state_file" 2>/dev/null || true)"

  if [[ -z "$pid" ]] || ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "unknown"
    return
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "stale"
    return
  fi

  # Best-effort: confirm the control server is responding (tight timeouts).
  if [[ -n "$httpPort" ]] && [[ "$httpPort" =~ ^[0-9]+$ ]]; then
    if curl -s --connect-timeout 0.2 --max-time 0.5 -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:${httpPort}/list" >/dev/null 2>&1; then
      t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
      swiftbar_profile_log "time" "label=daemon_status" "ms=$((t1 - t0))" "httpProbe=ok"
      echo "running:$pid"
      return
    fi
    t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
    swiftbar_profile_log "time" "label=daemon_status" "ms=$((t1 - t0))" "httpProbe=fail"
    echo "running-no-http:$pid"
    return
  fi

  t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  swiftbar_profile_log "time" "label=daemon_status" "ms=$((t1 - t0))" "httpProbe=skip"
  echo "running:$pid"
}

get_daemon_uptime() {
  local cli_home_dir="$1"
  local resolved state_file
  resolved="$(resolve_preferred_daemon_state_pair "$cli_home_dir")"
  state_file="${resolved%%|*}"
  if [[ -z "$cli_home_dir" ]] || [[ ! -f "$state_file" ]]; then
    return
  fi
  local node_bin
  node_bin="$(resolve_node_bin)"
  if [[ -z "$node_bin" ]] || [[ ! -x "$node_bin" ]]; then
    return
  fi
  "$node_bin" -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (s.startTime) process.stdout.write(String(s.startTime));' "$state_file" 2>/dev/null || true
}

get_last_heartbeat() {
  local cli_home_dir="$1"
  local resolved state_file
  resolved="$(resolve_preferred_daemon_state_pair "$cli_home_dir")"
  state_file="${resolved%%|*}"
  if [[ -z "$cli_home_dir" ]] || [[ ! -f "$state_file" ]]; then
    return
  fi
  local node_bin
  node_bin="$(resolve_node_bin)"
  if [[ -z "$node_bin" ]] || [[ ! -x "$node_bin" ]]; then
    return
  fi
  "$node_bin" -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (s.lastHeartbeat) process.stdout.write(String(s.lastHeartbeat));' "$state_file" 2>/dev/null || true
}

get_tailscale_url() {
  # Try multiple methods to get the Tailscale URL (best-effort).
  local url=""

  # Preferred: use hstack (respects our own timeouts/env handling).
  local hstack_sh="$hstack_ROOT_DIR/extras/swiftbar/hstack.sh"
  if [[ -x "$hstack_sh" ]]; then
    # Keep SwiftBar responsive: use a tight timeout for this periodic probe.
    local t0 t1
    t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"
    url="$("$hstack_sh" tailscale:url --timeout-ms=2500 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
    t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
    swiftbar_profile_log "time" "label=tailscale_url_hstack" "ms=$((t1 - t0))" "ok=$([[ "$url" == https://* ]] && echo 1 || echo 0)"
    if [[ "$url" == https://* ]]; then
      echo "$url"
      return
    fi
    url=""
  fi

  if command -v tailscale &>/dev/null; then
    local t0 t1
    t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"
    url="$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 || true)"
    t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
    swiftbar_profile_log "time" "label=tailscale_url_cli" "ms=$((t1 - t0))" "ok=$([[ -n "$url" ]] && echo 1 || echo 0)"
  fi
  if [[ -z "$url" ]] && [[ -x "/Applications/Tailscale.app/Contents/MacOS/tailscale" ]]; then
    url="$(/Applications/Tailscale.app/Contents/MacOS/tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 || true)"
  fi
  if [[ -z "$url" ]] && [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
    url="$(/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 || true)"
  fi

  echo "$url"
}
