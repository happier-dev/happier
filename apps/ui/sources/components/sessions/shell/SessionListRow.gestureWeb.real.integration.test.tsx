import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { SessionListRow } from './sessionListRow';
import { SessionListHeaderItem } from './sessionListHeaderItem';
import { makeMutable } from 'react-native-reanimated';
import { View } from 'react-native';
import { isWorkspaceActionId } from '@happier-dev/protocol';
import { useSessionListRowInteractions } from './useSessionListRowInteractions';
import { getStorage } from '@/sync/domains/state/storage';
import { DEFAULT_SESSION_FOLDERS_V1 } from '@/sync/domains/session/folders';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { treeRowId } from './drop-resolution/treeRowId';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { SplitCanvasHost, type SplitCanvasHostControls } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceActionAdapter } from '@/components/appShell/workspace/workspaceActions';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { resolveWorkspaceEntityDrop, WORKSPACE_ENTITY_KINDS } from '@/components/appShell/workspace/workspaceEntityDrop';
import { presentPaneDropAdmission } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { StyleSheet } = await vi.importActual<typeof import('react-native')>('react-native-web');
    return createUnistylesMock({ styleSheet: { absoluteFillObject: StyleSheet.absoluteFillObject } });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await import('react-native-web');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View: native.View, Text: native.Text } };
});
vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'span', Octicons: 'span' }));
vi.mock('expo-image', () => ({ Image: 'img' }));

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
let cancelCarry = () => {};
afterEach(async () => {
    await act(async () => root?.unmount());
    cancelCarry();
    container?.remove();
    vi.restoreAllMocks();
});

// jsdom has neither layout nor pointer capture. Supply these OS boundaries while keeping
// the real RNW row, GestureDetector, Pan recognizer and semantic callbacks in the path.
function pointer(target: Element, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
    target.dispatchEvent(event);
}

