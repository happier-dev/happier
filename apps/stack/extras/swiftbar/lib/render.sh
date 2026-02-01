#!/bin/bash

# Requires:
# - utils.sh
# - icons.sh
# - system.sh

# This file is sourced/executed under strict bash modes in some contexts.
# Ensure these env vars are always defined to avoid `set -u` crashes in tests.
hstack_BIN="${hstack_BIN:-}"
hstack_TERM="${hstack_TERM:-$hstack_BIN}"
hstack_ROOT_DIR="${hstack_ROOT_DIR:-}"

level_from_server_daemon() {
  local server_status="$1"
  local daemon_status="$2"
  if [[ "$server_status" == "running" && "$daemon_status" == "running" ]]; then
    echo "green"
    return
  fi
  if [[ "$server_status" == "running" || "$daemon_status" == "running" ]]; then
    echo "orange"
    return
  fi
  echo "red"
}

color_for_level() {
  local level="$1"
  if [[ "$level" == "green" ]]; then echo "#16a34a"; return; fi
  if [[ "$level" == "orange" ]]; then echo "#f59e0b"; return; fi
  echo "#e74c3c"
}

sfconfig_for_level() {
  local level="$1"
  local color="$(color_for_level "$level")"
  # sfconfig	SFSymbol configuration	Configures Rendering Mode for sfimage. Accepts a json encoded as base64, example json {"renderingMode":"Palette", "colors":["red","blue"], "scale": "large", "weight": "bold"}. Original issue #354
  echo "{\"colors\":[\"$color\"], \"scale\": \"small\"}" | base64 -b 0
}

sf_for_level() {
  local level="$1"
  if [[ "$level" == "green" ]]; then echo "checkmark.circle.fill"; return; fi
  if [[ "$level" == "orange" ]]; then echo "exclamationmark.triangle.fill"; return; fi
  echo "xmark.circle.fill"
}

sf_suffix_for_level() {
  local level="$1"
  if [[ "$level" == "green" ]]; then echo "badge.checkmark"; return; fi
  if [[ "$level" == "orange" ]]; then echo "trianglebadge.exclamationmark"; return; fi
  echo "badge.xmark"
}

print_item() {
  local prefix="$1"
  shift
  echo "${prefix}$*"
}

print_sep() {
  local prefix="$1"
  print_item "$prefix" "---"
}

render_component_server() {
  local prefix="$1"         # "" for top-level, "--" for stack submenu
  local stack_name="$2"     # main | <name>
  local port="$3"
  local server_component="$4"
  local server_status="$5"
  local server_pid="$6"
  local server_metrics="$7"
  local tailscale_url="$8"  # main only (optional)
  local launch_label="${9:-}" # optional (com.happy.stacks[.<stack>])

  local level="red"
  [[ "$server_status" == "running" ]] && level="green"

  local label="Server (${server_component})"
  local sf="$(sf_for_level "$level")"
  local sfconfig="$(sfconfig_for_level "$level")"
  print_item "$prefix" "$label | sfimage=$sf sfconfig=$sfconfig"

  local p2="${prefix}--"
  print_item "$p2" "Status: $server_status"
  if [[ -n "$port" ]]; then
    print_item "$p2" "Internal: http://127.0.0.1:${port}"
  else
    print_item "$p2" "Port: ephemeral (allocated at start time)"
  fi
  if [[ -n "$server_pid" ]]; then
    if [[ -n "$server_metrics" ]]; then
      local cpu mem etime
      cpu="$(echo "$server_metrics" | cut -d'|' -f1)"
      mem="$(echo "$server_metrics" | cut -d'|' -f2)"
      etime="$(echo "$server_metrics" | cut -d'|' -f3)"
      print_item "$p2" "PID: ${server_pid}, CPU: ${cpu}%, RAM: ${mem}MB, Uptime: ${etime}"
    else
      print_item "$p2" "PID: ${server_pid}"
    fi
  fi
  if [[ -n "$port" ]]; then
    print_item "$p2" "Open UI (local) | href=http://localhost:${port}/"
    print_item "$p2" "Open Health | href=http://127.0.0.1:${port}/health"
  fi
  if [[ -n "$tailscale_url" ]]; then
    print_item "$p2" "Open UI (Tailscale) | href=$tailscale_url"
  fi

  # Start/stop shortcuts (so you can control from the Server submenu too).
  if [[ -n "$hstack_BIN" ]]; then
    local plist=""
    local svc_installed="0"
    if ! swiftbar_is_sandboxed; then
      if [[ -n "$launch_label" ]]; then
        plist="$HOME/Library/LaunchAgents/${launch_label}.plist"
        [[ -f "$plist" ]] && svc_installed="1"
      fi
    fi

    print_sep "$p2"
    if [[ "$stack_name" == "main" ]]; then
      if [[ "$svc_installed" == "1" ]]; then
        if [[ "$server_status" == "running" ]]; then
          print_item "$p2" "Stop stack (service) | bash=$hstack_BIN param1=service:stop dir=$hstack_ROOT_DIR terminal=false refresh=true"
        else
          print_item "$p2" "Start stack (service) | bash=$hstack_BIN param1=service:start dir=$hstack_ROOT_DIR terminal=false refresh=true"
        fi
        print_item "$p2" "Restart stack (service) | bash=$hstack_BIN param1=service:restart dir=$hstack_ROOT_DIR terminal=false refresh=true"
      else
        if [[ "$server_status" == "running" ]]; then
          print_item "$p2" "Stop stack | bash=$hstack_BIN param1=stack param2=stop param3=main dir=$hstack_ROOT_DIR terminal=false refresh=true"
        else
          print_item "$p2" "Start stack (foreground) | bash=$hstack_TERM param1=start dir=$hstack_ROOT_DIR terminal=false refresh=true"
        fi
      fi
    else
      if [[ "$svc_installed" == "1" ]]; then
        if [[ "$server_status" == "running" ]]; then
          print_item "$p2" "Stop stack (service) | bash=$hstack_BIN param1=stack param2=service:stop param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
        else
          print_item "$p2" "Start stack (service) | bash=$hstack_BIN param1=stack param2=service:start param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
        fi
        print_item "$p2" "Restart stack (service) | bash=$hstack_BIN param1=stack param2=service:restart param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
      else
        if [[ "$server_status" == "running" ]]; then
          print_item "$p2" "Stop stack | bash=$hstack_BIN param1=stack param2=stop param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
        else
          print_item "$p2" "Start stack (foreground) | bash=$hstack_TERM param1=stack param2=start param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
        fi
      fi
    fi
  fi

  # Flavor switching (status-aware: only show switching to the other option).
  local helper="$hstack_ROOT_DIR/extras/swiftbar/set-server-flavor.sh"
  if [[ -n "$hstack_BIN" ]]; then
    print_sep "$p2"
    if [[ "$server_component" == "happy-server" ]]; then
      print_item "$p2" "Switch to happy-server-light (restart if service installed) | bash=$helper param1=$stack_name param2=happy-server-light dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p2" "Switch to happy-server (restart if service installed) | bash=$helper param1=$stack_name param2=happy-server dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
    if [[ "$stack_name" == "main" ]]; then
      print_item "$p2" "Show flavor status | bash=$hstack_TERM param1=srv param2=-- param3=status dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p2" "Show flavor status | bash=$hstack_TERM param1=stack param2=srv param3=$stack_name param4=-- param5=status dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
  fi
}

