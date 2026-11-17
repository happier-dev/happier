import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMemoryProcessBoundary } from '@/daemon/memory/processMemoryIndexer.testkit';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('rpcHandlers.memory cancellation', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('passes the target-side RPC signal through deep query embedding work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-cancel-'));
    const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    let worker: MemoryWorkerHandle | undefined;
    let restoreDaemon = () => {};
    try {
      environment.patch({ HAPPIER_HOME_DIR: dir, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
      vi.resetModules();
      const { configuration } = await import('@/configuration');
      const priorDaemon = configuration.isDaemonProcess;
      Object.assign(configuration, { isDaemonProcess: false });
      restoreDaemon = () => { Object.assign(configuration, { isDaemonProcess: priorDaemon }); };
      const axios = (await import('axios')).default;
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200,
          data: { sessions: [], hasNext: false, nextCursor: null } };
        throw new Error(`Unexpected Memory HTTP path: ${path}`);
      });
      const boundary = createMemoryProcessBoundary();
      const channel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
      vi.spyOn(channel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
      let holdEmbedding = false;
      let entered!: () => void;
      const embeddingEntered = new Promise<void>(resolve => { entered = resolve; });
      let embeddingCancelled!: () => void;
      const embeddingAborted = new Promise<void>(resolve => { embeddingCancelled = resolve; });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        expect(String(url)).toBe('https://embeddings.example.test/v1/embeddings');
        expect(JSON.parse(String(init?.body))).toMatchObject({ input: 'cancellation', model: 'fixture-model' });
        if (!holdEmbedding) return Response.json({ data: [{ embedding: [1] }] });
        const signal = init?.signal;
        if (!signal) throw new Error('Embedding HTTP request omitted cancellation');
        entered();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => { embeddingCancelled(); reject(signal.reason); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      });
      const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
      await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, indexMode: 'deep',
        embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'custom', custom: { kind: 'openai_compatible',
          baseUrl: 'https://embeddings.example.test/v1', model: 'fixture-model',
          apiKey: { _isSecretValue: true, value: 'fixture-key' },
        } } });
      const { startMemoryWorker } = await import('@/daemon/memory/memoryWorker');
      worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine' });
      const { resolveMemoryIndexPaths } = await import('@/daemon/memory/memoryIndexPaths');
      const { openDeepIndexDb } = await import('@/daemon/memory/deepIndex/deepIndexDb');
      const db = openDeepIndexDb({ dbPath: resolveMemoryIndexPaths().deepDbPath });
      db.init();
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        text: 'cancellation target',
      });
      db.close();

      const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
      const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
      const { registerMachineMemoryRpcHandlers } = await import('./rpcHandlers.memory');
      registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
      const query = { v: 1, query: 'cancellation', scope: { type: 'global' }, mode: 'deep' };
      await expect(manager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_SEARCH, query))
        .resolves.toMatchObject({ ok: true, hits: [{ sessionId: 's1' }] });
      holdEmbedding = true;
      const controller = new AbortController();
      const request = manager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_SEARCH, query, { signal: controller.signal });
      const rejected = expect(request).rejects.toThrow();
      await embeddingEntered;
      controller.abort(new Error('memory-query-cancelled'));
      await rejected;
      await embeddingAborted;
    } finally {
      await worker?.stop();
      restoreDaemon();
      environment.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
