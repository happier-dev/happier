import { afterEach, expect, it } from 'vitest';
import { buildWidgetSurfaceArtifactIdV1, projectWidgetBindingInputV1, readBuiltinWidgetDescriptorV1, WidgetSurfaceReadV1Schema, WidgetInstanceV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { standardCleanup } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createUsageWidgetPresets, USAGE_WIDGET_PRESET_IDS } from './usageWidgetPresets';
import { readUsageWidgetMetricPaths, setUsageWidgetMetric, usageWidgetAcceptsMetric } from './usageWidgetActions';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from './usageWidgetPageContext';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { storage } from '@/sync/domains/state/storage';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it('includes only currently applicable metric inputs in toolbar edits and mixed-metric decisions', () => {
    const rhythm = WidgetInstanceV1Schema.parse({ v: 1, id: 'metric-rhythm',
        definition: { kind: 'builtin', id: 'usage_rhythm' },
        bindings: { metric: { kind: 'value', value: 'tokens' } } });
    // The retained activity composition has no Tokens/Cost encoding, even with a saved metric.
    expect(usageWidgetAcceptsMetric(rhythm)).toBe(false);
    expect(usageWidgetAcceptsMetric({ ...rhythm, bindings: { ...rhythm.bindings,
        style: { kind: 'value', value: 'heatmap' } } })).toBe(false);
    expect(usageWidgetAcceptsMetric({ ...rhythm, bindings: { ...rhythm.bindings,
        style: { kind: 'value', value: 'sky' } } })).toBe(true);
    expect(usageWidgetAcceptsMetric({ ...rhythm,
        definition: { kind: 'builtin', id: 'usage_daily' }, bindings: {} })).toBe(true);
});

it('sets the declared nested metric input on an installed plugin widget', async () => {
    const instance = WidgetInstanceV1Schema.parse({ v: 1, id: 'plugin-metric',
        definition: { kind: 'installed', surface: { pluginId: 'example.usage', localId: 'spend' } },
        bindings: { 'query.metric': { kind: 'value', value: 'tokens' } } });
    const descriptor = { inputs: { fields: [{ path: 'query.metric', title: 'Metric', widget: 'select' as const,
        options: [{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }] }] } };
    expect(usageWidgetAcceptsMetric(instance, descriptor)).toBe(true);
    const paths = readUsageWidgetMetricPaths(instance, descriptor);
    expect(paths).toEqual(['query.metric']);
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'account', owner: { kind: 'corePage', pageId: 'usage', area: 'main' } };
    await expect(setUsageWidgetMetric({ metric: 'cost', targets: [{ instanceId: instance.id, paths }],
        target: { surface, context: {} }, port: {
            execute: async operation => {
                expect(operation).toEqual({ actionId: 'widgets.item.inputs.set', instanceId: instance.id,
                    paths: ['query.metric'], bindings: { 'query.metric': { kind: 'value', value: 'cost' } } });
                return { ok: true, result: {} };
            },
        },
    })).resolves.toHaveLength(1);
});

