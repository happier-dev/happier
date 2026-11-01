import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  readDefaultManagedReleaseChannelSync,
  resolveInstalledFirstPartyComponentPaths,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { projectPath } from '@/projectPath';
import { isEmbeddedBunBundlePath } from '@/runtime/js/isEmbeddedBunBundlePath';
import { resolveManagedCliShimInstall } from '@/runtime/managedCliShimInstall';
import {
  isRunnerSnapshotRuntimeRoot,
  resolveRuntimeRootsFromLaunchedProcess,
} from '@/runtime/resolveRuntimeEntrypointArgv';

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

  const shimInstall = resolveManagedCliShimInstall(normalized);
  if (!shimInstall) {
    return null;
  }

  return resolveManagedInstalledCliProjectRootForChannel(shimInstall.channel)
    ?? join(shimInstall.happierHomeDir, shimInstall.installRootName, 'current');
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
  const moduleProjectPath = projectPath();
  const moduleRoot = isEmbeddedBunBundlePath(moduleProjectPath) ? null : moduleProjectPath;
  const candidateRoots = [
    ...resolveRuntimeRootsFromLaunchedProcess(),
    // The bin wrapper imports its runtime without changing argv. Under Node/Bun the
    // loaded module therefore identifies this checkout/npm install (or runner snapshot).
    isJavaScriptRuntimeExecutable(process.execPath) ? moduleRoot : null,
    resolveRuntimeRootFromInstalledShimPath(process.execPath),
    resolveRuntimeRootFromInstalledShimPath(process.argv[0]),
    resolveManagedInstalledCliProjectRoot(),
    resolveRuntimeRootFromBinaryPath(process.execPath),
    resolveRuntimeRootFromBinaryPath(process.argv[0]),
    moduleRoot,
  ];

  for (const candidate of candidateRoots) {
    if (candidate) {
      roots.push(candidate);
    }
  }
  return [...new Set(roots)];
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
        if (existsSync(candidate)) {
          return candidate;
        }
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
