import { afterEach, expect, it } from 'vitest';
import { WidgetSurfaceReadV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
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
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from './usageWidgetPageContext';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(() => { standardCleanup(); retireActiveServerAccountScopeLifetime(); home?.dispose(); home = undefined; });

it('edits only displayed widget metric inputs through real Actions and Artifact CAS, retaining independent scopes', async () => {
    const names = Object.fromEntries(USAGE_WIDGET_PRESET_IDS.map(id => [id, id])) as Record<typeof USAGE_WIDGET_PRESET_IDS[number], string>;
    const presets = createUsageWidgetPresets(names);
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widget-actions.test', accountId: 'account-a' }],
        route: async request => request.path.startsWith('/v1/artifacts') ? (await artifacts.handle(request.path, {
            method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        })) ?? undefined : undefined });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const surface: WidgetSurfaceRefV1 = { serverId: focused.id, accountId: 'account-a', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    // Inject the real executor: no Metro call-time require bridge or substituted Action logic.
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor({ resolveWidgetAreaPresets: () => presets }));
    const values = readUsageWidgetPageContext(readUsageWidgetPageScope(normalizeUsageQuery({ period: { startMs: 1000 } })));
    const context = { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id,
        expectedAccountId: 'account-a', widgetAreaContext: { surface, values } };
    const before = await execute('widgets.item.list', { surface }, context);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error(before.errorCode);
    const read = WidgetSurfaceReadV1Schema.parse(before.result);
    const group = read.items![0]!;
    if (group.kind !== 'group') throw new Error('expected_group');
    // The displayed subset: the Overview group's first band (daily, period summary, capacity).
    const ids = group.children.slice(0, 3).map(child => child.instance.id);
    const admitted = await execute('widgets.item.inputs.validate', { ref: { surface, instanceId: ids[0]! },
        bindings: { ...group.children[0]!.instance.bindings, metric: { kind: 'value', value: 'cost' } } }, context);
    expect(admitted).toMatchObject({ ok: true, result: { status: 'ready' } });
    const writes = await setUsageWidgetMetric({ metric: 'cost', instanceIds: ids, port: {
        execute: async (operation, signal) => PluginUiWidgetAreaResultV1Schema.parse(await execute(operation.actionId,
            buildWidgetAreaActionInputV1(operation, surface), { ...context, signal })),
    } });
    expect(writes).toEqual(ids.map(instanceId => ({ instanceId, result: expect.objectContaining({ ok: true }) })));
    const after = await execute('widgets.item.list', { surface }, context);
    if (!after.ok) throw new Error(after.errorCode);
    const changed = WidgetSurfaceReadV1Schema.parse(after.result).items![0]!;
    if (changed.kind !== 'group') throw new Error('expected_group');
    for (const row of changed.children.slice(0, 3)) expect(row.instance.bindings).toMatchObject({
        metric: { kind: 'value', value: 'cost' }, breakdown: { kind: 'value', value: [] },
        period: { kind: 'context', slot: 'period' }, costBasis: { kind: 'context', slot: 'costBasis' },
    });
    // Widgets not displayed in the edit keep their own metric.
    expect(changed.children[3]!.instance.bindings.metric).toEqual({ kind: 'value', value: 'tokens' });
});
