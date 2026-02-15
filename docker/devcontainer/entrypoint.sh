#!/bin/sh
set -eu

providers_raw="${HAPPIER_PROVIDER_CLIS:-}"
providers="$(printf "%s" "$providers_raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

if [ -n "$providers" ]; then
  if command -v hstack >/dev/null 2>&1; then
    echo "[devcontainer] Installing provider CLIs via hstack: $providers"
    hstack providers install --providers="$providers" >/dev/null
  else
    # Fallback for older images: keep minimal install logic here.
    # (Prefer using hstack so the install recipes stay centralized.)
    echo "[devcontainer] Warning: hstack not found; falling back to legacy provider install logic." >&2
    old_ifs="$IFS"
    IFS=","
    for p in $providers; do
      case "$p" in
        "" )
          ;;
        "claude" )
          if command -v claude >/dev/null 2>&1; then
            continue
          fi
          echo "[devcontainer] Installing Claude Code CLI (native installer)..."
          curl -fsSL https://claude.ai/install.sh | bash
          ;;
        "codex" )
          if command -v codex >/dev/null 2>&1; then
            continue
          fi
          echo "[devcontainer] Installing OpenAI Codex CLI (@openai/codex)..."
          npm install -g @openai/codex
          ;;
        "gemini" )
          if command -v gemini >/dev/null 2>&1; then
            continue
          fi
          echo "[devcontainer] Installing Google Gemini CLI (@google/gemini-cli)..."
          npm install -g @google/gemini-cli
          ;;
        * )
          echo "[devcontainer] Unknown provider CLI: $p" >&2
          return 1
          ;;
      esac
    done
    IFS="$old_ifs"
  fi
fi

exec "$@"
