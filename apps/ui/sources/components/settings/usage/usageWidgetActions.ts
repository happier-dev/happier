import { UsageAccountingMetricSchema, type UsageAccountingMetric } from '@happier-dev/protocol/inputs/usageQuery';
import type { PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { projectWidgetBindingInputV1, proposeWidgetInputDefaultBindingsV1, readBuiltinWidgetDescriptorV1, type WidgetInputDescriptorV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import type { WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';

/** The page toolbar edits the metric on each eligible placement. */
export function readUsageWidgetMetricPaths(instance: WidgetInstanceV1,
    descriptor: WidgetInputDescriptorV1 | null = readBuiltinWidgetDescriptorV1(instance.definition)): readonly string[] {
    if (!descriptor) return [];
    // Applicability belongs to the declaration: a latent metric on an activity-only Style
    // neither determines the page selection nor becomes a toolbar write target.
    const input = projectWidgetBindingInputV1({
        instance: { ...instance, bindings: proposeWidgetInputDefaultBindingsV1(descriptor, instance.bindings) },
        fields: descriptor.inputs?.fields ?? [], context: {}, viewerValues: {},
    });
    return resolveEffectiveInputFields({ inputHints: descriptor.inputs }, input)
        .filter(field => (field.path === 'metric' || field.path.endsWith('.metric')) && field.widget === 'select'
            && UsageAccountingMetricSchema.options.every(metric => field.options?.some(option => option.value === metric)))
        .map(field => field.path);
}

export function usageWidgetAcceptsMetric(instance: WidgetInstanceV1, descriptor?: WidgetInputDescriptorV1 | null): boolean {
    return readUsageWidgetMetricPaths(instance, descriptor).length > 0;
}

export function usageWidgetMetricBindings(paths: readonly string[], metric: UsageAccountingMetric): WidgetInstanceV1['bindings'] {
    return Object.fromEntries(paths.map(path => [path, { kind: 'value', value: metric }]));
}

/** Receipts are per instance: the existing layout owner does not promise a multi-write transaction. */
export type UsageWidgetMetricWrite = Readonly<{ instanceId: string; result: PluginUiWidgetAreaResultV1 }>;
export async function setUsageWidgetMetric(input: Readonly<{
    port: WidgetAreaPort; targets: readonly Readonly<{ instanceId: string; paths: readonly string[] }>[];
    metric: UsageAccountingMetric; signal?: AbortSignal;
    target: NonNullable<Parameters<WidgetAreaPort['execute']>[2]>;
    onApprovalPending?: (registration: ActionApprovalContinuation) => void;
}>): Promise<readonly UsageWidgetMetricWrite[]> {
    const writes: UsageWidgetMetricWrite[] = [];
    // The shared Artifact revision owner serializes each acknowledged input edit.
    for (const { instanceId, paths } of input.targets) {
        if (input.signal?.aborted) break;
        const bindings = usageWidgetMetricBindings(paths, input.metric);
        const operation = { actionId: 'widgets.item.inputs.set' as const, instanceId, bindings, paths: [...paths] };
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
