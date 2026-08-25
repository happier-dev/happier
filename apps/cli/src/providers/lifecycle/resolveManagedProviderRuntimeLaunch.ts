import { lstat, realpath } from 'node:fs/promises';
import {
  basename,
  posix as posixPath,
  win32 as win32Path,
} from 'node:path';
import type { ManagedExecutableRef } from '@happier-dev/protocol';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

import {
  resolveInstalledFirstPartyComponentPaths,
  resolveFirstPartyVersionInstallPath,
  resolveManagedCliReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { projectPathFromModuleUrl } from '@/projectPath';
import {
  resolveCliRuntimeAssetPath,
} from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
export type PackagedRuntimeBinaryExecutableRef = Extract<
  ManagedExecutableRef,
  Readonly<{ kind: 'packaged-runtime-binary' }>
>;

const SAFE_RUNTIME_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export type ResolveManagedProviderRuntimeLaunchDependencies = Readonly<{
  platform?: NodeJS.Platform;
  /**
   * A materialized immutable plugin-generation root selected and integrity-fenced
   * by the executable plugin runtime registry.
   */
  installedPluginGenerationRuntimeRoot?: string;
  retainedRunnerRuntimeIdentity?: string;
  runtimeModuleUrl?: string;
  processEnv?: NodeJS.ProcessEnv;
  resolveAssetPath?: (...segments: string[]) => string;
  resolveReleaseChannel?: (input: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
  }>) => Promise<Readonly<{
    ringId: 'stable' | 'preview' | 'publicdev';
  }>>;
  resolveVersionInstallPath?: typeof resolveFirstPartyVersionInstallPath;
  resolveInstalledComponentPaths?: typeof resolveInstalledFirstPartyComponentPaths;
  resolveRuntimeRootFromModuleUrl?: (moduleUrl: string) => string;
  statFile?: (path: string) => Promise<Readonly<{
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
    mode: number;
  }>>;
  resolveRealPath?: (path: string) => Promise<string>;
}>;

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32Path : posixPath;
}

function canonicalPath(path: string, platform: NodeJS.Platform): string {
  const canonical = pathApiForPlatform(platform).resolve(path);
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function canonicalPathSegment(segment: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? segment.toLowerCase() : segment;
}

function isRealPathInsideRoot(input: Readonly<{
  root: string;
  path: string;
  platform: NodeJS.Platform;
}>): boolean {
  const pathApi = pathApiForPlatform(input.platform);
  const relativePath = pathApi.relative(
    canonicalPath(input.root, input.platform),
    canonicalPath(input.path, input.platform),
  );
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativePath);
}

async function resolveRetainedRunnerRuntimeRoot(
  dependencies: ResolveManagedProviderRuntimeLaunchDependencies,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const identity = dependencies.retainedRunnerRuntimeIdentity;
  if (!identity || identity !== identity.trim()) return null;

  if (identity.startsWith('version:')) {
    const versionId = identity.slice('version:'.length);
    if (!versionId) return null;
    const releaseChannel = await (
      dependencies.resolveReleaseChannel
      ?? resolveManagedCliReleaseChannel
    )({ processEnv: dependencies.processEnv });
    return (
      dependencies.resolveVersionInstallPath
      ?? resolveFirstPartyVersionInstallPath
    )({
      componentId: 'happier-cli',
      channel: releaseChannel.ringId,
      versionId,
      processEnv: dependencies.processEnv,
    });
  }

  if (identity.startsWith('snapshot:')) {
    const snapshotIdentity = identity.slice('snapshot:'.length);
    if (!SAFE_RUNTIME_PATH_SEGMENT.test(snapshotIdentity)) return null;
    const pathApi = pathApiForPlatform(platform);
    const runtimeRoot = (
      dependencies.resolveRuntimeRootFromModuleUrl
      ?? projectPathFromModuleUrl
    )(dependencies.runtimeModuleUrl ?? import.meta.url);
    if (!pathApi.isAbsolute(runtimeRoot)) return null;
    const resolvedRoot = pathApi.resolve(runtimeRoot);
    if (
      canonicalPathSegment(pathApi.basename(resolvedRoot), platform)
        !== canonicalPathSegment(snapshotIdentity, platform)
      || canonicalPathSegment(
        pathApi.basename(pathApi.dirname(resolvedRoot)),
        platform,
      ) !== canonicalPathSegment('.runner-snapshots', platform)
    ) {
      return null;
    }
    return resolvedRoot;
  }

  return null;
}

