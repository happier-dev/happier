import {
  SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1,
  buildSessionFollowSourceKeyPrepareRequestV1,
} from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionFollowAdmittedInputObservationV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceMaterialResolver } from '@/agent/runtime/session/follow/sessionFollowSourceMaterialResolver';
import { createSessionFollowSourceHydrator } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import {
  publishSessionFollowWakeInvalidation,
  readSessionFollowWakeInvalidationGeneration,
  waitForSessionFollowWakeInvalidation,
} from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import type { RpcHandler } from '@/api/rpc/types';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { registerRestrictedSessionFollowSourceKeyReceiver } from './registerRestrictedSessionFollowSourceKeyReceiver';

describe('restricted Follow source-key receiver', () => {
  it('rejects a different admitted input even when both Session identities match', async () => {
    const handlers = new Map<string, RpcHandler>();
    const sourceMaterial = createSessionFollowSourceMaterialResolver();
    registerRestrictedSessionFollowSourceKeyReceiver({
      destinationSessionId: 'destination', sourceMaterial,
      onSourceMaterialInstalled: () => {},
      rpc: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const first = buildSessionFollowSourceKeyPrepareRequestV1({
      sourceSessionId: 'source', destinationSessionId: 'destination', localInputId: 'first-input',
      sourceDataEncryptionKeyBase64: encodeBase64(new Uint8Array(32).fill(17)),
    });
    const second = buildSessionFollowSourceKeyPrepareRequestV1({
      sourceSessionId: 'source', destinationSessionId: 'destination', localInputId: 'second-input',
      sourceDataEncryptionKeyBase64: encodeBase64(new Uint8Array(32).fill(17)),
    });
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE)!;
    const rejected = await handler(first.request, { signal: new AbortController().signal,
      authorization: second.authorization }).catch((error: unknown) => error);
    expect(readRpcErrorCode(rejected)).toBe(SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1);
    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal: new AbortController().signal }))
      .toEqual({ mode: 'unavailable' });
    await expect(handler(first.request, { signal: new AbortController().signal,
      authorization: first.authorization })).resolves.toEqual({ v: 1, outcome: 'installed' });
  });

  it('installs only a request whose inner and authorized edge target this runtime', async () => {
    const handlers = new Map<string, RpcHandler>();
    const sourceMaterial = createSessionFollowSourceMaterialResolver();
    const onSourceMaterialInstalled = vi.fn();
    registerRestrictedSessionFollowSourceKeyReceiver({
      destinationSessionId: 'destination', sourceMaterial,
      onSourceMaterialInstalled,
      rpc: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE)!;
    const request = {
      v: 1 as const, sourceSessionId: 'source', destinationSessionId: 'destination',
      sourceDataEncryptionKeyBase64: encodeBase64(new Uint8Array(32).fill(17)),
    };
    const substituted = await handler(request, { signal: new AbortController().signal, authorization: {
      kind: 'session.follow.sourceKey.prepare', sourceSessionId: 'source', destinationSessionId: 'different',
    } as never }).catch((caught: unknown) => caught);
    expect(readRpcErrorCode(substituted)).toBe(SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1);
    expect((substituted as Error).message).toBe('Session Follow source-key preparation rejected');
    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal: new AbortController().signal })).toEqual({ mode: 'unavailable' });
    expect(onSourceMaterialInstalled).not.toHaveBeenCalled();

    await expect(handler(request, { signal: new AbortController().signal, authorization: {
      kind: 'session.follow.sourceKey.prepare', sourceSessionId: 'source', destinationSessionId: 'destination',
    } as never })).resolves.toEqual({ v: 1, outcome: 'installed' });
    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal: new AbortController().signal })).toMatchObject({ mode: 'e2ee' });
    expect(onSourceMaterialInstalled).toHaveBeenCalledOnce();
  });

  it('returns one typed, content-free rejection for malformed key material', async () => {
    const handlers = new Map<string, RpcHandler>();
    const sourceMaterial = createSessionFollowSourceMaterialResolver();
    const onSourceMaterialInstalled = vi.fn();
    registerRestrictedSessionFollowSourceKeyReceiver({
      destinationSessionId: 'destination', sourceMaterial,
      onSourceMaterialInstalled,
      rpc: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE)!;
    const secret = encodeBase64(new Uint8Array(31).fill(23));

    const error = await handler({
      v: 1,
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKeyBase64: secret,
    }, {
      signal: new AbortController().signal,
      authorization: {
        kind: 'session.follow.sourceKey.prepare',
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
      } as never,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(readRpcErrorCode(error)).toBe(SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1);
    expect((error as Error).message).toBe('Session Follow source-key preparation rejected');
    expect((error as Error).message).not.toContain(secret);
    expect(onSourceMaterialInstalled).not.toHaveBeenCalled();
    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal: new AbortController().signal })).toEqual({ mode: 'unavailable' });
  });

  it('wakes ordinary reconciliation after late installation and re-observes stale installs for revocation pruning', async () => {
    const signal = new AbortController().signal;
    const sourceDataKey = new Uint8Array(32).fill(41);
    const encryptedContent = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'prepared Runner source' } } },
    });
    const encryptedMetadata = encryptSessionPayload({
      ctx: { encryptionKey: sourceDataKey, encryptionVariant: 'dataKey' },
      payload: { path: '/workspace/source', host: 'source-host' },
    });
    const delivered = { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { transcriptSeq: 2, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake', event: { kind: 'message' },
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'runner-source-original', seq: 2 } } });
    let edgeIsCurrent = true;
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({
      ok: true,
      v: 1,
      destinationSessionId: 'destination',
      sourceSessionId: 'source',
      delivered: observed,
    });
    const session = {
      sessionId: 'destination',
      runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
      observePendingSessionFollow: vi.fn(async () => ({
        ok: true as const,
        v: 1 as const,
        sessionId: 'destination',
        publisherGeneration: '1',
        currentSourceSessionIds: edgeIsCurrent ? ['source'] : [],
        observations: edgeIsCurrent
          ? [SessionFollowAdmittedInputObservationV1Schema.parse({ kind: 'admitted_input', localInputId: 'accepted-input',
            sourceSessionId: 'source', destinationSessionId: 'destination', delivered, observed, delivery, effectiveDelivery: delivery.delivery })]
          : [],
      })),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const sourceMaterial = createSessionFollowSourceMaterialResolver();
    const hydrateObservation = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'restricted-runner-token', encryption: null },
      sourceMaterialResolver: sourceMaterial,
      deps: {
        fetchRunnerSourceProjection: (async () => ({
          v: 1,
          source: {
            id: 'source',
            encryptionMode: 'e2ee',
            metadata: encryptedMetadata,
            metadataLayoutVersion: 0,
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            thinking: false,
            thinkingAt: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
            meaningfulActivityAt: null,
            agentStateVersion: 0,
          },
          messages: [{
            seq: 2,
            localId: 'runner-source-original',
            content: { t: 'encrypted', c: encryptedContent },
            createdAt: 2,
            accountActor: null,
          }],
          hasMore: false,
        })) as never,
      },
    });
    const reconcile = createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 100_000,
      hydrateObservation,
      sourceMaterialController: sourceMaterial,
    });

    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal })).toEqual({ mode: 'unavailable' });
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();

    const handlers = new Map<string, RpcHandler>();
    const startWakeDrivenReconciliation = () => {
      const generation = readSessionFollowWakeInvalidationGeneration();
      return waitForSessionFollowWakeInvalidation(generation, signal).then(async (changed) => (
        changed ? await reconcile({ signal, followDeliveries: [{ delivery, localInputId: 'accepted-input', userMessageSeq: 2 }] }) : null
      ));
    };
    registerRestrictedSessionFollowSourceKeyReceiver({
      destinationSessionId: 'destination',
      sourceMaterial,
      onSourceMaterialInstalled: publishSessionFollowWakeInvalidation,
      rpc: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE)!;
    const preparedAfterInstall = startWakeDrivenReconciliation();
    await expect(handler({
      v: 1,
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKeyBase64: encodeBase64(sourceDataKey),
    }, {
      signal,
      authorization: {
        kind: 'session.follow.sourceKey.prepare',
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
      } as never,
    })).resolves.toEqual({ v: 1, outcome: 'installed' });
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal })).toMatchObject({ mode: 'e2ee' });

    const prepared = await preparedAfterInstall;
    expect(prepared?.updates).toEqual([expect.objectContaining({
      reason: 'source_changed',
      recentMessages: [expect.objectContaining({ seq: 2, text: 'prepared Runner source' })],
    })]);
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'accepted-input', userMessageSeq: 2 });
    await vi.waitFor(() => expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      expectedPublisherGeneration: '1',
      localInputId: 'accepted-input',
      expected: delivered,
      observed,
      consumed: observed,
      acceptance: { kind: 'admitted_input', localInputId: 'accepted-input', userMessageSeq: 2 },
    })));

    edgeIsCurrent = false;
    const prunedAfterStaleInstall = startWakeDrivenReconciliation();
    await expect(handler({
      v: 1,
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      sourceDataEncryptionKeyBase64: encodeBase64(sourceDataKey),
    }, {
      signal,
      authorization: {
        kind: 'session.follow.sourceKey.prepare',
        sourceSessionId: 'source',
        destinationSessionId: 'destination',
      } as never,
    })).resolves.toEqual({ v: 1, outcome: 'installed' });
    await expect(prunedAfterStaleInstall).resolves.toBeNull();
    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal })).toEqual({ mode: 'unavailable' });

    sourceMaterial.dispose();
    expect(sourceMaterial.resolveForHydration({ sourceSessionId: 'source', signal })).toEqual({ mode: 'unavailable' });
  });
});
