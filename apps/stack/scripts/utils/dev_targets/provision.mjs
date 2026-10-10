import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runDevTargetCommand, runDevTargetDependencyBootstrap } from './executor.mjs';
import { buildWorkerPowerScript, configureDevTargetPower, LINUX_WORKER_SLEEP_TARGETS } from './worker_power.mjs';
import { prependRemotePath, resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { runQaBrowserWorker } from './qa_browser.mjs';

import { run, runCaptureResult } from '../proc/proc.mjs';
import { buildLinuxInotifyScript } from '../../provision/linux-inotify.mjs';
import { ensureWorkspacePackagesBuiltByName } from '../proc/pm.mjs';

const TARGET_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:%_-]*$/;
const USER_RE = /^[A-Za-z0-9._-]+$/;

export async function provisionQaDevTarget({ target, stackName, stackBaseDir, env = process.env }) {
  if (target.platform !== 'posix') throw new Error('[dev-targets] QA host setup currently supports POSIX targets');
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  let dependencies;
  let result;
  try {
    // The QA entrypoint imports Stack's emitted workspace dependencies before
    // its setup function can run. Admit them through the stage-zero owner first.
    const admission = await runDevTargetDependencyBootstrap({ target, stackBaseDir,
      componentRelativeDir: 'apps/stack', env, silent: true,
      onLine: ({ line }) => process.stderr.write(`${line}\n`) });
    if (admission.code !== 0) {
      throw admission.error ?? new Error(`[dev-targets] ${target.name} QA dependency bootstrap failed (${admission.code})`);
    }
    result = await runDevTargetCommand({ target, stackBaseDir,
      commandArgs: ['node', './apps/stack/scripts/utils/dev_targets/provision.mjs', '--qa-setup-worker'],
      environment: { HAPPIER_HOME_DIR: paths.cliHomeDir, HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: paths.stackEnvPath, HAPPIER_STACK_PROCESS_KIND: 'infra' },
      dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env, silent: true,
      onLine: ({ line }) => {
        if (line.startsWith('HSTACK_QA_SETUP=')) dependencies = JSON.parse(line.slice('HSTACK_QA_SETUP='.length));
        else process.stderr.write(`${line}\n`);
      },
    });
    if (!dependencies) throw new Error(`[dev-targets] ${target.name} QA dependency setup exited without a result (${result.code})`);
  } catch (error) { dependencies = { error: error.message }; }
  let disk;
  let diskError;
  try {
    const maintenance = await runDevTargetCommand({ target, stackBaseDir,
      commandArgs: ['node', './apps/stack/scripts/utils/dev_targets/worker_disk_budget.mjs', '--maintenance',
        '--class=dependency-install', `--repo=${target.repoDir}`, `--cache=${target.cliHomeDir.replace(/[\\/]+$/, '')}/cache`],
      dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env, silent: true,
      onLine: ({ stream, line }) => {
        if (stream === 'stdout' && line.startsWith('{')) disk = JSON.parse(line);
        else process.stderr.write(`${line}\n`);
      },
    });
    if (maintenance.code !== 0 || !disk) throw new Error(`worker disk maintenance exited without a result (${maintenance.code})`);
  } catch (error) { diskError = error.message; }
  const power = await configureDevTargetPower({ target, env });
  return { target: target.name, cliHomeDir: paths.cliHomeDir, dependenciesReady: dependencies.ok === true && result?.code === 0, dependencies,
    diskReady: disk?.admitted === true && !diskError, disk: disk ?? { error: diskError },
    powerReady: power.every(entry => entry.ok), power };
}

export async function provisionQaHostDependencies(env = process.env) {
  // Mutagen carries authored catalogs, not emitted packages. Admit this
  // worker's consumed closure before Node caches either installer import.
  await ensureWorkspacePackagesBuiltByName(fileURLToPath(new URL('../../../../../', import.meta.url)),
    ['@happier-dev/agents', '@happier-dev/cli-common'], {
      env, includeDevDependencies: false, buildMode: 'source-dev',
    });
  // These are the package-owned catalog and acquisition owners used by normal
  // Agent installation. No Account or connected-service credentials are read.
  const { getAgentCliRuntimeSpec } = await import('@happier-dev/agents');
  const { ensureManagedJavaScriptRuntimeCommand, installAgentCliForRuntime } = await import('@happier-dev/cli-common/agents');
  const failures = [];
  let runtime;
  try {
    runtime = await ensureManagedJavaScriptRuntimeCommand(env);
    if (!runtime) throw new Error('managed JavaScript runtime setup failed');
  } catch (error) { failures.push({ component: 'js-runtime', error: error.message }); }
  const agents = {};
  for (const agentId of ['claude', 'codex']) {
    try {
      const result = await installAgentCliForRuntime({ runtimeSpec: getAgentCliRuntimeSpec(agentId),
        platform: process.platform, env, skipIfInstalled: true,
        // This public setup request explicitly installs these two QA Agent CLIs.
        allowVendorRecipeExecution: true });
      if (!result.ok) throw new Error(`[dev-targets] ${agentId} setup failed: ${result.errorMessage}`);
      agents[agentId] = true;
      process.stderr.write(`[dev-targets] ${agentId}: ready\n`);
    } catch (error) { agents[agentId] = false; failures.push({ component: agentId, error: error.message }); }
  }
  await mkdir(join(env.HAPPIER_HOME_DIR, 'workspace'), { recursive: true });
  const smokeBrowser = async () => {
    const signalSource = new EventEmitter();
    await runQaBrowserWorker({ sessionName: 'setup', env, writeReady: () => signalSource.emit('SIGINT') }, { signalSource });
  };
  let browserReady = false;
  try {
    try { await smokeBrowser(); }
    catch (error) {
      process.stderr.write(`[dev-targets] browser preflight failed; running its canonical installer: ${error.message}\n`);
      if (process.platform === 'linux') {
        await run('bash', ['./apps/stack/scripts/provision/linux-ubuntu-provision.sh', '--profile=qa'], { env });
      } else {
        await run('agent-browser', ['install'], { env });
      }
      await smokeBrowser();
    }
    browserReady = true;
  } catch (error) { failures.push({ component: 'browser', error: error.message }); }
  return { ok: failures.length === 0, jsRuntimeReady: Boolean(runtime), agents, browserReady,
    workspaceDir: join(env.HAPPIER_HOME_DIR, 'workspace'), failures };
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sshConfigQuote(value) {
  return `"${String(value).replace(/([\\"])/g, '\\$1')}"`;
}

function requireMatching(value, pattern, label) {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized)) throw new Error(`[dev-targets] invalid ${label}: ${JSON.stringify(normalized)}`);
  return normalized;
}

