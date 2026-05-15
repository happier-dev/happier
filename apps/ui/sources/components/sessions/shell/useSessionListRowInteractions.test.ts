import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { DEFAULT_SESSION_FOLDERS_V1 } from '@/sync/domains/session/folders';
import { useSessionListRowInteractions } from './useSessionListRowInteractions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({
    useSharedValue: (initial: unknown) => ({ value: initial }),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: () => Promise<void>) => [null, () => { void action(); }],
}));

describe('useSessionListRowInteractions', () => {
    function renderInteractions(overrides: Partial<Parameters<typeof useSessionListRowInteractions>[0]> = {}) {
        return renderHook(() => useSessionListRowInteractions({
            folderActionsEnabled: true,
            sessionFoldersV1: DEFAULT_SESSION_FOLDERS_V1,
            listItems: [],
            currentGroupOrderMap: {},
            setSessionListGroupOrderV1: vi.fn(),
            setSessionFoldersV1: vi.fn(),
            pinnedKeyList: [],
            pinnedKeySet: new Set(),
            setPinnedSessionKeysV1: vi.fn(),
            sessionTags: {},
            setSessionTagsV1: vi.fn(),
            ...overrides,
        }));
    }

    it('tracks the resolved outline visual from the canonical tree drop result', async () => {
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
        expect(hook.getCurrent().activeDropTargetId).toBe('folder:target');
        expect(hook.getCurrent().activeDropVisual).toEqual({
            kind: 'outline',
            targetId: 'folder:target',
        });

        await hook.unmount();
    });

    it('does not expose a legacy delta-based drag-end handler', async () => {
        const hook = await renderInteractions();

        expect(hook.getCurrent()).not.toHaveProperty('handleDragEnd');
        expect(hook.getCurrent()).toHaveProperty('resolveTreeDropResult');
        expect(hook.getCurrent()).toHaveProperty('handleTreeDropResult');

        await hook.unmount();
    });

    it('preserves pin and tag row actions while using the tree pipeline', async () => {
        const setPinnedSessionKeysV1 = vi.fn();
        const setSessionTagsV1 = vi.fn();
        const hook = await renderInteractions({
            pinnedKeyList: ['server-a:s1'],
            pinnedKeySet: new Set(['server-a:s1']),
            setPinnedSessionKeysV1,
            sessionTags: { 'server-a:s1': ['old'] },
            setSessionTagsV1,
        });

        hook.getCurrent().handleTogglePinnedSessionKey('server-a:s1');
        hook.getCurrent().handleSetTagsSessionKey('server-a:s1', ['new']);

        expect(setPinnedSessionKeysV1).toHaveBeenCalledWith([]);
        expect(setSessionTagsV1).toHaveBeenCalledWith({ 'server-a:s1': ['new'] });

        await hook.unmount();
    });
});
