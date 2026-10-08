import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { buildSessionFolderGroupKey, DEFAULT_SESSION_FOLDERS_V1 } from '@/sync/domains/session/folders';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { UseSessionListRowInteractionsInput } from './useSessionListRowInteractions';
import { treeRowId } from './drop-resolution/treeRowId';
import { getStorage } from '@/sync/domains/state/storage';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

<<<<<<< HEAD
=======
// Reanimated is the native SDK boundary; keep real row and entity runtime owners.
>>>>>>> origin/v0.3
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

const ACTIVE_SCOPE = { serverId: 'srv_server_a', accountId: 'account-a' } as const;
const SESSION_ONE_KEY = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's1' });
const MUTATION_SCOPE = {
    credentials: { token: createAccountTokenForTests(ACTIVE_SCOPE.accountId) },
    serverId: ACTIVE_SCOPE.serverId,
    serverIdAliases: ['profile-a', 'legacy-a'],
    serverUrl: 'https://server-a.example.test',
};
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.doUnmock('@/sync/http/client');
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let previousStorageState: ReturnType<ReturnType<typeof getStorage>['getState']>;
let useSessionListRowInteractions: typeof import('./useSessionListRowInteractions').useSessionListRowInteractions;
let invokeSessionListOrganizationAction: typeof import('./drag/sessionListOrganizationAction').invokeSessionListOrganizationAction;
const folderAssignmentPath = '/v2/session-organization/folder-assignments/s1';
function folderAssignmentRequests() {
    return home.requests.filter(request => request.path === folderAssignmentPath);
}

