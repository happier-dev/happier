#!/bin/bash

# Lightweight git helpers for SwiftBar.
# Keep these fast: avoid network, avoid long commands.

is_git_repo() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" ]] || return 1
  # Fast-path: repo root/worktree checkout.
  if [[ -d "$dir/.git" || -f "$dir/.git" ]]; then
    return 0
  fi
  # Monorepo packages (and other nested dirs) are still "inside" a git repo even if they don't contain .git.
  command -v git >/dev/null 2>&1 || return 1
  local inside
  inside="$(git -C "$dir" rev-parse --is-inside-work-tree 2>/dev/null || true)"
  [[ "$inside" == "true" ]]
}

git_cache_dir() {
  local home
  home="$(resolve_home_dir)"
  local dir="${home}/cache/swiftbar/git"
  mkdir -p "$dir" 2>/dev/null || true
  echo "$dir"
}

git_cache_ttl_sec() {
  # Default: 6 hours.
  local v="${HAPPIER_STACK_SWIFTBAR_GIT_TTL_SEC:-21600}"
  [[ "$v" =~ ^[0-9]+$ ]] || v=21600
  echo "$v"
}

git_cache_refresh_on_stale() {
  [[ "${HAPPIER_STACK_SWIFTBAR_GIT_REFRESH_ON_STALE:-0}" == "1" ]]
}

git_cache_auto_refresh_scope() {
  # off | main | all
  local s="${HAPPIER_STACK_SWIFTBAR_GIT_AUTO_REFRESH_SCOPE:-main}"
  s="$(echo "$s" | tr '[:upper:]' '[:lower:]')"
  case "$s" in
    off|none|0) echo "off" ;;
    all) echo "all" ;;
    *) echo "main" ;;
  esac
}

git_cache_last_refresh_file() {
  local scope="${1:-main}" # main|all|stack:<name>
  local dir
  dir="$(git_cache_dir)"
  local key="last_refresh|${scope}"
  echo "${dir}/$(swiftbar_cache_hash12 "$key").last"
}

git_cache_background_refresh_lockdir() {
  local scope="${1:-main}"
  local dir
  dir="$(git_cache_dir)"
  local key="bg_refresh_lock|${scope}"
  echo "${dir}/$(swiftbar_cache_hash12 "$key").lock"
}

git_cache_touch_last_refresh() {
  local scope="${1:-main}"
  local f
  f="$(git_cache_last_refresh_file "$scope")"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null >"$f" || true
  touch "$f" 2>/dev/null || true
}

git_cache_age_since_last_refresh_sec() {
  local scope="${1:-main}"
  local f
  f="$(git_cache_last_refresh_file "$scope")"
  [[ -f "$f" ]] || { echo ""; return; }
  local mtime now
  mtime="$(stat -f %m "$f" 2>/dev/null || echo 0)"
  now="$(date +%s 2>/dev/null || echo 0)"
  if [[ "$mtime" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ && "$now" -ge "$mtime" ]]; then
    echo $((now - mtime))
  else
    echo ""
  fi
}

git_cache_maybe_refresh_async() {
  # Non-blocking cache refresh.
  # Usage: git_cache_maybe_refresh_async <scope> <refresh_cmd...>
  local scope="$1"
  shift

  local ttl age
  ttl="$(git_cache_ttl_sec)"
  age="$(git_cache_age_since_last_refresh_sec "$scope")"

  # If never refreshed, treat as stale and allow.
  if [[ -n "$age" && "$age" =~ ^[0-9]+$ && "$age" -le "$ttl" ]]; then
    return 0
  fi

  local lockdir
  lockdir="$(git_cache_background_refresh_lockdir "$scope")"
  if [[ -d "$lockdir" ]]; then
    # If lock is too old, break it (e.g. crashed refresh).
    local lock_age
    lock_age="$(git_cache_age_sec "$lockdir" 2>/dev/null || true)"
    if [[ -n "$lock_age" && "$lock_age" =~ ^[0-9]+$ && "$lock_age" -gt 3600 ]]; then
      rm -rf "$lockdir" 2>/dev/null || true
    else
      return 0
    fi
  fi

  mkdir "$lockdir" 2>/dev/null || return 0
  echo "$$" >"${lockdir}/pid" 2>/dev/null || true
  date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null >"${lockdir}/started_at" || true

  # Run in the background; on success, update last-refresh marker.
  (
    "$@" >/dev/null 2>&1 || true
    git_cache_touch_last_refresh "$scope"
    rm -rf "$lockdir" >/dev/null 2>&1 || true
  ) >/dev/null 2>&1 &
}