function requireAbsolutePosixPath(value, label) {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  if (!normalized.startsWith('/') || /[\0\r\n]/.test(normalized)) {
    throw new Error(`[dev-targets] ${label} must be an absolute POSIX path`);
  }
  return normalized || '/';
}

function readMarker(output, name) {
  const match = String(output ?? '').match(new RegExp(`__HAPPIER_${name}__=([^\\r\\n]*)`));
  return String(match?.[1] ?? '').trim();
}

async function defaultRunInteractive({ command, args, env }) {
  await run(command, args, { env, stdio: [0, 2, 2] });
}

async function defaultRunCaptureResult({ command, args, env }) {
  return await runCaptureResult(command, args, { env });
}

function configuredSshArgs({ configPath, sshAlias, remoteCommand, tty = false, dedicated = false }) {
  return [tty ? '-tt' : '-T', ...(configPath ? ['-F', configPath] : []),
    ...(dedicated ? ['-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'IdentityAgent=none'] : []), sshAlias, remoteCommand];
}

function elevatedBash(script, argumentsExpression = '', passwordless = false) {
  return `root_command=(bash)
if [[ "$(id -u)" != 0 ]]; then root_command=(sudo ${passwordless ? '-n ' : ''}bash); fi
"\${root_command[@]}" -c ${posixQuote(script)} -- ${argumentsExpression}`;
}

export async function prepareDevTargetHost({ target, growRoot = false, noSleep = false,
  passwordlessSudo = false, passwordlessProvisioning = false, fleetSsh = false, diskTmp = false, inotify = false,
  toolchain = false, createUser = null, home = null, tailscale = false, tailscaleAuthkeyStdin = false,
  lockdown = null, autoUpdates = false, allLinux = false, env = process.env },
{ runInteractive = defaultRunInteractive, runCaptureResult: capture = defaultRunCaptureResult } = {}) {
  if (target.platform !== 'posix') throw new Error('[dev-targets] host prepare supports Linux workers only');
  if (lockdown === true) lockdown = 'tailscale-only';
  if (lockdown != null && !['tailscale-only', 'ssh-public'].includes(lockdown)) throw new Error('[dev-targets] invalid --lockdown mode');
  if (createUser != null) createUser = requireMatching(createUser, /^[a-z_][a-z0-9_.-]*$/, 'non-root worker user');
  if (createUser === 'root') throw new Error('[dev-targets] --create-user requires a non-root user');
  if (home != null && !createUser) throw new Error('[dev-targets] --home requires --create-user');
  if (home != null) home = requireAbsolutePosixPath(home, 'worker home');
  if (home === '/') throw new Error('[dev-targets] worker home cannot be the filesystem root');
  if (tailscaleAuthkeyStdin && !tailscale) throw new Error('[dev-targets] --tailscale-authkey-stdin requires --tailscale');
  if (!growRoot && !noSleep && !passwordlessSudo && !fleetSsh && !diskTmp && !inotify && !toolchain && !createUser && !tailscale && !lockdown && !autoUpdates) {
    throw new Error('[dev-targets] host prepare requires at least one explicit host setting');
  }
  if (passwordlessProvisioning && !passwordlessSudo) throw new Error('[dev-targets] --passwordless-provisioning requires --passwordless-sudo');
  const probe = async (candidate, command = 'true') => {
    const result = await capture({ command: 'ssh', args: configuredSshArgs({ configPath: candidate.sshConfigFile,
      sshAlias: candidate.ssh, remoteCommand: command, dedicated: true }), env });
    if (!result?.ok) throw new Error('[dev-targets] fresh dedicated-key authentication failed; host access policy was not committed');
    return result;
  };
  if (fleetSsh || lockdown || createUser || tailscale) await probe(target);
  if (allLinux) {
    const system = (await probe(target, 'uname -s')).out.trim();
    if (system === 'Darwin') return target;
    if (system !== 'Linux') throw new Error('[dev-targets] could not establish Linux host identity');
  }
  if ((createUser || tailscale) && !target.sshConfigFile) throw new Error('[dev-targets] changing the SSH account/address requires a managed SSH configuration');
  let publicKey = '';
  if (createUser) {
    if (!target.sshConfigFile) throw new Error('[dev-targets] --create-user requires a managed SSH configuration');
    publicKey = (await readFile(join(dirname(target.sshConfigFile), 'id_ed25519.pub'), 'utf8')).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?$/.test(publicKey)) throw new Error('[dev-targets] invalid dedicated public key');
  }
  const toolchainSource = toolchain ? await readFile(new URL('../../provision/linux-ubuntu-provision.sh', import.meta.url), 'utf8') : '';
  const rollbackUnit = `happier-host-prepare-${randomUUID()}`;
  const rollbackDir = `/var/lib/${rollbackUnit}`;
  const rollbackScript = `#!/bin/bash
set -euo pipefail
state=${posixQuote(rollbackDir)}
[[ -f "$state/pending" ]] || exit 0
${lockdown ? `ufw --force disable
cp -a -- "$state/ufw/." /etc/ufw/
cp -p -- "$state/ufw-default" /etc/default/ufw
if [[ -f "$state/ufw-active" ]]; then ufw --force enable; fi` : ''}
for name in 40-happier-no-password.conf 50-happier-fleet.conf; do
  if [[ -f "$state/$name" ]]; then cp -p -- "$state/$name" "/etc/ssh/sshd_config.d/$name"
  else rm -f -- "/etc/ssh/sshd_config.d/$name"; fi
done
sshd_command="$(command -v sshd || printf /usr/sbin/sshd)"
"$sshd_command" -t
systemctl reload ssh
mv -- "$state/pending" "$state/rolled-back"
echo '[dev-targets] previous SSH/firewall policy restored'
`;
  const rootScript = `
set -euo pipefail
worker_user="$1"
worker_corepack="$2"
worker_node="$3"
phase="$4"
[[ "$worker_user" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid worker user' >&2; exit 1; }
if [[ "$phase" = prepare ]]; then
${toolchain ? `bash -c ${posixQuote(toolchainSource)} -- --profile=toolchain
worker_corepack="$(command -v corepack)"
worker_node="$(node -p 'process.execPath')"` : ''}
${createUser ? `
worker_user=${posixQuote(createUser)}
worker_home=${posixQuote(home ?? `/home/${createUser}`)}
if getent passwd "$worker_user" >/dev/null; then
  worker_uid="$(id -u "$worker_user")"
  [[ "$worker_uid" != 0 ]] || { echo 'Worker account must be non-root; refusing UID 0' >&2; exit 1; }
  existing_home="$(getent passwd "$worker_user" | cut -d: -f6)"
  [[ "$existing_home" = "$worker_home" ]] || { echo 'Existing worker home differs; refusing to move its data' >&2; exit 1; }
fi
canonical_worker_home="$(readlink -m -- "$worker_home")"
registered_accounts="$(getent passwd)"
while IFS=: read -r registered_user registered_password registered_uid registered_gid registered_gecos registered_home registered_shell; do
  [[ "$registered_user" != "$worker_user" && -n "$registered_home" ]] || continue
  [[ "$(readlink -m -- "$registered_home")" != "$canonical_worker_home" ]] || {
    echo 'Worker home belongs to another account; refusing to modify its access' >&2; exit 1;
  }
done <<< "$registered_accounts"
if ! getent passwd "$worker_user" >/dev/null; then
  useradd --create-home --home-dir "$worker_home" --shell /bin/bash "$worker_user"
fi
command -v sudo >/dev/null || { apt-get update; apt-get install -y sudo; }
worker_group="$(id -gn "$worker_user")"
install -d -m 0700 -o "$worker_user" -g "$worker_group" "$worker_home/.ssh"
[[ -f "$worker_home/.ssh/authorized_keys" ]] || touch "$worker_home/.ssh/authorized_keys"
if ! grep -qxF -- ${posixQuote(publicKey)} "$worker_home/.ssh/authorized_keys"; then
  printf '\\n%s\\n' ${posixQuote(publicKey)} >> "$worker_home/.ssh/authorized_keys"
fi
chown "$worker_user:$worker_group" "$worker_home/.ssh/authorized_keys"
chmod 0600 "$worker_home/.ssh/authorized_keys"
sudo_candidate="$(mktemp)"
printf '%s ALL=(ALL) NOPASSWD: ALL\\n' "$worker_user" > "$sudo_candidate"
visudo -cf "$sudo_candidate"
if ! cmp -s "$sudo_candidate" "/etc/sudoers.d/happier-user-${Buffer.from(createUser ?? '').toString('hex')}"; then
  install -m 0440 "$sudo_candidate" "/etc/sudoers.d/happier-user-${Buffer.from(createUser ?? '').toString('hex')}"
fi
rm -f -- "$sudo_candidate"
` : ''}
${tailscale ? `
if ! command -v tailscale >/dev/null; then
  . /etc/os-release
  [[ "$ID" = ubuntu || "$ID" = debian ]] && [[ "$VERSION_CODENAME" =~ ^[a-z]+$ ]] || { echo 'Tailscale package setup requires Ubuntu or Debian' >&2; exit 1; }
  apt-get update
  apt-get install -y ca-certificates curl
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL "https://pkgs.tailscale.com/stable/$ID/$VERSION_CODENAME.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/$ID/$VERSION_CODENAME.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
  apt-get update
  apt-get install -y tailscale
fi
systemctl is-active --quiet tailscaled || systemctl enable --now tailscaled
if ! tailscale status --json | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then
  ${tailscaleAuthkeyStdin ? 'tailscale up --auth-key=file:/dev/stdin' : 'tailscale up'}
fi
tailscale status --json | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'
` : ''}
${autoUpdates ? `
. /etc/os-release
[[ "$ID" = ubuntu ]] || { echo 'Automatic security-update setup currently supports Ubuntu' >&2; exit 1; }
if [[ "$(dpkg-query -W -f='\${Status}' unattended-upgrades 2>/dev/null || true)" != 'install ok installed' ]]; then
  apt-get update
  apt-get install -y unattended-upgrades
fi
updates_candidate="$(mktemp)"
printf '%s\\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' \
  '#clear Unattended-Upgrade::Allowed-Origins;' '#clear Unattended-Upgrade::Origins-Pattern;' \
  'Unattended-Upgrade::Allowed-Origins { "\${distro_id}:\${distro_codename}-security"; };' \
  'Unattended-Upgrade::Automatic-Reboot "false";' > "$updates_candidate"
if ! cmp -s "$updates_candidate" /etc/apt/apt.conf.d/52happier-security-upgrades; then
  install -m 0644 "$updates_candidate" /etc/apt/apt.conf.d/52happier-security-upgrades
fi
rm -f -- "$updates_candidate"
apt-config dump | grep -qx 'Unattended-Upgrade::Automatic-Reboot "false";' || { echo 'Automatic reboot policy is overridden' >&2; exit 1; }
` : ''}
root_lv=''
root_vg=''
${growRoot || passwordlessSudo ? `
if command -v lvs >/dev/null && command -v vgs >/dev/null; then
  root_lv="$(findmnt -n -o SOURCE /)"
  root_vg="$(lvs --noheadings -o vg_name "$root_lv" 2>/dev/null || true)"
  root_vg="\${root_vg//[[:space:]]/}"
${growRoot ? `else
  echo 'Cannot inspect root LVM: lvs and vgs are required' >&2
  exit 1` : ''}
fi
` : ''}
${passwordlessSudo ? `
command_path() {
  local path
  case "$1" in
    corepack) path="$worker_corepack" ;;
    node) path="$worker_node" ;;
    *) path="$(command -v "$1")" ;;
  esac
  [[ "$path" =~ ^/[A-Za-z0-9_./+-]+$ ]] || { echo "Unsafe or missing command path: $1" >&2; return 1; }
  printf '%s' "$path"
}
candidate="$(mktemp)"
trap 'rm -f -- "$candidate"' EXIT
grant() {
  local path
  path="$(command_path "$1")"
  printf '%s ALL=(root) NOPASSWD: %s %s\\n' "$worker_user" "$path" "$2" >> "$candidate"
}
grant systemctl 'mask ${LINUX_WORKER_SLEEP_TARGETS.join(' ')}'
for unit in ${LINUX_WORKER_SLEEP_TARGETS.join(' ')}; do grant systemctl "is-enabled $unit"; done
if [[ -n "$root_vg" ]]; then
  [[ "$root_lv" =~ ^/[A-Za-z0-9_./+-]+$ && "$root_vg" =~ ^[A-Za-z0-9_.+-]+$ ]] || { echo 'Unsafe LVM identity' >&2; exit 1; }
  grant lvs "--noheadings -o vg_name $root_lv"
  grant vgs "--noheadings -o vg_free_count $root_vg"
  grant lvextend "-r -l +100%FREE $root_lv"
