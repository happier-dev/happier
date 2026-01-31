#!/bin/bash

get_menu_icon_b64() {
  # User override: point at any image file (png/jpg), we'll resize + base64 it.
  local user_icon="${HAPPY_LOCAL_SWIFTBAR_ICON_PATH:-}"
  local source=""

  if [[ -n "$user_icon" ]] && [[ -f "$user_icon" ]]; then
    source="$user_icon"
  fi

  # Default: prefer a menu-bar friendly PNG icon (repo-local).
  if [[ -z "$source" ]] && [[ -f "$HAPPY_LOCAL_DIR/extras/swiftbar/icons/logo-white.png" ]]; then
    source="$HAPPY_LOCAL_DIR/extras/swiftbar/icons/logo-white.png"
  fi

  # Fallback: use Happy's favicon if present.
  local workspace_dir
  workspace_dir="$(resolve_workspace_dir)"

  if [[ -z "$source" ]] && [[ -f "$workspace_dir/components/happy/dist/favicon.ico" ]]; then
    source="$workspace_dir/components/happy/dist/favicon.ico"
  fi

  # Final fallback: Happy logo if present.
  if [[ -z "$source" ]] && [[ -f "$workspace_dir/components/happy/logo.png" ]]; then
    source="$workspace_dir/components/happy/logo.png"
  fi

  if [[ -z "$source" ]]; then
    echo ""
    return
  fi

  local cache_dir="$HAPPY_HOME_DIR/swiftbar"
  local cache_png="$cache_dir/happy-stacks-icon.png"
  local cache_b64="$cache_dir/happy-stacks-icon.b64"
  local cache_meta="$cache_dir/happy-stacks-icon.meta"

  mkdir -p "$cache_dir" 2>/dev/null || true

  local src_mtime
  src_mtime="$(stat -f %m "$source" 2>/dev/null || echo 0)"

  local cached_mtime
  cached_mtime="$(cat "$cache_meta" 2>/dev/null || echo 0)"

  if [[ -f "$cache_b64" ]] && [[ "$cached_mtime" == "$src_mtime" ]]; then
    cat "$cache_b64" 2>/dev/null || true
    return
  fi

  # Resize to menu-bar-friendly size and base64 encode.
  sips -Z 18 -s format png "$source" --out "$cache_png" >/dev/null 2>&1 || true
  if [[ -f "$cache_png" ]]; then
    /usr/bin/base64 < "$cache_png" | tr -d '\n' > "$cache_b64" 2>/dev/null || true
    echo "$src_mtime" > "$cache_meta" 2>/dev/null || true
  fi

  cat "$cache_b64" 2>/dev/null || true
}

icon_b64_for_file() {
  local source="$1"
  local cache_key="$2"
  local size="${3:-18}"

  if [[ -z "$source" ]] || [[ ! -f "$source" ]]; then
    echo ""
    return
  fi

  local cache_dir="$HAPPY_HOME_DIR/swiftbar/icons"
  local cache_png="$cache_dir/${cache_key}-${size}.png"
  local cache_b64="$cache_dir/${cache_key}-${size}.b64"
  local cache_meta="$cache_dir/${cache_key}-${size}.meta"

  mkdir -p "$cache_dir" 2>/dev/null || true

  local src_mtime
  src_mtime="$(stat -f %m "$source" 2>/dev/null || echo 0)"

  local cached_mtime
  cached_mtime="$(cat "$cache_meta" 2>/dev/null || echo 0)"

  if [[ -f "$cache_b64" ]] && [[ "$cached_mtime" == "$src_mtime" ]]; then
    cat "$cache_b64" 2>/dev/null || true
    return
  fi

  sips -Z "$size" -s format png "$source" --out "$cache_png" >/dev/null 2>&1 || true
  if [[ -f "$cache_png" ]]; then
    /usr/bin/base64 < "$cache_png" | tr -d '\n' > "$cache_b64" 2>/dev/null || true
    echo "$src_mtime" > "$cache_meta" 2>/dev/null || true
  fi

  cat "$cache_b64" 2>/dev/null || true
}

status_icon_b64() {
  local level="$1"  # green | orange | red
  local size="${2:-14}"
  local path="$HAPPY_LOCAL_DIR/extras/swiftbar/icons/happy-$level.png"
  icon_b64_for_file "$path" "happy-$level" "$size"
}
