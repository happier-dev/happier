import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { SessionListHeaderItem } from './sessionListHeaderItem';
import { SessionSectionHeader, ProjectGroupHeader } from './sessionListChrome';
import { SessionListOrganizeModeProvider, useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';
import { useSessionListRowMoveActionHandlers } from './useSessionListRowMoveActionHandlers';
import { treeRowId } from './drop-resolution/treeRowId';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { EntityDragGrip } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';

const headerPlatform = vi.hoisted(() => ({ os: 'android' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const module = await createReactNativeWebMock();
    return { ...module, Platform: { ...module.Platform, get OS() { return headerPlatform.os; } } };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

function EnterOrganize() {
    const organize = useSessionListOrganizeMode();
    React.useEffect(() => organize.enter(), [organize.enter]);
    return null;
}
function matchesComponent(component: unknown) {
    return (node: ReactTestInstance) => node.type === component
        || (typeof component === 'object' && component !== null && 'type' in component && node.type === component.type);
}

describe('SessionListHeaderItem Organize source', () => {
    afterEach(standardCleanup);
    it.each((['folder', 'project'] as const).flatMap(headerKind => [
        { headerKind, platform: 'android', organize: true },
        { headerKind, platform: 'android', organize: false },
        { headerKind, platform: 'web', organize: false },
    ]))('$headerKind keeps header controls usable on $platform (Organize $organize)', async ({ headerKind, platform, organize }) => {
        headerPlatform.os = platform;
        const item = { type: 'header' as const, title: 'Planning', headerKind, groupKey: `${headerKind}:planning`,
            folderId: 'planning', serverId: 'server_a', workspaceKey: 'workspace_a',
            workspace: { t: 'workspaceRef' as const, serverId: 'server_a', workspaceRefId: 'workspace_a' },
            workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' } };
        const onPress = vi.fn();
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={{ token: 'test-token' }}>
                <SessionListOrganizeModeProvider>
                    {organize ? <EnterOrganize /> : null}
                    <SessionListHeaderItem item={item} collapsedKeys={{}} projectHeaderViewModelByGroupKey={new Map()}
                        hasMultipleMachines={false} onOpenProject={vi.fn()} onCreateSessionFromWorkspaceScope={vi.fn()}
                        onAddFolderToWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onResetWorkspaceName={vi.fn()}
                        onToggleCollapse={onPress}
                        overlayShared={{ overlayVisible: { value: 0 }, overlayKind: { value: 0 }, overlayTop: { value: 0 },
                            overlayHeight: { value: 0 }, overlayLeft: { value: 0 }, overlayRight: { value: 0 }, overlayDepth: { value: 0 } }}
                        resolveDropResult={() => ({ result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } }, geometry: { kind: 'none' } })}
                        onFolderDropResult={vi.fn()} />
                </SessionListOrganizeModeProvider>
            </InjectedAuthProvider>,
        );
        expect(screen.root.findAllByType(EntityDragGrip)).toHaveLength(organize ? 1 : 0);
        const header = screen.root.find(matchesComponent(headerKind === 'folder' ? SessionSectionHeader : ProjectGroupHeader));
        let wholeHeaderGesture = false;
        for (let ancestor = header.parent; ancestor; ancestor = ancestor.parent) {
            if (String(ancestor.type) === 'GestureDetector') wholeHeaderGesture = true;
        }
        expect(wholeHeaderGesture).toBe(false);
        if (organize) expect(screen.root.findByType(EntityDragGrip).parent?.props.gesture).toBeTruthy();
        await act(async () => header.props.onToggleCollapse());
        expect(onPress).toHaveBeenCalled();
    });
    it.each(['folder', 'project'] as const)('%s reuses move callbacks and menu items while dispatching the current label', async headerKind => {
        headerPlatform.os = 'web';
        const writes: Array<{ rowId: string; label: string; direction: 'up' | 'down' }> = [];
        const scope = { serverId: 'srv_header', machineId: 'machine_a', rootPath: '/repo' };
        function Header({ title }: { title: string }) {
            const getRowMoveActionHandlers = useSessionListRowMoveActionHandlers({
                openMoveSheetForTreeRow: async () => {},
                moveTreeRowToWorkspaceRoot: () => {},
                readSectionMoveMenuItems: () => null,
                moveTreeRowToSection: () => {},
                readSpaceMembershipMenu: () => null,
                moveTreeRowByKeyboard: (rowId, label, direction) => { writes.push({ rowId, label, direction }); },
            });
            return <InjectedAuthProvider credentials={{ token: 'test-token' }}>
                <SessionListHeaderItem
                    item={{ type: 'header', title, headerKind, groupKey: `${headerKind}:planning`,
                        folderId: 'planning', serverId: scope.serverId, workspaceKey: 'workspace_a',
                        workspace: { t: 'workspaceRef', serverId: scope.serverId, workspaceRefId: 'workspace_a' },
                        workspaceScopeHint: scope }}
                    collapsedKeys={{}} projectHeaderViewModelByGroupKey={new Map()}
                    hasMultipleMachines={false} onOpenProject={() => {}} onCreateSessionFromWorkspaceScope={() => {}}
                    onAddFolderToWorkspace={() => {}} onRenameWorkspace={() => {}} onResetWorkspaceName={() => {}}
                    onToggleCollapse={() => {}} getRowMoveActionHandlers={getRowMoveActionHandlers}
                />
            </InjectedAuthProvider>;
        }
        const screen = await renderScreen(<Header title="Planning" />);
        const findHeader = () => screen.root.find(matchesComponent(headerKind === 'folder' ? SessionSectionHeader : ProjectGroupHeader));
        const first = findHeader().props;
        expect(typeof first.onMoveUp).toBe('function');
        const menuItems = screen.root.find(matchesComponent(DropdownMenu)).props.items;
        for (const title of ['Planning', 'Renamed']) {
            await screen.update(<Header title={title} />);
            const next = findHeader().props;
            expect(next.onMoveUp).toBe(first.onMoveUp);
            expect(next.onMoveDown).toBe(first.onMoveDown);
            if (headerKind === 'folder') {
                expect(next.onMove).toBe(first.onMove);
                expect(next.onMoveToWorkspaceRoot).toBe(first.onMoveToWorkspaceRoot);
            }
            expect(screen.root.find(matchesComponent(DropdownMenu)).props.items).toBe(menuItems);
        }
        await act(async () => {
            first.onMoveUp();
            first.onMoveDown();
        });
        const rowId = headerKind === 'folder'
            ? treeRowId.folder(scope.serverId, 'planning')
            : treeRowId.workspaceRoot('project:planning');
        expect(writes).toEqual([
            { rowId, label: 'Renamed', direction: 'up' },
            { rowId, label: 'Renamed', direction: 'down' },
        ]);
    });

});