function packagedExecutableName(
  executableBaseName: string,
  platform: NodeJS.Platform,
): string | null {
  if (!['darwin', 'linux', 'win32'].includes(platform)) return null;
  if (
    basename(executableBaseName) !== executableBaseName
    || executableBaseName.includes('\\')
  ) {
    return null;
  }
  if (platform === 'win32') {
    return executableBaseName.toLowerCase().endsWith('.exe')
      ? executableBaseName
      : `${executableBaseName}.exe`;
  }
  return executableBaseName.toLowerCase().endsWith('.exe')
    ? null
    : executableBaseName;
}

function isSafePackagedRuntimeBinaryRef(
  executable: PackagedRuntimeBinaryExecutableRef,
): boolean {
  return executable.directorySegments.length >= 1
    && executable.directorySegments.length <= 8
    && executable.directorySegments.every((segment) => SAFE_RUNTIME_PATH_SEGMENT.test(segment))
    && SAFE_RUNTIME_PATH_SEGMENT.test(executable.executableBaseName);
}

/**
 * Produces the portable inventory path for a declared managed-runtime binary.
 * The executable plugin registry uses this before handing an installed
 * generation root to the managed-runtime lifecycle.
 */
export function resolvePackagedRuntimeBinaryRelativePath(
  executable: PackagedRuntimeBinaryExecutableRef,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!isSafePackagedRuntimeBinaryRef(executable)) return null;
  const executableName = packagedExecutableName(
    executable.executableBaseName,
    platform,
  );
  if (!executableName) return null;
  return [...executable.directorySegments, executableName].join('/');
}

function runtimeRootFromPackagedExecutablePath(
  executablePath: string,
  directorySegmentCount: number,
  platform: NodeJS.Platform,
): string {
  const pathApi = pathApiForPlatform(platform);
  let runtimeRoot = executablePath;
  for (let index = 0; index <= directorySegmentCount; index += 1) {
    runtimeRoot = pathApi.dirname(runtimeRoot);
  }
  return runtimeRoot;
}

function resolveImmutableInstalledCurrentRoot(input: Readonly<{
  runtimeRoot: string;
  platform: NodeJS.Platform;
  dependencies: ResolveManagedProviderRuntimeLaunchDependencies;
}>): string {
  const resolveInstalledComponentPaths = input.dependencies
    .resolveInstalledComponentPaths
    ?? resolveInstalledFirstPartyComponentPaths;
  for (const channel of ['stable', 'preview', 'publicdev'] as const) {
    let installedPaths;
    try {
      installedPaths = resolveInstalledComponentPaths({
        componentId: 'happier-cli',
        channel,
        processEnv: input.dependencies.processEnv,
      });
    } catch {
      continue;
    }
    if (
      canonicalPath(installedPaths.currentPath, input.platform)
      !== canonicalPath(input.runtimeRoot, input.platform)
    ) {
      continue;
    }
    const immutableRoot = installedPaths.resolvedCurrentPath;
    if (!immutableRoot || !pathApiForPlatform(input.platform).isAbsolute(immutableRoot)) {
      throw new Error('Installed CLI current root has no resolvable version path');
    }
    return immutableRoot;
  }
  return input.runtimeRoot;
}

