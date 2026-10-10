import { ActionExecuteFailureSchema, type ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import {
  SESSION_BOARD_GET_MAX_LIMIT_V1, SessionBoardGetResultV1Schema, SessionBoardMutationActionResultV1Schema,
  parseSessionBoardActionPortResultV1, type SessionBoardGetResultV1,
} from '../sessions/board/actions.js';
import { SessionSurfaceItemV1Schema, isSessionSurfaceItemIdentityCorrespondingV1, type SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { SessionBoardItemWidthSchema } from '../sessions/board/layout.js';
import { type SessionBoardLayoutOperationV1 } from '../sessions/board/layoutOperations.js';
import { getWidgetSizeFootprintV1, normalizeWidgetSizeForSurfaceV1, resolveSessionBoardWidgetSizeV1, WidgetSizeV1Schema } from './widgetPresentationV1.js';
import type { WidgetActionSurfacePortV1, WidgetMoveCaptureV1 } from './actionsV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { resetWidgetInputBindingsV1, setWidgetInputBindingsV1, type WidgetInputBindingsV1, type WidgetSurfaceRefV1 } from './widgetInstanceV1.js';

const fail = (errorCode: string): Extract<ActionExecuteResult, { ok: false }> => ({ ok: false, errorCode, error: errorCode });

function orderedWidgetEntries(board: SessionBoardGetResultV1): SessionBoardGetResultV1['items'] {
  const remaining = new Map(board.items.filter(entry => entry.item?.source.kind === 'widget').map(entry => [entry.itemId, entry]));
  const ordered: SessionBoardGetResultV1['items'] = [];
  for (const tab of board.layout?.document.tabs ?? []) for (const placement of tab.items) {
    const entry = remaining.get(placement.itemId);
    if (!entry) continue;
    ordered.push(entry);
    remaining.delete(entry.itemId);
  }
  return [...ordered, ...[...remaining.values()].sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0)];
}

/**
 * One copy's own edit on a shared Board widget item: its name (the card's title follows it) or its
 * bindings. Every Board writer — this Action port and the Board's menus — applies it the same way.
 * `null` when the item is not a configured widget or the edit would not be valid shared content.
 */
export function editSessionBoardWidgetItemV1(
  item: SessionSurfaceItemV1,
  edit: Readonly<{ kind: 'rename'; displayName?: string }> | Readonly<{ kind: 'inputs'; bindings: WidgetInputBindingsV1 }>,
): SessionSurfaceItemV1 | null {
  if (item.source.kind !== 'widget') return null;
  const instance = item.source.instance;
  const { displayName: _previousName, ...unnamed } = instance;
  const next = edit.kind === 'inputs' ? { ...instance, bindings: edit.bindings } : { ...unnamed, ...(edit.displayName ? { displayName: edit.displayName } : {}) };
  const updated = SessionSurfaceItemV1Schema.safeParse({ ...item, source: { kind: 'widget', instance: next }, ...(edit.kind === 'rename' ? { title: edit.displayName ?? item.title } : {}) });
  return updated.success ? updated.data : null;
}

/** Translates configured-widget operations into the existing sealed Session Board transport. */
export function createSessionBoardWidgetActionPortV1(
  action: NonNullable<ActionExecutorDeps['sessionBoardAction']>,
): WidgetActionSurfacePortV1 {
  const readBoard = async (surface: WidgetSurfaceRefV1, context: ActionExecutorContext, signal?: AbortSignal): Promise<SessionBoardGetResultV1 | Extract<ActionExecuteResult, { ok: false }>> => {
    if (surface.owner.kind !== 'sessionBoard') return fail('unsupported_widget_surface');
    const sessionId = surface.owner.sessionId;
    const scopedContext = { ...context, serverId: surface.serverId };
    let cursor: string | undefined;
    let first: SessionBoardGetResultV1 | undefined;
    const items: SessionBoardGetResultV1['items'] = [];
    do {
      const listed = await action({ actionId: 'session.board.get', input: { sessionId, limit: SESSION_BOARD_GET_MAX_LIMIT_V1, ...(cursor ? { cursor } : {}) }, context: scopedContext, signal });
      const refused = ActionExecuteFailureSchema.safeParse(listed);
      if (refused.success) return refused.data;
      const inventory = SessionBoardGetResultV1Schema.safeParse(listed);
      if (!inventory.success || inventory.data.serverId !== surface.serverId || inventory.data.sessionId !== sessionId) return fail('invalid_action_output');
      first ??= inventory.data;
      const itemIds = inventory.data.items.filter(entry => entry.sourceKind === 'widget').map(entry => entry.itemId);
      if (itemIds.length) {
        const full = await action({ actionId: 'session.board.get', input: { sessionId, itemIds }, context: scopedContext, signal });
        const failed = ActionExecuteFailureSchema.safeParse(full);
        if (failed.success) return failed.data;
        const opened = SessionBoardGetResultV1Schema.safeParse(full);
        if (!opened.success || opened.data.serverId !== surface.serverId || opened.data.sessionId !== sessionId) return fail('invalid_action_output');
        if (opened.data.items.some(entry => entry.item && !isSessionSurfaceItemIdentityCorrespondingV1(entry.itemId, entry.item))) return fail('invalid_action_output');
        if (opened.data.incomplete) return fail('widget_surface_incomplete');
        items.push(...opened.data.items.filter(entry => itemIds.includes(entry.itemId)));
      }
      if (inventory.data.incomplete && !inventory.data.page.hasNext) return fail('widget_surface_incomplete');
      cursor = inventory.data.page.hasNext ? inventory.data.page.cursor ?? undefined : undefined;
      if (inventory.data.page.hasNext && !cursor) return fail('invalid_action_output');
      signal?.throwIfAborted();
    } while (cursor);
    return { ...first!, items, incomplete: false };
  };
  const capture = (board: SessionBoardGetResultV1, instanceId: string): WidgetMoveCaptureV1 | Extract<ActionExecuteResult, { ok: false }> => {
    const entry = board.items.find(entry => entry.item?.source.kind === 'widget' && entry.item.source.instance.id === instanceId);
    if (entry?.item?.source.kind !== 'widget') return fail('widget_instance_not_found');
    const placements = board.layout?.document.tabs.flatMap(tab => tab.items.flatMap((placement, nativeIndex) => placement.itemId === entry.itemId ? [{ tabId: tab.id, nativeIndex, placement }] : [])) ?? [];
    if (!board.layout || placements.length === 0) return fail('widget_placement_required');
    if (placements.length !== 1) return fail('widget_placement_ambiguous');
    const placed = placements[0]!;
    const size = resolveSessionBoardWidgetSizeV1(placed.placement.width, entry.item.height);
    return { expectedInstance: entry.item.source.instance,
      expectedPresentation: { ...(size ? { size } : {}), frameStyle: placed.placement.frameStyle ?? null, nativeIndex: placed.nativeIndex, tabId: placed.tabId },
      boardRevisions: { itemRevision: entry.revision, layoutRevision: board.layout.revision } };
  };

  return {
    async captureMove(surface, instanceId, context, signal) {
      const board = await readBoard(surface, context, signal);
      return 'ok' in board ? board : !board.capabilities.editSessionRecords ? fail('widget_edit_denied') : capture(board, instanceId);
    },
    async read(surface, context, signal) {
      const board = await readBoard(surface, context, signal);
      if ('ok' in board) return board;
      return { surface, canEdit: board.capabilities.editSessionRecords, instances: orderedWidgetEntries(board).flatMap(entry => {
        const source = entry.item?.source;
        if (source?.kind !== 'widget') return [];
        const placements = board.layout?.document.tabs.flatMap(tab => tab.items).filter(item => item.itemId === entry.itemId) ?? [];
        const placement = placements.length === 1 ? placements[0] : undefined;
        const size = placement && entry.item ? resolveSessionBoardWidgetSizeV1(placement.width, entry.item.height) : undefined;
        return [{ instance: source.instance, ...(size ? { size } : {}), ...(placement?.frameStyle ? { frameStyle: placement.frameStyle } : {}) }];
      }) };
    },
    async apply(surface, intent, context, signal) {
      if (intent.kind === 'group_create' || intent.kind === 'group_add' || intent.kind === 'group_ungroup'
        || intent.kind === 'group_set' || intent.kind === 'group_inputs' || intent.kind === 'width') return fail('unsupported_widget_group_surface');
      if (intent.kind === 'move' && intent.groupId !== undefined) return fail('unsupported_widget_group_surface');
      const board = await readBoard(surface, context, signal);
      if ('ok' in board) return board;
      if (!board.capabilities.editSessionRecords) return fail('widget_edit_denied');
      const sessionId = board.sessionId;
      const instanceId = intent.kind === 'add' ? intent.instance.id : intent.instanceId;
      const existing = board.items.find(entry => entry.item?.source.kind === 'widget' && entry.item.source.instance.id === instanceId);
      const ref = { surface, instanceId };
      if (intent.kind === 'add' && existing) return fail('widget_instance_already_exists');
      if (intent.kind !== 'add' && !existing) return fail('widget_instance_not_found');
      const call = async (actionId: 'session.board.item.upsert' | 'session.board.item.remove' | 'session.board.layout.update', input: unknown, instance: unknown) => {
        const result = await action({ actionId, input, context: { ...context, serverId: surface.serverId }, signal });
        const corresponding = parseSessionBoardActionPortResultV1(actionId, input, result, { expectedServerId: surface.serverId, expectedSessionId: sessionId });
        if (!corresponding.success) return fail('invalid_action_output');
        const rejected = ActionExecuteFailureSchema.safeParse(result);
        if (rejected.success) return rejected.data;
        const committed = SessionBoardMutationActionResultV1Schema.safeParse(result);
        if (!committed.success || committed.data.serverId !== surface.serverId || committed.data.sessionId !== sessionId) return fail('invalid_action_output');
        const mutation = committed.data.result;
        return { ok: true as const, result: { ref, instance,
          ...(intent.kind === 'add' && intent.captureForMove && mutation.operation === 'upsert_item' && mutation.layoutRevision
            ? { moveCapture: { expectedInstance: intent.instance, boardRevisions: { itemRevision: mutation.itemRevision, layoutRevision: mutation.layoutRevision } } } : {}) } };
      };
      if (intent.kind === 'add') {
        if (intent.toIndex !== undefined) return fail('widget_index_placement_unsupported');
        const size = normalizeWidgetSizeForSurfaceV1('sessionBoard', intent.presentation?.size)!;
        const footprint = getWidgetSizeFootprintV1('sessionBoard', size)!;
        const nativeWidth = SessionBoardItemWidthSchema.parse(footprint.width);
        let placement = intent.placement;
        if (intent.position) {
          if (!intent.position.tabId) return fail('widget_placement_required');
          const tab = board.layout?.document.tabs.find(tab => tab.id === intent.position!.tabId);
          if (!tab) return fail('widget_view_not_found');
          const before = tab.items[intent.position.index]; const last = tab.items.at(-1);
          placement = { tabId: tab.id, width: nativeWidth,
            ...(intent.presentation?.frameStyle ? { frameStyle: intent.presentation.frameStyle } : {}),
            ...(before || last ? { anchor: { side: before ? 'before' : 'after', itemId: (before ?? last)!.itemId } } : {}) };
        }
        if (!placement) return fail('widget_placement_required');
        if (intent.presentation?.size) placement = { ...placement, width: nativeWidth };
        const item = SessionSurfaceItemV1Schema.safeParse({
          v: 1, title: intent.instance.displayName ?? (intent.instance.definition.kind === 'builtin' ? intent.instance.definition.id : intent.instance.definition.kind === 'installed' ? intent.instance.definition.surface.localId : intent.instance.definition.kind === 'inline' ? intent.instance.definition.definition.name : intent.instance.definition.artifactId),
          frame: 'card', height: intent.presentation?.size ? { mode: 'fixed', size: footprint.height } : { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance: intent.instance },
        });
        if (!item.success) return fail('invalid_widget_shared_content');
        return await call('session.board.item.upsert', { sessionId, itemId: instanceId, expectedItemRevision: null, item: item.data, placement }, intent.instance);
      }
      const item = existing!.item!;
      if (item.source.kind !== 'widget') return fail('widget_instance_not_found');
      const instance = item.source.instance;
      if (intent.kind === 'remove') {
        if (!board.layout) return fail('widget_placement_required');
        if (intent.expectedInstance && !sameStrictJsonValue(instance, intent.expectedInstance)) return fail('widget_instance_changed');
        if (intent.expectedPresentation && !intent.boardRevisions) {
          const current = capture(board, instanceId);
          if ('ok' in current) return current;
          if (!sameStrictJsonValue(current.expectedPresentation, intent.expectedPresentation)) return fail('widget_placement_changed');
        }
        return await call('session.board.item.remove', { sessionId, itemId: existing!.itemId,
          expectedItemRevision: intent.boardRevisions?.itemRevision ?? existing!.revision, expectedLayoutRevision: intent.boardRevisions?.layoutRevision ?? board.layout.revision }, null);
      }
      if (intent.kind === 'rename' || intent.kind === 'inputs' || intent.kind === 'inputs_reset') {
        const updated = editSessionBoardWidgetItemV1(item, intent.kind === 'inputs' || intent.kind === 'inputs_reset'
          ? { kind: 'inputs', bindings: intent.kind === 'inputs_reset' ? resetWidgetInputBindingsV1(instance.bindings, intent.paths) : setWidgetInputBindingsV1(instance.bindings, intent.bindings, intent.paths) }
          : { kind: 'rename', ...(intent.displayName ? { displayName: intent.displayName } : {}) });
        if (!updated || updated.source.kind !== 'widget') return fail('invalid_widget_shared_content');
        return await call('session.board.item.upsert', { sessionId, itemId: existing!.itemId, expectedItemRevision: existing!.revision, item: updated }, updated.source.instance);
      }
      if (!board.layout) return fail('widget_placement_required');
      const placements = board.layout.document.tabs.filter(tab => tab.items.some(entry => entry.itemId === existing!.itemId));
      if (placements.length !== 1) return fail('widget_placement_ambiguous');
      const tab = placements[0]!;
      let operation: SessionBoardLayoutOperationV1;
      if (intent.kind === 'size') {
        const size = WidgetSizeV1Schema.safeParse(intent.size);
        if (!size.success) return fail('widget_size_unsupported');
        const footprint = getWidgetSizeFootprintV1('sessionBoard', size.data)!;
        const width = SessionBoardItemWidthSchema.parse(footprint.width);
        // Item upsert already commits content and placement in one sealed mutation.
        return await call('session.board.item.upsert', { sessionId, itemId: existing!.itemId, expectedItemRevision: existing!.revision,
          expectedLayoutRevision: board.layout.revision,
          item: { ...item, height: { mode: 'fixed', size: footprint.height } }, placement: { tabId: tab.id, width } }, instance);
      }
      else if (intent.kind === 'frame') operation = { op: 'item.frameStyle', itemId: existing!.itemId, tabId: tab.id, frameStyle: intent.frameStyle };
      else {
        const destination = 'nativeIndex' in intent && intent.tabId ? board.layout.document.tabs.find(view => view.id === intent.tabId) : tab;
        if (!destination) return fail('widget_view_not_found');
        if (destination !== tab && destination.items.some(placement => placement.itemId === existing!.itemId)) return fail('widget_placement_ambiguous');
        const widgets = new Set(board.items.filter(entry => entry.item?.source.kind === 'widget').map(entry => entry.itemId));
        const siblings = destination.items.filter(entry => entry.itemId !== existing!.itemId && ('nativeIndex' in intent || widgets.has(entry.itemId)));
        const before = siblings['nativeIndex' in intent ? intent.nativeIndex : intent.toIndex]; const after = siblings.at(-1); const anchor = before ?? after;
        if (!anchor && destination === tab) return { ok: true, result: { ref, instance } };
        operation = { op: 'item.move', itemId: existing!.itemId, fromTabId: tab.id, toTabId: destination.id,
          ...(anchor ? { anchor: { side: before ? 'before' : 'after', itemId: anchor.itemId } } : {}) };
      }
      return await call('session.board.layout.update', { sessionId, expectedLayoutRevision: board.layout.revision, operation }, instance);
    },
  };
}
