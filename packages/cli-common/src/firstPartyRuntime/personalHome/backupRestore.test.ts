import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';

import { createPersonalHomeBackup, rotatePersonalHomeBackups } from './backup.js';
import { verifyPersonalHomeArchive } from './archive.js';
import { resolvePersonalHomeRuntimeLayout } from './layout.js';
import { restorePersonalHomeBackup } from './restore.js';
import { parsePersonalHomeBackupManifest } from './manifest.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-'));
  const layout = resolvePersonalHomeRuntimeLayout({ homeDir: root, platform: 'linux', mode: 'user' });
  await mkdir(layout.dataDir, { recursive: true });
  await mkdir(join(layout.publicFilesDir, 'nested'), { recursive: true });
  await mkdir(layout.privateFilesDir, { recursive: true });
  await writeFile(layout.databasePath, 'sqlite-fixture');
  await writeFile(layout.masterSecretPath, 'master-secret-fixture');
  await writeFile(join(layout.publicFilesDir, 'nested', 'readme.txt'), 'public');
  await writeFile(join(layout.privateFilesDir, 'secret.txt'), 'private');
  return { root, layout };
}

describe('Personal Home backup and restore owner', () => {
  it('archives the fixed database/public/private/secret allowlist and verifies every hash', async () => {
    const { root, layout } = await fixture();
    try {
      const outputPath = join(layout.backupsDir, 'home-1.tar');
      const result = await createPersonalHomeBackup({
        layout,
        outputPath,
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {
          homeServerIdentityId: 'home-identity',
          canonicalServerUrl: 'http://127.0.0.1:43123',
          encryptionStoragePolicy: 'plaintext_only',
          defaultAccountMode: 'plain',
          anonymousSignupPhase: 'loopback-bootstrap-then-disabled',
        },
      });
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
        'database/home.sqlite',
        'files/private/secret.txt',
        'files/public/nested/readme.txt',
        'secrets/handy-master-secret.txt',
        'configuration/home.env.json',
      ].sort());
      expect(await verifyPersonalHomeArchive(result.path)).toMatchObject({
        format: 'happier-personal-home-backup',
        version: 1,
        homeServerIdentityId: 'home-identity',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires the supplied SQLite checkpoint and quick-check callbacks before copying the database', async () => {
    const { root, layout } = await fixture();
    try {
      await expect(createPersonalHomeBackup({
        layout, outputPath: join(layout.backupsDir, 'quick-check.tar'), stagingDir: join(root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {},
        sqlite: { checkpoint: async () => ({ busy: 0 }), quickCheck: async () => false },
      })).rejects.toMatchObject({ code: 'sqlite_check_failed' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores through a staged swap and restores the destination when post-swap health fails', async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => false,
      });
      expect(result.outcome).toBe('rolled_back');
      expect(await readFile(destination.layout.databasePath, 'utf8')).toBe('destination-before-restore');
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('rotates only verified archives and never removes the newest retained backup', async () => {
    const { root, layout } = await fixture();
    try {
      for (const name of ['one.tar', 'two.tar', 'three.tar']) {
        await createPersonalHomeBackup({
          layout,
          outputPath: join(layout.backupsDir, name),
          stagingDir: join(root, `staging-${name}`),
          homeServerIdentityId: 'home-identity',
          schemaVersion: '1',
          happierVersion: '0.0.0',
          configuration: {},
        });
      }
      await writeFile(join(layout.backupsDir, 'unverified.tar'), 'not a tar archive');
      const result = await rotatePersonalHomeBackups({ backupsDir: layout.backupsDir, maxBackups: 2 });
      expect(result.retained.length).toBe(2);
      expect(await readFile(join(layout.backupsDir, 'unverified.tar'), 'utf8')).toBe('not a tar archive');
      expect((await readdir(layout.backupsDir)).filter((name) => name.endsWith('.tar')).length).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for archive paths outside the fixed allowlist and link entries', async () => {
    const { root, layout } = await fixture();
    try {
      const outputPath = join(layout.backupsDir, 'home.tar');
      const result = await createPersonalHomeBackup({
        layout, outputPath, stagingDir: join(root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {},
      });
      expect(() => parsePersonalHomeBackupManifest({ ...result.manifest, entries: [...result.manifest.entries, { path: '../outside', size: 1, sha256: 'a'.repeat(64) }] })).toThrow(/Invalid Personal Home backup path/u);
      const unexpectedStage = join(root, 'unexpected-stage');
      await mkdir(unexpectedStage, { recursive: true });
      await writeFile(join(unexpectedStage, 'unexpected.txt'), 'unexpected');
      await tar.create({ cwd: unexpectedStage, file: join(root, 'unexpected.tar'), portable: true }, ['unexpected.txt']);
      await expect(verifyPersonalHomeArchive(join(root, 'unexpected.tar'))).rejects.toThrow(/Invalid Personal Home backup path/u);
      await symlink('unexpected.txt', join(unexpectedStage, 'files-link'));
      await tar.create({ cwd: unexpectedStage, file: join(root, 'link.tar'), portable: true, follow: false }, ['files-link']);
      await expect(verifyPersonalHomeArchive(join(root, 'link.tar'))).rejects.toThrow(/Invalid Personal Home backup path|Unsupported archive entry type|Archive links/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
