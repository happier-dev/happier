import { useState } from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import type { BlockedReason } from '@/components/ui/treeDragDrop';
import type { SessionListTreeDropResult } from '../drop-resolution/sessionListTreeTypes';
import { useSessionListRowInteractions } from './useSessionListRowInteractions';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('session list drag commit outcomes', () => {
    it('returns the actual committed order, no-change, and explicit rejection outcomes', async () => {
        const workspace = { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' } as const;
        const items: SessionListIndexItem[] = [
            { type: 'header', title: 'project', headerKind: 'project', groupKey: 'project', workspaceKey: 'project', workspace, serverId: 'server-a' },
            ...['a', 'b'].map((id): SessionListIndexItem => ({
                type: 'session', sessionId: id, serverId: 'server-a', storageKind: 'persisted',
                groupKey: 'project', groupKind: 'project', folderId: null, folderDepth: 0, workspace,
            })),
        ];
        const hook = await renderHook(() => {
            const [order, setOrder] = useState<Record<string, string[]>>({ project: ['server-a:a', 'server-a:b'] });
            const [folders, setFolders] = useState<SessionFoldersV1>({ v: 1, folders: [] });
            const [workspaceOrder, setWorkspaceOrder] = useState<Record<string, string[]>>({});
            const interactions = useSessionListRowInteractions({
                folderActionsEnabled: true, folderSortMode: 'mixed', sessionListOrderingModeV1: 'custom',
                sessionListSectionModeV1: 'single', sessionFoldersV1: folders,
                sessionListGroupOrderV1: order, sessionWorkspaceOrderV1: workspaceOrder,
                sessionListIndexRef: { current: items }, listItemsRef: { current: [] },
                setSessionFoldersV1: setFolders, setSessionListGroupOrderV1: setOrder,
                setSessionWorkspaceOrderV1: setWorkspaceOrder, scrollToOffset: vi.fn(),
            });
            return { interactions, order };
        });
        const drop = async (
            kind: 'reorder-before' | 'reorder-after' | 'blocked',
            reason: BlockedReason = 'same-position',
            sessionListBlockReason?: SessionListTreeDropResult['sessionListBlockReason'],
        ) => {
            let outcome: unknown;
            await act(async () => {
                hook.getCurrent().interactions.handleDragStart('server-a:a');
                outcome = await hook.getCurrent().interactions.handleTreeDropResult({
                    sessionKey: 'server-a:a', groupKey: 'project', dataIndex: 1,
                    result: {
                        ...(sessionListBlockReason ? { sessionListBlockReason } : {}),
                        instruction: kind === 'blocked' ? { kind, reason } : {
                            kind, targetId: 'session:server-a:b', containerId: 'workspace-root:project', parentId: null, depth: 0,
                        },
                        visual: { kind: 'none' },
                    },
                });
            });
            return outcome;
        };
        expect(await drop('reorder-after')).toBe('applied');
        expect(hook.getCurrent().order).toEqual({ project: ['server-a:b', 'server-a:a'] });
        expect(await drop('reorder-after')).toBe('unchanged');
        expect(await drop('blocked', 'same-position')).toBe('unchanged');
        expect(await drop('blocked', 'no-target')).toBe('unchanged');
        expect(await drop('blocked', 'descendant-cycle')).toBe('refused');
        expect(await drop('blocked', 'same-position', 'date-ordering-mode')).toBe('refused');
        expect(hook.getCurrent().order).toEqual({ project: ['server-a:b', 'server-a:a'] });
    });
});
