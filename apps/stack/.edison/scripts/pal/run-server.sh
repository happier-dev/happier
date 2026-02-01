#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "SCRIPT_DIR: ${SCRIPT_DIR}"
echo "PROJECT_ROOT: ${PROJECT_ROOT}"

# Ensure PATH includes common locations for CLIs
# This is important when Cursor/VS Code is launched from GUI (not terminal)
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"

# Add NVM path if it exists
if [ -d "$HOME/.nvm/versions/node" ]; then
  # Find the latest node version in NVM
  NVM_NODE_VERSION=$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -1)
  if [ -n "$NVM_NODE_VERSION" ]; then
    export PATH="$HOME/.nvm/versions/node/$NVM_NODE_VERSION/bin:$PATH"
  fi
fi

# Optional project-specific environment overrides
PAL_ROOT="${PROJECT_ROOT}/.pal"
echo "PAL_ROOT: ${PAL_ROOT}"
if [[ -f "${PAL_ROOT}/.env" ]]; then
  echo "Loading .env file: ${PAL_ROOT}/.env"
  # shellcheck disable=SC1090
  set -a  # Export all variables
  source "${PAL_ROOT}/.env"
  set +a
fi

# Explicitly export API keys and config paths
export GEMINI_API_KEY
export OPENAI_API_KEY
export XAI_API_KEY
export OPENROUTER_API_KEY
export CLI_CLIENTS_CONFIG_PATH="${PAL_ROOT}/conf/cli_clients"
export LOG_LEVEL="${LOG_LEVEL:-INFO}"

# Preserve existing DISABLED_TOOLS if provided, otherwise default to a safe subset.
# Only enable: clink, listmodels, version (the latter two are essential upstream and cannot be disabled).
export DISABLED_TOOLS="${DISABLED_TOOLS:-chat,thinkdeep,planner,consensus,codereview,precommit,debug,secaudit,docgen,analyze,refactor,tracer,testgen,challenge,apilookup}"

# Point Pal to project-scoped configs.
export CLI_CLIENTS_CONFIG_PATH="${CLI_CLIENTS_CONFIG_PATH:-${PAL_ROOT}/conf/cli_clients}"
export PAL_CONFIG_ROOT="${PAL_CONFIG_ROOT:-${PAL_ROOT}/conf}"

# Set PAL_WORKING_DIR with validation (optional - defaults to project root)
if [[ -n "${PAL_WORKING_DIR:-}" ]]; then
  # If provided, validate it
  if ! PAL_WORKING_DIR="$(cd "${PAL_WORKING_DIR}" 2>/dev/null && pwd)"; then
    echo "❌ PAL_WORKING_DIR does not resolve to a directory: ${PAL_WORKING_DIR}" >&2
    exit 1
  fi

  if ! git -C "${PAL_WORKING_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "⚠️  Warning: PAL_WORKING_DIR is not inside a git worktree: ${PAL_WORKING_DIR}" >&2
  fi

  # Validate worktree shares same git metadata (only if both are git repos)
  repo_common="$(git -C "${PROJECT_ROOT}" rev-parse --git-common-dir 2>/dev/null || true)"
  worktree_common="$(git -C "${PAL_WORKING_DIR}" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "${repo_common}" && -n "${worktree_common}" && "${repo_common}" != "${worktree_common}" ]]; then
    echo "⚠️  Warning: PAL_WORKING_DIR (${PAL_WORKING_DIR}) does not share git metadata with repo root ${PROJECT_ROOT}" >&2
  fi
else
  # Default to project root if not set
  PAL_WORKING_DIR="${PROJECT_ROOT}"
fi

export PAL_WORKING_DIR

# Locate Pal MCP server installation
# Priority:
#  1) .edison/tools/pal-mcp-server (local project installation - highest priority)
#  2) PAL_MCP_SERVER_DIR (if set in .mcp.json - for custom/development setups)
#  3) ~/pal-mcp-server (standard clone location from README Option A)
#  4) uvx instant setup (Option B from README)
#  5) FAIL with helpful message

# Check for local .edison/tools/pal-mcp-server FIRST (relocatable setup)
EDISON_ROOT="${PROJECT_ROOT}/.edison"
if [[ -d "${EDISON_ROOT}/tools/pal-mcp-server" ]]; then
  SERVER_DIR="${EDISON_ROOT}/tools/pal-mcp-server"

  # Activate venv and launch from local .edison location
  if [[ ! -f "${SERVER_DIR}/.venv/bin/activate" ]]; then
    echo "❌ Missing virtualenv at ${SERVER_DIR}/.venv. Run: ${EDISON_ROOT}/scripts/pal/setup.sh" >&2
    exit 1
  fi
  source "${SERVER_DIR}/.venv/bin/activate"
  export PYTHONPATH="${SERVER_DIR}:${PYTHONPATH:-}"

  if [[ -x "${SERVER_DIR}/.venv/bin/python" ]]; then
    PY_BIN="${SERVER_DIR}/.venv/bin/python"
  elif [[ -x "${SERVER_DIR}/.venv/bin/python3" ]]; then
    PY_BIN="${SERVER_DIR}/.venv/bin/python3"
  else
    echo "❌ No python found in ${SERVER_DIR}/.venv" >&2
    exit 1
  fi
  exec "${PY_BIN}" "${SERVER_DIR}/server.py" "$@"

