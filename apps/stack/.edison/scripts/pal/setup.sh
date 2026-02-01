#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDISON_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PAL_SERVER_DIR="${EDISON_ROOT}/tools/pal-mcp-server"

echo "🔧 Setting up pal-mcp-server in ${PAL_SERVER_DIR}"

# Validate pal-mcp-server exists
if [[ ! -d "${PAL_SERVER_DIR}" ]]; then
  echo "❌ pal-mcp-server not found at ${PAL_SERVER_DIR}"
  exit 1
fi

# Check for requirements.txt
if [[ ! -f "${PAL_SERVER_DIR}/requirements.txt" ]]; then
  echo "❌ requirements.txt not found at ${PAL_SERVER_DIR}/requirements.txt"
  exit 1
fi

# Create virtualenv
echo "📦 Creating virtual environment..."
python3 -m venv "${PAL_SERVER_DIR}/.venv"

# Activate and install
echo "📥 Installing dependencies..."
source "${PAL_SERVER_DIR}/.venv/bin/activate"
pip install --upgrade pip
pip install -r "${PAL_SERVER_DIR}/requirements.txt"

echo "✅ pal-mcp-server setup complete"
echo ""
echo "To use this with Claude Code MCP:"
echo "1. Copy .edison/.mcp.json to your project root or Claude config"
echo "2. Ensure PAL_WORKING_DIR is set in your environment"
echo "3. Restart Claude Code to pick up the new MCP server"