render_component_daemon() {
  local prefix="$1"
  local daemon_status="$2"   # running|stale|stopped|unknown|running-no-http|auth_required|starting
  local daemon_pid="$3"
  local daemon_metrics="$4"
  local daemon_uptime="$5"
  local last_heartbeat="$6"
  local state_file="$7"
  local stack_name="$8"

  local level="red"
  if [[ "$daemon_status" == "running" ]]; then level="green"; fi
  if [[ "$daemon_status" == "running-no-http" || "$daemon_status" == "stale" || "$daemon_status" == "auth_required" || "$daemon_status" == "starting" ]]; then level="orange"; fi

  local sfconfig="$(sfconfig_for_level "$level")"

  local sf="$(sf_for_level "$level")"
  print_item "$prefix" "Daemon | sfimage=$sf sfconfig=$sfconfig"

  local p2="${prefix}--"
  print_item "$p2" "Status: $daemon_status"
  if [[ -n "$daemon_pid" ]]; then
    if [[ -n "$daemon_metrics" ]]; then
      local cpu mem etime
      cpu="$(echo "$daemon_metrics" | cut -d'|' -f1)"
      mem="$(echo "$daemon_metrics" | cut -d'|' -f2)"
      etime="$(echo "$daemon_metrics" | cut -d'|' -f3)"
      print_item "$p2" "PID: ${daemon_pid}, CPU: ${cpu}%, RAM: ${mem}MB, Uptime: ${etime}"
    else
      print_item "$p2" "PID: ${daemon_pid}"
    fi
  fi
  [[ -n "$daemon_uptime" ]] && print_item "$p2" "Started: $(shorten_text "$daemon_uptime" 52)"
  [[ -n "$last_heartbeat" ]] && print_item "$p2" "Last heartbeat: $(shorten_text "$last_heartbeat" 52)"
  # State file may not exist yet (e.g. daemon is waiting for auth).
  print_item "$p2" "State file: $(shorten_path "$state_file" 52)"

  if [[ -n "$hstack_BIN" ]]; then
    print_sep "$p2"
    if [[ "$daemon_status" == "auth_required" ]]; then
      # Provide a direct "fix" action for the common first-run problem under launchd.
      local auth_helper="$hstack_ROOT_DIR/extras/swiftbar/auth-login.sh"
      if [[ "$stack_name" == "main" ]]; then
        print_item "$p2" "Auth login (opens browser) | bash=$auth_helper param1=main dir=$hstack_ROOT_DIR terminal=false refresh=false"
      else
        # For stacks, best-effort use the stack's configured port if available (fallback to main port).
        local env_file
        env_file="$(resolve_stack_env_file "$stack_name")"
        local port
        port="$(dotenv_get "$env_file" "HAPPIER_STACK_SERVER_PORT")"
        [[ -z "$port" ]] && port="$(resolve_main_port)"
        print_item "$p2" "Auth login (opens browser) | bash=$auth_helper param1=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=false"
      fi
      print_sep "$p2"
    fi

    print_item "$p2" "Restart daemon | bash=$hstack_BIN param1=stack param2=daemon param3=$stack_name param4=restart dir=$hstack_ROOT_DIR terminal=false refresh=true"
    print_item "$p2" "Show daemon status (CLI) | bash=$hstack_TERM param1=stack param2=daemon param3=$stack_name param4=status dir=$hstack_ROOT_DIR terminal=false refresh=true"

    if ! swiftbar_is_sandboxed; then
      if [[ "$stack_name" == "main" ]]; then
        print_item "$p2" "Restart stack (service) | bash=$hstack_BIN param1=service:restart dir=$hstack_ROOT_DIR terminal=false refresh=true"
      else
        print_item "$p2" "Restart stack (service) | bash=$hstack_BIN param1=stack param2=service:restart param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
      fi
    fi
  fi
}

