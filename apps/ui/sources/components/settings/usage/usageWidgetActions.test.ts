import { afterEach, expect, it } from 'vitest';
import { buildWidgetSurfaceArtifactIdV1, projectWidgetBindingInputV1, readBuiltinWidgetDescriptorV1, WidgetSurfaceReadV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { standardCleanup } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createUsageWidgetPresets, USAGE_WIDGET_PRESET_IDS } from './usageWidgetPresets';
import { setUsageWidgetMetric } from './usageWidgetActions';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from './usageWidgetPageContext';
import { captureActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { storage } from '@/sync/domains/state/storage';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

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
    const writes = await setUsageWidgetMetric({ metric: 'cost', instanceIds: ids, target: { surface, context: {} }, port: {
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

it.each(['approve', 'reject', 'retire'] as const)('settles each metric approval before continuing displayed widgets (%s)', async decision => {
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
    const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
        serverId: focused.id, expectedAccountId: 'account-a', widgetAreaContext: { surface, values },
        actionsSettings };
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor({ resolveWidgetAreaPresets: () => presets }));
    const inboxExecute = createFrontDoorActionExecute(createDefaultActionExecutor());
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
    // Every requested write changes its current value, so each one must cross approval admission.
    expect(ids.length).toBeGreaterThan(1);
    const decisions: Promise<void>[] = [];
    const controller = new AbortController();
    const onApprovalPending = (registration: ActionApprovalContinuation) => {
        if (decision === 'retire') { controller.abort(); return; }
        decisions.push((async () => {
            // The Inbox and opened Artifact publication are the genuine system boundaries;
            // approval admission, replay, input identity and continuation logic remain real.
            expect(artifacts.list().filter(row => row.id !== buildWidgetSurfaceArtifactIdV1(surface))).toHaveLength(decisions.length + 1);
            const settled = await inboxExecute('approval.request.decide', { artifactId: registration.artifactId, decision }, context);
            expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true });
            const account = await captureActionAccountContext(focused.id);
            try {
                const artifact = await account.fetchArtifact(registration.artifactId);
                if (!artifact) throw new Error('missing_settled_approval');
                if (artifact.header?.approvalStatus === 'executed') await registration.onExecuted(artifact);
                else registration.onTerminal?.(decision === 'reject' ? 'rejected' : 'failed', artifact);
            } finally { account.dispose(); }
        })().catch(error => { controller.abort(); throw error; }));
    };
    const request = { metric: 'cost' as const, instanceIds: ids, signal: controller.signal,
        onApprovalPending, target: { surface, context: {} }, port: {
            execute: async (operation: Parameters<Parameters<typeof setUsageWidgetMetric>[0]['port']['execute']>[0], signal?: AbortSignal) => PluginUiWidgetAreaResultV1Schema.parse(await execute(operation.actionId,
                buildWidgetAreaActionInputV1(operation, surface), { ...context, signal })),
        } };
    const writes = await setUsageWidgetMetric(request);
    await Promise.all(decisions);
    expect(artifacts.list().filter(row => row.id !== buildWidgetSurfaceArtifactIdV1(surface)))
        .toHaveLength(decision === 'approve' ? ids.length : 1);
    expect(writes, JSON.stringify(writes)).toHaveLength(decision === 'approve' ? ids.length : 1);
    expect(writes.every(write => decision === 'approve' ? write.result.ok : !write.result.ok)).toBe(true);
    const after = await execute('widgets.item.list', { surface }, context);
    if (!after.ok) throw new Error(after.errorCode);
    const changed = WidgetSurfaceReadV1Schema.parse(after.result).items![0]!;
    if (changed.kind !== 'group') throw new Error('expected_group');
    for (const child of changed.children.filter(child => ids.includes(child.instance.id))) {
        // An unsettled write keeps each widget's own preset metric (Rhythm reads busy time, the others tokens).
        const before = group.children.find(row => row.instance.id === child.instance.id)!.instance.bindings.metric;
        expect(child.instance.bindings.metric).toEqual(decision === 'approve' ? { kind: 'value', value: 'cost' } : before);
        expect(child.instance.bindings.period).toEqual({ kind: 'context', slot: 'period' });
    }
});
