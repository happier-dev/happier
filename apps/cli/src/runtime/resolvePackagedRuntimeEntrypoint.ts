import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { projectPath } from '@/projectPath';
import { isEmbeddedBunBundlePath } from '@/runtime/js/isEmbeddedBunBundlePath';

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

function isJavaScriptRuntimeExecutable(pathLike: string): boolean {
  const base = basename(normalizePathLike(pathLike)).toLowerCase();
  return base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
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

  const executableBase = basename(normalized).toLowerCase();
  if (executableBase !== 'happier' && executableBase !== 'happier.exe') {
    return null;
  }

  const binaryDir = dirname(normalized);
  if (basename(binaryDir).toLowerCase() !== 'bin') {
    return null;
  }

  return join(dirname(binaryDir), 'cli', 'current');
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

function resolvePackagedRuntimeProjectRoots(): string[] {
  const roots: string[] = [];
  const candidateRoots = [
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
