import { describe, expect, it } from 'vitest';

import type { SessionBoardLayoutV1, SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import type { SessionBoardOpenedRecord } from './sessionBoardRecordOutcome';
import {
    isSessionBoardEmpty,
    projectSessionBoard,
    resolveActiveSessionBoardViewId,
    resolveSessionBoardReferenceState,
    selectSessionBoardView,
    shouldRenderSessionBoardViewStrip,
    type SessionBoardProjectionInput,
} from './sessionBoardProjection';

function noteItem(title: string): SessionSurfaceItemV1 {
    return {
        v: 1,
        title,
        frame: 'card',
        height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: title } } },
    } as unknown as SessionSurfaceItemV1;
}

function readyItem(title: string, revision: string): SessionBoardOpenedRecord<SessionSurfaceItemV1> {
    return { revision, outcome: { status: 'ready', value: noteItem(title) } };
}

function layoutRecord(layout: SessionBoardLayoutV1, revision = 'ssr1:layout'): SessionBoardOpenedRecord<SessionBoardLayoutV1> {
    return { revision, outcome: { status: 'ready', value: layout } };
}

const TWO_VIEW_LAYOUT: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [
        { id: 'overview', title: 'Overview', items: [{ itemId: 'a', width: 'medium' }, { itemId: 'b', width: 'full' }] },
        { id: 'risks', title: 'Risks', items: [{ itemId: 'a', width: 'compact' }] },
    ],
};