elif [[ -n "${PAL_MCP_SERVER_DIR:-}" ]]; then
  # User explicitly set PAL_MCP_SERVER_DIR (e.g., in .mcp.json)
  if [[ ! -d "${PAL_MCP_SERVER_DIR}" ]]; then
    echo "❌ PAL_MCP_SERVER_DIR is set but directory does not exist: ${PAL_MCP_SERVER_DIR}" >&2
    exit 1
  fi
  SERVER_DIR="${PAL_MCP_SERVER_DIR}"

  # Activate venv and launch from cloned location
  if [[ ! -f "${SERVER_DIR}/.venv/bin/activate" ]]; then
    echo "❌ Missing virtualenv at ${SERVER_DIR}/.venv. Run: cd ${SERVER_DIR} && ./run-server.sh" >&2
    exit 1
  fi
  source "${SERVER_DIR}/.venv/bin/activate"
  export PYTHONPATH="${SERVER_DIR}:${PYTHONPATH:-}"

  if [[ -x "${SERVER_DIR}/.venv/bin/python" ]]; then
    PY_BIN="${SERVER_DIR}/.venv/bin/python"
  elif [[ -x "${SERVER_DIR}/.venv/bin/python3" ]]; then
    PY_BIN="${SERVER_DIR}/.venv/bin/python3"
  else
    echo "❌ No python found in ${SERVER_DIR}/.venv" >&2
    exit 1
  fi
  exec "${PY_BIN}" "${SERVER_DIR}/server.py" "$@"

elif [[ -d "${HOME}/pal-mcp-server" ]]; then
  # Standard installation location (Option A from README)
  SERVER_DIR="${HOME}/pal-mcp-server"

  # Activate venv and launch from cloned location
  if [[ ! -f "${SERVER_DIR}/.venv/bin/activate" ]]; then
    echo "❌ Missing virtualenv at ${SERVER_DIR}/.venv. Run: cd ${SERVER_DIR} && ./run-server.sh" >&2
    exit 1
  fi
  source "${SERVER_DIR}/.venv/bin/activate"
  export PYTHONPATH="${SERVER_DIR}:${PYTHONPATH:-}"

  if [[ -x "${SERVER_DIR}/.venv/bin/python" ]]; then
    PY_BIN="${SERVER_DIR}/.venv/bin/python"
  elif [[ -x "${SERVER_DIR}/.venv/bin/python3" ]]; then
    PY_BIN="${SERVER_DIR}/.venv/bin/python3"
  else
    echo "❌ No python found in ${SERVER_DIR}/.venv" >&2
    exit 1
  fi
  exec "${PY_BIN}" "${SERVER_DIR}/server.py" "$@"

else
  # Fallback to uvx (Option B from README) - instant setup, no clone needed
  for uvx_path in $(command -v uvx 2>/dev/null) "$HOME/.local/bin/uvx" "/opt/homebrew/bin/uvx" "/usr/local/bin/uvx"; do
    if [[ -x "$uvx_path" ]]; then
      exec "$uvx_path" --from git+https://github.com/BeehiveInnovations/pal-mcp-server.git pal-mcp-server "$@"
    fi
  done

  # No uvx found - fail with installation instructions
  echo "❌ Could not locate pal-mcp-server installation and uvx is not available." >&2
  echo "" >&2
  echo "   Please install pal-mcp-server using one of these methods:" >&2
  echo "" >&2
  echo "   Option A: Standard Clone (Recommended)" >&2
  echo "   ---------" >&2
  echo "   git clone https://github.com/BeehiveInnovations/pal-mcp-server.git ~/pal-mcp-server" >&2
  echo "   cd ~/pal-mcp-server && ./run-server.sh" >&2
  echo "" >&2
  echo "   Option B: Install uvx (Instant Setup)" >&2
  echo "   ---------" >&2
  echo "   pip install uv" >&2
  echo "   # Then restart Claude Code - it will auto-use uvx" >&2
  echo "" >&2
  echo "   Option C: Custom Location" >&2
  echo "   ---------" >&2
  echo "   Clone to your path and set PAL_MCP_SERVER_DIR in .mcp.json" >&2
  echo "" >&2
  exit 1
fi