render_component_autostart() {
  local prefix="$1"
  local stack_name="$2"
  local label="$3"
  local launchagent_status="$4"  # loaded|unloaded|not_installed
  local autostart_pid="$5"
  local autostart_metrics="$6"
  local logs_dir="$7"

  if swiftbar_is_sandboxed; then
    print_item "$prefix" "Autostart | sfimage=exclamationmark.triangle sfconfig=light"
    local p2="${prefix}--"
    print_item "$p2" "Status: disabled in sandbox"
    return
  fi

  local level="red"
  if [[ "$launchagent_status" == "loaded" ]]; then level="green"; fi
  if [[ "$launchagent_status" == "unloaded" ]]; then level="orange"; fi

  local sf="$(sf_for_level "$level")"
  local sfconfig="$(sfconfig_for_level "$level")"
  print_item "$prefix" "Autostart | sfimage=$sf sfconfig=$sfconfig"

  local p2="${prefix}--"
  print_item "$p2" "Status: $launchagent_status"
  print_item "$p2" "Plist: $(shorten_path "$HOME/Library/LaunchAgents/${label}.plist" 52)"
  if [[ -n "$autostart_pid" ]]; then
    if [[ -n "$autostart_metrics" ]]; then
      local cpu mem etime
      cpu="$(echo "$autostart_metrics" | cut -d'|' -f1)"
      mem="$(echo "$autostart_metrics" | cut -d'|' -f2)"
      etime="$(echo "$autostart_metrics" | cut -d'|' -f3)"
      print_item "$p2" "PID: ${autostart_pid}, CPU: ${cpu}%, RAM: ${mem}MB, Uptime: ${etime}"
    else
      print_item "$p2" "PID: ${autostart_pid}"
    fi
  fi
  local stdout_file="hstack.out.log"
  local stderr_file="hstack.err.log"
  print_item "$p2" "Open logs (stdout) | bash=/usr/bin/open param1=-a param2=Console param3='${logs_dir}/${stdout_file}' terminal=false"
  print_item "$p2" "Open logs (stderr) | bash=/usr/bin/open param1=-a param2=Console param3='${logs_dir}/${stderr_file}' terminal=false"

  if [[ -z "$hstack_BIN" ]]; then
    return
  fi
  print_sep "$p2"
  if [[ "$stack_name" == "main" ]]; then
    if [[ "$launchagent_status" == "not_installed" ]]; then
      print_item "$p2" "Install Autostart | bash=$hstack_BIN param1=service:install dir=$hstack_ROOT_DIR terminal=false refresh=true"
      return
    fi
    # Status-aware: show only the relevant toggle (enable vs disable).
    if [[ "$launchagent_status" == "loaded" ]]; then
      print_item "$p2" "Disable Autostart | bash=$hstack_BIN param1=service:disable dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p2" "Enable Autostart | bash=$hstack_BIN param1=service:enable dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
    print_item "$p2" "Uninstall Autostart | bash=$hstack_BIN param1=service:uninstall dir=$hstack_ROOT_DIR terminal=false refresh=true"
    return
  fi

  if [[ "$launchagent_status" == "not_installed" ]]; then
    print_item "$p2" "Install Autostart | bash=$hstack_BIN param1=stack param2=service:install param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
    return
  fi
  # Status-aware: show only the relevant toggle (enable vs disable).
  if [[ "$launchagent_status" == "loaded" ]]; then
    print_item "$p2" "Disable Autostart | bash=$hstack_BIN param1=stack param2=service:disable param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  else
    print_item "$p2" "Enable Autostart | bash=$hstack_BIN param1=stack param2=service:enable param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  fi
  print_item "$p2" "Uninstall Autostart | bash=$hstack_BIN param1=stack param2=service:uninstall param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
}

