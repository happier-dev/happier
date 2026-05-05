#!/usr/bin/env bash
#
# recordSessionClip.sh — capture a marketing demo clip from the live Happier
# web app at native 60fps via AVFoundation, encode mp4 + webm.
#
# Why AVFoundation and not agent-browser record:
#   agent-browser record opens a fresh browser context that loses the dev-key
#   auth (MMKV is wiped), so recordings always landed on the login screen.
#   AVFoundation captures the visible chromium window directly, so whatever
#   the persistent --profile context is showing is what gets recorded.
#
# Prereqs (one-time):
#   1. Grant Screen Recording permission to the terminal running this script
#      (System Settings → Privacy & Security → Screen Recording).
#   2. Start agent-browser headed with a persistent profile and log in via the
#      restore-with-secret-key flow:
#        export AGENT_BROWSER_PROFILE=~/.local/share/agent-browser/happier-marketing-v2
#        export AGENT_BROWSER_HEADED=1
#        export AGENT_BROWSER_ARGS="--window-size=1620,1040,--window-position=20,20"
#        agent-browser open "http://happier-repo-remote-dev-d72117acdb.localhost:18829/restore/manual"
#        # paste secret key TKKFL-... in the form, click "Restore Account"
#        # then add the 4327 relay (Settings → Server → Add Relay → http://127.0.0.1:4327 → Add and use)
#        # paste the secret key on /restore/manual once more so the 4327 stack lands
#
# IMPORTANT: run this script from a *plain* terminal (Terminal.app or iTerm) — not
# from inside an Electron desktop client like Claude.app or Cursor. Those apps
# render their own UI window above chromium during ffmpeg's capture window,
# even when chromium is "frontmost" via osascript activate, so the captured
# pixels end up showing the host app instead of the Happier web app.
#
# Usage:
#   recordSessionClip.sh <output-name> <duration-sec>
#
# The browser must already be on the right URL + state before invoking.
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

NAME="${1:?usage: recordSessionClip.sh <name> <seconds>}"
SECONDS_LEN="${2:?usage: recordSessionClip.sh <name> <seconds>}"

OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/videos/demo/sessions"
mkdir -p "$OUT_DIR"

RAW="$(mktemp -t hpdemo-raw-XXXXXX).mp4"
OUT_MP4="$(resolve_output_path "$OUT_DIR" "$NAME" ".mp4")"
OUT_WEBM="$(resolve_output_path "$OUT_DIR" "$NAME" ".webm")"
trap 'rm -f "$RAW"' EXIT

export PATH=/opt/homebrew/bin:$PATH

# Locate the chromium-for-testing window via AppleScript, then derive the
# content rectangle (subtract the title+toolbar chrome). Coordinates returned
# are in macOS *points*; AVFoundation captures in *pixels*, so we multiply by
# the device pixel ratio (read from the page itself).
WIN_INFO=$(osascript <<'OSA'
tell application "System Events"
  set procs to (every process whose name contains "Chrome for Testing")
  repeat with p in procs
    repeat with w in (every window of p)
      set wp to position of w
      set ws to size of w
      return ((item 1 of wp) as string) & " " & ((item 2 of wp) as string) & " " & ((item 1 of ws) as string) & " " & ((item 2 of ws) as string)
    end repeat
  end repeat
end tell
OSA
)

if [[ -z "$WIN_INFO" ]]; then
    echo "error: chromium-for-testing window not found." >&2
    echo "       did you run scripts/recordSession.setup.sh first?" >&2
    exit 1
fi

read -r WX WY WW WH <<<"$WIN_INFO"

# Bring chromium-for-testing to the front. Use the app's bundle name so macOS
# raises it deterministically, then hold focus by also re-activating right
# before ffmpeg begins capture.
/usr/bin/osascript -e 'tell application id "com.google.chrome.for.testing" to activate' >/dev/null 2>&1 || true
sleep 0.6

# Detect screen DPR by comparing physical capture size (3024) to logical screen
# width in points (from Finder desktop bounds). agent-browser's CDP devicePixelRatio
# is overridden by viewport setup and doesn't reflect the actual screen DPR.
LOGICAL_W=$(/usr/bin/osascript -e 'tell application "Finder" to return (item 3 of (get bounds of window of desktop)) as string' 2>/dev/null)
PHYSICAL_W=$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | /usr/bin/grep -E "Capture screen 0" >/dev/null && echo 3024 || echo 3024)
SCREEN_DPR=$(( PHYSICAL_W / LOGICAL_W ))
[[ "$SCREEN_DPR" -lt 1 ]] && SCREEN_DPR=2

# Chrome toolbar height (window decorations + URL bar) in points. Chromium-for-testing
# shows ~78pt of chrome above the content area on macOS (title + tab strip + omnibox).
CHROME_H=78

# Final crop rectangle in screen pixels.
CX=$(( WX * SCREEN_DPR ))
CY=$(( (WY + CHROME_H) * SCREEN_DPR ))
CW=$(( WW * SCREEN_DPR ))
CH=$(( (WH - CHROME_H) * SCREEN_DPR ))

echo "window points: pos=($WX,$WY) size=${WW}x${WH}"
echo "screen: ${LOGICAL_W}pt logical, ${PHYSICAL_W}px physical → DPR=${SCREEN_DPR}"
echo "capture pixels: crop=${CW}:${CH}:${CX}:${CY}"

# Re-front chromium right before ffmpeg starts. We also disable Mission Control
# style focus stealing by NOT spawning a keep-alive (it caused chromium to
# lose its persistent profile, wiping auth state).
/usr/bin/osascript -e 'tell application id "com.google.chrome.for.testing" to activate' >/dev/null 2>&1 || true
sleep 0.4

# 1. Capture native 60fps from screen 0. -capture_cursor 0 keeps a clean frame
#    (no mouse pointer drifting through the marketing video). Pre-cropping at
#    capture time would be ideal but AVFoundation has no native region flag,
#    so we record full screen and crop in the encode step below.
ffmpeg -y \
    -f avfoundation -framerate 60 -capture_cursor 0 -i "4" \
    -t "$SECONDS_LEN" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    "$RAW" \
    -loglevel warning -hide_banner

# 2. Crop + downscale to 2× the device-pixel size (so output stays sharp on
#    retina but file size is bounded), encode mp4 (h264).
ffmpeg -y -i "$RAW" \
    -filter:v "crop=${CW}:${CH}:${CX}:${CY},scale=trunc(iw/2/2)*2:trunc(ih/2/2)*2" \
    -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p \
    -movflags +faststart \
    -an \
    "$OUT_MP4" \
    -loglevel warning -hide_banner

# 3. Same crop + scale, encode webm (vp9).
ffmpeg -y -i "$RAW" \
    -filter:v "crop=${CW}:${CH}:${CX}:${CY},scale=trunc(iw/2/2)*2:trunc(ih/2/2)*2" \
    -c:v libvpx-vp9 -b:v 0 -crf 32 -pix_fmt yuv420p \
    -an \
    "$OUT_WEBM" \
    -loglevel warning -hide_banner

echo ""
echo "Wrote $OUT_MP4"
echo "Wrote $OUT_WEBM"
ls -lh "$OUT_MP4" "$OUT_WEBM"
