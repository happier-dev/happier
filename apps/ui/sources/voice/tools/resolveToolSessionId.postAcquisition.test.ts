import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { resolveToolSessionAddress } = await import('./resolveToolSessionId');
const initialState = storage.getState();
afterEach(() => storage.setState(initialState, true));

describe('resolveToolSessionAddress after an off-list acquisition', () => {
    it('resolves a bare id against rows actually fetched and hydrated by the admitted Home list owner', async () => {
        let publishFreshSession = false;
        const rows = createSessionListSourceFixture({
            sessions: [{
                id: 'fresh-session', seq: 0, createdAt: 1, updatedAt: 20, active: true, activeAt: 20,
                encryptionMode: 'plain', metadata: JSON.stringify({ path: '/repo', host: 'test', summary: { text: 'Fresh', updatedAt: 20 } }),
                metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
            }],
            hasNext: false, nextCursor: null,
        });
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://voice-fresh-corpus.test', accountId: 'voice-corpus-account', credentialScope: 'restored-home',
            request: async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json(
                    publishFreshSession ? rows : createSessionListSourceFixture({ sessions: [], hasNext: false, nextCursor: null }));
                return null;
            },
        });
        try {
            storage.setState({
                sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
                sessionListIndexByServerId: {}, socketStatus: 'connected',
            });
            publishFreshSession = true;
            expect(storage.getState().sessionListRowsByServerId[connection.home.id]?.['fresh-session']).toBeUndefined();
            await expect(resolveToolSessionAddress({ explicitSessionId: 'fresh-session' }))
                .resolves.toEqual({ serverId: connection.home.id, sessionId: 'fresh-session' });
            expect(storage.getState().sessionListRowsByServerId[connection.home.id]?.['fresh-session']?.metadata?.summaryText).toBe('Fresh');
            expect(storage.getState().ordinarySessionListMembershipByServerId[connection.home.id] ?? []).toEqual([]);
        } finally { await connection.dispose(); }
    });
});