describe('SessionListRow real web gesture', () => {
    it.each(['session', 'session-folder', 'session-workspace'] as const)('carries the real %s gesture through list interactions and pane registration', async (sourceKind) => {
        const scope = { serverId: 'server_a', accountId: 'account_a' };
        const session = createSessionFixture({ id: 'sess_pointer', serverId: scope.serverId });
        const sessionKey = sessionAddressKey({ serverId: scope.serverId, sessionId: session.id });
        const rowId = treeRowId.session(scope.serverId, session.id);
        const workspaceScopeHint = { serverId: scope.serverId, machineId: 'machine_a', rootPath: '/repo' };
        const project: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header', title: 'Project', headerKind: 'project', groupKey: 'group', workspaceKey: 'group', serverId: scope.serverId,
            workspaceScopeHint, workspace: { t: 'workspaceScope', ...workspaceScopeHint },
        };
        const folder: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header', title: 'Planning', headerKind: 'folder', folderId: 'planning', folderDepth: 0,
            groupKey: 'group:folder:planning', serverId: scope.serverId, workspace: project.workspace,
        };
        const items: SessionListIndexItem[] = [project, folder,
            { type: 'session', sessionId: session.id, serverId: scope.serverId, groupKey: 'group', groupKind: 'project', storageKind: 'persisted' },
        ];
        getStorage().setState({ profileScope: scope, sessions: { [session.id]: session } });
        const captured = new Set<number>();
        Object.defineProperties(HTMLElement.prototype, {
            setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) },
            releasePointerCapture: { configurable: true, value: (id: number) => captured.delete(id) },
            hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
        });
        // jsdom cannot measure layout: the sidebar and pane occupy disjoint window regions.
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return this.closest('[data-testid="split-canvas-host"]')
                ? new DOMRect(320, 80, 1080, 600) : new DOMRect(0, 0, 300, 80);
        });
        let state = createWorkspaceState({ id: 'anchor', target: { kind: 'session', params: { id: 'existing', ...scope } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } });
        let sequence = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog, getScope: () => scope,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `id:${++sequence}`,
            transport: { commit: () => {} }, onChange: () => {} });
        const workspace: WorkspaceNavigationContextValue = { active: true, get state() { return state; }, catalog,
            ...navigation, canGoBack: false, canGoForward: false,
            back: () => navigation.step(-1), forward: () => navigation.step(1),
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }), registerBackStep: () => () => {} };
        const controlsRef: { current: SplitCanvasHostControls | null } = { current: null };
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => controlsRef.current, createId: () => `id:${++sequence}` });
        const actions: string[] = [];
        let paneMount = 0;
        let runtime: ReturnType<typeof useEntityDragDropRuntime>;
        function ComposedRowAndPane() {
            runtime = useEntityDragDropRuntime();
            cancelCarry = () => runtime.cancel();
            const interactions = useSessionListRowInteractions({
                folderActionsEnabled: true, isFolderActionsEnabledForServerId: () => true,
                sessionFoldersV1: DEFAULT_SESSION_FOLDERS_V1, listItems: items,
                currentGroupOrderMap: {}, currentWorkspaceOrderMap: {}, sessionListOrderingModeV1: 'custom',
                sessionListSectionModeV1: 'activity', manualSessionOrderingEnabled: true,
                setSessionListGroupOrderV1: async () => {}, setSessionWorkspaceOrderV1: async () => {}, setSessionFoldersV1: async () => {},
                pinnedKeySet: new Set(), sessionTags: {}, setSessionPinForKey: () => {}, setSessionTagsForKey: () => {},
            });
            React.useEffect(() => {
                interactions.handleTreeViewportMeasure({ measureInWindow: callback => callback(0, 0, 300, 900) });
            }, [interactions.handleTreeViewportMeasure]);
            return <>{sourceKind === 'session' ? <SessionListRow session={session} rowViewModel={createSessionItemRowViewModel({ session })}
                serverId={scope.serverId} selected={false} isFirst isLast variant="default" compact={false}
                sessionKey={sessionKey} treeRowId={rowId} groupKey="group" reorderEnabled organizeMode={false}
                onDragStart={interactions.handleDragStart} onDropResult={interactions.handleTreeDropResult}
                onDragCancel={interactions.handleDragCancel} resolveDropResult={interactions.resolveDropResult}
                onTogglePinnedSessionKey={null} onSetTagsSessionKey={null} onNativeContextMenuOpenChangeSessionKey={null}
                isDragActive={interactions.draggingSessionKey !== null} isBeingDragged={interactions.draggingSessionKey === sessionKey}
                dataIndex={2} overlayShared={interactions.dropOverlayShared}
                onRegisterTreeRowBounds={interactions.registerTreeRowBounds} onUnregisterTreeRowBounds={interactions.unregisterTreeRowBounds} />
                : <SessionListHeaderItem item={sourceKind === 'session-folder' ? folder : project}
                    collapsedKeys={{}} projectHeaderViewModelByGroupKey={new Map()} hasMultipleMachines={false}
                    onOpenProject={() => {}} onCreateSessionFromWorkspaceScope={() => {}} onAddFolderToWorkspace={() => {}}
                    onRenameWorkspace={() => {}} onResetWorkspaceName={() => {}} onToggleCollapse={() => {}}
                    dataIndex={sourceKind === 'session-folder' ? 1 : 0} overlayShared={interactions.dropOverlayShared}
                    onRegisterTreeRowBounds={interactions.registerTreeRowBounds} onUnregisterTreeRowBounds={interactions.unregisterTreeRowBounds}
                    onFolderDragStart={interactions.handleDragStart} onFolderDropResult={interactions.handleTreeDropResult}
                    onFolderDragCancel={interactions.handleDragCancel} resolveDropResult={interactions.resolveDropResult} />}
                <SplitCanvasHost key={paneMount} state={{ root: state.root, focusedLeafId: state.focusedGroupId, maximizedLeafId: null }}
                    dispatch={() => {}} controlsRef={controlsRef} keyboardEnabled={false}
                    getLeafMinimumSizePx={() => ({ width: 400, height: 100 })}
                    renderLeafHeader={() => <View testID="pane-header" />}
                    retainedLeafContents={[{ id: 'anchor', leafId: 'group:1', isActive: true, render: () => <View testID="transcript" /> }]}
                    entityDrop={{ runtime, id: 'row-pane', scope, acceptedKinds: WORKSPACE_ENTITY_KINDS,
                        resolve: input => presentPaneDropAdmission(resolveWorkspaceEntityDrop({ ...input, workspace, scope, catalog, workspaceRefs: [] }),
                            { paneId: input.target.leafId, paneTitle: null, locateTab: () => null }),
                        execute: async effect => {
                            actions.push(effect.actionId);
                            if (!isWorkspaceActionId(effect.actionId)) throw new Error('Expected workspace Action');
                            const result = execute(effect.actionId, effect.input);
                            return result.ok ? { status: 'applied' } : { status: 'refused', reason: { code: result.errorCode, message: result.error } };
                        },
                    }} /></>;
        }
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => root?.render(<InjectedAuthProvider credentials={{ token: 'test-token' }}><ComposedRowAndPane /></InjectedAuthProvider>));
        const host = container.querySelector<HTMLElement>('[data-testid="split-canvas-host"]')!;
        const layout = Reflect.get(host, '__reactLayoutHandler') as (event: unknown) => void;
        await act(async () => layout({ nativeEvent: { layout: { x: 0, y: 0, width: 1080, height: 600 } } }));
        const slot = container.querySelector<HTMLElement>('[data-testid="split-canvas-content-slot-group:1"]')!;
        const slotLayout = Reflect.get(slot, '__reactLayoutHandler') as (event: unknown) => void;
        await act(async () => slotLayout({ nativeEvent: { layout: { x: 0, y: 40, width: 1080, height: 560 } } }));
        const sourceTestId = sourceKind === 'session' ? 'session-list-item-sess_pointer'
            : sourceKind === 'session-folder' ? 'session-folder-header-planning' : 'session-list-project-header:group';
        const row = container.querySelector(`[data-testid="${sourceTestId}"]`)!;
        expect(row).not.toBeNull();
        await act(async () => pointer(row, 'pointerdown', 50, 30));
        expect(captured.has(1)).toBe(true);
        // Separate pointer frames permit the real carrying-state row rerender before leaving the list.
        for (const [x, y] of [[80, 30], [120, 30], [600, 380], [1000, 380], [1380, 380]] as const) {
            await act(async () => pointer(row, 'pointermove', x, y));
        }
        expect(runtime!.getSnapshot()).toMatchObject({ phase: 'carrying', item: { kind: sourceKind } });
        if (sourceKind === 'session') expect(runtime!.getSnapshot().admission).toEqual(expect.objectContaining({ status: 'allowed' }));
        // Exercise a real pane-host retirement/re-registration, the live cancellation seam.
        // Replacing a destination must not retire the still-mounted pointer source.
        paneMount += 1;
        await act(async () => root?.render(<InjectedAuthProvider credentials={{ token: 'test-token' }}><ComposedRowAndPane /></InjectedAuthProvider>));
        const remountedHost = container.querySelector<HTMLElement>('[data-testid="split-canvas-host"]')!;
        const remountedLayout = Reflect.get(remountedHost, '__reactLayoutHandler') as (event: unknown) => void;
        await act(async () => remountedLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1080, height: 600 } } }));
        await act(async () => pointer(row, 'pointermove', 1380, 380));
        if (sourceKind !== 'session') {
            // Folder/workspace references travel outside the list through the same owner,
            // but a Workspace pane does not declare either kind as an openable destination.
            expect(runtime!.getSnapshot()).toMatchObject({ phase: 'carrying', item: { kind: sourceKind }, targetId: null, admission: null });
            expect(runtime!.getPointer()).toEqual({ x: 1380, y: 380 });
            await act(async () => pointer(row, 'pointercancel', 1380, 380));
            expect(runtime!.getSnapshot().phase).toBe('idle');
            expect(actions).toEqual([]);
            expect(state.root.kind).toBe('leaf');
            return;
        }
        expect(runtime!.getSnapshot()).toMatchObject({ phase: 'carrying', item: { kind: 'session' },
            admission: { status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: { mode: 'splitRight' } } } });
        expect(container.querySelector('[data-testid="split-canvas-drop-overlay-group:1-right"]')).not.toBeNull();
        await act(async () => pointer(row, 'pointerup', 1380, 380));
        expect(actions).toEqual(['workspace.tabs.open']);
        expect(state.root.kind).toBe('split');
        expect(Object.values(state.tabs).map(tab => tab.target.params.id)).toEqual(['existing', session.id]);
    });

    it.each(['pointerup', 'pointercancel'])('captures a desktop carry and settles %s outside the row', async (terminalEvent) => {
        const captured = new Set<number>();
        Object.defineProperties(HTMLElement.prototype, {
            setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) },
            releasePointerCapture: { configurable: true, value: (id: number) => captured.delete(id) },
            hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
        });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            left: 0, top: 0, right: 300, bottom: 80, width: 300, height: 80, x: 0, y: 0, toJSON: () => ({}),
        });
        const session = createSessionFixture({ id: 'sess_pointer', serverId: 'server_a' });
        const onDragStart = vi.fn();
        const onDropResult = vi.fn();
        const onDragCancel = vi.fn();
        const resolveDropResult = vi.fn(() => ({
            result: { instruction: { kind: 'idle' as const }, visual: { kind: 'none' as const } },
            geometry: { kind: 'none' as const },
        }));
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root?.render(
            <InjectedAuthProvider credentials={{ token: 'test-token' }}>
                <SessionListRow session={session} rowViewModel={createSessionItemRowViewModel({ session })}
                    selected={false} isFirst isLast variant="default" compact={false}
                    sessionKey="sess_pointer" treeRowId="sess_pointer" groupKey="group" reorderEnabled organizeMode={false}
                    onDragStart={onDragStart} onDropResult={onDropResult} onDragCancel={onDragCancel} resolveDropResult={resolveDropResult}
                    onTogglePinnedSessionKey={null} onSetTagsSessionKey={null} onNativeContextMenuOpenChangeSessionKey={null}
                    isDragActive={false} isBeingDragged={false} dataIndex={0}
                    overlayShared={{ overlayVisible: makeMutable(0), overlayKind: makeMutable(0), overlayTop: makeMutable(0),
                        overlayHeight: makeMutable(0), overlayLeft: makeMutable(0), overlayRight: makeMutable(0), overlayDepth: makeMutable(0) }}
                    onRegisterTreeRowBounds={() => undefined} onUnregisterTreeRowBounds={() => undefined} />
            </InjectedAuthProvider>,
        ));
        const row = container.querySelector('[data-testid="session-list-item-sess_pointer"]');
        expect(row).not.toBeNull();
        await act(async () => { pointer(row!, 'pointerdown', 50, 30); });
        expect(captured.has(1)).toBe(true);
        expect(onDragStart).not.toHaveBeenCalled();
        await act(async () => { pointer(row!, 'pointermove', 80, 30); pointer(row!, 'pointermove', 120, 30); });
        expect(onDragStart).toHaveBeenCalledWith('sess_pointer');
        await act(async () => {
            pointer(row!, 'pointermove', 800, 30);
            pointer(row!, 'pointermove', 1000, 30);
            pointer(row!, terminalEvent, 1000, 30);
        });
        expect(resolveDropResult).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: { x: 1000, y: 30 } }));
        expect(onDropResult).toHaveBeenCalledTimes(terminalEvent === 'pointerup' ? 1 : 0);
        expect(onDragCancel).toHaveBeenCalledTimes(terminalEvent === 'pointercancel' ? 1 : 0);
        if (terminalEvent === 'pointerup') expect(captured.has(1)).toBe(false);
    });
});
