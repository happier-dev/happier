import { basename, dirname } from 'node:path';

import { isEmbeddedBunBundlePath } from '@/packagedRuntime/js/isEmbeddedBunBundlePath';

const RUNTIME_ENTRYPOINT_ARGV_SCAN_LIMIT = 3;

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

export function resolveRuntimeRootFromEntrypointPath(pathLike: string | null | undefined): string | null {
  const normalized = normalizePathLike(String(pathLike ?? ''));
  if (!normalized || isEmbeddedBunBundlePath(normalized)) {
    return null;
  }
  if (basename(normalized).toLowerCase() !== 'index.mjs') {
    return null;
  }

  const runnerSnapshotRoot = resolveRunnerSnapshotRuntimeRootFromPath(normalized);
  if (runnerSnapshotRoot) {
    return runnerSnapshotRoot;
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

export function resolveRunnerSnapshotRuntimeRootFromPath(pathLike: string | null | undefined): string | null {
  const normalized = normalizePathLike(String(pathLike ?? '')).replace(/\/+$/, '');
  if (!normalized || isEmbeddedBunBundlePath(normalized)) {
    return null;
  }
  for (const snapshotMarker of ['/.runner-snapshots/', '/dist/.runner-snapshots/']) {
    const snapshotIndex = normalized.lastIndexOf(snapshotMarker);
    if (snapshotIndex < 0) continue;
    const afterMarker = normalized.slice(snapshotIndex + snapshotMarker.length);
    const snapshotName = afterMarker.split('/')[0]?.trim();
    if (!snapshotName) continue;
    return normalized.slice(0, snapshotIndex + snapshotMarker.length + snapshotName.length);
  }
  return null;
}

export function isRunnerSnapshotRuntimeRoot(pathLike: string | null | undefined): boolean {
  const normalized = normalizePathLike(String(pathLike ?? '')).replace(/\/+$/, '');
  return resolveRunnerSnapshotRuntimeRootFromPath(normalized) === normalized;
}

export function resolveLaunchedRuntimeEntrypointsFromArgv(
  argv: readonly string[] = process.argv,
): string[] {
  const entrypoints: string[] = [];
  const seen = new Set<string>();
  for (const arg of argv.slice(1, RUNTIME_ENTRYPOINT_ARGV_SCAN_LIMIT)) {
    const entrypoint = String(arg ?? '').trim();
    if (!entrypoint || seen.has(entrypoint)) {
      continue;
    }
    if (!resolveRuntimeRootFromEntrypointPath(entrypoint)) {
      continue;
    }
    entrypoints.push(entrypoint);
    seen.add(entrypoint);
  }
  return entrypoints;
}

export function resolveRuntimeRootsFromLaunchedArgv(
  argv: readonly string[] = process.argv,
): string[] {
  const roots: string[] = [];
  for (const entrypoint of resolveLaunchedRuntimeEntrypointsFromArgv(argv)) {
    const root = resolveRuntimeRootFromEntrypointPath(entrypoint);
    if (root) {
      roots.push(root);
    }
  }
  return [...new Set(roots)];
}

export function resolveRuntimeRootFromPackagedBinaryPath(pathLike: string | null | undefined): string | null {
  const normalized = normalizePathLike(String(pathLike ?? ''));
  if (!normalized || isEmbeddedBunBundlePath(normalized)) {
    return null;
  }
  const fileName = basename(normalized).toLowerCase();
  if (!['happier', 'happier.exe', 'happier-dev', 'happier-dev.exe'].includes(fileName)) {
    return null;
  }
  return dirname(normalized);
}

export function resolveRuntimeRootsFromLaunchedProcess(params?: Readonly<{
  argv?: readonly string[] | null;
  currentExecPath?: string | null;
}>): string[] {
  const argv = params?.argv ?? process.argv;
  const roots = [
    ...resolveRuntimeRootsFromLaunchedArgv(argv),
    resolveRuntimeRootFromPackagedBinaryPath(params?.currentExecPath ?? process.execPath),
    resolveRuntimeRootFromPackagedBinaryPath(argv[0]),
  ].filter((root): root is string => Boolean(root));
  return [...new Set(roots)];
}
