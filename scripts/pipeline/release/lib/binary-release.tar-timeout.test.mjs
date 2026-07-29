import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDeterministicArchive,
  resolveArchiveBackend,
  resolveNodeArchiveExecutionTimeoutMs,
  resolveGzipExecutionTimeoutMs,
  resolveTarExecutionTimeoutMs,
  shouldUseWindowsSplitTarGzip,
} from './binary-release.mjs';

test('resolveTarExecutionTimeoutMs defaults to five minutes', () => {
  assert.equal(resolveTarExecutionTimeoutMs({}), 300_000);
});

test('resolveTarExecutionTimeoutMs clamps short values', () => {
  assert.equal(resolveTarExecutionTimeoutMs({ HAPPIER_RELEASE_TAR_TIMEOUT_MS: '1' }), 60_000);
});

test('resolveTarExecutionTimeoutMs clamps long values', () => {
  assert.equal(resolveTarExecutionTimeoutMs({ HAPPIER_RELEASE_TAR_TIMEOUT_MS: '99999999' }), 1_800_000);
});

test('resolveTarExecutionTimeoutMs accepts integer values in range', () => {
  assert.equal(resolveTarExecutionTimeoutMs({ HAPPIER_RELEASE_TAR_TIMEOUT_MS: '240000' }), 240_000);
});

test('resolveTarExecutionTimeoutMs scales timeout budget with archive stats', () => {
  const timeoutMs = resolveTarExecutionTimeoutMs(
    {},
    {
      totalBytes: 1_042_587_949,
      fileCount: 26_726,
    },
  );
  assert.equal(timeoutMs, 690_000);
});

test('resolveTarExecutionTimeoutMs honors parent timeout cap when provided', () => {
  const timeoutMs = resolveTarExecutionTimeoutMs(
    { HAPPIER_RELEASE_PARENT_TIMEOUT_MS: '1200000' },
    {
      totalBytes: 1_042_587_949,
      fileCount: 26_726,
    },
  );
  assert.equal(timeoutMs, 600_000);
});

test('resolveGzipExecutionTimeoutMs derives from tar timeout budget', () => {
  const timeoutMs = resolveGzipExecutionTimeoutMs(
    {},
    {
      totalBytes: 1_042_587_949,
      fileCount: 26_726,
    },
  );
  assert.equal(timeoutMs, 517_500);
});

test('resolveGzipExecutionTimeoutMs honors parent timeout cap when provided', () => {
  const timeoutMs = resolveGzipExecutionTimeoutMs(
    { HAPPIER_RELEASE_PARENT_TIMEOUT_MS: '1200000' },
    {
      totalBytes: 1_042_587_949,
      fileCount: 26_726,
    },
  );
  assert.equal(timeoutMs, 300_000);
});

test('resolveGzipExecutionTimeoutMs respects explicit override bounds', () => {
  assert.equal(resolveGzipExecutionTimeoutMs({ HAPPIER_RELEASE_GZIP_TIMEOUT_MS: '1' }), 60_000);
  assert.equal(resolveGzipExecutionTimeoutMs({ HAPPIER_RELEASE_GZIP_TIMEOUT_MS: '99999999' }), 1_800_000);
});

test('shouldUseWindowsSplitTarGzip enables split mode for large windows payloads', () => {
  assert.equal(shouldUseWindowsSplitTarGzip({
    platform: 'win32',
    archiveStats: { totalBytes: 1_042_587_949, fileCount: 26_726 },
    env: {},
  }), true);
});

test('shouldUseWindowsSplitTarGzip keeps non-windows payloads on direct tar path', () => {
  assert.equal(shouldUseWindowsSplitTarGzip({
    platform: 'darwin',
    archiveStats: { totalBytes: 1_042_587_949, fileCount: 26_726 },
    env: {},
  }), false);
});

test('shouldUseWindowsSplitTarGzip defaults to split mode on windows even for small payloads', () => {
  assert.equal(shouldUseWindowsSplitTarGzip({
    platform: 'win32',
    archiveStats: { totalBytes: 10_000, fileCount: 3 },
    env: {},
  }), true);
});

