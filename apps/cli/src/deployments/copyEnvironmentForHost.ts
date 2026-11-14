import { carryActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/resultProjection';
import { deploymentOutputValidationFailure } from './outputValidation';
import { DeploymentEnvironmentCreateResultV1Schema, DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentEnvironmentCreateInputV1,
    DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { isRecord } from '@happier-dev/protocol/common/records';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { deploymentUnavailableError, projectDeploymentFailure } from './deploymentFailure';
import { copyEnvironmentDataForHost } from './copyEnvironmentDataForHost';
import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { sameBindingIntent } from './secrets/sameBindingIntent';

export const COPY_ENVIRONMENT_BINDINGS_ROLE = 'copy-bindings';
type PartialResult = ReturnType<typeof DeploymentTemplateInstantiationPartialV1Schema.parse>;
type Continuation = NonNullable<PartialResult['continuation']>;
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
    if ((plan.bindings.length || plan.data?.length) && !context.hostReviewedChild) return failure('client_required');
    const stored = await host.create('deployments.environments.create', input, context, request.creationReview);
    if ('ok' in stored && !stored.ok && 'errorCode' in stored) return stored;
    const parsed = DeploymentEnvironmentCreateResultV1Schema.safeParse(stored);
    if (!parsed.success) return deploymentOutputValidationFailure('deployments.environments.create', undefined, parsed.error);
    const created = parsed.data;
    if (!created.ok) return created;
    if (created.replayed !== false && plan.data?.length) return { ...failure('deployment_conflict'), details: {
        kind: 'partial', phase: 'environment', environmentId: created.environmentId, revision: created.revision,
        errorCode: 'deployment_conflict', savedSecrets: [],
        requiredFact: plan.data.map(row => `data:${row.targetLinkId}:createEmpty`).join(', '),
        remedy: `${created.replayed === undefined
            ? 'Create acknowledged its Environment without confirming a fresh allocation. Upgrade or align Home and the client.'
            : 'This Create already allocated its Environment.'} Inspect this Environment, its database attachments and provider outcomes. Open the Environment Overview and add/manage a managed database. Link exact resources already created or explicitly create/configure remaining resources. Do not replay Duplicate.`,
    } satisfies PartialResult };
    const finish = async (revision: number) => {
        const finished = await copyEnvironmentDataForHost({ input, context, environmentId: created.environmentId, revision });
        return finished.ok ? { ...created, ...finished } : finished;
    };
    if (!plan.bindings.length) return finish(created.revision);
    let continuation: Continuation | undefined;
    const partial = (cause: string | ActionExecuteFailure): ActionExecuteFailure => {
        const errorCode = typeof cause === 'string' ? cause : cause.errorCode;
        const inherited = typeof cause === 'string' ? undefined
            : projectDeploymentFailureRecoveryV1(isRecord(cause.details) ? cause.details : {}, cause.errorCode);
        return carryActionFailureDiagnostic({ ...(typeof cause === 'string' ? failure(cause) : cause), effectAttempted: true, details: {
            kind: 'partial', phase: 'bindings', errorCode, savedSecrets: [],
            environmentId: created.environmentId, revision: created.revision, ...(continuation ? { continuation } : {}),
            ...(inherited ? { requiredFact: inherited.requiredFact, remedy: inherited.remedy } : {}),
            ...(plan.data?.length ? { requiredFact: [inherited?.requiredFact, ...plan.data.map(row => `data:${row.targetLinkId}:createEmpty`)].filter(Boolean).join(', '),
                remedy: `${inherited ? `${inherited.remedy} ` : ''}Recover bindings, then open the Environment Overview and add/manage a managed database. Explicitly create/configure these unattempted resources; inspect the provider and link exact resources already created. Do not replay Duplicate.` } : {}),
        } satisfies PartialResult }, cause);
    };
    try {
        const current = await host.readEnvironment({ environmentId: created.environmentId, context });
        const bindings = plan.bindings.map(binding => {
            if (binding.purpose !== 'registry') return binding;
            if (binding.targetLinkId !== plan.sourceRuntimeTargetLinkId || !current.environment.runtimeTargetLinkId)
                throw deploymentUnavailableError('deployment.environment.copy.registry_binding', 'binding_missing');
            return { ...binding, targetLinkId: current.environment.runtimeTargetLinkId };
        });
        if (sameBindingIntent(current.content.bindings, bindings)) return finish(current.environment.revision);
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
        if (!applied.ok) return partial(applied);
        const settled = DeploymentBindingsSetResultV1Schema.safeParse(applied.result);
        if (!settled.success) return partial(deploymentOutputValidationFailure('deployments.bindings.set', undefined, settled.error));
        if (!settled.data.ok) return partial(settled.data.error);
        return settled.data.environmentId === created.environmentId
            ? finish(settled.data.revision) : partial(deploymentOutputValidationFailure('copyEnvironmentForHost', undefined));
    } catch (error) {
        return partial(projectDeploymentFailure(context.signal?.aborted ? 'cancelled'
            : error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code : 'deployment_content_unavailable', error, 'deployment.environment.copy.bindings'));
    }
}
