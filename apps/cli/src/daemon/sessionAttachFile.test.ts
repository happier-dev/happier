import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

describe('createSessionAttachFile', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    vi.resetModules();
  });

  async function createHappyHomeFixture(): Promise<{ dir: string; baseDir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-home-'));
    tempDirs.push(dir);
    process.env.HAPPIER_HOME_DIR = dir;
    return {
      dir,
      baseDir: resolve(join(dir, 'tmp', 'session-attach')),
    };
  }

  test('writes a 0600 attach file under HAPPIER_HOME_DIR and cleanup deletes it', async () => {
    const { baseDir } = await createHappyHomeFixture();

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    const key = encodeBase64(new Uint8Array(32).fill(5), 'base64');
    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: 'happy-session-1',
      payload: { encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    expect(resolve(filePath).startsWith(baseDir + sep)).toBe(true);

    const raw = await readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      encryptionKeyBase64: key,
      encryptionVariant: 'dataKey',
    });

    if (process.platform !== 'win32') {
      const s = await stat(filePath);
      expect(s.mode & 0o077).toBe(0);
    }
    await cleanup();
    await expect(stat(filePath)).rejects.toBeTruthy();
  });

  test('prevents path traversal in happySessionId (always stays within base dir)', async () => {
    const { dir, baseDir } = await createHappyHomeFixture();

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    const key = encodeBase64(new Uint8Array(32).fill(5), 'base64');

    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: '../evil',
      payload: { encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    expect(resolve(filePath).startsWith(baseDir + sep)).toBe(true);
    expect(basename(filePath).startsWith('..')).toBe(false);

    await cleanup();
    await expect(stat(filePath)).rejects.toBeTruthy();

    // Ensure the base directory still exists (we didn't clobber parent dirs).
    await expect(stat(join(dir, 'tmp', 'session-attach'))).resolves.toBeTruthy();
  });
});