describe('useSessionListRowInteractions', () => {
    beforeEach(async () => {
        // The list answers drags and organization Actions for its mounted Home and Account only.
        previousStorageState = getStorage().getState();
        await home.reset();
        const homeId = await home.addHome({ name: 'Drag Home', serverUrl: MUTATION_SCOPE.serverUrl,
            serverIdentityId: ACTIVE_SCOPE.serverId, accountId: ACTIVE_SCOPE.accountId, active: false });
        home.answer(homeId, folderAssignmentPath, { body: { sessionId: 's1', folderId: 'folder-a' } });
        connection = await restoreServerAccountForTest({ serverUrl: MUTATION_SCOPE.serverUrl,
            serverIdentityId: ACTIVE_SCOPE.serverId, accountId: ACTIVE_SCOPE.accountId, request: home.request });
        ({ useSessionListRowInteractions } = await import('./useSessionListRowInteractions'));
        ({ invokeSessionListOrganizationAction } = await import('./drag/sessionListOrganizationAction'));
        home.requests.length = 0;
    });
    afterEach(async () => {
        standardCleanup();
        await connection.dispose();
        await home.reset();
        getStorage().setState(previousStorageState, true);
    });

    const workspace = {
        t: 'workspaceScope',
        serverId: 'srv_server_a',
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
            serverId: 'srv_server_a',
        },
        {
            type: 'session',
            sessionId: 's1',
            serverId: 'srv_server_a',
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
            serverId: 'srv_server_a',
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
        const scope = ACTIVE_SCOPE;
        const nativeItems = twoSessionListItems.map(item => ({ ...item, serverId: scope.serverId,
            workspace: { ...workspace, serverId: scope.serverId } }));
        const setOrder = vi.fn(async (_next: Record<string, string[]>) => {});
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
                expect.objectContaining({ destination: expect.objectContaining({ targetRowId: treeRowId.session('srv_server_a', 's128') }) }),
            ]));
            // One list traversal is linear; rereading every item for every place is quadratic.
            expect(itemReads, `129 input items, ${destinations.length} semantic places: ${itemReads} item reads`)
                .toBeLessThanOrEqual(items.length * 2);
            await hook.rerender({ ...initialInput, listItems: items.map(item => ({ ...item })) });
            expect(runtime.getDestinations('linear-chooser')).toEqual(destinations);
            await hook.rerender({ ...initialInput, listItems: items.slice(0, -1), sessionListOrderingModeV1: 'created' });
            const refreshed = runtime.getDestinations('linear-chooser');
            expect(refreshed).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: expect.objectContaining({ targetRowId: treeRowId.session('srv_server_a', 's128') }) }),
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

    it('prepares a semantic Session source and folder destinations without tree headers', async () => {
        const initialInput = buildInteractionsInput({ listItems: listItems.filter(item => item.type === 'session'),
            sessionFoldersV1: { v: 1, folders: [{ id: 'hidden-folder', name: 'Hidden', workspace,
                parentId: null, createdAt: 1, updatedAt: 1 }] } });
        const hook = await renderHook((input: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(input),
            { initialProps: initialInput });
        let source: Readonly<{ sourceId: string; dispose: () => void }> | null;
        try {
            source = hook.getCurrent().prepareTreeRowSource(treeRowId.session('srv_server_a', 's1'));
            expect(source).not.toBeNull();
            const { runtime } = hook.getCurrent().entityDragDrop;
            expect(runtime.getDestinations(source!.sourceId)).toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: { kind: 'folder-assignment', folderId: 'hidden-folder' },
                    admission: expect.objectContaining({ status: 'allowed' }) }),
            ]));
            await hook.rerender({ ...initialInput, listItems: [] });
            expect(runtime.getDestinations(source!.sourceId)).toEqual([]);
            expect(runtime.begin(source!.sourceId, 'keyboard')).toBeNull();
            source!.dispose();
        } finally {
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
            const targetRowId = treeRowId.session('srv_server_a', 's2');
            const carry = runtime.begin('chooser-session', 'keyboard');
            carry?.choose(targetId!, { sourceRowId: treeRowId.session('srv_server_a', 's1'), sourceKind: 'leaf',
                instructionKind: 'nest-into', targetRowId, containerId: targetRowId, parentRowId: targetRowId,
                depth: 1, edge: null });
            expect(runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'unavailable' },
                preview: { target: 's2' } });
            carry?.cancel();
            expect(relationTargets()).toMatchObject([{ targetId,
                destination: { sourceRowId: treeRowId.session('srv_server_a', 's1'), targetRowId: treeRowId.session('srv_server_a', 's2') },
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
                destination: { targetRowId: treeRowId.session('srv_server_a', 's3') },
                admission: { status: 'refused', reason: { code: 'unavailable' }, preview: { target: 's3' } },
            }]);
            const previousRelation = relationTargets()[0]!;
            const folderItems: SessionListIndexItem[] = [...latestItems, { type: 'header', title: 'Folder A',
                headerKind: 'folder', folderId: 'folder-a', folderDepth: 0,
                groupKey: buildSessionFolderGroupKey({ serverId: 'srv_server_a', workspace, folderId: 'folder-a' }),
                workspace, serverId: 'srv_server_a' }];
            await hook.rerender({ ...initialInput, listItems: folderItems, sessionListOrderingModeV1: 'created',
                sessionFoldersV1: { v: 1, folders: [{ id: 'folder-a', name: 'Folder A', workspace,
                    parentId: null, createdAt: 1, updatedAt: 1 }] } });
            const destinations = runtime.getDestinations('chooser-session');
            expect(destinations).toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: { kind: 'folder-assignment', folderId: 'folder-a' },
                    admission: expect.objectContaining({ status: 'allowed', effect: expect.objectContaining({ actionId: 'session.folder.set' }) }) }),
                expect.objectContaining({ destination: { kind: 'folder-assignment', folderId: null },
                    admission: expect.objectContaining({ status: 'refused', reason: expect.objectContaining({ code: 'no-change' }) }) }),
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
        home.requests.length = 0;
        const folderItems: SessionListIndexItem[] = [
            listItems[0]!,
            {
                type: 'header',
                title: 'Folder A',
                headerKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                groupKey: buildSessionFolderGroupKey({ serverId: ACTIVE_SCOPE.serverId, workspace, folderId: 'folder-a' }),
                workspace,
                serverId: 'srv_server_a',
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
                sourceRowId: treeRowId.session('srv_server_a', 's1'),
                sourceKind: 'leaf',
                instructionKind: 'nest-into',
                targetRowId: treeRowId.folder('srv_server_a', 'folder-a'),
                containerId: treeRowId.folder('srv_server_a', 'folder-a'),
                parentRowId: treeRowId.folder('srv_server_a', 'folder-a'),
                depth: 1,
                edge: null,
            } });
        });
        expect(output).toEqual({ status: 'applied' });

        expect(folderAssignmentRequests()).toEqual([expect.objectContaining({
            token: MUTATION_SCOPE.credentials.token, serverUrl: MUTATION_SCOPE.serverUrl,
            input: { folderId: 'folder-a' },
        })]);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's1' })])
            .toEqual({ sessionId: 's1', folderId: 'folder-a' });

        await hook.unmount();
    });

    it('does not start a folder mutation for a row whose exact Home disables folders', async () => {
        home.requests.length = 0;
        const folderItems: SessionListIndexItem[] = [
            listItems[0]!,
            {
                type: 'header',
                title: 'Folder A',
                headerKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                groupKey: buildSessionFolderGroupKey({ serverId: ACTIVE_SCOPE.serverId, workspace, folderId: 'folder-a' }),
                workspace,
                serverId: 'srv_server_a',
            },
            listItems[1]!,
        ];
        const hook = await renderInteractions({
            listItems: folderItems,
            isFolderActionsEnabledForServerId: (serverId) => serverId === 'srv_server_b',
            sessionFoldersV1: {
                v: 1,
                folders: [{ id: 'folder-a', workspace, parentId: null, name: 'Folder A', createdAt: 1, updatedAt: 1 }],
            },
        });

        let output: unknown;
        await act(async () => {
            output = await invokeSessionListOrganizationAction({ mutationScope: MUTATION_SCOPE, input: {
                scope: ACTIVE_SCOPE,
                sourceRowId: treeRowId.session('srv_server_a', 's1'),
                sourceKind: 'leaf',
                instructionKind: 'nest-into',
                targetRowId: treeRowId.folder('srv_server_a', 'folder-a'),
                containerId: treeRowId.folder('srv_server_a', 'folder-a'),
                parentRowId: treeRowId.folder('srv_server_a', 'folder-a'),
                depth: 1,
                edge: null,
            } });
        });
        expect(output).toEqual({ status: 'refused', reason: 'feature-disabled' });

        expect(folderAssignmentRequests()).toEqual([]);
        await hook.unmount();
    });

    it('exposes only drag snapshot and numeric overlay state for pointer drag visuals', async () => {
        const hook = await renderInteractions();

        await act(async () => {
            hook.getCurrent().handleDragStart(sessionAddressKey({ serverId: 'srv_server_a', sessionId: 's1' }));
            hook.getCurrent().handleDragUpdate({
                sessionKey: SESSION_ONE_KEY,
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

        expect(hook.getCurrent().draggingSessionKey).toBe(sessionAddressKey({ serverId: 'srv_server_a', sessionId: 's1' }));
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
                sourceRowId: treeRowId.session('srv_server_a', 's2'),
                sourceKind: 'leaf',
                instructionKind: 'reorder-before',
                targetRowId: treeRowId.session('srv_server_a', 's1'),
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
            pinnedKeySet: new Set([SESSION_ONE_KEY]),
            setSessionPinForKey,
            sessionTags: { [SESSION_ONE_KEY]: ['old'] },
            setSessionTagsForKey,
        });

        hook.getCurrent().handleTogglePinnedSessionKey(SESSION_ONE_KEY);
        hook.getCurrent().handleSetTagsSessionKey(SESSION_ONE_KEY, ['new']);

        expect(setSessionPinForKey).toHaveBeenCalledWith(SESSION_ONE_KEY, false);
        expect(setSessionTagsForKey).toHaveBeenCalledWith(SESSION_ONE_KEY, ['new']);

        await hook.unmount();
    });

    it('suppresses exactly one folder-focus press after a release, which writes nothing when no place admitted the row', async () => {
        home.requests.length = 0;
        const folderItems: SessionListIndexItem[] = [
            listItems[0]!,
            {
                type: 'header',
                title: 'Folder A',
                headerKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                groupKey: buildSessionFolderGroupKey({ serverId: ACTIVE_SCOPE.serverId, workspace, folderId: 'folder-a' }),
                workspace,
                serverId: 'srv_server_a',
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
            hook.getCurrent().handleDragStart(sessionAddressKey({ serverId: 'srv_server_a', sessionId: 's1' }));
            hook.getCurrent().handleTreeDropResult({
                sessionKey: SESSION_ONE_KEY,
                groupKey: 'project-a',
                dataIndex: 2,
                result: {
                    instruction: {
                        kind: 'nest-into',
                        targetId: treeRowId.folder('srv_server_a', 'folder-a'),
                        containerId: treeRowId.folder('srv_server_a', 'folder-a'),
                        parentId: treeRowId.folder('srv_server_a', 'folder-a'),
                        depth: 1,
                    },
                    visual: { kind: 'outline', targetId: treeRowId.folder('srv_server_a', 'folder-a') },
                },
            });
        });

        expect(hook.getCurrent().consumeFolderFocusPressAfterDrag()).toBe(true);
        expect(hook.getCurrent().consumeFolderFocusPressAfterDrag()).toBe(false);
        // The pointer never reached an admitted place, so the release had nothing to commit.
        expect(folderAssignmentRequests()).toEqual([]);

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
                    sessionTags: { [SESSION_ONE_KEY]: ['old'] },
                    setSessionTagsForKey,
                }),
            },
        );

        const initialTogglePinned = hook.getCurrent().handleTogglePinnedSessionKey;
        const initialSetTags = hook.getCurrent().handleSetTagsSessionKey;

        await hook.rerender(buildInteractionsInput({
            pinnedKeySet: new Set([SESSION_ONE_KEY]),
            setSessionPinForKey,
            sessionTags: { [SESSION_ONE_KEY]: ['old', 'new'] },
            setSessionTagsForKey,
        }));

        expect(hook.getCurrent().handleTogglePinnedSessionKey).toBe(initialTogglePinned);
        expect(hook.getCurrent().handleSetTagsSessionKey).toBe(initialSetTags);

        hook.getCurrent().handleTogglePinnedSessionKey(SESSION_ONE_KEY);
        hook.getCurrent().handleSetTagsSessionKey(SESSION_ONE_KEY, ['latest']);

        expect(setSessionPinForKey).toHaveBeenLastCalledWith(SESSION_ONE_KEY, false);
        expect(setSessionTagsForKey).toHaveBeenLastCalledWith(SESSION_ONE_KEY, ['latest']);

        await hook.unmount();
    });
});
