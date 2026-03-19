import { describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('readSessionAttachFromEnv', () => {
  test('rejects attach files outside the session-attach dir', async () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const dir = await mkdtemp(join(tmpdir(), 'happy-attach-'));
    try {
      process.env.HAPPIER_HOME_DIR = dir;

      vi.resetModules();

      const { readSessionAttachFromEnv } = await import('./sessionAttach');

      const attachDir = join(dir, 'tmp');
      await mkdir(attachDir, { recursive: true });
      const filePath = join(attachDir, 'attach.json');

      await writeFile(filePath, JSON.stringify({ v: 2, encryptionMode: 'plain' }), { mode: 0o600 });
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      await expect(readSessionAttachFromEnv()).rejects.toThrow('Invalid session attach file location');
    } finally {
      if (previousHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = previousHomeDir;
      }
      if (previousAttachFile === undefined) {
        delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      } else {
        process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttachFile;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects symlink attach files (must be a regular file)', async () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const dir = await mkdtemp(join(tmpdir(), 'happy-attach-'));
    try {
      process.env.HAPPIER_HOME_DIR = dir;

      vi.resetModules();

      const { readSessionAttachFromEnv } = await import('./sessionAttach');

      const attachDir = join(dir, 'tmp', 'session-attach');
      await mkdir(attachDir, { recursive: true });

      const targetPath = join(dir, 'tmp', 'target.json');
      await writeFile(targetPath, JSON.stringify({ v: 2, encryptionMode: 'plain' }), { mode: 0o600 });

      const linkPath = join(attachDir, 'attach.json');
      await symlink(targetPath, linkPath);

      process.env.HAPPIER_SESSION_ATTACH_FILE = linkPath;

      await expect(readSessionAttachFromEnv()).rejects.toThrow();

      // Ensure we still clean up the attach file path.
      await expect(stat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(targetPath)).resolves.toBeTruthy();
    } finally {
      if (previousHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = previousHomeDir;
      }
      if (previousAttachFile === undefined) {
        delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      } else {
        process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttachFile;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reads, validates, and deletes legacy v1 attach file (e2ee)', async () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const dir = await mkdtemp(join(tmpdir(), 'happy-attach-'));
    try {
      process.env.HAPPIER_HOME_DIR = dir;

      vi.resetModules();

      const { encodeBase64 } = await import('@/api/encryption');
      const { readSessionAttachFromEnv } = await import('./sessionAttach');

      const attachDir = join(dir, 'tmp', 'session-attach');
      await mkdir(attachDir, { recursive: true });
      const filePath = join(attachDir, 'attach.json');

      const key = new Uint8Array(32).fill(9);
      const payload = {
        encryptionKeyBase64: encodeBase64(key, 'base64'),
        encryptionVariant: 'dataKey',
      };

      await writeFile(filePath, JSON.stringify(payload), { mode: 0o600 });
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const res = await readSessionAttachFromEnv();
      expect(res).toEqual({ encryptionMode: 'e2ee', encryptionVariant: 'dataKey', encryptionKey: key });

      // File should be deleted.
      await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = previousHomeDir;
      }
      if (previousAttachFile === undefined) {
        delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      } else {
        process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttachFile;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reads, validates, and deletes v2 attach file (plain)', async () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const dir = await mkdtemp(join(tmpdir(), 'happy-attach-'));
    try {
      process.env.HAPPIER_HOME_DIR = dir;

      vi.resetModules();

      const { readSessionAttachFromEnv } = await import('./sessionAttach');

      const attachDir = join(dir, 'tmp', 'session-attach');
      await mkdir(attachDir, { recursive: true });
      const filePath = join(attachDir, 'attach.json');

      const payload = {
        v: 2,
        encryptionMode: 'plain',
      };

      await writeFile(filePath, JSON.stringify(payload), { mode: 0o600 });
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const res = await readSessionAttachFromEnv();
      expect(res).toEqual({ encryptionMode: 'plain' });
      expect(process.env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();

      // File should be deleted.
      await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = previousHomeDir;
      }
      if (previousAttachFile === undefined) {
        delete process.env.HAPPIER_SESSION_ATTACH_FILE;
      } else {
        process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttachFile;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
