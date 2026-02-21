import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('storage/files (S3 env parsing)', () => {
  it('does not require the MinIO dependency when the local backend is selected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-server-files-local-'));
    try {
      vi.resetModules();
      vi.doMock('minio', () => {
        throw new Error('MinIO should not be imported for the local backend');
      });

      const { initFilesLocalFromEnv, loadFiles } = await import('./files');
      initFilesLocalFromEnv({ HAPPIER_SERVER_LIGHT_FILES_DIR: dir } as unknown as NodeJS.ProcessEnv);
      await expect(loadFiles()).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes an explicit S3 region to the MinIO client (S3_REGION override, default us-east-1)', async () => {
    vi.resetModules();

    const clientCtor = vi.fn().mockImplementation(() => ({
      bucketExists: vi.fn().mockResolvedValue(true),
      putObject: vi.fn(),
    }));

    vi.doMock('minio', () => {
      return { Client: clientCtor };
    });

    const { initFilesS3FromEnv } = await import('./files');

    await initFilesS3FromEnv({
      S3_HOST: 'example.com',
      S3_BUCKET: 'bucket',
      S3_PUBLIC_URL: 'https://cdn.example.com',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
      S3_REGION: 'eu-west-1',
    } as unknown as NodeJS.ProcessEnv);

    expect(clientCtor).toHaveBeenCalledWith(expect.objectContaining({ region: 'eu-west-1' }));

    vi.resetModules();
    clientCtor.mockClear();
    vi.doMock('minio', () => {
      return { Client: clientCtor };
    });

    const { initFilesS3FromEnv: init2 } = await import('./files');
    await init2({
      S3_HOST: 'example.com',
      S3_BUCKET: 'bucket',
      S3_PUBLIC_URL: 'https://cdn.example.com',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
    } as unknown as NodeJS.ProcessEnv);

    expect(clientCtor).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-1' }));
  });

  it('throws when S3_PORT is set but not a valid integer port', async () => {
    vi.resetModules();
    const { initFilesS3FromEnv } = await import('./files');

    await expect(
      initFilesS3FromEnv({
        S3_HOST: 'example.com',
        S3_PORT: 'nope',
        S3_BUCKET: 'bucket',
        S3_PUBLIC_URL: 'https://cdn.example.com',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
      } as unknown as NodeJS.ProcessEnv),
    ).rejects.toThrow(/S3_PORT/i);
  });

  it('throws when the configured bucket does not exist', async () => {
    vi.resetModules();
    const bucketExists = vi.fn().mockResolvedValue(false);

    vi.doMock('minio', () => {
      return {
        Client: vi.fn().mockImplementation(() => ({
          bucketExists,
          putObject: vi.fn(),
        })),
      };
    });

    const { initFilesS3FromEnv, loadFiles } = await import('./files');

    await initFilesS3FromEnv({
      S3_HOST: 'example.com',
      S3_BUCKET: 'bucket',
      S3_PUBLIC_URL: 'https://cdn.example.com',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
    } as unknown as NodeJS.ProcessEnv);

    await expect(loadFiles()).rejects.toThrow(/bucket/i);
  });
});
