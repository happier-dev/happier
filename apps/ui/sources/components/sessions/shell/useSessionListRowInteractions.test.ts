import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { DEFAULT_SESSION_FOLDERS_V1 } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useSessionListRowInteractions,
    type UseSessionListRowInteractionsInput,
} from './useSessionListRowInteractions';
import { treeRowId } from './drop-resolution/treeRowId';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setSessionFolderAssignmentSpy = vi.hoisted(() => vi.fn(async () => {}));
const resolveSessionOrganizationMutationScopeSpy = vi.hoisted(() => vi.fn(async (serverId: string) => ({
    ok: true as const,
    scope: {
        credentials: { token: 'folder-token', secret: 'folder-secret' },
        serverId,
        serverIdAliases: ['profile-a', 'legacy-a'],
        serverUrl: 'https://server-a.example.test',
    },
})));

vi.mock('react-native-reanimated', () => ({
    Easing: {
        bezier: () => () => 0,
        linear: () => 0,
    },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedReaction: vi.fn(),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: () => Promise<void>) => [null, () => { void action(); }],
}));

vi.mock('@/sync/ops/sessionOrganization', () => ({
    resolveSessionOrganizationMutationScope: resolveSessionOrganizationMutationScopeSpy,
    writeSessionOrganizationFolderAssignment: setSessionFolderAssignmentSpy,
}));

describe('useSessionListRowInteractions', () => {
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
            sessionFoldersV1: DEFAULT_SESSION_FOLDERS_V1,
            listItems,
            currentGroupOrderMap: {},
            currentWorkspaceOrderMap: {},
            sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'activity',
            setSessionListGroupOrderV1: vi.fn(),
            setSessionWorkspaceOrderV1: vi.fn(),
            setSessionFoldersV1: vi.fn(),
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

    it('persists drag folder assignments under the list projection server id', async () => {
        setSessionFolderAssignmentSpy.mockClear();
        resolveSessionOrganizationMutationScopeSpy.mockClear();
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

        await act(async () => {
            hook.getCurrent().handleDragStart('server-a:s1');
            hook.getCurrent().handleTreeDropResult({
                sessionKey: 'server-a:s1',
                groupKey: 'project-a',
                dataIndex: 2,
                result: {
                    instruction: {
                        kind: 'nest-into',
                        targetId: treeRowId.folder('folder-a'),
                        containerId: treeRowId.folder('folder-a'),
                        parentId: treeRowId.folder('folder-a'),
                        depth: 1,
                    },
                    visual: { kind: 'outline', targetId: treeRowId.folder('folder-a') },
                },
            });
        });

        await vi.waitFor(() => {
            expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith({
                scope: {
                    credentials: { token: 'folder-token', secret: 'folder-secret' },
                    serverId: 'server-a',
                    serverIdAliases: ['profile-a', 'legacy-a'],
                    serverUrl: 'https://server-a.example.test',
                },
                sessionId: 's1',
                folderId: 'folder-a',
            });
        });
        expect(resolveSessionOrganizationMutationScopeSpy).toHaveBeenCalledWith('server-a');

        await hook.unmount();
    });

    it('exposes only drag snapshot and numeric overlay state for pointer drag visuals', async () => {
        const hook = await renderInteractions();

        await act(async () => {
            hook.getCurrent().handleDragStart('server-a:s1');
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

        expect(hook.getCurrent().draggingSessionKey).toBe('server-a:s1');
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
        const setSessionListGroupOrderV1 = vi.fn();
        const dateModeInput = {
            listItems: twoSessionListItems,
            sessionListOrderingModeV1: 'updated' as const,
            sessionListSectionModeV1: 'activity' as const,
            setSessionListGroupOrderV1,
        };
        const hook = await renderInteractions(dateModeInput);

        await act(async () => {
            hook.getCurrent().handleDragStart('server-a:s2');
            hook.getCurrent().handleTreeDropResult({
                sessionKey: 'server-a:s2',
                groupKey: 'project-a',
                dataIndex: 2,
                result: {
                    instruction: {
                        kind: 'reorder-before',
                        targetId: treeRowId.session('server-a', 's1'),
                        containerId: treeRowId.workspaceRoot('project-a'),
                        parentId: null,
                        depth: 0,
                    },
                    visual: { kind: 'line', targetId: treeRowId.session('server-a', 's1'), edge: 'top', depth: 0 },
                },
            });
        });

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

    it('suppresses exactly one folder-focus press immediately after a tree drag drop', async () => {
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
            hook.getCurrent().handleDragStart('server-a:s1');
            hook.getCurrent().handleTreeDropResult({
                sessionKey: 'server-a:s1',
                groupKey: 'project-a',
                dataIndex: 2,
                result: {
                    instruction: {
                        kind: 'nest-into',
                        targetId: treeRowId.folder('folder-a'),
                        containerId: treeRowId.folder('folder-a'),
                        parentId: treeRowId.folder('folder-a'),
                        depth: 1,
                    },
                    visual: { kind: 'outline', targetId: treeRowId.folder('folder-a') },
                },
            });
        });

        expect(hook.getCurrent().consumeFolderFocusPressAfterDrag()).toBe(true);
        expect(hook.getCurrent().consumeFolderFocusPressAfterDrag()).toBe(false);

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
