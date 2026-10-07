import { describe, expect, it } from 'vitest';
import { createSessionBoardWidgetActionPortV1 } from './sessionBoardWidgetActionPortV1.js';
import { SessionBoardItemUpsertInputV1Schema, SessionBoardItemRemoveInputV1Schema, SessionBoardLayoutUpdateInputV1Schema, projectSessionBoardActionFailureV1 } from '../sessions/board/actions.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { applySessionBoardItemPlacementV1, applySessionBoardLayoutOperationV1 } from '../sessions/board/layoutOperations.js';
import type { SessionBoardLayoutV1 } from '../sessions/board/layout.js';
import type { SessionSurfaceItemV1 } from '../sessions/board/item.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'sessionBoard', sessionId: 'shared' } } as const;
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'summary' }, bindings: {} } as const;
const item = { v: 1, title: 'Copy', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance } } as const;
const inventory = { v: 1, serverId: 'home', sessionId: 'shared', capabilities: { readTranscript: true, editSessionRecords: true },
  layout: null, items: [], incomplete: false, page: { hasNext: false, cursor: null } };

describe('configured widget Session Board transport', () => {
  it.each([
    { width: 'compact' as const, height: { mode: 'fixed' as const, size: 'tall' as const } },
    { width: 'wide' as const, height: { mode: 'auto' as const, fallback: 'regular' as const } },
  ])('omits an invented semantic size for native $width rectangles while retaining captured revision custody', async ({ width, height }) => {
    let nativeItem: SessionSurfaceItemV1 = { ...item, height };
    let itemRevision = revision;
    const document: SessionBoardLayoutV1 = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [
      { itemId: 'copy', width, frameStyle: 'plain' },
    ] }] };
    const before = structuredClone({ nativeItem, document });
    let removed = false;
    const action: NonNullable<ActionExecutorDeps['sessionBoardAction']> = async ({ actionId, input }) => {
      if (actionId === 'session.board.item.remove') {
        const request = SessionBoardItemRemoveInputV1Schema.parse(input);
        if (request.expectedItemRevision !== itemRevision || request.expectedLayoutRevision !== revision)
          return projectSessionBoardActionFailureV1({ error: 'session_board_revision_conflict',
            currentItemRevision: itemRevision, currentLayoutRevision: revision });
        removed = true;
        throw new Error('stale captured height must not be removed');
      }
      if (actionId !== 'session.board.get') throw new Error('presentation read must not write');
      return { ...inventory, layout: { revision, document }, items: [{ itemId: 'copy', revision: itemRevision, title: 'Copy', sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item: nativeItem } : {}) }] };
    };
    const port = createSessionBoardWidgetActionPortV1(action);
    expect(await port.read(surface, { surface: 'ui_button' }))
      .toEqual({ surface, canEdit: true, instances: [{ instance, frameStyle: 'plain' }] });
    const executor = createActionExecutor({ sessionBoardAction: action,
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }) });
    expect(await executor.execute('widgets.instance.list', { surface }, { surface: 'mcp', bypassApprovals: true }))
      .toEqual({ ok: true, result: { surface, canEdit: true, instances: [{ instance, frameStyle: 'plain' }] } });
    const capture = await port.captureMove!(surface, instance.id, { surface: 'ui_button' });
    expect(capture).toEqual({ expectedInstance: instance, expectedPresentation: {
      frameStyle: 'plain', nativeIndex: 0, tabId: 'overview',
    }, boardRevisions: { itemRevision: revision, layoutRevision: revision } });
    expect({ nativeItem, document }).toEqual(before);
    if ('ok' in capture) throw new Error('capture failed');
    nativeItem = { ...nativeItem, height: { mode: 'fixed', size: 'compact' } };
    itemRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...capture }, { surface: 'ui_button' }))
      .toMatchObject({ ok: false, errorCode: 'session_board_revision_conflict' });
    expect(removed).toBe(false);
    expect(nativeItem.height).toEqual({ mode: 'fixed', size: 'compact' });
    expect(document).toEqual(before.document);
  });
  it('changes both footprint dimensions atomically through the existing item height owner', async () => {
    let savedItem: SessionSurfaceItemV1 = { ...item, height: { mode: 'fixed', size: 'regular' } };
    let document: SessionBoardLayoutV1 = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [
      { itemId: 'copy', width: 'full', frameStyle: 'plain' }, { itemId: 'sibling', width: 'compact' },
    ] }] };
    const mutations: string[] = [];
    const port = createSessionBoardWidgetActionPortV1(async ({ actionId, input }) => {
      if (actionId === 'session.board.item.upsert') {
        const request = SessionBoardItemUpsertInputV1Schema.parse(input);
        mutations.push(actionId);
        expect(request).toHaveProperty('expectedLayoutRevision', revision);
        expect(request.item.height).toEqual({ mode: 'fixed', size: 'tall' });
        expect(request.placement).toMatchObject({ tabId: 'overview', width: 'medium' });
        const updated = applySessionBoardItemPlacementV1(document, { itemId: request.itemId, placement: request.placement! });
        if (!updated.ok) throw new Error(updated.error);
        document = updated.layout;
        savedItem = request.item;
        return { v: 1, serverId: 'home', sessionId: 'shared', destination: { tabId: 'overview', width: 'medium', frameStyle: 'plain' },
          result: { operation: 'upsert_item', itemId: 'copy', outcome: 'updated', itemRevision: revision, layoutRevision: revision } };
      }
      return { ...inventory, layout: { revision, document }, items: [{ itemId: 'copy', revision, title: 'Copy', sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item: savedItem } : {}) }] };
    });
    expect(await port.apply(surface, { kind: 'size', instanceId: 'copy', size: 'tall' }, { surface: 'ui_button' })).toMatchObject({ ok: true });
    expect(mutations).toEqual(['session.board.item.upsert']);
    expect(document.tabs[0]?.items).toEqual([{ itemId: 'copy', width: 'medium', frameStyle: 'plain' }, { itemId: 'sibling', width: 'compact' }]);
    expect(await port.read(surface, { surface: 'ui_button' })).toMatchObject({ instances: [{ size: 'tall' }] });
  });
  it.each(['frameless', 'full_bleed'] as const)('keeps native %s body geometry distinct from the portable placement frame', async frame => {
    const nativeItem = { ...item, frame };
    const port = createSessionBoardWidgetActionPortV1(async ({ input }) => ({ ...inventory,
      layout: { revision, document: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'copy', width: 'compact' }] }] } },
      items: [{ itemId: 'copy', revision, title: 'Copy', sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item: nativeItem } : {}) }],
    }));
    expect(await port.read(surface, { surface: 'ui_button' }))
      .toEqual({ surface, canEdit: true, instances: [{ instance }] });
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
  it('refuses an undeclared size operand while retaining the native compact tier', async () => {
    const compactItem = { ...item, height: { mode: 'fixed' as const, size: 'compact' as const } };
    const port = createSessionBoardWidgetActionPortV1(async ({ input }) => ({ ...inventory,
      layout: { revision, document: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'copy', width: 'compact' }] }] } },
      items: [{ itemId: 'copy', revision, title: 'Copy', sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item: compactItem } : {}) }],
    }));
    expect(await port.read(surface, { surface: 'ui_button' })).toMatchObject({ instances: [{ size: 'small' }] });
    expect(await port.apply(surface, { kind: 'size', instanceId: 'copy', size: 'half' } as never, { surface: 'ui_button' }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
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
    expect(read.instances.map(entry => entry.size)).toEqual([undefined, undefined, undefined]);
    expect(await port.apply(surface, { kind: 'size', instanceId: 'copy', size: 'wide' }, { surface: 'ui_button' }))
      .toMatchObject({ ok: false, errorCode: 'widget_placement_ambiguous' });
    expect(await port.captureMove!(surface, 'copy', { surface: 'ui_button' }))
      .toMatchObject({ ok: false, errorCode: 'widget_placement_ambiguous' });
  });
});
