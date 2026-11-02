import { isDeepStrictEqual } from 'node:util';
import { DeploymentDeployActionInputV1Schema, DeploymentDeployInputV1Schema, DeploymentEnvironmentGetResultV1Schema,
    type DeploymentDeployIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readPendingDeploymentIntentForHost } from './pendingDeploy';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readReviewedDeploymentDeployInput } from '@/api/externalActionExecutionAuthorization';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

type PendingRecoveryRequest = Readonly<{
    input: unknown; context: ActionExecutorContext;
    scope: Readonly<{ accountId: string; machineId: string }>;
    custody: Readonly<{ serverId: string; installationId: string }>;
    read(): Promise<unknown>;
}>;

/** Admission correspondence is shared by compact preparation and restoration;
 * neither may infer the original requester from a reader or Source owner. */
export async function readPendingDeploymentRecoveryAdmission(request: PendingRecoveryRequest): Promise<Readonly<{
    current: Extract<ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>, { ok: true }>;
    admission: import('@happier-dev/protocol/deployments/deploymentActionsV1').DeploymentPendingAdmissionV1;
}> | undefined> {
    const input = DeploymentDeployActionInputV1Schema.safeParse(request.input);
    if (!input.success || input.data.whenBusy !== 'supersede' || !input.data.requestKey) return undefined;
    const refuse = (code: string): never => { throw new RpcError(code, code); };
    const authorization = request.context.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    if (!authorization || authorization.binding.actionId !== 'deployments.deploy' || !requester
        || !await requester.isCurrent() || request.context.signal?.aborted) return refuse('action_forbidden');
    const reviewed = await readReviewedDeploymentDeployInput({ authorization,
        envelope: request.context.originalActionEnvelope, signal: request.context.signal });
    if (!reviewed || reviewed.environmentId !== input.data.environmentId || reviewed.requestKey !== input.data.requestKey
        || !await isServerProfileHomeIdentity(reviewed.serverId, authorization.binding.serverIdentityId)) return refuse('action_forbidden');
    const raw = await request.read();
    request.context.signal?.throwIfAborted();
    if (!await requester.isCurrent()) return refuse('action_forbidden');
    const metadata = DeploymentEnvironmentGetResultV1Schema.safeParse(raw);
    if (!metadata.success) return refuse('invalid_action_output');
    if (!metadata.data.ok) return refuse(metadata.data.error);
    const { environment, pendingDeploy, pendingAdmission } = metadata.data;
    if (environment.id !== input.data.environmentId) return refuse('deployment_conflict');
    if (!pendingDeploy) return undefined;
    // A different request is an intentional new supersede, not recovery.
    if (pendingAdmission && pendingAdmission.requestKey !== input.data.requestKey) return undefined;
    if ('contentArtifactId' in input.data && (!input.data.pendingDeploy
        || !isDeepStrictEqual(pendingDeploy, input.data.pendingDeploy))) return refuse('deployment_conflict');
    if (!pendingAdmission) return refuse('operation_unavailable');
    const binding = authorization.binding;
    if (!environment.capabilities.deploy || pendingAdmission.requesterAccountId !== request.scope.accountId
        || binding.accountId !== request.scope.accountId || pendingAdmission.serverId !== binding.serverIdentityId
        || !await isServerProfileHomeIdentity(request.custody.serverId, binding.serverIdentityId)
        || binding.target.kind !== 'machine' || binding.target.machineId !== request.scope.machineId
        || binding.machineId !== request.scope.machineId || environment.controllerMachineId !== request.scope.machineId
        || pendingAdmission.controller.machineId !== request.scope.machineId
        || pendingAdmission.controller.installationId !== request.custody.installationId
        || binding.installationId !== request.custody.installationId) return refuse('deployment_access_denied');
    return { current: metadata.data, admission: pendingAdmission };
}

/** Compact preparation and deferred observation share the same opened pin. */
export async function readCompactPendingDeploymentRecovery(request: Omit<PendingRecoveryRequest, 'input'> & Readonly<{
    input: DeploymentDeployIntentInputV1;
    readResource: Parameters<typeof readPendingDeploymentIntentForHost>[1]['readResource'];
    assertCurrent(): Promise<void>;
}>) {
    const retained = await readPendingDeploymentRecoveryAdmission(request);
    if (!retained?.current.pendingDeploy) return undefined;
    const pendingDeploy = retained.current.pendingDeploy;
    const captured = await readPendingDeploymentIntentForHost({ environment: retained.current.environment, pendingDeploy }, request);
    const input = request.input;
    // Omission retains the Git default, never an explicitly captured upload.
    const sourceMethod = input.sourceMethod ?? (captured.sourceMethod === 'gitIntegration' ? 'gitIntegration' : undefined);
    const refuse = (code: string): never => { throw new RpcError(code, code); };
    if (captured.triggerOccurrence) return refuse('unsupported_action');
    if (captured.actionOperationId !== retained.admission.actionOperationId || captured.requestKey !== input.requestKey
        || captured.targetLinkId !== retained.current.environment.runtimeTargetLinkId
        || input.targetLinkId !== undefined && input.targetLinkId !== captured.targetLinkId
        || sourceMethod !== captured.sourceMethod
        || input.sourceIntent !== undefined && !isDeepStrictEqual(input.sourceIntent, captured.sourceIntent)
        || input.sha !== undefined && (captured.sourceIntent.kind !== 'repository' || input.sha !== captured.sourceIntent.sha)) {
        return refuse('deployment_conflict');
    }
    await request.assertCurrent();
    return { ...retained, pendingDeploy, captured };
}

/** Only full prepared input validated against its retained private intent may
 * restore an old operation in the canonical runner. */
export async function readPendingDeploymentRecoveryOperation(request: PendingRecoveryRequest & Readonly<{
    validate(input: ReturnType<typeof DeploymentDeployInputV1Schema.parse>,
        current: Extract<ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>, { ok: true }>, operationId: string): Promise<void>;
}>): Promise<import('@happier-dev/protocol/deployments/deploymentActionsV1').DeploymentPendingAdmissionV1 | undefined> {
    const input = DeploymentDeployInputV1Schema.safeParse(request.input);
    if (!input.success || input.data.whenBusy !== 'supersede') return undefined;
    const retained = await readPendingDeploymentRecoveryAdmission(request);
    if (!retained) return undefined;
    const { current, admission: pendingAdmission } = retained;
    const environment = current.environment;
    const refuse = (code: string): never => { throw new RpcError(code, code); };
    const requester = readRequesterAccountActionContext(request.context.externalActionExecutionAuthorization);
    const currentLink = current.targetLinks.find(link => link.id === input.data.targetLinkId);
    if (environment.runtimeTargetLinkId !== input.data.targetLinkId || !currentLink) return refuse('deployment_conflict');
    try { await request.validate(input.data, current, pendingAdmission.actionOperationId); }
    catch (error) {
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') return refuse(error.code);
        throw error;
    }
    if (!requester || !await requester.isCurrent() || request.context.signal?.aborted) return refuse('action_forbidden');
    return pendingAdmission;
}
