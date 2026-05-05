#!/usr/bin/env bash
set -euo pipefail

export HAPPIER_CHANNEL="${HAPPIER_CHANNEL:-preview}"
export HAPPIER_PRODUCT="${HAPPIER_PRODUCT:-cli}"

curl -fsSL "https://happier.dev/install.sh" | bash -s -- "$@"