it('edits only displayed widget metric inputs through real Actions and Artifact CAS, retaining independent scopes', async () => {
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widget-actions.test', accountId: 'account-a',
        settings: { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'widgets.area.layout.create': ['ui'], 'widgets.item.inputs.set': ['ui'],
        } }) } }],
        route: async request => request.path.startsWith('/v1/artifacts') ? (await artifacts.handle(`${request.path}${request.url.search}`, {
            method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        })) ?? undefined : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const surface: WidgetSurfaceRefV1 = { serverId: focused.id, accountId: 'account-a', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    // Inject the real executor: no Metro call-time require bridge or substituted Action logic.
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
    const values = readUsageWidgetPageContext(readUsageWidgetPageScope(normalizeUsageQuery({ period: { startMs: 1000 } })));
    const context = { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id,
        expectedAccountId: 'account-a', widgetAreaContext: { surface, values },
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'widgets.area.layout.create': ['ui'], 'widgets.item.inputs.set': ['ui'],
        } }) };
    expect(await execute('widgets.area.layout.list', { surface }, context)).toMatchObject({ ok: true, result: { layouts:
        USAGE_WIDGET_PRESET_IDS.map(layoutId => ({ surface: { owner: { layoutId } }, isPreset: true })) } });
    const before = await execute('widgets.item.list', { surface }, context);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error(before.errorCode);
    const read = WidgetSurfaceReadV1Schema.parse(before.result);
    const group = read.items![0]!;
    if (group.kind !== 'group') throw new Error('expected_group');
    // Only the displayed band's metric consumers (Daily and Period summary) are editable.
    const ids = group.children.slice(0, 3).filter(child => readBuiltinWidgetDescriptorV1(child.instance.definition)!
        .inputs?.fields.some(field => field.path === 'metric')).map(child => child.instance.id);
    const admitted = await execute('widgets.item.inputs.validate', { ref: { surface, instanceId: ids[0]! },
        bindings: { ...group.children[0]!.instance.bindings, metric: { kind: 'value', value: 'cost' } } }, context);
    expect(admitted).toMatchObject({ ok: true, result: { status: 'ready' } });
    const selected: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'selected' } };
    expect(await execute('widgets.area.layout.create', { surface, layoutId: 'selected', name: 'Selected', fromSurface: surface }, context))
        .toMatchObject({ ok: true });
    const metricRequestStart = home.httpRequests.length;
    const writes = await setUsageWidgetMetric({ metric: 'cost', targets: ids.map(instanceId => ({ instanceId, paths: ['metric'] })), target: { surface, context: {} }, port: {
        execute: async (operation, signal, target) => {
            const destination = target?.surface ?? selected;
            return PluginUiWidgetAreaResultV1Schema.parse(await execute(operation.actionId,
                buildWidgetAreaActionInputV1(operation, destination), { ...context, signal, widgetAreaContext: { surface: destination, values } }));
        },
    } });
    expect(writes, JSON.stringify(writes)).toEqual(ids.map(instanceId => ({ instanceId, result: expect.objectContaining({ ok: true }) })));
    const metricRequests = home.httpRequests.slice(metricRequestStart).filter(request => request.path.startsWith('/v1/artifacts'));
    // Each persistent widget edit admits its placement once, then acquires the
    // writer's current revision/access for CAS. Input resolution reuses admission.
    expect(metricRequests.filter(request => request.method === 'GET' && request.path.endsWith('/access/grants')),
        JSON.stringify(metricRequests.map(request => `${request.method} ${request.path}`)))
        .toHaveLength(ids.length * 2);
    const after = await execute('widgets.item.list', { surface }, context);
    if (!after.ok) throw new Error(after.errorCode);
    const changed = WidgetSurfaceReadV1Schema.parse(after.result).items![0]!;
    if (changed.kind !== 'group') throw new Error('expected_group');
    for (const row of changed.children.filter(child => ids.includes(child.instance.id))) expect(row.instance.bindings).toMatchObject({
        metric: { kind: 'value', value: 'cost' },
        period: { kind: 'context', slot: 'period' }, costBasis: { kind: 'context', slot: 'costBasis' },
    });
    // Widgets not displayed in the edit keep their own metric.
    for (const row of changed.children.filter(child => !ids.includes(child.instance.id))) expect(row.instance.bindings)
        .toEqual(group.children.find(child => child.instance.id === row.instance.id)!.instance.bindings);
    const selectedRead = await execute('widgets.item.list', { surface: selected }, { ...context, widgetAreaContext: { surface: selected, values } });
    if (!selectedRead.ok) throw new Error(selectedRead.errorCode);
    const selectedGroup = WidgetSurfaceReadV1Schema.parse(selectedRead.result).items![0]!;
    if (selectedGroup.kind !== 'group') throw new Error('expected_group');
    for (const row of selectedGroup.children.filter(child => ids.includes(child.instance.id))) expect(row.instance.bindings.metric).toEqual({ kind: 'value', value: 'tokens' });
});

