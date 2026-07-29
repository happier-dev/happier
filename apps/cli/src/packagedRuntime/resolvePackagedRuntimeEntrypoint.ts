import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readDefaultManagedReleaseChannelSync,
  resolveInstalledFirstPartyComponentPaths,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { projectPath, projectPathFromModuleUrl } from '@/projectPath';
import { isEmbeddedBunBundlePath } from '@/packagedRuntime/js/isEmbeddedBunBundlePath';
import {
  isRunnerSnapshotRuntimeRoot,
  resolveRunnerSnapshotBackingRuntimeRootFromPath,
  resolveRunnerSnapshotRuntimeRootFromPath,
  resolveRuntimeRootsFromLaunchedProcess,
} from '@/packagedRuntime/resolveRuntimeEntrypointArgv';

const MANAGED_CLI_SHIM_INSTALLS = new Map(
  (['stable', 'preview', 'publicdev'] as const).flatMap((channel) => {
    const variant = resolveFirstPartyComponentPublicReleaseVariant({
      componentId: 'happier-cli',
      channel,
    });
    const legacyShimAliases =
      channel === 'preview'
        ? ['happier-preview']
        : channel === 'publicdev'
          ? ['happier-dev']
          : [];
    const shimNames = [...variant.installShims, ...legacyShimAliases];
    return shimNames.map((shimName) => [
      normalizeExecutableBase(shimName),
      { channel, installRootName: variant.installRootName },
    ] as const);
  }),
);

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

function normalizeExecutableBase(pathLike: string): string {
  return basename(normalizePathLike(pathLike)).toLowerCase().replace(/\.exe$/, '');
}

function isJavaScriptRuntimeExecutable(pathLike: string): boolean {
  const base = normalizeExecutableBase(pathLike);
  return base === 'node' || base === 'bun';
}

function resolveRuntimeRootFromBinaryPath(pathLike: string): string | null {
  const normalized = normalizePathLike(pathLike);
  if (!normalized || isEmbeddedBunBundlePath(normalized) || isJavaScriptRuntimeExecutable(normalized)) {
    return null;
  }
  return dirname(normalized);
}

