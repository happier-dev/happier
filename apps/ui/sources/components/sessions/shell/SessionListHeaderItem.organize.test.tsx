import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { SessionListHeaderItem } from './sessionListHeaderItem';
import { FolderGroupHeader, ProjectGroupHeader } from './sessionListChrome';
import { SessionListOrganizeModeProvider, useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';
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
                        onToggleCollapse={onPress} onFocusFolder={onPress}
                        overlayShared={{ overlayVisible: { value: 0 }, overlayKind: { value: 0 }, overlayTop: { value: 0 },
                            overlayHeight: { value: 0 }, overlayLeft: { value: 0 }, overlayRight: { value: 0 }, overlayDepth: { value: 0 } }}
                        resolveDropResult={() => ({ result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } }, geometry: { kind: 'none' } })}
                        onFolderDropResult={vi.fn()} />
                </SessionListOrganizeModeProvider>
            </InjectedAuthProvider>,
        );
        expect(screen.root.findAllByType(EntityDragGrip)).toHaveLength(organize ? 1 : 0);
        const header = screen.root.find(matchesComponent(headerKind === 'folder' ? FolderGroupHeader : ProjectGroupHeader));
        let wholeHeaderGesture = false;
        for (let ancestor = header.parent; ancestor; ancestor = ancestor.parent) {
            if (String(ancestor.type) === 'GestureDetector') wholeHeaderGesture = true;
        }
        expect(wholeHeaderGesture).toBe(platform === 'web');
        if (organize) expect(screen.root.findByType(EntityDragGrip).parent?.props.gesture).toBeTruthy();
        await act(async () => header.props.onToggleCollapse());
        expect(onPress).toHaveBeenCalled();
    });
});
