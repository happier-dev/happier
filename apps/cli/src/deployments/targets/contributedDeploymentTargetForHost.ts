import { randomUUID } from 'node:crypto';
import { DeploymentDeployInputV1Schema, DeploymentReceiptObserveInputV1Schema, DeploymentTeardownDetachInputV1Schema,
    type ActionExecutorContext } from '@happier-dev/protocol';
import type { HostReviewedChildrenPlanV1, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionApprovalRequestCreatedResultSchema, isActionOutcomeUnknownErrorCodeV1,
    type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentPlatformContentV1Schema, resolveDeploymentSourceMethodV1, type DeploymentPlatformContentV1,
    type DeploymentContentV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1,
    type DeploymentReceiptFailureV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentExecutionFailureDetailsV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { DeploymentTargetRoleCommonInputV1Schema, DeploymentTargetRoleInputSchemasV1,
    DeploymentTargetRoleResultV1Schema, type DeploymentTargetRuntimeRoleV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveRegistryConnectedAccountActionCredentialPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import type { DaemonDeploymentCandidateRequest, DaemonDeploymentCandidateResult,
    DaemonDeploymentPreparationRequest, DaemonDeploymentPreparationResult } from '../createDaemonDeploymentActionDeps';
import type { DeploymentReceiptDispatchV1 } from '../createCliDeploymentActionDeps';
import type { OwnServerDeploymentTransition, OwnServerDeploymentTargetHostInput } from './ownServer/ownServerDeploymentTarget';
import { readDeploymentSourceIntentForHost } from '../readDeploymentSourceIntentForHost';
import { readDeploymentTargetV1 } from './deploymentTargetCatalog';
import { admitDeploymentTargetRoleForHost } from './admitDeploymentTargetRoleForHost';
import { projectDeploymentException, projectDeploymentFailure as failure, projectDeploymentReceiptFailure } from '../deploymentFailure';
import { readDeploymentObservationTargetFailure } from '../readObservationForHost';
import { resolveScmHostingRefForHost, type ExecuteScmSourceReadAction } from '@/scm/hostingProviders/resolveRefForHost';
import { DeploymentLogsReadSuccessV1Schema, type DeploymentLogsReadInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { DeploymentTargetLogsResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';

type ContentReference = Pick<ReturnType<typeof DeploymentDeployInputV1Schema.parse>,
    'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;
type ScopeRequest = Readonly<{ environmentId: string; targetLinkId: string; context: ActionExecutorContext }>;
type Role = Exclude<DeploymentTargetRuntimeRoleV1, 'create' | 'inspect' | 'link'>;
type Host = Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
    resolveRequesterIdentity: import('../readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    executeSourceReadAction?: ExecuteScmSourceReadAction;
    readEnvironment(request: Readonly<{ environmentId: string; targetLinkId?: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
    readReceipt(request: Readonly<{ environmentId: string; deploymentId: string; context: ActionExecutorContext }>): Promise<DeploymentReceiptDetailV1>;
    readPreparedDeploymentContent(request: Readonly<{ input: ReturnType<typeof DeploymentDeployInputV1Schema.parse>; context: ActionExecutorContext }>):
        Promise<Readonly<{ ok: true; content: DeploymentContentV1 }> | ActionExecuteFailure>;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    createCandidate(request: Readonly<{ environment: DeploymentEnvironmentDetailV1; content: DeploymentPlatformContentV1;
        context: ActionExecutorContext; assertCurrent(): Promise<void> }>): Promise<ContentReference>;
    writeTransition(request: Omit<OwnServerDeploymentTransition, 'content'> & Readonly<{ content: DeploymentPlatformContentV1 }>):
        ReturnType<OwnServerDeploymentTargetHostInput['writeTransition']>;
}>;
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const deployRole = (method: 'gitIntegration' | 'upload'): Role => method === 'upload' ? 'uploadDeploy' : 'deploy';

function receiptFailureContent(content: DeploymentPlatformContentV1, result: ActionExecuteFailure,
    fallbackPhase: DeploymentReceiptFailureV1['phase']): DeploymentPlatformContentV1 & { failure: DeploymentReceiptFailureV1 } {
    return { ...content, failure: projectDeploymentReceiptFailure(result, fallbackPhase) };
}

function observedReceiptContent(content: DeploymentPlatformContentV1,
    observation: ReturnType<typeof DeploymentTargetRoleResultV1Schema.parse>): DeploymentPlatformContentV1 {
    const uploadProvenance = content.platform.observation.uploadProvenance ?? observation.uploadProvenance;
    const { failure: _previousFailure, ...retained } = content;
    return { ...retained, steps: observation.steps ?? content.steps,
        platform: { ...content.platform, observation: { ...observation,
            ...(uploadProvenance ? { uploadProvenance } : {}) } } };
}

/** The deployment factory consumes declared Actions; their existing executor owns placement and policy. */
export const deploymentTeardownDetachPreview = {
    summary: 'Detach this target link and keep any remote resources running. Their data and ongoing costs remain.',
};

export function createContributedDeploymentTargetForHost(host: Host) {
    async function withRole<T>(request: ScopeRequest, environment: DeploymentEnvironmentDetailV1, role: Role,
        run: (scope: Readonly<{
            common: ReturnType<typeof DeploymentTargetRoleCommonInputV1Schema.parse> & { targetLinkId: string; expectedTargetLinkRevision: number };
            action: Readonly<{ pluginId: string; localId: string }>;
            children: HostReviewedChildrenPlanV1['children'];
            credentials: StoredCredentials;
            admit(input: unknown, phase: 'preparation' | 'execution', receipt?: DeploymentReceiptDetailV1): Promise<void>;
            assertCurrent(): Promise<void>;
        }>) => Promise<T>): Promise<T> {
        if (!host.acquirePluginRuntimeRegistryLease) return refuse('unsupported_action');
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            const row = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId);
            if (!row || row.targetLink.source.kind !== 'plugin') return refuse('target_mismatch');
            const link = row.targetLink;
            const descriptor = readDeploymentTargetV1(link.source, lease.registry.contributes.deploymentTargets);
            if (!descriptor || descriptor.role !== 'runtime' || descriptor.targetKind !== link.targetKind) return refuse('deployment_target_role_unavailable');
            const readAction = (role: Role) => {
                const [group, leaf] = role.split('.');
                // The admitted runtime-role grammar owns which paths are leaves.
                type Reference = typeof descriptor.actions.deploy;
                const value = descriptor.actions[group as keyof typeof descriptor.actions];
                const reference = leaf
                    ? (value as Readonly<Record<string, Reference | undefined>> | undefined)?.[leaf]
                    : value as Reference | undefined;
                if (!reference || reference.kind !== 'plugin') return refuse('unsupported_action');
                const action = parseQualifiedPluginActionId(reference.actionId);
                if (!action) return refuse('deployment_target_role_unavailable');
                const declaration = readResolvedActionContribution(lease.registry.contributes, action);
                const executionTarget = declaration?.admittedTarget?.declaration.execution.target;
                if (executionTarget !== 'account' && executionTarget !== 'daemon') return refuse('deployment_target_role_unavailable');
                return { action, declaration, executionTarget };
            };
            const { action, declaration, executionTarget } = readAction(role);
            // A retry can observe the retained receipt instead of sending it again.
            // Both declarations come from this same selected target and registry lease.
            const children: HostReviewedChildrenPlanV1['children'] = [{ action, role },
                ...(role !== 'observe' && !role.includes('.') && descriptor.actions.observe
                    ? [{ action: readAction('observe').action, role: 'observe' }] : [])];
            const principal = row.content?.credentialPrincipal;
            const credentialRef = principal?.kind === 'team' && principal.selection.deliveryMode === 'direct'
                ? principal.selection.disclosedMember
                : principal?.kind === 'account' && principal.target.kind === 'account' ? principal.target.account : undefined;
            if (!principal || !credentialRef) return refuse('deployment_target_role_unavailable');
            const common = { ...DeploymentTargetRoleCommonInputV1Schema.parse({ v: 1, serverId: host.serverId,
                environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                credentialRef, credentialPrincipal: principal,
                providerIdentity: row.content?.providerIdentity, providerEnvironment: row.content?.providerEnvironment,
                ...(row.content?.repositoryAccess ? { repositoryAccess: row.content.repositoryAccess } : {}),
                ...(row.content?.preparedNative ? { preparedNative: row.content.preparedNative } : {}) }),
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision };
            const purposeAuthorization = resolveRegistryConnectedAccountActionCredentialPurposeAuthorization({
                registry: lease.registry.contributes, qualifiedActionId: buildQualifiedPluginContributionKey(action),
                fieldPath: 'credentialRef', requireSelect: false });
            const requester = readRequesterAccountActionContext(request.context.externalActionExecutionAuthorization);
            if (request.context.externalActionExecutionAuthorization && !requester) return refuse('action_forbidden');
            const credentials = requester?.credentials ?? host.credentials;
            const assertCurrent = () => host.assertCurrent(request.context);
            const admit = async (input: unknown, phase: 'preparation' | 'execution', receipt?: DeploymentReceiptDetailV1) => {
                await admitDeploymentTargetRoleForHost({ ...action, role, phase, input, context: request.context,
                    executionTarget, bindings: declaration?.admittedTarget?.deploymentTargetRoles ?? [],
                    purposeAuthorization }, {
                    serverId: host.serverId, machineId: host.machineId,
                    credentials, serverHttpBaseUrl: host.serverHttpBaseUrl,
                    resolveRequesterIdentity: host.resolveRequesterIdentity,
                    installationId: readInstallationIdentityIfExistsSync()?.installationId,
                    credentialOwnerAccountId: readAccountIdFromToken(credentials.token) ?? refuse('deployment_access_denied'),
                    readEnvironment: read => read.environmentId === environment.environment.id ? Promise.resolve(environment) : host.readEnvironment(read),
                    readReceipt: read => receipt && read.environmentId === receipt.deployment.environmentId
                        && read.deploymentId === receipt.deployment.id ? Promise.resolve(receipt) : host.readReceipt(read),
                    assertCurrent: async () => assertCurrent(),
                });
            };
            await assertCurrent();
            return await run({ common, action, children, credentials, admit, assertCurrent });
        } finally { await lease.release(); }
    }

    async function prepareCandidate(request: DaemonDeploymentCandidateRequest & { targetLinkId: string },
        environment: DeploymentEnvironmentDetailV1): Promise<DaemonDeploymentCandidateResult> {
        if (request.onFailure !== undefined) return failure('unsupported_action');
        const sourceMethod = resolveDeploymentSourceMethodV1({ explicit: request.sourceMethod,
            recorded: environment.targetLinks.find(row => row.targetLink.id === request.targetLinkId)?.content?.sourceMethod });
        return withRole(request, environment, deployRole(sourceMethod), async scope => {
            await scope.admit(scope.common, 'preparation');
            const assertCurrent = scope.assertCurrent;
            const source = await readDeploymentSourceIntentForHost({ request: { environment, context: request.context,
                sourceIntent: request.sourceIntent, sha: request.sha, requireWorkspace: sourceMethod === 'upload' },
                host: { ...host, credentials: scope.credentials, assertAuthority: assertCurrent,
                    resolveRepositoryRef: (repository, ref, context) => resolveScmHostingRefForHost({ repository, ref, context,
                        acquireRuntimeRegistryLease: host.acquirePluginRuntimeRegistryLease,
                        executeSourceReadAction: host.executeSourceReadAction }) } });
            const content = DeploymentPlatformContentV1Schema.parse({ sourceIntent: source.sourceIntent, sourceMethod,
                machines: [], images: [], machineResults: [], steps: [], platform: {
                    targetLinkRevision: scope.common.expectedTargetLinkRevision,
                    credentialPrincipal: scope.common.credentialPrincipal, providerIdentity: scope.common.providerIdentity,
                    providerEnvironment: scope.common.providerEnvironment,
                    ...(scope.common.repositoryAccess ? { repositoryAccess: scope.common.repositoryAccess } : {}),
                    ...(scope.common.preparedNative ? { preparedNative: scope.common.preparedNative } : {}),
                    observation: { v: 1, state: 'queued', observedAtMs: Date.now() },
                } });
            await source.assertSourceCurrent();
            const reference = await host.createCandidate({ environment, content, context: request.context, assertCurrent });
            return { ok: true, content, input: DeploymentDeployInputV1Schema.parse({ serverId: host.serverId,
                environmentId: request.environmentId, targetLinkId: request.targetLinkId,
                expectedRevision: environment.environment.revision, expectedTargetLinkRevision: scope.common.expectedTargetLinkRevision,
                requestKey: request.requestKey ?? randomUUID(), ...(request.whenBusy ? { whenBusy: request.whenBusy } : {}), ...reference }) };
        });
    }

    async function prepareAction(request: Omit<DaemonDeploymentPreparationRequest, 'input'>
        & { input: Exclude<DeploymentReceiptDispatchV1, { actionId: 'deployments.teardown' }>['input'] },
        candidate: DeploymentPlatformContentV1, environment: DeploymentEnvironmentDetailV1): Promise<DaemonDeploymentPreparationResult> {
        if ('onFailure' in request.input && request.input.onFailure !== undefined) return failure('unsupported_action');
        const role = request.actionId === 'deployments.deploy' ? deployRole(candidate.sourceMethod)
            : request.actionId === 'deployments.rollback' ? 'rollback' : 'promote';
        return withRole({ ...request.input, context: request.context }, environment, role, async scope => {
            if (candidate.platform.targetLinkRevision !== request.input.expectedTargetLinkRevision
                || !sameStrictJsonValue(candidate.platform.credentialPrincipal, scope.common.credentialPrincipal)
                || !sameStrictJsonValue(candidate.platform.providerIdentity, scope.common.providerIdentity)
                || !sameStrictJsonValue(candidate.platform.providerEnvironment, scope.common.providerEnvironment)
                || !sameStrictJsonValue(candidate.platform.repositoryAccess, scope.common.repositoryAccess)
                || !sameStrictJsonValue(candidate.platform.preparedNative, scope.common.preparedNative)) return failure('deployment_conflict');
            await scope.admit(scope.common, 'preparation');
            if (request.actionId === 'deployments.deploy') {
                const source = await readDeploymentSourceIntentForHost({ request: { environment, context: request.context,
                    sourceIntent: candidate.sourceIntent, actionId: request.actionId, requireWorkspace: candidate.sourceMethod === 'upload' },
                    host: { ...host, credentials: scope.credentials, assertAuthority: scope.assertCurrent } });
                await source.assertSourceCurrent();
            }
            const summary = [role === deployRole(candidate.sourceMethod) && candidate.sourceIntent.kind === 'repository'
                && environment.content.definition.kind === 'repository'
                ? `Deploy ${environment.content.definition.ref} at ${candidate.sourceIntent.sha.slice(0, 7)}.` : undefined,
                candidate.platform.preparedNative?.reviewNotice].filter(Boolean).join(' ');
            return { input: request.input, hostReviewedChildren: { children: scope.children }, preview: normalizeStrictJsonValue({ sourceIntent: candidate.sourceIntent,
                ...(summary ? { summary } : {}),
                sourceMethod: candidate.sourceMethod, platform: { targetLinkRevision: candidate.platform.targetLinkRevision,
                    credentialPrincipal: candidate.platform.credentialPrincipal, providerIdentity: candidate.platform.providerIdentity,
                    providerEnvironment: candidate.platform.providerEnvironment,
                    ...(candidate.platform.repositoryAccess ? { repositoryAccess: candidate.platform.repositoryAccess } : {}),
                    ...(candidate.platform.preparedNative ? { preparedNative: candidate.platform.preparedNative } : {}) },
                    controllerMachineId: environment.environment.controllerMachineId }) };
        });
    }

    async function prepareTeardownDetach(request: ScopeRequest & Pick<ReturnType<typeof DeploymentTeardownDetachInputV1Schema.parse>,
        'reason' | 'requestKey'>, environment: DeploymentEnvironmentDetailV1) {
        const row = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId);
        if (!row || row.targetLink.source.kind !== 'plugin') return null;
        if (!host.acquirePluginRuntimeRegistryLease) return refuse('deployment_target_role_unavailable');
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            const link = row.targetLink;
            const descriptor = readDeploymentTargetV1(link.source, lease.registry.contributes.deploymentTargets);
            if (!descriptor || descriptor.role !== 'runtime' || descriptor.role !== link.role || descriptor.targetKind !== link.targetKind)
                return refuse('deployment_target_role_unavailable');
            if (descriptor.actions.teardown) return null;
            await host.assertCurrent(request.context);
            return { input: DeploymentTeardownDetachInputV1Schema.parse({ serverId: host.serverId,
                environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: request.requestKey,
                reason: request.reason, detachKeepRunning: true }),
                preview: deploymentTeardownDetachPreview };
        } finally { await lease.release(); }
    }

    async function prepareTeardownChildren(request: ScopeRequest,
        environment: DeploymentEnvironmentDetailV1): Promise<HostReviewedChildrenPlanV1> {
        return withRole(request, environment, 'teardown', async scope => {
            await scope.admit(scope.common, 'preparation');
            return { children: scope.children };
        });
    }

    async function writeObservation(receipt: DeploymentReceiptDetailV1, content: DeploymentPlatformContentV1,
        observation: ReturnType<typeof DeploymentTargetRoleResultV1Schema.parse>, context: ActionExecutorContext,
        environmentRevision: number) {
        const observed = observedReceiptContent(content, observation);
        // A provider's read timestamp is liveness, not new receipt content.
        if (receipt.deployment.state === observation.state && sameStrictJsonValue(
            { ...content.platform.observation, observedAtMs: 0 }, { ...observed.platform.observation, observedAtMs: 0 })) {
            return { ok: true as const, environmentId: receipt.deployment.environmentId, revision: environmentRevision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state };
        }
        const written = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
            deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment,
            expectedRevision: receipt.deployment.revision, state: observation.state,
            content: observed, context });
        return written.ok ? written : { ...failure('outcome_unknown'), effectAttempted: true };
    }

    /** A finite observer spends the retained receipt's controller proof, never another Deploy request. */
    async function prepareObservation(request: Readonly<{
        input: ReturnType<typeof DeploymentReceiptObserveInputV1Schema.parse>; context: ActionExecutorContext;
    }>): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure> {
        try {
            if (request.input.serverId !== host.serverId) return failure('server_scope_mismatch');
            const receipt = await host.readReceipt({ environmentId: request.input.environmentId,
                deploymentId: request.input.deploymentId, context: request.context });
            const environment = await host.readEnvironment({ environmentId: request.input.environmentId,
                targetLinkId: receipt.deployment.targetLinkId, context: request.context });
            const row = environment.targetLinks.find(item => item.targetLink.id === receipt.deployment.targetLinkId);
            const targetFailure = row && readDeploymentObservationTargetFailure(row.targetLink.targetKind);
            if (targetFailure) return targetFailure;
            if (row?.targetLink.source.kind !== 'plugin') return failure('unsupported_action');
            const content = DeploymentPlatformContentV1Schema.parse(receipt.content);
            const identity = readInstallationIdentityIfExistsSync();
            const accepted = receipt.deployment.acceptedExecution;
            if (!identity || !accepted || accepted.controller.machineId !== host.machineId
                || accepted.controller.installationId !== identity.installationId
                || environment.environment.controllerMachineId !== host.machineId) return failure('machine_unavailable');
            if (receipt.deployment.state !== 'queued' && receipt.deployment.state !== 'running'
                && receipt.deployment.state !== 'outcome_unknown') {
                return { children: [], executeAdmittedAction: async () => ({ ok: true, result: {
                    ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state,
                } }) };
            }
            // A queued receipt without a provider id has not handed off its native effect yet.
            if (!content.platform.observation.providerDeploymentId) return failure('outcome_unknown');
            return await withRole<HostReviewedChildrenPreparationV1>({ environmentId: request.input.environmentId,
                targetLinkId: receipt.deployment.targetLinkId, context: request.context }, environment, 'observe', async scope => {
                const input = DeploymentTargetRoleInputSchemasV1.observe.parse({ ...scope.common,
                    deploymentId: receipt.deployment.id, expectedDeploymentRevision: receipt.deployment.revision,
                    actionOperationId: receipt.deployment.actionOperationId,
                    operation: receipt.deployment.operation,
                    providerDeploymentId: content.platform.observation.providerDeploymentId });
                await scope.admit(input, 'execution', receipt);
                return { children: [{ action: scope.action, role: 'observe', input: normalizeStrictJsonValue(input) }],
                    executeAdmittedAction: async ({ context }) => {
                        try {
                            if (!context.hostReviewedChild) return failure('unsupported_action');
                            const result = await context.hostReviewedChild.invoke({ action: scope.action, role: 'observe',
                                input: normalizeStrictJsonValue(input) });
                            if (!result.ok) return result;
                            const observation = DeploymentTargetRoleResultV1Schema.safeParse(result.result);
                            if (!observation.success || observation.data.providerDeploymentId !== content.platform.observation.providerDeploymentId)
                                return failure('outcome_unknown');
                            const written = await writeObservation(receipt, content, observation.data, context, environment.environment.revision);
                            return written.ok ? { ok: true, result: written } : written;
                        } catch (error) { return projectDeploymentException(error, { signal: context.signal }); }
                    } };
            });
        } catch (error) { return projectDeploymentException(error, { signal: request.context.signal }); }
    }

    async function execute(request: DeploymentReceiptDispatchV1) {
        let receipt: DeploymentReceiptDetailV1 | undefined;
        let providerInvocationStarted = false;
        let providerEffectObserved = false;
        let transitionAttempted = false;
        let effectContent: DeploymentPlatformContentV1 | undefined;
        let ownsReceipt = false;
        try {
            const environment = await host.readEnvironment({ environmentId: request.input.environmentId, context: request.context });
            receipt = await host.readReceipt({ environmentId: request.input.environmentId,
                deploymentId: request.receipt.deploymentId, context: request.context });
            const content = DeploymentPlatformContentV1Schema.parse(receipt.content);
            effectContent = content;
            const accepted = receipt.deployment.acceptedExecution;
            const identity = readInstallationIdentityIfExistsSync();
            if (!accepted || !identity || accepted.controller.machineId !== host.machineId
                || accepted.controller.installationId !== identity.installationId
                || receipt.deployment.actionOperationId !== request.context.operationAcceptance?.operationId
                || receipt.deployment.requestKey !== request.input.requestKey) return failure('target_mismatch');
            ownsReceipt = true;
            let deploymentSource: Pick<DeploymentPlatformContentV1, 'sourceIntent' | 'sourceMethod'> = content;
            let preparedPlatform = content.platform;
            if (request.actionId === 'deployments.deploy' && receipt.deployment.state === 'queued') {
                const candidate = await host.readPreparedDeploymentContent({ input: request.input, context: request.context });
                if (!candidate.ok) return refuse(candidate.errorCode);
                if (!candidate.content.platform || candidate.content.sourceMethod === undefined) return refuse('deployment_conflict');
                // The shared role admission compares this reviewed operand with
                // the independently opened receipt; neither side comes from the other.
                deploymentSource = { sourceIntent: candidate.content.sourceIntent, sourceMethod: candidate.content.sourceMethod };
                preparedPlatform = candidate.content.platform;
            }
            if (!request.context.hostReviewedChild) return refuse('unsupported_action');
            // A retained running/uncertain operation is observed by its exact provider id, never sent again.
            const role: Role = receipt.deployment.state !== 'queued' ? 'observe'
                : request.actionId === 'deployments.deploy' ? deployRole(deploymentSource.sourceMethod)
                    : request.actionId === 'deployments.rollback' ? 'rollback'
                        : request.actionId === 'deployments.promote' ? 'promote' : 'teardown';
            if (role === 'observe' && !content.platform.observation.providerDeploymentId) return failure('outcome_unknown');
            return await withRole({ ...request.input, context: request.context }, environment, role, async scope => {
                const previous = request.actionId === 'deployments.rollback' ? await host.readReceipt({ environmentId: request.input.environmentId,
                    deploymentId: request.input.deploymentId, context: request.context }) : request.actionId === 'deployments.promote'
                    ? await host.readReceipt({ environmentId: request.input.sourceEnvironmentId,
                        deploymentId: request.input.sourceDeploymentId, context: request.context }) : undefined;
                const priorProviderDeploymentId = previous?.content.platform?.observation.providerDeploymentId;
                if ((role === 'rollback' || role === 'promote') && (!previous || !priorProviderDeploymentId)) return failure('deployment_conflict');
                const { repositoryAccess: _currentRepositoryAccess, preparedNative: _currentPreparedNative, ...common } = scope.common;
                const input = DeploymentTargetRoleInputSchemasV1[role].parse({ ...common,
                    ...(preparedPlatform.repositoryAccess ? { repositoryAccess: preparedPlatform.repositoryAccess } : {}),
                    ...(preparedPlatform.preparedNative ? { preparedNative: preparedPlatform.preparedNative } : {}),
                    deploymentId: receipt!.deployment.id, expectedDeploymentRevision: receipt!.deployment.revision,
                    actionOperationId: receipt!.deployment.actionOperationId,
                    operation: receipt!.deployment.operation,
                    ...(content.platform.observation.providerDeploymentId ? { providerDeploymentId: content.platform.observation.providerDeploymentId } : {}),
                    ...(role === 'deploy' || role === 'uploadDeploy' ? deploymentSource : {}),
                    ...(role === 'rollback' || role === 'promote' ? { priorDeployment: { environmentId: previous!.deployment.environmentId,
                        deploymentId: previous!.deployment.id, expectedRevision: previous!.deployment.revision,
                        providerDeploymentId: priorProviderDeploymentId } } : {}),
                });
                await scope.admit(input, 'execution', receipt);
                providerInvocationStarted = true;
                const result = await request.context.hostReviewedChild!.invoke({ action: scope.action, role,
                    input: normalizeStrictJsonValue(input) });
                if (!result.ok) {
                    const unknown = isActionOutcomeUnknownErrorCodeV1(result.errorCode) || result.effectAttempted === true;
                    const failureContent = receiptFailureContent(content, result, result.effectAttempted === false
                        ? 'admission' : role === 'observe' || role === 'teardown' ? role : 'send');
                    providerEffectObserved = unknown;
                    transitionAttempted = true;
                    await host.writeTransition({ environmentId: request.input.environmentId, deploymentId: receipt!.deployment.id,
                        receiptHeader: receipt!.deployment, expectedRevision: receipt!.deployment.revision, state: unknown ? 'outcome_unknown' : 'failed', content: failureContent, context: request.context })
                        .catch(() => undefined);
                    return { ...result, details: {
                        serverId: host.serverId, environmentId: request.input.environmentId,
                        targetLinkId: receipt!.deployment.targetLinkId, deploymentId: receipt!.deployment.id,
                        failure: failureContent.failure,
                    } satisfies DeploymentExecutionFailureDetailsV1 };
                }
                const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
                if (deferred.success) return refuse('action_interactive_review_required');
                const observation = DeploymentTargetRoleResultV1Schema.safeParse(result.result);
                if (!observation.success || role === 'observe'
                    && observation.data.providerDeploymentId !== content.platform.observation.providerDeploymentId) {
                    providerEffectObserved = true;
                    transitionAttempted = true;
                    await host.writeTransition({ environmentId: request.input.environmentId, deploymentId: receipt!.deployment.id,
                        receiptHeader: receipt!.deployment, expectedRevision: receipt!.deployment.revision, state: 'outcome_unknown', content, context: request.context });
                    return failure('outcome_unknown');
                }
                providerEffectObserved = true;
                effectContent = observedReceiptContent(content, observation.data);
                transitionAttempted = true;
                return writeObservation(receipt!, content, observation.data, request.context, environment.environment.revision);
            });
        } catch (error) {
            if (providerEffectObserved) {
                const result = { ...failure('outcome_unknown', error), effectAttempted: true };
                if (!transitionAttempted && receipt && effectContent) {
                    await host.writeTransition({ environmentId: request.input.environmentId, deploymentId: receipt.deployment.id,
                        receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state: 'outcome_unknown',
                        content: receiptFailureContent(effectContent, result, 'observe'),
                        context: request.context }).catch(() => undefined);
                }
                return result;
            }
            const result = { ...projectDeploymentException(error, { signal: request.context.signal }),
                ...(!providerInvocationStarted ? { effectAttempted: false } : {}) };
            if (ownsReceipt && receipt && effectContent && !transitionAttempted) {
                await host.writeTransition({ environmentId: request.input.environmentId, deploymentId: receipt.deployment.id,
                    receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state: request.context.signal?.aborted ? 'cancelled' : 'failed',
                    content: receiptFailureContent(effectContent, result, providerInvocationStarted ? 'send' : 'admission'),
                    context: request.context }).catch(() => undefined);
            }
            return result;
        }
    }
    /** Select the target's declared reader once; own-server keeps its native reader. */
    async function prepareLogs(request: Readonly<{ input: DeploymentLogsReadInputV1; context: ActionExecutorContext }>):
        Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null> {
        try {
            const address = request.input;
            if (address.serverId !== host.serverId || address.machineId !== host.machineId) return failure('target_mismatch');
            const environment = await host.readEnvironment({ environmentId: address.environmentId, context: request.context });
            const row = environment.targetLinks.find(row => row.targetLink.id === address.targetLinkId);
            if (!row) return failure('target_mismatch');
            if (row.targetLink.source.kind !== 'plugin') return null;
            const role = address.kind === 'build' ? 'logs.build' : 'logs.runtime';
            const receipt = await host.readReceipt({ environmentId: address.environmentId, deploymentId: address.deploymentId, context: request.context });
            return await withRole<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null>({ environmentId: address.environmentId, targetLinkId: address.targetLinkId,
                context: request.context }, environment, role, async scope => {
                const input = DeploymentTargetRoleInputSchemasV1[role].parse({ ...scope.common,
                    deploymentId: receipt.deployment.id, expectedDeploymentRevision: receipt.deployment.revision,
                    actionOperationId: receipt.deployment.actionOperationId,
                    ...(receipt.content.platform?.observation.providerDeploymentId
                        ? { providerDeploymentId: receipt.content.platform.observation.providerDeploymentId } : {}),
                    ...(address.cursor ? { cursor: address.cursor } : {}),
                    ...(address.kind === 'build' ? { ...(address.ref ? { ref: address.ref } : {}),
                        ...(address.tail ? { tail: address.tail } : {}) } : address.service ? { service: address.service } : {}) });
                await scope.admit(input, 'execution', receipt);
                return { children: [{ action: scope.action, role, input: normalizeStrictJsonValue(input) }],
                    executeAdmittedAction: async ({ context }) => {
                        if (!context.hostReviewedChild) return failure('unsupported_action');
                        const result = await context.hostReviewedChild.invoke({ action: scope.action, role, input: normalizeStrictJsonValue(input) });
                        if (!result.ok) return result;
                        const logs = context.machineServiceLogsResource?.observation
                            ? { kind: 'page' as const, page: { sourceRevision: input.providerDeploymentId,
                                text: '', nextCursor: null, truncated: true } }
                            : DeploymentTargetLogsResultV1ProtocolSchema.parse(result.result);
                        return { ok: true, result: DeploymentLogsReadSuccessV1Schema.parse({ ok: true,
                            environmentId: address.environmentId, deploymentId: address.deploymentId, targetLinkId: address.targetLinkId,
                            machineId: address.machineId, installationId: address.installationId, kind: address.kind,
                            ...(address.kind === 'runtime' && address.service ? { service: address.service } : {}), logs }) };
                    } };
            });
        } catch (error) {
            const code = request.context.signal?.aborted ? 'cancelled'
                : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_failed';
            return code === 'unsupported_action' ? { ...failure(code), details: {
                requiredFact: `deploymentTarget.actions.logs.${request.input.kind}`,
                remedy: 'Choose a log kind declared by this deployment target.' } } : failure(code, error);
        }
    }
    return { withTargetRole: withRole, prepareCandidate, prepareAction, prepareTeardownDetach, prepareTeardownChildren, prepareObservation, prepareLogs, execute };
}
