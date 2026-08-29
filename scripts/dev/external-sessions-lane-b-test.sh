#!/bin/sh
# External Sessions Lane B focused-test helper (delete after lane closeout).
# Routes focused vitest selections through the canonical package test script so
# no `*:local` script or bare vitest is invoked directly.
#
# Usage:
#   ./scripts/dev/external-sessions-lane-b-test.sh <package-dir> [vitest args...]
# Examples (RED→GREEN runs for this lane):
#   ./scripts/dev/external-sessions-lane-b-test.sh packages/plugins/codex \
#     src/agent/surfaces/sessions/external/contribution.test.ts \
#     -t 'advances a bounded nonempty appended suffix'
#   ./scripts/dev/external-sessions-lane-b-test.sh packages/plugins/opencode \
#     src/agent/surfaces/sessions/external/readAfterTranscript.test.ts
#   ./scripts/dev/external-sessions-lane-b-test.sh packages/plugins/opencode \
#     src/agent/surfaces/sessions/external/pageTranscript.test.ts
#   ./scripts/dev/external-sessions-lane-b-test.sh packages/plugins/codex \
#     src/agent/surfaces/sessions/external/candidateSource.bounded.test.ts
set -eu
pkg_dir=$1
shift
cd "$pkg_dir"
exec ../../../apps/stack/bin/hstack-exec --script=test:local "$@"
