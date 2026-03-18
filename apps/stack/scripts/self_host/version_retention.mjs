import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

function resolveVersionedBinaryPrefix(binaryName) {
  return `${binaryName}-`;
}

function resolveVersionedBinaryName(binaryName, version) {
  return `${resolveVersionedBinaryPrefix(binaryName)}${version}`;
}

export async function listVersionedBinaryEntries({
  versionsDir,
  binaryName,
}) {
  const prefix = resolveVersionedBinaryPrefix(binaryName);
  const dirEntries = await readdir(versionsDir, { withFileTypes: true });
  const versionEntries = [];

  for (const dirEntry of dirEntries) {
    if (!dirEntry.isFile()) continue;
    if (!dirEntry.name.startsWith(prefix)) continue;
    const path = join(versionsDir, dirEntry.name);
    const info = await stat(path);
    versionEntries.push({
      name: dirEntry.name,
      path,
      mtimeMs: info.mtimeMs,
    });
  }

  versionEntries.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  return versionEntries;
}

export async function pruneVersionedBinaries({
  versionsDir,
  binaryName,
  keepCount = 1,
  protectedVersions = [],
}) {
  const entries = await listVersionedBinaryEntries({ versionsDir, binaryName });
  const retainedNames = new Set(
    entries.slice(0, Math.max(0, keepCount)).map((entry) => entry.name),
  );

  for (const version of protectedVersions) {
    retainedNames.add(resolveVersionedBinaryName(binaryName, version));
  }

  const retained = [];
  const removed = [];
  for (const entry of entries) {
    if (retainedNames.has(entry.name)) {
      retained.push(entry);
      continue;
    }
    await rm(entry.path, { force: true });
    removed.push(entry);
  }

  return {
    retained,
    removed,
  };
}
