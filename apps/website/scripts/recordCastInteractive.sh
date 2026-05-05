#!/usr/bin/env bash
#
# recordCastInteractive.sh — record an asciinema cast of a real provider CLI
# (`claude`, `codex`, or `opencode`) running interactively. Captures the full
# TUI chrome (input box, status line, streaming response, tool-call cards) by
# letting the user prompt land in the TUI as keystrokes via `expect`.
#
# We invoke the *native* CLIs directly rather than going through the `hdev`
# wrapper. The wrapper introduces a daemon-connection step that emits no
# per-character output during the response phase under expect, so streaming
# never makes it into the cast. The bare CLIs talk straight to their own
# auth/transport and emit the byte stream we want.
#
# Usage:
#   recordCastInteractive.sh <output-name> <provider> <project> <prompt>
#
# Example:
#   recordCastInteractive.sh claude-patio claude patio \
#     "Briefly list the files under components/dashboard"
#
# Output: apps/website/public/casts/<output-name>.cast (asciicast-v2)

set -euo pipefail

validate_output_name() {
    local name="$1"
    [[ "$name" == "$(basename -- "$name")" ]] || {
        echo "output name must be a basename: $name" >&2
        exit 1
    }
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
        echo "output name contains unsupported characters: $name" >&2
        exit 1
    }
}

resolve_output_path() {
    local target_dir="$1"
    local name="$2"
    local extension="$3"

    validate_output_name "$name"

    local resolved_dir resolved_output resolved_parent
    resolved_dir="$(cd "$target_dir" && pwd -P)"
    resolved_output="$resolved_dir/$name$extension"
    resolved_parent="${resolved_output%/*}"
    [[ "$resolved_parent" == "$resolved_dir" ]] || {
        echo "output path escapes target directory: $resolved_output" >&2
        exit 1
    }
    printf '%s\n' "$resolved_output"
}

NAME="${1:?usage: <output-name> <provider> <project> <prompt>}"
PROVIDER="${2:?usage: <output-name> <provider> <project> <prompt>}"
PROJECT="${3:?usage: <output-name> <provider> <project> <prompt>}"
PROMPT="${4:?usage: <output-name> <provider> <project> <prompt>}"

CAST_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/casts"
mkdir -p "$CAST_DIR"
OUT="$(resolve_output_path "$CAST_DIR" "$NAME" ".cast")"

PROJECT_DIR="$HOME/Documents/Development/happier-demo-projects/$PROJECT"
[[ -d "$PROJECT_DIR" ]] || { echo "no such project: $PROJECT_DIR" >&2; exit 1; }

# Resolve the native CLI binary plus any flags needed to bypass third-party
# wrappers. Both /Applications/cmux.app/.../claude and the system `which claude`
# resolve to a cmux-instrumented binary that injects 6 SessionStart/Stop hooks
# (each up to 10s timeout) on boot, which can stretch TUI startup to 100s+
# under expect's non-interactive PTY. We use:
#   - /Users/leeroy/.local/bin/claude --bare  → skips hooks/LSP/auto-memory.
case "$PROVIDER" in
    claude)
        PROVIDER_BIN="$HOME/.local/bin/claude"
        PROVIDER_ARGS=(--bare)
        ;;
    codex)
        PROVIDER_BIN="$(/usr/bin/which codex)"
        PROVIDER_ARGS=()
        ;;
    opencode)
        PROVIDER_BIN="$HOME/.opencode/bin/opencode"
        PROVIDER_ARGS=()
        ;;
    *)
        echo "unknown provider: $PROVIDER (expected claude|codex|opencode)" >&2; exit 1
        ;;
esac
[[ -x "$PROVIDER_BIN" ]] || { echo "no such binary: $PROVIDER_BIN" >&2; exit 1; }

# Driver script: launches hdev <provider> and types the prompt with a realistic
# per-char delay, then waits for the agent to finish and exits the TUI.
DRIVER="$(mktemp -t hdev-driver-XXXXXX.expect)"
trap 'rm -f "$DRIVER"' EXIT

cat > "$DRIVER" <<'EXPECT'
#!/usr/bin/expect -f
# Realistic typing cadence: 60-100ms per key with bursts of pauses.
set send_human {.06 .04 .8 .03 .14}
set timeout 300

set projectDir [lindex $argv 0]
set providerBin [lindex $argv 1]
set prompt [lindex $argv 2]
set providerArgs [lrange $argv 3 end]

# Force a fixed PTY size so the recorded cast has predictable dimensions
# matching the marketing terminal frame's xterm grid.
stty cols 80 rows 24

cd $projectDir

# 1. Launch the native provider CLI. With cmux hooks bypassed via --bare,
#    Claude boots in 2-5s instead of 100s.
spawn $providerBin {*}$providerArgs

# 2. Wait for the TUI input prompt to render. The trim pass afterwards
#    strips any leading idle time so a generous wait costs nothing.
sleep 15

# 3. Type the prompt with human-like timing.
send -h -- $prompt

# 4. Pause briefly, then submit.
sleep 0.6
send -- "\r"

# 5. Let the agent run. Most prompts complete in 20-90s of streaming.
sleep 90

# 6. Exit the TUI gracefully. Ctrl+C twice is the safe escape from any TUI.
send -- "\x03"
sleep 0.3
send -- "\x03"
expect eof
EXPECT
chmod +x "$DRIVER"

driver_command=("$DRIVER" "$PROJECT_DIR" "$PROVIDER_BIN" "$PROMPT")
if ((${#PROVIDER_ARGS[@]} > 0)); then
    driver_command+=("${PROVIDER_ARGS[@]}")
fi
printf -v DRIVER_COMMAND_STR "%q " "${driver_command[@]}"
DRIVER_COMMAND_STR="${DRIVER_COMMAND_STR% }"

echo "Recording $OUT ..."
echo "  provider: $PROVIDER ($PROVIDER_BIN)"
echo "  project:  $PROJECT_DIR"
echo "  prompt:   $PROMPT"
echo ""

# Use asciinema v2 format (absolute timestamps) — simpler to parse on the
# browser side and matches our CastPlayer.
#
# Wrap asciinema in `script -q /dev/null` so it sees a real PTY on stdin.
# Without this, when invoked from a non-TTY environment (eg. tools that
# don't allocate a PTY), asciinema falls back to "headless mode" which
# breaks TUIs like Claude Code: they detect non-interactive stdin and
# either refuse to render or buffer all output. The script wrapper
# allocates a PTY so the TUI behaves identically to a terminal session.
/usr/bin/script -q /dev/null /opt/homebrew/bin/asciinema rec \
    -f asciicast-v2 \
    --overwrite \
    --idle-time-limit 2 \
    --rows 24 \
    --cols 80 \
    -c "$DRIVER_COMMAND_STR" \
    "$OUT"

# Strip leading dead time (TUI boot) so playback starts on the first
# rendered UI rather than 70s of silence.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
/usr/bin/python3 "$SCRIPT_DIR/trimCast.py" "$OUT"
/usr/bin/python3 "$SCRIPT_DIR/sanitizeCast.py" "$OUT"

echo ""
echo "Wrote $OUT ($(wc -l < "$OUT") events)"
