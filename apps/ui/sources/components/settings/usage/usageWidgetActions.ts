import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';

/** Receipts are per instance: the existing layout owner does not promise a multi-write transaction. */
export type UsageWidgetMetricWrite = Readonly<{ instanceId: string; result: PluginUiWidgetAreaResultV1 }>;
export async function setUsageWidgetMetric(input: Readonly<{
    port: WidgetAreaPort; instanceIds: readonly string[]; metric: UsageQuery['metric']; signal?: AbortSignal;
}>): Promise<readonly UsageWidgetMetricWrite[]> {
    const writes: UsageWidgetMetricWrite[] = [];
    // The shared Artifact revision owner serializes each acknowledged input edit.
    for (const instanceId of new Set(input.instanceIds)) {
        if (input.signal?.aborted) break;
        const result = await input.port.execute({ actionId: 'widgets.item.inputs.set', instanceId,
            bindings: { metric: { kind: 'value', value: input.metric } }, paths: ['metric'] }, input.signal);
        writes.push({ instanceId, result });
        if (!result.ok || ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) break;
    }
    return writes;
}