fi
${passwordlessProvisioning ? `
echo '[dev-targets] Passwordless browser provisioning grants effective root access through package installation.' >&2
grant apt-get 'update'
grant apt-get 'update -y'
grant apt-get '^install --simulate [a-zA-Z0-9.+ -]+$'
grant apt-get '^install -y [a-zA-Z0-9.+ -]+$'
grant apt-get '^install -y --no-install-recommends [a-zA-Z0-9.+ -]+$'
# Playwright's Linux dependency owner elevates this exact two-command recipe.
grant sh '^-c apt-get update&& apt-get install -y --no-install-recommends [a-zA-Z0-9.+ -]+$'
corepack_entry="$(command_path corepack)"
corepack_entry="\${corepack_entry//./[.]}"
corepack_entry="\${corepack_entry//+/[+]}"
node_entry="$(command_path node)"
node_entry="\${node_entry//./[.]}"
node_entry="\${node_entry//+/[+]}"
grant env "^COREPACK_ENABLE_PROJECT_SPEC=0 $node_entry $corepack_entry npm install --global --no-audit --no-fund --allow-scripts=agent-browser agent-browser@[0-9]+[.][0-9]+[.][0-9]+$"
` : ''}
visudo -cf "$candidate"
install -m 0440 "$candidate" /etc/sudoers.d/happier-worker
rm -f -- "$candidate"
trap - EXIT
` : ''}
${growRoot ? `
if [[ -n "$root_vg" ]]; then
  free_extents="$(vgs --noheadings -o vg_free_count "$root_vg")"
  free_extents="\${free_extents//[[:space:]]/}"
  [[ "$free_extents" =~ ^[0-9]+$ ]] || { echo 'Invalid VG free-extents observation' >&2; exit 1; }
  if (( free_extents > 0 )); then
    lvextend -r -l +100%FREE "$root_lv"
  fi
