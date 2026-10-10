import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWorkBoardArtifactPortV1 } from '../boards/workBoardArtifactV1.js';
import { buildWorkBoardItemKeyV1, buildWorkBoardWidgetKeyV1, createWorkBoardV1 } from '../boards/workBoardV1.js';
import { captureWorkBoardWidgetMoveV1, createWorkBoardWidgetActionPortV1 } from './workBoardWidgetActionPortV1.js';
import { readWidgetActionSurfaceAdmissionV1 } from './widgetActionScopeV1.js';
import { WidgetInstanceV1Schema } from './widgetInstanceV1.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
const context = { serverId: 'home', surface: 'mcp', bypassApprovals: true } as const;

describe('WorkBoard widget domain adapter', () => {
  it('reads and edits another client’s placement through the admitted Board without rewriting its qualified key', async () => {
    const storedSurface = { ...surface, serverId: 'ui-profile' };
    const callerSurface = { ...surface, serverId: 'cli-profile' };
    const callerContext = { ...context, serverId: callerSurface.serverId };
    const boundary = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'b1', name: 'Cross-device' })]);
    const row = boundary.rows.get('b1')!;
    boundary.rows.set('b1', { ...row, ownerAccountId: surface.accountId });
    const boards = createWorkBoardArtifactPortV1(boundary.transport);
    const port = createWorkBoardWidgetActionPortV1(boards);
    expect(await port.apply(storedSurface, { kind: 'add', instance }, { ...context, serverId: storedSurface.serverId })).toMatchObject({ ok: true });
    const storedRef = { surface: storedSurface, instanceId: instance.id };
    const key = buildWorkBoardWidgetKeyV1(storedRef);
    await boards.apply({ kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [key]: { x: 48, y: 24 } } });
    const deps = { widgetAccountScope: () => callerSurface, workBoardArtifacts: boards };
    expect(await readWidgetActionSurfaceAdmissionV1(deps, storedSurface, callerContext)).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await readWidgetActionSurfaceAdmissionV1(deps, { ...callerSurface, accountId: 'other' }, callerContext)).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await readWidgetActionSurfaceAdmissionV1(deps, callerSurface, callerContext)).toMatchObject({ ok: true, read: { surface: callerSurface, instances: [{ instance }] } });
    expect(await port.captureMove!(callerSurface, instance.id, callerContext)).toMatchObject({ expectedInstance: instance, expectedPresentation: { canvasPosition: [48, 24] } });
    expect(await port.apply(callerSurface, { kind: 'rename', instanceId: instance.id, displayName: 'From CLI' }, callerContext)).toMatchObject({
      ok: true, result: { ref: { surface: callerSurface, instanceId: instance.id }, instance: { displayName: 'From CLI' } },
    });
    const edited = await boards.readBoard('b1');
    expect(edited?.widgets?.map(item => item.ref)).toEqual([storedRef]);
    expect(edited?.positionsByItemRef).toEqual({ [key]: { x: 48, y: 24 } });
    expect(edited?.itemOrder).toEqual([key]);
    expect(await port.apply(callerSurface, { kind: 'add', instance }, callerContext)).toMatchObject({ ok: false, errorCode: 'widget_instance_already_exists' });
    const before = boundary.updates.length;
    expect(await port.apply({ ...callerSurface, accountId: 'other' }, { kind: 'remove', instanceId: instance.id }, callerContext)).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(boundary.updates).toHaveLength(before);
    expect(await port.apply(callerSurface, { kind: 'remove', instanceId: instance.id }, callerContext)).toMatchObject({ ok: true, result: { instance: null } });
    expect((await boards.readBoard('b1'))?.widgets).toEqual([]);
    expect((await boards.readBoard('b1'))?.positionsByItemRef).toEqual({});
  });
  it('uses admitted Artifact view/edit authority and refuses new private pins on a shared document', async () => {
    const boundary = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'b1', name: 'Shared' })]);
    const row = boundary.rows.get('b1')!;
    const { access: _access, shared: _shared, ownerAccountId: _owner, ...withoutAdmission } = row;
    boundary.rows.set('b1', withoutAdmission);
    const unresolved = createWorkBoardWidgetActionPortV1(createWorkBoardArtifactPortV1(boundary.transport));
    expect(await unresolved.read(surface, context)).toMatchObject({ canEdit: false });
    expect(await unresolved.apply(surface, { kind: 'add', instance }, context)).toMatchObject({ ok: false, errorCode: 'artifact_access_denied' });
    boundary.rows.set('b1', { ...row, access: 'view', ownerAccountId: 'account', shared: true });
    const port = createWorkBoardWidgetActionPortV1(createWorkBoardArtifactPortV1(boundary.transport));
    expect(await port.read(surface, context)).toMatchObject({ canEdit: false, instances: [] });
    expect(await port.apply(surface, { kind: 'add', instance }, context)).toMatchObject({ ok: false, errorCode: 'artifact_access_denied' });
    expect(boundary.updates).toEqual([]);
    boundary.rows.set('b1', { ...row, access: 'edit', ownerAccountId: 'account', shared: true });
    expect(await port.read({ ...surface, accountId: 'wrong-owner' }, context)).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await port.apply({ ...surface, accountId: 'wrong-owner' }, { kind: 'add', instance }, context)).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await port.apply(surface, { kind: 'add', instance: { ...instance, definition: { kind: 'artifact', artifactId: 'private-definition' } } }, context)).toMatchObject({ ok: true });
    const before = boundary.rows.get('b1');
    const bindings = { cloud: { kind: 'value', value: { nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud', extra: true }, accountId: 'private' }] } } } as const;
    expect(await port.apply(surface, { kind: 'inputs', instanceId: instance.id, bindings }, context)).toMatchObject({ ok: false, errorCode: 'widget_private_connection_selection' });
    expect(await port.apply(surface, { kind: 'add', instance: { ...instance, id: 'unsafe', bindings } }, context)).toMatchObject({ ok: false, errorCode: 'widget_private_connection_selection' });
    expect(boundary.rows.get('b1')).toBe(before);
    const inline = WidgetInstanceV1Schema.parse({ ...instance, id: 'live-literal', definition: { kind: 'inline', definition: {
      v: 1, id: 'metric', name: 'Metric', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Count', value: { path: ['count'], type: 'number' },
        data: { kind: 'resource', resource: { pluginId: 'com.acme.test', localId: 'metrics' },
          inputSchema: { type: 'object', additionalProperties: false }, input: {},
          outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } },
      } } },
    } } });
    expect(await port.apply(surface, { kind: 'add', instance: inline }, context)).toMatchObject({ ok: false, errorCode: 'widget_shared_resource_input_literal' });
    expect(boundary.rows.get('b1')).toBe(before);
  });
  it('refuses to choose between retained placements with an ambiguous instance id', async () => {
    const boundary = createWorkBoardArtifactBoundary([{
      ...createWorkBoardV1({ id: 'b1', name: 'Retained' }),
      widgets: ['profile-a', 'profile-b'].map(serverId => ({ kind: 'widget' as const,
        ref: { surface: { ...surface, serverId }, instanceId: instance.id }, instance, size: 'medium' as const })),
    }]);
    const port = createWorkBoardWidgetActionPortV1(createWorkBoardArtifactPortV1(boundary.transport));
    expect(await port.captureMove!(surface, instance.id, context)).toMatchObject({ ok: false, errorCode: 'widget_instance_not_found' });
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id }, context)).toMatchObject({ ok: false, errorCode: 'widget_placement_unsupported' });
    expect(boundary.updates).toEqual([]);
    expect(captureWorkBoardWidgetMoveV1((await createWorkBoardArtifactPortV1(boundary.transport).readBoard('b1'))!, surface, instance.id)).toBeNull();
  });
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
    expect(added).toMatchObject({ ok: true, result: { ref: { surface, instanceId: 'copy' }, moveCapture: { expectedPresentation: { nativeIndex: 0, size: 'medium', frameStyle: null } } } });
    expect((await boards.readBoard('b1'))?.itemOrder?.[1]).toBe(buildWorkBoardItemKeyV1(work));
    const captured = await port.captureMove!(surface, instance.id, context);
    if ('ok' in captured) throw new Error(captured.errorCode);
    await port.apply(surface, { kind: 'inputs', instanceId: instance.id, bindings: { session: { kind: 'value', value: 's2' } } }, context);
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...captured }, context)).toMatchObject({ ok: false, errorCode: 'widget_instance_changed' });
    const updated = await port.captureMove!(surface, instance.id, context);
    if ('ok' in updated) throw new Error(updated.errorCode);
    await port.apply(surface, { kind: 'size', instanceId: instance.id, size: 'tall' }, context);
    expect(await port.read(surface, context)).toMatchObject({ instances: [{ size: 'tall' }] });
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id, ...updated }, context)).toMatchObject({ ok: false, errorCode: 'widget_placement_changed' });
    expect(await port.apply(surface, { kind: 'move', instanceId: instance.id, nativeIndex: 1 }, context)).toMatchObject({ ok: true });
    expect((await boards.readBoard('b1'))?.itemOrder?.[0]).toBe(buildWorkBoardItemKeyV1(work));
    expect(await port.apply(surface, { kind: 'remove', instanceId: instance.id }, context)).toMatchObject({ ok: true });
    expect((await boards.readBoard('b1'))?.source).toEqual({ picked: [work], sections: ['running'] });
  });
});
