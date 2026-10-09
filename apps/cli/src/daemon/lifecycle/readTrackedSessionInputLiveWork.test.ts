import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandler } from '@/api/rpc/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { registerSessionProviderInputAdmissionRpc } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { AdmittedRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import type { TrackedSession } from '../types';
import { createSessionLiveWorkProducer } from './sessionLiveWorkProducer';
import { readTrackedSessionInputLiveWork } from './readTrackedSessionInputLiveWork';

afterEach(() => vi.restoreAllMocks());

describe('requester-qualified live Session network observation', () => {
  it('queries Bob at the admitted Home, preserves real host activity, and withholds a reply after admission loss', async () => {
    const sessionId = 'c1234567890123456789012345';
    const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
    const tracked: TrackedSession = { pid: 1, startedBy: 'daemon', happySessionId: sessionId,
      requesterWorkAttributionV1: attribution };
    let current = true;
    let loseAdmissionDuringRpc = false;
    const requesterBootstrap: Pick<AdmittedRequesterSessionBootstrap,
      'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'getBoundSessionId' | 'isCurrent'> = {
      credentials: { token: 'bob-ordinary', encryption: null }, attribution,
      serverHttpBaseUrl: 'https://bob-home.test', getBoundSessionId: () => sessionId,
      // This port is the signed Home current-admission network boundary.
      isCurrent: async () => current,
    };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
        metadata: '{}', dataEncryptionKey: null, encryptionMode: 'plain' }) } };
    });
    const queue = new MessageQueue2<string>(() => 'mode');
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: 'runtime:bob', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied', committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
      } }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const handlers = new Map<string, RpcHandler>();
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const rpcTokens: string[] = [];
    const input = { tracked, credentials: { token: 'alice-ordinary', encryption: null },
      requesterBootstrap, custodianAccountId: 'alice', serverId: 'bob-home', machineId: 'machine',
      serverHttpBaseUrl: 'https://alice-home.test', isTrackedCurrent: () => true,
      // Only the Session network transport is replaced; host/RPC parsing and producer logic are real.
      callRpc: async (request: Parameters<NonNullable<Parameters<typeof readTrackedSessionInputLiveWork>[0]['callRpc']>>[0]) => {
        rpcTokens.push(request.token);
        const response = await handlers.get(request.method)!(request.request);
        if (loseAdmissionDuringRpc) current = false;
        return response;
      },
    };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked],
      readActivity: async () => await readTrackedSessionInputLiveWork(input) });
    // Characterize the genuine HTTP fixture before asserting composed activity;
    // a fixture/schema failure must not masquerade as an inventory assertion RED.
    const transport = await runWithServerHttpBaseUrl(requesterBootstrap.serverHttpBaseUrl,
      () => resolveSessionTransportContext({ credentials: requesterBootstrap.credentials, idOrPrefix: sessionId }));
    expect(transport).toMatchObject({ ok: true, sessionId, mode: 'plain' });
    expect(await source.read()).toMatchObject({ coverage: 'complete', items: [
      { category: 'session', attribution, state: 'settled' }, { category: 'input', attribution, state: 'settled' },
    ] });
    expect(rpcTokens).toEqual(['bob-ordinary']);
    expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://bob-home.test/')
      && config?.headers?.Authorization === 'Bearer bob-ordinary')).toBe(true);
    queue.pushImmediate('private input', 'mode');
    expect(await source.read()).toMatchObject({ coverage: 'complete', items: [
      { category: 'session', state: 'settled' }, { category: 'input', state: 'active' },
    ] });
    loseAdmissionDuringRpc = true;
    expect(await source.read()).toMatchObject({ coverage: 'unknown', items: [
      { category: 'session', state: 'unknown' }, { category: 'input', state: 'unknown' },
    ] });
    reads.mockClear();
    const callsBefore = rpcTokens.length;
    expect(await readTrackedSessionInputLiveWork({ ...input, requesterBootstrap: undefined }))
      .toEqual({ session: 'unknown', input: 'unknown' });
    expect(reads).not.toHaveBeenCalled();
    expect(rpcTokens.length).toBe(callsBefore);
  });
});