fi
` : ''}
${noSleep ? buildWorkerPowerScript('posix') : ''}
${inotify ? buildLinuxInotifyScript() : ''}
${diskTmp ? `
systemctl mask tmp.mount
install -d -m 0755 /etc/tmpfiles.d
tmp_candidate="$(mktemp)"
trap 'rm -f -- "$tmp_candidate"' EXIT
printf '%s\\n' 'q /tmp 1777 root root 3d' > "$tmp_candidate"
if ! cmp -s -- "$tmp_candidate" /etc/tmpfiles.d/tmp.conf; then
  install -m 0644 "$tmp_candidate" /etc/tmpfiles.d/tmp.conf
fi
rm -f -- "$tmp_candidate"
trap - EXIT
echo '[dev-targets] disk-backed /tmp takes effect at next reboot; live /tmp was not unmounted'
` : ''}
fi
if [[ "$phase" = security ]]; then
${lockdown ? `
command -v ufw >/dev/null || { echo 'Install ufw before lockdown' >&2; exit 1; }
command -v tailscale >/dev/null || { echo 'Tailscale is required before lockdown' >&2; exit 1; }
tailscale status --json | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"' || { echo 'Tailscale must be up before lockdown' >&2; exit 1; }
tailnet_ip="$(tailscale ip -4)"
read -r client_ip client_port destination_ip destination_port <<< "$5"
[[ "$destination_ip" = "$tailnet_ip" ]] || { echo 'Lockdown requires a fresh key connection over the tailnet address' >&2; exit 1; }
` : ''}
rollback_dir=${posixQuote(rollbackDir)}
install -d -m 0700 "$rollback_dir"
for name in 40-happier-no-password.conf 50-happier-fleet.conf; do
  if [[ -f "/etc/ssh/sshd_config.d/$name" ]]; then cp -p -- "/etc/ssh/sshd_config.d/$name" "$rollback_dir/$name"; fi
done
${lockdown ? `cp -a -- /etc/ufw "$rollback_dir/ufw"
cp -p -- /etc/default/ufw "$rollback_dir/ufw-default"
if ufw status | grep -qx 'Status: active'; then touch "$rollback_dir/ufw-active"; fi` : ''}
printf '%s' ${posixQuote(rollbackScript)} > "$rollback_dir/rollback.sh"
touch "$rollback_dir/pending"
systemd-run --unit=${rollbackUnit} --on-active=5min /bin/bash "$rollback_dir/rollback.sh"
${fleetSsh ? `
sshd_command="$(command -v sshd || true)"
if [[ -z "$sshd_command" && -x /usr/sbin/sshd ]]; then sshd_command=/usr/sbin/sshd; fi
[[ -n "$sshd_command" ]] || { echo 'OpenSSH sshd is required for --fleet-ssh' >&2; exit 1; }
sshd_version="$("$sshd_command" -V 2>&1 || true)"
fleet_penalties=false
# Per-source penalties were introduced in OpenSSH 9.8. Use the target daemon,
# not the controller's SSH client, and omit the option unless support is proven.
if [[ "$sshd_version" =~ OpenSSH_([0-9]+)\\.([0-9]+) ]] &&
  (( BASH_REMATCH[1] > 9 || (BASH_REMATCH[1] == 9 && BASH_REMATCH[2] >= 8) )); then
  fleet_penalties=true
