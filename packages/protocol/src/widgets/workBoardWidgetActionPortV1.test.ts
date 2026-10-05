import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWorkBoardArtifactPortV1 } from '../boards/workBoardArtifactV1.js';
import { buildWorkBoardItemKeyV1, createWorkBoardV1 } from '../boards/workBoardV1.js';
import { createWorkBoardWidgetActionPortV1 } from './workBoardWidgetActionPortV1.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
const context = { serverId: 'home', surface: 'mcp', bypassApprovals: true } as const;

describe('WorkBoard widget domain adapter', () => {
  it('retains a source placement moved on the canvas after transfer capture', async () => {
    const boundary = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'b1', name: 'Canvas' })]);
    const boards = createWorkBoardArtifactPortV1(boundary.transport);
    const port = createWorkBoardWidgetActionPortV1(boards);
    await port.apply(surface, { kind: 'add', instance }, context);
    const captured = await port.captureMove!(surface, instance.id, context);
    if ('ok' in captured) throw new Error(captured.errorCode);
    const key = JSON.stringify(['widget', 'home', 'account', 'b1', 'copy']);
    await boards.apply({ kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [key]: { x: 240, y: 120 } } });
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...captured }, context)).toMatchObject({ ok: false, errorCode: 'widget_placement_changed' });
    expect((await boards.readBoard('b1'))?.positionsByItemRef[key]).toEqual({ x: 240, y: 120 });
  });
  it('uses mixed insertion indices, preserves work custody and refuses conditional removal after a concurrent edit', async () => {
    const work = { kind: 'session', qualifiedId: { serverId: 'home', id: 's1' } } as const;
    const boundary = createWorkBoardArtifactBoundary([{ ...createWorkBoardV1({ id: 'b1', name: 'Mixed' }), source: { picked: [work], sections: ['running'] } }]);
    const boards = createWorkBoardArtifactPortV1(boundary.transport);
    const port = createWorkBoardWidgetActionPortV1(boards);
    const added = await port.apply(surface, { kind: 'add', instance, position: { index: 0 }, captureForMove: true }, context);
    expect(added).toMatchObject({ ok: true, result: { ref: { surface, instanceId: 'copy' }, moveCapture: { expectedPresentation: { nativeIndex: 0, width: 'half', frameStyle: null } } } });
    expect((await boards.readBoard('b1'))?.itemOrder?.[1]).toBe(buildWorkBoardItemKeyV1(work));
    const captured = await port.captureMove!(surface, instance.id, context);
    if ('ok' in captured) throw new Error(captured.errorCode);
    await port.apply(surface, { kind: 'inputs', instanceId: instance.id, bindings: { session: { kind: 'value', value: 's2' } } }, context);
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...captured }, context)).toMatchObject({ ok: false, errorCode: 'widget_instance_changed' });
    const updated = await port.captureMove!(surface, instance.id, context);
    if ('ok' in updated) throw new Error(updated.errorCode);
    await port.apply(surface, { kind: 'width', instanceId: instance.id, width: 'full' }, context);
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...updated }, context)).toMatchObject({ ok: false, errorCode: 'widget_placement_changed' });
    expect(await port.apply(surface, { kind: 'move', instanceId: instance.id, nativeIndex: 1 }, context)).toMatchObject({ ok: true });
    expect((await boards.readBoard('b1'))?.itemOrder?.[0]).toBe(buildWorkBoardItemKeyV1(work));
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id }, context)).toMatchObject({ ok: true });
    expect((await boards.readBoard('b1'))?.source).toEqual({ picked: [work], sections: ['running'] });
  });
});
