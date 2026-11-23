import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { projectWidgetBindingInputV1, proposeWidgetInputDefaultBindingsV1, readBuiltinWidgetDescriptorV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import type { WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';

/** The page toolbar edits the metric on each eligible placement. */
export function usageWidgetAcceptsMetric(instance: WidgetInstanceV1): boolean {
    const { definition } = instance;
    if (definition.kind !== 'builtin' || !definition.id.startsWith('usage_')) return false;
    const descriptor = readBuiltinWidgetDescriptorV1(definition);
    if (!descriptor) return false;
    // Applicability belongs to the declaration: a latent metric on an activity-only Style
    // neither determines the page selection nor becomes a toolbar write target.
    const input = projectWidgetBindingInputV1({
        instance: { ...instance, bindings: proposeWidgetInputDefaultBindingsV1(descriptor, instance.bindings) },
        fields: descriptor.inputs?.fields ?? [], context: {}, viewerValues: {},
    });
    return resolveEffectiveInputFields({ inputHints: descriptor.inputs }, input).some(field => field.path === 'metric');
}

/** Receipts are per instance: the existing layout owner does not promise a multi-write transaction. */
export type UsageWidgetMetricWrite = Readonly<{ instanceId: string; result: PluginUiWidgetAreaResultV1 }>;
export async function setUsageWidgetMetric(input: Readonly<{
    port: WidgetAreaPort; instanceIds: readonly string[]; metric: UsageQuery['metric']; signal?: AbortSignal;
    target: NonNullable<Parameters<WidgetAreaPort['execute']>[2]>;
    onApprovalPending?: (registration: ActionApprovalContinuation) => void;
}>): Promise<readonly UsageWidgetMetricWrite[]> {
    const writes: UsageWidgetMetricWrite[] = [];
    // The shared Artifact revision owner serializes each acknowledged input edit.
    for (const instanceId of new Set(input.instanceIds)) {
        if (input.signal?.aborted) break;
        const operation = { actionId: 'widgets.item.inputs.set' as const, instanceId,
            bindings: { metric: { kind: 'value' as const, value: input.metric } }, paths: ['metric'] };
        const immediate = await input.port.execute(operation, input.signal, input.target);
        const result = input.onApprovalPending ? PluginUiWidgetAreaResultV1Schema.parse(await resumeActionExecutionResult({
            result: immediate, actionId: operation.actionId, actionInput: buildWidgetAreaActionInputV1(operation, input.target.surface),
            scope: input.target.surface, signal: input.signal, onApprovalPending: input.onApprovalPending,
        })) : immediate;
        writes.push({ instanceId, result });
        if (!result.ok || ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) break;
    }
    return writes;
}
