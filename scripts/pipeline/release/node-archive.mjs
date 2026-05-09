#!/usr/bin/env node

// @ts-check

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as tar from 'tar';

function parseArgs(argv) {
  const kv = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      kv.set(arg, next);
      i += 1;
      continue;
    }
    kv.set(arg, '');
  }
  return kv;
}

function normalizeArchiveEntryPath(pathLike) {
  return String(pathLike ?? '').replaceAll('\\', '/');
}

function shouldExcludeArchiveEntry(pathLike) {
  const normalized = normalizeArchiveEntryPath(pathLike);
  if (!normalized) return false;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.startsWith('._'))) {
    return true;
  }
  if (normalized.includes('/node_modules/@prisma/client/node_modules')) {
    return true;
  }
  return false;
}

async function main() {
  const kv = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(String(kv.get('--source-path') ?? '').trim());
  const sourceName = String(kv.get('--source-name') ?? '').trim();
  const artifactPath = resolve(String(kv.get('--artifact-path') ?? '').trim());

  if (!sourcePath || !sourceName || !artifactPath) {
    throw new Error('[release] node archive helper requires --source-path, --source-name, and --artifact-path');
  }

  await mkdir(dirname(artifactPath), { recursive: true });
  await tar.c(
    {
      cwd: sourcePath,
      file: artifactPath,
      gzip: { level: 6 },
      portable: true,
      mtime: new Date(0),
      filter: (entryPath) => !shouldExcludeArchiveEntry(entryPath),
    },
    [sourceName],
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
