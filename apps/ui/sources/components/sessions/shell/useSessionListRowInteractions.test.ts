import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({
    useSharedValue: (initial: unknown) => ({ value: initial }),
}));

const workspace: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo',
};

describe('useSessionListRowInteractions', () => {
    it('assigns a dragged session to a centered folder target when no reorder line is active', async () => {
        const { useSessionListRowInteractions } = await import('./useSessionListRowInteractions');
        const setSessionListGroupOrderV1 = vi.fn();
        const assignSessionFolder = vi.fn(async () => {});
        const listItems: SessionListIndexItem[] = [
            {
                type: 'session',
                sessionId: 's1',
                serverId: 'server-a',
                groupKey: 'folder-root',
                workspace,
            },
        ];

        type Input = Parameters<typeof useSessionListRowInteractions>[0] & {
            resolveFolderDropTarget?: (point: { absoluteX: number; absoluteY: number }) => {
                type: 'folder';
                folderId: string;
                workspace: SessionFolderWorkspaceRefV1;
                serverId: string | null;
            } | null;
            assignSessionFolder?: (params: {
                serverId: string;
                sessionId: string;
                folderId: string | null;
            }) => Promise<void>;
        };

        const hook = await renderHook(() => useSessionListRowInteractions({
            listItems,
            currentGroupOrderMap: {},
            canReorderSessions: true,
            setSessionListGroupOrderV1,
            pinnedKeyList: [],
            pinnedKeySet: new Set(),
            setPinnedSessionKeysV1: () => {},
            sessionTags: {},
            setSessionTagsV1: () => {},
            resolveFolderDropTarget: () => ({
                type: 'folder',
                folderId: 'folder-a',
                workspace,
                serverId: 'server-a',
            }),
            assignSessionFolder,
        } satisfies Input));

        await act(async () => {
            await hook.getCurrent().handleDragEnd('server-a:s1', 'folder-root', 0, {
                absoluteX: 10,
                absoluteY: 20,
                positionDelta: 0,
                dataIndex: 0,
            });
        });

        expect(assignSessionFolder).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 's1',
            folderId: 'folder-a',
        });
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('prefers the reorder line over a centered folder target when the dragged row moved between rows', async () => {
        const { useSessionListRowInteractions } = await import('./useSessionListRowInteractions');
        const setSessionListGroupOrderV1 = vi.fn();
        const assignSessionFolder = vi.fn(async () => {});
        const listItems: SessionListIndexItem[] = [
            { type: 'session', sessionId: 's1', serverId: 'server-a', groupKey: 'g1', workspace },
            { type: 'session', sessionId: 's2', serverId: 'server-a', groupKey: 'g1', workspace },
        ];

        const hook = await renderHook(() => useSessionListRowInteractions({
            listItems,
            currentGroupOrderMap: {},
            canReorderSessions: true,
            setSessionListGroupOrderV1,
            pinnedKeyList: [],
            pinnedKeySet: new Set(),
            setPinnedSessionKeysV1: () => {},
            sessionTags: {},
            setSessionTagsV1: () => {},
            resolveFolderDropTarget: () => ({
                type: 'folder',
                folderId: 'folder-a',
                workspace,
                serverId: 'server-a',
            }),
            assignSessionFolder,
        }));

        await act(async () => {
            await hook.getCurrent().handleDragEnd('server-a:s1', 'g1', 1, {
                absoluteX: 10,
                absoluteY: 20,
                positionDelta: 1,
                dataIndex: 0,
            });
        });

        expect(assignSessionFolder).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            g1: ['server-a:s2', 'server-a:s1'],
        });
        await hook.unmount();
    });

    it('preserves reorder when no folder drop target resolves', async () => {
        const { useSessionListRowInteractions } = await import('./useSessionListRowInteractions');
        const setSessionListGroupOrderV1 = vi.fn();
        const assignSessionFolder = vi.fn(async () => {});
        const listItems: SessionListIndexItem[] = [
            { type: 'session', sessionId: 's1', serverId: 'server-a', groupKey: 'g1' },
            { type: 'session', sessionId: 's2', serverId: 'server-a', groupKey: 'g1' },
        ];

        type Input = Parameters<typeof useSessionListRowInteractions>[0] & {
            resolveFolderDropTarget?: () => null;
            assignSessionFolder?: (params: {
                serverId: string;
                sessionId: string;
                folderId: string | null;
            }) => Promise<void>;
        };

        const hook = await renderHook(() => useSessionListRowInteractions({
            listItems,
            currentGroupOrderMap: {},
            canReorderSessions: true,
            setSessionListGroupOrderV1,
            pinnedKeyList: [],
            pinnedKeySet: new Set(),
            setPinnedSessionKeysV1: () => {},
            sessionTags: {},
            setSessionTagsV1: () => {},
            resolveFolderDropTarget: () => null,
            assignSessionFolder,
        } satisfies Input));

        await act(async () => {
            await hook.getCurrent().handleDragEnd('server-a:s1', 'g1', 1, {
                absoluteX: 10,
                absoluteY: 20,
                positionDelta: 1,
                dataIndex: 0,
            });
        });

        expect(assignSessionFolder).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            g1: ['server-a:s2', 'server-a:s1'],
        });
        await hook.unmount();
    });

    it('unassigns a folder session when its drop position lands in workspace root rows', async () => {
        const { useSessionListRowInteractions } = await import('./useSessionListRowInteractions');
        const setSessionListGroupOrderV1 = vi.fn();
        const assignSessionFolder = vi.fn(async () => {});
        const projectGroupKey = 'server:server-a:active:project:workspace-a';
        const folderGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo:folder-a';
        const listItems: SessionListIndexItem[] = [
            { type: 'header', title: '~/repo', headerKind: 'project', groupKey: projectGroupKey, workspace },
            {
                type: 'session',
                sessionId: 's1',
                serverId: 'server-a',
                groupKey: folderGroupKey,
                groupKind: 'folder',
                folderId: 'folder-a',
                workspace,
            },
            {
                type: 'session',
                sessionId: 's2',
                serverId: 'server-a',
                groupKey: projectGroupKey,
                groupKind: 'project',
                folderId: null,
                workspace,
            },
        ];

        const hook = await renderHook(() => useSessionListRowInteractions({
            listItems,
            currentGroupOrderMap: {},
            canReorderSessions: true,
            setSessionListGroupOrderV1,
            pinnedKeyList: [],
            pinnedKeySet: new Set(),
            setPinnedSessionKeysV1: () => {},
            sessionTags: {},
            setSessionTagsV1: () => {},
            resolveFolderDropTarget: () => null,
            assignSessionFolder,
        }));

        await act(async () => {
            await hook.getCurrent().handleDragEnd('server-a:s1', folderGroupKey, 1, {
                absoluteX: null,
                absoluteY: null,
                positionDelta: 1,
                dataIndex: 1,
            });
        });

        expect(assignSessionFolder).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 's1',
            folderId: null,
        });
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
