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

const home = { serverId: 'home', accountId: 'account', owner: { kind: 'home' } } as const;
const board = { ...home, owner: { kind: 'sessionBoard', sessionId: 'shared' } } as const;
const instance = { v: 1, id: 'copy', displayName: 'My copy', definition: { kind: 'builtin', id: 'count' }, bindings: { count: { kind: 'value', value: 3 } } } as const;
const denied = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
const revision = (version: number) => {
  const bytes = new Uint8Array(9); const view = new DataView(bytes.buffer);
  view.setUint32(0, 1); bytes[4] = 120; view.setUint32(5, version);
  return `ssr1.${encodeBase64(bytes, 'base64url')}`;
};

async function fixture(candidate: WidgetInstanceV1 = instance) {
  const instance = candidate;
  const artifact = createWorkBoardArtifactBoundary();
  const faults: { addRefusal?: boolean; readRefusal?: boolean; lostAddAck?: boolean; lostSourceAck?: boolean; sharedReadOnly?: boolean; beforeAddAck?: () => Promise<void>; beforeRemove?: () => void | Promise<void> } = {};
  const homeHubArtifacts = createHomeHubArtifactPortV1({ ...artifact.transport,
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
    widgetInputs: createWidgetActionInputResolverV1({
      readDescriptor: async () => ({ inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] },
        inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }),
      readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
      validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    }),
  } as unknown as ActionExecutorDeps);
  const move = (signal?: AbortSignal) => executor.execute('widgets.instance.move', { ref: { surface: home, instanceId: instance.id }, to: { surface: board, tabId: 'metrics', index: 0 } },
    { surface: 'mcp', bypassApprovals: true, ...(signal ? { signal } : {}) });
  return { executor, homeHubArtifacts, effects, faults, upserts, move, boardItem: () => body, document: () => document,
    editDestinationFrame: () => { const next = applySessionBoardLayoutOperationV1(document, { op: 'item.frameStyle', tabId: 'metrics', itemId: instance.id, frameStyle: 'plain' }); if (!next.ok) throw new Error(next.error); document = next.layout; layoutVersion++; },
    editDestinationWidth: () => { const next = applySessionBoardLayoutOperationV1(document, { op: 'item.resize', tabId: 'metrics', itemId: instance.id, width: 'wide' }); if (!next.ok) throw new Error(next.error); document = next.layout; layoutVersion++; },
  };
}

