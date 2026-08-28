import { createHash } from 'node:crypto';

import { validateManagedLimaInstanceName } from './profiles.mjs';

const PROFILES = new Set(['happier', 'installer', 'bare']);
const SIMPLE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export const REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN = Object.freeze([
  Object.freeze({ command: 'node', label: 'Node.js' }),
  Object.freeze({ command: 'corepack', label: 'Corepack' }),
  Object.freeze({ command: 'rg', label: 'ripgrep (rg)' }),
]);

function requireProvisionProfile(value) {
  const profile = String(value ?? '').trim();
  if (!PROFILES.has(profile)) {
    throw new Error(`[managed-lima] unsupported guest provisioning profile: ${JSON.stringify(profile)}`);
  }
  return profile;
}

function requireToolchainValue(value, label) {
  const normalized = String(value ?? '').trim();
  if (!SIMPLE_VERSION_RE.test(normalized)) {
    throw new Error(`[managed-lima] invalid ${label}: ${JSON.stringify(normalized)}`);
  }
  return normalized;
}

function provisionVersion({
  scriptSource,
  profile,
  nodeMajor,
  yarnVersion,
  mutagenVersion,
  agentBrowserVersion,
  playwrightVersion,
  bunVersion,
}) {
  return createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: 1,
      profile,
      nodeMajor,
      yarnVersion,
      mutagenVersion,
      agentBrowserVersion,
      playwrightVersion,
      bunVersion,
    }))
    .update('\0')
    .update(scriptSource)
    .digest('hex');
}

