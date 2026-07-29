import { lstat } from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import type { ManagedProviderEndpointDeclarationV1 } from '@/providers/managed/types';

import type { ManagedProviderRuntimePreparation } from './managedEndpointLaunch';

type ManagedProviderLocalServiceDeclaration =
  ManagedProviderEndpointDeclarationV1['localService'];

const SAFE_RUNTIME_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_PRIVATE_CONFIG_FLAG = /^--[a-z0-9][a-z0-9-]*$/u;

export type ResolveManagedProviderRuntimeLaunchDependencies = Readonly<{
  platform?: NodeJS.Platform;
  resolveAssetPath?: (...segments: string[]) => string;
  statFile?: (path: string) => Promise<Readonly<{
    isFile: () => boolean;
    mode: number;
  }>>;
}>;

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

function isSafePackagedRuntimeDeclaration(
  declaration: ManagedProviderLocalServiceDeclaration,
): boolean {
  const launch = declaration.launch;
  return launch.kind === 'packaged-runtime-binary'
    && launch.directorySegments.length >= 1
    && launch.directorySegments.length <= 8
    && launch.directorySegments.every((segment) => SAFE_RUNTIME_PATH_SEGMENT.test(segment))
    && SAFE_RUNTIME_PATH_SEGMENT.test(launch.executableBaseName)
    && SAFE_PRIVATE_CONFIG_FLAG.test(launch.privateConfigPathFlag);
}

function isOwnedPrivateConfigPath(input: Readonly<{
  materializedRootDir: string;
  privateConfigPath: string;
}>): boolean {
  if (
    !isAbsolute(input.materializedRootDir)
    || !isAbsolute(input.privateConfigPath)
  ) {
    return false;
  }
  const ownedRoot = resolve(input.materializedRootDir);
  const configPath = resolve(input.privateConfigPath);
  const pathWithinRoot = relative(ownedRoot, configPath);
  return pathWithinRoot.length > 0
    && pathWithinRoot !== '..'
    && !pathWithinRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathWithinRoot);
}

export async function resolveManagedProviderRuntimeLaunch(
  declaration: ManagedProviderLocalServiceDeclaration,
  preparation: Pick<
    ManagedProviderRuntimePreparation,
    'materializedRootDir' | 'privateConfigPath'
  >,
  dependencies: ResolveManagedProviderRuntimeLaunchDependencies = {},
): Promise<LocalServiceDeclarationV1 | null> {
  if (!isSafePackagedRuntimeDeclaration(declaration)) return null;
  const platform = dependencies.platform ?? process.platform;
  const executableName = packagedExecutableName(
    declaration.launch.executableBaseName,
    platform,
  );
  if (!executableName || !isOwnedPrivateConfigPath(preparation)) return null;

  const resolveAssetPath = dependencies.resolveAssetPath ?? resolveCliRuntimeAssetPath;
  const executablePath = resolveAssetPath(
    ...declaration.launch.directorySegments,
    executableName,
  );
  if (
    !isAbsolute(executablePath)
    || basename(executablePath) !== executableName
  ) {
    return null;
  }

  try {
    const file = await (dependencies.statFile ?? lstat)(executablePath);
    if (!file.isFile()) return null;
    if (platform !== 'win32' && (file.mode & 0o111) === 0) return null;
  } catch {
    return null;
  }

  return Object.freeze({
    ...declaration,
    launch: Object.freeze({
      kind: 'binary',
      executablePath,
      args: Object.freeze([
        declaration.launch.privateConfigPathFlag,
        preparation.privateConfigPath,
      ]),
    }),
  });
}
