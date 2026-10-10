import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';
import { buildWorkBoardItemKeyV1, createWorkBoardV1, WorkBoardsV1Schema, type BoardItemRefV1, type WorkBoardIntentV1 } from '../boards/workBoardV1.js';
import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';
import { createWorkBoardArtifactPortV1 } from '../boards/workBoardArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';

const ref = (serverId: string, id: string): BoardItemRefV1 => ({ kind: 'session', qualifiedId: { serverId, id } });

/** Artifact persistence is the system boundary; Board logic and Action admission stay real. */
function createBoundary(initial: unknown = null) {
  const rawBoards = initial && typeof initial === 'object' && 'boards' in initial && Array.isArray(initial.boards) ? initial.boards : [];
  const boundary = createWorkBoardArtifactBoundary(rawBoards);
  const workBoardArtifacts = createWorkBoardArtifactPortV1(boundary.transport);
  // This focused persistence harness supplies only ports the Board Action corridor can reach.
  const executor = createActionExecutor({ workBoardArtifacts } as unknown as ActionExecutorDeps);
  const execute = (id: string, input: unknown = {}) => executor.execute(id as ActionId, input, { surface: 'mcp', bypassApprovals: true });
  const apply = (intent: WorkBoardIntentV1) => execute('boards.apply', { intent });
  return { execute, apply, read: boundary.readCollection, workBoardArtifacts };
}

