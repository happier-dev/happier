import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { MEMORY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from '@happier-dev/protocol';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { Message } from '@happier-dev/session-core/messages';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { useSessionRecap } from '@/components/sessions/companion/summary/useSessionRecap';
import { getAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { observeSessionSynopses } from './sessionSynopsis';

installDisconnectedServerSocketBoundary();

afterEach(() => { standardCleanup(); resetServerFeaturesClientForTests(); });

describe('Recap synopsis Account lifetime', () => {
    it.each([
        { transition: 'lifetime_retirement', hasSynopsis: true }, { transition: 'lifetime_retirement', hasSynopsis: false },
        { transition: 'same_credential_refresh', hasSynopsis: true }, { transition: 'same_credential_refresh', hasSynopsis: false },
        { transition: 'account_switch', hasSynopsis: true }, { transition: 'account_switch', hasSynopsis: false },
        { transition: 'runtime_retirement', hasSynopsis: true }, { transition: 'runtime_retirement', hasSynopsis: false },
    ] as const)('preserves Account currentness on $transition with synopsis: $hasSynopsis', async ({ transition, hasSynopsis }) => {
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
                if (path.endsWith('/system-records')) return Response.json({ records: hasSynopsis ? [{
                    id: 'synopsis-record', address: { owner: 'host', namespace: SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE,
                        kind: MEMORY_SESSION_SYSTEM_RECORD_KINDS[1], localId: 'latest' },
                    content: { t: 'plain', v: synopsis }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
                }] : [], nextCursor: null, hasNext: false });
                return new Response(null, { status: 404 });
            },
        });
        onTestFinished(connection.dispose);
        storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'alice' });
        const workerUpdate: Message = { kind: 'agent-event', id: 'worker-update', localId: null, seq: 1, createdAt: 1,
            event: { type: 'worker-update', update: { v: 1, workerKind: 'session', workerId: 'cworker0000000000000000000',
                ownerState: 'settled', wake: 'finished', headline: 'Alice private worker report', canInspect: true } } };
        const retainedTranscript = createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: [workerUpdate.id], messagesById: { [workerUpdate.id]: workerUpdate } });
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId: connection.home.id, owner: 'alice' }) },
            sessionMessages: { lead: retainedTranscript } });
        const hook = await renderHook(() => useSessionRecap({ serverId: connection.home.id, sessionId: 'lead' }));
        await vi.waitFor(() => expect(hook.getCurrent()?.text).toBe(hasSynopsis ? synopsis.synopsis : 'Alice private worker report'));
        const beforeLifetime = captureActiveServerAccountScopeLifetime();
        await act(async () => {
            if (transition === 'same_credential_refresh') {
                expect(await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id }, connection.credentials)).toBe(true);
            } else if (transition === 'lifetime_retirement') {
                // Exercise the real boundary used by connection resets, retaining both inputs.
                // A same-token persistence write only retires the System Record repository.
                retireActiveServerAccountScopeLifetime();
            } else if (transition === 'runtime_retirement') publishAppliedActiveServerRuntimeAvailability(false);
            else storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'bob' });
        });
        if (transition === 'same_credential_refresh') {
            expect(beforeLifetime?.isCurrent()).toBe(true);
            expect(hook.getCurrent()).toMatchObject({ source: 'worker_update', text: 'Alice private worker report' });
            return;
        }
        expect(beforeLifetime?.isCurrent()).toBe(false);
        expect(storage.getState().sessionMessages.lead).toBe(retainedTranscript);
        expect(hook.getCurrent()).toBeNull();
        if (transition === 'runtime_retirement') {
            synopsis = { v: 1, seqTo: 3, updatedAtMs: 3, synopsis: 'Recovered synopsis' };
            await act(async () => {
                publishAppliedActiveServerRuntimeAvailability(true);
                // Recovery hydrates transcript input in the newly established lifetime.
                storage.setState({ sessionMessages: { lead: createSessionMessagesFixture({ ...retainedTranscript }) } });
            });
            await vi.waitFor(() => expect(hook.getCurrent()?.text).toBe(hasSynopsis ? synopsis.synopsis : 'Alice private worker report'));
            await hook.unmount();
            const recovered = await renderHook(() => useSessionRecap({ serverId: connection.home.id, sessionId: 'lead' }));
            await vi.waitFor(() => expect(recovered.getCurrent()?.text).toBe(hasSynopsis ? synopsis.synopsis : 'Alice private worker report'));
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
            if (hasSynopsis) await vi.waitFor(() => expect(backgroundText).toBe(synopsis.synopsis));
            const background = await renderHook(() => useSessionRecap({ serverId: connection.home.id, sessionId: 'lead' }));
            await vi.waitFor(() => expect(background.getCurrent()?.text).toBe(hasSynopsis ? synopsis.synopsis : 'Alice private worker report'));
        }
    });
});
