import { createServer } from 'node:http';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Metadata } from '@/api/types';
import { registerSessionGuardNoticeRpc, requestSessionGuardNotice } from '@/agent/runtime/session/input/sessionGuardNoticeRpc';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTrackedSessionRpc } from './withTrackedSessionRpc';
import { createGuardSessionAccess } from '../guard/sessionAccess';
import { createRequesterSessionRuntimeContextResolver, releaseUnretainedRequesterSessionRuntimeContext } from './requesterSessionCredentials';
import type { TrackedSession } from '../types';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';

const sessionId = 'caaaaaaaaaaaaaaaaaaaaaaaa';
afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(notify: () => Promise<void>) {
  const channel = await createRequesterCurrentnessSocketHarness();
  let current = true;
  let metadata: Metadata = createTestMetadata();
  // Home HTTP and Session metadata persistence are genuine server boundaries.
  // Exact-Session admission, RPC codecs, relay socket and Guard receiver stay real.
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', dataEncryptionKey: null }),
    } };
    throw new Error(`Unexpected Home HTTP path: ${new URL(url).pathname}`);
  });
  const manager = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
  registerSessionGuardNoticeRpc({ rpcHandlerRegistrar: manager, machineId: 'machine', agentId: 'test-agent', notify,
    session: { sessionId, getMetadataSnapshot: () => metadata,
      checkCurrentPublisherAuthority: async () => current,
      updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); },
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    },
  });
  const pending = new Set<Promise<void>>();
  channel.server.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
      const execution = (async () => {
        try { ack({ ok: true, result: await manager.handleRequest(packet) }); }
        catch { ack({ ok: false, error: 'test_relay_failure' }); }
      })();
      pending.add(execution);
      void execution.finally(() => pending.delete(execution));
    });
  });
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: sessionId };
  const sessions = new Map([[tracked.trackingKey, tracked]]);
  const guard = createGuardSessionAccess({
    readAccess: () => ({ credentials: { token: 'fixture-token', encryption: null }, custodianAccountId: 'account',
      serverId: 'home', machineId: 'machine', serverHttpBaseUrl: 'https://guard-home.test' }),
    resolveRequesterSessionRuntimeContext: createRequesterSessionRuntimeContextResolver({ trackedSessions: sessions,
      getCreateRuntime: () => null,
      // No requester runtime is installed in this custodian-only fixture;
      // the real resolver must not attempt the persistence recovery boundary.
      recoverBootstrap: async () => { throw new Error('Unexpected requester custody recovery'); },
    }),
    releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
      [...sessions.values()].map(session => session.requesterSessionRuntimeContext)),
    isTrackedCurrent: session => current && sessions.get(session.trackingKey) === session,
  });
  return {
    metadata: () => metadata,
    retire: () => { current = false; },
    sendGuardNotice: () => guard.sendNotice(tracked, { kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions' }),
    send: (signal: AbortSignal, timeoutMs?: number | null) => {
      const access = { tracked: { trackingKey: legacyPidSessionTrackingKey(123), pid: 123, startedBy: 'daemon', happySessionId: sessionId },
        credentials: { token: 'fixture-token', encryption: null }, custodianAccountId: 'account',
        serverId: 'home', machineId: 'machine', serverHttpBaseUrl: 'https://guard-home.test',
        isTrackedCurrent: () => current, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
      return withTrackedSessionRpc(access, callRpc => requestSessionGuardNotice({ callRpc,
        request: { sessionId, state: { kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions' } } }));
    },
    close: async () => { await Promise.all(pending); await channel.close(); },
  };
}

describe('tracked Session Guard notice acknowledgement lifetime', () => {
  it('publishes the daemon Guard notice through its scoped Session access owner', async () => {
    const owner = await setup(async () => {});
    try {
      await expect(owner.sendGuardNotice()).resolves.toBe(true);
      expect(owner.metadata()).toHaveProperty('sessionGuardStateV1.kind', 'stopping');
      owner.retire();
      await expect(owner.sendGuardNotice()).resolves.toBe(false);
    } finally { await owner.close(); }
  });

  it('admits a real delayed Guard acknowledgement beyond the default RPC deadline without changing that default', async () => {
    // The observed notification boundary took >22 s. Exercise the existing
    // 20 s transport deadline with real clocks and sockets, not option assertions.
    const owner = await setup(async () => { await new Promise(resolve => setTimeout(resolve, 20_100)); });
    try {
      const results = await Promise.allSettled([
        owner.send(new AbortController().signal, null),
        owner.send(new AbortController().signal),
      ]);
      expect(owner.metadata()).toHaveProperty('sessionGuardStateV1.kind', 'stopping');
      expect(results[0]).toEqual({ status: 'fulfilled', value: { ok: true } });
      expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ name: 'RpcError', message: 'RPC call timeout' }) });
    } finally { await owner.close(); }
  }, 40_000);

  it('cancels the caller while notification admission is held and refuses a retired late acknowledgement', async () => {
    const entered = deferred();
    const released = deferred();
    const owner = await setup(async () => { entered.resolve(); await released.promise; });
    const lifetime = new AbortController();
    const result = Promise.allSettled([owner.send(lifetime.signal, null)]);
    try {
      await entered.promise;
      owner.retire();
      lifetime.abort();
      expect((await result)[0]).toMatchObject({ status: 'rejected' });
    } finally { released.resolve(); await owner.close(); }
  });

  it('finishes an admitted warning after Session retirement and refuses the next call', async () => {
    const entered = deferred();
    const released = deferred();
    const owner = await setup(async () => { entered.resolve(); await released.promise; });
    const result = owner.send(new AbortController().signal, null);
    try {
      await entered.promise;
      owner.retire();
      released.resolve();
      // The publisher owns this acknowledgement; caller custody must not replace it with null.
      await expect(result).resolves.toEqual({ ok: false });
      expect(owner.metadata()).toHaveProperty('sessionGuardStateV1.kind', 'stopping');
      await expect(owner.send(new AbortController().signal, null)).resolves.toBeNull();
    } finally { released.resolve(); await owner.close(); }
  });
});

// OWNER-RULINGS 2026-11-16 "Remove overbuilt re-reads": the Guard memory-ceiling scan reads every
// live Session's metadata on each plan pass. A read-only tracked operation borrows the held,
// push-updated Account observation; the Session record stays fresh, and other operations keep
// the fresh witness.
describe('tracked Session read operations', () => {
  it('borrow the held Account observation for read usage and keep the fresh witness otherwise', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
          updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null })));
      } else if (request.url === `/v2/sessions/${sessionId}`) {
        response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'plain', metadata: '{}', dataEncryptionKey: null }) })));
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback HTTP address unavailable');
    const base = `http://127.0.0.1:${address.port}`;
    const channel = await createRequesterCurrentnessSocketHarness();
    const token = 'tracked-read-held-fixture';
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId: 'account', token, serverBaseUrl: base });
    const count = (url: string) => requests.filter(value => value === url).length;
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(321), pid: 321, startedBy: 'daemon', happySessionId: sessionId };
    const run = (usage?: 'read') => withTrackedSessionRpc({ tracked, credentials: { token, encryption: null },
      custodianAccountId: 'account', serverId: 'home', machineId: 'machine', serverHttpBaseUrl: base,
      isTrackedCurrent: () => true, ...(usage ? { usage } : {}) },
    async (_callRpc, access) => ({ mode: access.accountEncryptionMode, sessionId: access.rawSession.id }));
    try {
      await runWithServerHttpBaseUrl(base, async () => { await holder.read(); });
      const witnessesBefore = count('/v1/account/encryption/currentness');
      for (let index = 0; index < 3; index += 1) {
        await expect(run('read')).resolves.toEqual({ mode: 'plain', sessionId });
      }
      expect(count('/v1/account/encryption/currentness') - witnessesBefore).toBe(0);
      expect(count(`/v2/sessions/${sessionId}`)).toBe(3);
      await expect(run()).resolves.toEqual({ mode: 'plain', sessionId });
      expect(count('/v1/account/encryption/currentness') - witnessesBefore).toBe(1);
    } finally {
      await holder.dispose();
      await channel.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
