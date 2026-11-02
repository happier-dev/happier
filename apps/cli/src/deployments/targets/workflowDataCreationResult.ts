import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { DeploymentDataCreationReferenceV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTargetRoleInputSchemasV1, DeploymentTargetPreparationBaseV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { DeploymentTargetProviderIdentityV1Schema, DeploymentTargetProviderEnvironmentV1Schema }
    from '@happier-dev/protocol/plugins/contributions/v2';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { z } from 'zod/mini';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { readDeploymentTargetV1 } from './deploymentTargetCatalog';

const isArray: (value: unknown) => value is readonly unknown[] = Array.isArray;

/** Host-private authority-bearing projection; provider operands remain governed
 * by the captured paired delete declaration, never by unknown wrapper fields. */
const contributionIdentity = z.custom<PluginContributionIdentityV1>(value => PluginContributionIdentityV1Schema.safeParse(value).success);
export const WorkflowDataCreationResultSchema = z.strictObject({
    kind: z.literal('deployment_data_created'), v: z.literal(1),
    source: contributionIdentity, deleteAction: contributionIdentity,
    providerIdentity: DeploymentTargetProviderIdentityV1Schema,
    providerEnvironment: DeploymentTargetProviderEnvironmentV1Schema,
    operands: z.record(z.string(), StrictJsonValueSchema),
});
export type WorkflowDataCreationResult = z.infer<typeof WorkflowDataCreationResultSchema>;

/** Snapshot only the declared data-create/delete pair before the one-shot effect.
 * Ordinary Action results retain their existing storage and capacity behavior. */
export function prepareWorkflowDataCreationResultCapture(actionId: string,
    contributes: ResolvedExecutablePluginRuntimeRegistry['contributes']): ((output: JsonValue) => JsonValue | undefined) | undefined {
    const action = parseQualifiedPluginActionId(actionId);
    if (!action) return;
    const declaration = readResolvedActionContribution(contributes, action);
    const roles = declaration?.admittedTarget?.deploymentTargetRoles?.filter(role => role.role === 'branches.create');
    if (!roles || roles.length !== 1) return;
    const source = { kind: 'plugin' as const, contribution: { pluginId: action.pluginId, localId: roles[0]!.targetLocalId } };
    const target = readDeploymentTargetV1(source, contributes.deploymentTargets);
    if (target?.role !== 'data') return;
    const deleteReference = target.dataV1?.branches?.delete;
    const deleteAction = deleteReference?.kind === 'plugin' ? parseQualifiedPluginActionId(deleteReference.actionId) : null;
    if (!deleteAction) return;
    const deleteDeclaration = readResolvedActionContribution(contributes, deleteAction);
    const properties = deleteDeclaration?.definition.inputSchema?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return;
    // Custody is already retained in execution.input. Retain only native result
    // operands the actual paired delete declaration can consume, never save refs.
    const common = new Set(Object.keys(DeploymentTargetPreparationBaseV1Schema.shape));
    const operands = Object.keys(properties).filter(key => !common.has(key));
    return output => {
        if (!output || typeof output !== 'object' || isArray(output)
            || output.status === 'outcome_unknown') return;
        const identity = DeploymentTargetProviderIdentityV1Schema.safeParse(output.providerIdentity);
        const environment = DeploymentTargetProviderEnvironmentV1Schema.safeParse(output.providerEnvironment);
        if (!identity.success || !environment.success) return;
        return WorkflowDataCreationResultSchema.parse({ kind: 'deployment_data_created', v: 1,
            source: source.contribution, deleteAction,
            providerIdentity: identity.data, providerEnvironment: environment.data,
            operands: Object.fromEntries(operands.filter(key => Object.hasOwn(output, key)).map(key => [key, output[key]])),
        });
    };
}

/** Consumes the incumbent authenticated Workflow getter; storage and envelope custody stay there. */
export function readWorkflowDataCreationResult(opened: unknown, reference: DeploymentDataCreationReferenceV1) {
    const record = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(opened).invocation;
    const execution = record.progress.execution;
    if (record.index.runId !== reference.runId || record.index.id !== reference.invocationId
        || record.progress.blockKind !== 'action' || execution?.kind !== 'action') throw new Error('target_mismatch');
    const envelope = execution.actionId === 'action.invoke' ? execution.input : undefined;
    const action = envelope ? PluginContributionIdentityV1Schema.parse(envelope.action)
        : parseQualifiedPluginActionId(execution.actionId);
    const raw = envelope ? envelope.input : execution.input;
    if (!action || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('target_mismatch');
    const shape = DeploymentTargetRoleInputSchemasV1['branches.create'].shape;
    const input = DeploymentTargetRoleInputSchemasV1['branches.create'].parse(Object.fromEntries(
        Object.keys(shape).filter(key => Object.hasOwn(raw, key)).map(key => [key, Reflect.get(raw, key)])));
    const result = WorkflowDataCreationResultSchema.parse(execution.output);
    if (action.pluginId !== result.source.pluginId || action.pluginId !== result.deleteAction.pluginId) throw new Error('target_mismatch');
    return { input, result, action };
}
