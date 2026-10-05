import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { DEFAULT_SESSION_FOLDERS_V1 } from '@/sync/domains/session/folders';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListRowInteractions, type UseSessionListRowInteractionsInput } from './useSessionListRowInteractions';
import { treeRowId } from './drop-resolution/treeRowId';

const scope = { serverId: 'lifecycle-home', accountId: 'lifecycle-account' };
const workspace = { t: 'workspaceScope', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo' } as const;
const items: SessionListIndexItem[] = [
    { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project', workspaceKey: 'project', workspace, serverId: scope.serverId },
    { type: 'session', sessionId: 'source', serverId: scope.serverId, storageKind: 'persisted', groupKey: 'project', groupKind: 'project', folderId: null, folderDepth: 0, workspace },
];
const sessionKey = sessionAddressKey({ serverId: scope.serverId, sessionId: 'source' });
const sourceRowId = treeRowId.session(scope.serverId, 'source');

function input(): UseSessionListRowInteractionsInput {
    return { folderActionsEnabled: true, isFolderActionsEnabledForServerId: () => true,
        sessionFoldersV1: DEFAULT_SESSION_FOLDERS_V1, listItems: items, currentGroupOrderMap: {}, currentWorkspaceOrderMap: {},
        sessionListOrderingModeV1: 'custom', sessionListSectionModeV1: 'activity', manualSessionOrderingEnabled: true,
        setSessionListGroupOrderV1: vi.fn(async () => {}), setSessionWorkspaceOrderV1: vi.fn(async () => {}), setSessionFoldersV1: vi.fn(async () => {}),
        pinnedKeySet: new Set(), sessionTags: {}, setSessionPinForKey: vi.fn(), setSessionTagsForKey: vi.fn() };
}

describe('Session list canonical carry retirement', () => {
    afterEach(() => { getStorage().setState({ profileScope: null }); });

    it('clears the lifted row and retires its source when the realm cancels externally', async () => {
        getStorage().setState({ profileScope: scope });
        const hook = await renderHook(() => useSessionListRowInteractions(input()));
        const runtime = hook.getCurrent().entityDragDrop.runtime;
        act(() => hook.getCurrent().handleDragStart(sessionKey));
        expect(hook.getCurrent().draggingSessionKey).toBe(sessionKey);
        const sourceId = runtime.getSnapshot().sourceId!;
        act(() => runtime.cancel('window-blur'));
        expect(hook.getCurrent().draggingSessionKey).toBeNull();
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        expect(runtime.begin(sourceId)).toBeNull();
        await hook.unmount();
    });

    it('clears staged keyboard state on external cancellation and can pick up again', async () => {
        getStorage().setState({ profileScope: scope });
        const hook = await renderHook(() => useSessionListRowInteractions(input()));
        act(() => { expect(hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Source', key: ' ' })).toBe(true); });
        expect(hook.getCurrent().stagedMove.view.label).toBe('Source');
        act(() => hook.getCurrent().entityDragDrop.runtime.cancel('escape-layer'));
        expect(hook.getCurrent().stagedMove.view.label).toBeNull();
        act(() => { expect(hook.getCurrent().stagedMove.handleRowKey({ sessionKey, label: 'Source', key: ' ' })).toBe(true); });
        expect(hook.getCurrent().stagedMove.view.label).toBe('Source');
        await hook.unmount();
    });

    it('retires a carry when its source leaves the current list or its mounted row retires', async () => {
        getStorage().setState({ profileScope: scope });
        const initial = input();
        const hook = await renderHook((props: UseSessionListRowInteractionsInput) => useSessionListRowInteractions(props), { initialProps: initial });
        act(() => hook.getCurrent().handleDragStart(sessionKey));
        await hook.rerender({ ...initial, listItems: [items[0]!] });
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
        expect(hook.getCurrent().activeDragSnapshot).toBeNull();
        await hook.rerender(initial);
        act(() => hook.getCurrent().handleDragStart(sessionKey));
        act(() => hook.getCurrent().unregisterTreeRowBounds(sourceRowId));
        expect(hook.getCurrent().entityDragDrop.runtime.getSnapshot().phase).toBe('idle');
        await hook.unmount();
    });
});
