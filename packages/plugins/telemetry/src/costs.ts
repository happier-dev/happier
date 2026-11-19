import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { type DatabaseCaptureCostsReadResultV1 } from '@happier-dev/database-protocol';
import { UsageModelPriceOverridesV1Schema, UsageModelPriceReadResultSchema } from '@happier-dev/plugin-sdk/usage';
import { type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { CaptureRuntime } from './runtime.js';
import type { CostOperandsInput } from './store/costs.js';

export type CaptureCostWindow = Pick<Extract<DatabaseCaptureCostsReadResultV1, { ok: true }>, 'since' | 'until' | 'items' | 'coverage'>;
export type CaptureCostPricingContext = Readonly<{ catalog: UsageModelPriceCatalog; viewerOverrides: UsageModelPriceOverridesV1 }>;

/** One selected SQL aggregate is shared by the raw Action, Resource and demanded spend measures. */
export async function readCaptureCostWindow(runtime: CaptureRuntime, input: CostOperandsInput): Promise<CaptureCostWindow> {
    const items = await runtime.store.costOperands(input);
    const coverage = items.reduce((sum, item) => ({ callCount: sum.callCount + item.callCount,
        tokenCategoryCallCount: sum.tokenCategoryCallCount + (item.tokenCategories === null ? 0 : item.callCount),
        reportedCostCallCount: sum.reportedCostCallCount + (item.reportedCost === null ? 0 : item.callCount),
    }), { callCount: 0, tokenCategoryCallCount: 0, reportedCostCallCount: 0 });
    return { since: input.since, until: input.until, items,
        coverage: { ...runtime.ingest.coverage(input.worktree), ...coverage } };
}

/** The caller loads this once for all windows in one Action; nothing is retained between viewers or invocations. */
export async function loadCaptureCostPricingContext(context: PluginInvocationContext,
    modelIds: readonly string[]): Promise<CaptureCostPricingContext> {
    const settings = await context.services.actions.execute('settings.get', { anchor: 'usage.modelPrices' }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(settings)) throw new PluginError({ code: 'approval_required' });
    const viewerOverrides = UsageModelPriceOverridesV1Schema.parse('unset' in settings ? {} : settings.value);
    // Mapping targets are price identifiers, not copied tariffs or locally resolved aliases.
    const selectedIds = [...new Set([...modelIds, ...Object.values(viewerOverrides).flatMap(value => value.kind === 'map' ? [value.modelId] : [])])];
    const prices = await context.services.actions.execute('usage.prices.get', { modelIds: selectedIds }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(prices)) throw new PluginError({ code: 'approval_required' });
    const delivered = UsageModelPriceReadResultSchema.parse(prices);
    const catalog: UsageModelPriceCatalog = 'models' in delivered ? delivered
        : { v: delivered.v, models: {}, provenance: delivered.provenance };
    return { catalog, viewerOverrides };
}
