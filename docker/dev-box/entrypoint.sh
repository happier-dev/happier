#!/bin/sh
set -eu

providers_raw="${HAPPIER_PROVIDER_CLIS:-}"
providers="$(printf "%s" "$providers_raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

if [ -n "$providers" ]; then
  if ! command -v happier >/dev/null 2>&1; then
    echo "[dev-box] Error: happier CLI not found on PATH; cannot install provider CLIs." >&2
    exit 1
  fi

  old_ifs="$IFS"
  IFS=","
  for p in $providers; do
    if [ -z "$p" ]; then
      continue
    fi
    echo "[dev-box] Installing provider CLI via happier: $p"
    happier install provider "$p" >/dev/null
  done
  IFS="$old_ifs"
fi

exec "$@"
