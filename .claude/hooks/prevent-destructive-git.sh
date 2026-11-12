#!/usr/bin/env bash
# Hook: prevent-destructive-git
# Type: PreToolUse
# Description: Block destructive git commands unless explicitly approved.
# Blocking: YES

set -u

HOOK_PATH=${BASH_SOURCE[0]}
if [[ "$HOOK_PATH" != */* ]]; then HOOK_PATH=./$HOOK_PATH; fi
if [[ -t 0 ]]; then
  exec node "${HOOK_PATH%/*}/prevent-destructive-git.mjs" <<<'{}'
else
  exec node "${HOOK_PATH%/*}/prevent-destructive-git.mjs"
fi
