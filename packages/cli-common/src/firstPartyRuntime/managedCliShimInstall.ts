import { basename, dirname } from 'node:path';

import { resolveFirstPartyComponentPublicReleaseVariant } from './componentCatalog.js';
import { readDefaultManagedReleaseChannelSync } from './defaultReleaseChannelState.js';

type ManagedCliChannel = 'stable' | 'preview' | 'publicdev';

export type ManagedCliShimInstall = Readonly<{
  channel: ManagedCliChannel;
  installRootName: string;
  happierHomeDir: string;
}>;

const MANAGED_CLI_CHANNELS = ['stable', 'preview', 'publicdev'] as const;

function resolveCliVariant(channel: ManagedCliChannel) {
  return resolveFirstPartyComponentPublicReleaseVariant({ componentId: 'happier-cli', channel });
}

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

function normalizeExecutableBase(pathLike: string): string {
  return basename(normalizePathLike(pathLike)).toLowerCase().replace(/\.exe$/, '');
}

// The stable `happier` shim is the default shim: installs link it to the default release channel's
// binary (see `resolveDesiredShimTargets`), so its channel is that home's default, not stable.
const DEFAULT_CLI_SHIM_NAME = normalizeExecutableBase(resolveCliVariant('stable').installShims[0] ?? 'happier');

const CHANNEL_SHIM_NAMES = new Map<string, ManagedCliChannel>(
  MANAGED_CLI_CHANNELS.flatMap((channel) => {
    const legacyShimAliases =
      channel === 'preview'
        ? ['happier-preview']
        : channel === 'publicdev'
          ? ['happier-dev']
          : [];
    return [...resolveCliVariant(channel).installShims, ...legacyShimAliases]
      .map((shimName) => normalizeExecutableBase(shimName))
      .filter((shimName) => shimName !== DEFAULT_CLI_SHIM_NAME)
      .map((shimName) => [shimName, channel] as const);
  }),
);

/**
 * The managed install a `<happierHome>/bin/<shim>` executable runs, or `null` when the path is not
 * a managed CLI shim.
 */
export function resolveManagedCliShimInstall(execPath: string): ManagedCliShimInstall | null {
  const trimmed = String(execPath ?? '').trim();
  if (!trimmed) return null;

  const binaryDir = dirname(trimmed);
  if (basename(normalizePathLike(binaryDir)).toLowerCase() !== 'bin') return null;
  const happierHomeDir = dirname(binaryDir);

  const shimName = normalizeExecutableBase(trimmed);
  const channel = shimName === DEFAULT_CLI_SHIM_NAME
    ? readDefaultManagedReleaseChannelSync({
        processEnv: { ...process.env, HAPPIER_HOME_DIR: happierHomeDir },
      })
    : CHANNEL_SHIM_NAMES.get(shimName);
  if (!isManagedCliChannel(channel)) return null;

  return {
    channel,
    installRootName: resolveCliVariant(channel).installRootName,
    happierHomeDir,
  };
}

function isManagedCliChannel(channel: string | undefined): channel is ManagedCliChannel {
  return (MANAGED_CLI_CHANNELS as readonly string[]).includes(channel ?? '');
}
