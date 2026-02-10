#!/usr/bin/env bash
set -euo pipefail

# Convenience wrapper for server installs.
# Uses the shared installer with HAPPIER_PRODUCT=server.
export HAPPIER_PRODUCT="${HAPPIER_PRODUCT:-server}"

curl -fsSL "https://happier.dev/install.sh" | bash
