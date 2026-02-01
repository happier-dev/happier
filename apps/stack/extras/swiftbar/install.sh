#!/bin/bash

# ============================================================================
# Hapsta SwiftBar Plugin Installer
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SOURCE="$SCRIPT_DIR/hapsta.5s.sh"
# No legacy fallback: always install the primary hapsta plugin.
# Default refresh: 5 minutes (good baseline; still refreshes instantly on open).
# You can override:
#   HAPPIER_STACK_SWIFTBAR_INTERVAL=30s ./install.sh
PLUGIN_INTERVAL="${HAPPIER_STACK_SWIFTBAR_INTERVAL:-5m}"
PLUGIN_BASENAME="${HAPPIER_STACK_SWIFTBAR_PLUGIN_BASENAME:-hapsta}"
PLUGIN_FILE="${PLUGIN_BASENAME}.${PLUGIN_INTERVAL}.sh"

# Optional: install a wrapper plugin instead of copying the source.
# This is useful for sandbox/test installs so the plugin can be pinned to a specific home/canonical dir
# even under SwiftBar's minimal environment.
WRAPPER="${HAPPIER_STACK_SWIFTBAR_PLUGIN_WRAPPER:-0}"

escape_single_quotes() {
  # Escape a string so it can be safely embedded inside single quotes in a bash script.
  # e.g. abc'def -> abc'"'"'def
  printf "%s" "$1" | sed "s/'/'\"'\"'/g"
}

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║            Hapsta SwiftBar Plugin Installer                ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running on macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo -e "${RED}Error: This installer only works on macOS${NC}"
    exit 1
fi

# Check if SwiftBar is installed
check_swiftbar() {
    if [[ -d "/Applications/SwiftBar.app" ]]; then
        return 0
    elif mdfind "kMDItemCFBundleIdentifier == 'com.ameba.SwiftBar'" 2>/dev/null | grep -q ".app"; then
        return 0
    else
        return 1
    fi
}

# Get SwiftBar plugins directory
get_plugins_dir() {
    # Default location
    local default_dir="$HOME/Library/Application Support/SwiftBar/Plugins"
    
    # Check if SwiftBar has a custom plugins directory set
    local plist_dir
    plist_dir=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || echo "")
    
    if [[ -n "$plist_dir" ]] && [[ -d "$plist_dir" ]]; then
        echo "$plist_dir"
    elif [[ -d "$default_dir" ]]; then
        echo "$default_dir"
    else
        echo ""
    fi
}

# Step 1: Check/Install SwiftBar
echo -e "${YELLOW}Step 1: Checking for SwiftBar...${NC}"

if check_swiftbar; then
    echo -e "${GREEN}✓ SwiftBar is already installed${NC}"
else
    echo -e "${YELLOW}SwiftBar is not installed.${NC}"
    echo ""
    echo "Would you like to install SwiftBar via Homebrew? (y/n)"
    read -r INSTALL_CHOICE
    
    if [[ "$INSTALL_CHOICE" == "y" ]] || [[ "$INSTALL_CHOICE" == "Y" ]]; then
        if ! command -v brew &>/dev/null; then
            echo -e "${RED}Error: Homebrew is not installed.${NC}"
            echo "Please install Homebrew first: https://brew.sh"
            echo "Or install SwiftBar manually: https://swiftbar.app"
            exit 1
        fi
        
        echo "Installing SwiftBar..."
        brew install --cask swiftbar
        
        if ! check_swiftbar; then
            echo -e "${RED}Error: SwiftBar installation failed${NC}"
            exit 1
        fi
        echo -e "${GREEN}✓ SwiftBar installed successfully${NC}"
    else
        echo ""
        echo "Please install SwiftBar manually:"
        echo "  - Homebrew: brew install --cask swiftbar"
        echo "  - Direct download: https://swiftbar.app"
        echo ""
        exit 1
    fi
fi

echo ""

# Step 2: Get or create plugins directory
echo -e "${YELLOW}Step 2: Setting up plugins directory...${NC}"

PLUGINS_DIR=$(get_plugins_dir)

if [[ -z "$PLUGINS_DIR" ]]; then
    PLUGINS_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
    echo "Creating plugins directory: $PLUGINS_DIR"
    mkdir -p "$PLUGINS_DIR"
fi

echo -e "${GREEN}✓ Plugins directory: $PLUGINS_DIR${NC}"
echo ""

# Step 3: Install the plugin
echo -e "${YELLOW}Step 3: Installing Hapsta plugin...${NC}"

PLUGIN_DEST="$PLUGINS_DIR/$PLUGIN_FILE"

EXISTED=0
if [[ -f "$PLUGIN_DEST" ]]; then
    EXISTED=1
fi

SHOULD_INSTALL=1
if [[ "$EXISTED" == "1" ]]; then
    echo "Plugin already exists at $PLUGIN_DEST"
    if [[ "$FORCE" == "1" ]] || [[ ! -t 0 ]]; then
        SHOULD_INSTALL=1
    else
        echo "Would you like to overwrite it? (y/n)"
        read -r OVERWRITE_CHOICE
        if [[ "$OVERWRITE_CHOICE" != "y" ]] && [[ "$OVERWRITE_CHOICE" != "Y" ]]; then
            SHOULD_INSTALL=0
            echo "Skipping plugin installation."
        fi
    fi
fi

