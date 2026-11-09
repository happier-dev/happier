import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { useFrozenSessionListItemsDuringDrag } from './useFrozenSessionListItemsDuringDrag';
import type { SessionListDragSnapshot } from './_types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function viewItem(id: string): SessionListIndexItem {
    return { type: 'session', sessionId: id, groupKey: 'g', groupKind: 'project', serverId: 'server-a' };
}

function snapshotWith(frozen: SessionListIndexItem[]): SessionListDragSnapshot {
    return {
        snapshotId: 'snap-1',
        signature: 'sig',
        frozenItems: [],
        frozenViewItems: frozen,
        topology: { rows: [], dropZones: [], rowMetadataById: new Map(), containerMetadataById: new Map() },
        source: {
            sourceRowId: 'session:server-a:a',
            sessionDragKey: 'server-a:a',
            kind: 'leaf',
            treeSource: { id: 'session:server-a:a', kind: 'leaf', excludedDescendantIds: new Set(['session:server-a:a']), metadata: {} as any },
        },
        foldersFeatureEnabled: true,
    };
}

describe('useFrozenSessionListItemsDuringDrag', () => {
    it('returns the live items and frozen=false when no drag is active', async () => {
        const live = [viewItem('a'), viewItem('b')];
        const hook = await renderHook(() => useFrozenSessionListItemsDuringDrag({
            activeSnapshot: null,
            liveViewItems: live,
        }));

        const projection = hook.getCurrent();
        expect(projection.frozen).toBe(false);
        expect(projection.viewItems).toBe(live);
        expect(projection.snapshotId).toBeNull();

        await hook.unmount();
    });

    it('returns the snapshot frozen order while a drag is active', async () => {
        const frozen = [viewItem('a'), viewItem('b'), viewItem('c')];
        const snapshot = snapshotWith(frozen);
        const hook = await renderHook(() => useFrozenSessionListItemsDuringDrag({
            activeSnapshot: snapshot,
            liveViewItems: frozen,
        }));

        const projection = hook.getCurrent();
        expect(projection.frozen).toBe(true);
        expect(projection.viewItems).toBe(frozen);
        expect(projection.snapshotId).toBe('snap-1');

        await hook.unmount();
    });

    it('does NOT change the frozen surface when live items churn during an active drag', async () => {
        const frozen = [viewItem('a'), viewItem('b')];
        const snapshot = snapshotWith(frozen);
        const hook = await renderHook(({ live }: { live: SessionListIndexItem[] }) => useFrozenSessionListItemsDuringDrag({
            activeSnapshot: snapshot,
            liveViewItems: live,
        }), { initialProps: { live: frozen } });

        expect(hook.getCurrent().viewItems).toBe(frozen);

        // A background reorder swaps the live list. The visible (frozen) surface
        // must NOT reflect it until the drag ends.
        await hook.rerender({ live: [frozen[1]!, frozen[0]!, viewItem('z')] });

        expect(hook.getCurrent().frozen).toBe(true);
        expect(hook.getCurrent().viewItems).toBe(frozen);

        await hook.unmount();
    });

    it('returns the latest live list again after the drag clears', async () => {
        const frozen = [viewItem('a'), viewItem('b')];
        const snapshot = snapshotWith(frozen);
        const latest = [frozen[1]!, frozen[0]!, viewItem('z')];
        const hook = await renderHook<
            ReturnType<typeof useFrozenSessionListItemsDuringDrag>,
            { active: SessionListDragSnapshot | null }
        >(({ active }) => useFrozenSessionListItemsDuringDrag({
            activeSnapshot: active,
            liveViewItems: latest,
        }), { initialProps: { active: snapshot } });

        expect(hook.getCurrent().viewItems).toBe(frozen);

        await hook.rerender({ active: null });

        expect(hook.getCurrent().frozen).toBe(false);
        expect(hook.getCurrent().viewItems).toBe(latest);
        expect(hook.getCurrent().snapshotId).toBeNull();

        await hook.unmount();
    });

    it('withdraws a deleted or revoked row immediately while retaining the other presented positions', async () => {
        const frozen = [viewItem('a'), viewItem('b'), viewItem('c')];
        const hook = await renderHook(({ live }: { live: SessionListIndexItem[] }) => useFrozenSessionListItemsDuringDrag({
            activeSnapshot: snapshotWith(frozen),
            liveViewItems: live,
        }), { initialProps: { live: frozen } });

        await hook.rerender({ live: [viewItem('c'), viewItem('a'), { ...viewItem('b'), serverId: 'server-b' }, viewItem('new')] });

        expect(hook.getCurrent().frozen).toBe(true);
        expect(hook.getCurrent().viewItems.map((item) => item.type === 'session' ? item.sessionId : item.type))
            .toEqual(['a', 'c']);
        await hook.unmount();
    });

    it('keeps current header counts and labels at the frozen positions', async () => {
        const header: SessionListIndexItem = { type: 'header', title: 'Needs you', headerKind: 'attention', groupKey: 'attention', eligibleCount: 1 };
        const source = viewItem('a');
        const frozen = [header, source];
        const snapshot = snapshotWith(frozen);
        const hook = await renderHook(({ live }: { live: SessionListIndexItem[] }) => useFrozenSessionListItemsDuringDrag({
            activeSnapshot: snapshot,
            liveViewItems: live,
        }), { initialProps: { live: frozen } });
        const currentHeader = { ...header, title: 'Current group', eligibleCount: 2 };

        await hook.rerender({ live: [currentHeader, source, viewItem('arrival')] });

        expect(hook.getCurrent().viewItems).toEqual([currentHeader, source]);
        await hook.unmount();
    });
});
