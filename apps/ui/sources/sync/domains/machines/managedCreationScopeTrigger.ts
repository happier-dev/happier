import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import type { TriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import { resolveMachineRetentionNativeIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

/** Creation and FIN's later draft share one executable managed Stop/Delete definition. */
export function buildManagedCreationScopeTriggerTarget(input: Readonly<{
    homeId: string;
    managedId: string;
    effect: 'stop' | 'delete';
    supportedIntents: Parameters<typeof resolveMachineRetentionNativeIntentV1>[1];
    afterMs?: number;
}>): TriggerTargetV1 {
    return { kind: 'inline', definition: WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [], blocks: [{
        kind: 'action', id: 'managed-scope-end', actionId: input.effect === 'stop' ? 'machines.managed.power.set' : 'machines.managed.delete',
        input: { homeId: { kind: 'literal', value: input.homeId }, managedId: { kind: 'literal', value: input.managedId },
            when: { kind: 'literal', value: 'after-idle' }, intent: { kind: 'literal', value: input.effect === 'stop'
                ? resolveMachineRetentionNativeIntentV1('stop', input.supportedIntents) ?? 'stop' : input.effect },
            ...(input.afterMs === undefined ? {} : { afterMs: { kind: 'literal', value: input.afterMs } }),
            ...(input.effect === 'delete' ? { reviewedDependencies: { kind: 'literal', value: true } } : {}) },
    }] }) };
}
