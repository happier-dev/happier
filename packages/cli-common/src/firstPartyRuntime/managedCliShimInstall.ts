import { basename, dirname } from 'node:path';
import { realpathSync } from 'node:fs';

import { PUBLIC_RELEASE_RING_IDS, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveFirstPartyComponentPublicReleaseVariant } from './componentCatalog.js';
import { readDefaultManagedReleaseChannelSync } from './defaultReleaseChannelState.js';
import { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
import { isAbsolutePathForPathShape, normalizePathForComparison } from '../path/pathShape.js';

export type ManagedCliShimInstall = Readonly<{
  channel: PublicReleaseRingId;
  happierHomeDir: string;
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

// The stable `happier` shim is the default shim: installs link it to the default release channel's
// binary (see `resolveDesiredShimTargets`), so its channel is that home's default, not stable.
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

/**
 * The managed install a `<happierHome>/bin/<shim>` executable runs, or `null` when the path is not
 * a managed CLI shim.
 */
export function resolveManagedCliShimInstall(execPath: string): ManagedCliShimInstall | null {
  const trimmed = normalizePathLike(execPath);
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
  if (!channel) return null;

  return {
    channel,
    happierHomeDir,
  };
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
      processEnv: { ...process.env, HAPPIER_HOME_DIR: shim.happierHomeDir },
    });
    return matches(paths.binaryPath) || Boolean(paths.resolvedBinaryPath && matches(paths.resolvedBinaryPath));
  });
}
