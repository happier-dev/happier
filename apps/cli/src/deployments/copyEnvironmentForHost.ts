import { DeploymentEnvironmentCreateResultV1Schema,
    type DeploymentEnvironmentCreateInputV1, type DeploymentBindingsSetInputV1,
    type DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';

export const COPY_ENVIRONMENT_BINDINGS_ROLE = 'copy-bindings';
type Continuation = Readonly<{ actionId: 'deployments.environments.create'; input: DeploymentEnvironmentCreateInputV1 }>
    | Readonly<{ actionId: 'deployments.bindings.set'; input: Extract<DeploymentBindingsSetInputV1, { set: unknown }> }>;
type CreateResult = ReturnType<typeof DeploymentEnvironmentCreateResultV1Schema.parse>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Copy configuration once; all selected grants still pass through the ordinary binding Action. */
export async function createEnvironmentWithCopyForHost(request: Readonly<{
    input: DeploymentEnvironmentCreateInputV1; context: ActionExecutorContext;
    creationReview?: DeploymentEnvironmentCreationReviewV1;
}>, host: Readonly<{
    create: NonNullable<ActionExecutorDeps['deploymentAction']>;
    readEnvironment(request: Parameters<typeof readDeploymentEnvironmentForHost>[0]): ReturnType<typeof readDeploymentEnvironmentForHost>;
}>): Promise<CreateResult | ActionExecuteFailure> {
    const { input, context } = request;
    const plan = input.copyPlan;
    if (!input.copyFrom || !plan) return failure('client_required');
    if (plan.bindings.length && !context.hostReviewedChild) return failure('client_required');
    const stored = await host.create('deployments.environments.create', input, context, request.creationReview);
    if ('errorCode' in stored) return stored;
    const parsed = DeploymentEnvironmentCreateResultV1Schema.safeParse(stored);
    if (!parsed.success) return failure('invalid_action_output');
    const created = parsed.data;
    if (!created.ok || !plan.bindings.length) return created;
    let continuation: Continuation = { actionId: 'deployments.environments.create', input };
    const partial = (errorCode: string): ActionExecuteFailure => ({ ...failure(errorCode), details: {
        environmentId: created.environmentId, revision: created.revision, continuation,
    } });
    try {
        const current = await host.readEnvironment({ environmentId: created.environmentId, context });
        const bindings = plan.bindings.map(binding => {
            if (binding.purpose !== 'registry') return binding;
            if (binding.targetLinkId !== plan.sourceRuntimeTargetLinkId || !current.environment.runtimeTargetLinkId)
                throw Object.assign(new Error('deployment_unavailable'), { code: 'deployment_unavailable' });
            return { ...binding, targetLinkId: current.environment.runtimeTargetLinkId };
        });
        if (sameStrictJsonValue(current.content.bindings, bindings)) return {
            ok: true, environmentId: created.environmentId, revision: current.environment.revision,
        };
        const bindingInput = { serverId: input.serverId, environmentId: created.environmentId,
            expectedRevision: current.environment.revision, set: bindings, remove: [] };
        continuation = { actionId: 'deployments.bindings.set', input: bindingInput };
        // A resumed copy cannot overwrite an independently edited destination or
        // seal its selected credentials to a runtime absent from the reviewed create.
        if (current.environment.contentArtifactId !== input.contentArtifactId
            || current.environment.contentHeaderVersion !== input.contentHeaderVersion
            || current.environment.contentBodyVersion !== input.contentBodyVersion) return partial('deployment_conflict');
        if (input.firstTargetLink) {
            const runtime = current.targetLinks.find(link => link.id === current.environment.runtimeTargetLinkId);
            const members = runtime?.members.map(({ machineId, installationId }) => ({ machineId, installationId }));
            if (!sameStrictJsonValue(members, input.firstTargetLink.machines)) return partial('approval_stale');
        }
        const applied = await context.hostReviewedChild!.invoke({ action: 'deployments.bindings.set',
            role: COPY_ENVIRONMENT_BINDINGS_ROLE, input: bindingInput });
        if (!applied.ok) return partial(applied.errorCode);
        const settled = DeploymentEnvironmentCreateResultV1Schema.safeParse(applied.result);
        if (!settled.success) return partial('invalid_action_output');
        if (!settled.data.ok) return partial(settled.data.error);
        return settled.data.environmentId === created.environmentId ? settled.data : partial('invalid_action_output');
    } catch (error) {
        return partial(context.signal?.aborted ? 'cancelled'
            : error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code : 'deployment_content_unavailable');
    }
}
