import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineSessionHandoffRpcHandlers } from './handlers';

// cli-v0.2.11 (98ea8fb76733b1dd785d38c31360179cafa84824),
// packages/protocol/src/sessionControl/handoff/handoffSchemas.ts, plus the
// moving 0.2 V2 peer operation. Owner ruling 2026-10-30 refuses these moves.
const predecessorPrepare = {
  handoffId: 'handoff-predecessor',
  sessionId: 'session-predecessor',
  sourceMachineId: 'source',
  targetMachineId: 'target',
  negotiatedTransportStrategy: 'direct_peer',
  sourceSessionStorageMode: 'persisted',
  targetSessionStorageMode: 'direct',
  targetPath: '/target',
  endpointCandidates: [],
  handoffMetadataV2: {
    providerBundleTransferPublication: { transferId: 'bundle-predecessor', sizeBytes: 1, manifestHash: 'sha256:predecessor' },
  },
} as const;

const identity = { handoffId: predecessorPrepare.handoffId, sessionId: predecessorPrepare.sessionId };
const attempt = { ...identity, attemptId: 'attempt-predecessor' };
const { sessionId: _sessionId, ...releasedPrepare } = predecessorPrepare;

describe('predecessor Session move refusal', () => {
  it.each([
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START, input: {
      requestId: 'request-predecessor', sessionId: predecessorPrepare.sessionId,
      sourceMachineId: 'source', targetMachineId: 'target', sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
    } },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET, input: releasedPrepare },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET, input: { handoffId: identity.handoffId } },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, input: { handoffId: identity.handoffId, mode: 'target' } },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, input: { handoffId: identity.handoffId, reason: 'cancelled' } },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, input: { handoffId: identity.handoffId } },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, input: predecessorPrepare },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, input: identity },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2, input: attempt },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2, input: attempt },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2, input: { ...attempt, mode: 'target' } },
    { method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, input: { ...identity, reason: 'cancelled' } },
  ])('returns the typed update result before any partial import: $method', async ({ method, input }) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-refusal-'));
    try {
      // Home authorization and native process control are system boundaries.
      // The manager, registrar, handlers and filesystem stores remain real.
      const stop = vi.fn(async () => 'stopped' as const);
      const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: predecessorPrepare.sessionId }));
      const manager = new RpcHandlerManager({ scopePrefix: 'target', localMachineId: 'target', encryptionMode: 'plain',
        authorizeRequest: async () => ({ ok: true }), logger: () => undefined });
      registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager: manager, runtimeConfig: { activeServerDir },
        stopSessionForHandoff: stop, spawnSessionForHandoff: spawn });
      const before = await readdir(activeServerDir, { recursive: true });
      const response = await manager.handleRequest({ method: `target:${method}`, params: input });
      expect(response).toEqual({ ok: false, errorCode: 'handoff_update_required', error: 'Update both computers to move this Session' });
      expect(await readdir(activeServerDir, { recursive: true })).toEqual(before);
      expect(stop).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
