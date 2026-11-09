import { expect, it } from 'vitest';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { createHomeHubArtifactPortV1 } from '../home/homeHubArtifactV1.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { flattenWidgetLayoutWidgetsV1 } from './widgetLayoutItemV1.js';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1 } from './widgetSurfaceArtifactV1.js';
import { createWidgetActionInputResolverV1 } from './widgetActionInputResolverV1.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';
import { WidgetSurfaceReadV1Schema, WidgetInstanceActionOutputSchemasV1 } from './actionsV1.js';

it('lists Project widgets only for Project owners without exposing internal target metadata', async () => {
  const boundary = createWorkBoardArtifactBoundary();
  const scope = { serverId: 'home', accountId: 'owner' };
  const project = { ...scope, owner: { kind: 'project', projectId: 'project-a' } } as const;
  const home = { ...scope, owner: { kind: 'home' } } as const;
  const projectPort = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(boundary.forAccount('owner'), {
    surface, isCurrent: () => true,
  }));
  const entry = { definition: { kind: 'installed' as const, surface: { pluginId: 'acme.project-status', localId: 'status' } },
    title: 'Project status', target: 'project' as const, fields: [], availability: 'available' as const, instanceCount: 0,
    sizeDeclaration: { sizes: ['medium' as const, 'wide' as const], defaultSize: 'medium' as const } };
  const executor = createActionExecutor({ widgetAccountScope: () => scope,
    homeHubArtifacts: createHomeHubArtifactPortV1(boundary.forAccount('owner'), { accountId: 'owner' }),
    widgetSurfaceActions: { project: projectPort }, widgetCatalog: { list: async () => [entry] } });
  expect(await executor.execute('widgets.catalog.list', { surface: home }, { surface: 'mcp' }))
    .toMatchObject({ ok: true, result: { entries: [] } });
  const result = await executor.execute('widgets.catalog.list', { surface: project }, { surface: 'mcp' });
  expect(result).toMatchObject({ ok: true, result: { entries: [{ definition: entry.definition, title: entry.title,
    sizeDeclaration: entry.sizeDeclaration }] } });
  if (!result.ok) throw new Error(result.error);
  const catalog = WidgetInstanceActionOutputSchemasV1['widgets.catalog.list'].parse(result.result);
  expect(catalog.entries[0]).not.toHaveProperty('target');
});

it('persists selected planet Styles through the existing public-profile input Action and rejects private scope', async () => {
  const boundary = createWorkBoardArtifactBoundary();
  const scope = { serverId: 'home', accountId: 'owner' };
  const surface = { ...scope, owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } } as const;
  const owner = createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(boundary.forAccount('owner'), {
    surface: target, presets: [{ id: 'minimal', name: 'Minimal', items: [] }], isCurrent: () => true,
  }));
  const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { corePage: owner },
    widgetInputs: createWidgetActionInputResolverV1({
      readDescriptor: async request => readBuiltinWidgetDescriptorV1(request.instance.definition),
      readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
      // These declarations have no external target/options: the real resolver admits the closed public schema.
      validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [],
    }),
  });
  for (const [id, style] of [['usage_rhythm', 'streakThread'], ['usage_orbit', 'moons'], ['usage_run_length', 'galaxy']] as const) {
    expect(await executor.execute('widgets.item.add', { surface, instance: { v: 1, id,
      definition: { kind: 'builtin', id }, bindings: {} } }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true });
    const ref = { surface, instanceId: id };
    expect(await executor.execute('widgets.item.inputs.set', { ref, paths: ['style'],
      bindings: { style: { kind: 'value', value: style } } }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true });
    const stored = WidgetSurfaceReadV1Schema.parse(await owner.read(surface, {}));
    expect(flattenWidgetLayoutWidgetsV1(stored.items).find(item => item.instance.id === id)?.instance.bindings)
      .toEqual({ style: { kind: 'value', value: style } });
    expect(await executor.execute('widgets.item.inputs.set', { ref, paths: ['metric'],
      bindings: { metric: { kind: 'value', value: 'cost' } } }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false });
    expect(await owner.read(surface, {})).toEqual(stored);
  }
});

