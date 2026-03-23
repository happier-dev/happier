import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readArtifactManifest, validateArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { readRuntimeManifest, readRuntimePointer, validateRuntimeManifest } from '../runtime/shared/runtime_manifest.mjs';
import { resolveStackArtifactsDir, resolveStackRuntimePaths } from '../runtime/shared/runtime_paths.mjs';

const DEFAULT_RETENTION_COUNT = 2;

function resolveKeepCount(rawValue, defaultValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(1, Math.floor(parsed));
}

function sortNewestFirst(a, b) {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : -1;
}

function normalizeReferencedSnapshotIds(manifest) {
  if (!Array.isArray(manifest?.reusedSnapshotIds)) return [];
  return [...new Set(
    manifest.reusedSnapshotIds
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )];
}

function preserveSnapshotWithReferences(snapshotId, snapshotById, keep, seen = new Set()) {
  const normalizedSnapshotId = String(snapshotId ?? '').trim();
  if (!normalizedSnapshotId || seen.has(normalizedSnapshotId)) return;
  seen.add(normalizedSnapshotId);
  keep.add(normalizedSnapshotId);
  const snapshot = snapshotById.get(normalizedSnapshotId);
  for (const referencedSnapshotId of snapshot?.referencedSnapshotIds ?? []) {
    preserveSnapshotWithReferences(referencedSnapshotId, snapshotById, keep, seen);
  }
}

async function listChildDirectories(parentDir) {
  try {
    const entries = await readdir(parentDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function resolveCreatedAtOrMtime(targetPath, rawCreatedAt) {
  const createdAt = String(rawCreatedAt ?? '').trim();
  if (createdAt) return createdAt;
  const entryStat = await stat(targetPath);
  return entryStat.mtime.toISOString();
}

export function resolveRuntimeRetentionPolicy({ env = process.env } = {}) {
  return {
    runtimeSnapshotKeepCount: resolveKeepCount(env.HAPPIER_STACK_RUNTIME_SNAPSHOT_KEEP_COUNT, DEFAULT_RETENTION_COUNT),
    artifactKeepCount: resolveKeepCount(env.HAPPIER_STACK_RUNTIME_ARTIFACT_KEEP_COUNT, DEFAULT_RETENTION_COUNT),
  };
}

export async function pruneRuntimeSnapshots({
  stackBaseDir,
  keepCount,
  preserveSnapshotIds = [],
}) {
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const snapshotIds = await listChildDirectories(runtimePaths.buildsDir);
  const keep = new Set((preserveSnapshotIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean));
  const activePointer = await readRuntimePointer({ currentPath: runtimePaths.currentPath });
  const activeSnapshotId = String(activePointer?.snapshotId ?? '').trim();
  const validSnapshots = [];
  const removedEntries = [];

  for (const snapshotId of snapshotIds) {
    const snapshotDir = join(runtimePaths.buildsDir, snapshotId);
    const manifest = await readRuntimeManifest({ manifestPath: join(snapshotDir, 'manifest.json') });
    const validation = validateRuntimeManifest(manifest);
    if (!validation.ok) {
      await rm(snapshotDir, { recursive: true, force: true });
      removedEntries.push(snapshotId);
      continue;
    }
    validSnapshots.push({
      id: snapshotId,
      dir: snapshotDir,
      createdAt: await resolveCreatedAtOrMtime(snapshotDir, manifest?.createdAt),
      referencedSnapshotIds: normalizeReferencedSnapshotIds(manifest),
    });
  }

  const snapshotById = new Map(validSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  for (const snapshotId of [...keep]) {
    preserveSnapshotWithReferences(snapshotId, snapshotById, keep);
  }
  if (activeSnapshotId) {
    preserveSnapshotWithReferences(activeSnapshotId, snapshotById, keep);
  }

  validSnapshots.sort(sortNewestFirst);
  const desiredKeepCount = Math.max(1, keepCount);
  for (const snapshot of validSnapshots) {
    if (keep.size >= desiredKeepCount) break;
    preserveSnapshotWithReferences(snapshot.id, snapshotById, keep);
  }

  for (const snapshot of validSnapshots) {
    if (keep.has(snapshot.id)) continue;
    await rm(snapshot.dir, { recursive: true, force: true });
    removedEntries.push(snapshot.id);
  }

  return {
    keptSnapshotIds: validSnapshots.filter((snapshot) => keep.has(snapshot.id)).map((snapshot) => snapshot.id),
    removedEntries,
  };
}

export async function pruneComponentArtifacts({
  stackBaseDir,
  component,
  keepCount,
}) {
  const componentDir = join(resolveStackArtifactsDir({ stackBaseDir }), String(component ?? '').trim());
  const artifactIds = await listChildDirectories(componentDir);
  const keep = new Set();
  const validArtifacts = [];
  const removedEntries = [];

  for (const artifactId of artifactIds) {
    const artifactDir = join(componentDir, artifactId);
    const manifest = await readArtifactManifest({ artifactDir });
    const validation = validateArtifactManifest(manifest);
    if (!validation.ok) {
      await rm(artifactDir, { recursive: true, force: true });
      removedEntries.push(artifactId);
      continue;
    }
    validArtifacts.push({
      id: artifactId,
      dir: artifactDir,
      createdAt: await resolveCreatedAtOrMtime(artifactDir, manifest?.createdAt),
    });
  }

  validArtifacts.sort(sortNewestFirst);
  for (const artifact of validArtifacts.slice(0, Math.max(1, keepCount))) {
    keep.add(artifact.id);
  }

  for (const artifact of validArtifacts) {
    if (keep.has(artifact.id)) continue;
    await rm(artifact.dir, { recursive: true, force: true });
    removedEntries.push(artifact.id);
  }

  return {
    keptFingerprints: validArtifacts.filter((artifact) => keep.has(artifact.id)).map((artifact) => artifact.id),
    removedEntries,
  };
}
