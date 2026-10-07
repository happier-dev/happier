import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from './index.js';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetDefinitionArtifactPortV1 } from '../widgets/widgetDefinitionArtifactV1.js';
import { resolveWidgetBindingsV1, type WidgetInstanceV1 } from '../widgets/widgetInstanceV1.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'home' } } as const;

describe('configured widget Actions', () => {
  it('resizes projected default Home widgets through native and universal Actions before materialization', async () => {
    for (const native of [true, false]) {
      const boundary = createWorkBoardArtifactBoundary();
      const widget = { key: 'com.acme.sizes/checks', homeDefault: 'shown' as const,
        surface: { pluginId: 'com.acme.sizes', localId: 'checks' } };
      const homeHubArtifacts = createHomeHubArtifactPortV1(boundary.forAccount(surface.accountId), {
        accountId: surface.accountId, readWidgets: () => [widget],
      });
      const executor = createActionExecutor({ homeHubArtifacts, widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
        widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'medium' },
          inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } }),
          readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
      });
      const instanceId = `default:${widget.key}`;
      expect((await homeHubArtifacts.read()).instances).toEqual([]);
      const result = native
        ? await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_size', instanceId, size: 'tall' } }, { surface: 'mcp', bypassApprovals: true })
        : await executor.execute('widgets.instance.size.set', { ref: { surface, instanceId }, size: 'tall' }, { surface: 'mcp', bypassApprovals: true });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(await homeHubArtifacts.read()).toMatchObject({ instances: [{ id: instanceId }], sections: { [instanceId]: { size: 'tall' } } });
    }
  });
  it('uses the exact declared size set for catalog, atomic Add and resize with the existing Artifact owner', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const homeHubArtifacts = createHomeHubArtifactPortV1(boundary.forAccount(surface.accountId), { accountId: surface.accountId });
    const sizeDeclaration = { sizes: ['medium', 'tall'], defaultSize: 'tall' } satisfies import('../widgets/widgetPresentationV1.js').WidgetSizeDeclarationV1;
    const descriptor = { sizeDeclaration, inputs: { fields: [] }, inputSchema: { type: 'object' as const, additionalProperties: false } };
    const instance = { v: 1 as const, id: 'sized-copy', definition: { kind: 'installed' as const, surface: { pluginId: 'com.acme.sizes', localId: 'checks' } }, bindings: {} };
    const executor = createActionExecutor({ homeHubArtifacts,
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetCatalog: { list: async () => [{ definition: instance.definition, title: 'Checks', fields: [], sizeDeclaration,
        availability: 'available', instanceCount: 0 }] },
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => descriptor,
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    const context = { surface: 'mcp' as const, serverId: surface.serverId, bypassApprovals: true };
    expect(await executor.execute('widgets.catalog.list', { surface }, context)).toMatchObject({ ok: true,
      result: { entries: [{ presentation: { sizes: ['medium', 'tall'], defaultSize: 'tall' } }] } });
    const execute = (id: string, input: unknown) => executor.execute(id as ActionId, input, context);
    expect(await execute('widgets.instance.add', { surface, instance, size: 'medium' })).toMatchObject({ ok: true });
    expect((await homeHubArtifacts.read()).sections?.['sized-copy']?.size).toBe('medium');
    expect(await execute('widgets.instance.size.set', { ref: { surface, instanceId: instance.id }, size: 'tall' })).toMatchObject({ ok: true });
    const before = await homeHubArtifacts.read();
    expect(await execute('widgets.instance.size.set', { ref: { surface, instanceId: instance.id }, size: 'full' }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await execute('widgets.instance.add', { surface, instance: { ...instance, id: 'refused' }, size: 'full' }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await execute('home.hub.layout.update', { intent: { kind: 'widget_size', instanceId: instance.id, size: 'full' } }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await execute('home.hub.layout.update', { intent: { kind: 'widget_add', instance: { ...instance, id: 'native-refused' }, size: 'full' } }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(ActionIdSchema.safeParse('widgets.instance.width.set').success).toBe(false);
    const spec = getActionSpec('widgets.instance.size.set' as ActionId);
    expect(spec.bindings?.mcpToolName).toBe('widgets_instance_size_set');
    expect(isApprovalRequiredByActionsSettings(spec.id, normalizeActionsSettingsV1({ v: 1 }), { surface: 'mcp' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(spec.id, normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { [spec.id]: ['mcp'] } }), { surface: 'mcp' })).toBe(false);
  });
  it('discovers the target size choices and default through the catalog Action', async () => {
    // The catalog port is supplied by the answering UI/daemon's installed projection.
    const executor = createActionExecutor({
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetCatalog: { list: async () => [] },
    });
    for (const [owner, presentation] of [
      [{ kind: 'home' }, { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }],
      [{ kind: 'sessionBoard', sessionId: 'shared' }, { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }],
      [{ kind: 'project', projectId: 'project' }, { sizes: [] }],
    ] as const) {
      const result = await executor.execute('widgets.catalog.list', { surface: { ...surface, owner } },
        { surface: 'mcp', serverId: surface.serverId, bypassApprovals: true });
      expect(result, JSON.stringify(result))
        .toMatchObject({ ok: true, result: { presentation } });
    }
  });
  it('keeps definition deletion behind default approval and credential admission, with an explicit policy waiver reaching the Artifact owner', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const definitions = createWidgetDefinitionArtifactPortV1({ ...boundary.transport,
      read: async (id, options) => { const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: surface.accountId } : null; },
      list: async options => { const page = await boundary.transport.list(options); return { ...page,
        items: page.items.map(row => ({ ...row, ownerAccountId: surface.accountId })) }; },
    }, { accountId: surface.accountId });
    const definition = await definitions.create({ sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, v: 1, id: 'checks', name: 'Checks', inputs: { fields: [] },
      inputSchema: { type: 'object', additionalProperties: false },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Saved checks' } } },
      provenance: { source: { kind: 'authored' } },
    });
    const executor = createActionExecutor({ widgetDefinitionArtifacts: definitions,
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
        context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, input),
    });
    const input = { account: { serverId: surface.serverId, accountId: surface.accountId }, artifactId: definition.id };
    const context = { surface: 'mcp' as const, authority: 'account_automation' as const, serverId: surface.serverId };
    expect(await executor.execute('widgets.definition.delete', input, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(await definitions.get(definition.id)).toEqual(definition);
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['widgets.definition.get'] },
      targets: null, approve: false, origins: [], models: null, permissionModes: null, create: null });
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.definition.delete': ['mcp'] } });
    expect(await executor.execute('widgets.definition.delete', input, { ...context, actionsSettings: waived,
      externalActionCredential: { accountId: surface.accountId, principalId: 'principal', credentialId: 'credential', grant },
    })).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await definitions.get(definition.id)).toEqual(definition);
    expect(await executor.execute('widgets.definition.delete', input, { ...context, actionsSettings: waived }))
      .toMatchObject({ ok: true });
    expect(await definitions.get(definition.id)).toBeNull();
  });

  it('returns typed unavailable results without a mounted client and no longer admits viewer override Actions', async () => {
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }) });
    const ref = { surface, instanceId: 'checks' };
    const context = { surface: 'mcp' as const, serverId: surface.serverId };
    expect(await executor.execute('widgets.instance.refresh', { ref }, context))
      .toMatchObject({ ok: false, errorCode: 'widget_refresh_unavailable' });
    expect(await executor.execute('widgets.instance.list', { surface: { ...surface,
      owner: { kind: 'companion', sessionId: 'session' } } }, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    for (const id of ['widgets.instance.viewerInputs.get', 'widgets.instance.viewerInputs.set', 'widgets.instance.viewerInputs.reset'] as const) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('delivers Companion reads and transfers through the answering client while Home stays Account-owned', async () => {
    const companion = { ...surface, owner: { kind: 'companion', sessionId: 'session' } } as const;
    const readSpec = getActionSpec('widgets.instance.inputs.get');
    expect(resolveActionExecutionPlacementForInput(readSpec, readSpec.inputSchema.parse({ ref: { surface: companion, instanceId: 'checks' } }))).toBe('client');
    expect(resolveActionExecutionPlacementForInput(readSpec, readSpec.inputSchema.parse({ ref: { surface, instanceId: 'checks' } }))).toBe('account');
    const bindings = { count: { kind: 'value', value: 7 } } as const;
    // The connected-client hop is a transport boundary; admission/placement are real.
    const executor = createActionExecutor({
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      clientActionExecute: async ({ actionId, input }) => actionId === 'widgets.instance.inputs.get'
        ? { ok: true, result: { ref: { surface: companion, instanceId: 'checks' }, bindings } }
        : { ok: false, errorCode: 'answering_client', error: JSON.stringify(input) },
    });
    const context = { surface: 'mcp', serverId: surface.serverId, bypassApprovals: true } as const;
    expect(await executor.execute('widgets.instance.inputs.get', { ref: { surface: companion, instanceId: 'checks' } }, context))
      .toEqual({ ok: true, result: { ref: { surface: companion, instanceId: 'checks' }, bindings } });
    for (const [from, to] of [[surface, companion], [companion, surface]] as const) {
      const input = { ref: { surface: from, instanceId: 'checks' }, to: { surface: to, index: 0 } };
      expect(await executor.execute('widgets.instance.move', input, context))
        .toEqual({ ok: false, errorCode: 'answering_client', error: JSON.stringify(input) });
    }
    expect(await executor.execute('widgets.instance.inputs.get', { ref: { surface, instanceId: 'checks' } }, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_widget_surface' });
  });

  it('requires configurable approval for the shared Board content writer used by snapshots', () => {
    const context = { surface: 'agent' as const, authority: 'account_automation' as const };
    const id = 'session.board.item.upsert';
    expect(isApprovalRequiredByActionsSettings(id, normalizeActionsSettingsV1({ v: 1 }), context)).toBe(true);
    expect(isApprovalRequiredByActionsSettings(id, normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { [id]: ['agent'] } }), context)).toBe(false);
  });
  it('advertises reusable definition and snapshot operations with consequential approval defaults and configurable waivers', () => {
    for (const name of ['widgets.definition.list', 'widgets.definition.get', 'widgets.definition.create',
      'widgets.definition.update', 'widgets.definition.duplicate', 'widgets.definition.delete',
      'widgets.definition.saveFromSession', 'widgets.snapshot.post']) {
      const admitted = ActionIdSchema.safeParse(name);
      expect(admitted.success, name).toBe(true);
      if (!admitted.success) continue;
      const id = admitted.data;
      const spec = getActionSpec(id);
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
      expect(spec.bindings?.mcpToolName, name).toBe(name.replaceAll('.', '_'));
      if (name === 'widgets.definition.update' || name === 'widgets.definition.delete' || name === 'widgets.snapshot.post') {
        const context = { surface: 'agent' as const, authority: 'account_automation' as const };
        expect(isApprovalRequiredByActionsSettings(id, normalizeActionsSettingsV1({ v: 1 }), context), name).toBe(true);
        const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [name]: ['agent'] } });
        expect(isApprovalRequiredByActionsSettings(id, settings, context), name).toBe(false);
      }
    }
  });
  it('advertises instance edits and admits their strict qualified inputs through the real executor', async () => {
    const executor = createActionExecutor({} as unknown as ActionExecutorDeps);
    const id = 'widgets.instance.add' as ActionId;
    expect(getActionSpec(id).surfaces).toMatchObject({ agent: true, mcp: true, cli: true });
    const result = await executor.execute(id, {
      surface, instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} },
      forgedAuthority: true,
    }, { surface: 'mcp', bypassApprovals: true });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('defaults consequential edits to the existing approval policy', async () => {
    const executor = createActionExecutor({} as unknown as ActionExecutorDeps);
    const result = await executor.execute('widgets.instance.inputs.set' as ActionId, {
      ref: { surface: { ...surface, owner: { kind: 'sessionBoard', sessionId: 'shared' } }, instanceId: 'copy' }, bindings: {},
    }, { surface: 'agent', defaultSessionId: 'shared', serverId: 'home' });
    expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(await executor.execute('widgets.instance.move', {
      ref: { surface, instanceId: 'copy' }, to: { surface: { ...surface, owner: { kind: 'sessionBoard', sessionId: 'shared' } }, tabId: 'metrics', index: 0 },
    }, { surface: 'agent', defaultSessionId: 'shared', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  it('admits snapshot and promotion against their exact Session and Account before approval custody', async () => {
    // This admission-only fixture deliberately has no external effect adapters.
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }) } as unknown as ActionExecutorDeps);
    const snapshot = {
      surface: { ...surface, owner: { kind: 'sessionBoard' as const, sessionId: 'shared' } },
      itemId: 'frozen', title: 'Checks', placement: {},
      preview: { v: 1, asOf: '2026-10-05T01:00:00.000Z', provenance: [],
        document: { version: 1, root: { kind: 'text', text: '7 checks' } } },
    };
    const context = { surface: 'agent' as const, defaultSessionId: 'shared', serverId: 'home' };
    expect(await executor.execute('widgets.snapshot.post', snapshot, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(await executor.execute('widgets.snapshot.post', { ...snapshot,
      surface: { ...snapshot.surface, accountId: 'another' } }, context))
      .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await executor.execute('widgets.snapshot.post', snapshot, { ...context, defaultSessionId: 'origin' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: null, targets: { sessions: ['origin'], machines: ['origin-machine'] },
      approve: false, origins: [], models: null, permissionModes: null, create: null });
    const credentialContext = { surface: 'mcp' as const, defaultSessionId: 'origin', defaultSessionMachineId: 'origin-machine',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant } };
    expect(await executor.execute('widgets.snapshot.post', snapshot, credentialContext))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('widgets.definition.saveFromSession', {
      account: { serverId: 'home', accountId: 'account' }, session: { serverId: 'home', sessionId: 'shared' },
      itemId: 'source', artifactId: 'copy',
    }, credentialContext)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    // Account-level definition reads cannot borrow a restricted default Session grant.
    expect(await executor.execute('widgets.definition.list', { account: { serverId: 'home', accountId: 'account' } }, credentialContext))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });

  it('uses the nested surface Session for current-Session and credential admission', async () => {
    const executor = createActionExecutor({} as unknown as ActionExecutorDeps);
    const another = { ...surface, owner: { kind: 'sessionBoard' as const, sessionId: 'another' } };
    expect(await executor.execute('widgets.instance.list', { surface: another }, {
      surface: 'agent', defaultSessionId: 'origin', serverId: 'home', bypassApprovals: true,
    })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: null, targets: { sessions: ['origin'], machines: ['origin-machine'] },
      approve: false, origins: [], models: null, permissionModes: null, create: null });
    const context = { surface: 'mcp' as const, defaultSessionId: 'origin', defaultSessionMachineId: 'origin-machine',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant } };
    expect(await executor.execute('widgets.instance.list', { surface: another }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('widgets.instance.list', { surface }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    const physicalOrigin = { ...surface, owner: { kind: 'sessionBoard' as const, sessionId: 'origin' } };
    expect(await executor.execute('widgets.catalog.list', { surface: physicalOrigin, boundSession: { serverId: 'home', sessionId: 'another' } }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('widgets.catalog.list', { surface: physicalOrigin, boundSession: { serverId: 'home', sessionId: 'another' } },
      { surface: 'agent', defaultSessionId: 'origin', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(await executor.execute('widgets.instance.move', {
      ref: { surface: physicalOrigin, instanceId: 'copy' }, to: { surface: another, tabId: 'metrics', index: 0 },
    }, context)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('widgets.instance.move', {
      ref: { surface: physicalOrigin, instanceId: 'copy' }, to: { surface: another, tabId: 'metrics', index: 0 },
    }, { surface: 'agent', defaultSessionId: 'origin', serverId: 'home', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('round-trips independent Home copies through the existing Artifact writer and refuses another Account', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const homeHubArtifacts = createHomeHubArtifactPortV1({ ...boundary.forAccount(surface.accountId),
      read: async (id, options) => { const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: surface.accountId } : null; },
    }, { accountId: surface.accountId });
    const executor = createActionExecutor({
      homeHubArtifacts, widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetInputs: createWidgetActionInputResolverV1({
        readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
          inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }] }, inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false } }),
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
        validateValue: async (_field, value) => typeof value === 'number' && Number.isSafeInteger(value)
          ? { status: 'valid' } : { status: 'invalid', reasonCode: 'invalid_count' }, resolveOptions: async () => [],
      }),
    } as unknown as ActionExecutorDeps);
    const execute = (id: string, input: unknown) => executor.execute(id as ActionId, input, { surface: 'mcp', bypassApprovals: true });
    const instance = (id: string, value: number): WidgetInstanceV1 => ({ v: 1, id, definition: { kind: 'builtin', id: 'count' }, bindings: { count: { kind: 'value', value } } });
    expect(await execute('widgets.instance.add', { surface, instance: instance('one', 1) })).toMatchObject({ ok: true });
    expect(await execute('widgets.instance.add', { surface, instance: instance('two', 2) })).toMatchObject({ ok: true });
    const ref = { surface, instanceId: 'one' };
    expect(await execute('widgets.instance.inputs.set', { ref, bindings: { count: { kind: 'value', value: 3 } } })).toMatchObject({ ok: true });
    expect(await execute('widgets.instance.size.set', { ref, size: 'full' })).toMatchObject({ ok: true });
    expect(await execute('widgets.instance.frame.set', { ref, frameStyle: 'plain' })).toMatchObject({ ok: true });
    expect(await execute('widgets.instance.rename', { ref, displayName: 'First' })).toMatchObject({ ok: true });
    expect(await execute('widgets.instance.move', { ref, toIndex: 1 })).toMatchObject({ ok: true });
    const result = await execute('widgets.instance.list', { surface });
    expect(result).toMatchObject({ ok: true, result: { instances: [
      { instance: instance('two', 2), size: 'medium' },
      { instance: { ...instance('one', 3), displayName: 'First' }, size: 'full', frameStyle: 'plain' },
    ] } });
    const before = await homeHubArtifacts.read();
    expect(await execute('widgets.instance.move', { ref, toIndex: 0, to: { surface, index: 1 } })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await execute('widgets.instance.move', { ref, to: { surface: { ...surface, accountId: 'other' }, index: 0 } })).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await execute('widgets.instance.size.set', { ref, size: 'small' })).toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(await execute('widgets.instance.remove', { ref: { surface: { ...surface, accountId: 'other' }, instanceId: 'one' } })).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(await execute('widgets.instance.inputs.set', { ref, bindings: { count: { kind: 'value', value: 'invalid' } } })).toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(await execute('widgets.instance.remove', { ref })).toMatchObject({ ok: true, result: { instance: null } });
    expect((await homeHubArtifacts.read()).instances).toEqual([instance('two', 2)]);
  });
  it('fails closed before Artifact disclosure when the captured Account retires or the caller cancels', async () => {
    const boundary = createWorkBoardArtifactBoundary(); let reads = 0; let retired = false;
    const homeHubArtifacts = createHomeHubArtifactPortV1({ ...boundary.forAccount(surface.accountId),
      read: async (id, options) => { reads++; const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: surface.accountId } : null; },
    }, { accountId: surface.accountId });
    const executor = createActionExecutor({ homeHubArtifacts,
      // The host Account-lifetime boundary throws after retirement, as the UI authority does.
      widgetAccountScope: () => { if (retired) throw new Error('Account context retired'); return { serverId: surface.serverId, accountId: surface.accountId }; },
    } as unknown as ActionExecutorDeps);
    const context = { surface: 'mcp' as const, bypassApprovals: true };
    expect(await executor.execute('widgets.instance.list', { surface }, context)).toMatchObject({ ok: true });
    const admittedReads = reads;
    expect(await executor.execute('widgets.instance.list', { surface: { ...surface, accountId: 'other' } }, context))
      .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    retired = true;
    expect(await executor.execute('widgets.instance.list', { surface }, context)).toMatchObject({ ok: false, errorCode: 'widget_scope_unavailable' });
    const abort = new AbortController(); abort.abort();
    expect(await executor.execute('widgets.instance.list', { surface }, { ...context, signal: abort.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(reads).toBe(admittedReads);
  });
});
