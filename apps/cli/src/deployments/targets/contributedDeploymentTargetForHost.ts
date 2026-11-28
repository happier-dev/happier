import { randomUUID } from 'node:crypto';
import { canRetryDeploymentReceiptObservationOnWake } from '@happier-dev/plugins-machine-services';
import { isPluginErrorData } from '@happier-dev/protocol/plugins/errors';
import { buildDeploymentTeardownInputV1, DeploymentDeployInputV1Schema, DeploymentReceiptObserveInputV1Schema, DeploymentTeardownDetachInputV1Schema,
    type ActionExecutorContext } from '@happier-dev/protocol';
import type { HostReviewedChildrenPlanV1, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecuteFailureError, ActionApprovalRequestCreatedResultSchema, isActionOutcomeUnknownErrorCodeV1,
    type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { carryActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/resultProjection';
import { deploymentInProgressStates, isDeploymentSettledV1, DeploymentProviderTeardownContentV1Schema, type DeploymentProviderTeardownContentV1, DeploymentPlatformContentV1Schema, resolveDeploymentSourceMethodV1, type DeploymentPlatformContentV1, type DeploymentContentV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1, type DeploymentReceiptFailureV1 } from '@happier-dev/deployments/contracts/v1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_PROMOTE_ACTION_ID_V1, DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { projectDeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { DEPLOYMENT_TEARDOWN_STEPS_V1 } from '@happier-dev/protocol/deployments/deploymentTeardownContentV1';
import { readDeploymentTargetDisplayNameV1, readPlatformResourceName, selectDeploymentTargetRemovalChoicesV1 } from '@happier-dev/deployments';
import type { DeploymentTeardownRequestInputV1 } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';
import type { DeploymentExecutionFailureDetailsV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { DeploymentTargetRoleCommonInputV1Schema, DeploymentTargetRoleInputSchemasV1,
    DeploymentTargetRoleResultV1Schema, type DeploymentTargetRuntimeRoleV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { resolvePluginLocalizedStringV2Text, type PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import type { StablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
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
import { admitDeploymentTargetRoleForHost, type DeploymentTargetRoleEnvironment } from './admitDeploymentTargetRoleForHost';
import { projectDeploymentException, projectDeploymentFailure as failure, projectDeploymentReceiptFailure,
    readProviderTeardownAbsenceFailure } from '../deploymentFailure';
import { readDeploymentObservationTargetFailure } from '../readObservationForHost';
import { resolveScmHostingRefForHost, type ExecuteScmSourceReadAction } from '@/scm/hostingProviders/resolveRefForHost';
import { DeploymentLogsReadSuccessV1Schema, type DeploymentLogsReadInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { hasDeploymentReceiptContentV1, type DeploymentCancelInputV1, type DeploymentEnvironmentGetResultV1,
    type DeploymentReceiptHeaderV1, type DeploymentReceiptResultV1, type DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTargetLogsResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { configuration } from '@/configuration';
import { resolveOwnServerDeploymentIdentityForHost } from './ownServer/paths';
import { openDeploymentStageLog, readDeploymentStageLogs, type DeploymentStageLogWriter } from './stageLog';

type ContributedReceiptContent = DeploymentPlatformContentV1 | DeploymentProviderTeardownContentV1;
const readContributedReceiptContent = (content: unknown): ContributedReceiptContent => {
    const teardown = DeploymentProviderTeardownContentV1Schema.safeParse(content);
    return teardown.success ? teardown.data : DeploymentPlatformContentV1Schema.parse(content);
};

type ContentReference = Pick<ReturnType<typeof DeploymentDeployInputV1Schema.parse>,
    'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;
type ScopeRequest = Readonly<{ environmentId: string; targetLinkId: string; context: ActionExecutorContext }>;
type EnvironmentMetadata = Extract<DeploymentEnvironmentGetResultV1, { ok: true }>;
type Role = Exclude<DeploymentTargetRuntimeRoleV1, 'create' | 'inspect' | 'link'>;
type SourceScope = Readonly<{
    common: Pick<ReturnType<typeof DeploymentTargetRoleCommonInputV1Schema.parse>, 'repositoryAccess'>;
    credentials: StoredCredentials;
    gitSource?: import('@happier-dev/deployments/contracts/v1').DeploymentRuntimeTargetV1['gitSource'];
    gitProviders?: readonly string[];
    assertCurrent(): Promise<void>;
}>;
type Host = Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
    resolveRequesterIdentity: import('../readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    executeSourceReadAction?: ExecuteScmSourceReadAction;
    readEnvironment(request: Readonly<{ environmentId: string; targetLinkId?: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
    readEnvironmentMetadata(request: Pick<ScopeRequest, 'environmentId' | 'context'>): Promise<EnvironmentMetadata>;
    readTargetLink(link: DeploymentTargetLinkHeaderV1, context: ActionExecutorContext): Promise<DeploymentTargetRoleEnvironment['targetLinks'][number]>;
    readReceipt(request: Readonly<{ environmentId: string; deploymentId: string; context: ActionExecutorContext }>): Promise<DeploymentReceiptDetailV1>;
    readPreparedDeploymentContent(request: Readonly<{ input: ReturnType<typeof DeploymentDeployInputV1Schema.parse>; context: ActionExecutorContext }>):
        Promise<Readonly<{ ok: true; content: DeploymentContentV1 }> | ActionExecuteFailure>;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    createCandidate(request: Readonly<{ environment: DeploymentEnvironmentDetailV1; content: ContributedReceiptContent;
        context: ActionExecutorContext; assertCurrent(): Promise<void> }>): Promise<ContentReference>;
    writeTransition(request: Omit<OwnServerDeploymentTransition, 'content'> & Readonly<{ content: ContributedReceiptContent }>):
        ReturnType<OwnServerDeploymentTargetHostInput['writeTransition']>;
}>;
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
const deployRole = (method: 'gitIntegration' | 'upload'): Role => method === 'upload' ? 'uploadDeploy' : 'deploy';

function receiptFailureContent(content: ContributedReceiptContent, result: ActionExecuteFailure,
    fallbackPhase: DeploymentReceiptFailureV1['phase']): ContributedReceiptContent & { failure: DeploymentReceiptFailureV1 } {
    return { ...content, failure: projectDeploymentReceiptFailure(result, fallbackPhase) };
}

function observedReceiptContent(content: ContributedReceiptContent,
    observation: ReturnType<typeof DeploymentTargetRoleResultV1Schema.parse>): ContributedReceiptContent {
    const uploadProvenance = content.platform.observation.uploadProvenance ?? observation.uploadProvenance;
    const { failure: _previousFailure, ...retained } = content;
    const { failureCause, ...progress } = observation;
    const observed = { ...retained, steps: progress.steps ?? content.steps,
        platform: { ...content.platform, observation: { ...progress,
            ...(uploadProvenance ? { uploadProvenance } : {}) } } };
    return failureCause && progress.state === 'outcome_unknown'
        ? receiptFailureContent(observed, { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown',
            failureCause, effectAttempted: true }, 'observe')
        : observed;
}

function captureControllerBuildLog(content: ContributedReceiptContent, output: DeploymentStageLogWriter | undefined): ContributedReceiptContent {
    const log = output?.provenance;
    return log?.excerpt ? { ...content, platform: { ...content.platform, stageLogs: [log] } } : content;
}

/** The deployment factory consumes declared Actions; their existing executor owns placement and policy. */
export const deploymentTeardownDetachPreview = {
    summary: 'Detach this target link and keep any remote resources running. Their data and ongoing costs remain.',
};

export function createContributedDeploymentTargetForHost(host: Host) {
    function readRuntimeDescriptor(link: DeploymentTargetLinkHeaderV1, registry: PluginRuntimeRegistryLease['registry']['contributes']) {
        const descriptor = readDeploymentTargetV1(link.source, registry.deploymentTargets);
        if (!descriptor || descriptor.role !== 'runtime' || descriptor.targetKind !== link.targetKind)
            return refuse('deployment_target_role_unavailable');
        return descriptor;
    }

    function readRoleAction(descriptor: ReturnType<typeof readRuntimeDescriptor>, role: Role,
        registry: PluginRuntimeRegistryLease['registry']['contributes']) {
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
        const declaration = readResolvedActionContribution(registry, action);
        const executionTarget = declaration?.admittedTarget?.declaration.execution.target;
        if (executionTarget !== 'account' && executionTarget !== 'daemon') return refuse('deployment_target_role_unavailable');
        return { action, declaration, executionTarget };
    }

    async function prepareVariablesSyncChild(request: Pick<ScopeRequest, 'environmentId' | 'context'>):
        Promise<HostReviewedChildrenPlanV1 | null> {
        // Review can plan from the Home headers. Only the admitted bindings
        // effect may open the private runtime Link for a telemetry write.
        const environment = await host.readEnvironmentMetadata(request);
        const link = environment.targetLinks.find(item => item.id === environment.environment.runtimeTargetLinkId);
        if (link?.source.kind !== 'plugin') return null;
        if (!host.acquirePluginRuntimeRegistryLease) return refuse('unsupported_action');
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            const role = 'variables.sync';
            const registry = lease.registry.contributes;
            const descriptor = readRuntimeDescriptor(link, registry);
            return { children: [{ action: readRoleAction(descriptor, role, registry).action, role }] };
        } finally { await lease.release(); }
    }

    async function withRole<T>(request: ScopeRequest, environment: DeploymentTargetRoleEnvironment, role: Role,
        run: (scope: SourceScope & Readonly<{
            common: ReturnType<typeof DeploymentTargetRoleCommonInputV1Schema.parse> & { targetLinkId: string; expectedTargetLinkRevision: number };
            action: Readonly<{ pluginId: string; localId: string }>;
            generatedDomains: boolean;
            children: HostReviewedChildrenPlanV1['children'];
            activeDeploymentId: string | undefined;
            targetTitle: PluginLocalizedStringV2;
            pendingReceiptEvents?: StablePluginEventsBroker;
            admit(input: unknown, phase: 'preparation' | 'execution', receipt?: DeploymentReceiptDetailV1): Promise<void>;
        }>) => Promise<T>, absent?: () => T): Promise<T> {
        if (!host.acquirePluginRuntimeRegistryLease) return refuse('unsupported_action');
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            const row = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId);
            if (!row || row.targetLink.source.kind !== 'plugin') return refuse('target_mismatch');
            const link = row.targetLink;
            const registry = lease.registry.contributes;
            const descriptor = readRuntimeDescriptor(link, registry);
            if (absent && role === 'cancel' && descriptor.actions.cancel === undefined) return absent();
            const { action, declaration, executionTarget } = readRoleAction(descriptor, role, registry);
            // A retry can observe the retained receipt instead of sending it again.
            // Both declarations come from this same selected target and registry lease.
            const children: HostReviewedChildrenPlanV1['children'] = [{ action, role },
                ...(role !== 'observe' && !role.includes('.') && descriptor.actions.observe
                    ? [{ action: readRoleAction(descriptor, 'observe', registry).action, role: 'observe' }] : [])];
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
            const carrier = request.context.externalActionExecutionAuthorization;
            const requester = readRequesterAccountActionContext(carrier);
            // A dispatched root spends its requester context. An agent Session's root carries the Session host's
            // projected same-Account custody instead (projectRequesterAccountActionAuthorization), so this host's
            // own credentials serve it, as headers() does; they never serve another Account or a bare root.
            if (carrier && !requester && (!carrier.requesterAccountProjection
                || readAccountIdFromToken(host.credentials.token) !== carrier.binding.accountId)) return refuse('action_forbidden');
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
            return await run({ common, action, children, credentials, admit, assertCurrent,
                activeDeploymentId: link.activeDeploymentId, targetTitle: descriptor.title,
                generatedDomains: descriptor.generatedDomains === true,
                gitSource: descriptor.gitSource, gitProviders: descriptor.sources?.gitIntegration,
                pendingReceiptEvents: descriptor.statusIntervalMs === undefined ? undefined : lease.registry.stableEventsBroker,
            });
        } finally { await lease.release(); }
    }

    function readSource(request: Omit<Parameters<typeof readDeploymentSourceIntentForHost>[0]['request'], 'retainFolderExport'>, scope: SourceScope,
        sourceMethod: 'gitIntegration' | 'upload') {
        const gitSource = sourceMethod === 'gitIntegration' ? scope.gitSource : undefined;
        return readDeploymentSourceIntentForHost({ request: { ...request, requireWorkspace: sourceMethod === 'upload',
            ...(gitSource ? { gitRepository: { access: scope.common.repositoryAccess } } : {}),
            publishedGitProviders: gitSource?.guarantee === 'exactCommit' && gitSource.requiresPublishedCheckout
                ? scope.gitProviders ?? [] : undefined },
            host: { ...host, credentials: scope.credentials, assertAuthority: scope.assertCurrent,
                resolveRepositoryRef: (repository, ref, context) => resolveScmHostingRefForHost({ repository, ref, context,
                    acquireRuntimeRegistryLease: host.acquirePluginRuntimeRegistryLease,
                    executeSourceReadAction: host.executeSourceReadAction }) } });
    }

    async function prepareCandidate(request: DaemonDeploymentCandidateRequest & { targetLinkId: string },
        environment: DeploymentEnvironmentDetailV1): Promise<DaemonDeploymentCandidateResult> {
        if (request.onFailure !== undefined) return failure('unsupported_action');
        const sourceMethod = resolveDeploymentSourceMethodV1({ explicit: request.sourceMethod,
            recorded: environment.targetLinks.find(row => row.targetLink.id === request.targetLinkId)?.content?.sourceMethod });
        return withRole(request, environment, deployRole(sourceMethod), async scope => {
            await scope.admit(scope.common, 'preparation');
            const assertCurrent = scope.assertCurrent;
            const source = await readSource({ environment, context: request.context, sourceIntent: request.sourceIntent,
                sha: request.sha }, scope, sourceMethod);
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
        candidate: DeploymentPlatformContentV1, environment: DeploymentEnvironmentDetailV1,
        sourceAdmitted: boolean, retainedSource?: DeploymentReceiptDetailV1): Promise<DaemonDeploymentPreparationResult> {
        if ('onFailure' in request.input && request.input.onFailure !== undefined) return failure('unsupported_action');
        if (request.actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1 && 'restoreBackupId' in request.input
            && request.input.restoreBackupId !== undefined) return failure('unsupported_action');
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
            if (request.actionId === 'deployments.deploy'
                && !(candidate.sourceMethod === 'gitIntegration' && scope.gitSource && sourceAdmitted)) {
                const source = await readSource({ environment, context: request.context, sourceIntent: candidate.sourceIntent,
                    actionId: request.actionId }, scope, candidate.sourceMethod);
                await source.assertSourceCurrent();
            }
            const summary = [request.actionId === 'deployments.deploy' && candidate.sourceIntent.kind === 'repository'
                && environment.content.definition.kind === 'repository'
                ? candidate.sourceMethod === 'gitIntegration' && scope.gitSource?.guarantee === 'branchHead'
                    ? 'Deploy the latest commit on the linked branch when the deployment starts.'
                    : `Deploy ${environment.content.definition.ref} at ${candidate.sourceIntent.sha.slice(0, 7)}.`
                : undefined, candidate.platform.preparedNative?.reviewNotice].filter(Boolean).join(' ');
            const providerReview = { sourceIntent: candidate.sourceIntent,
                sourceMethod: candidate.sourceMethod, platform: { targetLinkRevision: candidate.platform.targetLinkRevision,
                    credentialPrincipal: candidate.platform.credentialPrincipal, providerIdentity: candidate.platform.providerIdentity,
                    providerEnvironment: candidate.platform.providerEnvironment,
                    ...(candidate.platform.repositoryAccess ? { repositoryAccess: candidate.platform.repositoryAccess } : {}),
                    ...(candidate.platform.preparedNative ? { preparedNative: candidate.platform.preparedNative } : {}) },
                controllerMachineId: environment.environment.controllerMachineId };
            const reviewTitle = summary ? { summary } : {};
            if (request.actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1 && 'deploymentId' in request.input) {
                const retained = retainedSource ?? await host.readReceipt({ environmentId: request.input.environmentId,
                    deploymentId: request.input.deploymentId, context: request.context });
                const serving = scope.activeDeploymentId ? await host.readReceipt({ environmentId: request.input.environmentId,
                    deploymentId: scope.activeDeploymentId, context: request.context }) : null;
                if (!retained.content.sourceIntent || (serving && !serving.content.sourceIntent)) return failure('deployment_conflict');
                const revision = projectDeploymentReviewRevisionV1(retained.content);
                const servingRevision = serving && projectDeploymentReviewRevisionV1(serving.content);
                const platformName = resolvePluginLocalizedStringV2Text(scope.targetTitle);
                const preview = normalizeStrictJsonValue(!revision || (serving && !servingRevision) ? {
                    summary: `Roll back ${environment.content.name} on ${platformName} and keep its data. The deployed source version could not be established.`,
                    providerReview,
                } : { ...reviewTitle, providerReview, platformRollback: {
                    environment: { id: environment.environment.id, name: environment.content.name },
                    revision,
                    replaces: serving && servingRevision ? { deploymentId: serving.deployment.id, revision: servingRevision } : null,
                    platformName, providerResourceId: scope.common.providerIdentity.providerResourceId,
                    providerEnvironment: scope.common.providerIdentity.providerEnvironment, data: 'keep',
                } });
                return { input: request.input, hostReviewedChildren: { children: scope.children }, preview };
            }
            if (request.actionId === DEPLOYMENT_PROMOTE_ACTION_ID_V1 && 'sourceDeploymentId' in request.input) {
                const source = retainedSource ?? await host.readReceipt({ environmentId: request.input.sourceEnvironmentId,
                    deploymentId: request.input.sourceDeploymentId, context: request.context });
                if (!source.content.sourceIntent) return failure('deployment_conflict');
                const preview = normalizeStrictJsonValue({ ...reviewTitle, providerReview, platformPromotion: {
                    environment: { id: environment.environment.id, name: environment.content.name },
                    revision: projectDeploymentReviewRevisionV1(source.content.sourceIntent, source.content.commitSubject),
                    platformName: resolvePluginLocalizedStringV2Text(scope.targetTitle), providerResourceId: scope.common.providerIdentity.providerResourceId,
                    providerEnvironment: scope.common.providerIdentity.providerEnvironment,
                } });
                return { input: request.input, hostReviewedChildren: { children: scope.children }, preview };
            }
            return { input: request.input, hostReviewedChildren: { children: scope.children },
                preview: normalizeStrictJsonValue({ ...reviewTitle, ...providerReview }) };
        });
    }

    async function prepareTeardown(request: ScopeRequest & DeploymentTeardownRequestInputV1, environment: DeploymentEnvironmentDetailV1) {
        const row = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId);
        if (!row) return null;
        const link = row.targetLink;
        const source = link.source;
        if (source.kind !== 'plugin') return null;
        if (!host.acquirePluginRuntimeRegistryLease) return refuse('deployment_target_role_unavailable');
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            const descriptor = readDeploymentTargetV1(source, lease.registry.contributes.deploymentTargets);
            if (!descriptor || descriptor.role !== 'runtime' || descriptor.role !== link.role || descriptor.targetKind !== link.targetKind)
                return refuse('deployment_target_role_unavailable');
            const choices = selectDeploymentTargetRemovalChoicesV1(source, [{
                pluginId: source.contribution.pluginId, targetId: source.contribution.localId,
                ...(descriptor.actions.teardown ? { teardown: true as const } : {}),
            }], row.content?.providerResourceOrigin);
            const removal = request.providerRemoval ?? choices.defaultChoice;
            if (!choices.choices.includes(removal)) return refuse('unsupported_action');
            if (removal === 'delete') {
                return await withRole(request, environment, 'teardown', async scope => {
                    await scope.admit(scope.common, 'preparation');
                    const platform = readDeploymentTargetDisplayNameV1(descriptor);
                    const name = readPlatformResourceName(scope.common) ?? readPlatformResourceName(row.content ?? undefined) ?? platform;
                    const content = DeploymentProviderTeardownContentV1Schema.parse({ machines: [], images: [],
                        machineResults: [], steps: [], teardown: { reason: request.reason,
                            targetLinkRevision: link.revision, machines: [], resources: [], proofs: [] },
                        platform: { targetLinkRevision: link.revision,
                            credentialPrincipal: scope.common.credentialPrincipal, providerIdentity: scope.common.providerIdentity,
                            providerEnvironment: scope.common.providerEnvironment,
                            ...(scope.common.repositoryAccess ? { repositoryAccess: scope.common.repositoryAccess } : {}),
                            ...(scope.common.preparedNative ? { preparedNative: scope.common.preparedNative } : {}),
                            observation: { v: 1, state: 'queued', observedAtMs: Date.now() } } });
                    const reference = await host.createCandidate({ environment, content, context: request.context,
                        assertCurrent: scope.assertCurrent });
                    const { providerRemoval: _providerRemoval, mode: _mode, context: _context, ...intent } = request;
                    return { input: buildDeploymentTeardownInputV1(intent, { requestKey: request.requestKey ?? randomUUID(),
                        expectedRevision: environment.environment.revision, targetLinkId: link.id,
                        expectedTargetLinkRevision: link.revision, candidate: reference }),
                        hostReviewedChildren: { children: scope.children }, preview: normalizeStrictJsonValue({
                            summary: 'Delete this linked resource at its provider.',
                            removal: { subject: { kind: 'platformResource', name, platform },
                                environment: environment.content.name, removeEnvironment: request.removeEnvironment === true },
                        }) };
                });
            }
            await host.assertCurrent(request.context);
            if (request.removeEnvironment) {
                const provider = resolvePluginLocalizedStringV2Text(descriptor.title);
                return { ...failure('unsupported_action'), effectAttempted: false,
                    details: { reason: 'environment_removal_unavailable', requiredFact: 'environmentRemoval', provider,
                        remedy: `Use Detach to stop managing this Environment in Happier. Its workload keeps running on ${provider}; stop or delete it in ${provider}.` } };
            }
            return { input: DeploymentTeardownDetachInputV1Schema.parse({ serverId: host.serverId,
                environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: request.requestKey ?? randomUUID(),
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

    async function writeObservation(receipt: DeploymentReceiptDetailV1, content: ContributedReceiptContent,
        observation: ReturnType<typeof DeploymentTargetRoleResultV1Schema.parse>, context: ActionExecutorContext,
        environmentRevision: number,
        controller: NonNullable<DeploymentReceiptDetailV1['deployment']['acceptedExecution']>['controller'],
        providerRefusal?: ActionExecuteFailure, observedTargetLinkRevision?: number) {
        const absenceFailure = receipt.deployment.operation === 'teardown' ? readProviderTeardownAbsenceFailure(observation) : null;
        if (absenceFailure) {
            await host.writeTransition({ environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id,
                receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state: 'outcome_unknown',
                content: receiptFailureContent(content, absenceFailure, 'teardown'), context });
            return absenceFailure;
        }
        const observed = providerRefusal
            ? receiptFailureContent(observedReceiptContent(content, observation), providerRefusal, 'observe')
            : observedReceiptContent(content, observation);
        // Observation records provider progress without reclaiming an unknown receipt's released effect slot.
        const state = receipt.deployment.state === 'outcome_unknown' && deploymentInProgressStates().includes(observation.state)
            ? receipt.deployment.state : observation.state;
        // A provider's read timestamp is liveness, not new receipt content.
        if (receipt.deployment.state === state && sameStrictJsonValue(
            { ...content.platform.observation, observedAtMs: 0 }, { ...observed.platform.observation, observedAtMs: 0 })
            && (!(observation.failureCause || providerRefusal) || sameStrictJsonValue(content.failure, observed.failure))) {
            return { ok: true as const, environmentId: receipt.deployment.environmentId, revision: environmentRevision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state };
        }
        const written = await host.writeTransition({ environmentId: receipt.deployment.environmentId,
            deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment,
            expectedRevision: receipt.deployment.revision, state,
            ...(receipt.deployment.operation === 'teardown' && observation.state === 'succeeded' ? { teardownProof: {
                targetLinkRevision: content.platform.targetLinkRevision,
                machines: [controller], workloadAbsent: true, retainedProviderResource: false,
                steps: [...DEPLOYMENT_TEARDOWN_STEPS_V1],
            } } : {}),
            content: observed, context,
            ...(observedTargetLinkRevision === undefined ? {} : { observedTargetLinkRevision }) });
        return written.ok ? written : { ...failure('outcome_unknown'), effectAttempted: true,
            failureCause: written.failureCause };
    }

    /** Stop claims the existing Home receipt transition before issuing the admitted provider write. */
    async function prepareCancellation(request: Readonly<{
        input: DeploymentCancelInputV1; context: ActionExecutorContext;
        readReceiptHeader(): Promise<DeploymentReceiptHeaderV1>;
        openReceipt(header: DeploymentReceiptHeaderV1): Promise<DeploymentReceiptDetailV1>;
        stop(context: ActionExecutorContext): Promise<Readonly<{ result: DeploymentReceiptResultV1 | ActionExecuteFailure; accepted: boolean }>>;
    }>): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null> {
        try {
            const { environmentId, deploymentId, expectedReceiptRevision } = request.input;
            if (request.input.serverId !== host.serverId) return failure('server_scope_mismatch');
            const metadata = await host.readEnvironmentMetadata({ environmentId, context: request.context });
            const link = metadata.targetLinks.find(item => item.id === metadata.environment.runtimeTargetLinkId);
            if (link?.source.kind !== 'plugin') return null;
            const retained = await request.readReceiptHeader();
            const identity = readInstallationIdentityIfExistsSync();
            const controller = retained.acceptedExecution?.controller;
            if (retained.operation !== 'deploy' || retained.targetLinkId !== link.id
                || retained.cancelRequestedAtMs !== undefined || !deploymentInProgressStates().includes(retained.state)
                || retained.revision !== expectedReceiptRevision || controller?.machineId !== host.machineId
                || !identity || controller.installationId !== identity.installationId
                || metadata.environment.controllerMachineId !== host.machineId
                || !hasDeploymentReceiptContentV1(retained)) return null;
            const receipt = await request.openReceipt(retained);
            const content = readContributedReceiptContent(receipt.content);
            const providerDeploymentId = content.platform.observation.providerDeploymentId;
            if (!providerDeploymentId) return null;
            const environment = await host.readEnvironment({ environmentId, targetLinkId: link.id, context: request.context });
            return await withRole<HostReviewedChildrenPreparationV1 | null>({ environmentId,
                targetLinkId: link.id, context: request.context }, environment, 'cancel', async scope => {
                // Home advances the exact revision once. Its acknowledgement selects the one caller
                // which may spend the prepared child; a replay returns the committed receipt alone.
                const input = normalizeStrictJsonValue(DeploymentTargetRoleInputSchemasV1.cancel.parse({ ...scope.common,
                    deploymentId, expectedDeploymentRevision: expectedReceiptRevision + 1,
                    actionOperationId: retained.actionOperationId, operation: retained.operation, providerDeploymentId }));
                return { children: [{ action: scope.action, role: 'cancel', input }],
                    executeAdmittedAction: async ({ context }) => {
                        const { result, accepted } = await request.stop(context);
                        if (!result.ok) return 'errorCode' in result ? result : failure(result.error);
                        if (!accepted || !('deploymentRevision' in result) || result.state !== 'outcome_unknown'
                            || result.deploymentRevision !== expectedReceiptRevision + 1) return { ok: true, result };
                        if (!context.hostReviewedChild) return failure('unsupported_action');
                        const outcome = await context.hostReviewedChild.invoke({ action: scope.action, role: 'cancel', input });
                        if (!outcome.ok) return carryActionFailureDiagnostic({ ...outcome, effectAttempted: true }, outcome);
                        const observed = DeploymentTargetRoleResultV1Schema.safeParse(outcome.result);
                        if (!observed.success || observed.data.providerDeploymentId !== providerDeploymentId)
                            return failure('provider_response_invalid');
                        if (!isDeploymentSettledV1(observed.data.state)) return { ok: true, result };
                        const written = await host.writeTransition({ environmentId, deploymentId, context,
                            receiptHeader: retained, expectedRevision: result.deploymentRevision, state: observed.data.state,
                            content: observedReceiptContent(content, observed.data),
                            observedTargetLinkRevision: scope.common.expectedTargetLinkRevision });
                        return written.ok ? { ok: true, result: written } : written;
                    } };
            }, () => null);
        } catch (error) { return projectDeploymentException(error, { signal: request.context.signal }); }
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
            const content = readContributedReceiptContent(receipt.content);
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
            if (receipt.deployment.operation !== 'teardown' && !content.platform.observation.providerDeploymentId) return failure('outcome_unknown');
            return await withRole<HostReviewedChildrenPreparationV1>({ environmentId: request.input.environmentId,
                targetLinkId: receipt.deployment.targetLinkId, context: request.context }, environment, 'observe', async scope => {
                // The provider read follows the retained Receipt. The live Link revision is a separate settlement operand.
                const input = DeploymentTargetRoleInputSchemasV1.observe.parse({ ...scope.common,
                    expectedTargetLinkRevision: content.platform.targetLinkRevision,
                    deploymentId: receipt.deployment.id, expectedDeploymentRevision: receipt.deployment.revision,
                    actionOperationId: receipt.deployment.actionOperationId,
                    operation: receipt.deployment.operation,
                    ...(content.platform.observation.providerDeploymentId
                        ? { providerDeploymentId: content.platform.observation.providerDeploymentId } : {}) });
                await scope.admit(input, 'execution', receipt);
                return { children: [{ action: scope.action, role: 'observe', input: normalizeStrictJsonValue(input) }],
                    executeAdmittedAction: async ({ context }) => {
                        try {
                            if (!context.hostReviewedChild) return failure('unsupported_action');
                            const result = await context.hostReviewedChild.invoke({ action: scope.action, role: 'observe',
                                input: normalizeStrictJsonValue(input) });
                            if (!result.ok) {
                                context.signal?.throwIfAborted();
                                const authored = isPluginErrorData(result.details) ? result.details : undefined;
                                if (receipt.deployment.operation !== 'deploy' || !deploymentInProgressStates().includes(receipt.deployment.state)
                                    || canRetryDeploymentReceiptObservationOnWake({ code: result.errorCode,
                                        details: authored && 'details' in authored ? authored.details : undefined,
                                        retryable: authored?.retryable, httpStatus: result.failureCause?.httpStatus })) return result;
                                // The provider has the deploy. A terminal status refusal ends automatic follow
                                // without asserting that the provider build itself failed.
                                const written = await writeObservation(receipt, content, {
                                    ...content.platform.observation, state: 'outcome_unknown', observedAtMs: Date.now(),
                                }, context, environment.environment.revision, accepted.controller, { ...result, effectAttempted: true });
                                return written.ok ? { ok: true, result: written } : written;
                            }
                            const observation = DeploymentTargetRoleResultV1Schema.safeParse(result.result);
                            if (!observation.success || receipt.deployment.operation !== 'teardown'
                                && observation.data.providerDeploymentId !== content.platform.observation.providerDeploymentId)
                                return failure('outcome_unknown');
                            const written = await writeObservation(receipt, content, observation.data, context, environment.environment.revision,
                                accepted.controller, undefined, receipt.deployment.operation === 'deploy'
                                    && receipt.deployment.cancelRequestedAtMs !== undefined ? scope.common.expectedTargetLinkRevision : undefined);
                            return written.ok ? { ok: true, result: written } : written;
                        } catch (error) { return projectDeploymentException(error, { signal: context.signal }); }
                    } };
            });
        } catch (error) { return projectDeploymentException(error, { signal: request.context.signal }); }
    }

    async function execute(request: DeploymentReceiptDispatchV1, observed: Readonly<{
        environment: EnvironmentMetadata['environment']; link: DeploymentTargetLinkHeaderV1; receipt?: DeploymentReceiptDetailV1;
    }>) {
        let receipt: DeploymentReceiptDetailV1 | undefined;
        let providerInvocationStarted = false;
        let providerEffectObserved = false;
        let transitionAttempted = false;
        let effectContent: ContributedReceiptContent | undefined;
        let ownsReceipt = false;
        let buildOutput: DeploymentStageLogWriter | undefined;
        try {
            const environment = { environment: observed.environment, targetLinks: [await host.readTargetLink(observed.link, request.context)] };
            receipt = observed.receipt ?? await host.readReceipt({ environmentId: request.input.environmentId,
                deploymentId: request.receipt.deploymentId, context: request.context });
            let content = readContributedReceiptContent(receipt.content);
            effectContent = content;
            const accepted = receipt.deployment.acceptedExecution;
            const identity = readInstallationIdentityIfExistsSync();
            if (!accepted || !identity || accepted.controller.machineId !== host.machineId
                || accepted.controller.installationId !== identity.installationId
                || receipt.deployment.actionOperationId !== request.context.operationAcceptance?.operationId
                || receipt.deployment.requestKey !== request.input.requestKey) return failure('target_mismatch');
            ownsReceipt = true;
            let deploymentSource = content.sourceMethod === undefined ? undefined
                : { sourceIntent: content.sourceIntent, sourceMethod: content.sourceMethod };
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
                : request.actionId === 'deployments.deploy' ? deployRole(deploymentSource?.sourceMethod ?? refuse('deployment_conflict'))
                    : request.actionId === 'deployments.rollback' ? 'rollback'
                        : request.actionId === 'deployments.promote' ? 'promote' : 'teardown';
            if (role === 'observe' && receipt.deployment.operation !== 'teardown' && !content.platform.observation.providerDeploymentId) return failure('outcome_unknown');
            return await withRole({ ...request.input, context: request.context }, environment, role, async scope => {
                const previous = request.actionId === 'deployments.rollback' ? await host.readReceipt({ environmentId: request.input.environmentId,
                    deploymentId: request.input.deploymentId, context: request.context }) : request.actionId === 'deployments.promote'
                    ? await host.readReceipt({ environmentId: request.input.sourceEnvironmentId,
                        deploymentId: request.input.sourceDeploymentId, context: request.context }) : undefined;
                const priorProviderDeploymentId = previous?.content.platform?.observation.providerDeploymentId;
                if ((role === 'rollback' || role === 'promote') && (!previous || !priorProviderDeploymentId)) return failure('deployment_conflict');
                const { repositoryAccess: _currentRepositoryAccess, preparedNative: _currentPreparedNative, ...common } = scope.common;
                const input = DeploymentTargetRoleInputSchemasV1[role].parse({ ...common,
                    ...(role === 'observe' ? { expectedTargetLinkRevision: content.platform.targetLinkRevision } : {}),
                    ...(preparedPlatform.repositoryAccess ? { repositoryAccess: preparedPlatform.repositoryAccess } : {}),
                    ...(preparedPlatform.preparedNative ? { preparedNative: preparedPlatform.preparedNative } : {}),
                    deploymentId: receipt!.deployment.id, expectedDeploymentRevision: receipt!.deployment.revision,
                    actionOperationId: receipt!.deployment.actionOperationId,
                    operation: receipt!.deployment.operation,
                    ...(role === 'teardown' ? { ownedTelemetryDestinations: environment.targetLinks
                        .find(item => item.targetLink.id === request.input.targetLinkId)?.content?.ownedTelemetryDestinations ?? [] } : {}),
                    ...(content.platform.observation.providerDeploymentId ? { providerDeploymentId: content.platform.observation.providerDeploymentId } : {}),
                    ...(role === 'deploy' || role === 'uploadDeploy' ? deploymentSource : {}),
                    ...(role === 'rollback' || role === 'promote' ? { priorDeployment: { environmentId: previous!.deployment.environmentId,
                        deploymentId: previous!.deployment.id, expectedRevision: previous!.deployment.revision,
                        providerDeploymentId: priorProviderDeploymentId } } : {}),
                });
                await scope.admit(input, 'execution', receipt);
                if (role === 'uploadDeploy') {
                    const placement = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                        serverId: host.serverId, environmentId: request.input.environmentId });
                    buildOutput = await openDeploymentStageLog({ ...placement, deploymentId: receipt!.deployment.id,
                        machineId: accepted.controller.machineId, installationId: accepted.controller.installationId });
                    await buildOutput.beginStep({ stepId: 'build' });
                }
                providerInvocationStarted = true;
                const result = await request.context.hostReviewedChild!.invoke({ action: scope.action, role,
                    input: normalizeStrictJsonValue(input), ...(buildOutput ? { invocationServices: {
                        deploymentBuildOutput: output => buildOutput!.appendRedacted(output.stream, output.data),
                    } } : {}) });
                content = captureControllerBuildLog(content, buildOutput);
                effectContent = content;
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
                if (!observation.success || role === 'observe' && receipt!.deployment.operation !== 'teardown'
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
                const written = await writeObservation(receipt!, content, observation.data, request.context,
                    environment.environment.revision, accepted.controller);
                if (request.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 && scope.pendingReceiptEvents && written.ok
                    && deploymentInProgressStates().includes(written.state)
                    && request.context.operationAcceptance?.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1) {
                    return { pendingPlatformReceipt: written, events: scope.pendingReceiptEvents };
                }
                return written;
            });
        } catch (error) {
            if (effectContent) effectContent = captureControllerBuildLog(effectContent, buildOutput);
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
        } finally {
            await buildOutput?.close();
        }
    }
    /** Select the target's declared reader once; own-server keeps its native reader. */
    async function prepareLogs(request: Readonly<{ input: DeploymentLogsReadInputV1; context: ActionExecutorContext }>,
        observedMetadata?: EnvironmentMetadata):
        Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null> {
        try {
            const address = request.input;
            if (address.serverId !== host.serverId || address.machineId !== undefined && address.machineId !== host.machineId) return failure('target_mismatch');
            const receipt = await host.readReceipt({ environmentId: address.environmentId, deploymentId: address.deploymentId, context: request.context });
            const targetLinkId = receipt.deployment.targetLinkId;
            const controller = receipt.deployment.acceptedExecution?.controller;
            if (receipt.deployment.id !== address.deploymentId || receipt.deployment.environmentId !== address.environmentId
                || address.targetLinkId !== undefined && address.targetLinkId !== targetLinkId
                || address.machineId !== undefined && address.machineId !== controller?.machineId
                || address.installationId !== undefined && address.installationId !== controller?.installationId) return failure('target_mismatch');
            const metadata = observedMetadata ?? await host.readEnvironmentMetadata({ environmentId: address.environmentId, context: request.context });
            const link = metadata.targetLinks.find(link => link.id === targetLinkId && link.environmentId === address.environmentId);
            if (!link) return failure('target_mismatch');
            if (link.source.kind !== 'plugin') return null;
            if (address.kind === 'build' && (address.machineId !== undefined || !receipt.content.platform?.observation.providerDeploymentId)
                && receipt.content.platform?.stageLogs?.some(log => (address.machineId === undefined || log.machineId === address.machineId)
                    && (address.installationId === undefined || log.installationId === address.installationId))) {
                const placement = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                    serverId: host.serverId, environmentId: address.environmentId });
                const identity = readInstallationIdentityIfExistsSync();
                if (!identity) return failure('deployment_log_unavailable');
                return { children: [], executeAdmittedAction: async ({ context }) => {
                    const logs = await readDeploymentStageLogs({ deploymentRoot: placement.deploymentRoot,
                        serverId: placement.homeServerIdentityId, machineId: host.machineId, installationId: identity.installationId },
                    receipt, { ...address, signal: context.signal, observation: context.machineServiceLogsResource?.observation,
                        expectedSourceRevision: context.machineServiceLogsResource?.sourceRevision });
                    return { ok: true, result: DeploymentLogsReadSuccessV1Schema.parse({ ok: true,
                        environmentId: address.environmentId, deploymentId: address.deploymentId, targetLinkId, kind: 'build', logs }) };
                } };
            }
            const role = address.kind === 'build' ? 'logs.build' : 'logs.runtime';
            const environment = { environment: metadata.environment, targetLinks: [await host.readTargetLink(link, request.context)] };
            return await withRole<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null>({ environmentId: address.environmentId, targetLinkId,
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
                            environmentId: address.environmentId, deploymentId: address.deploymentId, targetLinkId,
                            kind: address.kind,
                            ...(address.kind === 'runtime' && address.service ? { service: address.service,
                                machineId: address.machineId, installationId: address.installationId } : {}), logs }) };
                    } };
            });
        } catch (error) {
            const projected = projectDeploymentException(error, { signal: request.context.signal, phase: 'deployment.logs.prepare' });
            return projected.errorCode === 'unsupported_action' ? { ...projected, details: {
                requiredFact: `deploymentTarget.actions.logs.${request.input.kind}`,
                remedy: 'Choose a log kind declared by this deployment target.' } } : projected;
        }
    }
    return { withTargetRole: withRole, prepareVariablesSyncChild, prepareCandidate, prepareAction, prepareTeardown, prepareTeardownChildren, prepareCancellation, prepareObservation, prepareLogs, execute };
}
