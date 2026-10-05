import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';
import { buildSessionFolderGroupKey, DEFAULT_SESSION_FOLDERS_V1 } from '@/sync/domains/session/folders';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useSessionListRowInteractions,
    type UseSessionListRowInteractionsInput,
} from './useSessionListRowInteractions';
import { treeRowId } from './drop-resolution/treeRowId';
import { invokeSessionListOrganizationAction } from './drag/sessionListOrganizationAction';
import { getStorage } from '@/sync/domains/state/storage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { profileDefaults } from '@/sync/domains/profiles/profile';

installDisconnectedServerSocketBoundary();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({
    Easing: {
        bezier: () => () => 0,
        linear: () => 0,
    },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedReaction: vi.fn(),
}));

const ACTIVE_SCOPE = { serverId: 'server-a', accountId: 'account-a' } as const;
const MUTATION_SCOPE = {
    credentials: { token: createAccountTokenForTests(ACTIVE_SCOPE.accountId) },
    serverId: ACTIVE_SCOPE.serverId,
    serverIdAliases: ['profile-a', 'legacy-a'],
    serverUrl: 'https://server-a.example.test',
};
const boundary = vi.hoisted(() => ({ folderAssignment: vi.fn<typeof import('@/sync/api/session/sessionOrganizationApi').setSessionFolderAssignment>() }));
vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return { ...actual, setSessionFolderAssignment: boundary.folderAssignment };
});