it('keeps surface-read failure and cancellation separate from a real Account scope change, then admits retry', async () => {
  const boundary = createWorkBoardArtifactBoundary();
  let scope = { serverId: 'home', accountId: 'owner' };
  const surface = { ...scope, owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'coach' } } as const;
  let fail = true;
  let changeScope = false;
  let cancel: AbortController | undefined;
  const transport = { ...boundary.forAccount('owner'), read: async () => {
    if (changeScope) scope = { ...scope, accountId: 'other' };
    if (cancel) { cancel.abort(); cancel.signal.throwIfAborted(); }
    if (fail) throw new Error('Artifact read failed');
    return null;
  } };
  const owner = createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1(transport, {
    surface: target, presets: [{ id: 'coach', name: 'Coach', items: [] }], isCurrent: () => true,
  }));
  const executor = createActionExecutor({ widgetAccountScope: () => scope, widgetSurfaceActions: { corePage: owner } });
  const read = (signal?: AbortSignal) => executor.execute('widgets.item.list', { surface }, { surface: 'ui', ...(signal ? { signal } : {}) });
  expect(await read()).toMatchObject({ ok: false, errorCode: 'widget_area_unavailable' });
  cancel = new AbortController();
  expect(await read(cancel.signal)).toMatchObject({ ok: false, errorCode: 'cancelled' });
  cancel = undefined;
  fail = false;
  expect(await read()).toMatchObject({ ok: true, result: { surface, preset: { id: 'coach' } } });
  changeScope = true;
  expect(await read()).toMatchObject({ ok: false, errorCode: 'widget_scope_unavailable' });
  changeScope = false;
  expect(await read()).toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
  scope = { serverId: 'home', accountId: 'owner' };
  expect(await read()).toMatchObject({ ok: true, result: { surface } });
});

it('changes and copies only the stored guest-network choice through the widget Action owner', async () => {
  const boundary = createWorkBoardArtifactBoundary();
  const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } } as const;
  const port = createHomeHubArtifactPortV1(boundary.forAccount('owner'), { accountId: 'owner' });
  const defaults = flattenWidgetLayoutWidgetsV1((await port.read()).items).map(item => item.instance);
  const instance = { v: 1, id: 'original', definition: { kind: 'builtin', id: 'summary' },
    bindings: { period: { kind: 'value', value: 'week' } } } as const;
  await port.apply({ kind: 'widget_add', instance });
  const executor = createActionExecutor({ homeHubArtifacts: port,
    widgetAccountScope: () => ({ serverId: 'home', accountId: 'owner' }) });
  const result = await executor.execute('widgets.item.network.set', {
    ref: { surface, instanceId: instance.id }, network: { networkOrigins: ['https://cdn.example.com'] },
  }, { surface: 'mcp', bypassApprovals: true });
  expect(result).toMatchObject({ ok: true, result: { instance: {
    ...instance, networkOverride: { networkOrigins: ['https://cdn.example.com'] },
  } } });
  const saved = flattenWidgetLayoutWidgetsV1((await port.read()).items).find(item => item.instance.id === instance.id)!.instance;
  await port.apply({ kind: 'widget_add', instance: { ...saved, id: 'copy' } });
  expect(await executor.execute('widgets.item.network.set', {
    ref: { surface, instanceId: instance.id }, network: { network: 'none' },
  }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: true });
  expect(flattenWidgetLayoutWidgetsV1((await port.read()).items).map(item => item.instance)).toEqual([
    ...defaults,
    { ...instance, networkOverride: { network: 'none' } },
    { ...saved, id: 'copy' },
  ]);
  const before = await port.read();
  expect(await executor.execute('widgets.item.network.set', {
    ref: { surface, instanceId: instance.id }, network: { network: 'open', actions: ['session.send'] },
  }, { surface: 'mcp', bypassApprovals: true })).toMatchObject({ ok: false });
  expect(await port.read()).toEqual(before);
});

it('admits group references through the deferred Action graph without widening their surface authority', async () => {
  const { WidgetInstanceActionInputSchemasV1 } = await import('./actionsV1.js');
  const schema = WidgetInstanceActionInputSchemasV1['widgets.group.ungroup'];
  const ref = { surface: { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } }, instanceId: 'group' };

  expect(schema.parse({ ref })).toEqual({ ref });
  expect(schema.safeParse({ ref: { ...ref, surface: { ...ref.surface, owner: { kind: 'sessionBoard', sessionId: 'session' } } } }).success).toBe(false);
  expect(schema.safeParse({ ref: { ...ref, extra: true } }).success).toBe(false);
});