function resolveManagedInstalledCliProjectRootForChannel(
  channel: 'stable' | 'preview' | 'publicdev',
): string | null {
  try {
    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      channel,
    });
    // Probe — and return — the JUNCTION-FREE versioned path. On Windows the
    // `<installRoot>/current` junction is unreliable to traverse for fs APIs
    // (see `resolveJunctionFreeCurrentPath` for the kernel-level reason), so
    // checking `existsSync(paths.nodeEntrypointPath)` returns `false` even
    // when the entrypoint is present at the junction's target. That used to
    // make this resolver fall through to wrong-channel fallbacks when running
    // from a bundled JS runtime.
    if (paths.resolvedNodeEntrypointPath && existsSync(paths.resolvedNodeEntrypointPath)) {
      return paths.resolvedCurrentPath;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveRuntimeRootFromInstalledShimPath(pathLike: string): string | null {
  const normalized = normalizePathLike(pathLike);
  if (!normalized || isEmbeddedBunBundlePath(normalized) || isJavaScriptRuntimeExecutable(normalized)) {
    return null;
  }

  const shimInstall = MANAGED_CLI_SHIM_INSTALLS.get(normalizeExecutableBase(normalized));
  if (!shimInstall) {
    return null;
  }

  const binaryDir = dirname(normalized);
  if (basename(binaryDir).toLowerCase() !== 'bin') {
    return null;
  }

  return resolveManagedInstalledCliProjectRootForChannel(shimInstall.channel)
    ?? join(dirname(binaryDir), shimInstall.installRootName, 'current');
}

function resolveManagedInstalledCliProjectRoot(): string | null {
  const channels: Array<'stable' | 'preview' | 'publicdev'> = [];
  try {
    channels.push(readDefaultManagedReleaseChannelSync());
  } catch {
    // fall through to canonical channel sweep
  }
  for (const channel of ['stable', 'preview', 'publicdev'] as const) {
    if (!channels.includes(channel)) {
      channels.push(channel);
    }
  }
  for (const channel of channels) {
    const resolved = resolveManagedInstalledCliProjectRootForChannel(channel);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

export function resolvePackagedRuntimeProjectRoots(): string[] {
  const roots: string[] = [];
  const candidateRoots = [
    ...resolveRuntimeRootsFromLaunchedProcess(),
    resolveRuntimeRootFromInstalledShimPath(process.execPath),
    resolveRuntimeRootFromInstalledShimPath(process.argv[0]),
    resolveManagedInstalledCliProjectRoot(),
    resolveRuntimeRootFromBinaryPath(process.execPath),
    resolveRuntimeRootFromBinaryPath(process.argv[0]),
    (() => {
      const resolvedProjectPath = projectPath();
      return isEmbeddedBunBundlePath(resolvedProjectPath) ? null : resolvedProjectPath;
    })(),
  ];

  for (const candidate of candidateRoots) {
    if (candidate) {
      roots.push(candidate);
    }
  }
  return [...new Set(roots)];
}

export type AuthoritativePackagedRuntimeProjectRoot = Readonly<{
  root: string;
  provenance:
    | 'source-module'
    | 'source-snapshot'
    | 'packaged-module'
    | 'packaged-snapshot'
    | 'packaged-launch'
    | 'packaged-shim';
}>;

function isExplicitStackSourceRoot(
  root: string,
  processEnv: NodeJS.ProcessEnv,
): boolean {
  const configuredRoot = String(processEnv.HAPPIER_STACK_CLI_ROOT_DIR ?? '').trim();
  if (!configuredRoot) return false;
  const normalizeForEquality = (value: string): string => {
    const normalized = normalizePathLike(value).replace(/\/+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  if (normalizeForEquality(configuredRoot) !== normalizeForEquality(root)) {
    return false;
  }
  try {
    const physicalRoot = realpathSync(root);
    const physicalConfiguredRoot = realpathSync(configuredRoot);
    const sourceDir = realpathSync(join(physicalRoot, 'src'));
    const packageJsonPath = realpathSync(join(physicalRoot, 'package.json'));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
    return normalizeForEquality(physicalConfiguredRoot) === normalizeForEquality(physicalRoot)
      && normalizeForEquality(dirname(sourceDir)) === normalizeForEquality(physicalRoot)
      && statSync(sourceDir).isDirectory()
      && normalizeForEquality(dirname(packageJsonPath)) === normalizeForEquality(physicalRoot)
      && statSync(packageJsonPath).isFile()
      && packageJson.name === '@happier-dev/cli';
  } catch {
    return false;
  }
}

function resolveModuleRuntimeAuthority(
  moduleUrl: string,
  processEnv: NodeJS.ProcessEnv,
): AuthoritativePackagedRuntimeProjectRoot | null {
  try {
    const modulePath = normalizePathLike(fileURLToPath(moduleUrl));
    if (isEmbeddedBunBundlePath(modulePath)) {
      return null;
    }
    const snapshotRoot = resolveRunnerSnapshotRuntimeRootFromPath(modulePath);
    if (snapshotRoot) {
      const backingRoot = resolveRunnerSnapshotBackingRuntimeRootFromPath(snapshotRoot);
      if (!backingRoot) return null;
      return {
        root: backingRoot,
        provenance: isExplicitStackSourceRoot(backingRoot, processEnv)
          ? 'source-snapshot'
          : 'packaged-snapshot',
      };
    }

    const moduleProjectRoot = projectPathFromModuleUrl(moduleUrl);
    const normalizedModuleProjectRoot = normalizePathLike(moduleProjectRoot).replace(/\/+$/u, '');
    const moduleTree = modulePath.startsWith(`${normalizedModuleProjectRoot}/`)
      ? modulePath.slice(normalizedModuleProjectRoot.length + 1).split('/')[0]
      : null;
    if (moduleTree === 'src') {
      return { root: moduleProjectRoot, provenance: 'source-module' };
    }
    if (moduleTree === 'dist') {
      return {
        root: moduleProjectRoot,
        provenance: existsSync(join(moduleProjectRoot, 'src'))
          ? 'source-module'
          : 'packaged-module',
      };
    }
    if (moduleTree === 'package-dist') {
      return { root: moduleProjectRoot, provenance: 'packaged-module' };
    }
  } catch {
    // Runtime process evidence remains available below.
  }
  return null;
}

export function resolveAuthoritativePackagedRuntimeProjectRoot(params: Readonly<{
  moduleUrl?: string;
  argv?: readonly string[];
  currentExecPath?: string;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): AuthoritativePackagedRuntimeProjectRoot | null {
  const processEnv = params.processEnv ?? process.env;
  const moduleAuthority = resolveModuleRuntimeAuthority(params.moduleUrl ?? import.meta.url, processEnv);
  if (moduleAuthority) {
    return moduleAuthority;
  }

  const argv = params.argv ?? process.argv;
  const launchedRoot = resolveRuntimeRootsFromLaunchedProcess({
    argv,
    currentExecPath: params.currentExecPath ?? process.execPath,
  })[0];
  if (launchedRoot) {
    const backingRoot = resolveRunnerSnapshotBackingRuntimeRootFromPath(launchedRoot);
    if (backingRoot) {
      return {
        root: backingRoot,
        provenance: isExplicitStackSourceRoot(backingRoot, processEnv)
          ? 'source-snapshot'
          : 'packaged-snapshot',
      };
    }
    return { root: launchedRoot, provenance: 'packaged-launch' };
  }

  const exactShimRoot = resolveRuntimeRootFromInstalledShimPath(params.currentExecPath ?? process.execPath)
    ?? resolveRuntimeRootFromInstalledShimPath(argv[0] ?? '');
  return exactShimRoot ? { root: exactShimRoot, provenance: 'packaged-shim' } : null;
}

export function resolvePackagedRuntimeEntrypoint(
  relativePath: string,
  options: Readonly<{ packageDistOnly?: boolean }> = {},
): string {
  const normalizedRelativePath = String(relativePath ?? '').trim();
  if (!normalizedRelativePath) {
    throw new Error('relativePath is required');
  }

  const projectRoots = resolvePackagedRuntimeProjectRoots();
  let firstCandidate: string | null = null;

  for (const root of projectRoots) {
    const isSnapshotRoot = isRunnerSnapshotRuntimeRoot(root);
    if (options.packageDistOnly) {
      const candidates = isSnapshotRoot
        ? [join(root, normalizedRelativePath), join(root, 'package-dist', normalizedRelativePath)]
        : [join(root, 'package-dist', normalizedRelativePath)];
      firstCandidate ??= candidates[0] ?? null;
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
      continue;
    }
    const candidates = [
      ...(isSnapshotRoot ? [join(root, normalizedRelativePath)] : []),
      join(root, 'package-dist', normalizedRelativePath),
      join(root, 'dist', normalizedRelativePath),
    ];
    firstCandidate ??= candidates[0] ?? null;

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return firstCandidate ?? join(projectPath(), 'package-dist', normalizedRelativePath);
}