it.each(['approve', 'reject', 'retire'] as const)('settles each native metric review before continuing displayed widgets (%s)', async decision => {
    const names = Object.fromEntries(USAGE_WIDGET_PRESET_IDS.map(id => [id, id])) as Record<typeof USAGE_WIDGET_PRESET_IDS[number], string>;
    const presets = createUsageWidgetPresets(names);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: {
        'widgets.item.inputs.set': { approvalRequiredSurfaces: ['ui'] },
    } });
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-metric-approval.test', accountId: 'account-a',
        settings: { actionsSettingsV1: actionsSettings } }],
        route: async request => request.path.startsWith('/v1/artifacts') ? (await artifacts.handle(`${request.path}${request.url.search}`, {
            method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        })) ?? undefined : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    expect(storage.getState().settings.actionsSettingsV1).toMatchObject(actionsSettings);
    const surface: WidgetSurfaceRefV1 = { serverId: focused.id, accountId: 'account-a', owner: {
        kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview',
    } };
    const values = readUsageWidgetPageContext(readUsageWidgetPageScope(normalizeUsageQuery({ period: { startMs: 1000 } })));
    // Own UI presses use native review, not durable approval Artifacts (02102e614e1).
    const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
        serverId: focused.id, expectedAccountId: 'account-a', widgetAreaContext: { surface, values },
        actionsSettings };
    const controller = new AbortController();
    let reviews = 0;
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor({
        resolveWidgetAreaPresets: () => presets,
        // The native presenter is the boundary; admission, input review and writes stay real.
        presentUserActionConfirmation: async ({ actionId }) => {
            expect(actionId).toBe('widgets.item.inputs.set');
            reviews++;
            if (decision === 'retire') controller.abort();
            return decision === 'approve';
        },
    }));
    const before = await execute('widgets.item.list', { surface }, context);
    if (!before.ok) throw new Error(before.errorCode);
    const original = WidgetSurfaceReadV1Schema.parse(before.result);
    const group = original.items![0]!;
    if (group.kind !== 'group') throw new Error('expected_group');
    const ids = group.children.filter(child => {
        const fields = readBuiltinWidgetDescriptorV1(child.instance.definition)!.inputs?.fields ?? [];
        return fields.some(field => field.path === 'metric') && projectWidgetBindingInputV1({
            instance: child.instance, fields, context: values, viewerValues: {},
        }).metric !== 'cost';
    }).map(child => child.instance.id);
    // Every requested write changes its current value, so all three cross native review.
    expect(ids).toHaveLength(3);
    const writes = await setUsageWidgetMetric({ metric: 'cost', targets: ids.map(instanceId => ({ instanceId, paths: ['metric'] })), signal: controller.signal,
        onApprovalPending: () => { throw new Error('native_review_created_durable_approval'); },
        target: { surface, context: {} }, port: {
            execute: async (operation, signal) => PluginUiWidgetAreaResultV1Schema.parse(await execute(operation.actionId,
                buildWidgetAreaActionInputV1(operation, surface), { ...context, signal })),
        } });
    expect(reviews).toBe(decision === 'approve' ? ids.length : 1);
    expect(artifacts.list().filter(row => row.id !== buildWidgetSurfaceArtifactIdV1(surface))).toHaveLength(0);
    expect(writes, JSON.stringify(writes)).toHaveLength(decision === 'approve' ? ids.length : 1);
    expect(writes.every(write => decision === 'approve' ? write.result.ok : !write.result.ok)).toBe(true);
    if (decision !== 'approve') expect(writes[0]?.result).toMatchObject({
        ok: false, errorCode: decision === 'retire' ? 'cancelled' : 'approval_canceled',
    });
    const after = await execute('widgets.item.list', { surface }, context);
    if (!after.ok) throw new Error(after.errorCode);
    const changed = WidgetSurfaceReadV1Schema.parse(after.result).items![0]!;
    if (changed.kind !== 'group') throw new Error('expected_group');
    for (const child of changed.children.filter(child => ids.includes(child.instance.id))) {
        // A rejected or retired review keeps each widget's own preset metric (Rhythm reads busy time, the others tokens).
        const before = group.children.find(row => row.instance.id === child.instance.id)!.instance.bindings.metric;
        expect(child.instance.bindings.metric).toEqual(decision === 'approve' ? { kind: 'value', value: 'cost' } : before);
        expect(child.instance.bindings.period).toEqual({ kind: 'context', slot: 'period' });
    }
});