fi
fleet_file=/etc/ssh/sshd_config.d/50-happier-fleet.conf
fleet_scratch="$(mktemp -d)"
fleet_installed=false
fleet_complete=false
fleet_previous=false
fleet_changed=false
cleanup_fleet() {
  if [[ "$fleet_installed" = true && "$fleet_complete" = false ]]; then
    if [[ "$fleet_previous" = true ]]; then cp -p -- "$fleet_scratch/previous" "$fleet_file"
    else rm -f -- "$fleet_file"; fi
  fi
  rm -f -- "$fleet_scratch/candidate" "$fleet_scratch/previous"
  rmdir -- "$fleet_scratch"
}
trap cleanup_fleet EXIT
printf '%s\\n' 'MaxSessions 64' 'MaxStartups 100:30:200' > "$fleet_scratch/candidate"
fleet_options=(-o MaxSessions=64 -o MaxStartups=100:30:200)
if [[ "$fleet_penalties" = true ]]; then
  printf '%s\\n' 'PerSourcePenaltyExemptList 100.64.0.0/10' >> "$fleet_scratch/candidate"
  fleet_options+=(-o PerSourcePenaltyExemptList=100.64.0.0/10)
fi
# Validate the complete current configuration with the supported requested options
# before replacing anything, then validate the installed drop-in before reload.
"$sshd_command" -t "\${fleet_options[@]}"
if ! cmp -s -- "$fleet_scratch/candidate" "$fleet_file"; then
  if [[ -e "$fleet_file" ]]; then cp -p -- "$fleet_file" "$fleet_scratch/previous"; fleet_previous=true; fi
  install -d -m 0755 /etc/ssh/sshd_config.d
  fleet_installed=true
  install -m 0644 "$fleet_scratch/candidate" "$fleet_file"
  fleet_changed=true
fi
"$sshd_command" -t
effective_fleet="$("$sshd_command" -T)"
grep -qx 'maxsessions 64' <<< "$effective_fleet" &&
  grep -qx 'maxstartups 100:30:200' <<< "$effective_fleet" &&
  { [[ "$fleet_penalties" = false ]] || grep -qx 'persourcepenaltyexemptlist 100.64.0.0/10' <<< "$effective_fleet"; } || {
    echo 'Fleet SSH drop-in is overridden or not included by sshd_config' >&2; exit 1;
  }
if [[ "$fleet_changed" = true ]]; then systemctl reload ssh; fi
fleet_complete=true
echo '[dev-targets] fleet SSH configuration ready'
` : ''}
${lockdown ? `
sshd_command="$(command -v sshd || printf /usr/sbin/sshd)"
lockdown_file=/etc/ssh/sshd_config.d/40-happier-no-password.conf
lockdown_candidate="$(mktemp)"
printf '%s\\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin prohibit-password' > "$lockdown_candidate"
"$sshd_command" -t -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=prohibit-password
lockdown_changed=false
if ! cmp -s "$lockdown_candidate" "$lockdown_file"; then
  install -d -m 0755 /etc/ssh/sshd_config.d
  install -m 0644 "$lockdown_candidate" "$lockdown_file"
  lockdown_changed=true
fi
rm -f -- "$lockdown_candidate"
"$sshd_command" -t
for lockdown_user in "$worker_user" root; do
  effective_lockdown="$("$sshd_command" -T -C "user=$lockdown_user,host=$client_ip,addr=$client_ip,laddr=$destination_ip,lport=$destination_port")"
  grep -qx 'passwordauthentication no' <<< "$effective_lockdown" &&
    grep -qx 'kbdinteractiveauthentication no' <<< "$effective_lockdown" &&
    grep -Eq '^permitrootlogin (prohibit-password|without-password)$' <<< "$effective_lockdown" || { echo 'Lockdown drop-in is overridden or not included for the SSH account/address' >&2; exit 1; }
done
if [[ "$lockdown_changed" = true ]]; then systemctl reload ssh; fi
firewall_status="$(ufw status verbose)"
firewall_ready=false
if grep -qx 'Status: active' <<< "$firewall_status" && grep -q 'Default: deny (incoming), allow (outgoing)' <<< "$firewall_status" &&
  awk -v public=${lockdown === 'ssh-public' ? '1' : '0'} '
    /ALLOW|DENY|REJECT|LIMIT/ {
      if ($0 ~ /^Anywhere( \\(v6\\))? on tailscale0[[:space:]]+ALLOW IN[[:space:]]+Anywhere/) { tailnet=1; next }
      if (public && $0 ~ /^22\\/tcp( \\(v6\\))?[[:space:]]+ALLOW IN[[:space:]]+Anywhere/) { ssh=1; next }
      invalid=1
    }
    END { exit !(tailnet && (!public || ssh) && !invalid) }
  ' <<< "$firewall_status"; then firewall_ready=true; fi
