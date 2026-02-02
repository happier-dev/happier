#!/bin/bash
set -euo pipefail

# Refresh SwiftBar Git/worktree cache.
#
# Usage:
#   ./git-cache-refresh.sh all
#   ./git-cache-refresh.sh main
#   ./git-cache-refresh.sh stack <name>
#   ./git-cache-refresh.sh component <context:main|stack> <stackName> <component>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

hstack_ROOT_DIR="${HAPPIER_STACK_CLI_ROOT_DIR:-$DEFAULT_ROOT_DIR}"
LIB_DIR="$hstack_ROOT_DIR/extras/swiftbar/lib"
if [[ ! -f "$LIB_DIR/utils.sh" ]]; then
  echo "missing SwiftBar libs at: $LIB_DIR" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$LIB_DIR/utils.sh"
hstack_ROOT_DIR="$(resolve_hstack_root_dir)"
LIB_DIR="$hstack_ROOT_DIR/extras/swiftbar/lib"
# shellcheck source=/dev/null
source "$LIB_DIR/git.sh"

components=(happier-ui happier-cli happier-server-light happier-server)

refresh_one() {
  local context="$1"
  local stack="$2"
  local component="$3"
  local env_file="$4"

  local active_dir=""
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    active_dir="$(resolve_component_dir_from_env_file "$env_file" "$component")"
  else
    active_dir="$(resolve_component_dir_from_env "$component")"
  fi

  git_cache_refresh_one "$context" "$stack" "$component" "$active_dir" >/dev/null
}

refresh_stack() {
  local stack="$1"
  local env_file=""
  if [[ "$stack" == "main" ]]; then
    env_file="$(resolve_main_env_file)"
    [[ -z "$env_file" ]] && env_file="$(resolve_stack_env_file main)"
  else
    env_file="$(resolve_stack_env_file "$stack")"
  fi

  for c in "${components[@]}"; do
    refresh_one "stack" "$stack" "$c" "$env_file"
  done
}

cmd="${1:-}"
case "$cmd" in
  all)
    refresh_stack "main"
    STACKS_DIR="$(resolve_stacks_storage_root)"
    STACK_NAMES="$(
      {
        ls -1 "$STACKS_DIR" 2>/dev/null || true
      } | sort -u
    )"
    while IFS= read -r s; do
      [[ -n "$s" ]] || continue
      [[ "$s" == "main" ]] && continue
      refresh_stack "$s"
    done <<<"$STACK_NAMES"
    git_cache_touch_last_refresh "all"
    echo "ok: git cache refreshed (all)"
    ;;
  main)
    # Main stack only (fast).
    local_env="$(resolve_main_env_file)"
    for c in "${components[@]}"; do
      refresh_one "main" "main" "$c" "$local_env"
    done
    git_cache_touch_last_refresh "main"
    echo "ok: git cache refreshed (main)"
    ;;
  stack)
    stack="${2:-}"
    if [[ -z "$stack" ]]; then
      echo "usage: $0 stack <name>" >&2
      exit 2
    fi
    refresh_stack "$stack"
    git_cache_touch_last_refresh "stack:${stack}"
    echo "ok: git cache refreshed (stack $stack)"
    ;;
  component)
    context="${2:-}"
    stack="${3:-}"
    component="${4:-}"
    if [[ -z "$context" || -z "$stack" || -z "$component" ]]; then
      echo "usage: $0 component <main|stack> <stackName> <component>" >&2
      exit 2
    fi
    env_file=""
    if [[ "$stack" == "main" ]]; then
      env_file="$(resolve_main_env_file)"
      [[ -z "$env_file" ]] && env_file="$(resolve_stack_env_file main)"
    else
      env_file="$(resolve_stack_env_file "$stack")"
    fi
    refresh_one "$context" "$stack" "$component" "$env_file"
    git_cache_touch_last_refresh "component:${context}:${stack}:${component}"
    echo "ok: git cache refreshed ($context/$stack/$component)"
    ;;
  *)
    echo "usage: $0 all|main|stack <name>|component <context> <stackName> <component>" >&2
    exit 2
    ;;
esac
