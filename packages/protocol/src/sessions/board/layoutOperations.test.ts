import { describe, expect, it } from 'vitest';

import {
  SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
  SessionBoardLayoutOperationV1Schema,
  applySessionBoardItemPlacementV1,
  applySessionBoardLayoutOperationV1,
  removeSessionBoardItemPlacementsV1,
} from './layoutOperations.js';
import type { SessionBoardLayoutV1 } from './layout.js';

const layout: SessionBoardLayoutV1 = {
  v: 1,
  tabs: [
    { id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' }, { itemId: 'chart', width: 'medium' }] },
    { id: 'metrics', title: 'Metrics', items: [{ itemId: 'chart', width: 'full' }] },
  ],
};

function expectOk(result: ReturnType<typeof applySessionBoardLayoutOperationV1>): SessionBoardLayoutV1 {
  if (!result.ok) throw new Error(`expected ok, received ${result.error}`);
  return result.layout;
}

describe('Session Board semantic layout operations', () => {
  it('applies the portable frame atomically with a first placement and retains it on omitted-frame upserts', () => {
    const placement = { tabId: 'metrics', width: 'compact' as const, frameStyle: 'plain' as const, anchor: { side: 'before' as const, itemId: 'chart' } };
    const added = expectOk(applySessionBoardItemPlacementV1(layout, { itemId: 'copy', placement }));
    expect(added.tabs[1]?.items).toEqual([{ itemId: 'copy', width: 'compact', frameStyle: 'plain' }, { itemId: 'chart', width: 'full' }]);
    const edited = expectOk(applySessionBoardItemPlacementV1(added, { itemId: 'copy', placement: { tabId: 'metrics', width: 'wide' } }));
    expect(edited.tabs[1]?.items[0]).toEqual({ itemId: 'copy', width: 'wide', frameStyle: 'plain' });
    expect(edited.tabs[0]).toEqual(layout.tabs[0]);
  });
  it('sets and clears a placement frame override without changing the same item in another view', () => {
    const parsed = SessionBoardLayoutOperationV1Schema.safeParse({
      op: 'item.frameStyle', tabId: 'overview', itemId: 'chart', frameStyle: 'plain',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const styled = expectOk(applySessionBoardLayoutOperationV1(layout, parsed.data));
    expect(styled.tabs[0]?.items[1]).toEqual({ itemId: 'chart', width: 'medium', frameStyle: 'plain' });
    expect(styled.tabs[1]?.items).toEqual(layout.tabs[1]?.items);
    const clear = SessionBoardLayoutOperationV1Schema.parse({
      op: 'item.frameStyle', tabId: 'overview', itemId: 'chart', frameStyle: null,
    });
    expect(expectOk(applySessionBoardLayoutOperationV1(styled, clear))).toEqual(layout);
    expect(applySessionBoardLayoutOperationV1(layout, { ...parsed.data, itemId: 'missing' }))
      .toEqual({ ok: false, error: 'session_board_item_not_found' });
  });

  it('preserves frame overrides through draft-based edits, moves, resizing and item upserts', () => {
    const styled = { ...layout, tabs: layout.tabs.map((tab) => ({ ...tab,
      items: tab.items.map((entry) => ({ ...entry, frameStyle: 'plain' as const })),
    })) };
    const renamed = expectOk(applySessionBoardLayoutOperationV1(styled, {
      op: 'tab.rename', tabId: 'overview', title: 'Renamed',
    }));
    expect(renamed.tabs[0]?.items).toEqual(styled.tabs[0]?.items);
    const resized = expectOk(applySessionBoardLayoutOperationV1(styled, {
      op: 'item.resize', tabId: 'overview', itemId: 'note', width: 'full',
    }));
    expect(resized.tabs[0]?.items[0]).toEqual({ itemId: 'note', width: 'full', frameStyle: 'plain' });
    const moved = expectOk(applySessionBoardLayoutOperationV1(styled, {
      op: 'item.move', itemId: 'note', fromTabId: 'overview', toTabId: 'metrics',
    }));
    expect(moved.tabs[1]?.items[1]).toEqual({ itemId: 'note', width: 'wide', frameStyle: 'plain' });
    const removed = expectOk(applySessionBoardLayoutOperationV1(styled, {
      op: 'tab.remove', tabId: 'overview', disposition: { kind: 'move', tabId: 'metrics' },
    }));
    expect(removed.tabs[0]?.items[1]).toEqual({ itemId: 'note', width: 'wide', frameStyle: 'plain' });
    const upserted = expectOk(applySessionBoardItemPlacementV1(styled, {
      itemId: 'note', placement: { tabId: 'overview', width: 'compact', anchor: { side: 'after', itemId: 'chart' } },
    }));
    expect(upserted.tabs[0]?.items[1]).toEqual({ itemId: 'note', width: 'compact', frameStyle: 'plain' });
    expect(styled.tabs[0]?.items[0]).toEqual({ itemId: 'note', width: 'wide', frameStyle: 'plain' });
  });

  it('cleans every reference to a missing item in one layout edit without changing siblings', () => {
    const operation = SessionBoardLayoutOperationV1Schema.safeParse({ op: 'item.unpinAll', itemId: 'chart' });
    expect(operation.success).toBe(true);
    if (!operation.success) return;
    const cleaned = expectOk(applySessionBoardLayoutOperationV1(layout, operation.data));
    expect(cleaned.tabs).toEqual([
      { id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' }] },
      { id: 'metrics', title: 'Metrics', items: [] },
    ]);
    expect(applySessionBoardLayoutOperationV1(cleaned, operation.data)).toEqual({ ok: true, layout: cleaned });
    expect(layout.tabs[1]?.items).toEqual([{ itemId: 'chart', width: 'full' }]);
  });

  it('accepts the closed semantic operations and rejects index-based moves', () => {
    for (const operation of [
      { op: 'tab.create', tabId: 'new', title: 'New' },
      { op: 'tab.rename', tabId: 'overview', title: 'Renamed' },
      { op: 'tab.move', tabId: 'metrics', anchor: { side: 'before', tabId: 'overview' } },
      { op: 'tab.remove', tabId: 'metrics', disposition: { kind: 'unpin' } },
      { op: 'item.place', itemId: 'note', tabId: 'metrics', width: 'compact' },
      { op: 'item.move', itemId: 'chart', fromTabId: 'overview', toTabId: 'metrics' },
      { op: 'item.unpin', itemId: 'chart', tabId: 'metrics' },
      { op: 'item.unpinAll', itemId: 'chart' },
      { op: 'item.resize', itemId: 'note', tabId: 'overview', width: 'full' },
    ]) {
      expect(SessionBoardLayoutOperationV1Schema.safeParse(operation).success, operation.op).toBe(true);
    }
    for (const operation of [
      { op: 'item.move', itemId: 'chart', fromTabId: 'overview', toTabId: 'metrics', index: 0 },
      { op: 'item.move', itemId: 'chart', fromTabId: 'overview', toTabId: 'metrics', anchor: { side: 'before', index: 1 } },
      { op: 'tab.move', tabId: 'metrics', index: 0 },
      { op: 'tab.remove', tabId: 'metrics' },
      { op: 'item.reorder', itemId: 'chart', tabId: 'overview' },
    ]) {
      expect(SessionBoardLayoutOperationV1Schema.safeParse(operation).success, JSON.stringify(operation)).toBe(false);
    }
  });

  it('anchors placements to stable siblings and leaves the input layout untouched', () => {
    const placed = expectOk(applySessionBoardLayoutOperationV1(layout, {
      op: 'item.place',
      itemId: 'summary',
      tabId: 'overview',
      width: 'compact',
      anchor: { side: 'before', itemId: 'chart' },
    }));
    expect(placed.tabs[0]?.items).toEqual([
      { itemId: 'note', width: 'wide' },
      { itemId: 'summary', width: 'compact' },
      { itemId: 'chart', width: 'medium' },
    ]);
    expect(layout.tabs[0]?.items).toHaveLength(2);
  });

  it('moves an item across Board views and reorders inside one view through the same operation', () => {
    const across = expectOk(applySessionBoardLayoutOperationV1(layout, {
      op: 'item.move',
      itemId: 'note',
      fromTabId: 'overview',
      toTabId: 'metrics',
      anchor: { side: 'after', itemId: 'chart' },
    }));
    expect(across.tabs[0]?.items.map((item) => item.itemId)).toEqual(['chart']);
    expect(across.tabs[1]?.items).toEqual([{ itemId: 'chart', width: 'full' }, { itemId: 'note', width: 'wide' }]);

    const reordered = expectOk(applySessionBoardLayoutOperationV1(layout, {
      op: 'item.move',
      itemId: 'chart',
      fromTabId: 'overview',
      toTabId: 'overview',
      anchor: { side: 'before', itemId: 'note' },
    }));
    expect(reordered.tabs[0]?.items.map((item) => item.itemId)).toEqual(['chart', 'note']);
  });

  it('requires a destination or explicit unpin when a Board view is removed', () => {
    const moved = expectOk(applySessionBoardLayoutOperationV1(layout, {
      op: 'tab.remove',
      tabId: 'metrics',
      disposition: { kind: 'move', tabId: 'overview' },
    }));
    expect(moved.tabs.map((tab) => tab.id)).toEqual(['overview']);
    // `chart` already lives on the destination view: the move keeps one placement, never a duplicate.
    expect(moved.tabs[0]?.items.map((item) => item.itemId)).toEqual(['note', 'chart']);

    const unpinned = expectOk(applySessionBoardLayoutOperationV1(layout, {
      op: 'tab.remove',
      tabId: 'overview',
      disposition: { kind: 'unpin' },
    }));
    expect(unpinned.tabs.map((tab) => tab.id)).toEqual(['metrics']);
    expect(unpinned.tabs[0]?.items).toEqual([{ itemId: 'chart', width: 'full' }]);
  });

  it('returns canonical Board error codes instead of silently repairing unknown operands', () => {
    expect(applySessionBoardLayoutOperationV1(layout, { op: 'tab.create', tabId: 'overview', title: 'Duplicate' }))
      .toEqual({ ok: false, error: 'session_board_invalid' });
    expect(applySessionBoardLayoutOperationV1(layout, { op: 'tab.rename', tabId: 'missing', title: 'Gone' }))
      .toEqual({ ok: false, error: 'session_board_invalid' });
    expect(applySessionBoardLayoutOperationV1(layout, {
      op: 'item.place', itemId: 'chart', tabId: 'metrics', width: 'wide',
    })).toEqual({ ok: false, error: 'session_board_invalid' });
    expect(applySessionBoardLayoutOperationV1(layout, {
      op: 'item.unpin', itemId: 'summary', tabId: 'overview',
    })).toEqual({ ok: false, error: 'session_board_item_not_found' });
    expect(applySessionBoardLayoutOperationV1(layout, {
      op: 'item.resize', itemId: 'note', tabId: 'metrics', width: 'wide',
    })).toEqual({ ok: false, error: 'session_board_item_not_found' });
    expect(applySessionBoardLayoutOperationV1(layout, {
      op: 'item.move', itemId: 'note', fromTabId: 'overview', toTabId: 'overview', anchor: { side: 'after', itemId: 'summary' },
    })).toEqual({ ok: false, error: 'session_board_item_not_found' });
    expect(applySessionBoardLayoutOperationV1(layout, {
      op: 'tab.remove', tabId: 'overview', disposition: { kind: 'move', tabId: 'overview' },
    })).toEqual({ ok: false, error: 'session_board_invalid' });
  });

  it('applies one atomic first placement for item creation and refuses to invent a Board view', () => {
    const created = applySessionBoardItemPlacementV1(layout, {
      itemId: 'summary',
      placement: { tabId: 'planning', tabTitle: 'Planning' },
    });
    expect(created.ok && created.layout.tabs.map((tab) => tab.id)).toEqual(['overview', 'metrics', 'planning']);
    expect(created.ok && created.layout.tabs[2]?.items)
      .toEqual([{ itemId: 'summary', width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1 }]);

    expect(applySessionBoardItemPlacementV1(layout, { itemId: 'summary', placement: { tabId: 'planning' } }))
      .toEqual({ ok: false, error: 'session_board_invalid' });
    expect(applySessionBoardItemPlacementV1({ v: 1, tabs: [] }, { itemId: 'summary', placement: {} }))
      .toEqual({ ok: false, error: 'session_board_invalid' });

    const defaulted = applySessionBoardItemPlacementV1(layout, { itemId: 'summary', placement: {} });
    expect(defaulted.ok && defaulted.layout.tabs[0]?.items.map((item) => item.itemId))
      .toEqual(['note', 'chart', 'summary']);
  });

  it('keeps an existing placement stable while an update changes only what the caller named', () => {
    const resized = applySessionBoardItemPlacementV1(layout, {
      itemId: 'chart',
      placement: { tabId: 'overview', width: 'full' },
    });
    expect(resized.ok && resized.layout.tabs[0]?.items).toEqual([
      { itemId: 'note', width: 'wide' },
      { itemId: 'chart', width: 'full' },
    ]);

    const untouched = applySessionBoardItemPlacementV1(layout, {
      itemId: 'chart',
      placement: { tabId: 'overview' },
    });
    expect(untouched.ok && untouched.layout).toEqual(layout);
  });

  it('removes every placement of a removed item across all Board views', () => {
    const removed = removeSessionBoardItemPlacementsV1(layout, 'chart');
    expect(removed.ok && removed.layout.tabs.map((tab) => tab.items.map((item) => item.itemId)))
      .toEqual([['note'], []]);
    expect(removeSessionBoardItemPlacementsV1(layout, 'never-placed')).toEqual({ ok: true, layout });
  });
});
