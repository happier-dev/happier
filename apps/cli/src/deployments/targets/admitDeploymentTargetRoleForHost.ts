import { sameStrictJsonValue as isDeepStrictEqual } from '@happier-dev/protocol/json/strictJsonValue';
import { readHostReviewedChildOperationV1, isHostAdmittedReviewedChildPolicyV1,
    readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { deploymentOperationForRootActionV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { WorkflowDataCreationResult } from './workflowDataCreationResult';
import { z } from 'zod/mini';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import {
    DeploymentTargetRoleInputSchemasV1, DeploymentTargetRoleCommonInputV1Schema,
    type DeploymentTargetRoleInputV1, type DeploymentTargetRoleCommonInputV1,
    type DeploymentTargetRoleV1,
} from '@happier-dev/protocol/plugins/contributions/v2';
import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { ResolvedDeploymentTargetActionRole } from '@/plugins/projection/registry/types';
import type { RegistryConnectedAccountActionFormPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type { StoredCredentials } from '@/persistence';
import { admitDeploymentTargetCredentialPrincipalForHost } from './admitDeploymentTargetCredentialPrincipalForHost';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { PluginError } from '@happier-dev/cli-common/plugins/errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentTargetLinkProviderContentV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';

export type DeploymentTargetRoleAdmissionHost = Readonly<{
    serverId: string;
    machineId: string;
    installationId?: string;
    credentialOwnerAccountId: string;
    credentials: StoredCredentials;
    serverHttpBaseUrl: string;
    resolveRequesterIdentity: import('../readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    readEnvironment(request: Readonly<{ environmentId: string; targetLinkId?: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
    readReceipt(request: Readonly<{ environmentId: string; deploymentId: string; context: ActionExecutorContext }>): Promise<DeploymentReceiptDetailV1>;
    resolveEnvironmentApprovalScope?: import('@happier-dev/protocol').ActionExecutorDeps['resolveEnvironmentApprovalScope'];
    assertCurrent(context: ActionExecutorContext): Promise<void>;
}>;

export type DeploymentTargetRoleAdmissionRequest = Readonly<{
    pluginId: string;
    localId: string;
    bindings: readonly ResolvedDeploymentTargetActionRole[];
    executionTarget: 'account' | 'daemon';
    role?: DeploymentTargetRoleV1;
    /** Host-only pre-reservation admission; never an authored Action operand. */
    phase?: 'preparation' | 'execution';
    /** Authenticated retained Workflow output, supplied only by the host preparation owner. */
    retainedDataCreation?: WorkflowDataCreationResult;
    input: unknown;
    context: ActionExecutorContext;
    purposeAuthorization: RegistryConnectedAccountActionFormPurposeAuthorization | null;
}>;

const refuse = (code: string, phase = 'deployment.target.admission'): never => {
    if (code === 'deployment_access_denied') throw new PluginError({ code,
        failureCause: projectActionFailureCauseV1(new Error(code), phase) });
    throw Object.assign(new Error(code), { code });
};

/** Link and receipt custody compare the same captured provider operands. */
function assertProviderProvenance(scope: 'link' | 'receipt', stored: Partial<DeploymentTargetLinkProviderContentV1>,
    input: Pick<AdmittedRoleInput, 'credentialPrincipal' | 'providerIdentity' | 'providerEnvironment' | 'repositoryAccess' | 'preparedNative'>): void {
    const deny = (family: string) => refuse('deployment_access_denied', `deployment.target.admission.${scope}.${family}`);
    if (!isDeepStrictEqual(stored.credentialPrincipal, input.credentialPrincipal)) deny('credential_principal');
    if (!isDeepStrictEqual(stored.providerIdentity, input.providerIdentity)) deny('provider_identity');
    if (!isDeepStrictEqual(stored.providerEnvironment, input.providerEnvironment)) deny('provider_environment');
    if (!isDeepStrictEqual(stored.repositoryAccess, input.repositoryAccess)) deny('repository_access');
    if (!isDeepStrictEqual(stored.preparedNative, input.preparedNative)) deny('prepared_native');
}
const has = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const preflightSchema = z.extend(DeploymentTargetRoleCommonInputV1Schema, {
    targetLinkId: DeploymentTargetRoleInputSchemasV1.deploy.shape.targetLinkId,
    expectedTargetLinkRevision: DeploymentTargetRoleInputSchemasV1.deploy.shape.expectedTargetLinkRevision,
});
type AdmittedRoleInput = DeploymentTargetRoleInputV1 | z.infer<typeof preflightSchema>;
export type DeploymentTargetRoleAdmissionForHost = Readonly<{
    input: DeploymentTargetRoleInputV1 | DeploymentTargetRoleCommonInputV1;
    environment: DeploymentEnvironmentDetailV1;
    receipt?: DeploymentReceiptDetailV1;
    role: string;
}> | Readonly<{ input: DeploymentTargetRoleInputV1; role: 'branches.delete'; environment?: never; receipt?: never }>;
function roleName(role: string): role is DeploymentTargetRoleV1 {
    return has(DeploymentTargetRoleInputSchemasV1, role);
}

/** Project shared custody only; the incumbent Action parser retains product-specific operands. */
function projectPreparationInput<TSchema extends z.ZodMiniObject>(value: unknown, schema: TSchema): z.output<TSchema> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const selected = Object.fromEntries(Object.keys(schema.shape).filter(key => has(value, key))
        .map(key => [key, Reflect.get(value, key)]));
    const parsed = z.safeParse(schema, selected);
    return parsed.success ? parsed.data : null;
}

/**
 * One admission owner for routed preparation and direct qualified execution.
 * Readers open only the selected Environment/link/receipt under captured custody.
 */
export async function admitDeploymentTargetRoleForHost(request: DeploymentTargetRoleAdmissionRequest,
    host: DeploymentTargetRoleAdmissionHost): Promise<DeploymentTargetRoleAdmissionForHost> {
    request.context.signal?.throwIfAborted();
    const bindings = request.bindings.filter(binding => roleName(binding.role) && (!request.role || request.role === binding.role));
    if (!bindings.length) return refuse('deployment_target_role_unavailable');
    const preparation = request.phase === 'preparation';
    const parsed: { binding: ResolvedDeploymentTargetActionRole; input: AdmittedRoleInput }[] = [];
    for (const binding of bindings) {
        if (!roleName(binding.role)) continue;
        if (preparation && !binding.role.includes('.')) {
            const value = projectPreparationInput(request.input, preflightSchema);
            if (value) parsed.push({ binding, input: value });
            continue;
        }
        if (binding.role === 'inspect' || binding.role === 'link' || binding.role.includes('.')) {
            const value = projectPreparationInput(request.input, DeploymentTargetRoleInputSchemasV1[binding.role]);
            if (value) parsed.push({ binding, input: value });
        } else {
            const value = DeploymentTargetRoleInputSchemasV1[binding.role].safeParse(request.input);
            if (value.success) parsed.push({ binding, input: value.data });
        }
    }
    if (!parsed.length) return refuse('deployment_invalid');
    // A preparation role may share an Action with a lifecycle role. Its
    // custody projection must never erase a successfully parsed receipt.
    const lifecycle = parsed.filter(entry => 'deploymentId' in entry.input);
    const matched = lifecycle.length ? lifecycle : parsed;
    const input = matched[0]!.input;
    const actionId = formatQualifiedPluginActionId({ pluginId: request.pluginId, localId: request.localId });
    const reviewed = readHostReviewedChildOperationV1(request.context, actionId, request.input);
    const parent = reviewed?.parent;
    // Accepted receipt reads carry custody, not permission to start another job.
    // Consume the host's existing admission for this exact operation instead of
    // re-admitting it from that deliberately read-only Environment projection.
    const admittedParent = isHostAdmittedReviewedChildPolicyV1(reviewed, actionId, request.input)
        ? parent : readHostAdmittedReviewedParentV1(request.context.hostReviewedChild);
    const admittedOperation = !preparation && 'deploymentId' in input
        && admittedParent?.input.serverId === input.serverId
        && admittedParent.input.environmentId === input.environmentId
        && admittedParent.input.targetLinkId === input.targetLinkId
        ? deploymentOperationForRootActionV1(admittedParent.actionId) : undefined;
    if (!preparation && matched.every(entry => entry.binding.role === 'branches.delete')
        && parent?.actionId === 'deployments.teardown'
        && parent.input.serverId === input.serverId && parent.input.environmentId === input.environmentId
        && parent.input.targetLinkId === input.targetLinkId
        && isHostAdmittedReviewedChildPolicyV1(reviewed, actionId, request.input)) {
        return { input: DeploymentTargetRoleInputSchemasV1['branches.delete'].parse(input), role: 'branches.delete' };
    }
    const retained = preparation && matched.every(entry => entry.binding.role === 'branches.delete')
        ? request.retainedDataCreation : undefined;
    const principal = admitDeploymentTargetCredentialPrincipalForHost(input, host.credentialOwnerAccountId);
    const authorization = request.purposeAuthorization;
    if (!authorization || authorization.action.pluginId !== request.pluginId || authorization.action.localId !== request.localId
        || !authorization.serviceRefs.some(service => isDeepStrictEqual(service, input.credentialRef.service))) {
        return refuse('deployment_access_denied', 'deployment.target.admission.purpose_authorization');
    }
    if (!await isServerProfileHomeIdentity(input.serverId, host.serverId)) return refuse('server_scope_mismatch');
    const detail = await host.readEnvironment({ environmentId: input.environmentId,
        ...(input.targetLinkId ? { targetLinkId: input.targetLinkId } : {}), context: request.context });
    const environment = detail.environment;
    if (environment.id !== input.environmentId || !await isServerProfileHomeIdentity(environment.serverId, host.serverId) || environment.deletedAtMs !== undefined
        || !environment.capabilities.read) return refuse('deployment_access_denied', 'deployment.target.admission.environment_read');
    if (environment.revision !== input.expectedRevision) return refuse('deployment_conflict');
    let candidates = matched;
    if (input.targetLinkId) {
        const selected = detail.targetLinks.find(entry => entry.targetLink.id === input.targetLinkId);
        const link = selected?.targetLink;
        const content = selected?.content;
        if (!link || !content || link.environmentId !== environment.id
            || link.deletedAtMs !== undefined || link.detachedAtMs !== undefined || link.source.kind !== 'plugin') return refuse('target_mismatch');
        if (!retained && link.createdByAccountId !== principal.accountId)
            return refuse('deployment_access_denied', 'deployment.target.admission.link_author');
        candidates = candidates.filter(({ binding }) => link.role === (binding.role.includes('.') ? 'data' : 'runtime')
            && link.source.kind === 'plugin'
            && link.source.contribution.pluginId === request.pluginId && link.source.contribution.localId === binding.targetLocalId
            && link.targetKind === binding.targetKind);
        if (!candidates.length) return refuse('target_mismatch');
        if (link.revision !== input.expectedTargetLinkRevision) return refuse('deployment_conflict');
        if (retained && (link.source.contribution.pluginId !== retained.source.pluginId
            || link.source.contribution.localId !== retained.source.localId
            || !isDeepStrictEqual(retained.deleteAction, { pluginId: request.pluginId, localId: request.localId })
            || !isDeepStrictEqual(retained.providerIdentity, input.providerIdentity)
            || !isDeepStrictEqual(retained.providerEnvironment, input.providerEnvironment))) return refuse('target_mismatch');
        if (!retained) assertProviderProvenance('link', content, input);
        if (request.executionTarget === 'daemon' && !candidates.some(candidate => candidate.binding.role.includes('.') || candidate.binding.role === 'uploadDeploy')) {
            if (!link.machineId || !link.installationId) return refuse('machine_unavailable');
            if (preparation ? environment.controllerMachineId !== host.machineId
                : !host.installationId || link.machineId !== host.machineId || link.installationId !== host.installationId) return refuse('machine_unavailable');
        }
    } else {
        if (!candidates.every(candidate => candidate.binding.role === 'inspect' || candidate.binding.role === 'link'
            || candidate.binding.role.startsWith('projects.'))) return refuse('target_mismatch');
        if (candidates.some(candidate => candidate.binding.role === 'link') && !environment.capabilities.manageTargets)
            return refuse('deployment_access_denied', 'deployment.target.admission.link_manage');
        // Initial intent has no stored provenance yet; it must spend its own
        // actual declaration-derived purpose rather than an arbitrary consumer.
        if (!isDeepStrictEqual(principal.purpose, authorization.purpose))
            return refuse('deployment_access_denied', 'deployment.target.admission.initial_purpose');
    }
    if ((request.executionTarget === 'account' || candidates.some(candidate => candidate.binding.role.includes('.') || candidate.binding.role === 'uploadDeploy'))
        && environment.controllerMachineId !== host.machineId) return refuse('machine_unavailable');
    candidates = candidates.filter(({ binding }) => ['inspect', 'observe', 'projects.list', 'projects.provisionOptions',
        'projects.link', 'branches.list', 'query.readOnly'].includes(binding.role)
        ? environment.capabilities.read : ['link', 'projects.provision', 'connectionSecret.save'].includes(binding.role)
            ? environment.capabilities.manageTargets : environment.capabilities.deploy
                || admittedOperation === (binding.role === 'uploadDeploy' ? 'deploy' : binding.role));
    if (!candidates.length) return refuse('deployment_access_denied', 'deployment.target.admission.role_capability');
    // The existing preview relation plus its manager-authored exact data link is adoption authority.
    if (candidates.some(({ binding }) => binding.role === 'branches.delete') && environment.purpose !== 'preview') {
        return refuse('deployment_access_denied', 'deployment.target.admission.preview_purpose');
    }
    if (candidates.some(({ binding }) => ['deploy', 'uploadDeploy', 'rollback', 'promote'].includes(binding.role))
        && environment.runtimeTargetLinkId !== input.targetLinkId) return refuse('target_mismatch');
    let receipt: DeploymentReceiptDetailV1 | undefined;
    if (!preparation && 'deploymentId' in input) {
        receipt = await host.readReceipt({ environmentId: environment.id, deploymentId: input.deploymentId, context: request.context });
        const header = receipt.deployment;
        if (header.id !== input.deploymentId || header.environmentId !== environment.id || header.targetLinkId !== input.targetLinkId
            || header.actionOperationId !== input.actionOperationId) return refuse('target_mismatch');
        if (header.revision !== input.expectedDeploymentRevision) return refuse('deployment_conflict');
        const observe = candidates.every(({ binding }) => binding.role === 'observe');
        const cancel = candidates.every(({ binding }) => binding.role === 'cancel');
        if (!observe) {
            const accepted = header.acceptedExecution;
            if (!accepted || accepted.controller.machineId !== environment.controllerMachineId
                || accepted.controller.machineId !== host.machineId || !host.installationId
                || accepted.controller.installationId !== host.installationId) return refuse('machine_unavailable');
            if (cancel ? ['succeeded', 'running_unverified', 'failed', 'cancelled'].includes(header.state)
                : header.state !== 'queued') return refuse('deployment_conflict');
            if (!cancel && header.cancelRequestedAtMs !== undefined) return refuse('cancelled');
            if (!cancel && request.context.operationAcceptance?.operationId !== input.actionOperationId) return refuse('operation_unavailable');
            const operations: readonly string[] = candidates.map(({ binding }) => binding.role === 'uploadDeploy' ? 'deploy' : binding.role);
            if (!cancel && !operations.includes(header.operation)) return refuse('target_mismatch');
        }
        const platform = receipt.content.platform;
        if (!platform || platform.targetLinkRevision !== input.expectedTargetLinkRevision)
            return refuse('deployment_access_denied', 'deployment.target.admission.receipt.target_link_revision');
        assertProviderProvenance('receipt', platform, input);
        if ('sourceIntent' in input && (!isDeepStrictEqual(receipt.content.sourceIntent, input.sourceIntent)
            || receipt.content.sourceMethod !== input.sourceMethod)) return refuse('deployment_conflict');
        if (input.providerDeploymentId !== undefined && platform.observation.providerDeploymentId !== input.providerDeploymentId) return refuse('target_mismatch');
        if ('priorDeployment' in input) {
            const prior = input.priorDeployment;
            const expected = candidates.some(candidate => candidate.binding.role === 'rollback')
                ? header.rollbackOfDeploymentId : header.promotedFromDeploymentId;
            if (expected !== prior.deploymentId) return refuse('target_mismatch');
            if (!candidates.some(({ binding }) => binding.role === admittedOperation)) {
                const source = await host.readEnvironment({ environmentId: prior.environmentId, context: request.context });
                if (source.environment.id !== prior.environmentId || source.environment.deletedAtMs !== undefined
                    || !source.environment.capabilities.deploy)
                    return refuse('deployment_access_denied', 'deployment.target.admission.prior_environment');
            }
            const previous = await host.readReceipt({ environmentId: prior.environmentId, deploymentId: prior.deploymentId, context: request.context });
            if (previous.deployment.id !== prior.deploymentId || previous.deployment.environmentId !== prior.environmentId
                || previous.deployment.revision !== prior.expectedRevision
                || previous.content.platform?.observation.providerDeploymentId !== prior.providerDeploymentId) return refuse('deployment_conflict');
        }
    }
    await host.assertCurrent(request.context);
    request.context.signal?.throwIfAborted();
    return { input, environment: detail, ...(receipt ? { receipt } : {}), role: candidates[0]!.binding.role };
}