if [[ "$firewall_ready" = false ]]; then
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow in on tailscale0
  ${lockdown === 'ssh-public' ? 'ufw allow 22/tcp' : ''}
  ufw --force enable
fi
ufw status verbose
` : ''}
fi
`;
  const script = `
set -eu
if [ "$(uname -s)" != Linux ]; then
  ${allLinux ? "echo '[dev-targets] skipping non-Linux target'; exit 0" : "echo 'host prepare requires Linux' >&2; exit 1"}
fi
worker_user="$(id -un)"
worker_corepack="$(command -v corepack || true)"
worker_node="$(node -p 'process.execPath' 2>/dev/null || true)"
needs_root=${growRoot || passwordlessSudo || diskTmp || inotify || toolchain || createUser || tailscale || autoUpdates ? 'true' : 'false'}
${noSleep ? `
power_status="$(sh -c ${posixQuote(buildWorkerPowerScript('posix', { action: 'inspect' }))})"
case "$power_status" in
  *__HAPPIER_WORKER_POWER__='{"ok":true,'*) ;;
  *) needs_root=true ;;
esac
` : ''}
if [ "$needs_root" = false ]; then
  echo '[dev-targets] requested host settings already satisfied'
  exit 0
fi
${elevatedBash(rootScript, '"$worker_user" "$worker_corepack" "$worker_node" prepare', tailscaleAuthkeyStdin)}
`;
  if (growRoot || noSleep || passwordlessSudo || diskTmp || inotify || toolchain || createUser || tailscale || autoUpdates) {
    await runInteractive({ command: 'ssh', args: configuredSshArgs({ configPath: target.sshConfigFile,
      sshAlias: target.ssh, remoteCommand: prependRemotePath(target, `bash -c ${posixQuote(script)}`), tty: !tailscaleAuthkeyStdin }), env });
  }
  let prepared = target;
  let previousSshConfig = null;
  if (createUser || tailscale) {
    if (!target.sshConfigFile) throw new Error('[dev-targets] changing the SSH account/address requires a managed SSH configuration');
    const previousDiscovery = normalizeDiscovery(await probe(target, discoveryCommand()), { requireToolchain: false });
    const tailnet = tailscale ? readMarker(await probe(target,
      `tailscale status --json | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"' && printf '__HAPPIER_TAILNET__=%s\\n' "$(tailscale ip -4)"`).then(result => result.out), 'TAILNET') : null;
    if (tailscale && !/^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(tailnet)) throw new Error('[dev-targets] Tailscale did not return a joined tailnet address');
    const oldConfig = await readFile(target.sshConfigFile, 'utf8');
    let nextConfig = oldConfig;
    if (createUser) nextConfig = nextConfig.replace(/^(\s*User\s+).*$/m, `$1${createUser}`);
    const oldHost = oldConfig.match(/^\s*HostName\s+(\S+)/m)?.[1];
    if (tailnet && tailnet !== oldHost) {
      nextConfig = nextConfig.replace(/^(\s*HostName\s+).*$/m, `$1${tailnet}`);
      // The address changes, not host trust: verify the same pinned host key.
      if (!/^\s*HostKeyAlias\s+/m.test(nextConfig)) nextConfig += `  HostKeyAlias ${oldHost}\n`;
    }
    const candidatePath = `${target.sshConfigFile}.prepare-${process.pid}`;
    await writeSshConfig(candidatePath, nextConfig);
    const candidate = { ...target, sshConfigFile: candidatePath };
    try {
      await probe(candidate);
      // Sudo ignores dotted includedir filenames; test the installed policy,
      // not only the temporary fragment's syntax, before changing access.
      if (createUser) await probe(candidate, 'sudo -n true');
      const discovered = normalizeDiscovery(await probe(candidate, discoveryCommand()), { requireToolchain: toolchain });
      prepared = { ...target, remotePath: discovered.remotePath,
        repoDir: target.repoDir === join(previousDiscovery.remoteHome, 'happier-dev') ? join(discovered.remoteHome, 'happier-dev') : target.repoDir,
        cliHomeDir: target.cliHomeDir === join(previousDiscovery.remoteHome, '.happier', 'dev-targets', target.name)
          ? join(discovered.remoteHome, '.happier', 'dev-targets', target.name) : target.cliHomeDir };
      previousSshConfig = oldConfig;
      await rename(candidatePath, target.sshConfigFile);
    } finally { await rm(candidatePath, { force: true }); }
  } else if (toolchain) {
    const discovered = normalizeDiscovery(await probe(target, discoveryCommand()), { requireToolchain: true });
    prepared = { ...target, remotePath: discovered.remotePath };
  }
  if (fleetSsh || lockdown) {
    await probe(prepared);
    const elevate = body => `bash -c ${posixQuote(elevatedBash(body))}`;
    const security = `set -eu
if [ "$(uname -s)" != Linux ]; then ${allLinux ? 'exit 0' : 'exit 1'}; fi
${elevatedBash(rootScript, '"$(id -un)" \'\' \'\' security "${SSH_CONNECTION:-}"')}`;
    const runPolicy = async command => await runInteractive({ command: 'ssh', args: configuredSshArgs({
      configPath: prepared.sshConfigFile, sshAlias: prepared.ssh, remoteCommand: command, tty: true, dedicated: true }), env });
    try {
      await runPolicy(security);
      await probe(prepared);
      await runPolicy(elevate(`set -euo pipefail
state=${posixQuote(rollbackDir)}
[[ -f "$state/pending" ]] || { echo 'Rollback already ran; policy was not committed' >&2; exit 1; }
systemctl stop ${rollbackUnit}.timer
[[ "$(systemctl show --property=ExecMainStartTimestampMonotonic --value ${rollbackUnit}.service)" = 0 ]] || { echo 'Rollback was triggered; policy was not committed' >&2; exit 1; }
[[ -f "$state/pending" ]] || exit 1
rm -rf -- "$state"
echo '[dev-targets] fresh key login verified; automatic rollback canceled'`));
    } catch (error) {
      // Immediate recovery is best effort; the independently armed timer stays
      // authoritative if the controller no longer has any working connection.
      try { await runPolicy(elevate(`bash ${posixQuote(`${rollbackDir}/rollback.sh`)}`)); } catch {}
      if (previousSshConfig != null) await writeSshConfig(target.sshConfigFile, previousSshConfig);
      throw error;
    }
  }
  return prepared;
}

