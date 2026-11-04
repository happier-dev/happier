// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { buildSessionSectionGroupKey, projectSessionSectionListIndex } from '@/sync/domains/session/organization/sections';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { UseSessionListRowInteractionsInput } from './useSessionListRowInteractions';
import { treeRowId } from './drop-resolution/treeRowId';
import { useEntityDragDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { buildSessionWorkspaceOrderItemKey, buildSessionWorkspaceOrderScopeKey } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import type { UseSessionInlineDragResolvedDrop } from './useSessionInlineDrag';
import { getStorage, useSessionOrganizationProjections } from '@/sync/domains/state/storage';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionOrganizationListViewStateForServers } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import { useFrozenSessionListItemsDuringDrag } from './drag/useFrozenSessionListItemsDuringDrag';
import { SESSION_LIST_SUPPORTING_SECTIONS_NODE } from './sessionListVirtualizedNodes';

// This suite statically imports the mounted Sync consumer; install its external transport first.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();

// Metro's deferred import is the external loader boundary; retain real Action policy/approval.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platform = vi.hoisted(() => ({ os: 'ios' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.os; } } });
});

// Reanimated is the native SDK boundary; keep real row and entity runtime owners.
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
        for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/session-organization']) {
            const response = createEmptyAccountBootstrapHttpResponse(path);
            if (!response) throw new Error('Session bootstrap fixture unavailable');
            home.answer(homeId, path, { body: await response.json() });
        }
        connection = await restoreServerAccountForTest({ serverUrl: MUTATION_SCOPE.serverUrl,
            serverIdentityId: ACTIVE_SCOPE.serverId, accountId: ACTIVE_SCOPE.accountId, request: home.request,
            additionalRequestOrigins: ['https://server-b.example.test'] });
        await waitForHomeGovernance(() => {
            expect(getStorage().getState().profileScope).toEqual(ACTIVE_SCOPE);
            expect(getStorage().getState().isDataReady).toBe(true);
        });
        ({ useSessionListRowInteractions } = await import('./useSessionListRowInteractions'));
        ({ invokeSessionListOrganizationAction } = await import('./drag/sessionListOrganizationAction'));
        home.requests.length = 0;
    });
    afterEach(async () => {
        platform.os = 'ios';
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
            sessionSections: [],
            listItems,
            currentGroupOrderMap: {},
            currentWorkspaceOrderMap: {},
            sessionListLayoutV1: 'projects',
            manualSessionOrderingEnabled: true,
            setSessionListGroupOrderV1: vi.fn(async () => {}),
            setSessionWorkspaceOrderV1: vi.fn(async () => {}),
            pinnedKeySet: new Set(),
            setSessionPinForKey: vi.fn(),
            sessionTags: {},
            setSessionTagsForKey: vi.fn(),
            ...overrides,
        };
    }

    async function renderInteractions(overrides: Partial<UseSessionListRowInteractionsInput> = {}) {
        return renderMutableInteractions(buildInteractionsInput(overrides));
    }

    async function renderMutableInteractions(value: UseSessionListRowInteractionsInput) {
        const hook = await renderHook((next: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(next), { initialProps: value });
        const tree = (await import('./drop-resolution/buildSessionListTreeRows')).buildSessionListTreeRows({ items: value.listItems ?? [] });
        const rowsByHome = new Map([...tree.rowMetadataById.values()].filter(row => row.serverId).map(row => [row.serverId, row]));
        for (const sourceRow of rowsByHome.values()) await waitForHomeGovernance(() => {
                const source = hook.getCurrent().prepareTreeRowSource(sourceRow.rowId);
                expect(source).not.toBeNull();
                source?.dispose();
            });
        return hook;
    }

    it.each([
        { inputKind: 'pointer', status: 200, direction: 'file' },
        { inputKind: 'keyboard', status: 200, direction: 'file' },
        { inputKind: 'pointer', status: 500, direction: 'file' },
        { inputKind: 'pointer', status: 200, direction: 'unfile' },
        { inputKind: 'chooser', status: 200, direction: 'unfile' },
    ] as const)('publishes Section membership and row placement in one commit after a $inputKind $direction drop ($status)', async ({ inputKind, status, direction }) => {
        const serverId = ACTIVE_SCOPE.serverId;
        const sectionId = 'payments';
        const sourceRowId = treeRowId.session(serverId, 's1');
        const sectionRowId = treeRowId.folder(serverId, sectionId);
        const sectionKey = buildSessionOrganizationServerKey(serverId, sectionId);
        const destination = direction === 'file' ? sectionId : null;
        const committedMembers = direction === 'file' ? 1 : 0;
        getStorage().getState().applySessionOrganizationSnapshot(serverId, {
            schemaVersion: 1, version: 1, pins: [], folders: [{
                folderId: sectionId, folderKey: sectionId, parentFolderId: null, parentFolderKey: null,
                sortKey: 'a0', archivedAt: null, createdAt: 1, updatedAt: 1,
                display: { t: 'plain', v: { name: 'Payments', icon: null } },
                displayState: { status: 'available', value: { name: 'Payments', icon: null } },
            }], folderAssignments: direction === 'file' ? [] : [{ sessionId: 's1', folderId: sectionId }],
            tags: [], tagAssignments: [], orderEntries: [], labels: [],
        }, { includeAllFolderAssignments: true });
        let answer = () => {};
        const response = new Promise<void>(resolve => { answer = resolve; });
        home.answer(serverId, folderAssignmentPath, { respondAfter: response, status,
            body: status === 200 ? { sessionId: 's1', folderId: destination } : { error: 'rejected' } });
        const commits: { members: number; filed: boolean; present: boolean }[] = [];
        const hook = await renderHook(() => {
            const projections = useSessionOrganizationProjections([serverId]);
            const organization = buildSessionOrganizationListViewStateForServers({ serverIds: [serverId], projectionsByServerId: projections });
            const live = projectSessionSectionListIndex({ source: listItems, sections: organization.sections,
                assignmentsBySessionKey: organization.sessionFolderAssignmentsBySessionKey }).items;
            const interactions = useSessionListRowInteractions(buildInteractionsInput({ listItems: live, sessionSections: organization.sections }));
            const presented = useFrozenSessionListItemsDuringDrag({ activeSnapshot: interactions.activeDragSnapshot, liveViewItems: live });
            const sectionIndex = presented.viewItems.findIndex(item => item.type === 'header' && item.folderId === sectionId);
            const sourceIndex = presented.viewItems.findIndex(item => item.type === 'session' && item.sessionId === 's1');
            const members = organization.sectionMemberSessionKeysBySectionKey[sectionKey]?.length ?? 0;
            const filed = sourceIndex === sectionIndex + 1;
            React.useLayoutEffect(() => { commits.push({ members, filed, present: sourceIndex >= 0 }); });
            return { interactions, members, filed };
        });
        let completion: Promise<void> | undefined;
        try {
            await waitForHomeGovernance(() => {
                const source = hook.getCurrent().interactions.prepareTreeRowSource(sourceRowId);
                expect(source).not.toBeNull();
                source?.dispose();
            });
            await act(async () => {
                const current = hook.getCurrent().interactions;
                current.handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 600) });
                current.registerTreeRowBounds(sectionRowId, { measureInWindow: callback => callback(0, 100, 300, 40) });
                current.registerTreeRowBounds(treeRowId.workspaceRoot('project-a'), { measureInWindow: callback => callback(0, 180, 300, 40) });
                current.registerTreeRowBounds(sourceRowId, { measureInWindow: callback => callback(0, 230, 300, 40) });
                if (inputKind === 'pointer') current.handleDragStart(SESSION_ONE_KEY);
                else if (inputKind === 'keyboard') current.stagedMove.handleRowKey({ sessionKey: sourceRowId, label: 'One', key: ' ' });
            });
            if (inputKind !== 'chooser') expect(hook.getCurrent().interactions.activeDragSnapshot).not.toBeNull();
            commits.length = 0;
            act(() => {
                const current = hook.getCurrent().interactions;
                if (inputKind === 'pointer') {
                    const resolved = current.resolveDropResult({ sessionKey: SESSION_ONE_KEY, groupKey: 'project-a',
                        pointer: { x: 10, y: direction === 'file' ? 120 : 200 } });
                    expect(current.entityDragDrop.runtime.getSnapshot().admission?.status).toBe('allowed');
                    completion = current.handleTreeDropResult({ sessionKey: SESSION_ONE_KEY, groupKey: 'project-a', result: resolved.result });
                } else if (inputKind === 'keyboard') {
                    current.entityDragDrop.runtime.choose(current.entityDragDrop.targetId, { kind: 'folder-assignment', folderId: destination });
                    expect(current.entityDragDrop.runtime.getSnapshot().admission?.status).toBe('allowed');
                    current.stagedMove.handleRowKey({ sessionKey: sourceRowId, label: 'One', key: 'Enter' });
                } else completion = current.moveToFolder(serverId, 's1', destination).then(() => {});
            });
            await waitForHomeGovernance(() => expect(hook.getCurrent().members).toBe(committedMembers));
            expect(hook.getCurrent().interactions.entityDragDrop.runtime.getSnapshot().phase).toBe('pending');
            expect(commits.some(commit => commit.members === committedMembers)).toBe(true);
            expect(commits.every(commit => commit.present && commit.filed === (commit.members === 1)), JSON.stringify(commits)).toBe(true);
            await act(async () => { answer(); await completion; });
            await waitForHomeGovernance(() => expect(hook.getCurrent().interactions.entityDragDrop.runtime.getSnapshot().phase).not.toBe('pending'));
            const finalMembers = status === 200 ? committedMembers : 1 - committedMembers;
            expect(hook.getCurrent()).toMatchObject({ members: finalMembers, filed: finalMembers === 1 });
            expect(commits.every(commit => commit.present && commit.filed === (commit.members === 1)), JSON.stringify(commits)).toBe(true);
        } finally {
            answer();
            await completion;
            await hook.unmount();
        }
    });

    it('files a Home-B Session under its own Section while Home-A remains focused', async () => {
        const serverId = 'srv_server_b';
        const accountId = 'account-b';
        const serverUrl = 'https://server-b.example.test';
        const homeB = await home.addHome({ name: 'Other Drag Home', serverUrl, serverIdentityId: serverId, accountId, active: false });
        for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/session-organization']) {
            const response = createEmptyAccountBootstrapHttpResponse(path);
            if (!response) throw new Error('Session bootstrap fixture unavailable');
            home.answer(homeB, path, { body: await response.json() });
        }
        const path = '/v2/session-organization/folder-assignments/other';
        home.answer(homeB, path, { body: { sessionId: 'other', folderId: 'section-b' } });
        const hook = await renderInteractions({ listItems: [...listItems,
            { type: 'header', headerKind: 'project', title: 'Other Project', groupKey: 'project-b', workspaceKey: 'project-b', serverId },
            { type: 'session', sessionId: 'other', serverId, groupKey: 'project-b', groupKind: 'project', folderId: null },
        ], sessionSections: [{ address: { serverId, sectionId: 'section-b' },
            display: { status: 'available', value: { name: 'B Section', icon: null } }, sortKey: null },
            { address: { serverId: ACTIVE_SCOPE.serverId, sectionId: 'section-a' },
                display: { status: 'available', value: { name: 'A Section', icon: null } }, sortKey: null }] });
        try {
            await waitForHomeGovernance(() => {
                const source = hook.getCurrent().prepareTreeRowSource(treeRowId.session(serverId, 'other'));
                expect(source).not.toBeNull();
                if (!source) return;
                expect(hook.getCurrent().entityDragDrop.runtime.getDestinations(source.sourceId)).toEqual(expect.arrayContaining([
                    expect.objectContaining({ admission: expect.objectContaining({ status: 'allowed', effect: expect.objectContaining({
                        actionId: 'session.section.set', input: { sessionId: 'other', sectionId: 'section-b' },
                    }) }) }),
                ]));
                source.dispose();
            });
            home.requests.length = 0;
            await act(async () => {
                expect(await hook.getCurrent().moveToFolder(serverId, 'other', 'section-a')).toBe(false);
            });
            expect(home.requests.filter(request => request.path === path)).toEqual([]);
            await act(async () => {
                expect(await hook.getCurrent().moveToFolder(serverId, 'other', 'section-b')).toBe(true);
            });
            expect(home.requests.filter(request => request.path === path)).toEqual([expect.objectContaining({
                serverUrl, token: createAccountTokenForTests(accountId), input: { folderId: 'section-b' },
            })]);
            expect(getStorage().getState().profileScope).toEqual(ACTIVE_SCOPE);
        } finally {
            await hook.unmount();
        }
    });

    it('retires a captured Home-B approval only when that source Account retires', async () => {
        const serverId = 'srv_server_b';
        const homeB = await home.addHome({ name: 'Captured Drag Home', serverUrl: 'https://server-b.example.test',
            serverIdentityId: serverId, accountId: 'account-b', active: false });
        await home.requireUiApproval(homeB, 'session.section.set');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
        const hook = await renderHook(() => ({
            bindings: useServerCredentialAccountScopeBindings([serverId]), actions: useMountedActionExecution(null),
        }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().bindings.get(serverId)?.isCurrent()).toBe(true));
            const captured = hook.getCurrent().bindings.get(serverId)!;
            let result: Promise<ActionExecuteResult> | undefined;
            act(() => { result = hook.getCurrent().actions.executeCaptured(captured, 'session.section.set',
                { sessionId: 'other', sectionId: 'section-b' }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().actions.approval.approvalId).not.toBeNull());
            const artifactId = hook.getCurrent().actions.approval.approvalId;
            await act(async () => { await home.switchAccount(ACTIVE_SCOPE.serverId, 'replacement-a'); });
            expect(captured.isCurrent()).toBe(true);
            expect(hook.getCurrent().actions.approval.approvalId).toBe(artifactId);
            await act(async () => { await home.switchAccount(serverId, 'replacement-b'); });
            expect(await result!).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            await waitForHomeGovernance(() => expect(hook.getCurrent().actions.approval.approvalId).toBeNull());
            expect(home.requests.filter(request => request.path === '/v2/session-organization/folder-assignments/other')).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it.each(['browser', 'keyboard'] as const)('reorders workspaces through the %s boundary with folders disabled', async inputKind => {
        getStorage().setState({ profileScope: ACTIVE_SCOPE });
        const projectA: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header', title: 'Project A', headerKind: 'project', groupKey: 'project-a', workspaceKey: 'project-a',
            workspace, serverId: ACTIVE_SCOPE.serverId,
        };
        const projectB: Extract<SessionListIndexItem, { type: 'header' }> = {
            ...projectA, title: 'Project B', groupKey: 'project-b', workspaceKey: 'project-b',
            workspace: { ...workspace, rootPath: '/repo/b' },
        };
        let finishWrite = () => {};
        const write = new Promise<void>(resolve => { finishWrite = resolve; });
        const setOrder = vi.fn(async (_next: Record<string, string[]>) => { if (inputKind === 'browser') await write; });
        const hook = await renderInteractions({ listItems: [projectA, projectB], folderActionsEnabled: false,
            isFolderActionsEnabledForServerId: () => false, setSessionWorkspaceOrderV1: setOrder });
        const sourceId = treeRowId.workspaceRoot('project-b');
        const viewport = Object.assign(document.createElement('div'), {
            // jsdom has no layout; the real measurement owner prefers this DOM boundary.
            getBoundingClientRect: () => new DOMRect(0, 0, 300, 300),
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 300),
        });
        const source = document.createElement('div');
        document.body.append(viewport, source);
        const sourceHook = await renderHook(() => useEntityDragDomBinding({
            runtime: hook.getCurrent().entityDragDrop.runtime, enabled: true,
            begin: () => hook.getCurrent().handleDragStart(sourceId) ?? null,
        }));
        const dispatch = (target: HTMLElement, type: string) => target.dispatchEvent(new MouseEvent(type,
            { bubbles: true, cancelable: true, clientX: 10, clientY: 51 }));
        const attachViewport = (node: typeof viewport | null) => {
            // The DOM ref is the platform boundary; keep the existing native storage harness
            // underneath the real list/runtime path rather than starting browser persistence.
            platform.os = 'web';
            hook.getCurrent().handleTreeViewportMeasure(node);
            platform.os = 'ios';
        };
        act(() => {
            platform.os = 'web';
            sourceHook.getCurrent()(source);
            platform.os = 'ios';
        });
        try {
            await act(async () => {
                attachViewport(viewport);
                hook.getCurrent().registerTreeRowBounds(treeRowId.workspaceRoot('project-a'), { measureInWindow: callback => callback(0, 50, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(sourceId, { measureInWindow: callback => callback(0, 110, 300, 40) });
            });
            if (inputKind === 'keyboard') {
                let committed: Promise<boolean> | undefined;
                await act(async () => { committed = hook.getCurrent().applyKeyboardMove(sourceId, 'up')?.committed; });
                expect(await committed).toBe(true);
            } else {
                await act(async () => { dispatch(source, 'dragstart'); });
                await act(async () => { dispatch(viewport, 'dragover'); });
                expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission?.status).toBe('allowed');
                // Detaching this receiver makes a browser drop inert; its source can still cancel.
                act(() => { attachViewport(null); });
                await act(async () => { dispatch(viewport, 'drop'); });
                expect(setOrder).not.toHaveBeenCalled();
                expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('carrying');
                act(() => { dispatch(source, 'dragend'); });
                expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
                await act(async () => {
                    attachViewport(viewport);
                    dispatch(source, 'dragstart');
                });
                await act(async () => { dispatch(viewport, 'dragover'); });
                await act(async () => { dispatch(viewport, 'drop'); });
                await vi.waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
                expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot()).toMatchObject({ phase: 'pending', item: { kind: 'session-workspace' } });
                act(() => { dispatch(source, 'dragend'); });
                expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot()).toMatchObject({ phase: 'pending', item: { kind: 'session-workspace' } });
                // A new gesture must not retire the source whose write is still pending.
                act(() => { expect(dispatch(source, 'dragstart')).toBe(false); });
                expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot()).toMatchObject({ phase: 'pending', item: { kind: 'session-workspace' } });
                expect(setOrder).toHaveBeenCalledTimes(1);
                await act(async () => { finishWrite(); });
                await vi.waitFor(() => expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).not.toBe('pending'));
            }
            expect(setOrder.mock.calls[0]?.[0]).toEqual({
                [buildSessionWorkspaceOrderScopeKey(ACTIVE_SCOPE.serverId)]: [
                    buildSessionWorkspaceOrderItemKey('project-b'), buildSessionWorkspaceOrderItemKey('project-a'),
                ],
            });
            expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(0);
        } finally {
            finishWrite();
            hook.getCurrent().handleDragCancel();
            source.remove(); viewport.remove(); await sourceHook.unmount(); await hook.unmount();
        }
    });

    it('scrolls an offscreen staged destination into view even for a row taller than the viewport and hides a refused step', async () => {
        const scrollToOffset = vi.fn();
        const initialInput = buildInteractionsInput({ listItems: twoSessionListItems, scrollToOffset });
        const hook = await renderMutableInteractions(initialInput);
        const sessionKey = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's2' });
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 300) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's1'), { measureInWindow: callback => callback(0, 1000, 300, 500) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's2'), { measureInWindow: callback => callback(0, 160, 300, 40) });
                hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Two', key: ' ' });
            });
            await act(async () => { hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Two', key: 'ArrowUp' }); });
            expect(scrollToOffset).toHaveBeenCalled();
            expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(0);
            await act(async () => { hook.getCurrent().handleTreeScroll({ nativeEvent: { contentOffset: { y: 900 } } }); });
            expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(1);
            expect(hook.getCurrent().dropOverlayShared.overlayTop.value).toBe(99);
            await hook.rerender({ ...initialInput, sessionListLayoutV1: 'recent_activity' });
            expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(0);
            act(() => { hook.getCurrent().stagedMove.cancel(); });
            expect(initialInput.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('reports ordering refusals and the relation verdict for list-only Session rows', async () => {
        getStorage().setState({ sessions: {} });
        const initialInput = buildInteractionsInput({ listItems: twoSessionListItems, sessionListLayoutV1: 'recent_activity' });
        const hook = await renderMutableInteractions(initialInput);
        const sessionKey = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's2' });
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 300) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's1'), { measureInWindow: callback => callback(0, 100, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's2'), { measureInWindow: callback => callback(0, 160, 300, 40) });
                hook.getCurrent().handleDragStart(sessionKey);
            });
            act(() => { hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a', pointer: { x: 10, y: 105 } }); });
            const runtime = hook.getCurrent().entityDragDrop.runtime;
            expect(runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'ordering-mode' } });
            let outcome: Awaited<ReturnType<typeof runtime.release>> = null;
            await act(async () => { outcome = await runtime.release(); });
            expect(outcome).toMatchObject({ status: 'refused', reason: { code: 'ordering-mode' } });
            expect(initialInput.setSessionListGroupOrderV1).not.toHaveBeenCalled();
            expect(folderAssignmentRequests()).toEqual([]);
            act(() => hook.getCurrent().handleDragCancel());
            await hook.rerender({ ...initialInput, sessionListLayoutV1: 'projects' });
            await act(async () => { hook.getCurrent().handleDragStart(sessionKey); });
            act(() => { hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a', pointer: { x: 10, y: 120 } }); });
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'unavailable' }, preview: { target: 's1' } });
            expect(initialInput.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        } finally {
            act(() => hook.getCurrent().handleDragCancel());
            await hook.unmount();
        }
    });

    it('releases over the dragged row own position without a refusal outcome or organization write', async () => {
        const initialInput = buildInteractionsInput({ listItems: twoSessionListItems });
        const hook = await renderMutableInteractions(initialInput);
        const sessionKey = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's2' });
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 300) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's1'), { measureInWindow: callback => callback(0, 100, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's2'), { measureInWindow: callback => callback(0, 160, 300, 40) });
                hook.getCurrent().handleDragStart(sessionKey);
            });
            act(() => { hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a', pointer: { x: 10, y: 165 } }); });
            const runtime = hook.getCurrent().entityDragDrop.runtime;
            expect(runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'no-target' } });
            let outcome: Awaited<ReturnType<typeof runtime.release>> = null;
            await act(async () => { outcome = await runtime.release(); });
            expect(outcome).toBeNull();
            expect(initialInput.setSessionListGroupOrderV1).not.toHaveBeenCalled();
            expect(initialInput.setSessionWorkspaceOrderV1).not.toHaveBeenCalled();
            expect(folderAssignmentRequests()).toEqual([]);
        } finally {
            act(() => hook.getCurrent().handleDragCancel());
            await hook.unmount();
        }
    });

    it.each(['workspace-root', 'folder'] as const)('outlines the admitted lead row for pointer Put under in a %s, including after scrolling', async containerKind => {
        await loadSyncSingletonForTests();
        const account = await restoreServerAccountForTest({ serverUrl: 'https://pointer-put-under.test', accountId: ACTIVE_SCOPE.accountId,
            credentials: { token: createAccountTokenForTests(ACTIVE_SCOPE.accountId) }, request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path.endsWith('/manager/options')) {
                    const input = JSON.parse(String(init?.body)) as { candidateSessionIds: string[] };
                    return Response.json({ sessionId: 's2', currentManagerSessionId: null,
                        candidates: input.candidateSessionIds.map(sessionId => ({ sessionId, allowed: true })) });
                }
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: ACTIVE_SCOPE.accountId });
                if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
                if (path === '/v1/artifacts') return Response.json([]);
                return Response.json({});
            } });
        const serverId = account.home.id;
        const sessions = Object.fromEntries(['s1', 's2'].map(id => [id, createSessionFixture({ id, serverId })]));
        getStorage().setState({ profileScope: { serverId, accountId: ACTIVE_SCOPE.accountId }, sessions } as never);
        const currentWorkspace = { ...workspace, serverId };
        const folderGroupKey = buildSessionSectionGroupKey({ serverId, sectionId: 'folder-a' });
        const items = twoSessionListItems.flatMap<SessionListIndexItem>(item => {
            if (item.type === 'session') return [{ ...item, serverId, workspace: currentWorkspace,
                ...(containerKind === 'folder' ? { folderId: 'folder-a', folderDepth: 1, groupKey: folderGroupKey, groupKind: 'folder' as const } : {}) }];
            const header = { ...item, serverId, workspace: currentWorkspace };
            return containerKind === 'folder' ? [header, {
                type: 'header', title: 'Folder A', headerKind: 'folder', folderId: 'folder-a', folderDepth: 0,
                groupKey: folderGroupKey, workspace: currentWorkspace, serverId,
            }] : [header];
        });
        const hook = await renderInteractions({ listItems: items, sessionSections: containerKind === 'folder'
            ? [{ address: { serverId, sectionId: 'folder-a' }, display: { status: 'available', value: { name: 'Folder A', icon: null } }, sortKey: null }] : [] });
        const sessionKey = sessionAddressKey({ serverId, sessionId: 's2' });
        const groupKey = containerKind === 'folder' ? folderGroupKey : 'project-a';
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 50, 300, 300) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.workspaceRoot('project-a'), { measureInWindow: callback => callback(0, 50, 300, 40) });
                if (containerKind === 'folder') hook.getCurrent().registerTreeRowBounds(treeRowId.folder(serverId, 'folder-a'),
                    { measureInWindow: callback => callback(0, 100, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(serverId, 's1'), { measureInWindow: callback => callback(0, 150, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(serverId, 's2'), { measureInWindow: callback => callback(0, 210, 300, 40) });
                hook.getCurrent().handleDragStart(sessionKey);
            });
            await vi.waitFor(() => {
                let resolved: UseSessionInlineDragResolvedDrop | undefined;
                act(() => { resolved = hook.getCurrent().resolveDropResult({ sessionKey, groupKey, pointer: { x: 10, y: 170 } }); });
                expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission).toMatchObject({ status: 'allowed',
                    effect: { actionId: 'session.manager.set', input: { sessionId: 's2', managerSessionId: 's1' } } });
                expect(resolved!.geometry).toMatchObject({ kind: 'outline', targetId: treeRowId.session(serverId, 's1'),
                    geometry: { top: 100, height: 40 } });
            });
            await act(async () => { hook.getCurrent().handleTreeScroll({ nativeEvent: { contentOffset: { y: 80 } } }); });
            let scrolled: UseSessionInlineDragResolvedDrop | undefined;
            act(() => { scrolled = hook.getCurrent().resolveDropResult({ sessionKey, groupKey, pointer: { x: 10, y: 90 } }); });
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission?.status).toBe('allowed');
            expect(scrolled!.geometry).toMatchObject({ kind: 'outline', targetId: treeRowId.session(serverId, 's1'),
                geometry: { top: 20, height: 40 } });
        } finally {
            act(() => hook.getCurrent().handleDragCancel());
            await hook.unmount();
            await account.dispose();
        }
    });

    it('keeps measured supporting sections out of implicit drop zones without measuring on pointer moves', async () => {
        const hook = await renderInteractions({ listItems: twoSessionListItems });
        const sessionKey = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's2' });
        const measureSupport = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 40, 300, 120));
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 300) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.workspaceRoot('project-a'), { measureInWindow: callback => callback(0, 0, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(SESSION_LIST_SUPPORTING_SECTIONS_NODE.id, { measureInWindow: measureSupport });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's1'), { measureInWindow: callback => callback(0, 160, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's2'), { measureInWindow: callback => callback(0, 220, 300, 40) });
                hook.getCurrent().handleDragStart(sessionKey);
            });
            const measurements = measureSupport.mock.calls.length;
            for (let index = 0; index < 10; index++) {
                let resolved: UseSessionInlineDragResolvedDrop | undefined;
                act(() => { resolved = hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a', pointer: { x: 10, y: 140 } }); });
                expect(resolved!.geometry).toEqual({ kind: 'none' });
                expect(resolved!.result.visual).toEqual({ kind: 'none' });
                expect(resolved!.result.instruction.kind).toBe('idle');
            }
            expect(measurements).toBeGreaterThan(0);
            expect(measureSupport).toHaveBeenCalledTimes(measurements);
            // Retiring the presentation cell restores the genuine root-before-first gap.
            act(() => hook.getCurrent().unregisterTreeRowBounds(SESSION_LIST_SUPPORTING_SECTIONS_NODE.id));
            let gap: UseSessionInlineDragResolvedDrop | undefined;
            act(() => { gap = hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a', pointer: { x: 10, y: 140 } }); });
            expect(gap!.geometry.kind).toBe('line');
        } finally {
            act(() => hook.getCurrent().handleDragCancel());
            await hook.unmount();
        }
    });

    it('keeps the Payments header under the pointer when scroll changes before measured rows publish', async () => {
        const folderId = 'payments';
        const folder: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header', title: 'Payments', headerKind: 'folder', folderId, folderDepth: 0,
            groupKey: buildSessionSectionGroupKey({ serverId: ACTIVE_SCOPE.serverId, sectionId: folderId }),
            serverId: ACTIVE_SCOPE.serverId, workspace,
        };
        const hook = await renderInteractions({ listItems: [folder, ...twoSessionListItems],
            sessionSections: [{ address: { serverId: ACTIVE_SCOPE.serverId, sectionId: folderId },
                display: { status: 'available', value: { name: 'Payments', icon: null } }, sortKey: null }] });
        const sessionKey = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's2' });
        let offset = 200;
        const row = (contentY: number) => ({ getBoundingClientRectFn: () => ({ x: 0, y: 100 + contentY - offset, width: 300, height: 40 }) });
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ getBoundingClientRectFn: () => ({ x: 0, y: 100, width: 300, height: 600 }) });
                hook.getCurrent().handleTreeScroll({ nativeEvent: { contentOffset: { y: offset } } });
            });
            await act(async () => {
                hook.getCurrent().registerTreeRowBounds(treeRowId.folder(ACTIVE_SCOPE.serverId, folderId), row(400));
                hook.getCurrent().registerTreeRowBounds(treeRowId.workspaceRoot('project-a'), row(560));
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's1'), row(620));
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's2'), row(680));
                hook.getCurrent().handleDragStart(sessionKey);
                // A DOM measurement is synchronous, but its Promise publishes in a later microtask.
                // Scrolling during that interval must not convert the old window bounds with a new offset.
                offset = 0;
                hook.getCurrent().handleTreeScroll({ nativeEvent: { contentOffset: { y: offset } } });
            });
            let resolved: UseSessionInlineDragResolvedDrop | undefined;
            act(() => { resolved = hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a', pointer: { x: 10, y: 520 } }); });
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission).toMatchObject({ status: 'allowed',
                effect: { actionId: 'session.section.set', input: { sessionId: 's2', sectionId: folderId } } });
            expect(resolved!.geometry).toMatchObject({ kind: 'outline',
                targetId: treeRowId.folder(ACTIVE_SCOPE.serverId, folderId), geometry: { top: 400, height: 40 } });
        } finally {
            act(() => hook.getCurrent().handleDragCancel());
            await hook.unmount();
        }
    });

    it('reports the first-gap Put under refusal through the same entity admission and leaves no overlay', async () => {
        const hook = await renderInteractions({ listItems: twoSessionListItems });
        const sessionKey = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's2' });
        try {
            await act(async () => { hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Two', key: ' ' }); });
            await act(async () => { hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Two', key: 'ArrowUp' }); });
            await act(async () => { hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Two', key: 'ArrowRight' }); });
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission)
                .toMatchObject({ status: 'refused', reason: { code: 'no-row-above' } });
            expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(0);
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission?.status).not.toBe('allowed');
            act(() => hook.getCurrent().stagedMove.cancel());
        } finally { await hook.unmount(); }
    });

    it('draws the existing list overlay for a staged keyboard move and hides it on cancel', async () => {
        const hook = await renderInteractions({ listItems: twoSessionListItems });
        const sessionKey = sessionAddressKey({ serverId: ACTIVE_SCOPE.serverId, sessionId: 's2' });
        try {
            await act(async () => {
                hook.getCurrent().handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 300) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's1'), { measureInWindow: callback => callback(0, 100, 300, 40) });
                hook.getCurrent().registerTreeRowBounds(treeRowId.session(ACTIVE_SCOPE.serverId, 's2'), { measureInWindow: callback => callback(0, 160, 300, 40) });
                hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Second', key: ' ' });
            });
            await act(async () => { hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Second', key: 'ArrowUp' }); });
            expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().admission?.status).toBe('allowed');
            expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(1);
            expect(hook.getCurrent().dropOverlayShared.overlayTop.value).toBe(99);
            act(() => { hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Second', key: 'Escape' }); });
            expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(0);
        } finally { await hook.unmount(); }
    });

    it('keeps final native release geometry and source topology through asynchronous pre-dispatch measurement', async () => {
        const scope = ACTIVE_SCOPE;
        const nativeItems = twoSessionListItems.map(item => ({ ...item, serverId: scope.serverId,
            workspace: { ...workspace, serverId: scope.serverId } }));
        const setOrder = vi.fn(async (_next: Record<string, string[]>) => {});
        const initialInput = buildInteractionsInput({ listItems: nativeItems, setSessionListGroupOrderV1: setOrder });
        const hook = await renderMutableInteractions(initialInput);
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
                const resolved = hook.getCurrent().resolveDropResult({ sessionKey, groupKey: 'project-a',
                    pointer: { x: 10, y: 105 } });
                expect(runtime.getSnapshot().admission?.status).toBe('allowed');
                completion = hook.getCurrent().handleTreeDropResult({ sessionKey, groupKey: 'project-a',
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
            // Project ordering belongs to the list's projected group, not a folder-root scope.
            expect(setOrder.mock.calls[0]?.[0]?.['project-a']).toEqual([
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
        const hook = await renderMutableInteractions(initialInput);
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
            await hook.rerender({ ...initialInput, listItems: items.slice(0, -1), sessionListLayoutV1: 'recent_activity' });
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
            sessionSections: [{ address: { serverId: ACTIVE_SCOPE.serverId, sectionId: 'hidden-folder' },
                display: { status: 'available', value: { name: 'Hidden', icon: null } }, sortKey: null }] });
        const hook = await renderMutableInteractions(initialInput);
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
        const hook = await renderMutableInteractions(initialInput);
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
                groupKey: buildSessionSectionGroupKey({ serverId: 'srv_server_a', sectionId: 'folder-a' }),
                workspace, serverId: 'srv_server_a' }];
            await hook.rerender({ ...initialInput, listItems: folderItems, sessionListLayoutV1: 'recent_activity',
                sessionSections: [{ address: { serverId: ACTIVE_SCOPE.serverId, sectionId: 'folder-a' },
                    display: { status: 'available', value: { name: 'Folder A', icon: null } }, sortKey: null }],
            });
            const destinations = runtime.getDestinations('chooser-session');
            expect(destinations).toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: { kind: 'folder-assignment', folderId: 'folder-a' },
                    admission: expect.objectContaining({ status: 'allowed', effect: expect.objectContaining({ actionId: 'session.section.set' }) }) }),
                expect.objectContaining({ destination: expect.objectContaining({ instructionKind: 'reorder-after' }),
                    admission: expect.objectContaining({ status: 'refused', reason: expect.objectContaining({ code: 'date-ordering-mode' }) }) }),
            ]));
            // The canonical chooser omits unchanged places, while direct admission still refuses them.
            expect(destinations).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ destination: { kind: 'folder-assignment', folderId: null } }),
            ]));
            expect(await runtime.perform('chooser-session', targetId!, { kind: 'folder-assignment', folderId: null }))
                .toMatchObject({ status: 'refused', reason: { code: 'no-change' } });
            // A previously enumerated target is only a proposal: final admission reads current membership.
            await hook.rerender({ ...initialInput, listItems: [latestItems[0]!, latestItems[1]!] });
            expect(await runtime.perform('chooser-session', targetId!, previousRelation.destination))
                .toMatchObject({ status: 'refused', reason: { code: 'target-missing' } });
            expect(initialInput.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        } finally {
            retire();
            await hook.unmount();
        }
    });

    it('uses the Section Action for mounted membership and refuses a generic move policy bypass', async () => {
        home.requests.length = 0;
        const folderItems: SessionListIndexItem[] = [
            listItems[0]!,
            {
                type: 'header',
                title: 'Folder A',
                headerKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                groupKey: buildSessionSectionGroupKey({ serverId: ACTIVE_SCOPE.serverId, sectionId: 'folder-a' }),
                workspace,
                serverId: 'srv_server_a',
            },
            listItems[1]!,
        ];
        const hook = await renderInteractions({
            listItems: folderItems,
            sessionSections: [{ address: { serverId: ACTIVE_SCOPE.serverId, sectionId: 'folder-a' },
                display: { status: 'available', value: { name: 'Folder A', icon: null } }, sortKey: null }],
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
        expect(output).toEqual({ status: 'refused', reason: 'unsupported_operation' });
        expect(folderAssignmentRequests()).toEqual([]);
        await act(async () => {
            expect(await hook.getCurrent().moveToFolder(ACTIVE_SCOPE.serverId, 's1', 'folder-a')).toBe(true);
        });

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
                groupKey: buildSessionSectionGroupKey({ serverId: ACTIVE_SCOPE.serverId, sectionId: 'folder-a' }),
                workspace,
                serverId: 'srv_server_a',
            },
            listItems[1]!,
        ];
        const hook = await renderInteractions({
            listItems: folderItems,
            isFolderActionsEnabledForServerId: (serverId) => serverId === 'srv_server_b',
            sessionSections: [{ address: { serverId: ACTIVE_SCOPE.serverId, sectionId: 'folder-a' },
                display: { status: 'available', value: { name: 'Folder A', icon: null } }, sortKey: null }],
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
            sessionListLayoutV1: 'recent_activity' as const,
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
                groupKey: buildSessionSectionGroupKey({ serverId: ACTIVE_SCOPE.serverId, sectionId: 'folder-a' }),
                workspace,
                serverId: 'srv_server_a',
            },
            listItems[1]!,
        ];
        const hook = await renderInteractions({
            listItems: folderItems,
            sessionSections: [{ address: { serverId: ACTIVE_SCOPE.serverId, sectionId: 'folder-a' },
                display: { status: 'available', value: { name: 'Folder A', icon: null } }, sortKey: null }],
        });

        await act(async () => {
            hook.getCurrent().handleDragStart(sessionAddressKey({ serverId: 'srv_server_a', sessionId: 's1' }));
            hook.getCurrent().handleTreeDropResult({
                sessionKey: SESSION_ONE_KEY,
                groupKey: 'project-a',
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
