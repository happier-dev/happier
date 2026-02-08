import { describe, expect, test, vi } from 'vitest';

describe('readSessionAttachFromEnv', () => {
  test('reads, validates, and deletes attach file', async () => {
    const { mkdtemp, rm, writeFile, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
    const dir = await mkdtemp(join(tmpdir(), 'happy-attach-'));
    try {
      process.env.HAPPIER_HOME_DIR = dir;

      vi.resetModules();

      const { encodeBase64 } = await import('@/api/encryption');
      const { readSessionAttachFromEnv } = await import('./sessionAttach');

      const attachDir = join(dir, 'tmp');
      await (await import('node:fs/promises')).mkdir(attachDir, { recursive: true });
      const filePath = join(attachDir, 'attach.json');

      const key = new Uint8Array(32).fill(9);
      const payload = {
        encryptionKeyBase64: encodeBase64(key, 'base64'),
        encryptionVariant: 'dataKey',
      };

      await writeFile(filePath, JSON.stringify(payload), { mode: 0o600 });
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const res = await readSessionAttachFromEnv();
      expect(res?.encryptionVariant).toBe('dataKey');
      expect(res?.encryptionKey).toEqual(key);

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