if [[ "$SHOULD_INSTALL" == "1" ]]; then
    if [[ "$WRAPPER" == "1" ]]; then
        # Generate a wrapper plugin that pins env vars and executes the real plugin source.
        HOME_DIR_VAL="${HAPPIER_STACK_HOME_DIR:-$HOME/.happier-stack}"
        CANONICAL_DIR_VAL="${HAPPIER_STACK_CANONICAL_HOME_DIR:-$HOME/.happier-stack}"
        SANDBOX_DIR_VAL="${HAPPIER_STACK_SANDBOX_DIR:-}"
        WORKSPACE_DIR_VAL="${HAPPIER_STACK_WORKSPACE_DIR:-}"
        RUNTIME_DIR_VAL="${HAPPIER_STACK_RUNTIME_DIR:-}"
        STORAGE_DIR_VAL="${HAPPIER_STACK_STORAGE_DIR:-}"

        if [[ -n "$SANDBOX_DIR_VAL" ]]; then
          [[ -z "$WORKSPACE_DIR_VAL" ]] && WORKSPACE_DIR_VAL="${SANDBOX_DIR_VAL%/}/workspace"
          [[ -z "$RUNTIME_DIR_VAL" ]] && RUNTIME_DIR_VAL="${SANDBOX_DIR_VAL%/}/runtime"
          [[ -z "$STORAGE_DIR_VAL" ]] && STORAGE_DIR_VAL="${SANDBOX_DIR_VAL%/}/storage"
        fi
        HOME_DIR_ESC="$(escape_single_quotes "$HOME_DIR_VAL")"
        CANONICAL_DIR_ESC="$(escape_single_quotes "$CANONICAL_DIR_VAL")"
        SANDBOX_DIR_ESC="$(escape_single_quotes "$SANDBOX_DIR_VAL")"
        WORKSPACE_DIR_ESC="$(escape_single_quotes "$WORKSPACE_DIR_VAL")"
        RUNTIME_DIR_ESC="$(escape_single_quotes "$RUNTIME_DIR_VAL")"
        STORAGE_DIR_ESC="$(escape_single_quotes "$STORAGE_DIR_VAL")"
        SRC_ESC="$(escape_single_quotes "$PLUGIN_SOURCE")"
        BASENAME_ESC="$(escape_single_quotes "$PLUGIN_BASENAME")"

        cat >"$PLUGIN_DEST" <<EOF
#!/bin/bash
set -euo pipefail
export HAPPIER_STACK_HOME_DIR='$HOME_DIR_ESC'
export HAPPIER_STACK_CANONICAL_HOME_DIR='$CANONICAL_DIR_ESC'
export HAPPIER_STACK_SWIFTBAR_PLUGIN_BASENAME='$BASENAME_ESC'
if [[ -n '$SANDBOX_DIR_ESC' ]]; then
  export HAPPIER_STACK_SANDBOX_DIR='$SANDBOX_DIR_ESC'
fi
if [[ -n '$WORKSPACE_DIR_ESC' ]]; then
  export HAPPIER_STACK_WORKSPACE_DIR='$WORKSPACE_DIR_ESC'
fi
if [[ -n '$RUNTIME_DIR_ESC' ]]; then
  export HAPPIER_STACK_RUNTIME_DIR='$RUNTIME_DIR_ESC'
fi
if [[ -n '$STORAGE_DIR_ESC' ]]; then
  export HAPPIER_STACK_STORAGE_DIR='$STORAGE_DIR_ESC'
fi
# Prevent any re-exec into a "real" install when testing.
export HAPPIER_STACK_CLI_ROOT_DISABLE="1"
exec '$SRC_ESC'
EOF
        chmod +x "$PLUGIN_DEST"
        if [[ "$EXISTED" == "1" ]]; then
            echo -e "${GREEN}✓ Plugin updated (wrapper)${NC}"
        else
            echo -e "${GREEN}✓ Plugin installed (wrapper)${NC}"
        fi
    else
        cp "$PLUGIN_SOURCE" "$PLUGIN_DEST"
        chmod +x "$PLUGIN_DEST"
        if [[ "$EXISTED" == "1" ]]; then
            echo -e "${GREEN}✓ Plugin updated${NC}"
        else
            echo -e "${GREEN}✓ Plugin installed${NC}"
        fi
    fi
fi

#
# Ensure helper scripts are executable (SwiftBar menu actions rely on this).
# The repo usually tracks +x, but home installs can lose mode bits depending on how assets are copied.
#
chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null || true

echo ""

# Step 4: Launch SwiftBar if not running
echo -e "${YELLOW}Step 4: Starting SwiftBar...${NC}"

if ! pgrep -x "SwiftBar" > /dev/null; then
    echo "Launching SwiftBar..."
    open -a SwiftBar
    sleep 2
    echo -e "${GREEN}✓ SwiftBar started${NC}"
else
    echo -e "${GREEN}✓ SwiftBar is already running${NC}"
    echo "  Refreshing plugins..."
    # Trigger a refresh by touching the plugin file
    touch "$PLUGIN_DEST"
fi

echo ""

# Done!
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Installation Complete!                   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "You should now see a 😊 (or 😢) icon in your menu bar."
echo ""
echo "The plugin refreshes every ${PLUGIN_INTERVAL}."
echo "Click it to see the full menu with controls."
echo ""
echo -e "${BLUE}Tips:${NC}"
echo "  • Right-click the icon for SwiftBar options"
echo "  • The plugin is located at: $PLUGIN_DEST"
echo "  • Edit the script to customize behavior"
echo ""