render_component_tailscale() {
  local prefix="$1"
  local stack_name="$2"
  local tailscale_url="$3"

  local level="red"
  [[ -n "$tailscale_url" ]] && level="green"

  local sf="$(sf_for_level "$level")"
  local sfconfig="$(sfconfig_for_level "$level")"
  print_item "$prefix" "Tailscale | sfimage=$sf sfconfig=$sfconfig"

  local p2="${prefix}--"
  if [[ -n "$tailscale_url" ]]; then
    local display="$tailscale_url"
    [[ ${#display} -gt 48 ]] && display="${display:0:48}..."
    print_item "$p2" "URL: $display"
    print_item "$p2" "Copy URL | bash=/bin/bash param1=-c param2='echo -n \"$tailscale_url\" | pbcopy' terminal=false"
    print_item "$p2" "Open URL | href=$tailscale_url"
  else
    print_item "$p2" "Status: not configured / unknown"
  fi

  # Tailscale Serve is global machine state; never offer enable/disable actions in sandbox mode.
  if swiftbar_is_sandboxed; then
    return
  fi

  if [[ -z "$hstack_BIN" ]]; then
    return
  fi
  print_sep "$p2"

  if [[ "$stack_name" == "main" ]]; then
    print_item "$p2" "Tailscale status | bash=$hstack_TERM param1=tailscale:status dir=$hstack_ROOT_DIR terminal=false refresh=true"
    if [[ -n "$tailscale_url" ]]; then
      print_item "$p2" "Disable Tailscale Serve | bash=$hstack_BIN param1=tailscale:disable dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p2" "Enable Tailscale Serve | bash=$hstack_TERM param1=tailscale:enable dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
    print_item "$p2" "Print URL | bash=$hstack_TERM param1=tailscale:url dir=$hstack_ROOT_DIR terminal=false refresh=true"
    return
  fi

  print_item "$p2" "Tailscale status | bash=$hstack_TERM param1=stack param2=tailscale:status param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  if [[ -n "$tailscale_url" ]]; then
    print_item "$p2" "Disable Tailscale Serve | bash=$hstack_BIN param1=stack param2=tailscale:disable param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  else
    print_item "$p2" "Enable Tailscale Serve | bash=$hstack_TERM param1=stack param2=tailscale:enable param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  fi
  print_item "$p2" "Print URL | bash=$hstack_TERM param1=stack param2=tailscale:url param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
}

render_component_repo() {
  # Git/worktree component view (unified UI).
  # Usage:
  #   render_component_repo <prefix> <component> <context> <stack_name> <env_file> <shared_repo_root?>
  # context: main|stack
  local prefix="$1"
  local component="$2"
  local context="$3"
  local stack_name="$4"
  local env_file="$5"
  local shared_repo_root="${6:-}"

  local t0 t1
  t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"

  local active_dir=""
  # If we have an env file for the current context, prefer it (stack env is authoritative).
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    active_dir="$(resolve_component_dir_from_env_file "$env_file" "$component")"
  else
    active_dir="$(resolve_component_dir_from_env "$component")"
  fi

  local level="red"
  local detail="missing"

  local git_mode
  git_mode="$(git_cache_mode)"

  local stale="0"
  local meta="" info="" wts=""
  if [[ "$git_mode" == "cached" ]]; then
    # Never refresh synchronously during menu render.
    IFS=$'\t' read -r meta info wts stale <<<"$(git_cache_load_or_refresh "$context" "$stack_name" "$component" "$active_dir" "0")"
  fi

  local status="missing"
  local dirty="" ahead="" behind="" wt_count=""
  local branch="" head="" upstream=""
  local main_branch="" main_upstream="" main_ahead="" main_behind=""
  local oref="" o_ahead="" o_behind="" uref="" u_ahead="" u_behind=""

  if [[ "$git_mode" == "cached" && -f "$info" ]]; then
    IFS=$'\t' read -r status _ad branch head upstream dirty ahead behind main_branch main_upstream main_ahead main_behind oref o_ahead o_behind uref u_ahead u_behind wt_count <"$info" || true
  elif [[ "$git_mode" == "live" ]]; then
    # live mode only: do git work on every refresh
    if is_git_repo "$active_dir"; then
      status="ok"
      dirty="$(git_dirty_flag "$active_dir")"
      local ab
      ab="$(git_ahead_behind "$active_dir")"
      if [[ -n "$ab" ]]; then
        ahead="$(echo "$ab" | cut -d'|' -f1)"
        behind="$(echo "$ab" | cut -d'|' -f2)"
      fi
    fi
  fi

  if [[ "$status" == "ok" ]]; then
    detail="ok"
    if [[ "$dirty" == "dirty" ]] || [[ -n "$behind" && "$behind" != "0" ]]; then
      level="orange"
    else
      level="green"
    fi
  fi

  t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  swiftbar_profile_log "time" "label=render_component_repo" "component=${component}" "context=${context}" "ms=$((t1 - t0))" "detail=${detail}"

  local sf color
  sf="$(sf_for_level "$level")"
  color="$(color_for_level "$level")"
  print_item "$prefix" "${component} | sfimage=$sf color=$color"

  local p2="${prefix}--"
  local repo_root=""
  local rel_dir=""
  repo_root="$(swiftbar_find_git_root_upwards "$active_dir" 2>/dev/null || true)"
  local repo_key=""
  repo_key="$(swiftbar_repo_key_from_path "$active_dir" 2>/dev/null || true)"
  [[ -n "$repo_key" ]] || repo_key="$component"
  local mono_repo="0"
  if [[ -n "$shared_repo_root" && -n "$repo_root" && "$shared_repo_root" == "$repo_root" ]]; then
    mono_repo="1"
  fi

  if [[ -n "$repo_root" && "$repo_root" != "$active_dir" && "$active_dir" == "$repo_root/"* ]]; then
    rel_dir="${active_dir#"$repo_root"/}"
    if [[ -n "$shared_repo_root" && "$shared_repo_root" == "$repo_root" ]]; then
      print_item "$p2" "Dir: $(shorten_text "$rel_dir" 52)"
    else
      print_item "$p2" "Repo: $(shorten_path "$repo_root" 52)"
      print_item "$p2" "Dir: $(shorten_text "$rel_dir" 52)"
    fi
  else
    print_item "$p2" "Dir: $(shorten_path "$active_dir" 52)"
    repo_root=""
    rel_dir=""
  fi
  if [[ "$detail" != "ok" ]]; then
    if [[ "$git_mode" == "cached" ]]; then
      print_item "$p2" "Status: git cache missing (or not a git repo)"
      local refresh="$hstack_ROOT_DIR/extras/swiftbar/git-cache-refresh.sh"
      if [[ -x "$refresh" ]]; then
        print_sep "$p2"
        if [[ "$context" == "stack" && -n "$stack_name" ]]; then
          print_item "$p2" "Refresh Git cache (this stack) | bash=$refresh param1=stack param2=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
        else
          print_item "$p2" "Refresh Git cache (main) | bash=$refresh param1=main dir=$hstack_ROOT_DIR terminal=false refresh=true"
        fi
      fi
    else
      print_item "$p2" "Status: not a git repo / missing"
    fi
    if [[ -n "$hstack_BIN" ]]; then
      print_sep "$p2"
      print_item "$p2" "Bootstrap (clone missing repos) | bash=$hstack_TERM param1=bootstrap dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
    return
  fi

  # Cache status + refresh actions
  if [[ "$git_mode" == "cached" ]]; then
    local age=""
    age="$(git_cache_age_sec "$meta")"
    if [[ -n "$age" ]]; then
      if [[ "$stale" == "1" ]]; then
        print_item "$p2" "Git cache: stale (${age}s old) | color=$YELLOW"
      else
        print_item "$p2" "Git cache: fresh (${age}s old) | color=$GRAY"
      fi
    fi
    local refresh="$hstack_ROOT_DIR/extras/swiftbar/git-cache-refresh.sh"
    if [[ -x "$refresh" ]]; then
      print_sep "$p2"
      print_item "$p2" "Refresh Git cache (this component) | bash=$refresh param1=component param2=$context param3=$stack_name param4=$component dir=$hstack_ROOT_DIR terminal=false refresh=true"
      if [[ "$context" == "stack" && -n "$stack_name" ]]; then
        print_item "$p2" "Refresh Git cache (this stack) | bash=$refresh param1=stack param2=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
      fi
    fi
  fi

  print_sep "$p2"
  print_item "$p2" "HEAD: ${branch:-"(unknown)"} ${head:+($head)}"
  print_item "$p2" "Upstream: ${upstream:-"(none)"}"
  if [[ -n "$ahead" && -n "$behind" ]]; then
    print_item "$p2" "Ahead/Behind: ${ahead}/${behind}"
  fi
  print_item "$p2" "Working tree: ${dirty}"

  if [[ -n "$main_branch" ]]; then
    if [[ -n "$main_upstream" ]]; then
      print_item "$p2" "Main: ${main_branch} → ${main_upstream}"
    else
      print_item "$p2" "Main: ${main_branch} → (no upstream)"
    fi
    if [[ -n "$main_ahead" && -n "$main_behind" ]]; then
      print_item "$p2" "Main ahead/behind: ${main_ahead}/${main_behind}"
    fi

    # Always show comparisons against origin/* and upstream/* when those remote refs exist.
    # (These reflect your last fetch; we do not auto-fetch in the menu.)
    if [[ -n "$oref" ]]; then
      local oref_short="${oref#refs/remotes/}"
      if [[ -n "$o_ahead" && -n "$o_behind" ]]; then
        print_item "$p2" "Origin: ${oref_short} ahead/behind: ${o_ahead}/${o_behind}"
      else
        print_item "$p2" "Origin: ${oref_short}"
      fi
    else
      print_item "$p2" "Origin: (no origin/main|master ref)"
    fi
    if [[ -n "$uref" ]]; then
      local uref_short="${uref#refs/remotes/}"
      if [[ -n "$u_ahead" && -n "$u_behind" ]]; then
        print_item "$p2" "Upstream: ${uref_short} ahead/behind: ${u_ahead}/${u_behind}"
      else
        print_item "$p2" "Upstream: ${uref_short}"
      fi
    else
      print_item "$p2" "Upstream: (no upstream/main|master ref)"
    fi
  fi

    local wt_count
    # If cache didn't populate wt_count, fall back to empty string.
    wt_count="${wt_count:-}"

  # Quick actions
  print_sep "$p2"
  if [[ -n "$repo_root" ]]; then
    print_item "$p2" "Open package folder | bash=/usr/bin/open param1='$active_dir' terminal=false"
    print_item "$p2" "Open repo root | bash=/usr/bin/open param1='$repo_root' terminal=false"
  else
    print_item "$p2" "Open folder | bash=/usr/bin/open param1='$active_dir' terminal=false"
  fi

  if [[ -n "${hstack_BIN:-}" ]]; then
    # Run via stack wrappers when in a stack context so env-file stays authoritative.
    if [[ "$context" == "stack" && -n "$stack_name" ]]; then
      print_item "$p2" "Status (active) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=status param6=$component dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Sync mirror (upstream/main) | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=sync param6=$component dir=$hstack_ROOT_DIR terminal=false refresh=true"
      print_item "$p2" "Update (dry-run) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=update param6=$component param7=active param8=--dry-run dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Update (apply) | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=update param6=$component param7=active dir=$hstack_ROOT_DIR terminal=false refresh=true"
      print_item "$p2" "Update (apply + stash) | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=update param6=$component param7=active param8=--stash dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p2" "Status (active) | bash=$hstack_TERM param1=wt param2=status param3=$component dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Sync mirror (upstream/main) | bash=$hstack_BIN param1=wt param2=sync param3=$component dir=$hstack_ROOT_DIR terminal=false refresh=true"
      print_item "$p2" "Update (dry-run) | bash=$hstack_TERM param1=wt param2=update param3=$component param4=active param5=--dry-run dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Update (apply) | bash=$hstack_BIN param1=wt param2=update param3=$component param4=active dir=$hstack_ROOT_DIR terminal=false refresh=true"
      print_item "$p2" "Update (apply + stash) | bash=$hstack_BIN param1=wt param2=update param3=$component param4=active param5=--stash dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi

    print_sep "$p2"
    if [[ "$context" == "stack" && -n "$stack_name" ]]; then
      if [[ "$mono_repo" == "1" && "$component" != "happy-server-light" ]]; then
        # Monorepo stacks: avoid per-component worktree switching (it can create version skew/confusion).
        # Prefer selecting a single monorepo worktree (repoKey) and letting hstack derive the rest.
        print_item "$p2" "Select monorepo worktree (interactive) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=use param6=$repo_key param7=--interactive dir=$hstack_ROOT_DIR terminal=false refresh=true"
      else
        print_item "$p2" "Switch stack worktree (interactive) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=use param6=$component param7=--interactive dir=$hstack_ROOT_DIR terminal=false refresh=true"
      fi
      print_item "$p2" "New worktree (interactive) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=new param6=--interactive dir=$hstack_ROOT_DIR terminal=false refresh=true"
      if [[ "$mono_repo" == "1" && "$component" != "happy-server-light" ]]; then
        print_item "$p2" "List worktrees (terminal) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=list param6=$repo_key dir=$hstack_ROOT_DIR terminal=false"
      else
        print_item "$p2" "List worktrees (terminal) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=list param6=$component dir=$hstack_ROOT_DIR terminal=false"
      fi
    else
      print_item "$p2" "Use worktree (interactive) | bash=$hstack_TERM param1=wt param2=use param3=--interactive dir=$hstack_ROOT_DIR terminal=false refresh=true"
      print_item "$p2" "New worktree (interactive) | bash=$hstack_TERM param1=wt param2=new param3=--interactive dir=$hstack_ROOT_DIR terminal=false refresh=true"
      print_item "$p2" "List worktrees (terminal) | bash=$hstack_TERM param1=wt param2=list param3=$component dir=$hstack_ROOT_DIR terminal=false"
    fi

    # PR worktree (prompt)
    local pr_helper="$hstack_ROOT_DIR/extras/swiftbar/wt-pr.sh"
    if [[ -x "$pr_helper" ]]; then
      if [[ "$context" == "stack" && -n "$stack_name" ]]; then
        print_item "$p2" "PR worktree (prompt) | bash=$pr_helper param1=$component param2=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
      else
        print_item "$p2" "PR worktree (prompt) | bash=$pr_helper param1=$component dir=$hstack_ROOT_DIR terminal=false refresh=true"
      fi
    fi

    print_sep "$p2"
    if [[ "$context" == "stack" && -n "$stack_name" ]]; then
      local open_component="$component"
      if [[ "$mono_repo" == "1" && "$component" != "happy-server-light" ]]; then
        open_component="$repo_key"
      fi
      print_item "$p2" "Shell (active, new window) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=shell param6=$open_component param7=active param8=--new-window dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Open in VS Code (active) | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=code param6=$open_component param7=active dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Open in Cursor (active) | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=cursor param6=$open_component param7=active dir=$hstack_ROOT_DIR terminal=false"
    else
      print_item "$p2" "Shell (active, new window) | bash=$hstack_TERM param1=wt param2=shell param3=$component param4=active param5=--new-window dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Open in VS Code (active) | bash=$hstack_BIN param1=wt param2=code param3=$component param4=active dir=$hstack_ROOT_DIR terminal=false"
      print_item "$p2" "Open in Cursor (active) | bash=$hstack_BIN param1=wt param2=cursor param3=$component param4=active dir=$hstack_ROOT_DIR terminal=false"
    fi

    # Worktrees listing (inline in SwiftBar, plus stack-aware switch).
    local wt_label="Worktrees: ${wt_count:-0} | sfimage=arrow.triangle.branch"
    print_item "$p2" "$wt_label"
    local p3="${p2}--"
    local tsv
    if [[ "$git_mode" == "cached" && -f "$wts" ]]; then
      tsv="$(cat "$wts" 2>/dev/null || true)"
    else
      tsv="$(git_worktrees_tsv "$active_dir" 2>/dev/null || true)"
    fi
    if [[ -z "$tsv" ]]; then
      print_item "$p3" "No worktrees found | color=$GRAY"
    else
      # Map worktree paths back to hstack specs (main/dev or workspace/{pr,local,tmp}/...).
      local repo_key
      repo_key="$(swiftbar_repo_key_from_path "$active_dir" 2>/dev/null || true)"
      local root=""
      if [[ -n "$repo_key" ]]; then
        root="$(resolve_workspace_dir)/"
      fi
      local shown=0
      while IFS=$'\t' read -r wt_path wt_branchref; do
        [[ -n "$wt_path" ]] || continue
        shown=$((shown + 1))
        if [[ $shown -gt 30 ]]; then
          if [[ -n "$root" ]]; then
            print_item "$p3" "More… (open folder) | bash=/usr/bin/open param1='$root' terminal=false"
          fi
          break
        fi

        local label=""
        local spec=""
        if [[ -n "$repo_key" ]]; then
          spec="$(swiftbar_worktree_spec_from_path "$wt_path" "$repo_key" 2>/dev/null || true)"
        fi
        if [[ -n "$spec" ]]; then
          label="$spec"
        else
          label="$(shorten_path "$wt_path" 52)"
        fi

        if [[ -n "$wt_branchref" && "$wt_branchref" == refs/heads/* ]]; then
          label="$label ($(basename "$wt_branchref"))"
        fi
        # Active worktree: for monorepo packages, active_dir is under the worktree root.
        local wt_component_dir="$wt_path"
        if [[ -n "$rel_dir" ]]; then
          wt_component_dir="$wt_path/$rel_dir"
        fi
        if [[ "$wt_component_dir" == "$active_dir" ]]; then
          label="(active) $label"
        fi

        print_item "$p3" "$label"

        # Only show "use" actions when we can express the worktree as a spec (main/dev or under pr/local/tmp).
        # Some git worktrees can exist outside our managed tree; for those we only offer open/shell actions.
        if [[ -n "$spec" ]]; then
          if [[ "$context" == "stack" && -n "$stack_name" ]]; then
            local wt_component="$component"
            if [[ "$mono_repo" == "1" && "$component" != "happy-server-light" ]]; then
              wt_component="$repo_key"
            fi
            if [[ "$mono_repo" != "1" || "$component" == "happy-server-light" ]]; then
              print_item "${p3}--" "Use in stack | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=use param6=$wt_component param7=$spec dir=$hstack_ROOT_DIR terminal=false refresh=true"
            fi
            print_item "${p3}--" "Shell (new window) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=shell param6=$wt_component param7=$spec param8=--new-window dir=$hstack_ROOT_DIR terminal=false"
            print_item "${p3}--" "Open in VS Code | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=code param6=$wt_component param7=$spec dir=$hstack_ROOT_DIR terminal=false"
            print_item "${p3}--" "Open in Cursor | bash=$hstack_BIN param1=stack param2=wt param3=$stack_name param4=-- param5=cursor param6=$wt_component param7=$spec dir=$hstack_ROOT_DIR terminal=false"
          else
            print_item "${p3}--" "Use (main) | bash=$hstack_BIN param1=wt param2=use param3=$component param4=$spec dir=$hstack_ROOT_DIR terminal=false refresh=true"
            print_item "${p3}--" "Shell (new window) | bash=$hstack_TERM param1=wt param2=shell param3=$component param4=$spec param5=--new-window dir=$hstack_ROOT_DIR terminal=false"
            print_item "${p3}--" "Open in VS Code | bash=$hstack_BIN param1=wt param2=code param3=$component param4=$spec dir=$hstack_ROOT_DIR terminal=false"
            print_item "${p3}--" "Open in Cursor | bash=$hstack_BIN param1=wt param2=cursor param3=$component param4=$spec dir=$hstack_ROOT_DIR terminal=false"
          fi
        else
          print_item "${p3}--" "Open folder | bash=/usr/bin/open param1='$wt_path' terminal=false"
        fi
      done <<<"$tsv"
    fi
  fi
}

render_components_menu() {
  # Usage: render_components_menu <prefix> <context> <stack_name> <env_file>
  local prefix="$1"   # "" for main menu, "--" for inside a stack
  local context="$2"  # main|stack
  local stack_name="$3"
  local env_file="$4"

  local t0 t1
  t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"

  print_item "$prefix" "Components | sfimage=cube"
  local p2="${prefix}--"

  # Background auto-refresh: keep menu refresh snappy but update git cache when TTL expires.
  if [[ "$(git_cache_mode)" == "cached" ]]; then
    local scope
    scope="$(git_cache_auto_refresh_scope)"
    local refresh="$hstack_ROOT_DIR/extras/swiftbar/git-cache-refresh.sh"
    if [[ -x "$refresh" ]]; then
      if [[ "$scope" == "all" ]]; then
        git_cache_maybe_refresh_async "all" "$refresh" all
      elif [[ "$scope" == "main" && "$context" == "main" ]]; then
        git_cache_maybe_refresh_async "main" "$refresh" main
      fi
    fi
  fi

  # Git cache controls (to keep the menu refresh fast while retaining rich inline worktrees UI).
  local refresh="$hstack_ROOT_DIR/extras/swiftbar/git-cache-refresh.sh"
  if [[ -f "$refresh" ]]; then
    local mode ttl
    mode="$(git_cache_mode)"
    ttl="$(git_cache_ttl_sec)"
    print_item "$p2" "Git cache | sfimage=arrow.triangle.2.circlepath"
    local p3="${p2}--"
    print_item "$p3" "Mode: ${mode} (default: cached)"
    print_item "$p3" "TTL: ${ttl}s (set HAPPIER_STACK_SWIFTBAR_GIT_TTL_SEC)"
    print_sep "$p3"
    if [[ "$context" == "main" ]]; then
      print_item "$p3" "Refresh now (main components) | bash=$refresh param1=main dir=$hstack_ROOT_DIR terminal=false refresh=true"
      print_item "$p3" "Refresh now (all stacks/components) | bash=$refresh param1=all dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p3" "Refresh now (this stack) | bash=$refresh param1=stack param2=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
    print_sep "$p2"
  fi

  # Always render the known components using the resolved component dirs (env file → env.local/.env → fallback),
  # instead of assuming they live under a fixed workspace path.
  local shared_repo_root=""
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    local dir_h dir_c dir_s
    dir_h="$(resolve_component_dir_from_env_file "$env_file" "happy")"
    dir_c="$(resolve_component_dir_from_env_file "$env_file" "happy-cli")"
    dir_s="$(resolve_component_dir_from_env_file "$env_file" "happy-server")"
    local root_h root_c root_s
    root_h="$(swiftbar_find_git_root_upwards "$dir_h" 2>/dev/null || true)"
    root_c="$(swiftbar_find_git_root_upwards "$dir_c" 2>/dev/null || true)"
    root_s="$(swiftbar_find_git_root_upwards "$dir_s" 2>/dev/null || true)"
    if [[ -n "$root_h" && "$root_h" == "$root_c" && "$root_h" == "$root_s" ]]; then
      shared_repo_root="$root_h"
    fi
  fi
  for c in happy happy-cli happy-server-light happy-server; do
    render_component_repo "$p2" "$c" "$context" "$stack_name" "$env_file" "$shared_repo_root"
    print_sep "$p2"
  done

  t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  swiftbar_profile_log "time" "label=render_components_menu" "context=${context}" "stack=${stack_name}" "ms=$((t1 - t0))"
}

render_stack_overview_item() {
  local title="$1"
  local level="$2"  # green|orange|red
  local prefix="$3"

  local icon_b64
  icon_b64="$(status_icon_b64 "$level" 14)"
  if [[ -n "$icon_b64" ]]; then
    print_item "$prefix" "$title | image=$icon_b64"
  else
    print_item "$prefix" "$title"
  fi
}

collect_stack_status() {
  # Output (tab-separated):
  # level server_status server_pid server_metrics daemon_status daemon_pid daemon_metrics daemon_uptime last_heartbeat launchagent_status autostart_pid autostart_metrics
  local port="$1"
  local cli_home_dir="$2"
  local label="$3"
  local base_dir="$4"

  local server_status server_pid server_metrics
  server_status="$(check_server_health "$port")"
  server_pid=""
  server_metrics=""
  if [[ "$server_status" == "running" ]]; then
    server_pid="$(get_port_listener_pid "$port")"
    server_metrics="$(get_process_metrics "$server_pid")"
  fi

  local daemon_raw daemon_status daemon_pid daemon_metrics
  daemon_raw="$(check_daemon_status "$cli_home_dir")"
  daemon_status="$daemon_raw"
  daemon_pid=""
  if [[ "$daemon_raw" == running:* ]] || [[ "$daemon_raw" == running-no-http:* ]]; then
    daemon_pid="${daemon_raw#*:}"
    daemon_status="${daemon_raw%%:*}"
  fi
  daemon_metrics=""
  if [[ -n "$daemon_pid" ]]; then
    daemon_metrics="$(get_process_metrics "$daemon_pid")"
  fi

  local daemon_uptime last_heartbeat
  daemon_uptime="$(get_daemon_uptime "$cli_home_dir")"
  last_heartbeat="$(get_last_heartbeat "$cli_home_dir")"

  local launchagent_status autostart_pid autostart_metrics
  if swiftbar_is_sandboxed; then
    launchagent_status="sandbox_disabled"
    autostart_pid=""
    autostart_metrics=""
  else
    local plist_path="$HOME/Library/LaunchAgents/${label}.plist"
    launchagent_status="$(check_launchagent_status "$label" "$plist_path")"
    autostart_pid=""
    autostart_metrics=""
    if [[ "$launchagent_status" != "not_installed" ]]; then
      autostart_pid="$(launchagent_pid_for_label "$label")"
      autostart_metrics="$(get_process_metrics "$autostart_pid")"
    fi
  fi

  local level
  level="$(level_from_server_daemon "$server_status" "$daemon_status")"

  # Important: callers use `read` with IFS=$'\t' which collapses consecutive delimiters.
  # Emit "-" placeholders for optional/empty fields so parsing stays stable.
  local spid="${server_pid:-"-"}"
  local smet="${server_metrics:-"-"}"
  local dpid="${daemon_pid:-"-"}"
  local dmet="${daemon_metrics:-"-"}"
  local dupt="${daemon_uptime:-"-"}"
  local dhb="${last_heartbeat:-"-"}"
  local apid="${autostart_pid:-"-"}"
  local amet="${autostart_metrics:-"-"}"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$level" \
    "$server_status" "$spid" "$smet" \
    "$daemon_status" "$dpid" "$dmet" "$dupt" "$dhb" \
    "$launchagent_status" "$apid" "$amet"
}

render_stack_info() {
  # Renders a single "Info" item (with actions) at the given prefix.
  local prefix="$1"         # "" or "--"
  local stack_name="$2"
  local port="$3"
  local server_component="$4"
  local base_dir="$5"
  local cli_home_dir="$6"
  local label="$7"
  local env_file="$8"       # optional
  local tailscale_url="$9"  # optional
  local server_metrics="${10:-}"
  local daemon_metrics="${11:-}"
  local autostart_metrics="${12:-}"

  # Avoid low-contrast gray in the main list; keep it readable in both light/dark.
  print_item "$prefix" "Stack details | sfimage=server.rack"
  local p2="${prefix}--"
  print_item "$p2" "Server component: ${server_component}"
  local pinned_port=""
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    pinned_port="$(dotenv_get "$env_file" "HAPPIER_STACK_SERVER_PORT")"
  fi
  local port_display="$port"
  if [[ -z "$port_display" ]]; then
    port_display="ephemeral (not running)"
  elif [[ -z "$pinned_port" ]]; then
    port_display="${port_display} (ephemeral)"
  fi
  print_item "$p2" "Port: ${port_display}"
  print_item "$p2" "Label: ${label}"
  [[ -n "$env_file" ]] && print_item "$p2" "Env: $(shorten_path "$env_file" 52)"
  [[ -n "$tailscale_url" ]] && print_item "$p2" "Tailscale: $(shorten_text "$tailscale_url" 52)"

  # Monorepo hint: if happy + happy-cli + happy-server all share the same git root, show it once here.
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    local dir_h dir_c dir_s
    dir_h="$(resolve_component_dir_from_env_file "$env_file" "happy")"
    dir_c="$(resolve_component_dir_from_env_file "$env_file" "happy-cli")"
    dir_s="$(resolve_component_dir_from_env_file "$env_file" "happy-server")"
    local root_h root_c root_s
    root_h="$(swiftbar_find_git_root_upwards "$dir_h" 2>/dev/null || true)"
    root_c="$(swiftbar_find_git_root_upwards "$dir_c" 2>/dev/null || true)"
    root_s="$(swiftbar_find_git_root_upwards "$dir_s" 2>/dev/null || true)"
    if [[ -n "$root_h" && "$root_h" == "$root_c" && "$root_h" == "$root_s" ]]; then
      print_item "$p2" "Happy monorepo: $(shorten_path "$root_h" 52) | color=$GRAY"
    fi
  fi

  # Aggregate metrics (best-effort): sum the per-component process snapshots.
  # NOTE: CPU may exceed 100% on multi-core machines.
  local totals cpu_total mem_total
  totals="$(swiftbar_sum_metrics_cpu_mem "$server_metrics" "$daemon_metrics" "$autostart_metrics" 2>/dev/null || true)"
  cpu_total="$(echo "$totals" | cut -d'|' -f1)"
  mem_total="$(echo "$totals" | cut -d'|' -f2)"
  if [[ -n "$cpu_total" && -n "$mem_total" ]]; then
    # Only show when we have at least one metric (avoid "0.0|0" noise on stopped stacks).
    if [[ "$cpu_total" != "0.0" || "$mem_total" != "0" ]]; then
      print_item "$p2" "Usage (server+daemon+autostart): CPU ${cpu_total}%, RAM ${mem_total}MB | color=$GRAY"
    fi
  fi

  print_sep "$p2"
  print_item "$p2" "Open repo | bash=/usr/bin/open param1='$hstack_ROOT_DIR' terminal=false"
  print_item "$p2" "Open data dir | bash=/usr/bin/open param1='$base_dir' terminal=false"
  print_item "$p2" "Open logs dir | bash=/usr/bin/open param1='${base_dir}/logs' terminal=false"
  print_item "$p2" "Open CLI home | bash=/usr/bin/open param1='$cli_home_dir' terminal=false"
  if [[ "$stack_name" == "main" ]]; then
    local main_env
    main_env="$(resolve_main_env_file)"
    if [[ -n "$main_env" ]]; then
      print_item "$p2" "Edit main env | bash=/usr/bin/open param1=-a param2=TextEdit param3='$main_env' terminal=false"
    else
      local home
      home="$(resolve_home_dir)"
      print_item "$p2" "Edit env.local | bash=/usr/bin/open param1=-a param2=TextEdit param3='${home}/env.local' terminal=false"
    fi
  else
    print_item "$p2" "Open stack env | bash=/usr/bin/open param1='$env_file' terminal=false"
  fi

  if [[ -z "$hstack_BIN" ]]; then
    return
  fi
  print_sep "$p2"

  local svc_installed="0"
  if ! swiftbar_is_sandboxed; then
    local plist="$HOME/Library/LaunchAgents/${label}.plist"
    [[ -f "$plist" ]] && svc_installed="1"
  fi
  local menu_mode
  menu_mode="$(resolve_menubar_mode)"

  if [[ "$stack_name" == "main" ]]; then
    if [[ "$svc_installed" == "1" ]]; then
      # Status-aware: only show start/stop based on whether the stack is running.
      if [[ "${MAIN_LEVEL:-}" == "red" ]]; then
        print_item "$p2" "Start (service) | bash=$hstack_BIN param1=service:start dir=$hstack_ROOT_DIR terminal=false refresh=true"
      else
        print_item "$p2" "Stop (service) | bash=$hstack_BIN param1=service:stop dir=$hstack_ROOT_DIR terminal=false refresh=true"
      fi
      print_item "$p2" "Restart (service) | bash=$hstack_BIN param1=service:restart dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      if [[ "${MAIN_LEVEL:-}" == "red" ]]; then
        print_item "$p2" "Start (foreground) | bash=$hstack_TERM param1=start dir=$hstack_ROOT_DIR terminal=false refresh=true"
      else
        print_item "$p2" "Stop stack | bash=$hstack_BIN param1=stack param2=stop param3=main dir=$hstack_ROOT_DIR terminal=false refresh=true"
      fi
    fi
    if [[ "$menu_mode" != "selfhost" ]]; then
      print_item "$p2" "Dev mode | bash=$hstack_TERM param1=dev dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
    print_item "$p2" "Build UI | bash=$hstack_TERM param1=build dir=$hstack_ROOT_DIR terminal=false refresh=true"
    print_item "$p2" "Doctor | bash=$hstack_TERM param1=stack:doctor dir=$hstack_ROOT_DIR terminal=false refresh=true"
    return
  fi

  if [[ "$svc_installed" == "1" ]]; then
    # Status-aware: only show start/stop based on whether the stack is running.
    if [[ "$STACK_LEVEL" == "red" ]]; then
      print_item "$p2" "Start (service) | bash=$hstack_BIN param1=stack param2=service:start param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p2" "Stop (service) | bash=$hstack_BIN param1=stack param2=service:stop param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
    print_item "$p2" "Restart (service) | bash=$hstack_BIN param1=stack param2=service:restart param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  else
    if [[ "$STACK_LEVEL" == "red" ]]; then
      print_item "$p2" "Start (foreground) | bash=$hstack_TERM param1=stack param2=start param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
    else
      print_item "$p2" "Stop stack | bash=$hstack_BIN param1=stack param2=stop param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
    fi
  fi
  if [[ "$menu_mode" != "selfhost" ]]; then
    print_item "$p2" "Dev mode | bash=$hstack_TERM param1=stack param2=dev param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  fi
  print_item "$p2" "Build UI | bash=$hstack_TERM param1=stack param2=build param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  print_item "$p2" "Doctor | bash=$hstack_TERM param1=stack param2=doctor param3=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  if [[ "$menu_mode" != "selfhost" ]]; then
    print_item "$p2" "Edit stack (interactive) | bash=$hstack_TERM param1=stack param2=edit param3=$stack_name param4=--interactive dir=$hstack_ROOT_DIR terminal=false refresh=true"
    print_item "$p2" "Select worktrees (interactive) | bash=$hstack_TERM param1=stack param2=wt param3=$stack_name param4=-- param5=use param6=--interactive dir=$hstack_ROOT_DIR terminal=false refresh=true"
  fi

  local pr_helper="$hstack_ROOT_DIR/extras/swiftbar/wt-pr.sh"
  if [[ "$menu_mode" != "selfhost" && -x "$pr_helper" ]]; then
    print_item "$p2" "PR worktree into this stack (prompt) | bash=$pr_helper param1=_prompt_ param2=$stack_name dir=$hstack_ROOT_DIR terminal=false refresh=true"
  fi
}
