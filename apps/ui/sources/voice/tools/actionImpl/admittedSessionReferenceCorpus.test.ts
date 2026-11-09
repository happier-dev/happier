import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const sockets = new Map<string, Socket>();
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    if (serverUrl) sockets.set(new URL(serverUrl).origin, socket);
    configureConnectedServerSocketBoundary(socket);
});
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
const { isSessionListQueryHomeOnline, resolveOrdinarySessionListHomeOwner } = await import('@/sync/domains/session/listing/sessionListQueryRuntime');
const { resetSessionListPaneRetentionForTests } = await import('@/components/sessions/shell/sessionListPaneRetention');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { acquireAdmittedSessionReferenceCorpusOptions } = await import('./admittedSessionReferenceCorpus');
const initialState = storage.getState();
const initialConcurrentFlag = process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
const NO_ORDINARY_MEMBERSHIP = { ordinarySessionListMembershipByServerId: {} } as const;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

function page(sessionId: string, options: { hasNext?: boolean; metadataUpgradeRequiredCount?: number } = {}) {
    return createSessionListSourceFixture({
        sessions: [{
            id: sessionId, seq: 0, createdAt: 1, updatedAt: 2, active: true, activeAt: 2,
            encryptionMode: 'plain', metadata: JSON.stringify({ path: '/repo', host: 'test' }), metadataVersion: 1,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        }],
        hasNext: options.hasNext ?? false, nextCursor: options.hasNext ? 'next' : null,
        ...(options.metadataUpgradeRequiredCount !== undefined ? { metadataUpgradeRequiredCount: options.metadataUpgradeRequiredCount } : {}),
    });
}

async function arrangeHomes(twoMounted = true) {
    const a = await home.addHome({ name: 'A', serverUrl: 'https://voice-corpus-a.test', accountId: 'account-a' });
    const b = await home.addHome({ name: 'B', serverUrl: 'https://voice-corpus-b.test', accountId: 'account-b', active: false });
    home.answer(a, '/v2/sessions', { body: createSessionListSourceFixture({ sessions: [], hasNext: false }) });
    home.answer(b, '/v2/sessions', { body: createSessionListSourceFixture({ sessions: [], hasNext: false }) });
    for (const serverId of [a, b]) home.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://voice-corpus-a.test', accountId: 'account-a',
        request: async (url, init) => home.request(url, init),
    });
    installHomeGovernanceBoundaries(home);
    // The real secondary reachability owner probes the same network port as
    // Account restoration, which otherwise admits only the restored Home.
    setRuntimeFetch(home.request);
    storage.setState({ socketStatus: 'connected' });
    startConcurrentSessionCacheSync();
    await home.selectHomes(twoMounted ? [a, b] : [a]);
    if (twoMounted) await waitForHomeGovernance(() => {
        expect(resolveOrdinarySessionListHomeOwner(b)).toBe('concurrent');
        expect(isSessionListQueryHomeOnline(b)).toBe(true);
    });
    return { a, b };
}

beforeEach(async () => {
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
    await home.reset();
    storage.setState(initialState, true);
    resetSessionListPaneRetentionForTests();
});
afterEach(async () => {
    stopConcurrentSessionCacheSync();
    await connection?.dispose();
    connection = undefined;
    await home.reset();
    sockets.clear();
    if (initialConcurrentFlag === undefined) delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
    else process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = initialConcurrentFlag;
    storage.setState(initialState, true);
});

