import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import type { SharedWorkspaceTabs } from './workspaceSyncedTabs';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';

// Expo is the navigator boundary; the workspace owner, Account sync and KV transport stay real.
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => '/', params: () => ({}) }).module);

// Only HTTP, Socket.IO and OS credential custody are replaced.
const homes = await createConcurrentCacheNetworkHarness('workspace-shared-tabs-delivery');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { dispatchKvBatchUpdate } = await import('@/sync/engine/socket/kvUpdateDispatcher');
const { resolveCompactAppDestinations } = await import('../destinations/compactAppDestinationCatalog');
const { WorkspaceProvider } = await import('./WorkspaceProvider');
const { useOptionalWorkspaceNavigation } = await import('./WorkspaceNavigationContext');

const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, inbox: false, friends: false, externalSessions: false } });
const sharedRecord = (pageId: string): SharedWorkspaceTabs => ({ v: 1,
    tabsById: { peer: { id: 'peer', target: { kind: 'settings', params: { pageId } }, pinned: true } }, order: ['peer'], pairs: [] });

const published: WorkspaceNavigationContextValue[] = [];
function NavigationConsumer() {
    const navigation = useOptionalWorkspaceNavigation();
    if (navigation) published.push(navigation);
    return null;
}

describe('workspace navigation delivery of shared tab records', () => {
    beforeEach(async () => { published.length = 0; await homes.reset(); await homes.startFocused(); });
    afterEach(async () => { await standardCleanup(); await homes.cleanup(); });
    afterAll(async () => { await homes.dispose(); });

    it('keeps the navigation value when a peer record leaves this window unchanged', async () => {
        const credentials = { token: homes.homeA.token };
        let stored = sharedRecord('appearance');
        let version = 1;
        let reads = 0;
        const keyPath = '/v1/kv/bulk';
        homes.setResponder(async input => {
            if (new URL(String(input)).pathname !== keyPath) return null;
            reads++;
            return Response.json({ values: [{ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: stored }), version }] });
        });
        await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <WorkspaceProvider enabled catalog={catalog}><NavigationConsumer /></WorkspaceProvider>
        </InjectedAuthProvider>);
        const latest = () => published[published.length - 1];
        await vi.waitFor(() => {
            expect(latest()?.state.tabs.peer?.target.params.pageId).toBe('appearance');
            expect(latest()?.tabSyncStatus).toBe('synced');
        });
        const settled = latest();
        const settledCommits = published.length;

        // Another window navigates inside the shared tab. This window keeps its mounted destination.
        stored = sharedRecord('account'); version++;
        const readsBefore = reads;
        await act(async () => { await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version }] },
            credentials, shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } }); });
        await vi.waitFor(() => expect(reads).toBe(readsBefore + 1));
        await act(async () => {});

        expect(latest().state).toBe(settled.state);
        expect(latest()).toBe(settled);
        expect(published).toHaveLength(settledCommits);
    });
});
