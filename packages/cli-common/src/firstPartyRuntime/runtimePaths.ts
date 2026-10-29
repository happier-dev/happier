import { basename } from 'node:path';

function decodePathLike(pathLike: string): string {
  try {
    return decodeURI(pathLike);
  } catch {
    return pathLike;
  }
}

export function isEmbeddedBunBundlePath(pathLike: string | null | undefined): boolean {
  const normalized = decodePathLike(String(pathLike ?? '').trim()).replaceAll('\\', '/');
  const normalizedWindowsUrlPath = normalized.replace(/^\/([a-z]:\/)/i, '$1');
  for (const candidate of [normalized, normalizedWindowsUrlPath]) {
    const lowered = candidate.toLowerCase();
    if (lowered === '/$bunfs' || lowered.startsWith('/$bunfs/')) {
      return true;
    }
    if (/^(?:[a-z]:)?\/~bun(?:\/|$)/i.test(candidate)) {
      return true;
    }
  }
  return false;
}

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
  const distBackupMarker = `${String.raw`/`}.dist.hstack-backup${String.raw`/`}`;
  const packageDistIndex = normalized.indexOf(packageDistMarker);
  if (packageDistIndex >= 0) {
    return normalized.slice(0, packageDistIndex);
  }
  const distIndex = normalized.indexOf(distMarker);
  if (distIndex >= 0) {
    return normalized.slice(0, distIndex);
  }
  // The stack PM's rename-aside rebuild layout boots as a supported runtime
  // tree, so a launched `index.mjs` inside it still names its runtime root.
  const distBackupIndex = normalized.indexOf(distBackupMarker);
  if (distBackupIndex >= 0) {
    return normalized.slice(0, distBackupIndex);
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

