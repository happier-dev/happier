import { DeploymentTeardownInputV1Schema, type ActionExecutorContext, type ActionExecutorDeps,
    type DeploymentTeardownInputV1, type DeploymentReceiptResultV1 } from '@happier-dev/protocol';
import type { HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentDataTeardownContentV1Schema, DEPLOYMENT_TEARDOWN_STEPS_V1,
    type DeploymentDataTeardownContentV1, type DeploymentContentV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionExecuteFailureError, isActionOutcomeUnknownErrorCodeV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { DeploymentExecutionFailureDetailsV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { projectDeploymentException, projectDeploymentReceiptFailure } from '../deploymentFailure';
import { createDeploymentTargetRoleAdmissionHost } from '../targets/createDeploymentTargetRoleAdmissionHost';
import { admitDeploymentTargetRoleForHost } from '../targets/admitDeploymentTargetRoleForHost';
import { resolveRegistryConnectedAccountActionCredentialPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { StoredCredentials } from '@/persistence';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { DeploymentReceiptDispatchV1 } from '../createCliDeploymentActionDeps';
import type { OwnServerDeploymentTargetHostInput, OwnServerDeploymentTransition } from '../targets/ownServer/ownServerDeploymentTarget';
import { readWorkflowDataCreationResult } from '../targets/workflowDataCreationResult';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { createDataProjectTeardownForHost } from './dataProjectTeardown';
import { DeploymentProviderTeardownContentV1Schema, type DeploymentProviderTeardownContentV1 } from '@happier-dev/deployment-protocol';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
type Reference = Pick<DeploymentTeardownInputV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;
export type DataTeardownHost = Pick<OwnServerDeploymentTargetHostInput, 'serverId' | 'machineId'> & Readonly<{
    credentials: StoredCredentials; serverHttpBaseUrl: string;
    resolveRequesterIdentity: import('../readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    readEnvironment(request: Readonly<{ environmentId: string; targetLinkId?: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
    readReceipt(request: Readonly<{ environmentId: string; deploymentId: string; context: ActionExecutorContext }>): Promise<DeploymentReceiptDetailV1>;
    writeTransition(request: Omit<OwnServerDeploymentTransition, 'content'> & Readonly<{ content: DeploymentDataTeardownContentV1 | DeploymentProviderTeardownContentV1 }>):
        ReturnType<OwnServerDeploymentTargetHostInput['writeTransition']>;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    findReceipt(input: Pick<DeploymentTeardownInputV1, 'environmentId' | 'targetLinkId' | 'requestKey'>, context: ActionExecutorContext): Promise<DeploymentReceiptDetailV1 | null>;
    readContent(input: Reference, context: ActionExecutorContext): Promise<DeploymentContentV1>;
    createCandidate(environment: DeploymentEnvironmentDetailV1, content: DeploymentDataTeardownContentV1 | DeploymentProviderTeardownContentV1,
        context: ActionExecutorContext): Promise<Reference>;
}>;

function childInput(input: Pick<DeploymentTeardownInputV1, 'serverId' | 'environmentId' | 'expectedRevision' | 'targetLinkId' | 'expectedTargetLinkRevision'>, content: DeploymentDataTeardownContentV1) {
    const platform = content.platform;
    const principal = platform.credentialPrincipal;
    if (principal.kind !== 'account' || principal.target.kind !== 'account') return refuse('deployment_target_role_unavailable');
    return normalizeStrictJsonValue({ v: 1, serverId: input.serverId, environmentId: input.environmentId,
        expectedRevision: input.expectedRevision, targetLinkId: input.targetLinkId,
        expectedTargetLinkRevision: input.expectedTargetLinkRevision, credentialRef: principal.target.account,
        credentialPrincipal: principal, providerIdentity: platform.providerIdentity, providerEnvironment: platform.providerEnvironment,
        ...(platform.repositoryAccess ? { repositoryAccess: platform.repositoryAccess } : {}),
        ...(platform.preparedNative ? { preparedNative: platform.preparedNative } : {}), ...platform.dataCreation.operands });
}
function children(input: DeploymentTeardownInputV1, content: DeploymentDataTeardownContentV1): HostReviewedChildrenPlanV1 {
    return { children: [{ action: content.platform.dataCreation.deleteAction, role: 'branches.delete', input: childInput(input, content) }] };
}

/** Ordinary teardown uses the exact opened Workflow result, then the existing receipt and child issuer. */
export function createDataTeardownForHost(host: DataTeardownHost) {
    const projectTeardown = createDataProjectTeardownForHost(host);
    const readPrepared = async (input: DeploymentTeardownInputV1, context: ActionExecutorContext) =>
        DeploymentDataTeardownContentV1Schema.safeParse(await host.readContent(input, context));
    return {
        ...projectTeardown,
        async prepare(request: Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentTeardown']>>[0]) {
            try {
                const { input, context } = request;
                if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
                const preparedContent = 'contentArtifactId' in input ? await host.readContent(input, context) : undefined;
                if (DeploymentProviderTeardownContentV1Schema.safeParse(preparedContent).success) {
                    const environment = await host.readEnvironment({ environmentId: input.environmentId, targetLinkId: input.targetLinkId, context });
                    const prepared = await projectTeardown.prepareProject(request, environment);
                    if (prepared) return prepared;
                }
                if (!('dataCreation' in input) && !('contentArtifactId' in input)) return failure('unsupported_action');
                const supplied = 'dataCreation' in input;
                if (supplied && input.volumes !== undefined) return failure('deployment_invalid');
                const prior = supplied ? await host.findReceipt(input, context) : null;
                const existing = prior ? DeploymentDataTeardownContentV1Schema.safeParse(prior.content)
                    : supplied ? null : DeploymentDataTeardownContentV1Schema.safeParse(preparedContent);
                if (existing?.success && input.volumes !== undefined) return failure('deployment_invalid');
                if (prior && (!existing?.success || prior.deployment.operation !== 'teardown'
                    || !sameStrictJsonValue(existing.data.platform.dataCreation.reference, 'dataCreation' in input ? input.dataCreation : undefined))) return failure('deployment_conflict');
                if (!supplied && !existing?.success) return { input: DeploymentTeardownInputV1Schema.parse(input), preview: normalizeStrictJsonValue(input) };
                const reference = 'dataCreation' in input ? input.dataCreation
                    : existing?.success ? existing.data.platform.dataCreation.reference : refuse('deployment_content_unavailable');
                const environment = await host.readEnvironment({ environmentId: input.environmentId, targetLinkId: input.targetLinkId, context });
                const row = environment.targetLinks.find(row => row.targetLink.id === input.targetLinkId);
                if (!row || row.targetLink.role !== 'data' || row.targetLink.source.kind !== 'plugin') return failure('target_mismatch');
                const retained = readWorkflowDataCreationResult(await request.readWorkflowInvocation(reference), reference);
                const source = row.targetLink.source.contribution;
                if (retained.input.serverId !== input.serverId || retained.input.environmentId !== input.environmentId
                    || retained.input.targetLinkId !== input.targetLinkId || !sameStrictJsonValue(source, retained.result.source)) return failure('target_mismatch');
                const principal = retained.input.credentialPrincipal;
                if (principal.kind !== 'account' || principal.target.kind !== 'account') return failure('deployment_access_denied');
                if (!host.acquirePluginRuntimeRegistryLease) return failure('unsupported_action');
                const content = DeploymentDataTeardownContentV1Schema.parse({ machines: [], images: [], machineResults: [], steps: [],
                    platform: { credentialPrincipal: principal, providerIdentity: retained.result.providerIdentity,
                        providerEnvironment: retained.result.providerEnvironment,
                        ...(retained.input.repositoryAccess ? { repositoryAccess: retained.input.repositoryAccess } : {}),
                        ...(retained.input.preparedNative ? { preparedNative: retained.input.preparedNative } : {}),
                        targetLinkRevision: input.expectedTargetLinkRevision, observation: existing?.success ? existing.data.platform.observation : { v: 1, state: 'queued', observedAtMs: Date.now() },
                        dataCreation: { reference, deleteAction: retained.result.deleteAction, operands: retained.result.operands,
                            retainedProviderResource: existing?.success ? existing.data.platform.dataCreation.retainedProviderResource
                                : !sameStrictJsonValue(row.content?.providerIdentity, retained.result.providerIdentity)
                                    || !sameStrictJsonValue(row.content?.providerEnvironment, retained.result.providerEnvironment) } } });
                const lease = await host.acquirePluginRuntimeRegistryLease();
                try {
                    const create = readResolvedActionContribution(lease.registry.contributes,
                        retained.action);
                    // The retained projection was made from this admitted target's paired deletion declaration.
                    const deletion = readResolvedActionContribution(lease.registry.contributes, retained.result.deleteAction);
                    if (!create?.admittedTarget?.deploymentTargetRoles?.some(role => role.role === 'branches.create'
                        && role.targetLocalId === source.localId)
                        || !deletion?.admittedTarget?.deploymentTargetRoles?.some(role => role.role === 'branches.delete'
                        && role.targetLocalId === source.localId)) return failure('deployment_target_role_unavailable');
                    const executionTarget = deletion.admittedTarget.declaration.execution.target;
                    if (executionTarget !== 'account' && executionTarget !== 'daemon') return failure('deployment_target_role_unavailable');
                    const admission = await createDeploymentTargetRoleAdmissionHost(context, {
                        resolveRequesterIdentity: host.resolveRequesterIdentity, readCurrentMachineId: () => host.machineId,
                        accountExecution: { credentials: host.credentials, serverUrl: host.serverHttpBaseUrl,
                            serverIdentityId: host.serverId, machineId: host.machineId,
                            isCurrent: async () => { await host.assertCurrent(context); return true; } } });
                    if (!admission) return failure('deployment_access_denied');
                    await admitDeploymentTargetRoleForHost({ pluginId: retained.result.deleteAction.pluginId, localId: retained.result.deleteAction.localId,
                        bindings: deletion.admittedTarget.deploymentTargetRoles ?? [], executionTarget, role: 'branches.delete',
                        phase: 'preparation', retainedDataCreation: retained.result, input: childInput(prior
                            ? { ...input, expectedRevision: environment.environment.revision, expectedTargetLinkRevision: row.targetLink.revision }
                            : input, content), context,
                        purposeAuthorization: resolveRegistryConnectedAccountActionCredentialPurposeAuthorization({
                            registry: lease.registry.contributes, qualifiedActionId: buildQualifiedPluginContributionKey(retained.result.deleteAction),
                            fieldPath: 'credentialRef', requireSelect: false }) }, { ...admission,
                        readEnvironment: async () => environment });
                } finally { await lease.release(); }
                if (existing?.success && !sameStrictJsonValue(existing.data, content)) return failure('deployment_conflict');
                const prepared = supplied ? await (async () => {
                    const { dataCreation: _reference, ...intent } = input;
                    return DeploymentTeardownInputV1Schema.parse({ ...intent, ...(prior ? { contentArtifactId: prior.deployment.contentArtifactId, contentHeaderVersion: prior.deployment.contentHeaderVersion,
                        contentBodyVersion: prior.deployment.contentBodyVersion } : await host.createCandidate(environment, content, context)) });
                })() : DeploymentTeardownInputV1Schema.parse(input);
                return { input: prepared, preview: normalizeStrictJsonValue({ dataCreation: reference,
                    providerIdentity: retained.result.providerIdentity, providerEnvironment: retained.result.providerEnvironment }),
                    hostReviewedChildren: children(prepared, content) };
            } catch (error) { return projectDeploymentException(error, { signal: request.context.signal }); }
        },
        async admit(input: DeploymentTeardownInputV1, context: ActionExecutorContext) {
            const content = await readPrepared(input, context);
            if (content.success && input.volumes !== undefined) return failure('deployment_invalid');
            return content.success && content.data.platform.targetLinkRevision === input.expectedTargetLinkRevision ? content.data : null;
        },
        async execute(request: DeploymentReceiptDispatchV1, retainedReceipt?: DeploymentReceiptDetailV1): Promise<DeploymentReceiptResultV1 | ActionExecuteFailure> {
            if (request.actionId !== 'deployments.teardown') return failure('unsupported_action');
            const receipt = retainedReceipt ?? await host.readReceipt({ environmentId: request.input.environmentId,
                deploymentId: request.receipt.deploymentId, context: request.context });
            const parsed = DeploymentDataTeardownContentV1Schema.safeParse(receipt.content);
            if (!parsed.success) return failure('target_mismatch');
            const accepted = receipt.deployment.acceptedExecution;
            if (receipt.deployment.operation !== 'teardown' || receipt.deployment.targetLinkId !== request.input.targetLinkId
                || receipt.deployment.requestKey !== request.input.requestKey
                || accepted?.controller.machineId !== host.machineId) return failure('target_mismatch');
            const result = (): DeploymentReceiptResultV1 => ({ ok: true, environmentId: receipt.deployment.environmentId,
                revision: request.receipt.revision, deploymentId: receipt.deployment.id,
                deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state });
            if ((receipt.deployment.state !== 'queued' && receipt.deployment.state !== 'running')
                || receipt.deployment.actionOperationId !== request.context.operationAcceptance?.operationId) return result();
            const installation = readInstallationIdentityIfExistsSync();
            if (!installation || accepted.controller.installationId !== installation.installationId) return failure('machine_unavailable');
            if (request.context.signal?.aborted || receipt.deployment.cancelRequestedAtMs !== undefined) return failure('cancelled');
            const port = request.context.hostReviewedChild;
            if (!port) return failure('unsupported_action');
            const content = parsed.data;
            const projectFailure = (response: ActionExecuteFailure) => {
                const receiptFailure = projectDeploymentReceiptFailure(response, response.effectAttempted === false ? 'admission' : 'teardown');
                return { failure: receiptFailure, result: { ...response,
                    ...(receiptFailure.failureCause ? { failureCause: receiptFailure.failureCause } : {}),
                    details: { serverId: host.serverId, environmentId: request.input.environmentId,
                        targetLinkId: request.input.targetLinkId, deploymentId: receipt.deployment.id,
                        failure: receiptFailure,
                    } satisfies DeploymentExecutionFailureDetailsV1 } satisfies ActionExecuteFailure };
            };
            const response = await (async () => {
                try {
                    return await port.invoke({ action: content.platform.dataCreation.deleteAction, role: 'branches.delete',
                        input: childInput(request.input, content) });
                } catch (error) {
                    const normalized = normalizeActionExecutorThrownError(error, 'deployment.teardown.execute');
                    return { ok: false, ...normalized, effectAttempted: normalized.effectAttempted ?? true } satisfies ActionExecuteFailure;
                }
            })();
            const deleted = response.ok && response.result !== null && typeof response.result === 'object'
                && !Array.isArray(response.result) && 'status' in response.result && response.result.status === 'deleted';
            const childFailure = deleted ? null : projectFailure(response.ok
                ? { ...failure('outcome_unknown'), effectAttempted: true } : response);
            const unknown = !deleted && (response.ok || isActionOutcomeUnknownErrorCodeV1(response.errorCode) || response.effectAttempted === true);
            const state = deleted ? 'succeeded' as const : unknown ? 'outcome_unknown' as const : 'failed' as const;
            const { failure: _previousFailure, ...withoutFailure } = content;
            const nextContent = childFailure ? { ...content, failure: childFailure.failure } : withoutFailure;
            try {
                const written = await host.writeTransition({ environmentId: request.input.environmentId, deploymentId: receipt.deployment.id,
                    receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state, content: nextContent, context: request.context,
                    ...(deleted && accepted ? { teardownProof: { targetLinkRevision: request.input.expectedTargetLinkRevision,
                        machines: [accepted.controller], workloadAbsent: true, retainedProviderResource: content.platform.dataCreation.retainedProviderResource, steps: [...DEPLOYMENT_TEARDOWN_STEPS_V1] } } : {}) });
                return childFailure?.result ?? (written.ok ? written : projectFailure({ ...written, errorCode: 'outcome_unknown', effectAttempted: true }).result);
            } catch (error) {
                return childFailure?.result ?? projectFailure({ ok: false,
                    ...normalizeActionExecutorThrownError(error, 'deployment.teardown.settle'), errorCode: 'outcome_unknown', effectAttempted: true }).result;
            }
        },
    };
}
