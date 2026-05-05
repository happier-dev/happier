#!/usr/bin/env bash
#
# recordAllClips.sh — drive agent-browser through the four marketing scenes
# and capture each as a 4-second 60fps clip via recordSessionClip.sh.
#
# RUN FROM A PLAIN TERMINAL (Terminal.app or iTerm), not from inside an
# Electron client. Otherwise the host app's window covers chromium during
# the capture and you end up recording the wrong pixels.
#
# Prereqs:
#   - agent-browser is running with the persistent profile, authenticated to
#     the demo-projects (4327) account, in dark mode.
#   - See recordSessionClip.sh header for the auth flow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="http://happier-repo-remote-dev-d72117acdb.localhost:18829"

# Quick guard: refuse to run if the host process is Claude.app or Cursor
# (Electron clients) since the recording will capture them instead of chromium.
HOST_APP="$(/usr/bin/osascript -e 'tell application "System Events" to return name of (first process whose frontmost is true)' 2>/dev/null || echo unknown)"
case "$HOST_APP" in
    Claude|Cursor|*VS\ Code*)
        echo "error: detected host app '$HOST_APP' which renders above chromium." >&2
        echo "       run this from Terminal.app or iTerm instead." >&2
        exit 1
        ;;
esac

resize_window() {
    local W="$1" H="$2"
    /usr/bin/osascript <<OSA >/dev/null 2>&1
tell application "System Events"
  tell window 1 of (first process whose name contains "Chrome for Testing")
    set position to {20, 20}
    set size to {$W, $H}
  end tell
end tell
OSA
    sleep 1
}

navigate() {
    agent-browser open "$1" >/dev/null 2>&1
    sleep 4
}

queue_hover_animation() {
    agent-browser eval "(() => {
        setTimeout(async () => {
            const items = document.querySelectorAll('[data-testid^=\"session-list-item-\"]');
            for (let i = 0; i < 5 && i < items.length; i++) {
                items[i].dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
                await new Promise(r => setTimeout(r, 350));
                items[i].dispatchEvent(new MouseEvent('mouseleave', {bubbles:true}));
            }
        }, 800);
        return 'queued';
    })()" >/dev/null 2>&1
}

queue_scroll_animation() {
    agent-browser eval "(() => {
        setTimeout(async () => {
            const sc = document.scrollingElement || document.body;
            let y = 0;
            const start = Date.now();
            while (Date.now() - start < 2200) {
                y += 4;
                sc.scrollTop = y;
                await new Promise(r => requestAnimationFrame(r));
            }
        }, 800);
        return 'queued';
    })()" >/dev/null 2>&1
}

# 1. Desktop session list (1600x1000 @ 2x)
agent-browser set viewport 1600 1000 2 >/dev/null 2>&1
sleep 1
resize_window 1492 950
navigate "$BASE_URL/"
queue_hover_animation
"$SCRIPT_DIR/recordSessionClip.sh" desktop-session-list 4

# 2. Phone session list (393x852 @ 3x — but window must be wider than chrome's
#    minimum width, so the page renders in a portion of the window)
agent-browser set viewport 393 852 3 >/dev/null 2>&1
sleep 1
resize_window 600 930
navigate "$BASE_URL/"
queue_scroll_animation
"$SCRIPT_DIR/recordSessionClip.sh" phone-session-list 4

# 3. Desktop permission card (lantern push-notifications session)
agent-browser set viewport 1600 1000 2 >/dev/null 2>&1
sleep 1
resize_window 1492 950
navigate "$BASE_URL/session/cmoh32h2101tctm35cu8ftbbp"
"$SCRIPT_DIR/recordSessionClip.sh" desktop-permission-card-claude 4

# 4. Phone permission card
agent-browser set viewport 393 852 3 >/dev/null 2>&1
sleep 1
resize_window 600 930
navigate "$BASE_URL/session/cmoh32h2101tctm35cu8ftbbp"
"$SCRIPT_DIR/recordSessionClip.sh" phone-permission-card-claude 4

echo ""
echo "Done. Output:"
ls -la "$SCRIPT_DIR/../public/videos/demo/sessions/"