git_cache_mode() {
  # cached (default) | live
  local m="${HAPPIER_STACK_SWIFTBAR_GIT_MODE:-cached}"
  m="$(echo "$m" | tr '[:upper:]' '[:lower:]')"
  [[ "$m" == "live" ]] && echo "live" || echo "cached"
}

git_cache_key() {
  # Include context+stack because stacks can point components at different worktrees/dirs.
  local context="$1"
  local stack="$2"
  local component="$3"
  local active_dir="$4"
  echo "ctx=${context}|stack=${stack}|comp=${component}|dir=${active_dir}"
}

git_cache_paths() {
  # Usage: git_cache_paths <key>
  # Output: meta<TAB>info<TAB>worktrees
  local key="$1"
  local dir
  dir="$(git_cache_dir)"
  local h
  h="$(swiftbar_hash "$key")"
  echo -e "${dir}/${h}.meta\t${dir}/${h}.info.tsv\t${dir}/${h}.worktrees.tsv"
}

git_cache_age_sec() {
  local meta="$1"
  [[ -f "$meta" ]] || { echo ""; return; }
  local mtime now
  mtime="$(stat -f %m "$meta" 2>/dev/null || echo 0)"
  now="$(date +%s 2>/dev/null || echo 0)"
  if [[ "$mtime" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ && "$now" -ge "$mtime" ]]; then
    echo $((now - mtime))
  else
    echo ""
  fi
}

git_cache_is_fresh() {
  local meta="$1"
  local ttl
  ttl="$(git_cache_ttl_sec)"
  local age
  age="$(git_cache_age_sec "$meta")"
  [[ -n "$age" && "$age" =~ ^[0-9]+$ && "$age" -le "$ttl" ]]
}

git_cache_write_meta() {
  local meta="$1"
  local key="$2"
  mkdir -p "$(dirname "$meta")" 2>/dev/null || true
  {
    echo "key=$key"
    echo "updated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)"
  } >"$meta" 2>/dev/null || true
  # touch to update mtime (age calculation uses mtime).
  touch "$meta" 2>/dev/null || true
}

git_cache_refresh_one() {
  # Computes and writes cached snapshot for one component context.
  # Usage: git_cache_refresh_one <context> <stack> <component> <active_dir>
  local context="$1"
  local stack="$2"
  local component="$3"
  local active_dir="$4"

  local key
  key="$(git_cache_key "$context" "$stack" "$component" "$active_dir")"
  local meta info wts
  IFS=$'\t' read -r meta info wts <<<"$(git_cache_paths "$key")"

  # Missing/non-repo: still write meta so we don't thrash.
  if ! is_git_repo "$active_dir"; then
    echo -e "missing\t${active_dir}\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-" >"$info" 2>/dev/null || true
    : >"$wts" 2>/dev/null || true
    git_cache_write_meta "$meta" "$key"
    return 0
  fi

  # Collect snapshot.
  local branch head upstream dirty ab ahead behind
  branch="$(git_head_branch "$active_dir")"
  head="$(git_head_short "$active_dir")"
  upstream="$(git_upstream_short "$active_dir")"
  dirty="$(git_dirty_flag "$active_dir")"
  ab="$(git_ahead_behind "$active_dir")"
  ahead=""
  behind=""
  if [[ -n "$ab" ]]; then
    ahead="$(echo "$ab" | cut -d'|' -f1)"
    behind="$(echo "$ab" | cut -d'|' -f2)"
  fi

  local main_branch main_upstream main_ab main_ahead main_behind
  main_branch="$(git_main_branch_name "$active_dir")"
  main_upstream=""
  main_ahead=""
  main_behind=""
  if [[ -n "$main_branch" ]]; then
    main_upstream="$(git_branch_upstream_short "$active_dir" "$main_branch")"
    main_ab="$(git_branch_ahead_behind "$active_dir" "$main_branch")"
    if [[ -n "$main_ab" ]]; then
      main_ahead="$(echo "$main_ab" | cut -d'|' -f1)"
      main_behind="$(echo "$main_ab" | cut -d'|' -f2)"
    fi
  fi

  local oref uref oab o_ahead o_behind uab u_ahead u_behind
  oref="$(git_remote_main_ref "$active_dir" "origin")"
  uref="$(git_remote_main_ref "$active_dir" "upstream")"
  o_ahead=""; o_behind=""; u_ahead=""; u_behind=""
  if [[ -n "$main_branch" && -n "$oref" ]]; then
    oab="$(git_ahead_behind_refs "$active_dir" "$oref" "$main_branch")"
    if [[ -n "$oab" ]]; then
      o_ahead="$(echo "$oab" | cut -d'|' -f1)"
      o_behind="$(echo "$oab" | cut -d'|' -f2)"
    fi
  fi
  if [[ -n "$main_branch" && -n "$uref" ]]; then
    uab="$(git_ahead_behind_refs "$active_dir" "$uref" "$main_branch")"
    if [[ -n "$uab" ]]; then
      u_ahead="$(echo "$uab" | cut -d'|' -f1)"
      u_behind="$(echo "$uab" | cut -d'|' -f2)"
    fi
  fi

  local wt_count
  wt_count="$(git_worktree_count "$active_dir")"
  git_worktrees_tsv "$active_dir" >"$wts" 2>/dev/null || true

  # status active_dir branch head upstream dirty ahead behind main_branch main_upstream main_ahead main_behind oref o_ahead o_behind uref u_ahead u_behind wt_count
  echo -e "ok\t${active_dir}\t${branch}\t${head}\t${upstream}\t${dirty}\t${ahead}\t${behind}\t${main_branch}\t${main_upstream}\t${main_ahead}\t${main_behind}\t${oref}\t${o_ahead}\t${o_behind}\t${uref}\t${u_ahead}\t${u_behind}\t${wt_count}" >"$info" 2>/dev/null || true
  git_cache_write_meta "$meta" "$key"
  return 0
}

