import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { tmpdir } from 'os';
import { join } from 'path';

type Handler = (data: unknown) => Promise<unknown> | unknown;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('filesystem WRITE_FILE handler max-bytes', () => {
  const envReadKey = 'HAPPIER_FILES_READ_MAX_BYTES';
  const envChunkKey = 'HAPPIER_FILES_TRANSFER_CHUNK_BYTES';
  const originalRead = process.env[envReadKey];
  const originalChunk = process.env[envChunkKey];

  beforeEach(() => {
    process.env[envReadKey] = '1';
    process.env[envChunkKey] = '1024';
    vi.resetModules();
  });

  afterEach(() => {
    process.env[envReadKey] = originalRead;
    process.env[envChunkKey] = originalChunk;
    vi.clearAllMocks();
  });

  it('fails closed when base64 payload exceeds the configured max inline-write bytes', async () => {
    const { registerFileSystemHandlers } = await import('./fileSystem');

    const mgr = createRpcHandlerManager();
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-write-file-max-bytes-'));
    try {
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workingDirectory);

      const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
      if (!write) throw new Error('expected write handler');

      const result = await write({
        path: 'big.bin',
        content: Buffer.from('xx', 'utf8').toString('base64'), // 2 bytes > 1 byte limit
        expectedHash: null,
      });

      expect(result).toMatchObject({ success: false });
      await expect(stat(join(workingDirectory, 'big.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('caps inline base64 writes to the transfer chunk size even when filesReadMaxBytes is larger', async () => {
    process.env[envReadKey] = '10000';
    process.env[envChunkKey] = '1024';
    vi.resetModules();

    const { registerFileSystemHandlers } = await import('./fileSystem');

    const mgr = createRpcHandlerManager();
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-write-file-chunk-cap-'));
    try {
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workingDirectory);

      const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
      if (!write) throw new Error('expected write handler');

      const payload = Buffer.alloc(2048, 0x61); // 2KB > 1KB chunk cap; < 10KB read max
      const result = await write({
        path: 'big.bin',
        content: payload.toString('base64'),
        expectedHash: null,
      });

      expect(result).toMatchObject({ success: false });
      await expect(stat(join(workingDirectory, 'big.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed (and does not overwrite) when expectedHash is provided for an existing file larger than the inline-write ceiling', async () => {
    process.env[envReadKey] = '1024';
    process.env[envChunkKey] = '1024';
    vi.resetModules();

    const { registerFileSystemHandlers } = await import('./fileSystem');

    const mgr = createRpcHandlerManager();
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-write-file-expected-hash-size-'));
    try {
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workingDirectory);

      const path = join(workingDirectory, 'existing.bin');
      const existingPayload = Buffer.alloc(2048, 0x61);
      await writeFile(path, existingPayload);

      const expectedHash = createHash('sha256').update(existingPayload).digest('hex');

      const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
      if (!write) throw new Error('expected write handler');

      const result = await write({
        path: 'existing.bin',
        content: Buffer.from('ok', 'utf8').toString('base64'),
        expectedHash,
      });

      expect(result).toMatchObject({ success: false });
      expect((await stat(path)).size).toBe(2048);
      expect(await readFile(path)).toEqual(existingPayload);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
