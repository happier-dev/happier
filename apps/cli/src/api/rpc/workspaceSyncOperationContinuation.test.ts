import { expect, it } from 'vitest';
import { callSocketRpc, createSocketRpcContinuation, socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createWorkspaceSyncSourceOperationContinuation, openWorkspaceSyncTargetOperationContinuation } from './workspaceSyncOperationContinuation';
import type { RpcLocalActionContext } from './types';

it('retains the source operation through remote cleanup progress, nested review and Stop', async () => {
  // Socket delivery/relay is the boundary; both continuation owners and codec remain real.
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const controller = new AbortController();
  const progress: unknown[] = [];
  let remoteOperationId: string | undefined;
  let reviewCalls = 0;
  let graphRetired = false;
  let stopSource: (() => void) | undefined;
  const source: RpcLocalActionContext = {
    actionRequestId: 'original-request',
    operationAcceptance: { operationId: 'original-operation', actionId: 'workspace.sync.relationship.remove', accept() { throw new Error('second acceptance'); } },
    operationProgress: { update: update => { progress.push(update); } },
    operationOwnerUpdate: { update: update => { progress.push(update); } },
    retirePreparedWorkspaceCopy: async () => {
      expect(graphRetired).toBe(false);
      graphRetired = true;
    },
    operationCancellation: { onRequest(listener) { stopSource = listener; return () => { stopSource = undefined; }; } },
    operationReview: { waitForResume: async (_details, producer) => {
      expect(await producer?.review({ reviewedEffectDigest: 'a'.repeat(64), skipForInvocation: false })).toBeNull();
    } },
  };
  const socket = (side: 'source' | 'target') => ({
    connected: true,
    on(event: string, listener: (...args: unknown[]) => void) {
      const key = `${side}:${event}`;
      const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
    },
    off(event: string, listener: (...args: unknown[]) => void) { listeners.get(`${side}:${event}`)?.delete(listener); },
    emit(event: string, ...args: unknown[]) {
      const [payload, rawAck] = args;
      const ack = typeof rawAck === 'function' ? rawAck as (result: unknown) => void : undefined;
      const packet = payload as { requestId: string; params: unknown; method: string; callId: string; reply?: true; notification?: true };
      if (event === SOCKET_RPC_EVENTS.CONTINUATION) {
        const other = side === 'source' ? 'target' : 'source';
        const forwarded = { requestId: other === 'target' ? 'target-request' : 'source-request',
          senderSocketId: `${side}-socket`, params: packet.params, callId: packet.callId,
          ...(packet.reply ? { reply: true as const } : {}), ...(packet.notification ? { notification: true as const } : {}) };
        for (const listener of listeners.get(`${other}:${event}`) ?? []) listener(forwarded);
      } else if (event === SOCKET_RPC_EVENTS.CANCEL) {
        controller.abort();
      } else if (event === SOCKET_RPC_EVENTS.CALL) {
        for (const listener of listeners.get(`source:${SOCKET_RPC_EVENTS.CONTINUATION}`) ?? []) {
          listener({ requestId: 'source-request', selectedSocketId: 'target-socket' });
        }
        void (async () => {
          const channel = createSocketRpcContinuation({ socket: targetSocket, requestId: 'target-request',
            content: { mode: 'plain' }, method: packet.method,
            returnTo: { socketId: 'source-socket', requestId: 'source-request' },
            signal: controller.signal, onRequest: (value, call) => targetReview(value, call) });
          let targetReview: Parameters<typeof createSocketRpcContinuation>[0]['onRequest'] = async () => null;
          try {
            const operation = await openWorkspaceSyncTargetOperationContinuation(channel, controller.signal,
              handler => { targetReview = handler; }, () => controller.abort());
            remoteOperationId = operation.operationAcceptance?.operationId;
            operation.operationProgress?.update({ phase: 'teardown', label: 'Cleaning checkout' });
            operation.operationProgress?.update({ label: 'Cleanup output' });
            await operation.operationReview!.waitForResume(reviewDetails(), { review: async () => { reviewCalls += 1; return null; } });
            expect(graphRetired).toBe(false);
            await operation.retirePreparedWorkspaceCopy!();
            await operation.retirePreparedWorkspaceCopy!();
            expect(graphRetired).toBe(true);
            const stopped = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
            operation.operationCancellation!.onRequest(() => controller.abort());
            stopSource!();
            await stopped;
            expect(operation.signal?.aborted).toBe(true);
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            ack?.({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, { removed: true }, decoded.callId) });
          } finally { channel.dispose(); }
        })().catch(error => ack?.({ ok: false, error: String(error) }));
      }
    },
  });
  const sourceSocket = socket('source');
  const targetSocket = socket('target');
  const result = await callSocketRpc({ socket: sourceSocket, target: { kind: 'machine', id: 'target' }, method: 'remove',
    requestId: 'source-request', params: {}, content: { mode: 'plain' }, timeoutMs: null,
    onContinuation: createWorkspaceSyncSourceOperationContinuation(source) });
  expect(result).toEqual({ removed: true });
  expect(remoteOperationId).toBe('original-operation');
  expect(progress).toEqual([{ phase: 'teardown', label: 'Cleanup output' }]);
  expect(reviewCalls).toBe(1);
  expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
  expect(stopSource).toBeUndefined();
});

function reviewDetails() {
  return { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
    reviewedEffect: { phase: 'teardown' }, reviewedEffectDigest: 'a'.repeat(64) };
}

it('retains Stop received during describe before a native cancellation listener exists', async () => {
  const controller = new AbortController();
  let receive: Parameters<typeof createSocketRpcContinuation>[0]['onRequest'] = async () => null;
  await expect(openWorkspaceSyncTargetOperationContinuation({
    call: async () => {
      await receive({ kind: 'stop' }, async () => null);
      return { operationId: 'original-operation', reviewSupported: true };
    },
    notify: async () => { throw new Error('No native work may start'); },
  }, controller.signal, handler => { receive = handler; }, () => controller.abort()))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(controller.signal.aborted).toBe(true);
});
