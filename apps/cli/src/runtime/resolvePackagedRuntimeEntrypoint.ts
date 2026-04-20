import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  readDefaultManagedReleaseChannelSync,
  resolveInstalledFirstPartyComponentPaths,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { projectPath } from '@/projectPath';
import { isEmbeddedBunBundlePath } from '@/runtime/js/isEmbeddedBunBundlePath';

const MANAGED_CLI_SHIM_INSTALL_ROOTS = new Map(
  (['stable', 'preview', 'publicdev'] as const).flatMap((channel) => {
    const variant = resolveFirstPartyComponentPublicReleaseVariant({
      componentId: 'happier-cli',
      channel,
    });
    return variant.installShims.map((shimName) => [normalizeExecutableBase(shimName), variant.installRootName] as const);
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

function resolveRuntimeRootFromInstalledShimPath(pathLike: string): string | null {
  const normalized = normalizePathLike(pathLike);
  if (!normalized || isEmbeddedBunBundlePath(normalized) || isJavaScriptRuntimeExecutable(normalized)) {
    return null;
  }

  const installRootName = MANAGED_CLI_SHIM_INSTALL_ROOTS.get(normalizeExecutableBase(normalized));
  if (!installRootName) {
    return null;
  }

  const binaryDir = dirname(normalized);
  if (basename(binaryDir).toLowerCase() !== 'bin') {
    return null;
  }

  return join(dirname(binaryDir), installRootName, 'current');
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
    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      channel,
    });
    if (paths.nodeEntrypointPath && existsSync(paths.nodeEntrypointPath)) {
      return paths.currentPath;
    }
  } catch {
    return null;
  }
  return null;
}

function shouldPreferDistForRuntimeRoot(root: string): boolean {
  const normalizedRoot = normalizePathLike(root);
  const normalizedArgv1 = normalizePathLike(process.argv[1] ?? '');
  if (!normalizedRoot || !normalizedArgv1) {
    return false;
  }

  return normalizedArgv1 === `${normalizedRoot}/dist/index.mjs`
    || normalizedArgv1.startsWith(`${normalizedRoot}/dist/`);
}

export function resolvePackagedRuntimeProjectRoots(): string[] {
  const roots: string[] = [];
  const candidateRoots = [
    resolveManagedInstalledCliProjectRoot(),
    resolveRuntimeRootFromInstalledShimPath(process.execPath),
    resolveRuntimeRootFromBinaryPath(process.execPath),
    resolveRuntimeRootFromScriptPath(process.argv[1]),
    resolveRuntimeRootFromInstalledShimPath(process.argv[0]),
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

export function resolvePackagedRuntimeEntrypoint(relativePath: string): string {
  const normalizedRelativePath = String(relativePath ?? '').trim();
  if (!normalizedRelativePath) {
    throw new Error('relativePath is required');
  }

  const projectRoots = resolvePackagedRuntimeProjectRoots();

  for (const root of projectRoots) {
    const candidates = shouldPreferDistForRuntimeRoot(root)
      ? [
        join(root, 'dist', normalizedRelativePath),
        join(root, 'package-dist', normalizedRelativePath),
      ]
      : [
        join(root, 'package-dist', normalizedRelativePath),
        join(root, 'dist', normalizedRelativePath),
      ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const fallbackRoot = projectRoots[0] ?? projectPath();
  return join(
    fallbackRoot,
    shouldPreferDistForRuntimeRoot(fallbackRoot) ? 'dist' : 'package-dist',
    normalizedRelativePath,
  );
}
