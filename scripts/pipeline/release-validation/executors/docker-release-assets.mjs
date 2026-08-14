// @ts-check

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  formatPublicReleaseChannelChoices,
  normalizePublicReleaseChannel,
} from '../../release/lib/public-release-rings.mjs';

/** @typedef {'stable' | 'preview'} RelayUpgradeChannel */

/**
 * @typedef {{ kind: string; ref: string }} ReleaseValidationSource
 * @typedef {{ from: ReleaseValidationSource; to: ReleaseValidationSource }} ReleaseValidationUpdate
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => unknown} ExecFileSyncLike
 */

const RELEASE_ASSETS_E2E_RUN_SCRIPT = ['scripts', 'release', 'release-assets-e2e', 'run.sh'];

/**
 * @param {'linux' | 'darwin' | 'win32'} platform
 */
function assertLinuxPlatform(platform) {
  if (platform !== 'linux') {
    throw new Error('docker-release-assets currently supports only --platform linux');
  }
}

/**
 * @param {string} raw
 */
function resolvePublicChannel(raw) {
  const channel = normalizePublicReleaseChannel(raw);
  if (!channel) {
    throw new Error(
      `docker-release-assets requires a public release channel (${formatPublicReleaseChannelChoices({ stableAlias: 'stable' })})`,
    );
  }
  return channel;
}

/**
 * @param {string} packageName
 * @param {'stable' | 'preview' | 'publicdev'} channel
 */
function resolvePublishedNpmSpec(packageName, channel) {
  const distTag = channel === 'stable' ? 'latest' : 'next';
  return `${packageName}@${distTag}`;
}

/**
 * @param {'stable' | 'preview' | 'publicdev'} channel
 * @returns {RelayUpgradeChannel | null}
 */
function resolveRelayUpgradeChannel(channel) {
  if (channel === 'stable' || channel === 'preview') return channel;
  return null;
}

/**
 * @param {readonly string[]} values
 * @returns {string[]}
 */
function withArgs(values) {
  return [...values];
}

/**
 * @returns {{
 *   mode: 'local';
 *   monorepo: 'local';
 *   stackSpec: null;
 *   cliSpec: null;
 *   withRemoteDaemon: true;
 *   withRemoteServer: true;
 *   remoteInstaller: 'shim';
 *   remoteAuthMode: 'reuse-cli';
 *   withRelayUpgrade: true;
 *   relayUpgradeFromChannel: RelayUpgradeChannel;
 *   relayUpgradeDb: 'both';
 *   args: string[];
 * }}
 */
function createLocalBuildPlan() {
  return {
    mode: 'local',
    monorepo: 'local',
    stackSpec: null,
    cliSpec: null,
    withRemoteDaemon: true,
    withRemoteServer: true,
    remoteInstaller: 'shim',
    remoteAuthMode: 'reuse-cli',
    withRelayUpgrade: true,
    relayUpgradeFromChannel: 'preview',
    relayUpgradeDb: 'both',
    args: withArgs([
      '--mode=local',
      '--monorepo=local',
      '--with-remote-daemon',
      '--with-remote-server',
      '--remote-installer=shim',
      '--remote-auth-mode=reuse-cli',
      '--with-relay-upgrade',
      '--relay-upgrade-from-channel=preview',
      '--relay-upgrade-db=both',
    ]),
  };
}

/**
 * @param {'stable' | 'preview' | 'publicdev'} channel
 */
function createPublishedChannelPlan(channel) {
  const stackSpec = resolvePublishedNpmSpec('@happier-dev/stack', channel);
  const cliSpec = resolvePublishedNpmSpec('@happier-dev/cli', channel);

  return {
    mode: 'npm',
    monorepo: 'github',
    stackSpec,
    cliSpec,
    withRemoteDaemon: false,
    withRemoteServer: false,
    remoteInstaller: 'official',
    remoteAuthMode: 'reuse-cli',
    withRelayUpgrade: false,
    relayUpgradeFromChannel: null,
    relayUpgradeDb: null,
    args: withArgs([
      '--mode=npm',
      '--monorepo=github',
      `--stack-spec=${stackSpec}`,
      `--cli-spec=${cliSpec}`,
      '--no-remote-daemon',
      '--no-remote-server',
      '--remote-installer=official',
      '--remote-auth-mode=reuse-cli',
      '--no-relay-upgrade',
    ]),
  };
}

function resolveImmutableServerCandidate(raw) {
  const match = /^server-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(String(raw ?? '').trim());
  if (!match) {
    throw new Error('docker-release-assets immutable relay targets must use server-v<version>');
  }
  return { tag: match[0], version: match[1] };
}

/**
 * @param {RelayUpgradeChannel} fromChannel
 * @param {{ tag: string; version: string } | null} [immutableCandidate]
 */