export async function inspectManagedLimaGuestIdentity({ executor, instance: rawInstance }) {
  if (!executor || typeof executor.capture !== 'function') throw new Error('[managed-lima] executor is required');
  const instance = validateManagedLimaInstanceName(rawInstance);
  const result = await executor.capture('limactl', [
    'shell', instance, '--', 'sh', '-lc', 'printf "%s\\0%s" "$HOME" "$USER"',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`[managed-lima] failed to inspect guest identity: ${String(result.err ?? '').trim() || 'limactl shell failed'}`);
  }
  const [rawHomeDir, rawUser = ''] = String(result.out ?? '').split('\0', 2);
  const homeDir = rawHomeDir.trim();
  const user = rawUser.trim();
  if (!homeDir.startsWith('/') || /[\0\r\n]/.test(homeDir)) {
    throw new Error('[managed-lima] guest returned an invalid home directory');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error('[managed-lima] guest returned an invalid user');
  return { homeDir, user };
}

const LOGIN_MANAGER_HEALTH_COMMAND = 'timeout 5 loginctl list-sessions --no-legend >/dev/null 2>&1';
const LOGIN_MANAGER_REPAIR_COMMAND = [
  'set -eu',
  'sudo systemctl kill --kill-whom=main --signal=KILL systemd-logind.service || true',
  'sudo systemctl reset-failed systemd-logind.service || true',
  'sudo systemctl start systemd-logind.service',
].join('; ');
const MANAGED_LIMA_GUEST_COMMANDS = Object.freeze([
  ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN,
  Object.freeze({ command: 'yarn', label: 'Yarn' }),
  Object.freeze({ command: 'mutagen', label: 'Mutagen' }),
  Object.freeze({ command: 'bwrap', label: 'Bubblewrap (bwrap)' }),
  Object.freeze({ command: 'agent-browser', label: 'agent-browser' }),
  Object.freeze({ command: 'bun', label: 'Bun' }),
  Object.freeze({ command: 'jq', label: 'jq' }),
]);

function guestToolchainHealthCommand({ nodeMajor, yarnVersion, mutagenVersion, agentBrowserVersion, playwrightVersion, bunVersion }) {
  return [
    'set -eu',
    ...MANAGED_LIMA_GUEST_COMMANDS.map(({ command, label }) => (
      `command -v ${command} >/dev/null 2>&1 || { echo "${label} is required in the managed Lima guest" >&2; exit 127; }`
    )),
    ...MANAGED_LIMA_GUEST_COMMANDS
      .filter(({ command }) => command !== 'yarn' && command !== 'mutagen' && command !== 'agent-browser' && command !== 'bun')
      .map(({ command }) => `${command} --version >/dev/null`),
    `node --version | grep -Eq '^v?${nodeMajor}(\\.|$)' || { echo "Node.js ${nodeMajor} is required in the managed Lima guest" >&2; exit 1; }`,
    `yarn --version | grep -Fx '${yarnVersion}' >/dev/null || { echo "Yarn ${yarnVersion} is required in the managed Lima guest" >&2; exit 1; }`,
    `mutagen version | grep -Fx '${mutagenVersion}' >/dev/null || { echo "Mutagen ${mutagenVersion} is required in the managed Lima guest" >&2; exit 1; }`,
    `agent-browser --version | awk '{print $NF}' | grep -Fx '${agentBrowserVersion}' >/dev/null || { echo "agent-browser ${agentBrowserVersion} is required in the managed Lima guest" >&2; exit 1; }`,
    `bun --version | grep -Fx '${bunVersion}' >/dev/null || { echo "Bun ${bunVersion} is required in the managed Lima guest" >&2; exit 1; }`,
    'test -f /etc/apparmor.d/happier-bwrap || { echo "happier-bwrap AppArmor profile is required in the managed Lima guest" >&2; exit 1; }',
    'grep -Eq "^[[:space:]]*profile[[:space:]]+happier-bwrap[[:space:]]" /etc/apparmor.d/happier-bwrap || { echo "happier-bwrap AppArmor profile is invalid" >&2; exit 1; }',
    'grep -Eq "^[[:space:]]*userns,[[:space:]]*$" /etc/apparmor.d/happier-bwrap || { echo "happier-bwrap AppArmor userns permission is missing" >&2; exit 1; }',
    'if [ -r /sys/kernel/security/apparmor/profiles ]; then sudo -n grep -Eq "(^|[[:space:]])happier-bwrap([[:space:]]|$)" /sys/kernel/security/apparmor/profiles || { echo "happier-bwrap AppArmor profile is not loaded" >&2; exit 1; }; else echo "happier-bwrap AppArmor profile listing is unavailable" >&2; exit 1; fi',
    `if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then test -f "$HOME/.agent-browser/config.json" || { echo "Playwright ARM64 headless shell config is required in the managed Lima guest" >&2; exit 1; }; browser_executable="$(jq -er ".executablePath" "$HOME/.agent-browser/config.json")" || { echo "Playwright ARM64 headless shell config is invalid" >&2; exit 1; }; case "$browser_executable" in "$HOME"/.cache/happier/agent-browser-browsers/*/chrome-linux/headless_shell) ;; *) echo "Playwright ARM64 headless shell path is invalid" >&2; exit 1 ;; esac; test -x "$browser_executable" || { echo "Playwright ${playwrightVersion} ARM64 headless shell is unavailable" >&2; exit 1; }; fi`,
  ].join('; ');
}
const GUEST_AGENT_SERVICE = 'lima-guestagent.service';
const GUEST_AGENT_HEALTH_COMMAND = `systemctl is-active --quiet ${GUEST_AGENT_SERVICE}`;
const GUEST_AGENT_RESTART_COMMAND = [
  `sudo systemctl kill -s SIGKILL ${GUEST_AGENT_SERVICE} || true`,
  `sudo systemctl reset-failed ${GUEST_AGENT_SERVICE}`,
  `sudo systemctl start ${GUEST_AGENT_SERVICE}`,
].join('; ');

export async function inspectManagedLimaGuestLoginManager({ executor, instance: rawInstance }) {
  if (!executor || typeof executor.capture !== 'function') throw new Error('[managed-lima] executor is required');
  const instance = validateManagedLimaInstanceName(rawInstance);
  const result = await executor.capture('limactl', [
    'shell', instance, '--', 'sh', '-lc', LOGIN_MANAGER_HEALTH_COMMAND,
  ]);
  return result.exitCode === 0
    ? { ok: true, error: null }
    : { ok: false, error: String(result.err ?? '').trim() || 'loginctl timed out' };
}

export async function ensureManagedLimaGuestLoginManager({ executor, instance: rawInstance }) {
  if (!executor || typeof executor.capture !== 'function' || typeof executor.run !== 'function') {
    throw new Error('[managed-lima] executor is required');
  }
  const instance = validateManagedLimaInstanceName(rawInstance);
  const inspect = async () => await inspectManagedLimaGuestLoginManager({ executor, instance });
  if ((await inspect()).ok) return { repaired: false };

  await executor.run('limactl', [
    'shell', instance, '--', 'sh', '-lc', LOGIN_MANAGER_REPAIR_COMMAND,
  ]);
  const repaired = await inspect();
  if (!repaired.ok) {
    const error = new Error(
      `[managed-lima] guest login manager remained unresponsive after targeted repair: ${repaired.error}`,
    );
    error.code = 'MANAGED_LIMA_GUEST_LOGIN_MANAGER_UNHEALTHY';
    throw error;
  }
  return { repaired: true };
}

export async function inspectManagedLimaGuestToolchain({
  executor,
  instance: rawInstance,
  nodeMajor: rawNodeMajor = '24',
  yarnVersion: rawYarnVersion = '1.22.22',
  mutagenVersion: rawMutagenVersion = '0.18.1',
  agentBrowserVersion: rawAgentBrowserVersion = '0.34.0',
  playwrightVersion: rawPlaywrightVersion = '1.58.2',
  bunVersion: rawBunVersion = '1.3.5',
}) {
  if (!executor || typeof executor.capture !== 'function') throw new Error('[managed-lima] executor is required');
  const instance = validateManagedLimaInstanceName(rawInstance);
  const nodeMajor = requireToolchainValue(rawNodeMajor, 'Node major');
  const yarnVersion = requireToolchainValue(rawYarnVersion, 'Yarn version');
  const mutagenVersion = requireToolchainValue(rawMutagenVersion, 'Mutagen version');
  const agentBrowserVersion = requireToolchainValue(rawAgentBrowserVersion, 'agent-browser version');
  const playwrightVersion = requireToolchainValue(rawPlaywrightVersion, 'Playwright version');
  const bunVersion = requireToolchainValue(rawBunVersion, 'Bun version');
  const result = await executor.capture('limactl', [
    'shell', instance, '--', 'sh', '-lc', guestToolchainHealthCommand({
      nodeMajor,
      yarnVersion,
      mutagenVersion,
      agentBrowserVersion,
      playwrightVersion,
      bunVersion,
    }),
  ]);
  if (result.exitCode === 0) return { ok: true, error: null };
  return {
    ok: false,
    error: String(result.err ?? '').trim()
      || String(result.out ?? '').trim()
      || 'required managed Lima guest toolchain is unavailable',
  };
}

export async function restartManagedLimaGuestAgent({ executor, instance: rawInstance }) {
  if (!executor || typeof executor.capture !== 'function' || typeof executor.run !== 'function') {
    throw new Error('[managed-lima] executor is required');
  }
  const instance = validateManagedLimaInstanceName(rawInstance);
  const restart = await executor.run('limactl', [
    'shell', instance, '--', 'sh', '-lc', GUEST_AGENT_RESTART_COMMAND,
  ]);
  if (restart?.exitCode !== undefined && restart.exitCode !== 0) {
    const error = new Error('[managed-lima] failed to restart the existing Lima guest agent');
    error.code = 'MANAGED_LIMA_GUEST_AGENT_RESTART_FAILED';
    throw error;
  }
  const health = await executor.capture('limactl', [
    'shell', instance, '--', 'sh', '-lc', GUEST_AGENT_HEALTH_COMMAND,
  ]);
  if (health.exitCode !== 0) {
    const error = new Error(
      `[managed-lima] Lima guest agent remained unhealthy after targeted restart: ${String(health.err ?? '').trim() || 'systemctl is-active failed'}`,
    );
    error.code = 'MANAGED_LIMA_GUEST_AGENT_UNHEALTHY';
    throw error;
  }
  return { restarted: true };
}

export async function provisionManagedLimaGuest({
  executor,
  instance: rawInstance,
  scriptSource,
  profile: rawProfile = 'happier',
  nodeMajor: rawNodeMajor = '24',
  yarnVersion: rawYarnVersion = '1.22.22',
  mutagenVersion: rawMutagenVersion = '0.18.1',
  agentBrowserVersion: rawAgentBrowserVersion = '0.34.0',
  playwrightVersion: rawPlaywrightVersion = '1.58.2',
  bunVersion: rawBunVersion = '1.3.5',
}) {
  if (!executor || typeof executor.capture !== 'function' || typeof executor.run !== 'function') {
    throw new Error('[managed-lima] executor is required');
  }
  const instance = validateManagedLimaInstanceName(rawInstance);
  const profile = requireProvisionProfile(rawProfile);
  const nodeMajor = requireToolchainValue(rawNodeMajor, 'Node major');
  const yarnVersion = requireToolchainValue(rawYarnVersion, 'Yarn version');
  const mutagenVersion = requireToolchainValue(rawMutagenVersion, 'Mutagen version');
  const agentBrowserVersion = requireToolchainValue(rawAgentBrowserVersion, 'agent-browser version');
  const playwrightVersion = requireToolchainValue(rawPlaywrightVersion, 'Playwright version');
  const bunVersion = requireToolchainValue(rawBunVersion, 'Bun version');
  const source = String(scriptSource ?? '');
  if (!source.trim()) throw new Error('[managed-lima] guest provision script is empty');

  const version = provisionVersion({
    scriptSource: source,
    profile,
    nodeMajor,
    yarnVersion,
    mutagenVersion,
    agentBrowserVersion,
    playwrightVersion,
    bunVersion,
  });
  const markerDir = '.local/state/happier/managed-lima-provision';
  const markerPath = `${markerDir}/${version}.ready`;
  const current = await executor.capture('limactl', [
    'shell', instance, '--', 'test', '-f', markerPath,
  ]);
  if (current.exitCode === 0) {
    const health = await inspectManagedLimaGuestToolchain({
      executor,
      instance,
      nodeMajor,
      yarnVersion,
      mutagenVersion,
      agentBrowserVersion,
      playwrightVersion,
      bunVersion,
    });
    if (health.ok) return { changed: false, version, markerPath };
  }

  await executor.run('limactl', [
    'shell', instance, '--',
    'env',
    `HAPPIER_PROVISION_NODE_MAJOR=${nodeMajor}`,
    `HAPPIER_PROVISION_YARN_VERSION=${yarnVersion}`,
    `HAPPIER_PROVISION_MUTAGEN_VERSION=${mutagenVersion}`,
    `HAPPIER_PROVISION_AGENT_BROWSER_VERSION=${agentBrowserVersion}`,
    `HAPPIER_PROVISION_PLAYWRIGHT_VERSION=${playwrightVersion}`,
    `HAPPIER_PROVISION_BUN_VERSION=${bunVersion}`,
    'bash', '-s', '--', `--profile=${profile}`,
  ], { input: source });
  const health = await inspectManagedLimaGuestToolchain({
    executor,
    instance,
    nodeMajor,
    yarnVersion,
    mutagenVersion,
    agentBrowserVersion,
    playwrightVersion,
    bunVersion,
  });
  if (!health.ok) {
    const error = new Error(
      `[managed-lima] required guest toolchain remained unavailable after provisioning: ${health.error}`,
    );
    error.code = 'MANAGED_LIMA_GUEST_TOOLCHAIN_UNHEALTHY';
    throw error;
  }
  await executor.run('limactl', [
    'shell', instance, '--', 'bash', '-lc',
    `mkdir -p '${markerDir}' && : > '${markerPath}'`,
  ]);
  return { changed: true, version, markerPath };
}
