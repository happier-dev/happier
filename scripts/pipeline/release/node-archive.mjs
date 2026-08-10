#!/usr/bin/env node

// @ts-check

import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import * as tar from 'tar';

import { extractFirstPartyReleaseArchiveToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

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

function requireValue(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`[release] ${label} is required`);
  return normalized;
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

export async function extractNodeArchive({ archivePath, extractDir, limits }) {
  const resolvedArchivePath = resolve(requireValue(archivePath, 'archive path'));
  const resolvedExtractDir = resolve(requireValue(extractDir, 'archive extraction directory'));
  await extractFirstPartyReleaseArchiveToDirectory({
    archivePath: resolvedArchivePath,
    archiveName: basename(resolvedArchivePath),
    extractDir: resolvedExtractDir,
    limits,
  });
}

export async function createNodeArchive({ sourcePath, sourceName, artifactPath }) {
  const resolvedSourcePath = resolve(requireValue(sourcePath, 'archive source path'));
  const normalizedSourceName = requireValue(sourceName, 'archive source name');
  const resolvedArtifactPath = resolve(requireValue(artifactPath, 'archive artifact path'));
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
    [normalizedSourceName],
  );
}

export async function main(argv = process.argv.slice(2)) {
  const kv = parseArgs(argv);
  const extractArchivePath = String(kv.get('--extract-archive-path') ?? '').trim();
  const extractDir = String(kv.get('--extract-dir') ?? '').trim();
  if (extractArchivePath || extractDir) {
    if (!extractArchivePath || !extractDir) {
      throw new Error('[release] node archive extraction requires --extract-archive-path and --extract-dir');
    }
    await extractNodeArchive({ archivePath: extractArchivePath, extractDir });
    return;
  }

  await createNodeArchive({
    sourcePath: kv.get('--source-path'),
    sourceName: kv.get('--source-name'),
    artifactPath: kv.get('--artifact-path'),
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