function input(overrides: Partial<SessionBoardProjectionInput> = {}): SessionBoardProjectionInput {
    return {
        layout: layoutRecord(TWO_VIEW_LAYOUT),
        items: new Map([['a', readyItem('Plan', 'ssr1:a')], ['b', readyItem('Notes', 'ssr1:b')]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
        ...overrides,
    };
}

describe('projectSessionBoard', () => {
    it('projects frame overrides and invalidates only the placement whose override changed or cleared', () => {
        const initialInput = input();
        const initial = projectSessionBoard(initialInput);
        const styledLayout = { ...TWO_VIEW_LAYOUT, tabs: TWO_VIEW_LAYOUT.tabs.map((tab, index) => ({ ...tab,
            items: tab.items.map((placement, itemIndex) => index === 0 && itemIndex === 0
                ? { ...placement, frameStyle: 'plain' as const } : placement),
        })) };
        const styled = projectSessionBoard({ ...initialInput, layout: layoutRecord(styledLayout, 'layout-2') }, initial);
        expect(styled.views[0]?.placements[0]).toMatchObject({ frameStyle: 'plain' });
        expect(styled.views[0]?.placements[0]?.item).toBe(initial.views[0]?.placements[0]?.item);
        expect(styled.views[0]?.placements[1]).toBe(initial.views[0]?.placements[1]);
        expect(styled.views[1]).toBe(initial.views[1]);
        const echoed = projectSessionBoard({ ...initialInput, layout: layoutRecord(styledLayout, 'layout-2') }, styled);
        expect(echoed.views).toBe(styled.views);
        const cleared = projectSessionBoard(initialInput, styled);
        expect(cleared.views[0]?.placements[0]).not.toHaveProperty('frameStyle');
        expect(cleared.views[0]?.placements[0]).not.toBe(styled.views[0]?.placements[0]);
    });
    it('joins the shared layout and item records into ordered Board views without copying content', () => {
        const snapshot = projectSessionBoard(input());

        expect(snapshot.views.map((view) => view.id)).toEqual(['overview', 'risks']);
        expect(snapshot.views[0]?.placements.map((placement) => placement.itemId)).toEqual(['a', 'b']);
        // One item placed on two views is the SAME projection, never a copied record.
        expect(snapshot.views[1]?.placements[0]?.item).toBe(snapshot.views[0]?.placements[0]?.item);
        expect(snapshot.views[0]?.placements[0]?.width).toBe('medium');
        expect(snapshot.views[1]?.placements[0]?.width).toBe('compact');
    });

    it('keeps a malformed sibling isolated so valid items still render', () => {
        const snapshot = projectSessionBoard(input({
            items: new Map([
                ['a', readyItem('Plan', 'ssr1:a')],
                ['b', { revision: 'ssr1:b', outcome: { status: 'malformed' } }],
            ]),
        }));

        expect(snapshot.itemsById.get('a')?.state.kind).toBe('ready');
        expect(snapshot.itemsById.get('b')?.state).toEqual({ kind: 'unopenable', reason: 'malformed' });
        // The unopenable row still carries a revision, so an editor can remove it.
        expect(snapshot.itemsById.get('b')?.revision).toBe('ssr1:b');
    });

    it('distinguishes a locked E2EE item from an absent one', () => {
        const snapshot = projectSessionBoard(input({
            items: new Map([
                ['a', { revision: 'ssr1:a', outcome: { status: 'locked' } }],
            ]),
        }));

        expect(snapshot.itemsById.get('a')?.state.kind).toBe('locked');
        expect(snapshot.itemsById.get('b')?.state).toEqual({ kind: 'missingReference' });
    });

    it('never calls a referenced item missing while the record inventory is incomplete', () => {
        const snapshot = projectSessionBoard(input({
            items: new Map([['a', readyItem('Plan', 'ssr1:a')]]),
            incomplete: true,
        }));

        expect(snapshot.itemsById.get('b')?.state).toEqual({ kind: 'loading' });
    });

    it('fails closed when Lane 04 has not projected capabilities yet', () => {
        const snapshot = projectSessionBoard(input({ capabilities: null }));

        expect(snapshot.canEdit).toBe(false);
        expect(snapshot.capabilities).toEqual({ readTranscript: false, editSessionRecords: false });
    });

    it('shows a synthetic Overview and no view strip when no layout row exists', () => {
        const snapshot = projectSessionBoard(input({ layout: undefined, items: new Map() }));

        expect(snapshot.layoutState).toEqual({ kind: 'ready' });
        expect(snapshot.layoutRevision).toBeNull();
        expect(snapshot.views).toHaveLength(1);
        expect(snapshot.views[0]?.synthetic).toBe(true);
        expect(snapshot.views[0]?.title).toBeNull();
        expect(shouldRenderSessionBoardViewStrip(snapshot)).toBe(false);
        expect(isSessionBoardEmpty(snapshot)).toBe(true);
    });

    it('reports an unreadable layout instead of an empty Board', () => {
        const snapshot = projectSessionBoard(input({
            layout: { revision: 'ssr1:layout', outcome: { status: 'locked' } },
            items: new Map(),
        }));

        expect(snapshot.layoutState).toEqual({ kind: 'locked' });
        expect(isSessionBoardEmpty(snapshot)).toBe(false);
    });

    it('surfaces readable records the shared layout does not place', () => {
        const snapshot = projectSessionBoard(input({
            layout: layoutRecord({ v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] }),
        }));

        expect(snapshot.unplacedItemIds).toEqual(['a', 'b']);
    });

    it('recovers only Board-intended unplaced items and retains transcript content after unpin', () => {
        const items = new Map<string, SessionBoardOpenedRecord<SessionSurfaceItemV1>>();
        for (const destination of ['transcript', 'board', 'both'] as const) {
            items.set(destination, { revision: `ssr1:${destination}`, outcome: {
                status: 'ready', value: { ...noteItem(destination), destination },
            } });
        }
        const snapshot = projectSessionBoard(input({
            layout: layoutRecord({ v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] }),
            items,
        }));
        expect(snapshot.unplacedItemIds).toEqual(['board']);
        expect(snapshot.itemsById.get('transcript')?.state.kind).toBe('ready');
        expect(snapshot.itemsById.get('both')?.state.kind).toBe('ready');
    });

    it('preserves referential identity for rows whose revision and state did not change', () => {
        const first = projectSessionBoard(input());
        const second = projectSessionBoard(input({ freshness: 'stale', loading: 'refreshing' }), first);

        expect(second.views).toBe(first.views);
        expect(second.itemsById.get('a')).toBe(first.itemsById.get('a'));
        expect(second.itemsById).toBe(first.itemsById);
        expect(second.unplacedItemIds).toBe(first.unplacedItemIds);
        expect(second.freshness).toBe('stale');
        expect(second.loading).toBe('refreshing');
    });

    it('replaces only the row that actually changed', () => {
        const first = projectSessionBoard(input());
        const second = projectSessionBoard(input({
            items: new Map([['a', readyItem('Plan', 'ssr1:a')], ['b', readyItem('Notes v2', 'ssr1:b2')]]),
        }), first);

        expect(second.itemsById.get('a')).toBe(first.itemsById.get('a'));
        expect(second.itemsById.get('b')).not.toBe(first.itemsById.get('b'));
        expect(second.views).not.toBe(first.views);
        expect(second.views[1]).toBe(first.views[1]);
    });
});

describe('viewer-local Board view selection', () => {
    it('falls back to the first view when the remembered view no longer exists', () => {
        const snapshot = projectSessionBoard(input());

        expect(resolveActiveSessionBoardViewId(snapshot, 'risks')).toBe('risks');
        expect(resolveActiveSessionBoardViewId(snapshot, 'deleted')).toBe('overview');
        expect(selectSessionBoardView(snapshot, 'risks')).toBe(snapshot.views[1]);
    });
});

describe('resolveSessionBoardReferenceState', () => {
    it('only calls a viewer-local reference removed once the Board is complete', () => {
        const complete = projectSessionBoard(input());
        const partial = projectSessionBoard(input({ incomplete: true }));

        expect(resolveSessionBoardReferenceState(complete, 'gone')).toEqual({ kind: 'removed' });
        expect(resolveSessionBoardReferenceState(partial, 'gone')).toEqual({ kind: 'loading' });
        expect(resolveSessionBoardReferenceState(complete, 'a').kind).toBe('ready');
    });
});
