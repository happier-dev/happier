import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

describe('storage/files (S3 env parsing)', () => {
  it('round trips S3 private bytes in the separate bucket using a private policy', async () => {
    vi.resetModules();
    const objects = new Map<string, Buffer>();
    vi.doMock('minio', () => ({ Client: vi.fn().mockImplementation(() => ({
      bucketExists: vi.fn().mockResolvedValue(true), getBucketPolicy: vi.fn().mockResolvedValue('{"Statement":[]}'),
      putObject: async (bucket: string, key: string, value: Buffer) => { objects.set(`${bucket}/${key}`, value); },
      getObject: async (bucket: string, key: string) => {
        const bytes = objects.get(`${bucket}/${key}`);
        if (!bytes) throw new Error('NoSuchKey');
        return Readable.from([bytes]);
      },
      removeObject: async (bucket: string, key: string) => { objects.delete(`${bucket}/${key}`); },
    })) }));
    const files = await import('./files');
    await files.initFilesS3FromEnv({ S3_HOST: 'example.com', S3_BUCKET: 'public', S3_PRIVATE_BUCKET: 'private',
      S3_PUBLIC_URL: 'https://cdn.example.com', S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret' });
    await files.loadFiles();
    const bytes = Uint8Array.of(0, 255, 0, 12);
    await files.writePrivateFile('artifacts/a/b', bytes);
    expect(await files.readPrivateFile('artifacts/a/b')).toEqual(bytes);
    expect(objects.has('public/artifacts/a/b')).toBe(false);
    await files.deletePrivateFile('artifacts/a/b');
    await files.deletePrivateFile('artifacts/a/b');
    await expect(files.readPrivateFile('artifacts/a/b')).rejects.toThrow();
  });
  it('keeps public-only S3 usable and refuses private IO without a separate bucket', async () => {
    vi.resetModules();
    vi.doMock('minio', () => ({ Client: vi.fn().mockImplementation(() => ({ bucketExists: vi.fn().mockResolvedValue(true) })) }));
    const files = await import('./files');
    await files.initFilesS3FromEnv({ S3_HOST: 'example.com', S3_BUCKET: 'public', S3_PUBLIC_URL: 'https://cdn.example.com',
      S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret' });
    await expect(files.loadFiles()).resolves.toBeUndefined();
    await expect(files.writePrivateFile('artifacts/a/b', Uint8Array.of(1))).rejects.toMatchObject({ code: 'private_storage_unavailable' });
    await expect(files.initFilesS3FromEnv({ S3_HOST: 'example.com', S3_BUCKET: 'public', S3_PRIVATE_BUCKET: 'public',
      S3_PUBLIC_URL: 'https://cdn.example.com', S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret' })).rejects.toThrow(/private/i);
  });
  it('refuses an anonymous-readable private S3 bucket without changing its policy', async () => {
    vi.resetModules();
    const setBucketPolicy = vi.fn();
    vi.doMock('minio', () => ({ Client: vi.fn().mockImplementation(() => ({
      bucketExists: vi.fn().mockResolvedValue(true), setBucketPolicy,
      getBucketPolicy: vi.fn().mockResolvedValue(JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }] })),
    })) }));
    const files = await import('./files');
    await files.initFilesS3FromEnv({ S3_HOST: 'example.com', S3_BUCKET: 'public', S3_PRIVATE_BUCKET: 'private',
      S3_PUBLIC_URL: 'https://cdn.example.com', S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret' });
    await files.loadFiles();
    await expect(files.writePrivateFile('artifacts/a/b', Uint8Array.of(1))).rejects.toMatchObject({ code: 'private_storage_unavailable' });
    expect(setBucketPolicy).not.toHaveBeenCalled();
  });
  it('round trips private bytes outside the public root and deletes them idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-server-files-private-'));
    try {
      vi.resetModules();
      const files = await import('./files');
      files.initFilesLocalFromEnv({ HAPPIER_SERVER_LIGHT_DATA_DIR: dir, HAPPIER_SERVER_LIGHT_FILES_DIR: join(dir, 'public') });
      await files.loadFiles();
      const bytes = Uint8Array.of(0, 255, 12, 0);
      await files.writePrivateFile('artifacts/a/b', bytes);
      expect(await files.readPrivateFile('artifacts/a/b')).toEqual(bytes);
      await expect(files.readPublicFile('artifacts/a/b')).rejects.toThrow();
      await files.deletePrivateFile('artifacts/a/b');
      await files.deletePrivateFile('artifacts/a/b');
      await expect(files.readPrivateFile('artifacts/a/b')).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('deletes local public files idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-server-files-delete-'));
    try { vi.resetModules(); const { deletePublicFile, initFilesLocalFromEnv, writePublicFile } = await import('./files'); initFilesLocalFromEnv({ HAPPIER_SERVER_LIGHT_FILES_DIR: dir } as NodeJS.ProcessEnv); await writePublicFile('public/u/a', Uint8Array.of(1)); await expect(deletePublicFile('public/u/a')).resolves.toBeUndefined(); await expect(deletePublicFile('public/u/a')).resolves.toBeUndefined(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
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
