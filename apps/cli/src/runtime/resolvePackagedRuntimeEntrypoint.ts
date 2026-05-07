import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  readDefaultManagedReleaseChannelSync,
  resolveInstalledFirstPartyComponentPaths,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { projectPath } from '@/projectPath';
import { isEmbeddedBunBundlePath } from '@/runtime/js/isEmbeddedBunBundlePath';

const MANAGED_CLI_SHIM_INSTALLS = new Map(
  (['stable', 'preview', 'publicdev'] as const).flatMap((channel) => {
    const variant = resolveFirstPartyComponentPublicReleaseVariant({
      componentId: 'happier-cli',
      channel,
    });
    return variant.installShims.map((shimName) => [
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

function resolveRuntimeRootFromScriptPath(pathLike: string): string | null {
  const normalized = normalizePathLike(pathLike);
  if (!normalized || isEmbeddedBunBundlePath(normalized)) {
    return null;
  }
  if (basename(normalized).toLowerCase() !== 'index.mjs') {
    return null;
  }

  const packageDistMarker = `${String.raw`/`}package-dist${String.raw`/`}`;
  const distMarker = `${String.raw`/`}dist${String.raw`/`}`;
  const packageDistIndex = normalized.indexOf(packageDistMarker);
  if (packageDistIndex >= 0) {
    return normalized.slice(0, packageDistIndex);
  }
  const distIndex = normalized.indexOf(distMarker);
  if (distIndex >= 0) {
    return normalized.slice(0, distIndex);
  }
  return null;
}

function resolveManagedInstalledCliProjectRoot(): string | null {
  try {
    const channel = readDefaultManagedReleaseChannelSync();
    return resolveManagedInstalledCliProjectRootForChannel(channel);
  } catch {
    return null;
  }
}

export function resolvePackagedRuntimeProjectRoots(): string[] {
  const roots: string[] = [];
  const candidateRoots = [
    resolveRuntimeRootFromInstalledShimPath(process.execPath),
    resolveRuntimeRootFromInstalledShimPath(process.argv[0]),
    resolveManagedInstalledCliProjectRoot(),
    resolveRuntimeRootFromBinaryPath(process.execPath),
    resolveRuntimeRootFromScriptPath(process.argv[1]),
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

export function resolvePackagedRuntimeEntrypoint(
  relativePath: string,
  options: Readonly<{ packageDistOnly?: boolean }> = {},
): string {
  const normalizedRelativePath = String(relativePath ?? '').trim();
  if (!normalizedRelativePath) {
    throw new Error('relativePath is required');
  }

  const projectRoots = resolvePackagedRuntimeProjectRoots();

  for (const root of projectRoots) {
    if (options.packageDistOnly) {
      const candidate = join(root, 'package-dist', normalizedRelativePath);
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    const candidates = [
      join(root, 'package-dist', normalizedRelativePath),
      join(root, 'dist', normalizedRelativePath),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return join(projectRoots[0] ?? projectPath(), 'package-dist', normalizedRelativePath);
}
