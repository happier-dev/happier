#!/usr/bin/env bash
set -euo pipefail

# Create/configure a Lima VM for testing Hapsta in an isolated Linux environment,
# while still opening the Expo web UI on the macOS host via localhost port forwarding
# (required for WebCrypto/secure-context APIs).
#
# Usage:
#   ./scripts/provision/macos-lima-happy-vm.sh [vm-name]
#
# Defaults:
#   vm-name: happy-test
#   template: ubuntu-24.04
#
# What it does:
# - creates the VM (if missing)
# - injects port forwarding rules for the Hapsta VM port ranges
# - restarts the VM so the rules take effect
# - prints next steps (provision script + hapsta commands)

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  ./scripts/provision/macos-lima-happy-vm.sh [vm-name]

Examples:
  ./scripts/provision/macos-lima-happy-vm.sh            # uses "happy-test"
  ./scripts/provision/macos-lima-happy-vm.sh happy      # uses "happy"
  ./scripts/provision/macos-lima-happy-vm.sh happy-vm   # uses "happy-vm"

Notes:
- This is intended to be run on the macOS host (not inside the VM).
- It configures localhost port forwarding so you can open http://localhost / http://*.localhost
  in your macOS browser (required for WebCrypto APIs used by Expo web).
EOF
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[lima] expected macOS (Darwin); got: $(uname -s)" >&2
  exit 1
fi

if ! command -v limactl >/dev/null 2>&1; then
  echo "[lima] limactl not found. Install Lima first (example: brew install lima)." >&2
  exit 1
fi

VM_NAME="${1:-happy-test}"
TEMPLATE="${LIMA_TEMPLATE:-ubuntu-24.04}"
LIMA_MEMORY="${LIMA_MEMORY:-8GiB}"
TEMPLATE_LOCATOR="${TEMPLATE}"
if [[ "${TEMPLATE_LOCATOR}" == template://* ]]; then
  TEMPLATE_LOCATOR="template:${TEMPLATE_LOCATOR#template://}"
elif [[ "${TEMPLATE_LOCATOR}" != template:* ]]; then
  TEMPLATE_LOCATOR="template:${TEMPLATE_LOCATOR}"
fi
LIMA_DIR="${HOME}/.lima/${VM_NAME}"
LIMA_YAML="${LIMA_DIR}/lima.yaml"

echo "[lima] vm: ${VM_NAME}"
echo "[lima] template: ${TEMPLATE}"
echo "[lima] memory: ${LIMA_MEMORY} (override with LIMA_MEMORY=...)"

if [[ ! -f "${LIMA_YAML}" ]]; then
  echo "[lima] creating VM..."
  limactl create --name "${VM_NAME}" --tty=false "${TEMPLATE_LOCATOR}"
fi

if [[ ! -f "${LIMA_YAML}" ]]; then
  echo "[lima] expected instance config at: ${LIMA_YAML}" >&2
  exit 1
fi

echo "[lima] stopping VM (if running)..."
limactl stop "${VM_NAME}" >/dev/null 2>&1 || true

echo "[lima] configuring port forwarding (localhost)..."
cp -a "${LIMA_YAML}" "${LIMA_YAML}.bak.$(date +%Y%m%d-%H%M%S)"

VM_NAME="${VM_NAME}" LIMA_YAML="${LIMA_YAML}" LIMA_MEMORY="${LIMA_MEMORY}" python3 - <<'PY'
import os, re
from pathlib import Path

vm_name = os.environ["VM_NAME"]
path = Path(os.environ["LIMA_YAML"])
memory = os.environ.get("LIMA_MEMORY", "8GiB")
text = path.read_text(encoding="utf-8")

MEM_MARK_BEGIN = "# --- hapsta vm sizing (managed by hapsta) ---"
MEM_MARK_END = "# --- /hapsta vm sizing ---"
MARK_BEGIN = "# --- hapsta port forwards (managed by hapsta) ---"
MARK_END = "# --- /hapsta port forwards ---"

entries = [
    "  - guestPortRange: [13000, 13999]\n    hostPortRange:  [13000, 13999]\n",
    "  - guestPortRange: [18000, 19099]\n    hostPortRange:  [18000, 19099]\n",
]

mem_block = (
    f"\n{MEM_MARK_BEGIN}\n"
    f'memory: "{memory}"\n'
    f"{MEM_MARK_END}\n"
)

block_as_section = (
    f"\n{MARK_BEGIN}\n"
    "portForwards:\n"
    + "".join(entries) +
    f"{MARK_END}\n"
)

block_as_list_items = (
    f"  # --- hapsta port forwards (managed by hapsta) ---\n"
    + "".join(entries) +
    f"  # --- /hapsta port forwards ---\n"
)

if MEM_MARK_BEGIN in text and MEM_MARK_END in text:
  text = re.sub(
      re.escape(MEM_MARK_BEGIN) + r"[\\s\\S]*?" + re.escape(MEM_MARK_END) + r"\\n?",
      mem_block.strip("\n") + "\n",
      text,
      flags=re.MULTILINE,
  )
else:
  m = re.search(r"^memory:\\s*.*$", text, flags=re.MULTILINE)
  if m:
    text = re.sub(r"^memory:\\s*.*$", f'memory: "{memory}"', text, flags=re.MULTILINE)
  else:
    text = text.rstrip() + mem_block

if MARK_BEGIN in text and MARK_END in text:
  text = re.sub(
      re.escape(MARK_BEGIN) + r"[\\s\\S]*?" + re.escape(MARK_END) + r"\\n?",
      block_as_section.strip("\n") + "\n",
      text,
      flags=re.MULTILINE,
  )
else:
  m = re.search(r"^portForwards:\\s*$", text, flags=re.MULTILINE)
  if m:
    insert_at = m.end()
    text = text[:insert_at] + "\n" + block_as_list_items + text[insert_at:]
  else:
    text = text.rstrip() + block_as_section

path.write_text(text, encoding="utf-8")
print(f"[lima] updated {path} ({vm_name})")
PY

echo "[lima] starting VM..."
limactl start "${VM_NAME}"

cat <<EOF

[lima] done.

Next steps:
  limactl shell ${VM_NAME}

Inside the VM:
  curl -fsSL https://raw.githubusercontent.com/leeroybrun/happier-dev/main/apps/stack/scripts/provision/linux-ubuntu-review-pr.sh -o /tmp/linux-ubuntu-review-pr.sh \\
    && chmod +x /tmp/linux-ubuntu-review-pr.sh \\
    && /tmp/linux-ubuntu-review-pr.sh

Then:
  npx --yes -p @happier-dev/stack@latest hapsta setup --profile=dev --bind=loopback

Tip:
  Open the printed URLs on your macOS host via http://localhost:<port> or http://*.localhost:<port>.
  For `npx --yes -p @happier-dev/stack hapsta review-pr ...` inside the VM, pass `--vm-ports` so stack ports land in the forwarded ranges.
EOF
