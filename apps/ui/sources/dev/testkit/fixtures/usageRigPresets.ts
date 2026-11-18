import { createUsageWidgetPresets, flattenWidgetLayoutWidgetsV1, readBuiltinWidgetDescriptorV1,
    resolveConfiguredWidgetInputs, setWidgetInputBindingsV1, WidgetLayoutItemsV1Schema } from '@happier-dev/protocol/widgets';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { usageWidgetAcceptsMetric } from '@/components/settings/usage/usageWidgetActions';
import { buildUsageWidgetQueryPlan, isUsageQueryWidget, resolveUsageWidgetInventoryQuery,
    resolveUsageWidgetQuery } from '@/components/settings/usage/widgets/usageWidgetBatch';
import { buildUsageWidgetPageInventoryQuery, readUsageWidgetPageContext, readUsageWidgetPageScope,
    readUsageWidgetQueryOverrides, resolveUsageWidgetPageInitialQuery } from '@/components/settings/usage/usageWidgetPageContext';
import type { UsagePeriod } from '@/sync/api/account/usagePeriods';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { USAGE_RIG_NOW } from './usageRigAccounting';

/** The real preset, binder, widget demand and inventory owners drive this synthetic page. */
export function buildUsageRigPresetPlans(scope: ServerAccountScope, period: UsagePeriod, costBasis: UsageQuery['costBasis'] = 'auto',
    metric?: 'tokens' | 'cost') {
    const page = resolveUsageWidgetPageInitialQuery({ initialFilters: { period, metric: 'tokens', focus: null, costMode: costBasis },
        nowMs: USAGE_RIG_NOW, timeZoneOffsetMinutes: 0 });
    const context = readUsageWidgetPageContext(readUsageWidgetPageScope(page));
    const clauses = readUsageWidgetQueryOverrides(page);
    const inventory = resolveUsageWidgetInventoryQuery(buildUsageWidgetPageInventoryQuery(clauses, context));
    return createUsageWidgetPresets().map(preset => {
        const registrations = new Map<string, NonNullable<ReturnType<typeof resolveUsageWidgetQuery>>>();
        const widgets = flattenWidgetLayoutWidgetsV1(WidgetLayoutItemsV1Schema.parse(preset.items));
        for (const { instance } of widgets) {
            const { definition } = instance;
            if (definition.kind !== 'builtin' || !isUsageQueryWidget(definition.id)) continue;
            const descriptor = readBuiltinWidgetDescriptorV1(definition)!;
            // Start with the stored artifact after the toolbar's metric edit.
            const configured = metric && usageWidgetAcceptsMetric(definition) ? { ...instance,
                bindings: setWidgetInputBindingsV1(instance.bindings, { metric: { kind: 'value', value: metric } }, ['metric']) } : instance;
            const binding = resolveConfiguredWidgetInputs({ instance: configured, descriptor, providedContext: context, viewerValues: {} });
            if (binding.status !== 'ready') throw new Error(`Usage preset ${preset.id}/${definition.id} input ${binding.status}`);
            const registration = resolveUsageWidgetQuery(clauses, binding.input, definition.id, false);
            if (!registration) throw new Error(`Usage preset ${preset.id}/${definition.id} has no accounting demand`);
            registrations.set(instance.id, registration);
        }
        const plan = buildUsageWidgetQueryPlan(scope, registrations, inventory);
        return { id: preset.id, name: preset.name, plan, inventory };
    });
}