test('shouldUseWindowsSplitTarGzip allows explicit env override to disable split mode', () => {
  assert.equal(shouldUseWindowsSplitTarGzip({
    platform: 'win32',
    archiveStats: { totalBytes: 1_042_587_949, fileCount: 26_726 },
    env: { HAPPIER_RELEASE_WINDOWS_SPLIT_ARCHIVE: '0' },
  }), false);
});

test('resolveArchiveBackend defaults to node backend on windows', () => {
  assert.equal(resolveArchiveBackend({
    platform: 'win32',
    archiveStats: { totalBytes: 1_042_587_949, fileCount: 26_726 },
    env: {},
  }), 'node');
});

test('resolveArchiveBackend defaults to deterministic platform backends', () => {
  assert.equal(resolveArchiveBackend({
    platform: 'darwin',
    archiveStats: { totalBytes: 1_042_587_949, fileCount: 26_726 },
    env: {},
  }), 'node');
  assert.equal(resolveArchiveBackend({
    platform: 'linux',
    archiveStats: { totalBytes: 1_042_587_949, fileCount: 26_726 },
    env: {},
  }), 'tar');
});

test('createDeterministicArchive produces identical bytes when source mtimes differ', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-archive-mtime-'));
  const previousArchiveBackend = process.env.HAPPIER_RELEASE_ARCHIVE_BACKEND;
  process.env.HAPPIER_RELEASE_ARCHIVE_BACKEND = 'node';
  try {
    const archives = [];
    for (const [index, timestamp] of [1_000, 2_000].entries()) {
      const sourcePath = join(root, `source-${index}`);
      const payloadPath = join(sourcePath, 'payload');
      const filePath = join(payloadPath, 'example.txt');
      const artifactPath = join(root, `archive-${index}.tar.gz`);
      await mkdir(payloadPath, { recursive: true });
      await writeFile(filePath, 'identical payload\n', 'utf8');
      const date = new Date(timestamp * 1_000);
      await utimes(filePath, date, date);
      await utimes(payloadPath, date, date);
      await createDeterministicArchive({
        artifactPath,
        sourcePath,
        sourceName: 'payload',
      });
      const bytes = await readFile(artifactPath);
      archives.push(createHash('sha256').update(bytes).digest('hex'));
    }
    assert.equal(archives[0], archives[1]);
  } finally {
    if (previousArchiveBackend == null) {
      delete process.env.HAPPIER_RELEASE_ARCHIVE_BACKEND;
    } else {
      process.env.HAPPIER_RELEASE_ARCHIVE_BACKEND = previousArchiveBackend;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveArchiveBackend honors explicit backend override', () => {
  assert.equal(resolveArchiveBackend({
    platform: 'win32',
    archiveStats: { totalBytes: 10_000, fileCount: 3 },
    env: { HAPPIER_RELEASE_ARCHIVE_BACKEND: 'tar' },
  }), 'tar');
  assert.equal(resolveArchiveBackend({
    platform: 'linux',
    archiveStats: { totalBytes: 10_000, fileCount: 3 },
    env: { HAPPIER_RELEASE_ARCHIVE_BACKEND: 'node' },
  }), 'node');
});

test('resolveNodeArchiveExecutionTimeoutMs derives from tar timeout budget', () => {
  const timeoutMs = resolveNodeArchiveExecutionTimeoutMs(
    {},
    {
      totalBytes: 1_042_587_949,
      fileCount: 26_726,
    },
  );
  assert.equal(timeoutMs, 690_000);
});

test('resolveNodeArchiveExecutionTimeoutMs honors explicit override bounds', () => {
  assert.equal(resolveNodeArchiveExecutionTimeoutMs({ HAPPIER_RELEASE_NODE_ARCHIVE_TIMEOUT_MS: '1' }), 60_000);
  assert.equal(resolveNodeArchiveExecutionTimeoutMs({ HAPPIER_RELEASE_NODE_ARCHIVE_TIMEOUT_MS: '99999999' }), 1_800_000);
});
