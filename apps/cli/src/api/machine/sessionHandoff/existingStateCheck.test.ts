import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerMachineSessionHandoffRpcHandlers } from './handlers';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler } from '@/api/rpc/types';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

describe('read-only existing native state admission', () => {
  it.each([false, true])('fails closed before reading native state without the full supported boundary (callback: %s)', async (callbackPresent) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-check-'));
    try {
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      // RPC transport registration is the system boundary; the real registrar owns admission.
      const rpcHandlerManager = { registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => handlers.set(method, handler) } as unknown as RpcHandlerManager;
      registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager, runtimeConfig: { activeServerDir },
        ...(callbackPresent ? { admitExistingSessionState: async () => null } : {}),
        loadSessionMetadata: async () => { throw new Error('unsupported peer must not read native state'); } });
      const handle = handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3);
      expect(handle).toBeTypeOf('function');
      expect(await handle!({ sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/target', sourceSessionStorageMode: 'persisted' })).toMatchObject({ ok: false, errorCode: 'handoff_existing_state_update_required' });
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
  it('refuses persisted existing-state recovery before reading native state when local support is no longer mounted', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-recovery-support-'));
    try {
      const handoffId = 'existing-recovery'; const jobId = `prepare_${handoffId}`;
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await store.write({ handoffId, jobId, createdAtMs: 1, updatedAtMs: 1,
        status: { handoffId, jobId, status: 'pending', phase: 'staging_target', recoveryActions: [] },
        prepareTargetRequest: { handoffId, sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target',
          targetPath: '/target', stateTransfer: 'existing', sourceSessionStorageMode: 'persisted', negotiatedTransportStrategy: 'direct_peer', endpointCandidates: [] } });
      const interrupted = await store.hydrateInterrupted(jobId, 2);
      if (!interrupted || interrupted.schemaVersion !== 2) throw new Error('Recovery fixture did not hydrate');
      const nativePath = join(activeServerDir, 'native-state'); await writeFile(nativePath, 'unchanged native bytes');
      let metadataReads = 0;
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      // Registration is the transport boundary; recovery/store/native admission remain real.
      const rpcHandlerManager = { registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => handlers.set(method, handler) } as unknown as RpcHandlerManager;
      registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager, runtimeConfig: { activeServerDir },
        admitExistingSessionState: async () => null,
        loadSessionMetadata: async () => { metadataReads += 1; throw new Error('Native state must not be read without supported authority'); } });
      await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3)!({ handoffId, jobId,
        expectedRevision: interrupted.transitionRevision, attemptId: 'explicit-resume' })).resolves.toMatchObject({ ok: true });
      await vi.waitFor(async () => expect((await store.read(jobId))?.failedAtMs).toBeTypeOf('number'));
      expect(await store.read(jobId)).toMatchObject({ lastErrorCode: 'handoff_existing_state_update_required' });
      expect(metadataReads).toBe(0);
      expect(await readFile(nativePath, 'utf8')).toBe('unchanged native bytes');
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
});