describe('useSessionListRowInteractions', () => {
    beforeEach(() => {
        // The list answers drags and organization Actions for its mounted Home and Account only.
        getStorage().setState({ profileScope: ACTIVE_SCOPE } as never);
        boundary.folderAssignment.mockReset();
        boundary.folderAssignment.mockImplementation(async ({ sessionId, request }) => ({ sessionId, folderId: request.folderId }));
    });

    const workspace = {
        t: 'workspaceScope',
        serverId: 'server-a',
        machineId: 'machine-a',
        rootPath: '/repo/a',
    } as const;
    const listItems: SessionListIndexItem[] = [
        {
            type: 'header',
            title: 'Project A',
            headerKind: 'project',
            groupKey: 'project-a',
            workspaceKey: 'project-a',
            workspace,
            serverId: 'server-a',
        },
        {
            type: 'session',
            sessionId: 's1',
            serverId: 'server-a',
            storageKind: 'persisted',
            groupKey: 'project-a',
            groupKind: 'project',
            folderId: null,
            folderDepth: 0,
            workspace,
        },
    ];
    const twoSessionListItems: SessionListIndexItem[] = [
        listItems[0]!,
        listItems[1]!,
        {
            type: 'session',
            sessionId: 's2',
            serverId: 'server-a',
            storageKind: 'persisted',
            groupKey: 'project-a',
            groupKind: 'project',
            folderId: null,
            folderDepth: 0,
            workspace,
        },
    ];

    function buildInteractionsInput(overrides: Partial<UseSessionListRowInteractionsInput> = {}): UseSessionListRowInteractionsInput {
        return {
            folderActionsEnabled: true,
            isFolderActionsEnabledForServerId: () => true,
            sessionFoldersV1: DEFAULT_SESSION_FOLDERS_V1,
            listItems,
            currentGroupOrderMap: {},
            currentWorkspaceOrderMap: {},
            sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'activity',
            manualSessionOrderingEnabled: true,
            setSessionListGroupOrderV1: vi.fn(async () => {}),
            setSessionWorkspaceOrderV1: vi.fn(async () => {}),
            setSessionFoldersV1: vi.fn(async () => {}),
            pinnedKeySet: new Set(),
            setSessionPinForKey: vi.fn(),
            sessionTags: {},
            setSessionTagsForKey: vi.fn(),
            ...overrides,
        };
    }

    function renderInteractions(overrides: Partial<UseSessionListRowInteractionsInput> = {}) {
        return renderHook(() => useSessionListRowInteractions(buildInteractionsInput(overrides)));
    }

    it('keeps final native release geometry and source topology through asynchronous pre-dispatch measurement', async () => {
        await loadSyncSingletonForTests();
        const account = await restoreServerAccountForTest({ serverUrl: 'https://native-release.test', accountId: ACTIVE_SCOPE.accountId,
            credentials: { token: createAccountTokenForTests(ACTIVE_SCOPE.accountId) }, request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: ACTIVE_SCOPE.accountId });
                if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
                if (path === '/v1/artifacts') return Response.json([]);
                return Response.json({});
            } });
        const scope = { serverId: account.home.id, accountId: ACTIVE_SCOPE.accountId };
        getStorage().setState({ profileScope: scope } as never);
        const nativeItems = twoSessionListItems.map(item => ({ ...item, serverId: scope.serverId,
            workspace: { ...workspace, serverId: scope.serverId } }));
        const setOrder = vi.fn(async () => {});
        const initialInput = buildInteractionsInput({ listItems: nativeItems, setSessionListGroupOrderV1: setOrder });
        const hook = await renderHook(
            (input: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(input),
            { initialProps: initialInput },
        );
        const sessionKey = sessionAddressKey({ serverId: scope.serverId, sessionId: 's2' });
        let finishMeasurement = () => {};
        const { runtime } = hook.getCurrent().entityDragDrop;
        let releaseOutcome: unknown;
        const unsubscribe = runtime.subscribe(() => {
            if (runtime.getSnapshot().outcome) releaseOutcome = runtime.getSnapshot().outcome;
        });
        const retire = runtime.registerTarget({ id: 'native-neighbor', scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: 500, y: 0, width: 50, height: 50 }),
            measureBounds: () => new Promise<void>(resolve => { finishMeasurement = resolve; }),
            resolve: () => ({ status: 'refused', reason: { code: 'unavailable', message: 'Unavailable' } }),
            execute: async () => { throw new Error('The distant target must not own release'); } });
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 300) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(scope.serverId, 's1'),
                    { measureInWindow: callback => callback(0, 100, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(scope.serverId, 's2'),
                    { measureInWindow: callback => callback(0, 160, 300, 40) });
                hook.getCurrent().handleDragStart(sessionKey);
            });
            let completion: Promise<void> | undefined;
            act(() => {
                // useSessionInlineDrag resolves the final absolute coordinates before this callback.
                const resolved = hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a', dataIndex: 2,
                    pointer: { x: 10, y: 105 } });
                expect(runtime.getSnapshot().admission?.status).toBe('allowed');
                completion = hook.getCurrent().handleTreeDropResult({ sessionKey, groupKey: 'project-a', dataIndex: 2,
                    result: resolved.result });
            });
            expect(runtime.getPointer()).toEqual({ x: 10, y: 105 });
            expect(hook.getCurrent().activeDragSnapshot).not.toBeNull();
            expect(setOrder).not.toHaveBeenCalled();
            const sessionTemplate = nativeItems[2]!;
            if (sessionTemplate.type !== 'session') throw new Error('Expected a Session fixture');
            await hook.rerender({ ...initialInput, listItems: [...nativeItems, { ...sessionTemplate, sessionId: 's3' }] });
            await act(async () => { finishMeasurement(); await completion; });
            expect(releaseOutcome).toEqual({ status: 'applied' });
            const rootGroupKey = buildSessionFolderGroupKey({ serverId: scope.serverId,
                workspace: { ...workspace, serverId: scope.serverId }, folderId: null });
            expect(setOrder.mock.calls[0]?.[0]?.[rootGroupKey]).toEqual([
                sessionKey, sessionAddressKey({ serverId: scope.serverId, sessionId: 's1' }),
                sessionAddressKey({ serverId: scope.serverId, sessionId: 's3' }),
            ]);
            expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        } finally {
            finishMeasurement();
            retire();
            unsubscribe();
            await hook.unmount();
            await account.dispose();
        }
    });

    it('keeps chooser input traversal linear while equivalent and changed membership refresh semantic results', async () => {
        const template = twoSessionListItems[1]!;
        if (template.type !== 'session') throw new Error('Expected a Session fixture');
        const items: SessionListIndexItem[] = [listItems[0]!, ...Array.from({ length: 128 }, (_, index) => (
            { ...template, sessionId: `s${index + 1}` }
        ))];
        let itemReads = 0;
        // Measure real input traversal rather than mocking the tree builder or timing the host.
        const measuredItems = new Proxy(items, { get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) itemReads += 1;
            return Reflect.get(target, property, receiver);
        } });
        const initialInput = buildInteractionsInput({ listItems: measuredItems });
        const hook = await renderHook(
            (input: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(input),
            { initialProps: initialInput },
        );
        const { runtime } = hook.getCurrent().entityDragDrop;
        const retire = runtime.registerSource({ id: 'linear-chooser', scope: ACTIVE_SCOPE, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope: ACTIVE_SCOPE, address: { serverId: ACTIVE_SCOPE.serverId, sessionId: 's1' } }) });
        try {
            itemReads = 0;
            const destinations = runtime.getDestinations('linear-chooser');
            expect(destinations).toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: expect.objectContaining({ targetRowId: treeRowId.session('server-a', 's128') }) }),
            ]));
            // One list traversal is linear; rereading every item for every place is quadratic.
            expect(itemReads, `129 input items, ${destinations.length} semantic places: ${itemReads} item reads`)
                .toBeLessThanOrEqual(items.length * 2);
            await hook.rerender({ ...initialInput, listItems: items.map(item => ({ ...item })) });
            expect(runtime.getDestinations('linear-chooser')).toEqual(destinations);
            await hook.rerender({ ...initialInput, listItems: items.slice(0, -1), sessionListOrderingModeV1: 'created' });
            const refreshed = runtime.getDestinations('linear-chooser');
            expect(refreshed).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: expect.objectContaining({ targetRowId: treeRowId.session('server-a', 's128') }) }),
            ]));
            expect(refreshed).toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: expect.objectContaining({ instructionKind: 'reorder-after' }),
                    admission: expect.objectContaining({ status: 'refused', reason: expect.objectContaining({ code: 'date-ordering-mode' }) }) }),
            ]));
        } finally {
            retire();
            await hook.unmount();
        }
    });

    it('offers current semantic destinations through the mounted list, retaining denied relation targets', async () => {
        const initialInput = buildInteractionsInput({ listItems: twoSessionListItems });
        const hook = await renderHook(
            (input: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(input),
            { initialProps: initialInput },
        );
        const { runtime, targetId } = hook.getCurrent().entityDragDrop;
        const retire = runtime.registerSource({ id: 'chooser-session', scope: ACTIVE_SCOPE, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope: ACTIVE_SCOPE, address: { serverId: ACTIVE_SCOPE.serverId, sessionId: 's1' } }) });
        const relationTargets = () => runtime.getDestinations('chooser-session').filter(entry => {
            const destination = entry.destination;
            return destination != null && typeof destination === 'object' && !Array.isArray(destination) && 'instructionKind' in destination
                && destination.instructionKind === 'nest-into';
        });
        try {
            const targetRowId = treeRowId.session('server-a', 's2');
            const carry = runtime.begin('chooser-session', 'keyboard');
            carry?.choose(targetId!, { sourceRowId: treeRowId.session('server-a', 's1'), sourceKind: 'leaf',
                instructionKind: 'nest-into', targetRowId, containerId: targetRowId, parentRowId: targetRowId,
                depth: 1, edge: null });
            expect(runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'unavailable' },
                preview: { target: 's2' } });
            carry?.cancel();
            expect(relationTargets()).toMatchObject([{ targetId,
                destination: { sourceRowId: treeRowId.session('server-a', 's1'), targetRowId: treeRowId.session('server-a', 's2') },
                admission: { status: 'refused', reason: { code: 'unavailable' }, preview: { target: 's2' } },
            }]);
            // No row was measured or mounted; the current list index, rather than a carry snapshot,
            // supplies chooser targets. Refresh membership while the list target remains mounted.
            const sessionTemplate = twoSessionListItems[2]!;
            if (sessionTemplate.type !== 'session') throw new Error('Expected a Session fixture');
            const latestItems: SessionListIndexItem[] = [twoSessionListItems[0]!, twoSessionListItems[1]!,
                { ...sessionTemplate, sessionId: 's3' }];
            await hook.rerender({ ...initialInput, listItems: latestItems });
            expect(relationTargets()).toMatchObject([{ targetId,
                destination: { targetRowId: treeRowId.session('server-a', 's3') },
                admission: { status: 'refused', reason: { code: 'unavailable' }, preview: { target: 's3' } },
            }]);
            const previousRelation = relationTargets()[0]!;
            const folderRowId = treeRowId.folder('server-a', 'folder-a');
            const folderItems: SessionListIndexItem[] = [...latestItems, { type: 'header', title: 'Folder A',
                headerKind: 'folder', folderId: 'folder-a', folderDepth: 0,
                groupKey: buildSessionFolderGroupKey({ serverId: 'server-a', workspace, folderId: 'folder-a' }),
                workspace, serverId: 'server-a' }];
            await hook.rerender({ ...initialInput, listItems: folderItems, sessionListOrderingModeV1: 'created' });
            const destinations = runtime.getDestinations('chooser-session');
            expect(destinations).toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: expect.objectContaining({ instructionKind: 'nest-into', targetRowId: folderRowId }),
                    admission: expect.objectContaining({ status: 'allowed', effect: expect.objectContaining({ actionId: 'session.organization.move' }) }) }),
                expect.objectContaining({ destination: expect.objectContaining({ instructionKind: 'move-to-root' }) }),
                expect.objectContaining({ destination: expect.objectContaining({ instructionKind: 'reorder-after' }),
                    admission: expect.objectContaining({ status: 'refused', reason: expect.objectContaining({ code: 'date-ordering-mode' }) }) }),
            ]));
            // A previously enumerated target is only a proposal: final admission reads current membership.
            await hook.rerender({ ...initialInput, listItems: [latestItems[0]!, latestItems[1]!] });
            expect(await runtime.perform('chooser-session', targetId!, previousRelation.destination))
                .toMatchObject({ status: 'refused', reason: { code: 'target-missing' } });
            expect(initialInput.setSessionListGroupOrderV1).not.toHaveBeenCalled();
            expect(initialInput.setSessionFoldersV1).not.toHaveBeenCalled();
        } finally {
            retire();
            await hook.unmount();
        }
    });

    it('answers session.organization.move from the mounted list and persists under the projection server id', async () => {
        boundary.folderAssignment.mockClear();
        const folderItems: SessionListIndexItem[] = [
            listItems[0]!,
            {
                type: 'header',
                title: 'Folder A',
                headerKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                groupKey: 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-a',
                workspace,
                serverId: 'server-a',
            },
            listItems[1]!,
        ];
        const hook = await renderInteractions({
            listItems: folderItems,
            sessionFoldersV1: {
                v: 1,
                folders: [{
                    id: 'folder-a',
                    workspace,
                    parentId: null,
                    name: 'Folder A',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        });

        let output: unknown;
        await act(async () => {
            output = await invokeSessionListOrganizationAction({ mutationScope: MUTATION_SCOPE, input: {
                scope: ACTIVE_SCOPE,
                sourceRowId: treeRowId.session('server-a', 's1'),
                sourceKind: 'leaf',
                instructionKind: 'nest-into',
                targetRowId: treeRowId.folder('server-a', 'folder-a'),
                containerId: treeRowId.folder('server-a', 'folder-a'),
                parentRowId: treeRowId.folder('server-a', 'folder-a'),
                depth: 1,
                edge: null,
            } });
        });
        expect(output).toEqual({ status: 'applied' });

        expect(boundary.folderAssignment).toHaveBeenCalledWith(expect.objectContaining({
            credentials: MUTATION_SCOPE.credentials, serverUrl: MUTATION_SCOPE.serverUrl,
            sessionId: 's1', request: { folderId: 'folder-a' },
        }));
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's1' })])
            .toEqual({ sessionId: 's1', folderId: 'folder-a' });

        await hook.unmount();
    });

    it('does not start a folder mutation for a row whose exact Home disables folders', async () => {
        boundary.folderAssignment.mockClear();
        const folderItems: SessionListIndexItem[] = [
            listItems[0]!,
            {
                type: 'header',
                title: 'Folder A',
                headerKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                groupKey: 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-a',
                workspace,
                serverId: 'server-a',
            },
            listItems[1]!,
        ];
        const hook = await renderInteractions({
            listItems: folderItems,
            isFolderActionsEnabledForServerId: (serverId) => serverId === 'server-b',
            sessionFoldersV1: {
                v: 1,
                folders: [{ id: 'folder-a', workspace, parentId: null, name: 'Folder A', createdAt: 1, updatedAt: 1 }],
            },
        });

        let output: unknown;
        await act(async () => {
            output = await invokeSessionListOrganizationAction({ mutationScope: MUTATION_SCOPE, input: {
                scope: ACTIVE_SCOPE,
                sourceRowId: treeRowId.session('server-a', 's1'),
                sourceKind: 'leaf',
                instructionKind: 'nest-into',
                targetRowId: treeRowId.folder('server-a', 'folder-a'),
                containerId: treeRowId.folder('server-a', 'folder-a'),
                parentRowId: treeRowId.folder('server-a', 'folder-a'),
                depth: 1,
                edge: null,
            } });
        });
        expect(output).toEqual({ status: 'refused', reason: 'feature-disabled' });

        expect(boundary.folderAssignment).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('exposes only drag snapshot and numeric overlay state for pointer drag visuals', async () => {
        const hook = await renderInteractions();

        await act(async () => {
            hook.getCurrent().handleDragStart(sessionAddressKey({ serverId: 'server-a', sessionId: 's1' }));
            hook.getCurrent().handleDragUpdate({
                sessionKey: 'server-a:s1',
                groupKey: 'g1',
                dataIndex: 1,
                result: {
                    instruction: {
                        kind: 'nest-into',
                        targetId: 'folder:target',
                        containerId: 'folder:target',
                        parentId: 'folder:target',
                        depth: 1,
                    },
                    visual: {
                        kind: 'outline',
                        targetId: 'folder:target',
                    },
                },
            });
        });

        expect(hook.getCurrent().draggingSessionKey).toBe(sessionAddressKey({ serverId: 'server-a', sessionId: 's1' }));
        expect(hook.getCurrent()).toHaveProperty('activeDragSnapshot');
        expect(hook.getCurrent()).toHaveProperty('dropOverlayShared');
        expect(hook.getCurrent()).not.toHaveProperty('activeDropTargetId');
        expect(hook.getCurrent()).not.toHaveProperty('activeDropVisual');
        expect(hook.getCurrent()).not.toHaveProperty('dropVisual');

        await hook.unmount();
    });

    it('does not expose a legacy delta-based drag-end handler', async () => {
        const hook = await renderInteractions();

        expect(hook.getCurrent()).not.toHaveProperty('handleDragEnd');
        expect(hook.getCurrent()).toHaveProperty('resolveTreeDropResult');
        expect(hook.getCurrent()).toHaveProperty('handleTreeDropResult');

        await hook.unmount();
    });

    it('does not persist same-container session reorder from row interactions in date ordering mode', async () => {
        const setSessionListGroupOrderV1 = vi.fn(async () => {});
        const dateModeInput = {
            listItems: twoSessionListItems,
            sessionListOrderingModeV1: 'updated' as const,
            sessionListSectionModeV1: 'activity' as const,
            setSessionListGroupOrderV1,
        };
        const hook = await renderInteractions(dateModeInput);

        let output: unknown;
        await act(async () => {
            output = await invokeSessionListOrganizationAction({ mutationScope: MUTATION_SCOPE, input: {
                scope: ACTIVE_SCOPE,
                sourceRowId: treeRowId.session('server-a', 's2'),
                sourceKind: 'leaf',
                instructionKind: 'reorder-before',
                targetRowId: treeRowId.session('server-a', 's1'),
                containerId: treeRowId.workspaceRoot('project-a'),
                parentRowId: null,
                depth: 0,
                edge: 'top',
            } });
        });
        expect(output).toEqual({ status: 'refused', reason: 'date-ordering-mode' });

        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('preserves pin and tag row actions while using the tree pipeline', async () => {
        const setSessionPinForKey = vi.fn();
        const setSessionTagsForKey = vi.fn();
        const hook = await renderInteractions({
            pinnedKeySet: new Set(['server-a:s1']),
            setSessionPinForKey,
            sessionTags: { 'server-a:s1': ['old'] },
            setSessionTagsForKey,
        });

        hook.getCurrent().handleTogglePinnedSessionKey('server-a:s1');
        hook.getCurrent().handleSetTagsSessionKey('server-a:s1', ['new']);

        expect(setSessionPinForKey).toHaveBeenCalledWith('server-a:s1', false);
        expect(setSessionTagsForKey).toHaveBeenCalledWith('server-a:s1', ['new']);

        await hook.unmount();
    });

    it('suppresses exactly one folder-focus press after a release, which writes nothing when no place admitted the row', async () => {
        boundary.folderAssignment.mockClear();
        const folderItems: SessionListIndexItem[] = [
            listItems[0]!,
            {
                type: 'header',
                title: 'Folder A',
                headerKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                groupKey: 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-a',
                workspace,
                serverId: 'server-a',
            },
            listItems[1]!,
        ];
        const hook = await renderInteractions({
            listItems: folderItems,
            sessionFoldersV1: {
                v: 1,
                folders: [{
                    id: 'folder-a',
                    workspace,
                    parentId: null,
                    name: 'Folder A',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        });

        expect(hook.getCurrent().consumeFolderFocusPressAfterDrag()).toBe(false);

        await act(async () => {
            hook.getCurrent().handleDragStart(sessionAddressKey({ serverId: 'server-a', sessionId: 's1' }));
            hook.getCurrent().handleTreeDropResult({
                sessionKey: 'server-a:s1',
                groupKey: 'project-a',
                dataIndex: 2,
                result: {
                    instruction: {
                        kind: 'nest-into',
                        targetId: treeRowId.folder('server-a', 'folder-a'),
                        containerId: treeRowId.folder('server-a', 'folder-a'),
                        parentId: treeRowId.folder('server-a', 'folder-a'),
                        depth: 1,
                    },
                    visual: { kind: 'outline', targetId: treeRowId.folder('server-a', 'folder-a') },
                },
            });
        });

        expect(hook.getCurrent().consumeFolderFocusPressAfterDrag()).toBe(true);
        expect(hook.getCurrent().consumeFolderFocusPressAfterDrag()).toBe(false);
        // The pointer never reached an admitted place, so the release had nothing to commit.
        expect(boundary.folderAssignment).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('keeps row action handler identities stable across pin and tag state changes', async () => {
        const setSessionPinForKey = vi.fn();
        const setSessionTagsForKey = vi.fn();
        const hook = await renderHook(
            (input: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(input),
            {
                initialProps: buildInteractionsInput({
                    setSessionPinForKey,
                    sessionTags: { 'server-a:s1': ['old'] },
                    setSessionTagsForKey,
                }),
            },
        );

        const initialTogglePinned = hook.getCurrent().handleTogglePinnedSessionKey;
        const initialSetTags = hook.getCurrent().handleSetTagsSessionKey;

        await hook.rerender(buildInteractionsInput({
            pinnedKeySet: new Set(['server-a:s1']),
            setSessionPinForKey,
            sessionTags: { 'server-a:s1': ['old', 'new'] },
            setSessionTagsForKey,
        }));

        expect(hook.getCurrent().handleTogglePinnedSessionKey).toBe(initialTogglePinned);
        expect(hook.getCurrent().handleSetTagsSessionKey).toBe(initialSetTags);

        hook.getCurrent().handleTogglePinnedSessionKey('server-a:s1');
        hook.getCurrent().handleSetTagsSessionKey('server-a:s1', ['latest']);

        expect(setSessionPinForKey).toHaveBeenLastCalledWith('server-a:s1', false);
        expect(setSessionTagsForKey).toHaveBeenLastCalledWith('server-a:s1', ['latest']);

        await hook.unmount();
    });
});
