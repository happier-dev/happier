import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  archiveSha256IntegrityFromDigest,
  normalizeArchiveSha256Integrity,
  resolveArchiveExpectedIntegrity,
} from './integrity';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('archive SHA-256 integrity', () => {
  it('converts the pack digest sidecar shape into canonical SRI', () => {
    const digest = 'ab'.repeat(32);
    expect(archiveSha256IntegrityFromDigest(`sha256:${digest}`))
      .toBe(`sha256-${Buffer.from(digest, 'hex').toString('base64')}`);
  });

  it('reads a matching local pack sidecar and ignores absent and remote sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-archive-integrity-'));
    roots.push(root);
    const archivePath = join(root, 'plugin.tgz');
    const digest = '12'.repeat(32);
    await writeFile(`${archivePath}.sha256`, `sha256:${digest}  ${basename(archivePath)}\n`, 'utf8');

    await expect(resolveArchiveExpectedIntegrity({ locator: archivePath }))
      .resolves.toBe(`sha256-${Buffer.from(digest, 'hex').toString('base64')}`);
    await expect(resolveArchiveExpectedIntegrity({ locator: join(root, 'ordinary.tgz') }))
      .resolves.toBeUndefined();
    await expect(resolveArchiveExpectedIntegrity({ locator: 'https://example.test/plugin.tgz' }))
      .resolves.toBeUndefined();
  });

  it('rejects a noncanonical explicit SRI and a sidecar for another archive', async () => {
    expect(() => normalizeArchiveSha256Integrity(`sha512-${Buffer.alloc(64).toString('base64')}`))
      .toThrow(/canonical sha256 SRI/i);
    const root = await mkdtemp(join(tmpdir(), 'happier-archive-integrity-'));
    roots.push(root);
    const archivePath = join(root, 'plugin.tgz');
    await writeFile(`${archivePath}.sha256`, `sha256:${'34'.repeat(32)}  another.tgz\n`, 'utf8');
    await expect(resolveArchiveExpectedIntegrity({ locator: archivePath }))
      .rejects.toThrow(/Invalid archive SHA-256 sidecar/);
  });
});
