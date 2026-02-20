#!/usr/bin/env bash
set -euo pipefail

# Best-effort smoke test for `hstack` on Ubuntu using an isolated sandbox.
#
# Intended usage (inside a VM):
#   curl -fsSL https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack/scripts/provision/linux-ubuntu-provision.sh -o /tmp/linux-ubuntu-provision.sh \
#     && chmod +x /tmp/linux-ubuntu-provision.sh \
#     && /tmp/linux-ubuntu-provision.sh --profile=happier
#
#   curl -fsSL https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack/scripts/provision/linux-ubuntu-hstack-smoke.sh -o /tmp/linux-ubuntu-hstack-smoke.sh \
#     && chmod +x /tmp/linux-ubuntu-hstack-smoke.sh \
#     && HSTACK_VERSION=latest /tmp/linux-ubuntu-hstack-smoke.sh
#
# Env overrides:
# - HSTACK_VERSION: npm dist-tag or semver for @happier-dev/stack (default: latest)
# - HSTACK_TGZ: path to a local @happier-dev/stack tarball inside the VM (overrides HSTACK_VERSION)
# - HSTACK_SMOKE_DIR: where to store the sandbox + logs (default: /tmp/hstack-smoke-<timestamp>)
# - HSTACK_SMOKE_KEEP: set to 1 to keep the sandbox dir on exit (default: 0)

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

fail() {
  echo "[smoke] failed: $*" >&2
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
SMOKE_DIR="${HSTACK_SMOKE_DIR:-/tmp/hstack-smoke-$(timestamp)}"
KEEP="${HSTACK_SMOKE_KEEP:-0}"

SANDBOX_DIR="${SMOKE_DIR}/sandbox"
NPM_CACHE="${SMOKE_DIR}/npm-cache"
LOG_DIR="${SMOKE_DIR}/logs"

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
    echo "[smoke] keeping dir: $SMOKE_DIR"
    return
  fi
  rm -rf "$SMOKE_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "system info"
echo "[smoke] node: $(node --version)"
echo "[smoke] npm:  $(npm --version)"
echo "[smoke] git:  $(git --version)"
echo "[smoke] jq:   $(jq --version)"
echo "[smoke] pkg:  @happier-dev/stack@${STACK_VERSION}"

say "hstack help (sanity)"
hstack --help >/dev/null

say "hstack where --json (sandbox wiring)"
WHERE_JSON="$(hstack --sandbox-dir "$SANDBOX_DIR" where --json | tee "$LOG_DIR/where.json")"
echo "$WHERE_JSON" | jq -e '.sandbox.enabled == true' >/dev/null || fail "expected sandbox.enabled=true"

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
echo "[smoke] internal url: $INTERNAL_URL"

say "health check"
curl -fsS "${INTERNAL_URL}/health" | tee "$LOG_DIR/health.json" | jq -e '.status == "ok"' >/dev/null

say "UI served by server-light"
HTML_HEAD="$(curl -fsS "${INTERNAL_URL}/" | head -n 5 || true)"
echo "$HTML_HEAD" | tee "$LOG_DIR/ui.head.txt" | grep -Eqi '<!doctype html|<html' || fail "expected HTML from ${INTERNAL_URL}/"

say "worktree smoke (monorepo-only)"
hstack --sandbox-dir "$SANDBOX_DIR" wt new "tmp/smoke-$(timestamp)" --from=origin --use --json | tee "$LOG_DIR/wt-new.json" >/dev/null
hstack --sandbox-dir "$SANDBOX_DIR" wt status --json | tee "$LOG_DIR/wt-status.json" >/dev/null

say "stop main stack (clean shutdown)"
hstack --sandbox-dir "$SANDBOX_DIR" stop --yes --aggressive --sweep-owned --no-service 2>&1 | tee "$LOG_DIR/stop-main.log"

say "done"
echo "[smoke] ok"

