import { useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
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
    // The platform event boundary only needs the fields consumed by this hook.
    const scrollEvent = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as NativeSyntheticEvent<NativeScrollEvent>;
    async function geometryHarness(sourceId = 'a') {
        const positions = [0, 40, 80];
        const heights = [40, 40, 40];
        let scrollOffset = 0;
        const items: SessionListIndexItem[] = [
            { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: 'pinned-v1' },
            ...['a', 'b', 'c'].map((sessionId): SessionListIndexItem => ({
                type: 'session', sessionId, serverId: 'server-a', groupKey: 'pinned-v1',
                groupKind: 'pinned', pinned: true, storageKind: 'persisted',
            })),
        ];
        const hook = await renderHook(() => useSessionListRowInteractions({
            folderActionsEnabled: true, folderSortMode: 'mixed', sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'single', sessionFoldersV1: { v: 1, folders: [] },
            sessionListGroupOrderV1: {}, sessionWorkspaceOrderV1: {},
            sessionListIndexRef: { current: items }, listItemsRef: { current: [] },
            setSessionFoldersV1: vi.fn(), setSessionListGroupOrderV1: vi.fn(),
            setSessionWorkspaceOrderV1: vi.fn(), scrollToOffset: vi.fn(),
        }));
        const refs = positions.map((_, index) => ({
            getBoundingClientRectFn: () => ({ x: 0, y: positions[index]! - scrollOffset, width: 300, height: heights[index]! }),
        }));
        ['a', 'b', 'c'].forEach((id, index) => hook.getCurrent().registerTreeRowBounds(`session:server-a:${id}`, refs[index]!));
        await act(async () => { hook.getCurrent().handleDragStart(`server-a:${sourceId}`); });
        const pointer = (y: number) => ({ sessionKey: `server-a:${sourceId}`, groupKey: 'pinned-v1', dataIndex: 1, pointer: { x: 100, y } });
        return { hook, positions, heights, refs, pointer, setScroll: (value: number) => { scrollOffset = value; } };
    }

    it('refreshes later target bounds when an earlier row grows during a drag', async () => {
        const { hook, positions, heights, refs, pointer } = await geometryHarness('c');
        expect(hook.getCurrent().resolveDropResult(pointer(45)).geometry.kind).toBe('line');
        heights[0] = 140;
        positions[1] = 140;
        // The lifted source follows the pointer; only stationary target bounds
        // should be refreshed, retaining the source's original list slot.
        positions[2] = 145;
        heights[2] = 10;
        // Only the resized row receives onLayout; its same-sized siblings move.
        await act(async () => { hook.getCurrent().registerTreeRowBounds('session:server-a:a', refs[0]!); });
        const resolved = hook.getCurrent().resolveDropResult(pointer(145));
        expect(resolved.geometry).toMatchObject({ kind: 'line', targetId: 'session:server-a:b', geometry: { top: 139 } });
        await hook.unmount();
    });

    it('keeps a shrunken earlier row from letting the source slot mask a later target', async () => {
        const { hook, positions, heights, refs, pointer } = await geometryHarness('b');
        heights[0] = 10;
        positions[2] = 50;
        await act(async () => { hook.getCurrent().registerTreeRowBounds('session:server-a:a', refs[0]!); });
        expect(hook.getCurrent().resolveDropResult(pointer(78)).result.instruction).toMatchObject({
            kind: 'reorder-after', targetId: 'session:server-a:c',
        });
        await hook.unmount();
    });

    it('refreshes the line under a stationary pointer on scroll and stops after cancellation', async () => {
        const { hook, pointer, setScroll, refs } = await geometryHarness();
        expect(hook.getCurrent().resolveDropResult(pointer(85)).geometry).toMatchObject({ kind: 'line', geometry: { top: 79 } });
        setScroll(30);
        await act(async () => { hook.getCurrent().handleTreeScroll(scrollEvent(30)); });
        expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(1);
        expect(hook.getCurrent().dropOverlayShared.overlayTop.value).toBe(89);
        await act(async () => {
            // A queued layout refresh must not resurrect the cancelled drag.
            hook.getCurrent().registerTreeRowBounds('session:server-a:b', refs[1]!);
            hook.getCurrent().handleDragCancel({ sessionKey: 'server-a:a', groupKey: 'pinned-v1', dataIndex: 1 });
        });
        await act(async () => { hook.getCurrent().handleTreeScroll(scrollEvent(40)); });
        expect(hook.getCurrent().dropOverlayShared.overlayVisible.value).toBe(0);
        await hook.unmount();
    });

    it('resolves and commits consecutive pointer drags from different pinned rows', async () => {
        const hook = await renderHook(() => {
            const [order, setOrder] = useState<Record<string, string[]>>({ 'pinned-v1': ['server-a:a', 'server-a:b', 'server-a:c'] });
            const items: SessionListIndexItem[] = [
                { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: 'pinned-v1' },
                ...order['pinned-v1'].map((key): SessionListIndexItem => ({
                    type: 'session', sessionId: key.slice('server-a:'.length), serverId: 'server-a',
                    groupKey: 'pinned-v1', groupKind: 'pinned', pinned: true, storageKind: 'persisted',
                })),
            ];
            const interactions = useSessionListRowInteractions({
                folderActionsEnabled: true, folderSortMode: 'mixed', sessionListOrderingModeV1: 'custom',
                sessionListSectionModeV1: 'single', sessionFoldersV1: { v: 1, folders: [] },
                sessionListGroupOrderV1: order, sessionWorkspaceOrderV1: {},
                sessionListIndexRef: { current: items }, listItemsRef: { current: [] },
                setSessionFoldersV1: vi.fn(), setSessionListGroupOrderV1: setOrder,
                setSessionWorkspaceOrderV1: vi.fn(), scrollToOffset: vi.fn(),
            });
            return { interactions, order };
        });
        const register = () => {
            hook.getCurrent().order['pinned-v1'].forEach((key, index) => {
                hook.getCurrent().interactions.registerTreeRowBounds(`session:${key}`, {
                    getBoundingClientRectFn: () => ({ x: 0, y: index * 40, width: 300, height: 40 }),
                });
            });
        };
        const drag = async (source: string, targetY: number) => {
            register();
            await act(async () => { hook.getCurrent().interactions.handleDragStart(`server-a:${source}`); });
            const event = { sessionKey: `server-a:${source}`, groupKey: 'pinned-v1', dataIndex: 0, pointer: { x: 100, y: targetY } };
            const resolved = hook.getCurrent().interactions.resolveDropResult(event);
            let outcome: unknown;
            await act(async () => { outcome = await hook.getCurrent().interactions.handleTreeDropResult({ ...event, result: resolved.result }); });
            expect(outcome).toBe('applied');
        };
        await drag('b', 5);
        expect(hook.getCurrent().order['pinned-v1']).toEqual(['server-a:b', 'server-a:a', 'server-a:c']);
        await drag('c', 5);
        expect(hook.getCurrent().order['pinned-v1']).toEqual(['server-a:c', 'server-a:b', 'server-a:a']);
        await drag('b', 115);
        expect(hook.getCurrent().order['pinned-v1']).toEqual(['server-a:c', 'server-a:a', 'server-a:b']);
        await hook.unmount();
    });

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
