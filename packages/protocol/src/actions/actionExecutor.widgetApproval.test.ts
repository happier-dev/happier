import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import type { ActionId } from './actionIds.js';
import { ActionsSettingsV1Schema, normalizeActionsSettingsV1 } from './actionSettings.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import type { WidgetSurfaceRefV1 } from '../widgets/widgetInstanceV1.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { buildWidgetSurfaceArtifactIdV1, createWidgetAreaActionPortV1, createWidgetAreaLayoutArtifactPortV1, createWidgetSurfaceArtifactPortV1 } from '../widgets/widgetSurfaceArtifactV1.js';
import { WidgetInstanceActionOutputSchemasV1 } from '../widgets/actionsV1.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { ApprovalRequestSchema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createPluginWidgetAreaHostPortV1 } from '../plugins/ui/widgetAreaHost.js';
import { UiSurfaceNetworkRequestV1Schema } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { createWidgetDefinitionArtifactPortV1 } from '../widgets/widgetDefinitionArtifactV1.js';
import { WidgetDefinitionV1Schema } from '../widgets/widgetDefinitionV1.js';

const account = { serverId: 'home', accountId: 'account' };

async function fixture(owner: WidgetSurfaceRefV1['owner'], shared: boolean | ((artifactId: string) => boolean), policyHook = true,
  presentUserActionConfirmation?: () => Promise<boolean>, readActionsSettings?: () => ReturnType<typeof normalizeActionsSettingsV1>) {
  const boundary = createWorkBoardArtifactBoundary();
  const artifactReads: string[] = [];
  const transport = boundary.forAccount(account.accountId);
  // Artifact transport is the system boundary; domain ports and approval logic remain real.
  const admittedTransport = { ...transport, delete: boundary.transport.delete,
    read: async (...args: Parameters<typeof transport.read>) => {
      artifactReads.push(args[0]);
      const row = await transport.read(...args);
      return row ? { ...row, shared: typeof shared === 'function' ? shared(row.artifactId) : shared } : null;
    },
    list: async (...args: Parameters<typeof boundary.transport.list>) => {
      const page = await boundary.transport.list(...args);
      return { ...page, items: page.items.map(row => ({ ...row, bodyVersion: boundary.rows.get(row.artifactId)!.revision.bodyVersion })) };
    },
  };
  const surface: WidgetSurfaceRefV1 = { ...account, owner };
  const presets = [{ id: 'main', name: 'Main', items: [] }, { id: 'other', name: 'Other', items: [] }];
  const artifactFor = (target: WidgetSurfaceRefV1) => createWidgetSurfaceArtifactPortV1(admittedTransport,
    { surface: target, isCurrent: () => true, presets });
  const layoutsFor = (target: WidgetSurfaceRefV1) => createWidgetAreaLayoutArtifactPortV1(admittedTransport,
    { surface: target, isCurrent: () => true, presets });
  const artifact = artifactFor(surface);
  for (const id of ['one', 'two']) await artifact.apply({ kind: 'add', instance: {
    v: 1, id, definition: { kind: 'builtin', id: 'session_summary' }, bindings: {},
  }, size: 'small' });
  await artifact.apply({ kind: 'group_create', groupId: 'group', instanceIds: ['two'] });
  const port = createWidgetAreaActionPortV1(artifactFor);
  const homeHubArtifacts = createHomeHubArtifactPortV1(admittedTransport, { accountId: account.accountId });
  const definitions = createWidgetDefinitionArtifactPortV1(admittedTransport, { accountId: account.accountId });
  const executor = createActionExecutor({ homeHubArtifacts, widgetDefinitionArtifacts: definitions, widgetAccountScope: () => account, presentUserActionConfirmation,
    ...(policyHook ? { readActionsSettings: context => readActionsSettings?.() ?? context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }) } : {}),
    widgetSurfaceActions: { project: port, corePage: port, pluginArea: port },
    widgetInputs: createWidgetActionInputResolverV1({
      readDescriptor: async ({ instance }) => readBuiltinWidgetDescriptorV1(instance.definition),
      readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
      validateValue: async () => ({ status: 'valid' }),
      resolveOptions: async (_field, _input, _request, values) => values.map(value => ({ value })),
    }),
    widgetAreaLayouts: {
      reset: (input, _context, signal) => artifactFor(input.surface).resetPreset(input.expectedRevision, signal),
      undo: (capture, _context, signal) => artifactFor(capture.surface).undoReset(capture, signal),
      list: (input, _context, signal) => layoutsFor(input.surface).list(signal),
      create: (input, _context, signal) => layoutsFor(input.surface).create(input, signal),
      rename: (input, _context, signal) => layoutsFor(input.surface).rename(input, signal),
      reorder: (input, _context, signal) => layoutsFor(input.surface).reorder(input, signal),
      delete: (input, _context, signal) => layoutsFor(input.surface).delete(input, signal),
    },
  });
  return { surface, artifact, artifactFor, homeHubArtifacts, definitions, artifactReads, layouts: layoutsFor(surface), executor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function revision(artifact: Fixture['artifact']) {
  const state = await artifact.readState();
  if (state.kind !== 'present') throw new Error('Expected seeded layout');
  return state.revision;
}
const edits: readonly { name: string; action: ActionId; input: (state: Fixture) => Promise<unknown> | unknown }[] = [
  { name: 'widget rename', action: 'widgets.item.rename', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, displayName: 'Renamed' }) },
  { name: 'widget size', action: 'widgets.item.size.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, size: 'medium' }) },
  { name: 'widget frame', action: 'widgets.item.frame.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, frameStyle: 'plain' }) },
  { name: 'widget reorder', action: 'widgets.item.move', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, toIndex: 1 }) },
  { name: 'widget native reorder', action: 'widgets.item.move', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, to: { surface, index: 1 } }) },
  { name: 'group width', action: 'widgets.item.size.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, width: 'half' }) },
  { name: 'group dividers', action: 'widgets.group.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, dividers: 'none' }) },
  { name: 'layout create', action: 'widgets.area.layout.create', input: ({ surface }) => ({ surface, layoutId: 'new', name: 'New' }) },
  { name: 'layout rename', action: 'widgets.area.layout.rename', input: async ({ surface, artifact }) => ({ surface, name: 'Renamed', expectedRevision: await revision(artifact) }) },
  { name: 'layout reorder', action: 'widgets.area.layout.reorder', input: async ({ surface, artifact, layouts }) => ({ surface,
    expectedRevision: await revision(artifact), position: { anchorId: (await layouts.list()).find(row => row.surface.owner.kind === surface.owner.kind && 'layoutId' in row.surface.owner && row.surface.owner.layoutId === 'other')!.artifactId, placement: 'after' } }) },
  { name: 'layout reset', action: 'widgets.area.layout.reset', input: async ({ surface, artifact }) => ({ surface, expectedRevision: await revision(artifact) }) },
  { name: 'layout undo', action: 'widgets.area.layout.undo', input: async ({ artifact }) => {
    const reset = await artifact.resetPreset(await revision(artifact));
    return { capture: reset.undo };
  } },
];

const owners = [
  { name: 'private Project', owner: { kind: 'project', projectId: 'project', layoutId: 'main' }, shared: false },
  { name: 'shared Project', owner: { kind: 'project', projectId: 'project', layoutId: 'main' }, shared: true },
  { name: 'plugin area', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'pinned', layoutId: 'main' }, shared: false },
  { name: 'shared plugin area', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'pinned', layoutId: 'main' }, shared: true },
  { name: 'core page', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, shared: false },
  { name: 'shared core page', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, shared: true },
] as const;

