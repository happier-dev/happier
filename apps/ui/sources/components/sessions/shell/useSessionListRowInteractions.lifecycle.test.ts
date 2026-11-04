import { act } from 'react-test-renderer';
import { SessionManagerOptionsV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import * as React from 'react';
import * as Reanimated from 'react-native-reanimated';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { buildSessionSectionGroupKey } from '@/sync/domains/session/organization/sections';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListRowInteractions, type UseSessionListRowInteractionsInput } from './useSessionListRowInteractions';
import { treeRowId } from './drop-resolution/treeRowId';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    SessionListAttentionInteractionContext,
    useSessionListAttentionInteractionHeld,
    useSessionListAttentionInteractionOwner,
} from './useSessionListAttentionInteraction';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let previousState: ReturnType<ReturnType<typeof getStorage>['getState']>;

const scope = { serverId: 'srv_lifecycle_home', accountId: 'lifecycle-account' };
const workspace = { t: 'workspaceScope', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo' } as const;
const items: SessionListIndexItem[] = [
    { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project', workspaceKey: 'project', workspace, serverId: scope.serverId },
    { type: 'session', sessionId: 'source', serverId: scope.serverId, storageKind: 'persisted', groupKey: 'project', groupKind: 'project', folderId: null, folderDepth: 0, workspace },
];
const sessionKey = sessionAddressKey({ serverId: scope.serverId, sessionId: 'source' });
const sourceRowId = treeRowId.session(scope.serverId, 'source');

function input(): UseSessionListRowInteractionsInput {
    return { folderActionsEnabled: true, isFolderActionsEnabledForServerId: () => true,
        listItems: items, currentGroupOrderMap: {}, currentWorkspaceOrderMap: {},
        sessionSections: [], sessionListLayoutV1: 'projects', manualSessionOrderingEnabled: true,
        setSessionListGroupOrderV1: vi.fn(async () => {}), setSessionWorkspaceOrderV1: vi.fn(async () => {}),
        pinnedKeySet: new Set(), sessionTags: {}, setSessionPinForKey: vi.fn(), setSessionTagsForKey: vi.fn() };
}

async function renderInteractions(
    initialProps = input(),
    wrapper?: React.ComponentType<React.PropsWithChildren>,
) {
    const hook = await renderHook((props: UseSessionListRowInteractionsInput) => {
        const bindings = useServerCredentialAccountScopeBindings([scope.serverId]);
        return { ...useSessionListRowInteractions(props), sourceBinding: bindings.get(scope.serverId) };
    }, { initialProps, wrapper });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sourceBinding?.isCurrent()).toBe(true));
    return hook;
}

