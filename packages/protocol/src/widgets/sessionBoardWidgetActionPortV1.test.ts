import { describe, expect, it } from 'vitest';
import { createSessionBoardWidgetActionPortV1 } from './sessionBoardWidgetActionPortV1.js';
import { SessionBoardLayoutUpdateInputV1Schema } from '../sessions/board/actions.js';
import { applySessionBoardLayoutOperationV1 } from '../sessions/board/layoutOperations.js';
import type { SessionBoardLayoutV1 } from '../sessions/board/layout.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'shared' } } as const;
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'summary' }, bindings: {} } as const;
const item = { v: 1, title: 'Copy', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance } } as const;
const inventory = { v: 1, serverId: 'home', sessionId: 'shared', capabilities: { readTranscript: true, editSessionRecords: true },
  layout: null, items: [], incomplete: false, page: { hasNext: false, cursor: null } };

describe('configured widget Session Board transport', () => {
  it.each(['frameless', 'full_bleed'] as const)('keeps native %s body geometry distinct from the portable placement frame', async frame => {
    const nativeItem = { ...item, frame };
    const port = createSessionBoardWidgetActionPortV1(async ({ input }) => ({ ...inventory,
      layout: { revision, document: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'copy', width: 'compact' }] }] } },
      items: [{ itemId: 'copy', revision, title: 'Copy', sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item: nativeItem } : {}) }],
    }));
    expect(await port.read(surface, { surface: 'ui_button' }))
      .toEqual({ surface, canEdit: true, instances: [{ instance, width: 'compact' }] });
    expect(await port.captureMove!(surface, 'copy', { surface: 'ui_button' }))
      .toMatchObject({ expectedPresentation: { frameStyle: null }, boardRevisions: { itemRevision: revision, layoutRevision: revision } });
  });
  it('refuses an acknowledgement for a different mutation operation', async () => {
    // The sealed Board transport is an external system boundary, not an internal reducer mock.
    const port = createSessionBoardWidgetActionPortV1(async ({ actionId }) => actionId === 'session.board.get' ? inventory : {
      v: 1, serverId: 'home', sessionId: 'shared', destination: null, result: { operation: 'remove_item', itemId: 'copy', outcome: 'removed', layoutRevision: revision },
    });
    expect(await port.apply(surface, { kind: 'add', instance, placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' } }, { surface: 'ui_button' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });
  it('rejects record/instance identity disagreement after opening record bytes', async () => {
    const port = createSessionBoardWidgetActionPortV1(async ({ input }) => ({ ...inventory,
      items: [{ itemId: 'outer', revision, title: 'Copy', sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item } : {}) }],
    }));
    expect(await port.read(surface, { surface: 'ui_button' })).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });
  it('retains the canonical compact width instead of projecting every non-full tier as half', async () => {
    let document: SessionBoardLayoutV1 = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'copy', width: 'compact' }, { itemId: 'sibling', width: 'full' }] }] };
    const port = createSessionBoardWidgetActionPortV1(async ({ actionId, input }) => {
      if (actionId === 'session.board.layout.update') {
        const operation = SessionBoardLayoutUpdateInputV1Schema.parse(input);
        const updated = applySessionBoardLayoutOperationV1(document, operation.operation);
        if (!updated.ok) throw new Error(updated.error);
        document = updated.layout;
        return { v: 1, serverId: 'home', sessionId: 'shared', destination: null,
          result: { operation: 'update_layout', outcome: 'updated', layoutRevision: revision } };
      }
      return { ...inventory, layout: { revision, document }, items: [{ itemId: 'copy', revision, title: 'Copy', sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item } : {}) }] };
    });
    expect(await port.read(surface, { surface: 'ui_button' })).toMatchObject({ instances: [{ width: 'compact' }] });
    expect(await port.apply(surface, { kind: 'width', instanceId: 'copy', width: 'wide' }, { surface: 'ui_button' })).toMatchObject({ ok: true });
    expect(document.tabs[0]?.items).toEqual([{ itemId: 'copy', width: 'wide' }, { itemId: 'sibling', width: 'full' }]);
    expect(await port.apply(surface, { kind: 'width', instanceId: 'copy', width: 'compact' }, { surface: 'ui_button' })).toMatchObject({ ok: true });
    expect((await port.read(surface, { surface: 'ui_button' }))).toMatchObject({ instances: [{ width: 'compact' }] });
    expect(await port.apply(surface, { kind: 'width', instanceId: 'copy', width: 'half' }, { surface: 'ui_button' })).toMatchObject({ ok: false, errorCode: 'widget_width_unsupported' });
  });
  it('uses the displayed widget ordinal while preserving intervening non-widget content', async () => {
    const second = { ...item, title: 'Second', source: { kind: 'widget' as const, instance: { ...instance, id: 'second' } } };
    let document: SessionBoardLayoutV1 = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [
      { itemId: 'copy', width: 'compact' }, { itemId: 'read-only', width: 'wide', frameStyle: 'plain' }, { itemId: 'second', width: 'full' },
    ] }] };
    const port = createSessionBoardWidgetActionPortV1(async ({ actionId, input }) => {
      if (actionId === 'session.board.layout.update') {
        const command = SessionBoardLayoutUpdateInputV1Schema.parse(input);
        const updated = applySessionBoardLayoutOperationV1(document, command.operation);
        if (!updated.ok) throw new Error(updated.error);
        document = updated.layout;
        return { v: 1, serverId: 'home', sessionId: 'shared', destination: null,
          result: { operation: 'update_layout', outcome: 'updated', layoutRevision: revision } };
      }
      const bodies = input && typeof input === 'object' && 'itemIds' in input;
      // Record update order differs from the canonical view order.
      return { ...inventory, layout: { revision, document }, items: [
        { itemId: 'second', revision, title: 'Second', sourceKind: 'widget', ...(bodies ? { item: second } : {}) },
        { itemId: 'copy', revision, title: 'Copy', sourceKind: 'widget', ...(bodies ? { item } : {}) },
      ] };
    });
    const initial = await port.read(surface, { surface: 'ui_button' });
    expect(initial).toMatchObject({ instances: [{ instance: { id: 'copy' } }, { instance: { id: 'second' } }] });
    expect(await port.apply(surface, { kind: 'move', instanceId: 'copy', toIndex: 1 }, { surface: 'ui_button' })).toMatchObject({ ok: true });
    expect(document.tabs[0]?.items).toEqual([
      { itemId: 'read-only', width: 'wide', frameStyle: 'plain' }, { itemId: 'second', width: 'full' }, { itemId: 'copy', width: 'compact' },
    ]);
    expect(await port.read(surface, { surface: 'ui_button' })).toMatchObject({ instances: [{ instance: { id: 'second' } }, { instance: { id: 'copy' } }] });
    document = { v: 1, tabs: [
      { id: 'overview', title: 'Overview', items: [{ itemId: 'read-only', width: 'wide', frameStyle: 'plain' }, { itemId: 'copy', width: 'compact' }] },
      { id: 'metrics', title: 'Metrics', items: [{ itemId: 'note', width: 'wide', frameStyle: 'plain' }, { itemId: 'second', width: 'full' }] },
    ] };
    expect(await port.apply(surface, { kind: 'move', instanceId: 'copy', toIndex: 1 }, { surface: 'ui_button' })).toMatchObject({ ok: true });
    expect(document.tabs.map(tab => tab.items)).toEqual([
      [{ itemId: 'read-only', width: 'wide', frameStyle: 'plain' }, { itemId: 'copy', width: 'compact' }], [{ itemId: 'note', width: 'wide', frameStyle: 'plain' }, { itemId: 'second', width: 'full' }],
    ]);
    const crossView = { kind: 'move' as const, instanceId: 'copy', nativeIndex: 0, tabId: 'metrics' };
    expect(await port.apply(surface, crossView, { surface: 'ui_button' })).toMatchObject({ ok: true });
    expect(document.tabs.map(tab => tab.items)).toEqual([
      [{ itemId: 'read-only', width: 'wide', frameStyle: 'plain' }], [{ itemId: 'copy', width: 'compact' }, { itemId: 'note', width: 'wide', frameStyle: 'plain' }, { itemId: 'second', width: 'full' }],
    ]);
  });
  it('retains unplaced instances and refuses to guess which repeated native placement to edit', async () => {
    const records = ['z-unplaced', 'copy', 'a-unplaced'].map(itemId => ({ itemId, revision, title: 'Copy', sourceKind: 'widget',
      item: { ...item, source: { kind: 'widget', instance: { ...instance, id: itemId } } } }));
    const port = createSessionBoardWidgetActionPortV1(async ({ input }) => ({ ...inventory,
      layout: { revision, document: { v: 1, tabs: [
        { id: 'overview', title: 'Overview', items: [{ itemId: 'copy', width: 'compact' }] },
        { id: 'metrics', title: 'Metrics', items: [{ itemId: 'copy', width: 'full' }] },
      ] } }, items: records.map(({ item: body, ...record }) => ({ ...record,
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item: body } : {}) })),
    }));
    const read = await port.read(surface, { surface: 'ui_button' });
    expect(read).toMatchObject({ instances: [{ instance: { id: 'copy' } }, { instance: { id: 'a-unplaced' } }, { instance: { id: 'z-unplaced' } }] });
    if ('ok' in read) throw new Error(read.errorCode);
    expect(read.instances.map(entry => entry.width)).toEqual([undefined, undefined, undefined]);
    expect(await port.apply(surface, { kind: 'width', instanceId: 'copy', width: 'wide' }, { surface: 'ui_button' }))
      .toMatchObject({ ok: false, errorCode: 'widget_placement_ambiguous' });
    expect(await port.captureMove!(surface, 'copy', { surface: 'ui_button' }))
      .toMatchObject({ ok: false, errorCode: 'widget_placement_ambiguous' });
  });
});