function discoveryCommand() {
  const inner = [
    'printf "__HAPPIER_UNAME__=%s\\n" "$(uname -s)"',
    'printf "__HAPPIER_HOME__=%s\\n" "$HOME"',
    'printf "__HAPPIER_PATH__=%s\\n" "$PATH"',
    'node_command="$(command -v node 2>/dev/null || true)"',
    'node_exec="$(node -p "process.execPath" 2>/dev/null || true)"',
    'node_version="$(node --version 2>/dev/null || true)"',
    'corepack_command="$(command -v corepack 2>/dev/null || true)"',
    'if [ -z "$corepack_command" ] && [ -n "$node_exec" ]; then node_bin_dir="$(dirname "$node_exec")"; [ -x "$node_bin_dir/corepack" ] && corepack_command="$node_bin_dir/corepack"; fi',
    'printf "__HAPPIER_NODE__=%s\\n" "$node_command"',
    'printf "__HAPPIER_NODE_VERSION__=%s\\n" "$node_version"',
    'printf "__HAPPIER_COREPACK__=%s\\n" "$corepack_command"',
  ].join('; ');
  return `remote_shell="${'${SHELL:-/bin/sh}'}"; "$remote_shell" -lic ${posixQuote(inner)}`;
}

function normalizeDiscovery(discovery, { requireToolchain }) {
  if (!discovery?.ok) {
    const detail = String(discovery?.err ?? '').trim() || 'remote discovery failed';
    throw new Error(`[dev-targets] SSH provisioned, but remote discovery failed: ${detail}`);
  }
  const uname = readMarker(discovery.out, 'UNAME');
  if (uname !== 'Darwin' && uname !== 'Linux') {
    throw new Error(`[dev-targets] one-command SSH provisioning currently supports macOS and Linux targets; found ${uname || 'unknown'}`);
  }
  const remoteHome = requireAbsolutePosixPath(readMarker(discovery.out, 'HOME'), 'discovered remote home');
  const nodePath = readMarker(discovery.out, 'NODE');
  const nodeVersion = readMarker(discovery.out, 'NODE_VERSION');
  const corepackPath = readMarker(discovery.out, 'COREPACK');
  if (requireToolchain && (!nodePath.startsWith('/') || !corepackPath.startsWith('/'))) {
    throw new Error(
      '[dev-targets] SSH is ready, but Node.js and Corepack were not discoverable in the remote login shell; install them and rerun add',
    );
  }
  const nodeMajor = Number(nodeVersion.match(/^v?(\d+)/)?.[1]);
  if (requireToolchain && Number.isInteger(nodeMajor) && nodeMajor < 22) {
    throw new Error(
      `[dev-targets] SSH is ready, but Node.js 22 or newer is required; found ${nodeVersion}`,
    );
  }
  const discoveredPath = readMarker(discovery.out, 'PATH')
    .split(':')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry.startsWith('/'));
  const remotePath = [...new Set([
    ...(nodePath.startsWith('/') ? [dirname(nodePath)] : []),
    ...(corepackPath.startsWith('/') ? [dirname(corepackPath)] : []),
    ...discoveredPath,
  ])];
  return { remoteHome, remotePath, toolchainReady: nodePath.startsWith('/') && corepackPath.startsWith('/') && (!Number.isInteger(nodeMajor) || nodeMajor >= 22) };
}