git_cache_load_or_refresh() {
  # Usage: git_cache_load_or_refresh <context> <stack> <component> <active_dir> <allow_refresh_on_miss:0|1>
  # Output: meta<TAB>info<TAB>worktrees<TAB>stale(0|1)
  local context="$1"
  local stack="$2"
  local component="$3"
  local active_dir="$4"
  local allow_refresh_on_miss="${5:-0}"

  local key
  key="$(git_cache_key "$context" "$stack" "$component" "$active_dir")"
  local meta info wts
  IFS=$'\t' read -r meta info wts <<<"$(git_cache_paths "$key")"

  # If cache exists and is fresh, use it.
  if [[ -f "$meta" && -f "$info" ]]; then
    if git_cache_is_fresh "$meta"; then
      echo -e "${meta}\t${info}\t${wts}\t0"
      return 0
    fi
    # Stale: do not refresh synchronously during menu render. Background refresh is handled elsewhere.
    echo -e "${meta}\t${info}\t${wts}\t1"
    return 0
  fi

  # Missing: only refresh synchronously when allowed by caller.
  if [[ "$allow_refresh_on_miss" == "1" ]]; then
    git_cache_refresh_one "$context" "$stack" "$component" "$active_dir" >/dev/null 2>&1 || true
    if [[ -f "$info" ]]; then
      echo -e "${meta}\t${info}\t${wts}\t0"
      return 0
    fi
  fi

  # Still missing; report missing and stale=1 so callers can show "refresh" action.
  echo -e "${meta}\t${info}\t${wts}\t1"
  return 0
}

git_try() {
  local dir="$1"
  shift
  if ! command -v git >/dev/null 2>&1; then
    return 1
  fi
  local subcmd="${1:-}"

  # Run-cache: many stacks render the same component git info; cache by repo path + args for this SwiftBar run.
  local cache_key="git|${dir}|$*"
  swiftbar_cache_get "$cache_key"
  local cached_rc=$?
  if [[ $cached_rc -ne 111 ]]; then
    # Cache hit: swiftbar_cache_get already printed stdout. Preserve rc.
    return $cached_rc
  fi

  local t0 t1 rc out
  t0="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  out="$(git -C "$dir" "$@" 2>/dev/null)"
  rc=$?
  t1="$(swiftbar_now_ms 2>/dev/null || echo 0)"
  swiftbar_cache_set "$cache_key" "$rc" "$out"
  # Keep label short; include subcommand for aggregation.
  swiftbar_profile_log "time" "label=git" "subcmd=$subcmd" "ms=$((t1 - t0))" "rc=${rc}"
  printf '%s\n' "$out"
  return $rc
}

git_head_branch() {
  local dir="$1"
  git_try "$dir" rev-parse --abbrev-ref HEAD | head -1
}

