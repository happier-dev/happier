#!/usr/bin/env node

// @ts-check

import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import * as tar from 'tar';

import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

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

export async function extractNodeArchive({ archivePath, extractDir }) {
  const resolvedArchivePath = resolve(archivePath);
  await extractArchivePayloadToDirectory({
    archivePath: resolvedArchivePath,
    archiveName: basename(resolvedArchivePath),
    extractDir: resolve(extractDir),
  });
}

export async function createNodeArchive({ sourcePath, sourceName, artifactPath }) {
  const resolvedSourcePath = resolve(sourcePath);
  const resolvedArtifactPath = resolve(artifactPath);
  await mkdir(dirname(resolvedArtifactPath), { recursive: true });
  await tar.c(
    {
      cwd: resolvedSourcePath,
      file: resolvedArtifactPath,
      gzip: { level: 6 },
      portable: true,
      mtime: new Date(0),
      filter: (entryPath) => !shouldExcludeArchiveEntry(entryPath),
    },
    [sourceName],
  );
}

export async function main(argv = process.argv.slice(2)) {
  const kv = parseArgs(argv);
  const extractArchivePathInput = String(kv.get('--extract-archive-path') ?? '').trim();
  const extractDirInput = String(kv.get('--extract-dir') ?? '').trim();
  if (extractArchivePathInput || extractDirInput) {
    if (!extractArchivePathInput || !extractDirInput) {
      throw new Error(
        '[release] node archive extraction requires --extract-archive-path and --extract-dir',
      );
    }
    await extractNodeArchive({
      archivePath: extractArchivePathInput,
      extractDir: extractDirInput,
    });
    return;
  }

  const sourcePathInput = String(kv.get('--source-path') ?? '').trim();
  const sourceName = String(kv.get('--source-name') ?? '').trim();
  const artifactPathInput = String(kv.get('--artifact-path') ?? '').trim();

  if (!sourcePathInput || !sourceName || !artifactPathInput) {
    throw new Error('[release] node archive helper requires --source-path, --source-name, and --artifact-path');
  }

  await createNodeArchive({
    sourcePath: sourcePathInput,
    sourceName,
    artifactPath: artifactPathInput,
  });
}

const isEntrypoint = (() => {
  const entry = String(process.argv[1] ?? '');
  return entry.endsWith('/scripts/pipeline/release/node-archive.mjs')
    || entry.endsWith('\\scripts\\pipeline\\release\\node-archive.mjs');
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
