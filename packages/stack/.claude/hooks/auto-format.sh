#!/usr/bin/env bash
# Edison Hook: auto-format
# Type: PostToolUse
# Description: Auto-format code after modifications

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "auto-format" "session"
fi

# Parse input JSON (with timeout to prevent hanging)
INPUT=$(timeout 1 cat 2>/dev/null || echo '{}')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool' 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | jq -r '.args.file_path // ""' 2>/dev/null || echo "")


# Only for Write/Edit
if [[ "$TOOL_NAME" != "Write" && "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

# Check if file matches patterns using bash glob matching
SHOULD_FORMAT=false
case "$FILE_PATH" in
*.ts|*.tsx|*.js|*.jsx|*.___never_match___)
    SHOULD_FORMAT=true
    ;;
esac

if [[ "$SHOULD_FORMAT" != "true" ]]; then
  exit 0
fi

echo "🎨 Auto-formatting: $FILE_PATH"

# Run formatters
if command -v prettier &> /dev/null; then
  prettier --write "$FILE_PATH" 2>&1 || true
fi
if command -v eslint &> /dev/null; then
  eslint --write "$FILE_PATH" 2>&1 || true
fi

exit 0