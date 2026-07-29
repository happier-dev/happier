import { lstat, realpath } from 'node:fs/promises';
import {
  basename,
  posix as posixPath,
  win32 as win32Path,
} from 'node:path';

import {
  readInstalledVersionMarkers,
  resolveFirstPartyInstallLayout,
  resolveFirstPartyVersionInstallPath,
  resolveManagedCliReleaseChannel,
  type FirstPartyInstallLayout,
} from '@happier-dev/cli-common/firstPartyRuntime';

import type {
  ManagedProviderEndpointDeclarationV1,
} from '@/providers/managed/types';

const SAFE_VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

type RetainedArtifactDependencies = Readonly<{
  platform?: NodeJS.Platform;
  resolveReleaseChannel?: (input: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
  }>) => Promise<Readonly<{ ringId: 'stable' | 'preview' | 'publicdev' }>>;
  resolveInstallLayout?: (input: Readonly<{
    componentId: 'happier-cli';
    channel: 'stable' | 'preview' | 'publicdev';
    processEnv?: NodeJS.ProcessEnv;
  }>) => FirstPartyInstallLayout;
  readVersionMarkers?: typeof readInstalledVersionMarkers;
  resolveVersionInstallPath?: typeof resolveFirstPartyVersionInstallPath;
  statFile?: (path: string) => Promise<Readonly<{
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
    mode: number;
  }>>;
  resolveRealPath?: (path: string) => Promise<string>;
}>;

function executableName(
  baseName: string,
  platform: NodeJS.Platform,
): string | null {
  if (!['darwin', 'linux', 'win32'].includes(platform)) return null;
  if (!SAFE_PATH_SEGMENT.test(baseName) || basename(baseName) !== baseName) {
    return null;
  }
  if (platform === 'win32') {
    return baseName.toLowerCase().endsWith('.exe')
      ? baseName
      : `${baseName}.exe`;
  }
  return baseName.toLowerCase().endsWith('.exe') ? null : baseName;
}

function canonicalPath(path: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? win32Path : posixPath;
  const canonical = pathApi.resolve(path);
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Proves that an observed surviving wrapper is the exact packaged artifact
 * from the launch-recorded A version, and that A is still retained as either
 * the current or previous installed CLI payload. This intentionally does not
 * follow the replacement daemon's `current` pointer, which may now identify B.
 */
export async function verifyRetainedManagedProviderRuntimeArtifact(input: Readonly<{
  wrapperBuildVersion: string;
  observedExecutablePath: string;
  declaration: ManagedProviderEndpointDeclarationV1['localService'];
  processEnv?: NodeJS.ProcessEnv;
}>, dependencies: RetainedArtifactDependencies = {}): Promise<boolean> {
  const versionId = input.wrapperBuildVersion.trim();
  const launch = input.declaration.launch;
  const platform = dependencies.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32Path : posixPath;
  const name = executableName(launch.executableBaseName, platform);
  if (
    versionId !== input.wrapperBuildVersion
    || !SAFE_VERSION_ID.test(versionId)
    || launch.kind !== 'packaged-runtime-binary'
    || !name
    || launch.directorySegments.length < 1
    || launch.directorySegments.length > 8
    || !launch.directorySegments.every((segment) => SAFE_PATH_SEGMENT.test(segment))
    || !pathApi.isAbsolute(input.observedExecutablePath)
  ) {
    return false;
  }

  try {
    const releaseChannel = await (
      dependencies.resolveReleaseChannel ?? resolveManagedCliReleaseChannel
    )({ processEnv: input.processEnv });
    const layout = (
      dependencies.resolveInstallLayout ?? resolveFirstPartyInstallLayout
    )({
      componentId: 'happier-cli',
      channel: releaseChannel.ringId,
      processEnv: input.processEnv,
    });
    const markers = await (
      dependencies.readVersionMarkers ?? readInstalledVersionMarkers
    )(layout);
    if (
      markers.currentVersionId !== versionId
      && markers.previousVersionId !== versionId
    ) {
      return false;
    }
    const versionRoot = (
      dependencies.resolveVersionInstallPath ?? resolveFirstPartyVersionInstallPath
    )({
      componentId: 'happier-cli',
      versionId,
      channel: releaseChannel.ringId,
      processEnv: input.processEnv,
    });
    const expectedPath = pathApi.join(
      versionRoot,
      ...launch.directorySegments,
      name,
    );
    const withinVersion = pathApi.relative(
      pathApi.resolve(versionRoot),
      pathApi.resolve(expectedPath),
    );
    if (
      !withinVersion
      || withinVersion === '..'
      || withinVersion.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(withinVersion)
    ) {
      return false;
    }
    const file = await (dependencies.statFile ?? lstat)(expectedPath);
    if (
      file.isSymbolicLink()
      || !file.isFile()
      || (platform !== 'win32' && (file.mode & 0o111) === 0)
    ) {
      return false;
    }
    const resolveRealPath = dependencies.resolveRealPath ?? realpath;
    const [expectedRealPath, observedRealPath] = await Promise.all([
      resolveRealPath(expectedPath),
      resolveRealPath(input.observedExecutablePath),
    ]);
    return canonicalPath(expectedRealPath, platform)
      === canonicalPath(observedRealPath, platform);
  } catch {
    return false;
  }
}
