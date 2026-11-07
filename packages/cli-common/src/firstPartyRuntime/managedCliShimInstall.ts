import { basename, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
import { isAbsolutePathForPathShape, normalizePathForComparison } from '../path/pathShape.js';

import { PUBLIC_RELEASE_RING_IDS, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveFirstPartyComponentPublicReleaseVariant } from './componentCatalog.js';
import { readDefaultManagedReleaseChannelSync } from './defaultReleaseChannelState.js';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY } from './installLayoutContract.js';

export type ManagedCliShimInstall = Readonly<{
  channel: PublicReleaseRingId;
  installHomeDir: string;
}>;

function resolveCliVariant(channel: PublicReleaseRingId) {
  return resolveFirstPartyComponentPublicReleaseVariant({ componentId: 'happier-cli', channel });
}

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

function normalizeExecutableBase(pathLike: string): string {
  return basename(normalizePathLike(pathLike)).toLowerCase().replace(/\.exe$/, '');
}

// The install publisher binds this shim to the home's default channel, not necessarily stable.
const DEFAULT_CLI_SHIM_NAME = normalizeExecutableBase(resolveCliVariant('stable').installShims[0] ?? 'happier');

const CHANNEL_SHIM_NAMES = new Map<string, PublicReleaseRingId>(
  PUBLIC_RELEASE_RING_IDS.flatMap((channel) => {
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

/** The managed install identified by an executable under `<installHome>/bin`. */
export function resolveManagedCliShimInstall(
  execPath: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): ManagedCliShimInstall | null {
  const normalized = normalizePathLike(execPath);
  if (!normalized) return null;

  const binaryDir = dirname(normalized);
  if (basename(binaryDir).toLowerCase() !== 'bin') return null;
  const installHomeDir = dirname(binaryDir);
  const shimName = normalizeExecutableBase(normalized);
  const channel = shimName === DEFAULT_CLI_SHIM_NAME
    ? readDefaultManagedReleaseChannelSync({
        processEnv: { ...processEnv, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: installHomeDir },
      })
    : CHANNEL_SHIM_NAMES.get(shimName);
  return channel ? { channel, installHomeDir } : null;
}

/** Match the installation a service actually launches, including managed default/channel aliases. */
export function doesCliLauncherUseInstallation(params: Readonly<{
  launcher: readonly string[];
  installationRoots: readonly string[];
}>): boolean {
  const realPath = (path: string): string | null => {
    try { return realpathSync(path); } catch { return null; }
  };
  const roots = params.installationRoots.filter(isAbsolutePathForPathShape)
    .flatMap((root) => [root, realPath(root)].filter((value): value is string => value !== null))
    .map(normalizePathForComparison);
  const matches = (path: string): boolean => {
    const normalized = normalizePathForComparison(path);
    return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  };
  return params.launcher.filter(isAbsolutePathForPathShape).some((executable) => {
    if (matches(executable)) return true;
    const resolved = realPath(executable);
    if (resolved && matches(resolved)) return true;
    const shim = resolveManagedCliShimInstall(executable);
    if (!shim) return false;
    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli', channel: shim.channel,
      processEnv: { ...process.env, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: shim.installHomeDir },
    });
    return matches(paths.binaryPath) || Boolean(paths.resolvedBinaryPath && matches(paths.resolvedBinaryPath));
  });
}