describe('Session list canonical carry retirement', () => {
    beforeEach(async () => {
        previousState = getStorage().getState();
        await home.reset();
        const serverUrl = 'https://lifecycle-home.example.test';
        const homeId = await home.addHome({ name: 'Lifecycle Home', serverUrl, serverIdentityId: scope.serverId, accountId: scope.accountId, active: false });
        for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/session-organization']) {
            const response = createEmptyAccountBootstrapHttpResponse(path);
            if (!response) throw new Error('Missing canonical bootstrap response');
            home.answer(homeId, path, { body: await response.json() });
        }
        home.answer(homeId, '/v1/sessions/source/manager/options', {
            body: SessionManagerOptionsV1Schema.parse({ sessionId: 'source', currentManagerSessionId: null, candidates: [] }),
        });
        connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: scope.serverId, accountId: scope.accountId, request: home.request });
        await waitForHomeGovernance(() => expect(getStorage().getState().profileScope).toEqual(scope));
    });
    afterEach(async () => {
        standardCleanup();
        await connection?.dispose();
        await home.reset();
        getStorage().setState(previousState, true);
    });

    it('uses scroll-event content metrics for a bounded edge carry and stops it on cancellation', async () => {
        // Reanimated's UI-thread scheduler is the boundary: keep the real
        // mounted list, carry admission and autoscroll calculation beneath it.
        let readNextOffset: () => unknown = () => undefined;
        const reaction = vi.spyOn(Reanimated, 'useAnimatedReaction').mockImplementation((prepare) => {
            readNextOffset = prepare;
        });
        const groupKey = buildSessionSectionGroupKey({ serverId: scope.serverId, sectionId: 'payments' });
        const folder: SessionListIndexItem = { type: 'header', headerKind: 'folder', title: 'Payments',
            folderId: 'payments', folderDepth: 0, groupKey, serverId: scope.serverId, workspace };
        const hook = await renderInteractions({ ...input(), listItems: [folder, ...items],
            sessionSections: [{ address: { serverId: scope.serverId, sectionId: 'payments' },
                display: { status: 'available', value: { name: 'Payments', icon: null } }, sortKey: null }] });
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 100, 300, 400) });
                hook.getCurrent().handleTreeScroll({ nativeEvent: { contentOffset: { y: 250 }, contentSize: { height: 1000 } } });
                hook.getCurrent().registerTreeRowBounds(treeRowId.folder(scope.serverId, 'payments'),
                    { measureInWindow: callback => callback(0, 450, 300, 50) });
                hook.getCurrent().handleDragStart(sessionKey);
            });
            act(() => { hook.getCurrent().resolveDropResult({ sessionKey, groupKey, pointer: { x: 10, y: 475 } }); });
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission).toMatchObject({ status: 'allowed' });
            expect(readNextOffset()).toBeGreaterThan(250);
            expect(readNextOffset()).toBeLessThanOrEqual(600);
            act(() => hook.getCurrent().handleDragCancel());
            expect(readNextOffset()).toBeNull();
        } finally {
            await hook.unmount();
            reaction.mockRestore();
        }
    });

    it('does not re-render mounted drag consumers when the list receives unchanged inputs', async () => {
        let renders = 0;
        let bindingCurrent = false;
        const Row = React.memo(function Row(_props: { onDragStart: (key: string) => void }) {
            renders += 1;
            return null;
        });
        function List(props: { value: UseSessionListRowInteractionsInput }) {
            const bindings = useServerCredentialAccountScopeBindings([scope.serverId]);
            bindingCurrent = bindings.get(scope.serverId)?.isCurrent() === true;
            const interactions = useSessionListRowInteractions(props.value);
            return React.createElement(Row, { onDragStart: interactions.handleDragStart });
        }
        const value = input();
        const screen = await renderScreen(React.createElement(List, { value }));
        await waitForHomeGovernance(() => expect(bindingCurrent).toBe(true));
        const mounted = renders;
        await screen.update(React.createElement(List, { value: { ...value } }));
        expect(renders - mounted).toBe(0);
        await screen.unmount();
    });

    it('clears the lifted row and retires its source when the realm cancels externally', async () => {
        const interaction = await renderHook(() => {
            const controller = useSessionListAttentionInteractionOwner();
            return { controller, held: useSessionListAttentionInteractionHeld(controller) };
        });
        const Wrapper = ({ children }: React.PropsWithChildren) => React.createElement(
            SessionListAttentionInteractionContext.Provider, { value: interaction.getCurrent().controller }, children,
        );
        const hook = await renderInteractions(input(), Wrapper);
        const runtime = hook.getCurrent().entityDragDrop.runtime;
        act(() => { hook.getCurrent().handleDragStart(sessionKey); });
        expect(hook.getCurrent().draggingSessionKey).toBe(sessionKey);
        expect(interaction.getCurrent().held).toBe(true);
        const sourceId = runtime.getSnapshot().sourceId!;
        act(() => runtime.cancel('window-blur'));
        expect(hook.getCurrent().draggingSessionKey).toBeNull();
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        expect(interaction.getCurrent().held).toBe(false);
        expect(runtime.begin(sourceId)).toBeNull();
        await hook.unmount();
    });

    it('starts from current keyed topology after rows move and cancels without an organization write', async () => {
        const initial = input();
        const source = items[1];
        if (!source || source.type !== 'session') throw new Error('Expected the source Session fixture');
        const neighbor = { ...source, sessionId: 'neighbor' } satisfies SessionListIndexItem;
        const shiftedItems = [items[0]!, neighbor, source];
        const hook = await renderInteractions(initial);
        try {
            await hook.rerender({ ...initial, listItems: shiftedItems });
            act(() => { hook.getCurrent().handleDragStart(sessionKey); });
            const snapshot = hook.getCurrent().activeDragSnapshot;
            expect(snapshot?.source.sourceRowId).toBe(sourceRowId);
            expect(snapshot?.topology.rows.filter(row => row.kind === 'leaf').map(row => row.rowId))
                .toEqual([treeRowId.session(scope.serverId, 'neighbor'), sourceRowId]);
            act(() => { hook.getCurrent().handleDragCancel(); });
            expect(hook.getCurrent().activeDragSnapshot).toBeNull();
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
            expect(initial.setSessionListGroupOrderV1).not.toHaveBeenCalled();
            expect(initial.setSessionWorkspaceOrderV1).not.toHaveBeenCalled();

            await hook.rerender({ ...initial, listItems: [items[0]!, source, neighbor] });
            act(() => { hook.getCurrent().handleDragStart(sessionKey); });
            expect(hook.getCurrent().activeDragSnapshot?.topology.rows.filter(row => row.kind === 'leaf').map(row => row.rowId))
                .toEqual([sourceRowId, treeRowId.session(scope.serverId, 'neighbor')]);
            act(() => { hook.getCurrent().handleDragCancel(); });
        } finally {
            await hook.unmount();
        }
    });

    it('clears staged keyboard state on external cancellation and can pick up again', async () => {
        const hook = await renderInteractions();
        act(() => { expect(hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Source', key: ' ' })).toBe(true); });
        expect(hook.getCurrent().stagedMove.view.label).toBe('Source');
        act(() => hook.getCurrent().entityDragDrop.runtime.cancel('escape-layer'));
        expect(hook.getCurrent().stagedMove.view.label).toBeNull();
        act(() => { expect(hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Source', key: ' ' })).toBe(true); });
        expect(hook.getCurrent().stagedMove.view.label).toBe('Source');
        await hook.unmount();
    });

    it('retires a carry when its source leaves the current list or its mounted row retires', async () => {
        const initial = input();
        const hook = await renderInteractions(initial);
        act(() => { hook.getCurrent().handleDragStart(sessionKey); });
        await hook.rerender({ ...initial, listItems: [items[0]!] });
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        await hook.rerender(initial);
        act(() => { hook.getCurrent().handleDragStart(sessionKey); });
        act(() => hook.getCurrent().unregisterTreeRowBounds(sourceRowId));
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
        await hook.unmount();
    });

    it('retires pointer and staged carries on explicit view or scope changes, while arrivals keep the carry', async () => {
        const initial = { ...input(), presentationScopeKey: 'space-a' };
        const source = items[1];
        if (!source || source.type !== 'session') throw new Error('Expected the source Session fixture');
        const nextItems = [...items, { ...source, sessionId: 'arrival' }];
        const hook = await renderInteractions(initial);
        act(() => { hook.getCurrent().handleDragStart(sessionKey); });
        await hook.rerender({ ...initial, listItems: nextItems });
        expect(hook.getCurrent().activeDragSnapshot).not.toBeNull();

        const recent = { ...initial, listItems: nextItems, sessionListLayoutV1: 'recent_activity' as const };
        await hook.rerender(recent);
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');

        act(() => { expect(hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Source', key: ' ' })).toBe(true); });
        expect(hook.getCurrent().stagedMove.view.label).toBe('Source');
        await hook.rerender({ ...recent, presentationScopeKey: 'space-b' });
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        expect(hook.getCurrent().stagedMove.view.label).toBeNull();
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
        expect(initial.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
