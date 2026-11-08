import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { encodeBase64StoredJsonContentEnvelope, decodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import type { CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import type { SharedWorkspaceTabs } from './workspaceSyncedTabs';

// Only HTTP, Socket.IO and OS credential custody are replaced. The hook,
// authenticated Home/Sync owner, Account observation and KV transport stay real.
const homes = await createConcurrentCacheNetworkHarness('workspace-tab-observation');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { useWorkspaceState } = await import('./useWorkspaceState');
const { useWorkspaceTabSync } = await import('./useWorkspaceTabSync');
const { ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS } = await import('@/sync/engine/pending/pendingSettings');
const { dispatchKvBatchUpdate } = await import('@/sync/engine/socket/kvUpdateDispatcher');

const initialTab = { id: 'placeholder', target: { kind: 'newTab', params: {} }, pinned: false, preview: true };
const noDestinations: readonly CompactAppDestination[] = [];
const workflows: readonly CompactAppDestination[] = [{ id: 'workflows', kind: 'builtin', title: 'Workflows',
    icon: 'tree-structure', order: 40, placement: { kind: 'rail', region: 'app' }, activation: 'navigate',
    availability: 'available', routePath: '/workflows' }];
const sharedRecord = (id: string): SharedWorkspaceTabs => ({ v: 1,
    tabsById: { [id]: { id, target: { kind: 'settings', params: { pageId: id } }, pinned: false } }, order: [id], pairs: [] });

function Probe({ catalog }: Readonly<{ catalog: readonly CompactAppDestination[] }>) {
    const local = useWorkspaceState({ initialTab, windowId: 'observation-window' });
    const owner = useWorkspaceTabSync({ local, enabled: true, catalog });
    return React.createElement('WorkspaceOwner', { owner });
}

describe('workspace tab sync observed Account request', () => {
    beforeEach(async () => { await homes.reset(); await homes.startFocused(); });
    afterEach(async () => { vi.useRealTimers(); await standardCleanup(); await homes.cleanup(); });
    afterAll(async () => { await homes.dispose(); });

    it('borrows the warm Home observation for mount, policy and KV refreshes but keeps sealing fresh', async () => {
        const credentials = { token: homes.homeA.token };
        const observation = apiSocket.getAccountEncryptionObservationBinding(credentials);
        if (!observation) throw new Error('Expected the production authenticated Home observation');
        await vi.waitFor(() => expect(observation.peek()?.mode).toBe('plain'));
        let stored = sharedRecord('remote');
        let version = 1;
        const writes: SharedWorkspaceTabs[] = [];
        const keyPath = '/v1/kv/bulk';
        const isWorkspaceRead = (init?: RequestInit) => (JSON.parse(String(init?.body)) as { keys: string[] }).keys.includes('workspace:tabs:v1');
        const workspaceReads = () => homes.requests(keyPath).filter(request => isWorkspaceRead(request.init));
        homes.setResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === keyPath && isWorkspaceRead(init)) return Response.json({ values: [{ key: 'workspace:tabs:v1',
                value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: stored }), version }] });
            if (path === '/v1/kv' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as { mutations: { key: string; value: string; version: number }[] };
                const mutation = body.mutations[0];
                expect(mutation.key).toBe('workspace:tabs:v1');
                expect(mutation.version).toBe(version);
                const envelope = decodeBase64StoredJsonContentEnvelope(mutation.value);
                if (envelope?.t !== 'plain') throw new Error('Expected the plain Account envelope');
                stored = envelope.v as SharedWorkspaceTabs;
                writes.push(stored);
                return Response.json({ success: true, results: [{ key: mutation.key, version: ++version }] });
            }
            return null;
        });
        const trustReads = () => homes.requests('/v1/account/encryption/currentness').length
            + homes.requests('/v1/account/encryption').length;
        const before = trustReads();
        const render = (catalog: readonly CompactAppDestination[]) => <InjectedAuthProvider credentials={credentials}>
            <Probe catalog={catalog} />
        </InjectedAuthProvider>;
        const screen = await renderScreen(render(noDestinations));
        const owner = () => screen.root.findByType('WorkspaceOwner').props.owner as ReturnType<typeof useWorkspaceTabSync>;
        await vi.waitFor(() => expect(owner().sharedTabs?.order).toEqual(['remote']));
        expect(workspaceReads()).toHaveLength(1);
        expect(trustReads() - before).toBe(0);
        expect(writes).toEqual([]);

        await screen.update(render(workflows));
        await vi.waitFor(() => expect(workspaceReads()).toHaveLength(2));
        await vi.waitFor(() => expect(owner().tabSyncStatus).toBe('synced'));
        expect(trustReads() - before).toBe(0);

        stored = sharedRecord('peer'); version++;
        await act(async () => { await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version }] },
            credentials, shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } }); });
        await vi.waitFor(() => expect(owner().sharedTabs?.order).toEqual(['peer']));
        expect(workspaceReads()).toHaveLength(3);
        expect(trustReads() - before).toBe(0);

        vi.useFakeTimers();
        act(() => owner().dispatch({ type: 'setPinned', tabId: 'peer', pinned: true }));
        await act(async () => { await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS); });
        expect(writes).toHaveLength(1);
        expect(writes[0].tabsById.peer.pinned).toBe(true);
        expect(trustReads() - before).toBe(1);
        vi.useRealTimers();

        // Retiring the captured Home must not borrow a successor observation or
        // keep refreshing its old KV subscription after the runtime changes.
        await act(async () => { await homes.profiles.setActiveServerId(homes.homeB.id, { scope: 'device' }); });
        const retiredReads = workspaceReads().length;
        await act(async () => { await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version: ++version }] },
            credentials, shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } }); });
        expect(workspaceReads()).toHaveLength(retiredReads);
        expect(owner().sharedTabs).toBeNull();
        await screen.unmount();
    });
});
