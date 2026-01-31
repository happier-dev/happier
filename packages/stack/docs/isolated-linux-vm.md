# Isolated Linux VM (Apple Silicon) for `review-pr`

If you want to validate `hapsta review-pr` on a **fresh system** (no existing `~/.happier-stack`, no host tooling), the simplest repeatable approach on Apple Silicon is a Linux VM managed by **Lima** (it uses Apple’s Virtualization.framework).

This avoids Docker/container UX issues (browser opening, Expo networking, file watching) while still being truly “clean”.

## Option A (recommended): Lima + Ubuntu ARM64

### 1) Install Lima (macOS host)

```bash
brew install lima
```

### 2) Create + configure a VM (recommended script)

On your macOS host (this repo):

```bash
./scripts/provision/macos-lima-happy-vm.sh happy-test
```

This creates the VM if needed and configures **localhost port forwarding** for the port ranges used by our VM defaults.
(This is important because the Expo web app uses WebCrypto and needs a secure context like `http://localhost`.)

It also sets a higher default VM memory size (to avoid Expo/Metro getting OOM-killed and exiting with `code=137`).
Override if needed:

```bash
LIMA_MEMORY=12GiB ./scripts/provision/macos-lima-happy-vm.sh happy-test
```

Port ranges note:
- `review-pr` runs in a **fully isolated sandbox** (separate happy-stacks home dir), so VM defaults written to
  `~/.happier-stack/env.local` inside the VM won’t be read automatically.
- Prefer passing `--vm-ports` (or explicit `--stack-port-start=...`) to `review-pr` so the sandbox uses the forwarded ranges.

### 2b) Manual setup (if you prefer)

```bash
limactl create --name happy-pr --tty=false template://ubuntu-24.04
limactl start happy-pr
```

If you run `review-pr` (Expo web / Metro) inside the VM, **allocate enough memory** (recommend **8GiB+**).
Edit `~/.lima/happy-pr/lima.yaml` on the macOS host and set:

```yaml
memory: "8GiB"
```

### 2c) Host access (ports + browser URLs)

When you want to open Happy/Expo URLs in your macOS browser, **use localhost port forwarding**.

Why this matters: the Expo web app uses WebCrypto (`crypto.subtle`) via `expo-crypto` for things like key derivation.
Browsers only expose WebCrypto in **secure contexts**:
- `https://...`
- `http://localhost`, `http://127.0.0.1`, and `http://*.localhost`

If you open the UI via a VM LAN IP like `http://192.168.x.y:PORT`, the browser treats it as **insecure** and you can hit errors like:
`TypeError: Cannot read properties of undefined (reading 'digest')`.

#### Configure port forwarding (recommended)

Edit the instance config on the **macOS host**:

```bash
limactl stop happy-pr || true
open -a TextEdit ~/.lima/happy-pr/lima.yaml
```

Add a `portForwards` section to forward the Happy Stacks VM port ranges to your host `localhost`:

```yaml
portForwards:
  # Stack/server ports (default VM range from our provision script)
  - guestPortRange: [13000, 13999]
    hostPortRange:  [13000, 13999]

  # Expo dev-server (web) ports (default VM range from our provision script)
  - guestPortRange: [18000, 19099]
    hostPortRange:  [18000, 19099]
```

Then restart the VM:

```bash
limactl start happy-pr
```

#### Optional: IP-based access (only when you need LAN)

If you explicitly need to access guest services by VM IP (e.g. for testing from another device), you can enable `vzNAT`:

```bash
limactl stop happy-pr || true
limactl start happy-pr --network vzNAT
```

Note: IP-based URLs (like `http://192.168...`) may break web-only crypto flows unless you use HTTPS or a browser dev override.

### 3) Provision the VM (Node + build deps)

```bash
limactl shell happy-pr
```

Inside the VM:

```bash
curl -fsSL https://raw.githubusercontent.com/happier-dev/happy-local/main/scripts/provision/linux-ubuntu-review-pr.sh -o /tmp/linux-ubuntu-review-pr.sh && chmod +x /tmp/linux-ubuntu-review-pr.sh && /tmp/linux-ubuntu-review-pr.sh

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
```

### 3b) (Optional) Run the Happy Stacks dev setup wizard

If your goal is to **work on changes** (not just review a PR), you can run the dev profile:

```bash
npx --yes -p @happier-dev/stack@latest hapsta setup --profile=dev --bind=loopback
```

Notes:
- This bootstraps a workspace (clones repos, installs deps, sets up worktrees/stacks tooling).
- On Linux VMs you typically want `--no-mobile` workflows (iOS dev-client requires Xcode/macOS).

### 4) Run `review-pr` via `npx` (published package)

Inside the VM:

```bash
npx --yes -p @happier-dev/stack@latest hapsta review-pr \
  --happy=https://github.com/slopus/happy/pull/<PR_NUMBER> \
  --vm-ports \
  --no-mobile \
  --keep-sandbox \
  --verbose \
  -- --bind=loopback
```

Notes:
- `--no-mobile` keeps the validation focused (Expo mobile dev-client adds more host requirements).
- You can also add `--keep-sandbox` if you want to inspect the sandbox contents after a failure.
- For full reproducibility, pin the version: `npx --yes -p @happier-dev/stack@0.3.0 hapsta review-pr ...`
- `--vm-ports` forces the stack/server and Expo dev-server (web) ports into the forwarded VM ranges
  (pairs with the `portForwards` config in this doc).

### Optional: test **unreleased local changes**

If you need to test changes that aren’t published to npm yet:

1) On your Mac (repo checkout):

```bash
npm pack
```

2) Copy the generated `happy-stacks-*.tgz` into the VM (any method you like), then inside the VM:

```bash
npx --yes ./happier-dev-stack-*.tgz hapsta review-pr ...
```

## Option B: GUI VM (UTM) – simplest when you want a “real desktop”

If you want the most realistic “reviewer” experience (open browser, etc.), a GUI VM is great:

1. Install UTM (macOS host): `brew install --cask utm`
2. Create an Ubuntu 24.04 ARM64 VM (UTM wizard).
3. Run the same provisioning + `node bin/hapsta.mjs review-pr ...` inside the VM.

## Option C: Apple “container” / Docker

Containers are excellent for server-only validation, but are usually **not** the best fit for end-to-end `review-pr` UX because:
- opening the host browser from inside the container is awkward
- Expo/dev-server workflows and networking tend to require extra port mapping and host interaction

Use containers only if you explicitly want “CLI-only” checks and are okay opening URLs manually.

---

## Resetting / starting fresh

### Full reset (recommended): recreate the VM

On the macOS host:

```bash
limactl stop happy-pr || true
limactl delete happy-pr
limactl create --name happy-pr --tty=false template:ubuntu-24.04
limactl start happy-pr
```

Then re-run the provisioning step (Node + build deps) from this doc.

### Soft reset: keep the VM, delete Happy Stacks state

If you want a “clean-ish” rerun without recreating the VM, delete the Happy Stacks home + any workspace you chose:

Inside the VM:

```bash
rm -rf ~/.happier-stack ~/.happy
```

If you used `hapsta setup --profile=dev` and picked a custom workspace directory (outside `~/.happier-stack/workspace`), delete that directory too.

---

## Notes / scope

- This doc targets **web-only** validation (`--no-mobile`) on Ubuntu ARM64 VMs.
- On-device iOS testing via `--mobile` requires a macOS host with Xcode (not possible inside the Linux VM).
