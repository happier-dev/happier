#!/usr/bin/env bash
set -euo pipefail

# Provision an Ubuntu machine with *dependencies only* so you can install/run Happier tools manually.
# This script intentionally does NOT install Happier/hstack itself.
#
# Intended usage (inside a VM):
#   curl -fsSL https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack/scripts/provision/linux-ubuntu-provision.sh -o /tmp/linux-ubuntu-provision.sh \
#     && chmod +x /tmp/linux-ubuntu-provision.sh \
#     && /tmp/linux-ubuntu-provision.sh --profile=happier
#
# Profiles:
# - happier   : build tools + Node + Corepack/Yarn (default)
# - installer : minimal base tooling (curl/ca-certs) to test the official installer on a mostly-empty box
# - bare      : do nothing (useful if you explicitly want an unprovisioned VM)
#
# Env overrides:
# - HAPPIER_PROVISION_NODE_MAJOR (default: 24)
# - HAPPIER_PROVISION_YARN_VERSION (default: 1.22.22)

usage() {
  cat <<'EOF'
Usage:
  ./linux-ubuntu-provision.sh [--profile=happier|installer|bare]

Examples:
  ./linux-ubuntu-provision.sh --profile=happier
  ./linux-ubuntu-provision.sh --profile=installer
  ./linux-ubuntu-provision.sh --profile=bare
EOF
}

PROFILE="happier"
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --profile=*)
      PROFILE="${arg#--profile=}"
      ;;
    *)
      echo "[provision] unknown argument: ${arg}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
    return
  fi
  if require_cmd sudo; then
    sudo "$@"
    return
  fi
  echo "[provision] missing sudo; re-run as root" >&2
  exit 1
}

say() {
  echo ""
  echo "[provision] $*"
}

NODE_MAJOR="${HAPPIER_PROVISION_NODE_MAJOR:-24}"
YARN_VERSION="${HAPPIER_PROVISION_YARN_VERSION:-1.22.22}"

case "${PROFILE}" in
  happier|installer|bare) ;;
  *)
    echo "[provision] invalid --profile: ${PROFILE}" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "${PROFILE}" == "bare" ]]; then
  say "profile=bare (no changes)"
  echo ""
  echo "[provision] done."
  exit 0
fi

say "updating apt"
as_root apt-get update -y

if [[ "${PROFILE}" == "installer" ]]; then
  say "installing minimal packages (installer profile)"
  as_root apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils
  echo ""
  echo "[provision] done."
  echo ""
  echo "Next (example):"
  echo "  curl -fsSL https://happier.dev/install | bash"
  exit 0
fi

say "installing base packages"
as_root apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  xz-utils \
  build-essential \
  python3

if ! require_cmd node; then
  say "installing Node.js (NodeSource ${NODE_MAJOR}.x)"
  as_root bash -lc "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
  as_root apt-get install -y nodejs
fi

say "node: $(node --version)"

if ! require_cmd corepack; then
  echo "[provision] corepack not found (expected with Node >=16)." >&2
  exit 1
fi

say "enabling Corepack shims (root)"
as_root corepack enable

say "preparing Yarn ${YARN_VERSION} (root; system cache)"
as_root mkdir -p /usr/local/share/corepack
as_root env COREPACK_HOME=/usr/local/share/corepack corepack prepare "yarn@${YARN_VERSION}" --activate

say "yarn: $(yarn --version)"

echo ""
echo "[provision] done."
echo ""
echo "Next:"
echo "  npx --yes -p @happier-dev/stack@latest hstack setup --profile=dev --bind=loopback"