describe('destination-aware widget move through canonical owners', () => {
  it('moves unchanged identity, bindings and title without dropping unrelated Board content', async () => {
    const f = await fixture();
    expect(await f.move()).toMatchObject({ ok: true, result: { ref: { surface: board, instanceId: instance.id }, fromRef: { surface: home, instanceId: instance.id }, status: 'moved', instance } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([]);
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
  it('leaves the source intact when destination add is refused', async () => {
    const f = await fixture(); f.faults.addRefusal = true;
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { phase: 'destination_add', source: 'present', destination: 'absent' } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
  it('reports unknown destination presence when its principal denies the preflight read', async () => {
    const f = await fixture(); f.faults.readRefusal = true;
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { phase: 'preflight', source: 'present', destination: 'unknown', reasonCode: 'session_board_forbidden' } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
  it('reports an unknown lost destination acknowledgement without deleting either owner', async () => {
    const f = await fixture(); f.faults.lostAddAck = true;
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_unknown', details: { source: 'present', destination: 'present' } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('compensates known source refusal without deleting its newer bindings', async () => {
    const f = await fixture();
    f.faults.beforeAddAck = () => f.homeHubArtifacts.apply({ kind: 'widget_inputs', instanceId: instance.id, bindings: { count: { kind: 'value', value: 9 } } }).then(() => {});
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { source: 'present', destination: 'absent', reasonCode: 'widget_instance_changed' } });
    expect((await f.homeHubArtifacts.read()).instances[0]?.bindings.count).toEqual({ kind: 'value', value: 9 });
    expect(f.effects).toEqual({ adds: 1, removes: 1 });
  });
  it('retains the only surviving destination when a concurrent owner removes the source before guarded removal', async () => {
    const f = await fixture();
    f.faults.beforeAddAck = () => f.homeHubArtifacts.apply({ kind: 'widget_remove', instanceId: instance.id }).then(() => {});
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved', instance } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([]);
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
    expect((await f.homeHubArtifacts.read()).instances).toEqual([]);
    expect(f.boardItem()).toBeUndefined();
  });
  it('confirms a lost source acknowledgement by owner reads without rolling back the surviving copy', async () => {
    const f = await fixture(); f.faults.lostSourceAck = true;
    expect(await f.move()).toMatchObject({ ok: true, result: { status: 'moved', ref: { surface: board, instanceId: instance.id } } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([]);
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('keeps cancellation after destination commit observable as unknown rather than plain cancelled', async () => {
    const f = await fixture(); const abort = new AbortController();
    f.faults.beforeAddAck = async () => abort.abort();
    expect(await f.move(abort.signal)).toMatchObject({ ok: false, errorCode: 'widget_transfer_unknown', details: { phase: 'source_remove', reasonCode: 'cancelled' } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([instance]);
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('refuses private Artifact definition transfer into shared content before changing either owner', async () => {
    const privateInstance = { ...instance, definition: { kind: 'artifact' as const, artifactId: 'private-definition' } };
    const f = await fixture(privateInstance);
    expect(await f.move()).toMatchObject({ ok: false, errorCode: 'widget_transfer_refused', details: { reasonCode: 'invalid_widget_shared_content' } });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([privateInstance]);
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
  it('admits the destination principal as well as the source with no transfer side effects', async () => {
    const f = await fixture(); expect(await f.move()).toMatchObject({ ok: true });
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: null, targets: { sessions: ['shared'], machines: [] }, approve: false, origins: [], models: null, permissionModes: null, create: null });
    expect(await f.executor.execute('widgets.instance.move', { ref: { surface: board, instanceId: instance.id }, to: { surface: home, index: 0 } },
      { surface: 'mcp', bypassApprovals: true, defaultSessionId: 'shared', externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant } }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
    expect((await f.homeHubArtifacts.read()).instances).toEqual([]);
    expect(f.boardItem()?.source).toEqual({ kind: 'widget', instance });
  });
  it('moves Board wide/plain back before Home builtins using Home native defaults without tier conversion', async () => {
    const f = await fixture(); expect(await f.move()).toMatchObject({ ok: true });
    f.editDestinationFrame(); f.editDestinationWidth();
    expect(await f.executor.execute('widgets.instance.move', { ref: { surface: board, instanceId: instance.id }, to: { surface: home, index: 0 } },
      { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true, result: { instance, status: 'moved' } });
    const layout = await f.homeHubArtifacts.read();
    expect(layout.order[0]).toBe(instance.id);
    expect(layout.sections?.[instance.id]).toEqual({ frameStyle: 'plain' });
    expect(await f.executor.execute('widgets.instance.list', { surface: home }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { instances: [{ instance, width: 'half', frameStyle: 'plain' }] } });
    expect(layout.instances).toEqual([instance]);
    expect(f.document().tabs[0]?.items).toEqual([{ itemId: 'read-only', width: 'wide', frameStyle: 'plain' }]);
  });
  it('edits shared Board inputs through the public widget Action while retaining layout, frame and editor authority', async () => {
    const f = await fixture(); expect(await f.move()).toMatchObject({ ok: true });
    f.editDestinationFrame(); f.editDestinationWidth();
    const beforeLayout = f.document(); const beforeBody = f.boardItem()!;
    const ref = { surface: board, instanceId: instance.id };
    expect(await f.executor.execute('widgets.instance.inputs.set', { ref, bindings: { count: { kind: 'value', value: 9 } } }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { ref, instance: { ...instance, bindings: { count: { kind: 'value', value: 9 } } } } });
    expect(f.document()).toEqual(beforeLayout);
    expect(f.boardItem()).toEqual({ ...beforeBody, source: { kind: 'widget', instance: { ...instance, bindings: { count: { kind: 'value', value: 9 } } } } });
    expect(f.upserts.at(-1)).toMatchObject({ itemId: instance.id, expectedItemRevision: revision(2) });
    expect(f.upserts.at(-1)?.placement).toBeUndefined();
    f.faults.sharedReadOnly = true;
    expect(await f.executor.execute('widgets.instance.inputs.set', { ref, bindings: {} }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'widget_edit_denied' });
    expect(f.upserts).toHaveLength(2);
  });
  it('rejects a removed caller-supplied viewer map before shared add', async () => {
    const f = await fixture();
    const draft = { ...instance, id: 'viewer-copy', bindings: { connection: { kind: 'viewer', purpose: 'metrics' } } };
    expect(await f.executor.execute('widgets.instance.add', { surface: board, instance: draft, placement: { tabId: 'metrics' },
      viewerValues: { connection: { service: { pluginId: 'acme.metrics', localId: 'cloud' }, accountId: 'own-connection' } },
    }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
    expect(f.boardItem()).toBeUndefined();
  });
  it('rejects even an empty removed viewer map without writing a shared instance', async () => {
    const f = await fixture();
    expect(await f.executor.execute('widgets.instance.add', { surface: board, instance, placement: { tabId: 'metrics' }, viewerValues: {} }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
    expect(f.boardItem()).toBeUndefined();
  });
  it('reports an unknown durable add acknowledgement with its exact ref rather than encouraging duplicate retry', async () => {
    const f = await fixture(); f.faults.lostAddAck = true;
    expect(await f.executor.execute('widgets.instance.add', { surface: board, instance, placement: { tabId: 'metrics' } }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'widget_add_unknown', details: { ref: { surface: board, instanceId: instance.id }, reasonCode: 'widget_write_ack_unknown' } });
    expect(f.boardItem()?.source).toEqual({ kind: 'widget', instance });
    expect(f.effects).toEqual({ adds: 1, removes: 0 });
  });
  it('retains a known native placement refusal on public add without claiming an uncertain write', async () => {
    const f = await fixture();
    expect(await f.executor.execute('widgets.instance.add', { surface: board, instance, toIndex: 0, placement: { tabId: 'metrics' } }, { surface: 'mcp', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'widget_index_placement_unsupported' });
    expect(f.effects).toEqual({ adds: 0, removes: 0 });
  });
});