describe('Boards through the canonical Action executor', () => {
  it('admits retained native widget edits through this Home while preserving stored refs and strict generic targets', async () => {
    const storedSurface = { serverId: 'ui-profile', accountId: 'account', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
    const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
    const storedRef = { surface: storedSurface, instanceId: instance.id };
    const boundary = createWorkBoardArtifactBoundary([{ ...createWorkBoardV1({ id: 'b1', name: 'Retained' }), widgets: [{ kind: 'widget', ref: storedRef, instance, size: 'medium' }] }]);
    const row = boundary.rows.get('b1')!;
    boundary.rows.set('b1', { ...row, ownerAccountId: 'account' });
    const executor = createActionExecutor({ workBoardArtifacts: createWorkBoardArtifactPortV1(boundary.transport),
      widgetAccountScope: () => ({ serverId: 'cli-profile', accountId: 'account' }) });
    const context = { serverId: 'cli-profile', surface: 'mcp', bypassApprovals: true } as const;
    const intent = { kind: 'widget_rename', boardId: 'b1', ref: storedRef, displayName: 'From CLI' } as const;
    const renamed = await executor.execute('boards.apply', { intent }, context);
    expect(renamed, JSON.stringify(renamed)).toMatchObject({ ok: true, result: { board: { widgets: [{ ref: storedRef, instance: { displayName: 'From CLI' } }] } } });
    const before = boundary.updates.length;
    expect(await executor.execute('widgets.item.remove', { ref: storedRef }, context)).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await executor.execute('boards.apply', { intent }, { ...context, serverId: 'different-home' })).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await executor.execute('boards.apply', { intent: { ...intent, ref: { ...storedRef, surface: { ...storedSurface, accountId: 'other' } } } }, context)).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'b1', ref: { ...storedRef, instanceId: 'new' }, instance: { ...instance, id: 'new' } } }, context)).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(boundary.updates).toHaveLength(before);
  });
  it('admits raw Board widget adds and input edits exactly like widget Actions before persistence', async () => {
    const boundary = createWorkBoardArtifactBoundary([{ id: 'b1', name: 'Widgets', source: { picked: [] } }]);
    const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
    const instance = { v: 1, id: 'one', definition: { kind: 'builtin', id: 'counter' }, bindings: { count: { kind: 'value', value: 1 } } } as const;
    let sourceAdmitted = true;
    const executor = createActionExecutor({ workBoardArtifacts: createWorkBoardArtifactPortV1(boundary.transport),
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      // The descriptor/current-source facts are the metadata boundary, not schema logic.
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' }, inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] }, inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }),
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
        validateValue: async () => sourceAdmitted ? { status: 'valid' } : { status: 'denied', reasonCode: 'source_denied' }, resolveOptions: async () => [] }),
    });
    const context = { serverId: 'home', surface: 'mcp', bypassApprovals: true } as const;
    const ref = { surface, instanceId: instance.id };
    const invalid = { ...instance, bindings: { count: { kind: 'value', value: 'not-an-integer' } } } as const;
    const rejected = { ok: false, errorCode: 'widget_inputs_invalid', details: { status: 'invalid', fields: [{ reasonCode: 'widget_input_schema_invalid' }] } };
    const before = boundary.updates.length;
    expect(await executor.execute('widgets.item.add', { surface, instance: invalid }, context)).toMatchObject(rejected);
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'b1', ref, instance: invalid } }, context)).toMatchObject(rejected);
    expect(boundary.updates).toHaveLength(before);
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'b1', ref, instance } }, context)).toMatchObject({ ok: true });
    const saved = boundary.readCollection();
    expect(await executor.execute('widgets.item.inputs.set', { ref, bindings: invalid.bindings }, context)).toMatchObject(rejected);
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_inputs', boardId: 'b1', ref, bindings: invalid.bindings } }, context)).toMatchObject(rejected);
    expect(boundary.readCollection()).toEqual(saved);
    sourceAdmitted = false;
    const denied = { ok: false, errorCode: 'widget_inputs_invalid', details: { status: 'denied', fields: [{ reasonCode: 'source_denied' }] } };
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'b1', ref: { ...ref, instanceId: 'two' }, instance: { ...instance, id: 'two' } } }, context)).toMatchObject(denied);
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_inputs', boardId: 'b1', ref, bindings: instance.bindings } }, context)).toMatchObject(denied);
    expect(boundary.readCollection()).toEqual(saved);
    sourceAdmitted = true;
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_inputs', boardId: 'b1', ref, bindings: { count: { kind: 'value', value: 9 } } } }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.inputs.get', { ref }, context)).toMatchObject({ ok: true, result: { bindings: { count: { kind: 'value', value: 9 } } } });
  });
  it('dispatches configured WorkBoard copies through the canonical widget Action family', async () => {
    const boundary = createWorkBoardArtifactBoundary([{ id: 'b1', name: 'Widgets', source: { picked: [ref('home', 's1')], sections: ['running'] } }]);
    boundary.rows.set('b1', { ...boundary.rows.get('b1')!, ownerAccountId: 'account' });
    const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
    const instance = { v: 1, id: 'one', definition: { kind: 'builtin', id: 'counter' }, bindings: { count: { kind: 'value', value: 1 } } } as const;
    const executor = createActionExecutor({ workBoardArtifacts: createWorkBoardArtifactPortV1(boundary.transport),
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      // Installed descriptor and source facts are the metadata boundary; admission remains real.
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' }, inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] }, inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false } }),
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    } as unknown as ActionExecutorDeps);
    const context = { serverId: 'home', surface: 'mcp', bypassApprovals: true } as const;
    const target = { ref: { surface, instanceId: 'one' } };
    expect(await executor.execute('widgets.item.add', { surface, instance }, context)).toMatchObject({ ok: true, result: { instance } });
    expect(await executor.execute('widgets.item.add', { surface, instance: { ...instance, id: 'two' } }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.size.set', { ...target, size: 'full' }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.size.set', { ...target, size: 'wide' }, context)).toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await executor.execute('widgets.item.inputs.set', { ...target, bindings: { count: { kind: 'value', value: 9 } } }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.inputs.get', target, context)).toMatchObject({ ok: true, result: { bindings: { count: { kind: 'value', value: 9 } } } });
    expect(await executor.execute('widgets.item.move', { ...target, toIndex: 1 }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: { instances: [{ instance: { id: 'two', bindings: instance.bindings } }, { instance: { id: 'one' }, size: 'full' }] } });
    expect(await executor.execute('widgets.item.rename', { ...target, displayName: 'First' }, context)).toMatchObject({ ok: true, result: { instance: { displayName: 'First' } } });
    expect(await executor.execute('widgets.item.frame.set', { ...target, frameStyle: 'plain' }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.inputs.reset', target, context)).toMatchObject({ ok: true, result: { instance: { bindings: {} } } });
    expect(await executor.execute('widgets.item.remove', target, context)).toMatchObject({ ok: true });
    expect(boundary.readCollection()?.boards[0]?.source).toEqual({ picked: [ref('home', 's1')], sections: ['running'] });
    const before = boundary.updates.length;
    expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'b1', ref: { surface: { ...surface, accountId: 'other' }, instanceId: instance.id }, instance } }, context)).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(boundary.updates).toHaveLength(before);
  });
  it('round-trips every existing intent through individual Board Artifacts', async () => {
    const b = createBoundary();
    expect(await b.execute('boards.list')).toEqual({ ok: true, result: { boards: [] } });
    expect(await b.apply({ kind: 'create', board: { id: 'b1', name: 'Overview' } }))
      .toMatchObject({ ok: true, result: { boardId: 'b1', board: { id: 'b1', mode: 'canvas', source: { picked: [] } } } });
    expect(await b.apply({ kind: 'update', boardId: 'b1', patch: {
      name: 'Release', mode: 'by_status', snap: false, pinnedInSessions: true,
      source: { sections: ['needs_you', 'running'], filter: normalizeSessionListFilterV1(), picked: [ref('a', 's1')] },
    } })).toMatchObject({ ok: true, result: { board: { name: 'Release', mode: 'by_status', snap: false, pinnedInSessions: true } } });
    expect(await b.apply({ kind: 'add_items', boardId: 'b1', refs: [ref('a', 's1'), ref(' a ', 's1 '), ref('b', 's1')] }))
      .toMatchObject({ ok: true, result: { board: { source: { picked: [ref('a', 's1'), ref('b', 's1')] } } } });
    const key = buildWorkBoardItemKeyV1(ref('a', 's1'));
    expect(await b.execute('boards.apply', { intent: { kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [key]: { x: 24.4, y: 48.6 } } } }))
      .toMatchObject({ ok: true, result: { board: { positionsByItemRef: { [key]: { x: 24, y: 49 } } } } });
    expect(await b.execute('boards.list')).toMatchObject({ ok: true, result: { boards: [{ id: 'b1', name: 'Release' }] } });
    expect(await b.apply({ kind: 'remove_item', boardId: 'b1', ref: ref('a', 's1') }))
      .toMatchObject({ ok: true, result: { board: { source: { picked: [ref('b', 's1')] } } } });
    expect(await b.apply({ kind: 'delete', boardId: 'b1' })).toEqual({ ok: true, result: { boardId: 'b1', board: null } });
    expect(b.read()).toEqual({ v: 1, boards: [] });
  });

  it('accepts Board membership beyond the unrelated Account settings collection quota', async () => {
    const b = createBoundary();
    await b.apply({ kind: 'create', board: { id: 'b1', name: 'Overview' } });
    expect(await b.apply({ kind: 'add_items', boardId: 'b1', refs: Array.from({ length: 300 }, (_, i) => ref('a', `s${i}`)) }))
      .toMatchObject({ ok: true });
    expect(WorkBoardsV1Schema.parse(b.read()).boards[0]?.source.picked).toHaveLength(300);
  });

  it.each([
    { kind: 'update', boardId: 'gone', patch: { name: 'New name' } },
    { kind: 'delete', boardId: 'gone' },
    { kind: 'add_items', boardId: 'gone', refs: [ref('a', 's')] },
    { kind: 'remove_item', boardId: 'gone', ref: ref('a', 's') },
    { kind: 'set_positions', boardId: 'gone', positionsByItemRef: {} },
  ] as const)('$kind returns a typed missing-board error without a write', async (intent) => {
    const b = createBoundary();
    expect(await b.execute('boards.apply', { intent })).toMatchObject({ ok: false, errorCode: 'board_not_found' });
    expect(b.read()).toBeNull();
  });

  it('preserves existing picks for a source-only update and refuses editing an unreadable Board', async () => {
    const b = createBoundary();
    await b.apply({ kind: 'create', board: { id: 'b1', name: 'Overview' } });
    await b.apply({ kind: 'add_items', boardId: 'b1', refs: [ref('a', 's1')] });
    await b.apply({ kind: 'update', boardId: 'b1', patch: { source: { sections: ['my_machines'] } } });
    expect(WorkBoardsV1Schema.parse(b.read()).boards[0]?.source.picked).toEqual([ref('a', 's1')]);
    const unreadable = { id: 'b1', broken: true };
    const malformed = createBoundary({ boards: [unreadable] });
    expect(await malformed.execute('boards.list')).toMatchObject({ ok: true, result: { boards: [] } });
    expect(await malformed.apply({ kind: 'update', boardId: 'b1', patch: { name: 'Overview' } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_board_record' });
    expect(malformed.read()).toEqual({ v: 1, boards: [unreadable] });
  });

  it('keeps every existing position when an agent moves one item, even with stale membership', async () => {
    const b = createBoundary();
    await b.apply({ kind: 'create', board: { id: 'b1', name: 'Overview' } });
    const a = buildWorkBoardItemKeyV1(ref('a', 'section-only'));
    const other = buildWorkBoardItemKeyV1(ref('other-home', 'other'));
    await b.execute('boards.apply', { intent: { kind: 'set_positions', boardId: 'b1',
      positionsByItemRef: { [a]: { x: 1, y: 2 }, [other]: { x: 3, y: 4 } } } });
    expect(await b.execute('boards.apply', { intent: { kind: 'set_positions', boardId: 'b1',
      positionsByItemRef: { [a]: { x: 5, y: 6 } }, membership: { liveItemKeys: [], unavailableServerIds: [] } } }))
      .toMatchObject({ ok: true, result: { board: { positionsByItemRef: { [a]: { x: 5, y: 6 }, [other]: { x: 3, y: 4 } } } } });
  });

  it('rejects a conflicting outer target instead of writing another board', async () => {
    const b = createBoundary();
    expect(await b.execute('boards.apply', { boardId: 'other', intent: { kind: 'create', board: { id: 'b1', name: 'Overview' } } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(b.read()).toBeNull();
  });

  it('preserves opaque stored Boards and unknown source values without admitting them as mutation input', async () => {
    const unreadable = { id: 'future', name: 'Future', newField: true };
    const unknownPick = { kind: 'future-kind', qualifiedId: { serverId: 'a', id: 'future-item' } };
    const b = createBoundary({ v: 1, boards: [unreadable,
      { id: 'known', name: 'Known', source: { sections: ['needs_you', 'future-section'], picked: [unknownPick] } },
    ] });
    expect(await b.execute('boards.list')).toMatchObject({ ok: true, result: { boards: [{ id: 'known' }] } });
    expect(await b.apply({ kind: 'update', boardId: 'known', patch: { source: { sections: ['running'] } } })).toMatchObject({ ok: true });
    const stored = WorkBoardsV1Schema.parse(b.read());
    expect(stored.unreadable).toEqual([unreadable]);
    expect(stored.boards[0]?.source.unknown).toEqual({ sections: ['future-section'], picked: [unknownPick] });
    const before = b.read();
    expect(await b.execute('boards.apply', { intent: { kind: 'update', boardId: 'known', patch: { source: { unknown: { sections: ['future-section'] } } } } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(b.read()).toEqual(before);
  });

  it('uses the no-membership remove fallback for agents rather than pruning on their stale projection', async () => {
    const b = createBoundary();
    const item = ref('a', 'live-item');
    const key = buildWorkBoardItemKeyV1(item);
    await b.apply({ kind: 'create', board: { id: 'b1', name: 'Overview' } });
    await b.apply({ kind: 'update', boardId: 'b1', patch: { source: { sections: ['needs_you'], picked: [item] } } });
    await b.apply({ kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [key]: { x: 1, y: 2 } } });
    expect(await b.apply({ kind: 'remove_item', boardId: 'b1', ref: item, membership: { liveItemKeys: [], unavailableServerIds: [] } }))
      .toMatchObject({ ok: true, result: { board: { source: { picked: [] }, positionsByItemRef: { [key]: { x: 1, y: 2 } } } } });
  });

  it('publishes typed agent/MCP/CLI/plugin contracts and defaults mutation approval closed', async () => {
    for (const id of ['boards.list', 'boards.apply']) {
      const spec = getActionSpec(id as ActionId);
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, cli: true, plugin: true });
      expect(spec.executionPlacement).toBe('account');
    }
    const b = createBoundary();
    // Unlike the round-trip cases, this uses the real unwired-policy default.
    const executor = createActionExecutor({ workBoardArtifacts: b.workBoardArtifacts } as unknown as ActionExecutorDeps);
    expect(await executor.execute('boards.apply' as ActionId, { intent: { kind: 'create', board: { id: 'b1', name: 'Overview' } } }, { surface: 'agent' }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(b.read()).toBeNull();
  });
});