export async function resolveManagedProviderRuntimeExecutable(
  executable: PackagedRuntimeBinaryExecutableRef,
  dependencies: ResolveManagedProviderRuntimeLaunchDependencies = {},
): Promise<string | null> {
  const platform = dependencies.platform ?? process.platform;
  const relativePath = resolvePackagedRuntimeBinaryRelativePath(
    executable,
    platform,
  );
  if (!relativePath) return null;
  const executableName = relativePath.split('/').at(-1)!;

  const pathApi = pathApiForPlatform(platform);
  let retainedRuntimeRoot: string | null = null;
  let executablePath: string;
  try {
    if (dependencies.installedPluginGenerationRuntimeRoot !== undefined) {
      retainedRuntimeRoot = dependencies.installedPluginGenerationRuntimeRoot;
      if (!pathApi.isAbsolute(retainedRuntimeRoot)) return null;
      const root = await (dependencies.statFile ?? lstat)(retainedRuntimeRoot);
      if (root.isSymbolicLink() || !root.isDirectory()) return null;
      executablePath = pathApi.join(
        retainedRuntimeRoot,
        ...executable.directorySegments,
        executableName,
      );
    } else if (dependencies.retainedRunnerRuntimeIdentity) {
      retainedRuntimeRoot = await resolveRetainedRunnerRuntimeRoot(
        dependencies,
        platform,
      );
      if (!retainedRuntimeRoot) return null;
      const root = await (dependencies.statFile ?? lstat)(
        retainedRuntimeRoot,
      );
      if (root.isSymbolicLink() || !root.isDirectory()) return null;
      executablePath = pathApi.join(
        retainedRuntimeRoot,
        ...executable.directorySegments,
        executableName,
      );
    } else {
      const resolveAssetPath = dependencies.resolveAssetPath
        ?? resolveCliRuntimeAssetPath;
      executablePath = resolveAssetPath(
        ...executable.directorySegments,
        executableName,
      );
      const runtimeRoot = runtimeRootFromPackagedExecutablePath(
        executablePath,
        executable.directorySegments.length,
        platform,
      );
      const immutableRuntimeRoot = resolveImmutableInstalledCurrentRoot({
        runtimeRoot,
        platform,
        dependencies,
      });
      if (
        canonicalPath(immutableRuntimeRoot, platform)
        !== canonicalPath(runtimeRoot, platform)
      ) {
        executablePath = pathApi.join(
          immutableRuntimeRoot,
          ...executable.directorySegments,
          executableName,
        );
      }
    }
  } catch {
    return null;
  }
  if (
    !pathApi.isAbsolute(executablePath)
    || pathApi.basename(executablePath) !== executableName
  ) {
    return null;
  }

  try {
    const file = await (dependencies.statFile ?? lstat)(executablePath);
    if (file.isSymbolicLink() || !file.isFile()) return null;
    if (platform !== 'win32' && (file.mode & 0o111) === 0) return null;
    const runtimeRoot = runtimeRootFromPackagedExecutablePath(
      executablePath,
      executable.directorySegments.length,
      platform,
    );
    const resolveRealPath = dependencies.resolveRealPath ?? realpath;
    const [verifiedRuntimeRoot, verifiedExecutablePath] = await Promise.all([
      resolveRealPath(retainedRuntimeRoot ?? runtimeRoot),
      resolveRealPath(executablePath),
    ]);
    if (!isRealPathInsideRoot({
      root: verifiedRuntimeRoot,
      path: verifiedExecutablePath,
      platform,
    })) {
      return null;
    }
    if (dependencies.installedPluginGenerationRuntimeRoot === undefined) {
      const integrity = cliDistBuildManifest.readCliRuntimeAssetIntegrity({
        runtimeRoot: verifiedRuntimeRoot,
        relativePath,
      });
      if (
        !integrity.ok
        || !integrity.assetPath
        || canonicalPath(integrity.assetPath, platform)
          !== canonicalPath(verifiedExecutablePath, platform)
      ) {
        return null;
      }
    }
    return verifiedExecutablePath;
  } catch {
    return null;
  }
}
