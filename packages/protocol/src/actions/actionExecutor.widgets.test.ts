import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from './index.js';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWorkBoardArtifactPortV1 } from '../boards/workBoardArtifactV1.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';
import { createWorkBoardWidgetActionPortV1 } from '../widgets/workBoardWidgetActionPortV1.js';
import { createWidgetDefinitionArtifactPortV1 } from '../widgets/widgetDefinitionArtifactV1.js';
import { resolveWidgetBindingsV1, type WidgetInstanceV1 } from '../widgets/widgetInstanceV1.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';
import { createWidgetAreaActionPortV1, createWidgetAreaLayoutArtifactPortV1, createWidgetSurfaceArtifactPortV1 } from '../widgets/widgetSurfaceArtifactV1.js';
import { WIDGET_INSTANCE_ACTION_IDS_V1 } from '../widgets/actionIdsV1.js';
import { flattenWidgetLayoutWidgetsV1 } from '../widgets/widgetLayoutItemV1.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'home' } } as const;

describe('configured widget Actions', () => {
  it('refuses a Session-target credential for Account fragments before opening the Artifact port', async () => {
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }) });
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: ['widgets'], ids: [] },
      targets: { sessions: ['session'], machines: [] }, approve: false, origins: [], models: null, permissionModes: null, create: null });
    expect(await executor.execute('widgets.fragment.list', { account: { serverId: surface.serverId, accountId: surface.accountId } },
      { surface: 'mcp', defaultSessionId: 'session', serverId: surface.serverId,
        externalActionCredential: { accountId: surface.accountId, principalId: 'principal', credentialId: 'credential', grant } }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });
  it('advertises closed group mutations with the existing consequential approval policy', () => {
    for (const operation of ['create', 'ungroup', 'set', 'inputs.set']) {
      const name = `widgets.group.${operation}`;
      const admitted = ActionIdSchema.safeParse(name);
      expect(admitted.success, name).toBe(true);
      if (!admitted.success) continue;
      const spec = getActionSpec(admitted.data);
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
      expect(spec.inputSchema.safeParse({ surface, unexpected: true }).success).toBe(false);
      expect(isApprovalRequiredByActionsSettings(admitted.data, normalizeActionsSettingsV1({ v: 1 }),
        { surface: 'agent', authority: 'account_automation' })).toBe(true);
    }
  });
  it('creates and edits groups through the real area Artifact while preserving child placement options', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const area = { ...surface, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'main' } } as const;
    const artifact = createWidgetSurfaceArtifactPortV1(boundary.forAccount(surface.accountId), { surface: area, isCurrent: () => true });
    for (const id of ['a', 'b']) await artifact.apply({ kind: 'add', instance: { v: 1, id,
      definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} }, size: 'small', frameStyle: 'plain' });
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(() => artifact) } });
    const context = { surface: 'mcp', bypassApprovals: true } as const;
    const groupRef = { surface: area, instanceId: 'group' };
    expect(await executor.execute('widgets.group.create', { surface: area, groupId: 'group', instanceIds: ['a', 'b'] }, context))
      .toMatchObject({ ok: true, result: { ref: groupRef, instance: null, item: { kind: 'group', id: 'group', frameStyle: 'card', dividers: 'hairline' } } });
    expect(await executor.execute('widgets.item.rename', { ref: groupRef, displayName: 'Checks' }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.size.set', { ref: groupRef, width: 'half' }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.group.inputs.set', { ref: groupRef, bindings: { project: { kind: 'context', slot: 'project' } } }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.list', { surface: area }, context)).toMatchObject({ ok: true, result: {
      items: [{ kind: 'group', id: 'group', title: 'Checks', width: 'half', context: { project: { kind: 'context', slot: 'project' } } }],
    } });
    expect(await executor.execute('widgets.group.ungroup', { ref: groupRef }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('widgets.item.list', { surface: area }, context)).toMatchObject({ ok: true, result: {
      items: [{ kind: 'widget', instance: { id: 'a' }, frameStyle: 'plain' }, { kind: 'widget', instance: { id: 'b' }, frameStyle: 'plain' }],
    } });
  });
  it('retains a WorkBoard private-input refusal on Add without reporting an unknown commit', async () => {
    const boundary = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'shared', name: 'Shared' })]);
    const row = boundary.rows.get('shared')!;
    boundary.rows.set('shared', { ...row, ownerAccountId: surface.accountId, access: 'edit', shared: true });
    const board = { ...surface, owner: { kind: 'workBoard', boardId: 'shared' } } as const;
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      workBoardArtifacts: createWorkBoardArtifactPortV1(boundary.transport),
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'json' }] }, inputSchema: { type: 'object', properties: { connection: { type: 'object' } } } }),
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }) });
    expect(await executor.execute('widgets.item.add', { surface: board, instance: { v: 1, id: 'private', definition: { kind: 'builtin', id: 'count' },
      bindings: { connection: { kind: 'value', value: { service: { pluginId: 'acme.cloud', localId: 'service' }, accountId: 'private' } } } } },
      { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'widget_private_connection_selection' });
    expect(boundary.rows.get('shared')).toEqual({ ...row, ownerAccountId: surface.accountId, access: 'edit', shared: true });
  });
  it('retains a known shared-content refusal on Add without reporting an unknown commit', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const project = { ...surface, owner: { kind: 'project', projectId: 'shared' } } as const;
    const accountTransport = boundary.forAccount(surface.accountId);
    const transport = { ...accountTransport, read: async (...args: Parameters<typeof accountTransport.read>) => {
      const row = await accountTransport.read(...args); return row ? { ...row, access: 'edit' as const, shared: true } : null;
    } };
    const artifact = createWidgetSurfaceArtifactPortV1(transport, { surface: project, isCurrent: () => true });
    await artifact.apply({ kind: 'add', instance: { v: 1, id: 'public', definition: { kind: 'builtin', id: 'count' }, bindings: {} } });
    const before = [...boundary.rows.values()][0]!;
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetSurfaceActions: { project: createWidgetAreaActionPortV1(() => artifact) },
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'json' }] }, inputSchema: { type: 'object', properties: { connection: { type: 'object' } } } }), readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }) });
    expect(await executor.execute('widgets.item.add', { surface: project,
      instance: { v: 1, id: 'private', definition: { kind: 'builtin', id: 'count' }, bindings: { connection: { kind: 'value',
        value: { service: { pluginId: 'acme.cloud', localId: 'service' }, accountId: 'private' } } } } },
      { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'widget_shared_input_forbidden' });
    expect([...boundary.rows.values()][0]).toEqual(before);
  });
  it('creates, renames, reorders and deletes exact dashboard documents through real Artifact CAS', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const project = { ...surface, owner: { kind: 'project', projectId: 'source-free' } } as const;
    const transport = { ...boundary.forAccount(surface.accountId), delete: boundary.transport.delete,
      list: async (options: Parameters<typeof boundary.transport.list>[0]) => {
        const page = await boundary.transport.list(options);
        return { ...page, items: page.items.map(item => ({ ...item, bodyVersion: boundary.rows.get(item.artifactId)!.revision.bodyVersion })) };
      } };
    const resolve = (target: typeof project | import('../widgets/widgetInstanceV1.js').WidgetSurfaceRefV1) => createWidgetAreaLayoutArtifactPortV1(transport, { surface: target, isCurrent: () => true });
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetSurfaceActions: { project: createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(transport, { surface: target, isCurrent: () => true })) },
      widgetAreaLayouts: {
        reset: (args, _context, signal) => createWidgetSurfaceArtifactPortV1(transport, { surface: args.surface, isCurrent: () => true }).resetPreset(args.expectedRevision, signal),
        undo: (capture, _context, signal) => createWidgetSurfaceArtifactPortV1(transport, { surface: capture.surface, isCurrent: () => true }).undoReset(capture, signal),
        list: (args, _context, signal) => resolve(args.surface).list(signal),
        create: (args, _context, signal) => resolve(args.surface).create(args, signal),
        rename: (args, _context, signal) => resolve(args.surface).rename(args, signal),
        delete: (args, _context, signal) => resolve(args.surface).delete(args, signal),
        reorder: (args, _context, signal) => resolve(args.surface).reorder(args, signal),
      } });
    const context = { surface: 'mcp', bypassApprovals: true } as const;
    const execute = (operation: string, input: unknown) => executor.execute(`widgets.area.layout.${operation}` as ActionId, input, context);
    expect(await execute('list', { surface: project })).toMatchObject({ ok: true, result: { layouts: [{ isDefault: true, revision: null }] } });
    expect(boundary.rows.size).toBe(0);
    expect(await execute('create', { surface: project, layoutId: 'release', name: 'Release' })).toMatchObject({ ok: true, result: { name: 'Release', isDefault: false } });
    const named = { ...project, owner: { ...project.owner, layoutId: 'release' } };
    const port = resolve(project);
    const first = (await port.list()).find(item => !item.isDefault)!;
    expect(await execute('rename', { surface: named, name: 'Shipping', expectedRevision: first.revision })).toMatchObject({ ok: true, result: { artifactId: first.artifactId, name: 'Shipping' } });
    expect(await execute('delete', { surface: named, expectedRevision: first.revision })).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    const inventory = await port.list();
    const current = inventory.find(item => !item.isDefault)!;
    expect(await execute('reorder', { surface: named, expectedRevision: current.revision,
      position: { anchorId: inventory.find(item => item.isDefault)!.artifactId, placement: 'before' } })).toMatchObject({ ok: true });
    const reordered = (await port.list()).find(item => !item.isDefault)!;
    expect(await execute('delete', { surface: named, expectedRevision: reordered.revision })).toMatchObject({ ok: true, result: { artifactId: first.artifactId } });
    expect(boundary.rows.size).toBe(0);
  });
  it('removes only explicitly selected widget input choices while retaining unrelated bindings', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const homeHubArtifacts = createHomeHubArtifactPortV1(boundary.forAccount(surface.accountId), { accountId: surface.accountId });
    const instance: WidgetInstanceV1 = { v: 1, id: 'private-pin', definition: { kind: 'builtin', id: 'count' },
      bindings: { connection: { kind: 'value', value: { accountId: 'private' } }, count: { kind: 'value', value: 3 } } };
    await homeHubArtifacts.apply({ kind: 'widget_add', instance });
    const executor = createActionExecutor({ homeHubArtifacts,
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }) });
    const ref = { surface, instanceId: instance.id };
    expect(await executor.execute('widgets.item.inputs.reset', { ref, paths: ['connection'] },
      { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true });
    expect(flattenWidgetLayoutWidgetsV1((await homeHubArtifacts.read()).items)[0]?.instance.bindings).toEqual({ count: { kind: 'value', value: 3 } });
  });
  it('selectively resets against the current Home winner without overwriting an unrelated concurrent edit', async () => {
    const boundary = createWorkBoardArtifactBoundary();
    const transport = boundary.forAccount(surface.accountId);
    const concurrent = createHomeHubArtifactPortV1(transport, { accountId: surface.accountId });
    let race = false;
    const homeHubArtifacts = createHomeHubArtifactPortV1({ ...transport, update: async request => {
      if (race) {
        race = false;
        await concurrent.apply({ kind: 'widget_inputs', instanceId: 'private-pin', bindings: {
          connection: { kind: 'value', value: { accountId: 'private' } }, count: { kind: 'value', value: 9 },
        } });
      }
      return transport.update(request);
    } }, { accountId: surface.accountId });
    await homeHubArtifacts.apply({ kind: 'widget_add', instance: { v: 1, id: 'private-pin', definition: { kind: 'builtin', id: 'count' },
      bindings: { connection: { kind: 'value', value: { accountId: 'private' } }, count: { kind: 'value', value: 3 } } } });
    const executor = createActionExecutor({ homeHubArtifacts, widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }) });
    race = true;
    expect(await executor.execute('widgets.item.inputs.reset', { ref: { surface, instanceId: 'private-pin' }, paths: ['connection'] },
      { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true });
    expect(flattenWidgetLayoutWidgetsV1((await homeHubArtifacts.read()).items)[0]?.instance.bindings).toEqual({ count: { kind: 'value', value: 9 } });
  });
  it.each([false, true])('merges selected inputs into the current Home winner after complete validation (native=%s)', async native => {
    const boundary = createWorkBoardArtifactBoundary();
    const transport = boundary.forAccount(surface.accountId);
    const concurrent = createHomeHubArtifactPortV1(transport, { accountId: surface.accountId });
    let race = false;
    const homeHubArtifacts = createHomeHubArtifactPortV1({ ...transport, update: async request => {
      if (race) {
        race = false;
        await concurrent.apply({ kind: 'widget_inputs', instanceId: 'copy', bindings: {
          selected: { kind: 'value', value: 1 }, count: { kind: 'value', value: 9 },
        } });
      }
      return transport.update(request);
    } }, { accountId: surface.accountId });
    await homeHubArtifacts.apply({ kind: 'widget_add', instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'count' },
      bindings: { selected: { kind: 'value', value: 1 }, count: { kind: 'value', value: 3 } } } });
    const executor = createActionExecutor({ homeHubArtifacts, widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'count', title: 'Count', widget: 'integer' }, { path: 'selected', title: 'Selected', widget: 'integer' }] },
        inputSchema: { type: 'object', properties: { count: { type: 'integer' }, selected: { type: 'integer' } }, required: ['count', 'selected'] } }),
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }) });
    race = true;
    const bindings = { selected: { kind: 'value' as const, value: 2 } };
    expect(await executor.execute(native ? 'home.hub.layout.update' : 'widgets.item.inputs.set', native
      ? { intent: { kind: 'widget_inputs', instanceId: 'copy', bindings, paths: ['selected'] } }
      : { ref: { surface, instanceId: 'copy' }, bindings, paths: ['selected'] }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true });
    expect(flattenWidgetLayoutWidgetsV1((await homeHubArtifacts.read()).items)[0]?.instance.bindings).toEqual({ selected: { kind: 'value', value: 2 }, count: { kind: 'value', value: 9 } });
  });
  it('discovers strict Project dashboard Actions and refuses default deletion before transport', async () => {
    const project = { ...surface, owner: { kind: 'project', projectId: 'project' } } as const;
    for (const id of WIDGET_INSTANCE_ACTION_IDS_V1) expect(getActionSpec(id).surfaces.voice, id).toBe(true);
    for (const operation of ['list', 'create', 'select', 'rename', 'delete', 'reorder', 'reset', 'undo']) {
      const id = `widgets.area.layout.${operation}` as ActionId;
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      const spec = getActionSpec(id);
      expect(spec.executionPlacement).toBe(operation === 'select' ? 'client' : 'account');
      expect(isApprovalRequiredByActionsSettings(id, normalizeActionsSettingsV1({ v: 1 }), { surface: 'mcp' })).toBe(operation !== 'list' && operation !== 'select');
      expect(spec.inputSchema.safeParse({ surface: project, unexpected: true }).success).toBe(false);
    }
    for (const id of ['widgets.area.dashboard.list', 'widgets.area.preset.reset', 'widgets.area.layout.get', 'widgets.area.layout.update']) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(false);
    }
    const boundary = createWorkBoardArtifactBoundary();
    const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetSurfaceActions: { project: createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(boundary.forAccount(surface.accountId), { surface: target, isCurrent: () => true })) } });
    expect(await executor.execute('widgets.area.layout.delete' as ActionId, {
      surface: project, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
    }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'widget_area_layout_default_protected' });
  });
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
      expect((await homeHubArtifacts.read()).items).toEqual([]);
      const result = native
        ? await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_size', instanceId, size: 'tall' } }, { surface: 'mcp', bypassApprovals: true })
        : await executor.execute('widgets.item.size.set', { ref: { surface, instanceId }, size: 'tall' }, { surface: 'mcp', bypassApprovals: true });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(flattenWidgetLayoutWidgetsV1((await homeHubArtifacts.read()).items)).toMatchObject([{ instance: { id: instanceId }, size: 'tall' }]);
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
    expect(await execute('widgets.item.add', { surface, instance, size: 'medium' })).toMatchObject({ ok: true });
    expect(flattenWidgetLayoutWidgetsV1((await homeHubArtifacts.read()).items).find(entry => entry.instance.id === 'sized-copy')?.size).toBe('medium');
    expect(await execute('widgets.item.size.set', { ref: { surface, instanceId: instance.id }, size: 'tall' })).toMatchObject({ ok: true });
    const before = await homeHubArtifacts.read();
    expect(await execute('widgets.item.size.set', { ref: { surface, instanceId: instance.id }, size: 'full' }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await execute('widgets.item.add', { surface, instance: { ...instance, id: 'refused' }, size: 'full' }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await execute('home.hub.layout.update', { intent: { kind: 'widget_size', instanceId: instance.id, size: 'full' } }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await execute('home.hub.layout.update', { intent: { kind: 'widget_add', instance: { ...instance, id: 'native-refused' }, size: 'full' } }))
      .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(ActionIdSchema.safeParse('widgets.item.width.set').success).toBe(false);
    const spec = getActionSpec('widgets.item.size.set' as ActionId);
    expect(spec.bindings?.mcpToolName).toBe('widgets_item_size_set');
    expect(isApprovalRequiredByActionsSettings(spec.id, normalizeActionsSettingsV1({ v: 1 }), { surface: 'mcp' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(spec.id, normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { [spec.id]: ['mcp'] } }), { surface: 'mcp' })).toBe(false);
  });
  it('discovers the target size choices and default through the catalog Action', async () => {
    // The catalog port is supplied by the answering UI/daemon's installed projection.
    const boundary = createWorkBoardArtifactBoundary();
    const executor = createActionExecutor({
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      widgetSurfaceActions: { project: createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(boundary.forAccount(surface.accountId), { surface: target, isCurrent: () => true })) },
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
    expect(await executor.execute('widgets.item.refresh', { ref }, context))
      .toMatchObject({ ok: false, errorCode: 'widget_refresh_unavailable' });
    expect(await executor.execute('widgets.item.list', { surface: { ...surface,
      owner: { kind: 'companion', sessionId: 'session' } } }, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    for (const id of ['widgets.item.viewerInputs.get', 'widgets.item.viewerInputs.set', 'widgets.item.viewerInputs.reset'] as const) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('delivers Companion reads and transfers through the answering client while Home stays Account-owned', async () => {
    const companion = { ...surface, owner: { kind: 'companion', sessionId: 'session' } } as const;
    const readSpec = getActionSpec('widgets.item.inputs.get');
    expect(resolveActionExecutionPlacementForInput(readSpec, readSpec.inputSchema.parse({ ref: { surface: companion, instanceId: 'checks' } }))).toBe('client');
    expect(resolveActionExecutionPlacementForInput(readSpec, readSpec.inputSchema.parse({ ref: { surface, instanceId: 'checks' } }))).toBe('account');
    const bindings = { count: { kind: 'value', value: 7 } } as const;
    // The connected-client hop is a transport boundary; admission/placement are real.
    const executor = createActionExecutor({
      widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
      clientActionExecute: async ({ actionId, input }) => actionId === 'widgets.item.inputs.get'
        ? { ok: true, result: { ref: { surface: companion, instanceId: 'checks' }, bindings } }
        : { ok: false, errorCode: 'answering_client', error: JSON.stringify(input) },
    });
    const context = { surface: 'mcp', serverId: surface.serverId, bypassApprovals: true } as const;
    expect(await executor.execute('widgets.item.inputs.get', { ref: { surface: companion, instanceId: 'checks' } }, context))
      .toEqual({ ok: true, result: { ref: { surface: companion, instanceId: 'checks' }, bindings } });
    for (const [from, to] of [[surface, companion], [companion, surface]] as const) {
      const input = { ref: { surface: from, instanceId: 'checks' }, to: { surface: to, index: 0 } };
      expect(await executor.execute('widgets.item.move', input, context))
        .toEqual({ ok: false, errorCode: 'answering_client', error: JSON.stringify(input) });
    }
    expect(await executor.execute('widgets.item.inputs.get', { ref: { surface, instanceId: 'checks' } }, context))
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
  it('advertises item edits and admits their strict qualified inputs through the real executor', async () => {
    const executor = createActionExecutor({} as unknown as ActionExecutorDeps);
    const id = 'widgets.item.add' as ActionId;
    expect(getActionSpec(id).surfaces).toMatchObject({ agent: true, mcp: true, cli: true });
    const result = await executor.execute(id, {
      surface, instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} },
      forgedAuthority: true,
    }, { surface: 'mcp', bypassApprovals: true });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('defaults consequential edits to the existing approval policy', async () => {
    const executor = createActionExecutor({} as unknown as ActionExecutorDeps);
    const result = await executor.execute('widgets.item.inputs.set' as ActionId, {
      ref: { surface: { ...surface, owner: { kind: 'sessionBoard', sessionId: 'shared' } }, instanceId: 'copy' }, bindings: {},
    }, { surface: 'agent', defaultSessionId: 'shared', serverId: 'home' });
    expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(await executor.execute('widgets.item.move', {
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
    expect(await executor.execute('widgets.item.list', { surface: another }, {
      surface: 'agent', defaultSessionId: 'origin', serverId: 'home', bypassApprovals: true,
    })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: null, targets: { sessions: ['origin'], machines: ['origin-machine'] },
      approve: false, origins: [], models: null, permissionModes: null, create: null });
    const context = { surface: 'mcp' as const, defaultSessionId: 'origin', defaultSessionMachineId: 'origin-machine',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant } };
    expect(await executor.execute('widgets.item.list', { surface: another }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('widgets.item.list', { surface }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    const physicalOrigin = { ...surface, owner: { kind: 'sessionBoard' as const, sessionId: 'origin' } };
    expect(await executor.execute('widgets.catalog.list', { surface: physicalOrigin, boundSession: { serverId: 'home', sessionId: 'another' } }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('widgets.catalog.list', { surface: physicalOrigin, boundSession: { serverId: 'home', sessionId: 'another' } },
      { surface: 'agent', defaultSessionId: 'origin', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(await executor.execute('widgets.item.move', {
      ref: { surface: physicalOrigin, instanceId: 'copy' }, to: { surface: another, tabId: 'metrics', index: 0 },
    }, context)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await executor.execute('widgets.item.move', {
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
    expect(await execute('widgets.item.add', { surface, instance: instance('one', 1) })).toMatchObject({ ok: true });
    expect(await execute('widgets.item.add', { surface, instance: instance('two', 2) })).toMatchObject({ ok: true });
    const ref = { surface, instanceId: 'one' };
    expect(await execute('widgets.item.inputs.set', { ref, bindings: { count: { kind: 'value', value: 3 } } })).toMatchObject({ ok: true });
    expect(await execute('widgets.item.size.set', { ref, size: 'full' })).toMatchObject({ ok: true });
    expect(await execute('widgets.item.frame.set', { ref, frameStyle: 'plain' })).toMatchObject({ ok: true });
    expect(await execute('widgets.item.rename', { ref, displayName: 'First' })).toMatchObject({ ok: true });
    expect(await execute('widgets.item.move', { ref, toIndex: 1 })).toMatchObject({ ok: true });
    const result = await execute('widgets.item.list', { surface });
    expect(result).toMatchObject({ ok: true, result: { instances: [
      { instance: instance('two', 2), size: 'medium' },
      { instance: { ...instance('one', 3), displayName: 'First' }, size: 'full', frameStyle: 'plain' },
    ] } });
    const before = await homeHubArtifacts.read();
    expect(await execute('widgets.item.move', { ref, toIndex: 0, to: { surface, index: 1 } })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await execute('widgets.item.move', { ref, to: { surface: { ...surface, accountId: 'other' }, index: 0 } })).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await execute('widgets.item.size.set', { ref, size: 'small' })).toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(await execute('widgets.item.remove', { ref: { surface: { ...surface, accountId: 'other' }, instanceId: 'one' } })).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(await execute('widgets.item.inputs.set', { ref, bindings: { count: { kind: 'value', value: 'invalid' } } })).toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid' });
    expect(await execute('home.hub.layout.update', { intent: { kind: 'widget_inputs', instanceId: ref.instanceId,
      bindings: { count: { kind: 'value', value: 'invalid' } }, paths: ['count'] } }))
      .toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid' });
    expect(await homeHubArtifacts.read()).toEqual(before);
    expect(await execute('widgets.item.remove', { ref })).toMatchObject({ ok: true, result: { instance: null } });
    expect(flattenWidgetLayoutWidgetsV1((await homeHubArtifacts.read()).items).map(entry => entry.instance)).toEqual([instance('two', 2)]);
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
    expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true });
    const admittedReads = reads;
    expect(await executor.execute('widgets.item.list', { surface: { ...surface, accountId: 'other' } }, context))
      .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    retired = true;
    expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: false, errorCode: 'widget_scope_unavailable' });
    const abort = new AbortController(); abort.abort();
    expect(await executor.execute('widgets.item.list', { surface }, { ...context, signal: abort.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(reads).toBe(admittedReads);
  });
  it('uses admitted shared Artifact facts for configurable present-user Project and WorkBoard write approval', async () => {
    for (const kind of ['project', 'workBoard'] as const) {
      const boundary = createWorkBoardArtifactBoundary(kind === 'workBoard'
        ? [createWorkBoardV1({ id: 'board', name: 'Shared' })] : []);
      const target = { ...surface, owner: kind === 'project'
        ? { kind, projectId: 'source-free' } : { kind, boardId: 'board' } };
      const workBoardArtifacts = kind === 'workBoard' ? createWorkBoardArtifactPortV1(boundary.transport) : undefined;
      const port = kind === 'project'
        ? createWidgetAreaActionPortV1(() => createWidgetSurfaceArtifactPortV1(boundary.forAccount(surface.accountId),
          { surface: target, isCurrent: () => true }))
        : createWorkBoardWidgetActionPortV1(workBoardArtifacts!);
      const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'count' }, bindings: {} };
      await port.apply(target, { kind: 'add', instance }, { surface: 'ui' });
      const executor = createActionExecutor({ widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
        widgetSurfaceActions: { [kind]: port }, workBoardArtifacts });
      const ref = { surface: target, instanceId: instance.id };
      const personal = await executor.execute('widgets.item.rename', { ref, displayName: 'Personal' }, { surface: 'ui', authority: 'present_user' });
      expect(personal, JSON.stringify(personal))
        .toMatchObject({ ok: true });
      const row = [...boundary.rows.values()][0]!;
      boundary.rows.set(row.artifactId, { ...row, shared: true });
      const before = boundary.rows.get(row.artifactId);
      expect(await executor.execute('widgets.item.rename', { ref, displayName: 'Shared' }, { surface: 'ui', authority: 'present_user' }))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      if (kind === 'workBoard') {
        expect(await executor.execute('boards.apply', { intent: { kind: 'widget_rename', boardId: 'board', ref, displayName: 'Native' } },
          { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      }
      expect(boundary.rows.get(row.artifactId)).toBe(before);
      const actionsSettings = normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'widgets.item.rename': ['ui'] } });
      expect(await executor.execute('widgets.item.rename', { ref, displayName: 'Shared' }, { surface: 'ui', authority: 'present_user', actionsSettings }))
        .toMatchObject({ ok: true });
    }
  });
});