const automationEdits: readonly { action: ActionId; input: (state: Fixture) => unknown }[] = [
  { action: 'widgets.item.remove', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' } }) },
  { action: 'widgets.item.add', input: ({ surface }) => ({ surface, instance: { v: 1, id: 'added', definition: { kind: 'builtin', id: 'session_summary' },
    bindings: { session: { kind: 'value', value: { serverId: account.serverId, sessionId: 'session-1' } } } } }) },
  { action: 'widgets.item.inputs.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' }, bindings: {} }) },
  { action: 'widgets.item.inputs.reset', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' } }) },
  { action: 'widgets.group.create', input: ({ surface }) => ({ surface, groupId: 'another-group', instanceIds: ['one'] }) },
  { action: 'widgets.group.ungroup', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' } }) },
  { action: 'widgets.group.inputs.set', input: ({ surface }) => ({ ref: { surface, instanceId: 'group' }, bindings: {} }) },
  { action: 'widgets.group.add', input: ({ surface }) => ({ surface, group: { kind: 'group', id: 'copied-group', width: 'full',
    frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance: { v: 1, id: 'copied-child', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }] } }) },
  { action: 'widgets.item.move', input: ({ surface }) => ({ ref: { surface, instanceId: 'one' },
    to: { surface: { ...surface, owner: { ...surface.owner, layoutId: 'other' } }, index: 0 } }) },
];

