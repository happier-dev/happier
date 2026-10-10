import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { SessionBoardItemUpsertInputV1Schema, SessionBoardItemRemoveInputV1Schema, type SessionBoardItemUpsertInputV1 } from '../sessions/board/actions.js';
import { applySessionBoardItemPlacementV1, applySessionBoardLayoutOperationV1 } from '../sessions/board/layoutOperations.js';
import type { SessionBoardLayoutV1 } from '../sessions/board/layout.js';
import type { SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { encodeBase64 } from '../crypto/base64.js';
import { createWidgetActionInputResolverV1 } from './widgetActionInputResolverV1.js';
import type { WidgetInstanceV1 } from './widgetInstanceV1.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { AccountProfileSchema } from '../account/profile.js';
import { resolveWidgetViewerPurposeValuesV1 } from './widgetViewerPurposeV1.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import { buildWidgetSurfaceArtifactIdV1, createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1 } from './widgetSurfaceArtifactV1.js';
import { flattenWidgetLayoutWidgetsV1, type WidgetLayoutItemV1 } from './widgetLayoutItemV1.js';

const home = { serverId: 'home', accountId: 'account', owner: { kind: 'home' } } as const;
const board = { ...home, owner: { kind: 'sessionBoard', sessionId: 'shared' } } as const;
const instance = { v: 1, id: 'copy', displayName: 'My copy', definition: { kind: 'builtin', id: 'count' }, bindings: { count: { kind: 'value', value: 3 } } } as const;
const denied = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
const instancesOf = (items: readonly WidgetLayoutItemV1[]) => flattenWidgetLayoutWidgetsV1(items).map(entry => entry.instance);
const revision = (version: number) => {
  const bytes = new Uint8Array(9); const view = new DataView(bytes.buffer);
  view.setUint32(0, 1); bytes[4] = 120; view.setUint32(5, version);
  return `ssr1.${encodeBase64(bytes, 'base64url')}`;
};

async function fixture(candidate: WidgetInstanceV1 = instance, widgetInputs?: ActionExecutorDeps['widgetInputs']) {
  const instance = candidate;
  const artifact = createWorkBoardArtifactBoundary();
  const faults: { addRefusal?: boolean; readRefusal?: boolean; lostAddAck?: boolean; lostSourceAck?: boolean; sharedReadOnly?: boolean; beforeAddAck?: () => Promise<void>; beforeRemove?: () => void | Promise<void> } = {};
  const homeHubArtifacts = createHomeHubArtifactPortV1({ ...artifact.forAccount(home.accountId),
    read: async (id, options) => { const row = await artifact.transport.read(id, options); return row ? { ...row, ownerAccountId: home.accountId } : null; },
    update: async request => { const result = await artifact.transport.update(request); if (result.ok && faults.lostSourceAck) throw new Error('Source lost acknowledgement'); return result; },
  }, { accountId: home.accountId });
  await homeHubArtifacts.apply({ kind: 'widget_add', instance });
  let document: SessionBoardLayoutV1 = { v: 1, tabs: [{ id: 'metrics', title: 'Metrics', items: [{ itemId: 'read-only', width: 'wide', frameStyle: 'plain' }] }] };
  let body: SessionSurfaceItemV1 | undefined;
  let itemVersion = 1; let layoutVersion = 1;
  const effects = { adds: 0, removes: 0 };
  const upserts: SessionBoardItemUpsertInputV1[] = [];
  // This is the sealed transport/persistent-record boundary; schemas and layout reducer remain real.
  const sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']> = async ({ actionId, input }) => {
    if (actionId === 'session.board.get') return faults.readRefusal ? denied('session_board_forbidden') : {
      v: 1, serverId: home.serverId, sessionId: 'shared', capabilities: { readTranscript: true, editSessionRecords: !faults.sharedReadOnly },
      layout: { revision: revision(layoutVersion), document }, incomplete: false, page: { hasNext: false, cursor: null },
      items: body ? [{ itemId: instance.id, revision: revision(itemVersion), title: body.title, sourceKind: 'widget',
        ...(input && typeof input === 'object' && 'itemIds' in input ? { item: body } : {}) }] : [],
    };
    if (actionId === 'session.board.item.upsert') {
      if (faults.addRefusal) return denied('session_board_forbidden');
      const request = SessionBoardItemUpsertInputV1Schema.parse(input);
      if (body && request.expectedItemRevision !== revision(itemVersion)) return denied('session_board_revision_conflict');
      const created = body === undefined; const placement = request.placement;
      if (placement) {
        const next = applySessionBoardItemPlacementV1(document, { itemId: request.itemId, placement });
        if (!next.ok) return denied(next.error);
        document = next.layout; layoutVersion++;
      }
      body = request.item; itemVersion++; if (created) effects.adds++; upserts.push(request);
      await faults.beforeAddAck?.();
      if (faults.lostAddAck) throw new Error('Transport lost acknowledgement');
      const placed = document.tabs[0]!.items.find(item => item.itemId === request.itemId)!;
      return { v: 1, serverId: home.serverId, sessionId: 'shared', destination: placement ? { tabId: 'metrics', width: placed.width, ...(placed.frameStyle ? { frameStyle: placed.frameStyle } : {}) } : null,
        result: { operation: 'upsert_item', itemId: request.itemId, outcome: created ? 'created' : 'updated', itemRevision: revision(itemVersion), ...(placement ? { layoutRevision: revision(layoutVersion) } : {}) } };
    }
    if (actionId === 'session.board.item.remove') {
      await faults.beforeRemove?.();
      const request = SessionBoardItemRemoveInputV1Schema.parse(input);
      if (request.expectedItemRevision !== revision(itemVersion) || request.expectedLayoutRevision !== revision(layoutVersion)) return denied('session_board_revision_conflict');
      const next = applySessionBoardLayoutOperationV1(document, { op: 'item.unpinAll', itemId: request.itemId });
      if (!next.ok) return denied(next.error);
      document = next.layout; body = undefined; layoutVersion++; effects.removes++;
      return { v: 1, serverId: home.serverId, sessionId: 'shared', destination: null,
        result: { operation: 'remove_item', itemId: request.itemId, outcome: 'removed', layoutRevision: revision(layoutVersion) } };
    }
    return denied('unsupported_action');
  };
  const executor = createActionExecutor({ homeHubArtifacts, sessionBoardAction,
    widgetAccountScope: () => ({ serverId: home.serverId, accountId: home.accountId }),
    // Fixed host descriptor facts; the real neutral schema/binding/options admission remains intact.
    widgetInputs: widgetInputs ?? createWidgetActionInputResolverV1({
      readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium', 'full', 'tall'], defaultSize: 'medium' }, inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] },
        inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }),
      readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
      validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    }),
  } as unknown as ActionExecutorDeps);
  const move = (signal?: AbortSignal) => executor.execute('widgets.item.move', { ref: { surface: home, instanceId: instance.id }, to: { surface: board, tabId: 'metrics', index: 0 } },
    { surface: 'mcp', bypassApprovals: true, ...(signal ? { signal } : {}) });
  return { executor, homeHubArtifacts, effects, faults, upserts, move, boardItem: () => body, document: () => document,
    editDestinationFrame: () => { const next = applySessionBoardLayoutOperationV1(document, { op: 'item.frameStyle', tabId: 'metrics', itemId: instance.id, frameStyle: 'plain' }); if (!next.ok) throw new Error(next.error); document = next.layout; layoutVersion++; },
    editDestinationWidth: () => { const next = applySessionBoardLayoutOperationV1(document, { op: 'item.resize', tabId: 'metrics', itemId: instance.id, width: 'wide' }); if (!next.ok) throw new Error(next.error); document = next.layout; layoutVersion++; },
  };
}

