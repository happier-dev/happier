import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { MEMORY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from '@happier-dev/protocol';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { useSessionRecap } from '@/components/sessions/companion/summary/useSessionRecap';
import { getAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { observeSessionSynopses } from './sessionSynopsis';

installDisconnectedServerSocketBoundary();

afterEach(() => { standardCleanup(); resetServerFeaturesClientForTests(); });

describe('Recap synopsis Account lifetime', () => {
    it.each(['credential_retirement', 'account_switch', 'runtime_retirement'] as const)('discards an already delivered synopsis on %s at the same Session address', async (transition) => {
        await loadSyncSingletonForTests();
        const initial = storage.getState();
        onTestFinished(() => storage.setState(initial, true));
        let synopsis = { v: 1 as const, seqTo: 2, updatedAtMs: 2, synopsis: 'Alice private synopsis' };
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://synopsis-lifetime.example.test', accountId: 'alice',
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json({ features: {}, capabilities: { session: { systemRecords: { protocolVersions: [1] } } } });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                if (path.endsWith('/system-records')) return Response.json({ records: [{
                    id: 'synopsis-record', address: { owner: 'host', namespace: SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE,
                        kind: MEMORY_SESSION_SYSTEM_RECORD_KINDS[1], localId: 'latest' },
                    content: { t: 'plain', v: synopsis }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
                }], nextCursor: null, hasNext: false });
                return new Response(null, { status: 404 });
            },
        });
        onTestFinished(connection.dispose);
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'alice' });
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId: connection.home.id, owner: 'alice' }) } });
        const hook = await renderHook(() => useSessionRecap({ serverId: connection.home.id, sessionId: 'lead' }));
        await vi.waitFor(() => expect(hook.getCurrent()?.text).toBe(synopsis.synopsis));
        await act(async () => {
            if (transition === 'credential_retirement') {
                await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id }, connection.credentials);
            } else if (transition === 'runtime_retirement') publishAppliedActiveServerRuntimeAvailability(false);
            else storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'bob' });
        });
        expect(hook.getCurrent()).toBeNull();
        if (transition === 'runtime_retirement') {
            synopsis = { v: 1, seqTo: 3, updatedAtMs: 3, synopsis: 'Recovered synopsis' };
            await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
            await vi.waitFor(() => expect(hook.getCurrent()?.text).toBe(synopsis.synopsis));
            const appliedHome = getAppliedActiveServerSnapshot();
            onTestFinished(() => publishAppliedActiveServerSnapshot(appliedHome));
            await act(async () => {
                publishAppliedActiveServerSnapshot({ serverId: 'other-home', serverUrl: 'https://other-home.example.test', generation: appliedHome.generation + 1 }, false);
            });
            // A new exact-Home observer is still admitted when that Home really
            // is background, even with no available focused Account lifetime.
            let backgroundText: string | undefined;
            const stop = observeSessionSynopses({
                session: { serverId: connection.home.id, sessionId: 'lead' },
                onChange: (synopses) => { backgroundText = synopses[0]?.synopsis; },
            });
            onTestFinished(stop);
            await vi.waitFor(() => expect(backgroundText).toBe(synopsis.synopsis));
        }
    });
});
