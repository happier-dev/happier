import 'fake-indexeddb/auto';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

let disposeHome: (() => Promise<void>) | undefined;
let releaseConsumer: (() => void) | undefined;
let server: Server | undefined;
let releaseHeldRead: (() => void) | undefined;
let releaseAuthority: (() => Promise<void>) | undefined;
afterEach(async () => {
    releaseHeldRead?.(); releaseHeldRead = undefined;
    await releaseAuthority?.(); releaseAuthority = undefined;
    releaseConsumer?.(); releaseConsumer = undefined;
    await disposeHome?.(); disposeHome = undefined;
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
});

it.each([false, true])('converges a consumed Session to canonical idle after a real transport gap (older read held: %s)', async held => {
    const http = createServer();
    server = new Server(http, { path: '/v1/updates' });
    let declarations = 0;
    server.on('connection', socket => {
        socket.on('session-consumption-replace', (declaration, acknowledge) => {
            declarations += 1;
            acknowledge({ ok: true, ...declaration });
        });
        socket.on('session-human-presence:visible-replace', (_declaration, acknowledge) =>
            acknowledge({ ok: true, v: 1 }));
        socket.on('ping', acknowledge => acknowledge({ ok: true }));
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const now = Date.now();
    let session = SessionCurrentProjectionRecordV1Schema.parse({
        ...createPlainSessionCurrentProjectionRecordFixture({ id: 'reconnect-session', active: true, activeAt: now }),
        thinking: true, thinkingAt: now, runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: now, runtimeActivityRevision: 1 });
    let exactReads = 0;
    let holdNextRead = false;
    const home = await restoreServerAccountForTest({ serverUrl, accountId: 'reconnect-account', request: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === `/v2/sessions/${session.id}`) {
            exactReads += 1;
            const response = Response.json({ session });
            if (holdNextRead) {
                holdNextRead = false;
                await new Promise<void>(resolve => { releaseHeldRead = resolve; });
            }
            return response;
        }
        if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/active') {
            return Response.json({ sessions: [session], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
        }
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
        return createEmptyAccountBootstrapHttpResponse(url.pathname, init);
    } });
    disposeHome = home.dispose;
    const { storage } = await import('@/sync/domains/state/storage');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
    releaseConsumer = registerSessionRealtimeTranscriptConsumer(session.id, home.serverId);
    await vi.waitFor(() => expect(storage.getState().sessions[session.id]?.runtimeActivityState).toBe('active'));
    await vi.waitFor(() => expect(exactReads).toBeGreaterThan(0));
    const { sync } = await import('@/sync/sync');
    const { captureServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const authority = await captureServerRequestAuthorityForServerAccountScope({ serverId: home.serverId, activeRequest: apiSocket.request.bind(apiSocket) });
    releaseAuthority = async () => { await authority.release(); };
    await sync.ensureSessionVisibleForMessageRoute(session.id, { serverId: home.serverId,
        forceRefresh: true, hydrateMessages: false, includeTurnsProjection: false, authority });
    let pendingRead: Promise<unknown> | undefined;
    if (held) {
        holdNextRead = true;
        pendingRead = sync.ensureSessionVisibleForMessageRoute(session.id, { serverId: home.serverId,
            forceRefresh: true, hydrateMessages: false, includeTurnsProjection: false, authority });
        await vi.waitFor(() => expect(releaseHeldRead).toBeTypeOf('function'));
    }
    const before = apiSocket.getSocketId();
    const socket = server.sockets.sockets.get(before);
    if (!socket) throw new Error('Missing connected Account socket');
    session = SessionCurrentProjectionRecordV1Schema.parse({ ...session,
        thinking: false, thinkingAt: now + 1, runtimeActivityState: 'idle', runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: now + 1, runtimeActivityRevision: 2 });
    // The idle transition is missed during transport loss. No durable change-feed
    // row or subsequent heartbeat is supplied to rescue the stale client.
    socket.conn.close();
    await vi.waitFor(() => expect(apiSocket.getSocketId()).not.toBe(before), { timeout: 10_000 });
    await vi.waitFor(() => expect(storage.getState().socketStatus).toBe('connected'), { timeout: 10_000 });
    await vi.waitFor(() => expect(storage.getState().sessions[session.id]?.runtimeActivityState).toBe('idle'), { timeout: 10_000 });
    expect(storage.getState().sessions[session.id]?.thinking).toBe(false);
    expect(declarations).toBeGreaterThanOrEqual(2);
    releaseHeldRead?.(); releaseHeldRead = undefined;
    await pendingRead;
    await releaseAuthority(); releaseAuthority = undefined;
    expect(storage.getState().sessions[session.id]?.runtimeActivityState).toBe('idle');
});