describe('acquireAdmittedSessionReferenceCorpusOptions', () => {
    it('acquires the authorized corpus through real row-only Home list reads when no pane owns one', async () => {
        const { a, b } = await arrangeHomes();
        home.answer(a, '/v2/sessions', { body: page('s-alpha') });
        home.answer(b, '/v2/sessions', { body: page('s-beta') });
        const ordinaryMembershipBefore = structuredClone(storage.getState().ordinarySessionListMembershipByServerId);
        const corpus = await acquireAdmittedSessionReferenceCorpusOptions(NO_ORDINARY_MEMBERSHIP);
        expect(corpus).toEqual({ knownServerIds: [a, b], coverage: 'complete', addresses: [
            { serverId: a, sessionId: 's-alpha' }, { serverId: b, sessionId: 's-beta' },
        ] });
        expect(storage.getState().sessionListRowsByServerId[a]?.['s-alpha']).toBeDefined();
        expect(storage.getState().sessionListRowsByServerId[b]?.['s-beta']).toBeDefined();
        expect(storage.getState().ordinarySessionListMembershipByServerId).toEqual(ordinaryMembershipBefore);
    });
    it('reports incomplete coverage when a mounted Home read fails or another Home has more pages', async () => {
        const { a, b } = await arrangeHomes();
        home.answer(a, '/v2/sessions', { body: page('s-alpha', { hasNext: true }) });
        home.answer(b, '/v2/sessions', { status: 503, body: {} });
        await expect(acquireAdmittedSessionReferenceCorpusOptions(NO_ORDINARY_MEMBERSHIP)).resolves.toMatchObject({
            coverage: 'incomplete', addresses: [{ serverId: a, sessionId: 's-alpha' }],
        });
    });
    it('does not read an offline Home and reports no corpus when none is reachable', async () => {
        await arrangeHomes(false);
        storage.setState({ socketStatus: 'disconnected' });
        const readsBefore = home.requestsFor('/v2/sessions').length;
        await expect(acquireAdmittedSessionReferenceCorpusOptions(NO_ORDINARY_MEMBERSHIP)).resolves.toBeNull();
        expect(home.requestsFor('/v2/sessions')).toHaveLength(readsBefore);
    });
    it('keeps an offline mounted Home in the corpus as uncovered instead of dropping it', async () => {
        const { a, b } = await arrangeHomes();
        home.answer(a, '/v2/sessions', { body: page('deploy') });
        const socket = sockets.get('https://voice-corpus-b.test');
        if (!socket) throw new Error('Mounted Home Socket boundary missing');
        // A client-requested disconnect is intentional and does not prove the
        // Home is offline. Deliver the lost transport plus failed health probe.
        home.answer(b, '/health', { status: 503, body: {} });
        home.answer(b, '/v1/auth/ping', { status: 503, body: {} });
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('transport close');
        await waitForHomeGovernance(() => expect(isSessionListQueryHomeOnline(b)).toBe(false));
        expect(resolveOrdinarySessionListHomeOwner(b)).toBe('concurrent');
        await expect(acquireAdmittedSessionReferenceCorpusOptions(NO_ORDINARY_MEMBERSHIP)).resolves.toEqual({
            knownServerIds: [a, b], coverage: 'incomplete', addresses: [{ serverId: a, sessionId: 'deploy' }],
        });
    });
    it('does not count a saved Home that no runtime mounts', async () => {
        const { a, b } = await arrangeHomes(false);
        home.answer(a, '/v2/sessions', { body: page('deploy') });
        expect(resolveOrdinarySessionListHomeOwner(b)).toBeNull();
        await expect(acquireAdmittedSessionReferenceCorpusOptions(NO_ORDINARY_MEMBERSHIP)).resolves.toEqual({
            knownServerIds: [a], coverage: 'complete', addresses: [{ serverId: a, sessionId: 'deploy' }],
        });
    });
    it('reports incomplete coverage when a Home withholds historical rows pending the owner upgrade', async () => {
        const { a } = await arrangeHomes(false);
        home.answer(a, '/v2/sessions', { body: page('deploy', { metadataUpgradeRequiredCount: 1 }) });
        await expect(acquireAdmittedSessionReferenceCorpusOptions(NO_ORDINARY_MEMBERSHIP)).resolves.toMatchObject({ coverage: 'incomplete' });
    });
});
