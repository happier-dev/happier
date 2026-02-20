#!/usr/bin/env bash
set -euo pipefail

# Create/configure a Lima VM for running Happier stack flows in a clean Linux environment,
# while keeping Expo web URLs openable on the macOS host via localhost port forwarding
# (required for WebCrypto/secure-context APIs).
#
# Usage (macOS host):
#   ./scripts/provision/macos-lima-vm.sh [vm-name]
#
# Env overrides:
# - LIMA_TEMPLATE (default: ubuntu-24.04)
# - LIMA_MEMORY (default: 8GiB)
# - LIMA_VM_TYPE (optional: vz|qemu|krunkit)
# - HAPPIER_LIMA_STACK_PORT_RANGE (default: 13000-13999)
# - HAPPIER_LIMA_EXPO_PORT_RANGE  (default: 18000-19099)

usage() {
  cat <<'EOF'
Usage:
  ./scripts/provision/macos-lima-vm.sh [vm-name]

Examples:
  ./scripts/provision/macos-lima-vm.sh
  ./scripts/provision/macos-lima-vm.sh happy-e2e

Notes:
- Run on macOS (Darwin) host.
- Configures localhost port forwarding so you can open http://localhost / http://*.localhost
  in your macOS browser (required for WebCrypto APIs used by Expo web).
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
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

if ! command -v python3 >/dev/null 2>&1; then
  echo "[lima] python3 not found. Install Python 3 to edit Lima YAML." >&2
  exit 1
fi

VM_NAME="${1:-happy-test}"
TEMPLATE="${LIMA_TEMPLATE:-ubuntu-24.04}"
LIMA_MEMORY="${LIMA_MEMORY:-8GiB}"
LIMA_VM_TYPE="${LIMA_VM_TYPE:-}" # optional: vz|qemu|krunkit (see: limactl create --list-drivers)

STACK_PORT_RANGE="${HAPPIER_LIMA_STACK_PORT_RANGE:-13000-13999}"
EXPO_PORT_RANGE="${HAPPIER_LIMA_EXPO_PORT_RANGE:-18000-19099}"

TEMPLATE_LOCATOR="${TEMPLATE}"
if [[ "${TEMPLATE_LOCATOR}" == template://* ]]; then
  TEMPLATE_LOCATOR="template:${TEMPLATE_LOCATOR#template://}"
elif [[ "${TEMPLATE_LOCATOR}" != template:* ]]; then
  TEMPLATE_LOCATOR="template:${TEMPLATE_LOCATOR}"
fi

LIMA_HOME_DIR="${LIMA_HOME:-${HOME}/.lima}"
export LIMA_HOME="${LIMA_HOME_DIR}"
LIMA_DIR="${LIMA_HOME_DIR}/${VM_NAME}"
LIMA_YAML="${LIMA_DIR}/lima.yaml"

echo "[lima] vm: ${VM_NAME}"
echo "[lima] template: ${TEMPLATE}"
echo "[lima] memory: ${LIMA_MEMORY} (override with LIMA_MEMORY=...)"
echo "[lima] stack ports: ${STACK_PORT_RANGE}"
echo "[lima] expo ports:  ${EXPO_PORT_RANGE}"
echo "[lima] LIMA_HOME: ${LIMA_HOME_DIR}"
if [[ -n "${LIMA_VM_TYPE}" ]]; then
  echo "[lima] vmType: ${LIMA_VM_TYPE}"
fi

if [[ ! -f "${LIMA_YAML}" ]]; then
  echo "[lima] creating VM..."
  if [[ "${LIMA_VM_TYPE}" == "qemu" ]]; then
    if ! command -v qemu-system-aarch64 >/dev/null 2>&1; then
      echo "[lima] qemu vmType requested but qemu-system-aarch64 is missing." >&2
      echo "[lima] Fix: brew install qemu" >&2
      exit 1
    fi
  fi

  create_args=(create --name "${VM_NAME}" --tty=false)
  if [[ -n "${LIMA_VM_TYPE}" ]]; then
    create_args+=(--vm-type "${LIMA_VM_TYPE}")
  fi
  create_args+=("${TEMPLATE_LOCATOR}")
  limactl "${create_args[@]}"
fi

if [[ ! -f "${LIMA_YAML}" ]]; then
  echo "[lima] expected instance config at: ${LIMA_YAML}" >&2
  exit 1
fi

echo "[lima] stopping VM (if running)..."
limactl stop "${VM_NAME}" >/dev/null 2>&1 || true

echo "[lima] configuring port forwarding (localhost)..."
cp -a "${LIMA_YAML}" "${LIMA_YAML}.bak.$(date +%Y%m%d-%H%M%S)"

VM_NAME="${VM_NAME}" \
LIMA_YAML="${LIMA_YAML}" \
LIMA_MEMORY="${LIMA_MEMORY}" \
STACK_PORT_RANGE="${STACK_PORT_RANGE}" \
EXPO_PORT_RANGE="${EXPO_PORT_RANGE}" \
python3 - <<'PY'
import os, re
from pathlib import Path

vm_name = os.environ["VM_NAME"]
path = Path(os.environ["LIMA_YAML"])
memory = os.environ.get("LIMA_MEMORY", "8GiB")

def parse_range(s: str):
  m = re.match(r"^\s*(\d+)\s*-\s*(\d+)\s*$", s or "")
  if not m:
    raise SystemExit(f"invalid port range: {s!r} (expected like 13000-13999)")
  a = int(m.group(1))
  b = int(m.group(2))
  if a <= 0 or b <= 0 or b < a:
    raise SystemExit(f"invalid port range: {s!r}")
  return a, b

stack_a, stack_b = parse_range(os.environ.get("STACK_PORT_RANGE", "13000-13999"))
expo_a, expo_b = parse_range(os.environ.get("EXPO_PORT_RANGE", "18000-19099"))

text = path.read_text(encoding="utf-8")

MEM_MARK_BEGIN = "# --- happier vm sizing (managed) ---"
MEM_MARK_END = "# --- /happier vm sizing ---"
MARK_BEGIN = "# --- happier port forwards (managed) ---"
MARK_END = "# --- /happier port forwards ---"

entries = [
  f"  - guestPortRange: [{stack_a}, {stack_b}]\n    hostPortRange:  [{stack_a}, {stack_b}]\n",
  f"  - guestPortRange: [{expo_a}, {expo_b}]\n    hostPortRange:  [{expo_a}, {expo_b}]\n",
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
  f"  {MARK_BEGIN}\n"
  + "".join(entries) +
  f"  {MARK_END}\n"
)

if MEM_MARK_BEGIN in text and MEM_MARK_END in text:
  text = re.sub(
    re.escape(MEM_MARK_BEGIN) + r"[\s\S]*?" + re.escape(MEM_MARK_END) + r"\n?",
    mem_block.strip("\n") + "\n",
    text,
    flags=re.MULTILINE,
  )
else:
  m = re.search(r"^memory:\s*.*$", text, flags=re.MULTILINE)
  if m:
    text = re.sub(r"^memory:\s*.*$", f'memory: "{memory}"', text, flags=re.MULTILINE)
  else:
    text = text.rstrip() + mem_block

if MARK_BEGIN in text and MARK_END in text:
  text = re.sub(
    re.escape(MARK_BEGIN) + r"[\s\S]*?" + re.escape(MARK_END) + r"\n?",
    block_as_section.strip("\n") + "\n",
    text,
    flags=re.MULTILINE,
  )
else:
  m = re.search(r"^portForwards:\s*$", text, flags=re.MULTILINE)
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

echo ""
echo "[lima] done."
echo ""
echo "What this script did:"
echo "  - ensured the VM exists (${VM_NAME})"
echo "  - set VM memory (${LIMA_MEMORY})"
echo "  - configured localhost port forwarding:"
echo "      - stack/server: ${STACK_PORT_RANGE}"
echo "      - Expo (web):   ${EXPO_PORT_RANGE}"
echo ""
echo "Next step (enter the VM):"
printf "  limactl shell %s\n" "${VM_NAME}"
echo ""
cat <<'EOF'
Inside the VM: choose a provisioning profile (dependencies only)

Profile `happier` (recommended for most manual testing):
  - Installs: build tools + git + Node + Corepack/Yarn.
  - Use when: you want to run `npx ... hstack ...` and iterate quickly without relying on the official installer.
  - Run:
      curl -fsSL https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack/scripts/provision/linux-ubuntu-provision.sh -o /tmp/linux-ubuntu-provision.sh \
        && chmod +x /tmp/linux-ubuntu-provision.sh \
        && /tmp/linux-ubuntu-provision.sh --profile=happier

Profile `installer` (clean-machine installer validation):
  - Installs: minimal tooling only (curl/ca-certs/etc). DOES NOT install Node/Yarn.
  - Use when: you want to validate the “fresh box” experience via the official installer.
  - Run:
      curl -fsSL https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack/scripts/provision/linux-ubuntu-provision.sh -o /tmp/linux-ubuntu-provision.sh \
        && chmod +x /tmp/linux-ubuntu-provision.sh \
        && /tmp/linux-ubuntu-provision.sh --profile=installer
      # Then run the official installer:
      curl -fsSL https://happier.dev/install | bash

Profile `bare` (no changes at all):
  - Installs: nothing.
  - Use when: you want a totally untouched VM and will install everything yourself (or validate your own bootstrap flow).
  - Run:
      /tmp/linux-ubuntu-provision.sh --profile=bare

After provisioning (common next commands):
  - Dev monorepo wizard (clones + bootstraps a workspace):
      npx --yes -p @happier-dev/stack@latest hstack setup --profile=dev --bind=loopback
  - Selfhost (lighter; good for quickly validating server/UI boot without auth):
      npx --yes -p @happier-dev/stack@latest hstack setup --profile=selfhost --no-auth --no-tailscale --no-autostart --no-menubar --bind=loopback

Tips:
  - Open printed URLs on your macOS host via http://localhost:<port> or http://*.localhost:<port>.
  - For `npx --yes -p @happier-dev/stack hstack tools review-pr ...` inside the VM, pass `--vm-ports` so stack ports land in the forwarded ranges.
  - Override guest provision versions (profile=happier):
      HAPPIER_PROVISION_NODE_MAJOR=24 HAPPIER_PROVISION_YARN_VERSION=1.22.22 /tmp/linux-ubuntu-provision.sh --profile=happier
EOF