git_head_short() {
  local dir="$1"
  git_try "$dir" rev-parse --short HEAD | head -1
}

git_upstream_short() {
  local dir="$1"
  # Prints like "origin/main" or "upstream/main"
  git_try "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' | head -1 || true
}

git_ahead_behind() {
  # Output: ahead|behind (numbers). Returns empty if no upstream.
  local dir="$1"
  local upstream
  upstream="$(git_upstream_short "$dir")"
  if [[ -z "$upstream" ]]; then
    echo ""
    return
  fi
  local counts
  counts="$(git_try "$dir" rev-list --left-right --count "${upstream}...HEAD" | tr -s ' ' | sed 's/^ //')" || true
  if [[ -z "$counts" ]]; then
    echo ""
    return
  fi
  # counts is "behind ahead"
  local behind ahead
  behind="$(echo "$counts" | awk '{print $1}')"
  ahead="$(echo "$counts" | awk '{print $2}')"
  if [[ -n "$ahead" && -n "$behind" ]]; then
    echo "${ahead}|${behind}"
  else
    echo ""
  fi
}

git_dirty_flag() {
  # "clean" | "dirty" | "unknown"
  local dir="$1"
  if ! is_git_repo "$dir"; then
    echo "unknown"
    return
  fi
  local out
  out="$(git_try "$dir" status --porcelain | head -1 || true)"
  if [[ -n "$out" ]]; then
    echo "dirty"
  else
    echo "clean"
  fi
}

git_main_branch_name() {
  local dir="$1"
  if git_try "$dir" show-ref --verify --quiet refs/heads/main; then
    echo "main"
    return
  fi
  if git_try "$dir" show-ref --verify --quiet refs/heads/master; then
    echo "master"
    return
  fi
  echo ""
}

git_branch_upstream_short() {
  local dir="$1"
  local branch="$2"
  if [[ -z "$branch" ]]; then
    echo ""
    return
  fi
  git_try "$dir" rev-parse --abbrev-ref --symbolic-full-name "${branch}@{u}" | head -1 || true
}

git_branch_ahead_behind() {
  # Output: ahead|behind for a branch vs its upstream.
  local dir="$1"
  local branch="$2"
  local upstream
  upstream="$(git_branch_upstream_short "$dir" "$branch")"
  if [[ -z "$branch" || -z "$upstream" ]]; then
    echo ""
    return
  fi
  local counts
  counts="$(git_try "$dir" rev-list --left-right --count "${upstream}...${branch}" | tr -s ' ' | sed 's/^ //')" || true
  if [[ -z "$counts" ]]; then
    echo ""
    return
  fi
  local behind ahead
  behind="$(echo "$counts" | awk '{print $1}')"
  ahead="$(echo "$counts" | awk '{print $2}')"
  if [[ -n "$ahead" && -n "$behind" ]]; then
    echo "${ahead}|${behind}"
  else
    echo ""
  fi
}

git_ref_exists() {
  local dir="$1"
  local ref="$2"
  [[ -n "$ref" ]] || return 1
  git_try "$dir" show-ref --verify --quiet "$ref"
}

git_remote_main_ref() {
  # Returns a remote tracking ref like refs/remotes/origin/main or refs/remotes/upstream/master.
  local dir="$1"
  local remote="$2"
  if git_ref_exists "$dir" "refs/remotes/${remote}/main"; then
    echo "refs/remotes/${remote}/main"
    return
  fi
  if git_ref_exists "$dir" "refs/remotes/${remote}/master"; then
    echo "refs/remotes/${remote}/master"
    return
  fi
  echo ""
}

git_ahead_behind_refs() {
  # Output: ahead|behind for local_ref compared to base_ref.
  # Uses: git rev-list --left-right --count base...local => "behind ahead"
  local dir="$1"
  local base_ref="$2"
  local local_ref="$3"
  if [[ -z "$base_ref" || -z "$local_ref" ]]; then
    echo ""
    return
  fi
  local counts
  counts="$(git_try "$dir" rev-list --left-right --count "${base_ref}...${local_ref}" | tr -s ' ' | sed 's/^ //')" || true
  if [[ -z "$counts" ]]; then
    echo ""
    return
  fi
  local behind ahead
  behind="$(echo "$counts" | awk '{print $1}')"
  ahead="$(echo "$counts" | awk '{print $2}')"
  if [[ -n "$ahead" && -n "$behind" ]]; then
    echo "${ahead}|${behind}"
  else
    echo ""
  fi
}