describe('destination-aware widget move through canonical owners', () => {
  it.each([
    { title: 'moves a child across surfaces into the requested group and admits its following input against group context', width: 'full', size: 'medium', moved: true },
    { title: 'refuses a cross-surface child transfer that cannot fit the destination group without removing its source', width: 'half', size: 'full', moved: false },
  ] as const)('$title', async ({ width, size, moved }) => {
    const boundary = createWorkBoardArtifactBoundary();
    const homeHubArtifacts = createHomeHubArtifactPortV1(boundary.forAccount(home.accountId), { accountId: home.accountId });
    const candidate: WidgetInstanceV1 = { ...instance, bindings: { count: { kind: 'context', slot: 'count' } } };
    await homeHubArtifacts.apply({ kind: 'widget_add', instance: candidate });
    const area = { ...home, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'main' } } as const;
    const artifact = createWidgetSurfaceArtifactPortV1(boundary.forAccount(home.accountId), { surface: area, isCurrent: () => true });
    await artifact.apply({ kind: 'add', instance: { ...instance, id: 'anchor' }, size: 'medium' });
    await artifact.apply({ kind: 'group_create', groupId: 'group', instanceIds: ['anchor'], width, context: { count: { kind: 'value', value: 7 } } });
    const executor = createActionExecutor({ homeHubArtifacts,
      widgetAccountScope: () => ({ serverId: home.serverId, accountId: home.accountId }),
      widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(() => artifact) },
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({
        sizeDeclaration: { sizes: [size], defaultSize: size },
        inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] },
        inputSchema: { type: 'object', properties: { count: { const: 7 } }, required: ['count'], additionalProperties: false },
      }), readContext: async () => ({ count: [3] }), readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    const result = await executor.execute('widgets.item.move', { ref: { surface: home, instanceId: instance.id },
      to: { surface: area, groupId: 'group', index: 1 } }, { surface: 'mcp', bypassApprovals: true });
    if (!moved) {
      expect(result).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: {
        phase: 'destination_add', source: 'present', destination: 'absent', reasonCode: 'widget_group_width_no_fit',
      } });
      expect((await artifact.read()).items).toMatchObject([{ kind: 'group', id: 'group', children: [{ instance: { id: 'anchor' } }] }]);
      expect((await homeHubArtifacts.read()).items).toMatchObject([{ kind: 'widget', instance: candidate }]);
      return;
    }
    expect(result).toMatchObject({ ok: true, result: { status: 'moved', ref: { surface: area, instanceId: instance.id } } });
    expect((await artifact.read()).items).toMatchObject([{ kind: 'group', id: 'group',
      children: [{ instance: { id: 'anchor' } }, { instance: candidate }] }]);
    expect((await homeHubArtifacts.read()).items).toEqual([]);
  });
  it('moves between Project areas in one document while preserving instance and frame', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const project = { ...home, owner: { kind: 'project', projectId: 'source-free' } } as const;
    const accountTransport = boundary.forAccount(home.accountId);
    const transport = { ...accountTransport, read: async (...args: Parameters<typeof accountTransport.read>) => {
      const row = await accountTransport.read(...args); return row ? { ...row, access: 'owner' as const } : null;
    } };
    const artifact = createWidgetSurfaceArtifactPortV1(transport, { surface: project, isCurrent: () => true });
    const executor = createActionExecutor({
      widgetAccountScope: () => ({ serverId: home.serverId, accountId: home.accountId }),
      widgetSurfaceActions: { project: createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(transport, { surface: target, isCurrent: () => true })) },
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] },
        inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
      }), readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
      validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    const context = { surface: 'mcp', bypassApprovals: true } as const;
    const ref = { surface: project, instanceId: instance.id };
    expect(await executor.execute('widgets.item.add', { surface: project, instance, area: 'main' }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.frame.set', { ref, frameStyle: 'plain' }, context)).toMatchObject({ ok: true });
    const before = [...boundary.rows.values()][0]!;
    // The first edit of a missing default materializes its canonical default widgets.
    // Area moves must preserve those companions while moving only the selected instance.
    const companions = flattenWidgetLayoutWidgetsV1((await artifact.read()).items).filter(entry => entry.instance.id !== instance.id);
    expect(await executor.execute('widgets.item.move', { ref, to: { surface: project, area: 'aside', index: 0 } }, context)).toMatchObject({ ok: true });
    expect(boundary.rows.size).toBe(1);
    expect(await executor.execute('widgets.item.list', { surface: project }, context)).toMatchObject({ ok: true,
      result: { instances: expect.arrayContaining([{ instance, area: 'aside', frameStyle: 'plain' }]) } });
    expect(flattenWidgetLayoutWidgetsV1((await artifact.read()).items).filter(entry => entry.instance.id !== instance.id)).toEqual(companions);
    const after = [...boundary.rows.values()][0]!;
    expect(after.revision.bodyVersion).toBe(before.revision.bodyVersion + 1);
    expect(await executor.execute('widgets.item.move', { ref, to: { surface: project, area: 'aside', index: 0 } }, context)).toMatchObject({ ok: true });
    expect([...boundary.rows.values()][0]!.revision).toEqual(after.revision);
    expect(await executor.execute('widgets.item.move', { ref, to: { surface: project, area: 'main', index: 0 } }, context)).toMatchObject({ ok: true });
    expect(flattenWidgetLayoutWidgetsV1((await artifact.read()).items)).toEqual(expect.arrayContaining([expect.objectContaining({ instance, area: 'main', frameStyle: 'plain' })]));
    expect(await executor.execute('widgets.item.move', { ref,
      to: { surface: { ...project, artifactId: buildWidgetSurfaceArtifactIdV1(project) }, area: 'aside', index: 0 } }, context)).toMatchObject({ ok: true });
    expect(boundary.rows.size).toBe(1);
    expect(flattenWidgetLayoutWidgetsV1((await artifact.read()).items)).toEqual(expect.arrayContaining([expect.objectContaining({ instance, area: 'aside', frameStyle: 'plain' })]));
    const destination = { ...project, owner: { kind: 'project', projectId: 'second' } } as const;
    expect(await executor.execute('widgets.item.move', { ref, to: { surface: destination, area: 'aside', index: 0 } }, context))
      .toMatchObject({ ok: true, result: { instance, area: 'aside', status: 'moved' } });
    expect(flattenWidgetLayoutWidgetsV1((await artifact.read()).items)).toEqual(companions);
    expect(flattenWidgetLayoutWidgetsV1((await createWidgetSurfaceArtifactPortV1(transport, { surface: destination, isCurrent: () => true }).read()).items))
      .toEqual(expect.arrayContaining([expect.objectContaining({ instance, area: 'aside', frameStyle: 'plain' })]));
  });
  it('adds, edits and transfers declared viewer intent without connecting, then refuses execution', async () => {
    const consumer = { pluginId: 'acme.metrics', localId: 'metrics' };
    const descriptor: WidgetInputDescriptorV1 & { resources: typeof consumer[] } = {
      sizeDeclaration: { sizes: ['medium', 'full', 'tall'], defaultSize: 'medium' },
      resources: [consumer], connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }],
      inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select', required: true, connectedAccountOptions: true },
        { path: 'count', title: 'Count', widget: 'integer', required: true }] },
      inputSchema: { type: 'object', properties: { count: { type: 'integer' }, connection: { type: 'object', properties: {
        service: { type: 'object', properties: { pluginId: { type: 'string' }, localId: { type: 'string' } }, required: ['pluginId', 'localId'], additionalProperties: false },
        accountId: { type: 'string' } }, required: ['service', 'accountId'], additionalProperties: false } }, required: ['connection', 'count'], additionalProperties: false },
    };
    const widgetInputs = createWidgetActionInputResolverV1({ readDescriptor: async () => descriptor, readContext: async () => ({}),
      readViewerValues: async request => resolveWidgetViewerPurposeValuesV1({ instance: request.instance, descriptor,
        profile: AccountProfileSchema.parse({ id: home.accountId }), purposeBindings: { v: 1, bindings: [] }, now: 1,
        resources: [{ id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config', scope: 'global',
          connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [{ pluginId: consumer.pluginId, localId: 'cloud' }] }] }] }),
      validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    });
    const copy: WidgetInstanceV1 = { ...instance, bindings: { ...instance.bindings, connection: { kind: 'viewer', purpose: 'read' } } };
    const f = await fixture(copy, widgetInputs);
    await f.homeHubArtifacts.apply({ kind: 'widget_remove', instanceId: copy.id });
    const context = { surface: 'mcp' as const, bypassApprovals: true };
    expect(await f.executor.execute('widgets.item.add', { surface: home, instance: copy }, context)).toMatchObject({ ok: true });
    const updated = { ...copy, bindings: { ...copy.bindings, count: { kind: 'value' as const, value: 4 } } };
    expect(await f.executor.execute('widgets.item.inputs.set', { ref: { surface: home, instanceId: copy.id }, bindings: updated.bindings }, context)).toMatchObject({ ok: true });
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved', instance: updated } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([]);
    expect(f.boardItem()?.source).toEqual({ kind: 'widget', instance: updated });
    expect(await widgetInputs.resolve({ ref: { surface: board, instanceId: copy.id }, instance: updated, context: {} }))
      .toMatchObject({ status: 'selection_required', fields: [{ path: 'connection', reasonCode: 'widget_viewer_connection_missing' }] });
  });
  it('moves unchanged identity, bindings and title without dropping unrelated Board content', async () => {
    const f = await fixture();
    expect(await f.move()).toMatchObject({ ok: true, result: { ref: { surface: board, instanceId: instance.id }, fromRef: { surface: home, instanceId: instance.id }, status: 'moved', instance } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([]);
    expect(f.boardItem()?.source).toEqual({ kind: 'widget', instance });
    expect(f.document().tabs[0]?.items).toEqual([{ itemId: instance.id, width: 'medium' }, { itemId: 'read-only', width: 'wide', frameStyle: 'plain' }]);
  });
  it('preserves a portable plain frame in the atomic Board placement without treating it as body geometry', async () => {
    const f = await fixture();
    await f.homeHubArtifacts.apply({ kind: 'frameStyle', sectionId: instance.id, frameStyle: 'plain' });
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved' } });
    expect(f.boardItem()?.frame).toBe('card');
    expect(f.document().tabs[0]?.items[0]).toEqual({ itemId: instance.id, width: 'medium', frameStyle: 'plain' });
  });
  it('retains full size when the destination supports the declared source size', async () => {
    const f = await fixture();
    await f.homeHubArtifacts.apply({ kind: 'widget_size', instanceId: instance.id, size: 'full' });
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved' } });
    expect(f.document().tabs[0]?.items[0]).toEqual({ itemId: instance.id, width: 'full' });
  });
  it('transfers a tall source size into the existing Board item-height owner in the same Add', async () => {
    const f = await fixture();
    await f.homeHubArtifacts.apply({ kind: 'widget_size', instanceId: instance.id, size: 'tall' });
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved' } });
    expect(f.upserts).toHaveLength(1);
    expect(f.upserts[0]).toMatchObject({ item: { height: { mode: 'fixed', size: 'tall' } }, placement: { width: 'medium' } });
  });
  it('leaves the source intact when destination add is refused', async () => {
    const f = await fixture(); f.faults.addRefusal = true;
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { phase: 'destination_add', source: 'present', destination: 'absent' } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
  it('reports unknown destination presence when its principal denies the preflight read', async () => {
    const f = await fixture(); f.faults.readRefusal = true;
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { phase: 'preflight', source: 'present', destination: 'unknown', reasonCode: 'session_board_forbidden' } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
  it('reports an unknown lost destination acknowledgement without deleting either owner', async () => {
    const f = await fixture(); f.faults.lostAddAck = true;
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_unknown', details: { source: 'present', destination: 'present' } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('compensates known source refusal without deleting its newer bindings', async () => {
    const f = await fixture();
    f.faults.beforeAddAck = () => f.homeHubArtifacts.apply({ kind: 'widget_inputs', instanceId: instance.id, bindings: { count: { kind: 'value', value: 9 } } }).then(() => {});
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { source: 'present', destination: 'absent', reasonCode: 'widget_instance_changed' } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)[0]?.bindings.count).toEqual({ kind: 'value', value: 9 });
    expect(f.effects).toEqual({ adds: 1, removes: 1 });
  });
  it('retains the only surviving destination when a concurrent owner removes the source before guarded removal', async () => {
    const f = await fixture();
    f.faults.beforeAddAck = () => f.homeHubArtifacts.apply({ kind: 'widget_remove', instanceId: instance.id }).then(() => {});
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved', instance } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([]);
    expect(f.boardItem()?.source).toEqual({ kind: 'widget', instance });
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('does not roll back a destination edited before guarded compensation', async () => {
    const f = await fixture();
    f.faults.beforeAddAck = () => f.homeHubArtifacts.apply({ kind: 'widget_inputs', instanceId: instance.id, bindings: { count: { kind: 'value', value: 9 } } }).then(() => {});
    f.faults.beforeRemove = f.editDestinationFrame;
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_unknown', details: { source: 'present', destination: 'present', phase: 'compensation' } });
    expect(f.document().tabs[0]?.items.find(item => item.itemId === instance.id)?.frameStyle).toBe('plain');
    expect(f.effects.removes).toBe(0);
  });
  it('returns the recoverable instance when independent deletion wins during guarded compensation', async () => {
    const f = await fixture();
    f.faults.beforeAddAck = () => f.homeHubArtifacts.apply({ kind: 'widget_inputs', instanceId: instance.id, bindings: { count: { kind: 'value', value: 9 } } }).then(() => {});
    f.faults.beforeRemove = () => f.homeHubArtifacts.apply({ kind: 'widget_remove', instanceId: instance.id }).then(() => {});
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_unknown', details: { phase: 'compensation', source: 'absent', destination: 'absent', instance } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([]);
    expect(f.boardItem()).toBeUndefined();
  });
  it('confirms a lost source acknowledgement by owner reads without rolling back the surviving copy', async () => {
    const f = await fixture(); f.faults.lostSourceAck = true;
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved', ref: { surface: board, instanceId: instance.id } } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([]);
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('keeps cancellation after destination commit observable as unknown rather than plain cancelled', async () => {
    const f = await fixture(); const abort = new AbortController();
    f.faults.beforeAddAck = async () => abort.abort();
    expect(await f.move(abort.signal)).toMatchObject({ ok: false, errorCode: 'widget_transfer_unknown', details: { phase: 'source_remove', reasonCode: 'cancelled' } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('refuses private Artifact definition transfer into shared content before changing either owner', async () => {
    const privateInstance = { ...instance, definition: { kind: 'artifact' as const, artifactId: 'private-definition' } };
    const f = await fixture(privateInstance);
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { reasonCode: 'invalid_widget_shared_content' } });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([privateInstance]);
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
  it('admits the destination principal as well as the source with no transfer side effects', async () => {
    const f = await fixture(); expect(await f.move()).toMatchObject({ ok: true });
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: null, targets: { sessions: ['shared'], machines: [] }, approve: false, origins: [], models: null, permissionModes: null, create: null });
    expect(await f.executor.execute('widgets.item.move', { ref: { surface: board, instanceId: instance.id }, to: { surface: home, index: 0 } },
      { surface: 'mcp', bypassApprovals: true, defaultSessionId: 'shared', externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant } }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
    expect(instancesOf((await f.homeHubArtifacts.read()).items)).toEqual([]);
    expect(f.boardItem()?.source).toEqual({ kind: 'widget', instance });
  });
  it('moves Board wide/plain back before Home builtins using Home native defaults without tier conversion', async () => {
    const f = await fixture(); expect(await f.move()).toMatchObject({ ok: true });
    f.editDestinationFrame(); f.editDestinationWidth();
    expect(await f.executor.execute('widgets.item.move', { ref: { surface: board, instanceId: instance.id }, to: { surface: home, index: 0 } },
      { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true, result: { instance, status: 'moved' } });
    const layout = await f.homeHubArtifacts.read();
    expect(layout.order[0]).toBe(instance.id);
    expect(flattenWidgetLayoutWidgetsV1(layout.items).find(entry => entry.instance.id === instance.id))
      .toEqual({ kind: 'widget', instance, frameStyle: 'plain', size: 'medium' });
    expect(await f.executor.execute('widgets.item.list', { surface: home }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { instances: [{ instance, size: 'medium', frameStyle: 'plain' }] } });
    expect(instancesOf(layout.items)).toEqual([instance]);
    expect(f.document().tabs[0]?.items).toEqual([{ itemId: 'read-only', width: 'wide', frameStyle: 'plain' }]);
  });
  it('edits shared Board inputs through the public widget Action while retaining layout, frame and editor authority', async () => {
    const f = await fixture(); expect(await f.move()).toMatchObject({ ok: true });
    f.editDestinationFrame(); f.editDestinationWidth();
    const beforeLayout = f.document(); const beforeBody = f.boardItem()!;
    const ref = { surface: board, instanceId: instance.id };
    expect(await f.executor.execute('widgets.item.inputs.set', { ref, bindings: { count: { kind: 'value', value: 9 } } }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { ref, instance: { ...instance, bindings: { count: { kind: 'value', value: 9 } } } } });
    expect(f.document()).toEqual(beforeLayout);
    expect(f.boardItem()).toEqual({ ...beforeBody, source: { kind: 'widget', instance: { ...instance, bindings: { count: { kind: 'value', value: 9 } } } } });
    expect(f.upserts.at(-1)).toMatchObject({ itemId: instance.id, expectedItemRevision: revision(2) });
    expect(f.upserts.at(-1)?.placement).toBeUndefined();
    f.faults.sharedReadOnly = true;
    expect(await f.executor.execute('widgets.item.inputs.set', { ref, bindings: {} }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'widget_edit_denied' });
    expect(f.upserts).toHaveLength(2);
  });
  it('rejects a removed caller-supplied viewer map before shared add', async () => {
    const f = await fixture();
    const draft = { ...instance, id: 'viewer-copy', bindings: { connection: { kind: 'viewer', purpose: 'metrics' } } };
    expect(await f.executor.execute('widgets.item.add', { surface: board, instance: draft, placement: { tabId: 'metrics' },
      viewerValues: { connection: { service: { pluginId: 'acme.metrics', localId: 'cloud' }, accountId: 'own-connection' } },
    }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
    expect(f.boardItem()).toBeUndefined();
  });
  it('rejects even an empty removed viewer map without writing a shared instance', async () => {
    const f = await fixture();
    expect(await f.executor.execute('widgets.item.add', { surface: board, instance, placement: { tabId: 'metrics' }, viewerValues: {} }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
    expect(f.boardItem()).toBeUndefined();
  });
  it('reports an unknown durable add acknowledgement with its exact ref rather than encouraging duplicate retry', async () => {
    const f = await fixture(); f.faults.lostAddAck = true;
    expect(await f.executor.execute('widgets.item.add', { surface: board, instance, placement: { tabId: 'metrics' } }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'widget_add_unknown', details: { ref: { surface: board, instanceId: instance.id }, reasonCode: 'widget_write_ack_unknown' } });
    expect(f.boardItem()?.source).toEqual({ kind: 'widget', instance });
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('retains a known native placement refusal on public add without claiming an uncertain write', async () => {
    const f = await fixture();
    expect(await f.executor.execute('widgets.item.add', { surface: board, instance, toIndex: 0, placement: { tabId: 'metrics' } }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'widget_index_placement_unsupported' });
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
});
