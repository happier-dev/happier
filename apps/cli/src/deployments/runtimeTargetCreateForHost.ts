import type { DeploymentTargetV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DeploymentTargetLinkProviderIntentInputV1Schema,
    DeploymentTargetLinkProvisionedResultV1Schema, type DeploymentTargetLinkCreateIntentInputV1, type DeploymentTargetLinkProviderIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTargetCreateInputV1Schema, DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** A failed durable checkpoint must still expose the acknowledged resource to the initiating client. */
export class RuntimeTargetCreationCheckpointError extends Error {
    constructor(readonly recovery: DeploymentTargetLinkProviderIntentInputV1, cause: unknown) {
        super('target_link.create_checkpoint_failed', { cause });
    }
}

/** The target declaration owns create capability and its qualified Action identity. */
export function prepareRuntimeTargetCreateForHost(input: DeploymentTargetLinkCreateIntentInputV1, target: DeploymentTargetV1 | null) {
    if (target?.role !== 'runtime' || target.actions.create?.kind !== 'plugin') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    const action = parseQualifiedPluginActionId(target.actions.create.actionId);
    if (!action) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    const operand = DeploymentTargetCreateInputV1Schema.parse({ ...input.providerCreate, v: 1,
        serverId: input.serverId, environmentId: input.environmentId, expectedRevision: input.expectedRevision, requestKey: input.requestKey });
    return { children: [{ action, role: 'create', input: normalizeStrictJsonValue(operand) }] };
}

/** Native acknowledgment is checkpointed by the existing encrypted operation owner before any follow-up. */
export async function createRuntimeTargetForHost(input: DeploymentTargetLinkCreateIntentInputV1,
    target: DeploymentTargetV1 | null, context: ActionExecutorContext) {
    if (!context.operationOwnerUpdate || !context.hostReviewedChild) return {
        ok: false as const, errorCode: 'source_unavailable', error: 'source_unavailable',
    };
    const [child] = prepareRuntimeTargetCreateForHost(input, target).children;
    const created = await context.hostReviewedChild.invoke(child!);
    if (!created.ok) return created;
    const provider = { ...DeploymentTargetLinkProviderContentV1Schema.parse(created.result),
        ...(input.providerCreate.sourceMethod !== undefined ? { sourceMethod: input.providerCreate.sourceMethod } : {}) };
    const { providerCreate: _create, ...intent } = input;
    const recovery = DeploymentTargetLinkProviderIntentInputV1Schema.parse({ ...intent, provider, provisioned: true });
    const retained = DeploymentTargetLinkProvisionedResultV1Schema.parse({ ok: false, error: 'deployment_link_incomplete', recovery });
    try { context.operationOwnerUpdate.update({ outcome: { ok: true, result: normalizeStrictJsonValue(retained) } }); }
    catch (cause) { throw new RuntimeTargetCreationCheckpointError(recovery, cause); }
    return { ok: true as const, recovery };
}