function createRelayUpgradePlan(fromChannel, immutableCandidate = null) {
  return {
    mode: 'local',
    monorepo: 'local',
    stackSpec: null,
    cliSpec: null,
    withRemoteDaemon: true,
    withRemoteServer: true,
    remoteInstaller: 'shim',
    remoteAuthMode: 'reuse-cli',
    withRelayUpgrade: true,
    relayUpgradeFromChannel: fromChannel,
    relayUpgradeDb: 'both',
    ...(immutableCandidate ? {
      relayUpgradeToServerTag: immutableCandidate.tag,
      relayUpgradeToServerVersion: immutableCandidate.version,
    } : {}),
    args: withArgs([
      '--mode=local',
      '--monorepo=local',
      '--with-remote-daemon',
      '--with-remote-server',
      '--remote-installer=shim',
      '--remote-auth-mode=reuse-cli',
      '--with-relay-upgrade',
      `--relay-upgrade-from-channel=${fromChannel}`,
      '--relay-upgrade-db=both',
      ...(immutableCandidate ? [
        `--relay-upgrade-to-server-tag=${immutableCandidate.tag}`,
        `--relay-upgrade-to-server-version=${immutableCandidate.version}`,
      ] : []),
    ]),
  };
}

/**
 * @param {{
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: ReleaseValidationSource | null;
 *   update: ReleaseValidationUpdate | null;
 * }} params
 */
export function resolveDockerReleaseAssetsPlan({ platform, source, update }) {
  assertLinuxPlatform(platform);

  if (source && update) {
    throw new Error('docker-release-assets accepts either a direct source or an explicit from/to update, not both');
  }

  if (source) {
    if (source.kind === 'local-build') {
      return createLocalBuildPlan();
    }
    if (source.kind === 'published-channel') {
      const channel = resolvePublicChannel(source.ref);
      return createPublishedChannelPlan(channel);
    }
    throw new Error('docker-release-assets currently supports only --source local-build or --source published-channel <ring>');
  }

  if (!update) {
    throw new Error('docker-release-assets requires either --source/--ref or --from-source/--from-ref with --to-source/--to-ref');
  }

  if (update.from.kind !== 'published-channel' || !['local-build', 'published-tag'].includes(update.to.kind)) {
    throw new Error('docker-release-assets updates support published-channel -> local-build|published-tag relay upgrades');
  }

  const fromChannel = resolvePublicChannel(update.from.ref);
  const relayUpgradeChannel = resolveRelayUpgradeChannel(fromChannel);
  if (!relayUpgradeChannel) {
    throw new Error('docker-release-assets relay upgrade currently supports only stable|preview source channels');
  }

  const immutableCandidate = update.to.kind === 'published-tag'
    ? resolveImmutableServerCandidate(update.to.ref)
    : null;
  return createRelayUpgradePlan(relayUpgradeChannel, immutableCandidate);
}

/**
 * @param {{
 *   repoRoot: string;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: ReleaseValidationSource | null;
 *   update: ReleaseValidationUpdate | null;
 * }} params
 */
export function resolveDockerReleaseAssetsExecution({ repoRoot, platform, source, update }) {
  const plan = resolveDockerReleaseAssetsPlan({ platform, source, update });
  return {
    type: 'command',
    command: 'bash',
    args: [resolve(repoRoot, ...RELEASE_ASSETS_E2E_RUN_SCRIPT), ...plan.args],
    cwd: repoRoot,
  };
}

/**
 * @param {{ exec?: ExecFileSyncLike }} [opts]
 */
export function assertDockerReleaseAssetsAvailable(opts = {}) {
  const exec = opts.exec ?? execFileSync;
  try {
    exec('docker', ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10_000,
    });
  } catch (error) {
    const message = String(
      // @ts-expect-error Node sync exec errors expose stderr
      error?.stderr ?? error?.message ?? error,
    ).trim();
    throw new Error(
      [
        'docker-release-assets requires Docker to be running.',
        'Fix: start Docker Desktop or the local Docker engine, then retry.',
        message ? `Raw error: ${message}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

/**
 * @param {{
 *   repoRoot: string;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: ReleaseValidationSource | null;
 *   update: ReleaseValidationUpdate | null;
 *   exec?: ExecFileSyncLike;
 *   assertDockerAvailable?: (opts?: { exec?: ExecFileSyncLike }) => void;
 * }} params
 */
export function runDockerReleaseAssetsValidation({
  repoRoot,
  platform,
  source,
  update,
  exec = execFileSync,
  assertDockerAvailable = assertDockerReleaseAssetsAvailable,
}) {
  assertDockerAvailable({ exec });
  const execution = resolveDockerReleaseAssetsExecution({ repoRoot, platform, source, update });
  exec(execution.command, execution.args, {
    cwd: execution.cwd,
    stdio: 'inherit',
  });
}
