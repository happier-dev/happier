#!/bin/bash

# <xbar.title>Happy Stacks</xbar.title>
# <xbar.version>1.0.0</xbar.version>
# <xbar.author>Happy Stacks</xbar.author>
# <xbar.author.github>happier-dev</xbar.author.github>
# <xbar.desc>Monitor and control your Happy stacks from the menu bar</xbar.desc>
# <xbar.dependencies>node</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>false</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
# <swiftbar.refreshOnOpen>false</swiftbar.refreshOnOpen>

# ============================================================================
# Configuration
# ============================================================================

# SwiftBar runs with a minimal environment, so users often won't have
# HAPPY_STACKS_HOME_DIR / HAPPY_STACKS_WORKSPACE_DIR exported.
# Treat <canonicalHomeDir>/.env as the canonical pointer file (written by `happys init`).
# Default: ~/.happy-stacks/.env
CANONICAL_HOME_DIR="${HAPPY_STACKS_CANONICAL_HOME_DIR:-${HAPPY_LOCAL_CANONICAL_HOME_DIR:-$HOME/.happy-stacks}}"
CANONICAL_ENV_FILE="$CANONICAL_HOME_DIR/.env"

_dotenv_get_quick() {
  # Usage: _dotenv_get_quick /path/to/env KEY
  local file="$1"
  local key="$2"
  [[ -n "$file" && -n "$key" && -f "$file" ]] || return 0
  local line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | head -n 1 || true)"
  [[ -n "$line" ]] || return 0
  local v="${line#*=}"
  v="${v%$'\r'}"
  # Strip simple surrounding quotes.
  if [[ "$v" == \"*\" && "$v" == *\" ]]; then v="${v#\"}"; v="${v%\"}"; fi
  if [[ "$v" == \'*\' && "$v" == *\' ]]; then v="${v#\'}"; v="${v%\'}"; fi
  echo "$v"
}

_expand_home_quick() {
  local p="$1"
  if [[ "$p" == "~/"* ]]; then
    echo "$HOME/${p#~/}"
  else
    echo "$p"
  fi
}

_home_from_canonical=""
if [[ -f "$CANONICAL_ENV_FILE" ]]; then
  _home_from_canonical="$(_dotenv_get_quick "$CANONICAL_ENV_FILE" "HAPPY_STACKS_HOME_DIR")"
  [[ -z "$_home_from_canonical" ]] && _home_from_canonical="$(_dotenv_get_quick "$CANONICAL_ENV_FILE" "HAPPY_LOCAL_HOME_DIR")"
fi
_home_from_canonical="$(_expand_home_quick "${_home_from_canonical:-}")"

HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-${_home_from_canonical:-$CANONICAL_HOME_DIR}}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HAPPY_STACKS_HOME_DIR}"
HAPPY_LOCAL_PORT="${HAPPY_LOCAL_PORT:-3005}"

# Map common preferences from HAPPY_STACKS_* -> HAPPY_LOCAL_* (SwiftBar scripts are shell-based).
if [[ -n "${HAPPY_STACKS_WT_TERMINAL:-}" && -z "${HAPPY_LOCAL_WT_TERMINAL:-}" ]]; then HAPPY_LOCAL_WT_TERMINAL="$HAPPY_STACKS_WT_TERMINAL"; fi
if [[ -n "${HAPPY_STACKS_WT_SHELL:-}" && -z "${HAPPY_LOCAL_WT_SHELL:-}" ]]; then HAPPY_LOCAL_WT_SHELL="$HAPPY_STACKS_WT_SHELL"; fi
if [[ -n "${HAPPY_STACKS_SWIFTBAR_ICON_PATH:-}" && -z "${HAPPY_LOCAL_SWIFTBAR_ICON_PATH:-}" ]]; then HAPPY_LOCAL_SWIFTBAR_ICON_PATH="$HAPPY_STACKS_SWIFTBAR_ICON_PATH"; fi

# Colors
GREEN="#34C759"
RED="#FF3B30"
YELLOW="#FFCC00"
GRAY="#8E8E93"
BLUE="#007AFF"

# ============================================================================
# Load libs
# ============================================================================

LIB_DIR="$HAPPY_LOCAL_DIR/extras/swiftbar/lib"
if [[ ! -f "$LIB_DIR/utils.sh" ]]; then
  echo "Happy Stacks"
  echo "---"
  echo "SwiftBar libs missing at: $LIB_DIR"
  echo "↪ run: happys menubar install"
  exit 0
fi

# shellcheck source=/dev/null
source "$LIB_DIR/utils.sh"
HAPPY_LOCAL_DIR="$(resolve_happy_local_dir)"
LIB_DIR="$HAPPY_LOCAL_DIR/extras/swiftbar/lib"
# shellcheck source=/dev/null
source "$LIB_DIR/icons.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/system.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/git.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/render.sh"

# ============================================================================
# Menu
# ============================================================================

PNPM_BIN="$(resolve_pnpm_bin)"
MAIN_PORT="$(resolve_main_port)"
MAIN_SERVER_COMPONENT="$(resolve_main_server_component)"
TAILSCALE_URL="$(get_tailscale_url)"
if swiftbar_is_sandboxed; then
  # Never probe Tailscale (global machine state) when sandboxing.
  TAILSCALE_URL=""
fi
MAIN_ENV_FILE="$(resolve_main_env_file)"
MENUBAR_MODE="$(resolve_menubar_mode)"

ensure_launchctl_cache

if [[ -z "$MAIN_ENV_FILE" ]]; then
  MAIN_ENV_FILE="$(resolve_stack_env_file main)"
fi
HAPPY_HOME_DIR="$(resolve_stack_base_dir main "$MAIN_ENV_FILE")"
CLI_HOME_DIR="$(resolve_stack_cli_home_dir main "$MAIN_ENV_FILE")"
LOGS_DIR="$HAPPY_HOME_DIR/logs"
MAIN_LABEL="$(resolve_stack_label main)"

MAIN_COLLECT="$(collect_stack_status "$MAIN_PORT" "$CLI_HOME_DIR" "$MAIN_LABEL" "$HAPPY_HOME_DIR")"
IFS=$'\t' read -r MAIN_LEVEL MAIN_SERVER_STATUS MAIN_SERVER_PID MAIN_SERVER_METRICS MAIN_DAEMON_STATUS MAIN_DAEMON_PID MAIN_DAEMON_METRICS MAIN_DAEMON_UPTIME MAIN_LAST_HEARTBEAT MAIN_LAUNCHAGENT_STATUS MAIN_AUTOSTART_PID MAIN_AUTOSTART_METRICS <<<"$MAIN_COLLECT"
for v in MAIN_SERVER_PID MAIN_SERVER_METRICS MAIN_DAEMON_PID MAIN_DAEMON_METRICS MAIN_DAEMON_UPTIME MAIN_LAST_HEARTBEAT MAIN_AUTOSTART_PID MAIN_AUTOSTART_METRICS; do
  if [[ "${!v}" == "-" ]]; then
    printf -v "$v" '%s' ""
  fi
done

# Menu bar icon
MENU_STATUS_ICON_B64="$(status_icon_b64 "$MAIN_LEVEL" 18)"
if [[ -n "$MENU_STATUS_ICON_B64" ]]; then
  echo " | image=$MENU_STATUS_ICON_B64"
else
  STATUS_COLOR="$(color_for_level "$MAIN_LEVEL")"
  ICON_B64="$(get_menu_icon_b64)"
  if [[ -n "$ICON_B64" ]]; then
    echo "● | templateImage=$ICON_B64 color=$STATUS_COLOR"
  else
    echo "Happy"
  fi
fi

echo "---"
echo "Happy Stacks | size=14 font=SF Pro Display"
echo "---"

# Mode (selfhost vs dev)
if [[ "$MENUBAR_MODE" == "selfhost" ]]; then
  echo "Mode: Selfhost | sfimage=house"
else
  echo "Mode: Dev | sfimage=hammer"
fi
if [[ -n "$PNPM_BIN" ]]; then
  if [[ "$MENUBAR_MODE" == "selfhost" ]]; then
    echo "--Switch to Dev mode | bash=$PNPM_BIN param1=menubar param2=mode param3=dev dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  else
    echo "--Switch to Selfhost mode | bash=$PNPM_BIN param1=menubar param2=mode param3=selfhost dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  fi
fi
echo "---"

# Main stack (inline)
echo "Main stack"
echo "---"
export MAIN_LEVEL="$MAIN_LEVEL"
render_stack_info "" "main" "$MAIN_PORT" "$MAIN_SERVER_COMPONENT" "$HAPPY_HOME_DIR" "$CLI_HOME_DIR" "$MAIN_LABEL" "$MAIN_ENV_FILE" "$TAILSCALE_URL" "$MAIN_SERVER_METRICS" "$MAIN_DAEMON_METRICS" "$MAIN_AUTOSTART_METRICS"
render_component_server "" "main" "$MAIN_PORT" "$MAIN_SERVER_COMPONENT" "$MAIN_SERVER_STATUS" "$MAIN_SERVER_PID" "$MAIN_SERVER_METRICS" "$TAILSCALE_URL" "$MAIN_LABEL"
render_component_daemon "" "$MAIN_DAEMON_STATUS" "$MAIN_DAEMON_PID" "$MAIN_DAEMON_METRICS" "$MAIN_DAEMON_UPTIME" "$MAIN_LAST_HEARTBEAT" "$CLI_HOME_DIR/daemon.state.json" "main"
render_component_autostart "" "main" "$MAIN_LABEL" "$MAIN_LAUNCHAGENT_STATUS" "$MAIN_AUTOSTART_PID" "$MAIN_AUTOSTART_METRICS" "$LOGS_DIR"
render_component_tailscale "" "main" "$TAILSCALE_URL"

echo "---"
if [[ "$MENUBAR_MODE" == "selfhost" ]]; then
  echo "Maintenance | sfimage=wrench.and.screwdriver"
  if [[ -n "$PNPM_BIN" ]]; then
    UPDATE_JSON="${HAPPY_LOCAL_DIR}/cache/update.json"
    update_available=""
    latest=""
    current=""
    if [[ -f "$UPDATE_JSON" ]]; then
      update_available="$(grep -oE '\"updateAvailable\"[[:space:]]*:[[:space:]]*(true|false)' "$UPDATE_JSON" 2>/dev/null | head -1 | grep -oE '(true|false)' || true)"
      latest="$(grep -oE '\"latest\"[[:space:]]*:[[:space:]]*\"[^\"]+\"' "$UPDATE_JSON" 2>/dev/null | head -1 | sed -E 's/.*\"latest\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/' || true)"
      current="$(grep -oE '\"current\"[[:space:]]*:[[:space:]]*\"[^\"]+\"' "$UPDATE_JSON" 2>/dev/null | head -1 | sed -E 's/.*\"current\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/' || true)"
    fi
    if [[ "$update_available" == "true" && -n "$latest" ]]; then
      echo "--Update available: ${current:-current} → ${latest} | color=$YELLOW"
    else
      echo "--Updates: up to date | color=$GRAY"
    fi
    echo "--Check for updates | bash=$PNPM_BIN param1=self param2=check dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--Update happy-stacks runtime | bash=$PNPM_BIN param1=self param2=update dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--Doctor | bash=$PNPM_BIN param1=doctor dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  else
    echo "--⚠️ happys not found (run: npx happy-stacks setup)" 
  fi
else
  echo "Stacks | sfimage=server.rack"
  STACKS_PREFIX="--"

  if [[ -n "$PNPM_BIN" ]]; then
    HAPPYS_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/happys-term.sh"
    echo "${STACKS_PREFIX}New stack (interactive) | bash=$HAPPYS_TERM param1=stack param2=new param3=--interactive dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "${STACKS_PREFIX}List stacks | bash=$HAPPYS_TERM param1=stack param2=list dir=$HAPPY_LOCAL_DIR terminal=false"
    print_sep "$STACKS_PREFIX"
  fi

  STACKS_DIR="$(resolve_stacks_storage_root)"
  LEGACY_STACKS_DIR="$HOME/.happy/local/stacks"
  if swiftbar_is_sandboxed; then
    LEGACY_STACKS_DIR=""
  fi
  if [[ -d "$STACKS_DIR" ]] || [[ -n "$LEGACY_STACKS_DIR" && -d "$LEGACY_STACKS_DIR" ]]; then
    STACK_NAMES="$(
      {
        ls -1 "$STACKS_DIR" 2>/dev/null || true
        [[ -n "$LEGACY_STACKS_DIR" ]] && ls -1 "$LEGACY_STACKS_DIR" 2>/dev/null || true
      } | sort -u
    )"
    if [[ -z "$STACK_NAMES" ]]; then
      echo "${STACKS_PREFIX}No stacks found | color=$GRAY"
    fi
    for s in $STACK_NAMES; do
      env_file="$(resolve_stack_env_file "$s")"
      [[ -f "$env_file" ]] || continue

      # Ports may be ephemeral (runtime-only). Do not skip stacks if the env file does not pin a port.
      port="$(resolve_stack_server_port "$s" "$env_file")"

      server_component="$(dotenv_get "$env_file" "HAPPY_STACKS_SERVER_COMPONENT")"
      [[ -z "$server_component" ]] && server_component="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_COMPONENT")"
      [[ -n "$server_component" ]] || server_component="happy-server-light"

      base_dir="$(resolve_stack_base_dir "$s" "$env_file")"
      cli_home_dir="$(resolve_stack_cli_home_dir "$s" "$env_file")"
      label="$(resolve_stack_label "$s")"

      COLLECT="$(collect_stack_status "$port" "$cli_home_dir" "$label" "$base_dir")"
      IFS=$'\t' read -r LEVEL SERVER_STATUS SERVER_PID SERVER_METRICS DAEMON_STATUS DAEMON_PID DAEMON_METRICS DAEMON_UPTIME LAST_HEARTBEAT LAUNCHAGENT_STATUS AUTOSTART_PID AUTOSTART_METRICS <<<"$COLLECT"
      for v in SERVER_PID SERVER_METRICS DAEMON_PID DAEMON_METRICS DAEMON_UPTIME LAST_HEARTBEAT AUTOSTART_PID AUTOSTART_METRICS; do
        if [[ "${!v}" == "-" ]]; then
          printf -v "$v" '%s' ""
        fi
      done

      render_stack_overview_item "Stack: $s" "$LEVEL" "$STACKS_PREFIX"
      export STACK_LEVEL="$LEVEL"
      render_stack_info "${STACKS_PREFIX}--" "$s" "$port" "$server_component" "$base_dir" "$cli_home_dir" "$label" "$env_file" "" "$SERVER_METRICS" "$DAEMON_METRICS" "$AUTOSTART_METRICS"
      render_component_server "${STACKS_PREFIX}--" "$s" "$port" "$server_component" "$SERVER_STATUS" "$SERVER_PID" "$SERVER_METRICS" "" "$label"
      render_component_daemon "${STACKS_PREFIX}--" "$DAEMON_STATUS" "$DAEMON_PID" "$DAEMON_METRICS" "$DAEMON_UPTIME" "$LAST_HEARTBEAT" "$cli_home_dir/daemon.state.json" "$s"
      render_component_autostart "${STACKS_PREFIX}--" "$s" "$label" "$LAUNCHAGENT_STATUS" "$AUTOSTART_PID" "$AUTOSTART_METRICS" "$base_dir/logs"
      render_component_tailscale "${STACKS_PREFIX}--" "$s" ""
      render_components_menu "${STACKS_PREFIX}--" "stack" "$s" "$env_file"
    done
  else
    echo "${STACKS_PREFIX}No stacks dir found at: $(shorten_path "$STACKS_DIR" 52) | color=$GRAY"
  fi

  echo "---"
  render_components_menu "" "main" "main" "$MAIN_ENV_FILE"

  echo "Worktrees | sfimage=arrow.triangle.branch"
  if [[ -z "$PNPM_BIN" ]]; then
    echo "--⚠️ happys not found (run: npx happy-stacks setup)"
  else
    HAPPYS_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/happys-term.sh"
    echo "--Use (interactive) | bash=$HAPPYS_TERM param1=wt param2=use param3=--interactive dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--New (interactive) | bash=$HAPPYS_TERM param1=wt param2=new param3=--interactive dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--PR worktree (prompt) | bash=$HAPPY_LOCAL_DIR/extras/swiftbar/wt-pr.sh dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--Sync mirrors (all) | bash=$PNPM_BIN param1=wt param2=sync-all dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--Update all (dry-run) | bash=$HAPPYS_TERM param1=wt param2=update-all param3=--dry-run dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--Update all (apply) | bash=$PNPM_BIN param1=wt param2=update-all dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  fi

  echo "---"
  echo "Setup / Tools"
  if [[ -z "$PNPM_BIN" ]]; then
    echo "--⚠️ happys not found (run: npx happy-stacks setup)"
  else
    HAPPYS_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/happys-term.sh"
    echo "--Setup (guided) | bash=$HAPPYS_TERM param1=setup dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--Bootstrap (clone/install) | bash=$HAPPYS_TERM param1=bootstrap dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--CLI link (install happy wrapper) | bash=$HAPPYS_TERM param1=cli:link dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
    echo "--Mobile dev helper | bash=$HAPPYS_TERM param1=mobile dir=$HAPPY_LOCAL_DIR terminal=false"
  fi
fi

echo "---"
echo "Refresh | sfimage=arrow.clockwise refresh=true"
echo "---"
echo "Refresh interval | sfimage=timer"
SET_INTERVAL="$HAPPY_LOCAL_DIR/extras/swiftbar/set-interval.sh"
echo "--10s | bash=$SET_INTERVAL param1=10s dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--30s | bash=$SET_INTERVAL param1=30s dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--1m | bash=$SET_INTERVAL param1=1m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--5m (recommended) | bash=$SET_INTERVAL param1=5m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--10m | bash=$SET_INTERVAL param1=10m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--15m | bash=$SET_INTERVAL param1=15m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--30m | bash=$SET_INTERVAL param1=30m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--1h | bash=$SET_INTERVAL param1=1h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--2h | bash=$SET_INTERVAL param1=2h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--6h | bash=$SET_INTERVAL param1=6h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--12h | bash=$SET_INTERVAL param1=12h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--1d | bash=$SET_INTERVAL param1=1d dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"

exit 0
