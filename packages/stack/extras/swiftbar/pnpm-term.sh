#!/bin/bash
set -euo pipefail

# Back-compat wrapper. Use `happys-term.sh` for new installs.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/happys-term.sh" "$@"
