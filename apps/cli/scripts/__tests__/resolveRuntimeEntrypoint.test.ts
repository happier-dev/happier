import { rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import {
  resolveRuntimeEntrypoint,
  resolveValidRuntimeEntrypoint,
} from '../../bin/_resolveRuntimeEntrypoint.mjs';

function writeBuildManifest(dir: string, fingerprint: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.build-manifest.json'),
    `${JSON.stringify({
      fingerprint,
      builtAt: '2026-07-09T00:00:00.000Z',
      fileCount: 1,
      toolVersion: '1',
    })}\n`,
    'utf8',
  );
}

describe('resolveRuntimeEntrypoint', () => {
  it('selects only manifest-backed snapshots for repo-local launch readiness', () => {
    const root = createTempDirSync('happier-cli-resolve-manifest-entrypoint-');
    const distDir = join(root, 'dist');
    const packageDistDir = join(root, 'package-dist');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(packageDistDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), 'export const source = "uncommitted";\n', 'utf8');
    writeFileSync(join(packageDistDir, 'index.mjs'), 'export const source = "committed";\n', 'utf8');
    writeBuildManifest(packageDistDir, '0123456789abcdef');

    expect(resolveValidRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(packageDistDir, 'index.mjs'));
  });

  it('resolves a nested entrypoint against the snapshot-root manifest', () => {
    const root = createTempDirSync('happier-cli-resolve-nested-entrypoint-');
    const distDir = join(root, 'dist');
    const entrypoint = join(distDir, 'mcp', 'bridges', 'remote.mjs');
    mkdirSync(join(distDir, 'mcp', 'bridges'), { recursive: true });
    writeFileSync(entrypoint, 'export const ready = true;\n', 'utf8');
    writeBuildManifest(distDir, 'fedcba9876543210');

    expect(resolveValidRuntimeEntrypoint(root, join('mcp', 'bridges', 'remote.mjs'))).toEqual(entrypoint);
  });

  it('skips an incomplete dist entrypoint when package-dist is healthy', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const packageDistDir = join(root, 'package-dist');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(packageDistDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), "import './missing-chunk.mjs';\nexport {};\n", 'utf8');
    writeFileSync(join(packageDistDir, 'index.mjs'), 'export {};\n', 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(packageDistDir, 'index.mjs'));
  });

  it('prefers the hstack backup when dist is incomplete even if package-dist exists', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const packageDistDir = join(root, 'package-dist');
    const backupDir = join(root, '.dist.hstack-backup');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(packageDistDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), "import './missing-chunk.mjs';\nexport {};\n", 'utf8');
    writeFileSync(join(packageDistDir, 'index.mjs'), 'export const source = "package-dist";\n', 'utf8');
    writeFileSync(join(backupDir, 'index.mjs'), 'export const source = "backup";\n', 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(backupDir, 'index.mjs'));
  });

  it('skips a dist entrypoint when a nested reachable import is missing', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const packageDistDir = join(root, 'package-dist');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(packageDistDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), "import './index-hashed.mjs';\nexport {};\n", 'utf8');
    writeFileSync(join(distDir, 'index-hashed.mjs'), "await import('./create-missing.mjs');\n", 'utf8');
    writeFileSync(join(packageDistDir, 'index.mjs'), 'export {};\n', 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(packageDistDir, 'index.mjs'));
  });

  it('uses package-dist before an incomplete hstack backup when no source dist build is active', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const packageDistDir = join(root, 'package-dist');
    const backupDir = join(root, '.dist.hstack-backup');
    mkdirSync(packageDistDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(packageDistDir, 'index.mjs'), 'export const source = "package-dist";\n', 'utf8');
    writeFileSync(join(backupDir, 'index.mjs'), "import './missing-chunk.mjs';\nexport const source = 'backup';\n", 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(packageDistDir, 'index.mjs'));
  });

  it('falls back to .dist.hstack-backup when dist and package-dist are missing', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const backupDir = join(root, '.dist.hstack-backup');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'index.mjs'), 'export {};\n', 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(backupDir, 'index.mjs'));
  });

  it('prefers the hstack backup while a source dist build lock is active', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const backupDir = join(root, '.dist.hstack-backup');
    const buildLockPath = join(root, '.project', 'tmp', 'cli-dist-build.lock');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(join(root, '.project', 'tmp'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}\n', 'utf8');
    writeFileSync(join(root, 'yarn.lock'), '# lock\n', 'utf8');
    writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(join(backupDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(buildLockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }), 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(backupDir, 'index.mjs'));
  });

  it('prefers the hstack backup while an app-local hstack dist build lock is active', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const backupDir = join(root, '.dist.hstack-backup');
    const buildLockPath = join(root, '.dist.hstack-build.lock');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(join(backupDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(buildLockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }), 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(backupDir, 'index.mjs'));
  });

  it('treats a dist build lock with a live owner pid as active even when its timestamp is stale', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const backupDir = join(root, '.dist.hstack-backup');
    const buildLockPath = join(root, '.dist.hstack-build.lock');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), 'export const source = "dist";\n', 'utf8');
    writeFileSync(join(backupDir, 'index.mjs'), 'export const source = "backup";\n', 'utf8');
    const staleTimestamp = Date.now() - 1_000_000;
    writeFileSync(
      buildLockPath,
      JSON.stringify({ pid: process.pid, createdAtMs: staleTimestamp, updatedAtMs: staleTimestamp }),
      'utf8',
    );

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(backupDir, 'index.mjs'));
  });

  it('uses healthy dist while a source dist build lock is active when no hstack backup exists', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const packageDistDir = join(root, 'package-dist');
    const buildLockPath = join(root, '.project', 'tmp', 'cli-dist-build.lock');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(packageDistDir, { recursive: true });
    mkdirSync(join(root, '.project', 'tmp'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}\n', 'utf8');
    writeFileSync(join(root, 'yarn.lock'), '# lock\n', 'utf8');
    writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(join(packageDistDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(buildLockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }), 'utf8');

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(distDir, 'index.mjs'));
  });

  it('uses healthy dist when a stale hstack backup remains without an active build lock', () => {
    const root = createTempDirSync('happier-cli-resolve-entrypoint-');
    const distDir = join(root, 'dist');
    const backupDir = join(root, '.dist.hstack-backup');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(distDir, 'index.mjs'), 'export {};\n', 'utf8');
    writeFileSync(join(backupDir, 'index.mjs'), 'export {};\n', 'utf8');
    rmSync(join(root, '.project'), { recursive: true, force: true });

    expect(resolveRuntimeEntrypoint(root, 'index.mjs')).toEqual(join(distDir, 'index.mjs'));
  });
});