describe('contextual widget approval at the Action executor', () => {
  it.each(['widgets.item.add', 'widgets.item.remove'] as const)('captures installed widget names before %s and preserves its Action operands', async actionId => {
    const surface: WidgetSurfaceRefV1 = { ...account, owner: { kind: 'pluginArea', pluginId: 'examples.widget-areas', pageId: 'overview', area: 'pinned' } };
    const instance = { v: 1, id: 'directory-copy', definition: { kind: 'installed', surface: { pluginId: 'examples.widget-areas', localId: 'count' } }, bindings: {} } as const;
    const boundary = createWorkBoardArtifactBoundary();
    const artifact = createWidgetSurfaceArtifactPortV1(boundary.forAccount(account.accountId), { surface, isCurrent: () => true });
    await artifact.apply({ kind: 'add', instance });
    const requests: ApprovalRequest[] = [];
    const executor = createActionExecutor({ widgetAccountScope: () => account,
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [context.surface] } } }),
      widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(() => artifact) },
      widgetCatalog: { list: async () => [{ definition: instance.definition, title: 'Directory count', fields: [], availability: 'available',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, instanceCount: 1 }],
        describeSurface: async () => ({ pageName: 'Widget areas', areaName: 'Pinned' }) },
      approvalsCreate: async ({ request }) => { requests.push(ApprovalRequestSchema.parse(request)); return { artifactId: 'approval' }; },
    });
    const input = actionId === 'widgets.item.add' ? { surface, instance } : { ref: { surface, instanceId: instance.id } };
    await executor.execute(actionId, input, { surface: 'cli', authority: 'account_automation', runtimeAccountId: account.accountId,
      serverId: account.serverId, defaultSessionMachineId: 'machine', actionRequestId: 'remove-directory' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actionArgs: input, preview: {
      widgetPresentation: { widgetName: 'Directory count', pageName: 'Widget areas', areaName: 'Pinned' },
      summary: actionId === 'widgets.item.add' ? 'Add “Directory count” to Widget areas · Pinned.' : 'Remove “Directory count” from Widget areas · Pinned.',
    } });
    expect((await artifact.read()).items).toHaveLength(1);
  });
  it.each([
    { entry: 'execute', policy: 'direct' },
    { entry: 'prepare', policy: 'direct' },
    { entry: 'execute', policy: 'unattended' },
  ] as const)('uses $policy policy for followed page input through $entry without persisting context', async ({ entry, policy }) => {
    const boundary = createWorkBoardArtifactBoundary();
    const surface: WidgetSurfaceRefV1 = { ...account, owner: { kind: 'pluginArea', pluginId: 'external.widgets', pageId: 'overview', area: 'pinned' } };
    const artifact = createWidgetSurfaceArtifactPortV1(boundary.forAccount(account.accountId), { surface, isCurrent: () => true });
    const requests: ApprovalRequest[] = [];
    const executor = createActionExecutor({
      widgetAccountScope: () => account,
      widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(() => artifact) },
      widgetInputs: createWidgetActionInputResolverV1({
        readDescriptor: async ({ instance }) => readBuiltinWidgetDescriptorV1(instance.definition),
        readContext: async request => request.context.widgetAreaContext?.values ?? {},
        readViewerValues: async () => ({ values: {} }),
        // Session readability is the external host boundary; the resolver and binder remain real.
        validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
      }),
      // Approval persistence is the external boundary; policy and dispatch remain real.
      approvalsCreate: async ({ request }) => { requests.push(ApprovalRequestSchema.parse(request)); return { artifactId: 'approval' }; },
    });
    const host = createPluginWidgetAreaHostPortV1({ scope: account, pluginId: 'external.widgets', pageId: 'overview',
      declarations: [{ name: 'pinned', contextSchema: { type: 'object', properties: { session: { type: 'object' } }, required: ['session'], additionalProperties: false } }],
      isCurrent: () => true,
      execute: async (id, input, context) => {
        const invocation = { ...context, surface: 'plugin' as const, authority: 'account_automation' as const,
          defaultSessionMachineId: 'machine', runtimeAccountId: account.accountId,
          // A person's saved Direct choice does not lend the plugin present-user authority.
          actionsSettings: normalizeActionsSettingsV1({ v: 1, ...(policy === 'direct'
            ? { approvalWaivedSurfaces: { 'widgets.item.add': ['plugin'] } } : {}) }),
          actionCaller: { kind: 'plugin' as const, pluginId: 'external.widgets', contributionLocalId: 'overview',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'external-root' } } };
        if (entry === 'execute') return executor.execute(id, input, invocation);
        const prepared = await executor.prepare(id, input, invocation);
        return prepared.kind === 'ready' ? prepared.invocation.run() : prepared.result;
      } });
    const copy = { v: 1 as const, id: 'follow', definition: { kind: 'builtin' as const, id: 'session_summary' },
      bindings: { session: { kind: 'context' as const, slot: 'session' } } };
    const result = await host.execute({ area: 'pinned', context: { session: { serverId: account.serverId, sessionId: 'private-session' } },
      operation: { actionId: 'widgets.item.add', instance: copy } }, undefined, 'page-add-request');
    const items = (await artifact.read()).items;
    if (policy === 'direct') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { instance: copy } });
      expect(items).toEqual([expect.objectContaining({ instance: copy })]);
      expect(requests).toHaveLength(0);
    } else {
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' } });
      expect(items).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ status: 'open' });
      expect(JSON.stringify(requests)).not.toContain('private-session');
    }
  });
  it.each(['waived', 'ask'] as const)('uses saved %s policy for an audience-widening move', async policy => {
    const actionId = 'widgets.item.move';
    const settings = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { [actionId]: ['ui'] },
      ...(policy === 'ask' ? { actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } : {}),
    });
    let confirmations = 0;
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, true,
      true, async () => { confirmations += 1; return false; }, () => settings);
    const instance = { v: 1, id: 'movable', definition: { kind: 'builtin', id: 'your_home' }, bindings: {} } as const;
    await state.homeHubArtifacts.apply({ kind: 'widget_add', instance });
    const input = { ref: { surface: { ...account, owner: { kind: 'home' } }, instanceId: instance.id },
      to: { surface: state.surface, index: 0 } };
    const result = await state.executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionsSettings: settings });
    expect(result).toMatchObject(policy === 'waived' ? { ok: true } : { ok: false, errorCode: 'approval_canceled' });
    expect(confirmations).toBe(policy === 'waived' ? 0 : 1);
    expect((await state.artifact.read()).items.some(item => item.kind === 'widget' && item.instance.id === instance.id)).toBe(policy === 'waived');
  });

  it('confirms an admitted private-to-shared move from Home without lending authority to input audience fields', async () => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, true,
      true, async () => false);
    const instance = { v: 1, id: 'movable', definition: { kind: 'builtin', id: 'your_home' }, bindings: {} } as const;
    await state.homeHubArtifacts.apply({ kind: 'widget_add', instance });
    const input = { ref: { surface: { ...account, owner: { kind: 'home' } }, instanceId: instance.id },
      to: { surface: state.surface, index: 0 } };
    expect(await state.executor.execute('widgets.item.move', input, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect((await state.homeHubArtifacts.read()).items).toContainEqual(expect.objectContaining({ instance }));
    expect((await state.artifact.read()).items.some(item => item.kind === 'widget' && item.instance.id === instance.id)).toBe(false);
    expect(await state.executor.execute('widgets.item.move', { ...input, isShared: false }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it.each(owners.filter(row => !row.shared).flatMap(row => [true, false].map(policyHook => ({ ...row, policyHook }))))(
    'confirms an admitted private-to-shared move on $name (policy hook=$policyHook)', async row => {
      const destination: WidgetSurfaceRefV1 = { ...account, owner: { ...row.owner, layoutId: 'other' } };
      const destinationId = buildWidgetSurfaceArtifactIdV1(destination);
      let approved = false;
      let confirmations = 0;
      const state = await fixture(row.owner, artifactId => artifactId === destinationId, row.policyHook,
        async () => { confirmations += 1; return approved; });
      await state.artifact.apply({ kind: 'add', instance: { v: 1, id: 'movable',
        definition: { kind: 'builtin', id: 'your_home' }, bindings: {} }, size: 'small' });
      const target = state.artifactFor(destination);
      await target.apply({ kind: 'add', instance: { v: 1, id: 'existing',
        definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} }, size: 'small' });
      const input = { ref: { surface: state.surface, instanceId: 'movable' }, to: { surface: destination, index: 0 } };
      const context = { surface: 'ui', authority: 'present_user' } as const;
      const sourceBefore = (await state.artifact.read()).items;
      const destinationBefore = (await target.read()).items;
      expect(await state.executor.execute('widgets.item.move', input, context))
        .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
      expect(confirmations).toBe(1);
      expect((await state.artifact.read()).items).toEqual(sourceBefore);
      expect((await target.read()).items).toEqual(destinationBefore);
      approved = true;
      const moved = await state.executor.execute('widgets.item.move', input, context);
      expect(moved).toMatchObject({ ok: true });
      if (!moved.ok) throw new Error(moved.errorCode);
      expect(WidgetInstanceActionOutputSchemasV1['widgets.item.move'].safeParse(moved.result).success).toBe(true);
      expect(confirmations).toBe(2);
      expect((await state.artifact.read()).items.some(item => item.kind === 'widget' && item.instance.id === 'movable')).toBe(false);
      expect((await target.read()).items).toContainEqual(expect.objectContaining({ instance: expect.objectContaining({ id: 'movable' }) }));
    });

  it.each([{ sourceShared: false, destinationShared: false }, { sourceShared: true, destinationShared: true },
    { sourceShared: true, destinationShared: false }])('keeps a reversible move direct without private-to-shared widening (%j)', async row => {
    const owner = { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' } as const;
    const destination: WidgetSurfaceRefV1 = { ...account, owner: { ...owner, layoutId: 'other' } };
    const destinationId = buildWidgetSurfaceArtifactIdV1(destination);
    const state = await fixture(owner, artifactId => artifactId === destinationId ? row.destinationShared : row.sourceShared,
      true, async () => { throw new Error('Unexpected confirmation'); });
    await state.artifact.apply({ kind: 'add', instance: { v: 1, id: 'movable',
      definition: { kind: 'builtin', id: 'your_home' }, bindings: {} }, size: 'small' });
    await state.artifactFor(destination).apply({ kind: 'add', instance: { v: 1, id: 'existing',
      definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} }, size: 'small' });
    expect(await state.executor.execute('widgets.item.move', {
      ref: { surface: state.surface, instanceId: 'movable' }, to: { surface: destination, index: 0 },
    }, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
  });

  it.each([
    { authority: 'account_automation' as const },
    { authority: 'present_user' as const, actionCaller: { kind: 'plugin' as const, pluginId: 'acme.confirmation' } },
    { authority: 'present_user' as const, externalActionCredential: {
      accountId: 'account', principalId: 'token', credentialId: 'token', grant: API_TOKEN_FULL_GRANT_V1,
    } },
  ])('never lends host UI confirmation to a non-host invocation (%j)', async context => {
    let confirmations = 0;
    const executor = createActionExecutor({ presentUserActionConfirmation: async () => { confirmations += 1; return false; } });
    const result = await executor.execute('projects.trust.revoke', {
      project: { serverId: 'home', projectId: 'project' }, expectedRevision: 1, expectedEffectDigest: 'reviewed-effect',
    }, { surface: 'ui', ...context });
    expect(confirmations).toBe(0);
    expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  it('consumes the exact completed confirmation when Account policy changes to Ask-first while the host is open', async () => {
    let confirmations = 0;
    let settings = normalizeActionsSettingsV1({ v: 1 });
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, true, true,
      async () => {
        confirmations += 1;
        settings = normalizeActionsSettingsV1({ v: 1, actions: { 'widgets.item.remove': { approvalRequiredSurfaces: ['ui'] } } });
        return true;
      }, () => settings);
    expect(await state.executor.execute('widgets.item.remove', {
      ref: { surface: state.surface, instanceId: 'group' },
    }, { surface: 'ui', authority: 'present_user', actionsSettings: settings }))
      .toMatchObject({ ok: true, result: { instance: null } });
    expect(confirmations).toBe(1);
    expect((await state.artifact.read()).items.some(item => item.kind === 'group' && item.id === 'group')).toBe(false);
  });

  it('confirms a non-widget UI Action configured Ask-first at the same host boundary', async () => {
    const executor = createActionExecutor({ presentUserActionConfirmation: async () => false });
    expect(await executor.execute('projects.trust.revoke', {
      project: { serverId: 'home', projectId: 'project' }, expectedRevision: 1, expectedEffectDigest: 'reviewed-effect',
    }, { surface: 'ui', authority: 'present_user', actionsSettings: normalizeActionsSettingsV1({ v: 1,
      actions: { 'projects.trust.revoke': { approvalRequiredSurfaces: ['ui'] } },
    }) }))
      .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
  });

  it('confirms group content removal through the host and cancels without a write', async () => {
    let confirmations = 0;
    let approved = false;
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, true, true,
      async () => { confirmations += 1; return approved; });
    const before = (await state.artifact.read()).items;
    expect(await state.executor.execute('widgets.item.remove', {
      ref: { surface: state.surface, instanceId: 'group' },
    }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(confirmations).toBe(1);
    expect((await state.artifact.read()).items).toEqual(before);
    expect(await state.executor.prepare('widgets.item.remove', {
      ref: { surface: state.surface, instanceId: 'group' },
    }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_interactive_review_required' } });
    expect(confirmations).toBe(1);
    expect((await state.artifact.read()).items).toEqual(before);
    approved = true;
    expect(await state.executor.execute('widgets.item.remove', {
      ref: { surface: state.surface, instanceId: 'group' },
    }, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true, result: { ref: { surface: state.surface, instanceId: 'group' }, instance: null } });
    expect(confirmations).toBe(2);
    approved = false;
    const applied = (await state.artifact.read()).items;
    expect(applied.some(item => item.kind === 'group' && item.id === 'group')).toBe(false);
    expect(await state.executor.execute('widgets.item.rename', {
      ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Requires Inbox approval',
    }, { surface: 'ui', authority: 'present_user', actionsSettings: normalizeActionsSettingsV1({ v: 1,
      actions: { 'widgets.item.rename': { approvalRequiredSurfaces: ['ui'] } },
      approvalWaivedSurfaces: { 'widgets.item.rename': ['ui'] },
    }) })).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(confirmations).toBe(3);
    expect((await state.artifact.read()).items).toEqual(applied);
  });

  it.each(owners.flatMap(owner => edits.flatMap(edit => ['ui', 'mcp'].map(surface => ({ ...owner, ...edit, surface })))))('$name ($owner.kind, shared=$shared, $surface)', async row => {
    const state = await fixture(row.owner, row.shared);
    const input = await row.input(state);
    const before = [...(await state.artifact.read()).items];
    const result = await state.executor.execute(row.action, input, { surface: row.surface, authority: row.surface === 'ui' ? 'present_user' : 'account_automation' });
    if (row.surface === 'ui') {
      if (row.owner.kind === 'project' && row.name === 'widget size') {
        expect(result).toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
        expect((await state.artifact.read()).items).toEqual(before);
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (row.name === 'layout create') {
          expect(await state.layouts.list()).toContainEqual(expect.objectContaining({ name: 'New' }));
        } else if (row.name === 'layout rename') {
          expect((await state.artifact.read()).name).toBe('Renamed');
        } else if (row.name === 'layout reorder') {
          expect((await state.layouts.list()).map(layout => layout.name)).toEqual(['Other', 'Main']);
        } else {
          expect((await state.artifact.read()).items).not.toEqual(before);
        }
      }
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect((await state.artifact.read()).items).toEqual(before);
  });

  it.each(['ui', 'mcp'] as const)('honors a persisted %s approval waiver for a private widget edit', async surface => {
    // The executor must route persisted policy even without an optional host policy hook.
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false, false);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'widgets.item.rename': [surface] } });
    expect(await state.executor.execute('widgets.item.rename', { ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Renamed' }, {
      surface, authority: surface === 'ui' ? 'present_user' : 'account_automation', actionsSettings,
    })).toMatchObject({ ok: true });
    expect((await state.artifact.read()).items[0]).toMatchObject({ instance: { id: 'one', displayName: 'Renamed' } });
  });

  it('fails closed without a policy hook and preserves Ask-first over a supplied waiver', async () => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false, false);
    const input = { ref: { surface: state.surface, instanceId: 'one' }, displayName: 'Renamed' };
    const context = { surface: 'mcp' as const, authority: 'account_automation' as const };
    expect(await state.executor.execute('widgets.item.rename', input, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'widgets.item.rename': ['mcp'] },
      actions: { 'widgets.item.rename': { approvalRequiredSurfaces: ['mcp'] } },
    });
    expect(await state.executor.execute('widgets.item.rename', input, { ...context, actionsSettings }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect((await state.artifact.read()).items[0]).toMatchObject({ instance: { id: 'one' } });
    expect((await state.artifact.read()).items[0]).not.toHaveProperty('instance.displayName');
  });

  it.each(owners.flatMap(owner => edits.map(edit => ({ ...owner, ...edit }))))('retains explicit Ask-first for $name ($owner.kind, shared=$shared)', async row => {
    const state = await fixture(row.owner, row.shared);
    const input = await row.input(state);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: { [row.action]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(await state.executor.execute(row.action, input, { surface: 'ui', authority: 'present_user', actionsSettings }))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
  });

  it.each(owners.flatMap(owner => ['ui', 'mcp'].map(surface => ({ ...owner, surface }))))('retains destructive layout deletion for $name ($surface)', async row => {
    const state = await fixture(row.owner, row.shared);
    const created = await state.layouts.create({ surface: state.surface, layoutId: 'delete-me', name: 'Delete me' });
    expect(await state.executor.execute('widgets.area.layout.delete', { surface: created.surface, expectedRevision: created.revision },
      { surface: row.surface, authority: row.surface === 'ui' ? 'present_user' : 'account_automation' })).toMatchObject({ ok: false, errorCode: row.surface === 'ui' ? 'action_interactive_review_required' : 'approvals_not_supported' });
    expect(await state.layouts.list()).toContainEqual(expect.objectContaining({ artifactId: created.artifactId }));
  });

  it('retains private present-user danger for deleting a group', async () => {
    const action = 'widgets.item.remove';
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false);
    const before = (await state.artifact.read()).items;
    expect(await state.executor.execute(action, {
      ref: { surface: state.surface, instanceId: 'group' },
    }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect((await state.artifact.read()).items).toEqual(before);
  });

  it.each([
    { name: 'open to none', before: { network: 'open' }, after: { network: 'none' }, asks: false },
    { name: 'open to origins', before: { network: 'open' }, after: { networkOrigins: ['https://one.example.com'] }, asks: false },
    { name: 'origins subset', before: { networkOrigins: ['https://one.example.com', 'https://two.example.com'] }, after: { networkOrigins: ['https://one.example.com'] }, asks: false },
    { name: 'unchanged origins', before: { networkOrigins: ['https://one.example.com'] }, after: { networkOrigins: ['https://one.example.com'] }, asks: false },
    { name: 'unset to none', before: undefined, after: { network: 'none' }, asks: false },
    { name: 'inherited to origins', before: undefined, after: { networkOrigins: ['https://one.example.com'] }, asks: false },
    { name: 'none to open', before: { network: 'none' }, after: { network: 'open' }, asks: true },
    { name: 'origins replacement', before: { networkOrigins: ['https://one.example.com'] }, after: { networkOrigins: ['https://two.example.com'] }, asks: true },
    { name: 'explicit Ask on narrowing', before: { network: 'open' }, after: { network: 'none' }, asks: true, preference: 'ask' },
    { name: 'explicit Allow on widening', before: { network: 'none' }, after: { network: 'open' }, asks: false, preference: 'allow' },
  ] as const)('classifies widget network $name once and preserves the saved preference', async row => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false);
    if (row.before) await state.artifact.apply({ kind: 'network', instanceId: 'one', network: UiSurfaceNetworkRequestV1Schema.parse(row.before) });
    const before = (await state.artifact.read()).items;
    const preference = 'preference' in row ? row.preference : undefined;
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
      ...(preference === 'ask' ? { actions: { 'widgets.item.network.set': { approvalRequiredSurfaces: ['ui'] } } } : {}),
      ...(preference === 'allow' ? { approvalWaivedSurfaces: { 'widgets.item.network.set': ['ui'] } } : {}),
    });
    const result = await state.executor.execute('widgets.item.network.set', {
      ref: { surface: state.surface, instanceId: 'one' }, network: row.after,
    }, { surface: 'ui', authority: 'present_user', actionsSettings });
    expect(result).toMatchObject(row.asks ? { ok: false, errorCode: 'action_interactive_review_required' } : { ok: true });
    const items = (await state.artifact.read()).items;
    if (row.asks) expect(items).toEqual(before);
    else expect(items[0]).toMatchObject({ instance: { id: 'one', networkOverride: row.after } });
  });

  it.each(['agent', 'mcp', 'cli'] as const)('uses the same network classification on %s', async surface => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false);
    await state.artifact.apply({ kind: 'network', instanceId: 'one', network: { network: 'open' } });
    const ref = { surface: state.surface, instanceId: 'one' };
    const context = { surface, authority: 'account_automation' } as const;
    expect(await state.executor.execute('widgets.item.network.set', { ref, network: { network: 'none' } }, context)).toMatchObject({ ok: true });
    expect(await state.executor.execute('widgets.item.network.set', { ref, network: { network: 'open' } }, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect((await state.artifact.read()).items[0]).toMatchObject({ instance: { networkOverride: { network: 'none' } } });
  });

  it('classifies Home network changes from the same admitted layout read', async () => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false);
    const instance = { v: 1, id: 'home-network', definition: { kind: 'builtin', id: 'your_home' }, bindings: {}, networkOverride: { network: 'open' } } as const;
    await state.homeHubArtifacts.apply({ kind: 'widget_add', instance });
    const ref = { surface: { ...account, owner: { kind: 'home' } }, instanceId: instance.id } as const;
    const context = { surface: 'ui', authority: 'present_user' } as const;
    expect(await state.executor.execute('widgets.item.network.set', { ref, network: { network: 'none' } }, context)).toMatchObject({ ok: true });
    expect(await state.executor.execute('widgets.item.network.set', { ref, network: { network: 'open' } }, context))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect((await state.homeHubArtifacts.read()).items).toContainEqual(expect.objectContaining({ instance: { ...instance, networkOverride: { network: 'none' } } }));
  });

  it('compares inherited network access with the current saved definition before classifying a widening', async () => {
    const state = await fixture({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'main' }, false);
    await state.definitions.create(WidgetDefinitionV1Schema.parse({ v: 1, id: 'network-definition', name: 'Network',
      inputs: { fields: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      sizeDeclaration: { sizes: ['small'], defaultSize: 'small' },
      body: { kind: 'installed', surface: { pluginId: 'example.widgets', localId: 'frame' } },
      provenance: { source: { kind: 'authored' } } }));
    const instance = { v: 1, id: 'inherited', definition: { kind: 'artifact', artifactId: 'network-definition' }, bindings: {} } as const;
    await state.artifact.apply({ kind: 'add', instance, size: 'small' });
    // A library edit changes the inherited policy of an existing placement.
    await state.definitions.update('network-definition', { networkOverride: { network: 'none' } });
    const ref = { surface: state.surface, instanceId: instance.id };
    const context = { surface: 'ui', authority: 'present_user' } as const;
    const countDefinitionReads = () => state.artifactReads.filter(id => id === 'network-definition').length;
    const readsBeforeWidening = countDefinitionReads();
    expect(await state.executor.execute('widgets.item.network.set', { ref, network: { network: 'open' } }, context))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(countDefinitionReads() - readsBeforeWidening).toBe(1);
    await state.definitions.update('network-definition', { networkOverride: { network: 'open' } });
    const readsBeforeNarrowing = countDefinitionReads();
    expect(await state.executor.execute('widgets.item.network.set', { ref, network: { networkOrigins: ['https://one.example.com'] } }, context))
      .toMatchObject({ ok: true });
    expect(countDefinitionReads() - readsBeforeNarrowing).toBe(1);
  });

  it.each(owners.flatMap(owner => automationEdits.map(edit => ({ ...owner, ...edit }))))('retains automation approval for $action on $name', async row => {
    const state = await fixture(row.owner, row.shared);
    expect(await state.executor.execute(row.action, row.input(state), { surface: 'mcp', authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });
});
