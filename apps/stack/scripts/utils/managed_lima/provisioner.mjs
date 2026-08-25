import { createHash } from 'node:crypto';

import { validateManagedLimaInstanceName } from './profiles.mjs';

const PROFILES = new Set(['happier', 'installer', 'bare']);
const SIMPLE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

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

function provisionVersion({ scriptSource, profile, nodeMajor, yarnVersion }) {
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, profile, nodeMajor, yarnVersion }))
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

export async function provisionManagedLimaGuest({
  executor,
  instance: rawInstance,
  scriptSource,
  profile: rawProfile = 'happier',
  nodeMajor: rawNodeMajor = '24',
  yarnVersion: rawYarnVersion = '1.22.22',
}) {
  if (!executor || typeof executor.capture !== 'function' || typeof executor.run !== 'function') {
    throw new Error('[managed-lima] executor is required');
  }
  const instance = validateManagedLimaInstanceName(rawInstance);
  const profile = requireProvisionProfile(rawProfile);
  const nodeMajor = requireToolchainValue(rawNodeMajor, 'Node major');
  const yarnVersion = requireToolchainValue(rawYarnVersion, 'Yarn version');
  const source = String(scriptSource ?? '');
  if (!source.trim()) throw new Error('[managed-lima] guest provision script is empty');

  const version = provisionVersion({ scriptSource: source, profile, nodeMajor, yarnVersion });
  const markerDir = '.local/state/happier/managed-lima-provision';
  const markerPath = `${markerDir}/${version}.ready`;
  const current = await executor.capture('limactl', [
    'shell', instance, '--', 'test', '-f', markerPath,
  ]);
  if (current.exitCode === 0) return { changed: false, version, markerPath };

  await executor.run('limactl', [
    'shell', instance, '--',
    'env',
    `HAPPIER_PROVISION_NODE_MAJOR=${nodeMajor}`,
    `HAPPIER_PROVISION_YARN_VERSION=${yarnVersion}`,
    'bash', '-s', '--', `--profile=${profile}`,
  ], { input: source });
  await executor.run('limactl', [
    'shell', instance, '--', 'bash', '-lc',
    `mkdir -p '${markerDir}' && : > '${markerPath}'`,
  ]);
  return { changed: true, version, markerPath };
}