async function writeSshConfig(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export function renderSshConfig({
  sshAlias,
  remoteHost,
  remoteUser,
  keyPath,
  knownHostsPath,
  strictHostKeyChecking,
}) {
  return [
    `Host ${sshAlias}`,
    `  HostName ${remoteHost}`,
    `  User ${remoteUser}`,
    `  IdentityFile ${sshConfigQuote(keyPath)}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${sshConfigQuote(knownHostsPath)}`,
    `  StrictHostKeyChecking ${strictHostKeyChecking}`,
    '  BatchMode yes',
    '  ConnectTimeout 10',
    '  ServerAliveInterval 15',
    '  ServerAliveCountMax 3',
    '  ControlMaster auto',
    '  ControlPersist 600',
    '  ControlPath "~/.ssh/happier-dev-target-%C"',
    '',
  ].join('\n');
}

export async function provisionPosixDevTarget(
  {
    name,
    host,
    user,
    stackBaseDir,
    repoDir = null,
    cliHomeDir = null,
    requireToolchain = true,
    env = process.env,
  },
  {
    pathExists = existsSync,
    runInteractive = defaultRunInteractive,
    runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult,
  } = {},
) {
  const targetName = requireMatching(name, TARGET_NAME_RE, 'target name').toLowerCase();
  const remoteHost = requireMatching(host, HOST_RE, 'remote host');
  const remoteUser = requireMatching(user, USER_RE, 'remote user');
  const baseDir = requireAbsolutePosixPath(stackBaseDir, 'stack base directory');
  const sshDir = join(baseDir, 'dev-target-ssh', targetName);
  const keyPath = join(sshDir, 'id_ed25519');
  const publicKeyPath = `${keyPath}.pub`;
  const knownHostsPath = join(sshDir, 'known_hosts');
  const configPath = join(sshDir, 'ssh.config');
  const sshAlias = `happier-dev-target-${targetName}`;
  await mkdir(sshDir, { recursive: true, mode: 0o700 });

  const hasPrivateKey = pathExists(keyPath);
  const hasPublicKey = pathExists(publicKeyPath);
  if (hasPrivateKey !== hasPublicKey) {
    throw new Error(`[dev-targets] incomplete SSH key pair at ${sshDir}; restore or remove it before retrying`);
  }
  if (!hasPrivateKey) {
    await runInteractive({
      command: 'ssh-keygen',
      args: [
        '-q', '-t', 'ed25519', '-N', '',
        '-C', `happier-dev-target:${targetName}`,
        '-f', keyPath,
      ],
      env,
    });
  }

  const bootstrapConfig = renderSshConfig({
    sshAlias,
    remoteHost,
    remoteUser,
    keyPath,
    knownHostsPath,
    strictHostKeyChecking: 'accept-new',
  });
  const strictConfig = renderSshConfig({
    sshAlias,
    remoteHost,
    remoteUser,
    keyPath,
    knownHostsPath,
    strictHostKeyChecking: 'yes',
  });
  // An existing master proves neither this dedicated key nor strict host-key
  // verification. Enrollment must authenticate independently; commands reuse it.
  const probeArgs = configuredSshArgs({ configPath, sshAlias, remoteCommand: 'true', dedicated: true });
  let discovery;

  await writeSshConfig(configPath, bootstrapConfig);
  try {
    let probe = await runCaptureResultImpl({ command: 'ssh', args: probeArgs, env });
    if (!probe?.ok) {
      await runInteractive({
        command: 'ssh-copy-id',
        args: [
          '-F', configPath,
          '-o', 'BatchMode=no',
          '-o', 'IdentitiesOnly=yes',
          '-o', 'IdentityAgent=none',
          '-o', 'ControlMaster=no',
          '-o', 'ControlPath=none',
          '-i', publicKeyPath,
          sshAlias,
        ],
        env,
      });
      probe = await runCaptureResultImpl({ command: 'ssh', args: probeArgs, env });
    }
    if (!probe?.ok) {
      const detail = String(probe?.err ?? '').trim() || 'dedicated key authentication failed';
      throw new Error(`[dev-targets] could not verify provisioned SSH key: ${detail}`);
    }

    discovery = await runCaptureResultImpl({
      command: 'ssh',
      args: configuredSshArgs({ configPath, sshAlias, remoteCommand: discoveryCommand() }),
      env,
    });
  } finally {
    await writeSshConfig(configPath, strictConfig);
  }

  const strictProbe = await runCaptureResultImpl({ command: 'ssh', args: probeArgs, env });
  if (!strictProbe?.ok) {
    const detail = String(strictProbe?.err ?? '').trim() || 'strict host-key verification failed';
    throw new Error(`[dev-targets] SSH provisioned, but strict host-key verification failed after enrollment: ${detail}`);
  }
  const { remoteHome, remotePath, toolchainReady } = normalizeDiscovery(discovery, { requireToolchain });

  return {
    name: targetName,
    platform: 'posix',
    ssh: sshAlias,
    sshConfigFile: configPath,
    remoteHome,
    toolchainReady,
    controllerKey: { privateKeyPath: keyPath, publicKeyPath },
    repoDir: repoDir == null
      ? join(remoteHome, 'happier-dev')
      : requireAbsolutePosixPath(repoDir, 'remote repo directory'),
    cliHomeDir: cliHomeDir == null
      ? join(remoteHome, '.happier', 'dev-targets', targetName)
      : requireAbsolutePosixPath(cliHomeDir, 'remote CLI home directory'),
    remotePath,
    remoteServerPort: null,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--qa-setup-worker') {
  const dependencies = await provisionQaHostDependencies();
  process.stdout.write(`HSTACK_QA_SETUP=${JSON.stringify(dependencies)}\n`);
  process.exitCode = dependencies.ok ? 0 : 1;
}

export async function inspectProvisionedPosixDevTarget(
  { target, requireToolchain = false, env = process.env },
  {
    pathExists = existsSync,
    runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult,
  } = {},
) {
  if (target?.platform !== 'posix' || !target.sshConfigFile) {
    throw new Error('[dev-targets] an existing POSIX target with a managed SSH config is required');
  }
  const privateKeyPath = join(dirname(target.sshConfigFile), 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;
  if (!pathExists(privateKeyPath) || !pathExists(publicKeyPath)) {
    throw new Error(`[dev-targets] existing target ${target.name} does not own a reusable controller key pair`);
  }
  const baseArgs = ['-T', '-F', target.sshConfigFile, target.ssh];
  const probe = await runCaptureResultImpl({ command: 'ssh', args: configuredSshArgs({
    configPath: target.sshConfigFile, sshAlias: target.ssh, remoteCommand: 'true', dedicated: true }), env });
  if (!probe?.ok) {
    const detail = String(probe?.err ?? '').trim() || 'strict SSH probe failed';
    throw new Error(`[dev-targets] existing target ${target.name} is not reachable: ${detail}`);
  }
  const discovery = await runCaptureResultImpl({
    command: 'ssh',
    args: [...baseArgs, discoveryCommand()],
    env,
  });
  const { remoteHome, remotePath } = normalizeDiscovery(discovery, { requireToolchain });
  return {
    ...target,
    remoteHome,
    remotePath,
    controllerKey: { privateKeyPath, publicKeyPath },
  };
}