git_worktree_count() {
  local dir="$1"
  if ! is_git_repo "$dir"; then
    echo ""
    return
  fi
  local out
  out="$(git_try "$dir" worktree list --porcelain || true)"
  if [[ -z "$out" ]]; then
    echo ""
    return
  fi
  # Count "worktree <path>" blocks.
  echo "$out" | awk '/^worktree /{c++} END{ if (c>0) print c; }'
}

git_worktrees_tsv() {
  # Output: path<TAB>branchRefOrEmpty
  # Example branch line in porcelain: "branch refs/heads/slopus/pr/foo"
  local dir="$1"
  if ! is_git_repo "$dir"; then
    return
  fi
  local out
  out="$(git_try "$dir" worktree list --porcelain || true)"
  if [[ -z "$out" ]]; then
    return
  fi

  local wt_path="" wt_branch=""
  while IFS= read -r line; do
    # Block separator
    if [[ -z "$line" ]]; then
      if [[ -n "$wt_path" ]]; then
        echo -e "${wt_path}\t${wt_branch}"
      fi
      wt_path=""
      wt_branch=""
      continue
    fi

    if [[ "$line" == worktree\ * ]]; then
      wt_path="${line#worktree }"
      continue
    fi
    if [[ "$line" == branch\ * ]]; then
      wt_branch="${line#branch }"
      continue
    fi
    # ignore HEAD/detached lines
  done <<<"$out"

  if [[ -n "$wt_path" ]]; then
    echo -e "${wt_path}\t${wt_branch}"
  fi
}

resolve_component_dir_from_env_file() {
  # Resolve component directory based on a stack env file.
  # Usage: resolve_component_dir_from_env_file <env_file> <component>
  local env_file="$1"
  local component="$2"
  local stacks_key=""
  case "$component" in
    happy) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY" ;;
    happy-cli) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI" ;;
    happy-server-light) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT" ;;
    happy-server) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER" ;;
    *) stacks_key="" ;;
  esac

  local fallback
  fallback="$(resolve_components_dir)/$component"
  if [[ -z "$env_file" || -z "$stacks_key" || ! -f "$env_file" ]]; then
    echo "$fallback"
    return
  fi

  local raw
  raw="$(dotenv_get "$env_file" "$stacks_key")"
  if [[ -z "$raw" ]]; then
    echo "$fallback"
    return
  fi

  if [[ "$raw" == "~/"* ]]; then
    raw="$HOME/${raw#~/}"
  fi
  if [[ "$raw" == /* ]]; then
    echo "$raw"
  else
    echo "$(resolve_workspace_dir)/$raw"
  fi
}

resolve_component_dir_from_env() {
  # Resolve active component directory based on env + env.local + .env.
  # Usage: resolve_component_dir_from_env <component>
  # Output: absolute path (best-effort). Falls back to <workspace>/components/<component>.
  local component="$1"
  local stacks_key=""
  case "$component" in
    happy) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY" ;;
    happy-cli) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI" ;;
    happy-server-light) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT" ;;
    happy-server) stacks_key="HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER" ;;
    *) stacks_key="" ;;
  esac

  local raw=""
  if [[ -n "$stacks_key" && -n "${!stacks_key:-}" ]]; then
    raw="${!stacks_key}"
  fi

  local env_file
  env_file="$(resolve_main_env_file)"
  if [[ -z "$raw" && -n "$env_file" && -n "$stacks_key" ]]; then
    raw="$(dotenv_get "$env_file" "$stacks_key")"
  fi

  local home
  home="$(resolve_home_dir)"
  if [[ -z "$raw" && -n "$stacks_key" ]]; then
    raw="$(dotenv_get "$home/env.local" "$stacks_key")"
  fi
  if [[ -z "$raw" && -n "$stacks_key" ]]; then
    raw="$(dotenv_get "$home/.env" "$stacks_key")"
  fi

  local fallback
  fallback="$(resolve_components_dir)/$component"
  if [[ -z "$raw" ]]; then
    echo "$fallback"
    return
  fi

  # Expand ~
  if [[ "$raw" == "~/"* ]]; then
    raw="$HOME/${raw#~/}"
  fi

  # Absolute vs relative (relative is interpreted relative to the repo root).
  if [[ "$raw" == /* ]]; then
    echo "$raw"
  else
    echo "$(resolve_workspace_dir)/$raw"
  fi
}
