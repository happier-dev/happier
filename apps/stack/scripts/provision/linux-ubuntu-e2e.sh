#!/usr/bin/env bash
set -euo pipefail

# End-to-end (best-effort) smoke test for hstack on Ubuntu.
#
# Intended usage (inside a Lima VM):
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/<ref>/apps/stack/scripts/provision/linux-ubuntu-review-pr.sh -o /tmp/linux-ubuntu-review-pr.sh \
#     && chmod +x /tmp/linux-ubuntu-review-pr.sh \
#     && /tmp/linux-ubuntu-review-pr.sh
#
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/<ref>/apps/stack/scripts/provision/linux-ubuntu-e2e.sh -o /tmp/linux-ubuntu-e2e.sh \
#     && chmod +x /tmp/linux-ubuntu-e2e.sh \
#     && HSTACK_VERSION=latest /tmp/linux-ubuntu-e2e.sh
#
# Notes:
# - This uses `npx` by default (no reliance on global installs).
# - All state is isolated under a hstack sandbox dir so it can be deleted cleanly.
# - Authentication / Tailscale / autostart / menubar are intentionally skipped.
#
# Env overrides:
# - HSTACK_VERSION: npm dist-tag or semver for @happier-dev/stack (default: latest)
# - HSTACK_TGZ: path to a local @happier-dev/stack tarball inside the VM (overrides HSTACK_VERSION)
# - HSTACK_E2E_DIR: where to store the sandbox + logs (default: /tmp/hstack-e2e-<timestamp>)
# - HSTACK_E2E_KEEP: set to 1 to keep the sandbox dir on exit (default: 0)

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

fail() {
  echo "[e2e] failed: $*" >&2
  exit 1
}

say() {
  echo ""
  echo "==> $*"
}

timestamp() {
  date +"%Y%m%d-%H%M%S"
}

for cmd in bash curl git node npx jq; do
  require_cmd "$cmd" || fail "missing required command: $cmd"
done

STACK_VERSION="${HSTACK_VERSION:-latest}"
STACK_TGZ="${HSTACK_TGZ:-}"
E2E_DIR="${HSTACK_E2E_DIR:-/tmp/hstack-e2e-$(timestamp)}"
KEEP="${HSTACK_E2E_KEEP:-0}"

SANDBOX_DIR="${E2E_DIR}/sandbox"
NPM_CACHE="${E2E_DIR}/npm-cache"
LOG_DIR="${E2E_DIR}/logs"

mkdir -p "$LOG_DIR" "$NPM_CACHE"

hstack() {
  local spec
  if [[ -n "$STACK_TGZ" ]]; then
    spec="$STACK_TGZ"
  else
    spec="-p @happier-dev/stack@${STACK_VERSION}"
  fi
  # shellcheck disable=SC2086
  npm_config_cache="$NPM_CACHE" \
  npm_config_update_notifier=false \
  npx --yes ${spec} hstack "$@"
}

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    echo ""
    echo "[e2e] keeping sandbox dir: $E2E_DIR"
    return
  fi
  rm -rf "$E2E_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "system info"
echo "[e2e] node: $(node --version)"
echo "[e2e] npm:  $(npm --version)"
echo "[e2e] git:  $(git --version)"
echo "[e2e] jq:   $(jq --version)"
echo "[e2e] pkg:  @happier-dev/stack@${STACK_VERSION}"

say "hstack help (sanity)"
hstack --help >/dev/null

say "hstack where --json (sandbox wiring)"
WHERE_JSON="$(hstack --sandbox-dir "$SANDBOX_DIR" where --json | tee "$LOG_DIR/where.json")"
echo "$WHERE_JSON" | jq -e '.sandbox.enabled == true' >/dev/null || fail "expected sandbox.enabled=true"
echo "$WHERE_JSON" | jq -e '.repoDir | startswith("/tmp/") or startswith("/var/") or startswith("/home/")' >/dev/null || true

say "selfhost setup (no auth/tailscale/autostart/menubar)"
export HAPPIER_STACK_UPDATE_CHECK=0
hstack --sandbox-dir "$SANDBOX_DIR" setup \
  --profile=selfhost \
  --no-auth \
  --no-tailscale \
  --no-autostart \
  --no-menubar \
  --bind=loopback \
  2>&1 | tee "$LOG_DIR/setup-selfhost.log"

say "resolve server URL"
START_JSON="$(hstack --sandbox-dir "$SANDBOX_DIR" start --json | tee "$LOG_DIR/start.json")"
INTERNAL_URL="$(echo "$START_JSON" | jq -r '.internalServerUrl')"
if [[ -z "$INTERNAL_URL" || "$INTERNAL_URL" == "null" ]]; then
  fail "missing internalServerUrl from start --json"
fi
echo "[e2e] internal url: $INTERNAL_URL"

say "health check"
curl -fsS "${INTERNAL_URL}/health" | tee "$LOG_DIR/health.json" | jq -e '.status == "ok"' >/dev/null

say "UI served by server-light"
HTML_HEAD="$(curl -fsS "${INTERNAL_URL}/" | head -n 5 || true)"
echo "$HTML_HEAD" | tee "$LOG_DIR/ui.head.txt" | grep -Eqi '<!doctype html|<html' || fail "expected HTML from ${INTERNAL_URL}/"

say "worktree smoke (monorepo-only)"
# Create a throwaway worktree based on the default remote (keeps this test stable even if upstream remotes vary).
hstack --sandbox-dir "$SANDBOX_DIR" wt new "tmp/e2e-$(timestamp)" --from=origin --use --json | tee "$LOG_DIR/wt-new.json" >/dev/null
hstack --sandbox-dir "$SANDBOX_DIR" wt status --json | tee "$LOG_DIR/wt-status.json" >/dev/null

say "stop main stack (clean shutdown)"
hstack --sandbox-dir "$SANDBOX_DIR" stop --yes --aggressive --sweep-owned --no-service 2>&1 | tee "$LOG_DIR/stop-main.log"

say "done"
echo "[e2e] ok"
