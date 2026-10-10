import type { UsageQueryBatchInput, UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { WidgetBindingResolutionV1 } from '@happier-dev/protocol/widgets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * One mounted page's batch: each body's platform-resolved query (widget value → group → page slot,
 * applied by the shared widget binder) keyed canonically, and the deduplicated `usage.query` input.
 * Built by `widgets/usageWidgetBatch.tsx`; no second input resolution runs at page level.
 */
export type UsageWidgetQueryPlan = Readonly<{
    /** The existing admitted viewer scope captured for resolution, never an access grant. */
    scope: ServerAccountScope;
    input: UsageQueryBatchInput | null;
    widgets: ReadonlyMap<string, Readonly<{ resolution: WidgetBindingResolutionV1; query?: UsageQuery; key?: string }>>;
}>;
