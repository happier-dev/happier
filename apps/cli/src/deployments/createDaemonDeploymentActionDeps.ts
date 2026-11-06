import { DeploymentTargetLinksListResultV1Schema } from '@happier-dev/protocol';
import { findExistingNativeComposeTargetLinkV1 } from '@happier-dev/deployment-protocol';
import { prepareServiceAdoptionForHost } from './serviceAdoptionForHost';
import { readDeploymentSystemToolFailure } from './deploymentSystemToolFailure';
import { admitPreviewEnvironmentForHost } from './previewAdmissionForHost';
import axios from '@/api/client/credentialAxios';
import { z } from 'zod/mini';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema, DeploymentReceiptListResultV1Schema, DeploymentReceiptResultV1Schema, DeploymentTransitionInputV1Schema, computeDeploymentTransitionRequestDigestV1, signMachineInstallationProof, type ActionExecutorContext, type ActionExecutorDeps, DeploymentDeployInputV1Schema, DeploymentTeardownInputV1Schema, type DeploymentDeployInputV1, DeploymentPendingCancelInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreatePreviewV1Schema, type DeploymentEnvironmentCreateIntentInputV1, type DeploymentTransitionInputV1, type DeploymentTeardownInputV1, DeploymentChildRpcV1Schema, type DeploymentChildRpcV1, DeploymentDomainMutationResultV1Schema, isDeploymentDomainChildActionIdV1, DeploymentTemplateInstantiateInputV1Schema, deploymentOperationForRootActionV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDeploymentCandidatePublicationV1, createDeploymentDomainContentArtifactIdV1,
    isDeploymentDomainNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readDeploymentEnvironmentArtifactV1, readDeploymentTargetLinkArtifactV1, readDeploymentReceiptArtifactV1, createDeploymentReceiptArtifactHeaderV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1, type DeploymentContentV1, type DeploymentMachineResultV1, type DeploymentReceiptHeaderV1, type DeploymentSourceIntentV1, DeploymentContentV1Schema, DeploymentEnvironmentContentV1Schema, DeploymentDataTeardownContentV1Schema, DeploymentOwnServerContentV1Schema, DeploymentPlatformContentV1Schema, OwnServerDeploymentInputBasisV1Schema, getDeploymentTargetLinkLineageV1 } from '@happier-dev/deployment-protocol';
import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { createDeploymentMemberVersionProjectionV1 } from '@happier-dev/deployments';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { readExternalActionInstalledMachine, readReviewedActionOperationCancelAddress } from '@/api/externalActionExecutionAuthorization';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { ArtifactEncryptionMaterialUnavailableError, createCredentialedAccountArtifactStore, type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { isDeploymentNativeReadActionIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createOwnServerDeploymentReads } from './targets/ownServer/ownServerDeploymentReads';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createDataTeardownForHost } from './actions/dataTeardown';
import { createDeploymentTeardownExecutor, type DeploymentTeardownBoundary } from './actions/teardown';
import { readDeploymentUniformTargetLinkRevisionV1 } from './deploymentUniformProof';
import { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';
import { readStoredPromotionCandidateForHost } from './storedPromotionCandidate';
import { admitStoredComposeDefinition } from '@/workspaces/projectSetup/nativeComposeSource';
import { createPrepareDeploymentBindingsForHost } from './secrets/prepareDeploymentBindingsForHost';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createOwnServerDeploymentTargetForHost, type OwnServerDeploymentRuntime,
    type OwnServerDeploymentTransition, type OwnServerDeploymentTargetHostInput,
    type OwnServerDeploymentReview, type OwnServerDeploymentReviewRequest } from './targets/ownServer/ownServerDeploymentTarget';
import { prepareOwnServerDeploymentCandidate } from './targets/ownServer/prepareCandidate';
import { createDaemonDeploymentChildExecutor, readDeploymentChildResult as readChildResult } from './deploymentChild';
import { projectDeploymentTransitionOutcomeUnknownForHost, projectDeploymentTransitionResultForHost } from './deploymentTransitionResult';
import { createDeploymentTemplateInstantiationForHost } from './templates/instantiate';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { openDeploymentReceiptForHost, readDeploymentReceiptForHost, readOwnServerDeploymentReceiptHistoryForHost } from './readReceiptForHost';
import { readDeploymentCreationDefaultInputsForHost, prepareDeploymentCreationDefaultsForHost,
    type DeploymentCreationDefaultRequestForHost } from './readCreationDefaultsForHost';
import { createPrepareEnvironmentCreateForHost, resolveEnvironmentCreateCopyForHost } from './prepareEnvironmentCreateForHost';
import { COPY_ENVIRONMENT_BINDINGS_ROLE, createEnvironmentWithCopyForHost } from './copyEnvironmentForHost';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { preparePendingDeploymentForHost, waitForPendingDeploymentForHost, validatePendingDeploymentInputForHost } from './pendingDeploy';
import { readPendingDeploymentRecoveryOperation, readCompactPendingDeploymentRecovery } from './pendingDeploymentRecovery';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import { prepareRollbackForHost } from './prepareRollbackForHost';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createContributedDeploymentTargetForHost } from './targets/contributedDeploymentTargetForHost';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { prepareTargetLinkForHost } from './prepareTargetLinkForHost';
import { createOwnServerDomainActions, createOwnServerDomainContentWriter,
    prepareOwnServerDomainReviewedChildren } from './targets/ownServer/ownServerDomainActions';
import { createOwnServerDomainNative, createOwnServerStartFirstRoutesForHost } from './targets/ownServer/ownServerDomainNative';
import { resolveDeploymentDefinitionRoleForHost, admitUseDeploymentDefinition } from './deploymentDefinitionAdmission';
import { createDeploymentRestartActionForHost } from './actions/restart';

export type DaemonDeploymentPreparationRequest = Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentAction']>>[0];
export type DaemonDeploymentPreparationResult = Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareDeploymentAction']>>>;
export type DaemonDeploymentCandidateRequest = Readonly<{
    environmentId: string; targetLinkId?: string; context: ActionExecutorContext;
    sourceIntent?: DeploymentSourceIntentV1; sha?: string; sourceMethod?: 'gitIntegration' | 'upload';
    requestKey?: string; whenBusy?: 'refuse' | 'supersede';
}>;
export type DaemonDeploymentCandidateResult = Readonly<{ ok: true; input: DeploymentDeployInputV1; content: DeploymentContentV1 }> | ActionExecuteFailure;
const refuse = (reason: string | ActionExecuteFailure): never => {
    const code = typeof reason === 'string' ? reason : reason.errorCode;
    throw Object.assign(new RpcError(code, code), { code, ...(typeof reason === 'string' ? {} : { cause: reason }) });
};
const failure = (errorCode: string, error?: unknown): ActionExecuteFailure =>
    readDeploymentSystemToolFailure(errorCode, error)
        ?? { ok: false, errorCode, error: errorCode };
const errorCode = (error: unknown) => {
    const code = readRpcErrorCode(error) ?? (error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'deployment_content_unavailable');
    const details = error instanceof Error && 'details' in error ? error.details : undefined;
    // Project only the native owner's closed reason. Native stderr, messages
    // and arbitrary PluginError details never enter the public Action result.
    if (code === 'service_admission_unavailable' && details !== null && typeof details === 'object'
        && 'reason' in details && details.reason === 'native_runtime_form_unsupported'
        && 'form' in details && details.form === 'native_config') return 'native_runtime_configuration_failed';
    return code;
};

/** Installed controller storage composition; the target remains the sole native executor. */
export function createDaemonDeploymentActionDeps(host: Readonly<{
    credentials: StoredCredentials;
    /** Native installation authentication remains distinct from requester content custody. */
    installedCredentials?: StoredCredentials;
    /** Exact requester-owned content custody; transport remains signed by the root. */
    accountArtifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    resolveRequesterIdentity: import('./readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    readMachineVitals?: () => MachineVitalsSampleV1 | null;
    ensureServiceObservations?(): Promise<void>;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    runtime: OwnServerDeploymentRuntime;
    captureNativeSetup?: () => import('./targets/ownServer/ownServerDomainNative').DomainNativeSetupForHost;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    teardownBoundary?: DeploymentTeardownBoundary;
    /** Re-enters the incumbent executor's policy/review path, not another operation runner. */
    executePreparedPendingDeploy?(input: DeploymentDeployInputV1, context: ActionExecutorContext):
        Promise<import('@happier-dev/protocol/actions').ActionExecuteResult>;
    /** Existing installed operation owner; absence leaves ordinary cold preparation. */
    preparePendingDeploymentObservation?: HostActionOperationRuntime['preparePendingDeploymentObservation'];
    readOperation?(operationId: string, context: ActionExecutorContext): Promise<import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null>;
    runActionOperation?: ActionExecutorDeps['runActionOperation'];
}>) {
    const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
    const definitionRole = (context: ActionExecutorContext) => resolveDeploymentDefinitionRoleForHost(context, host);
    const requireDefinitionManage = async (context: ActionExecutorContext, code = 'action_forbidden') => {
        if (await definitionRole(context) !== 'manage') return refuse(code);
    };
    const atHome = <T>(run: () => T) => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, run);
    const assertHttpAuthority = async (context: ActionExecutorContext) => {
        context.signal?.throwIfAborted();
        const authorization = context.externalActionExecutionAuthorization;
        if (authorization) {
            if (!authorization.requesterHttpProjection) return refuse('action_forbidden');
        } else if (context.externalActionCredential || context.rpcSessionAuthorization) return refuse('action_forbidden');
        context.signal?.throwIfAborted();
    };
    const assertCurrent = async (context: ActionExecutorContext) => {
        await assertHttpAuthority(context);
        // Metadata transport spends the signed root; opening private content
        // additionally requires the requester's admitted content custody.
        const authorization = context.externalActionExecutionAuthorization;
        if (authorization && !authorization.requesterAccountProjection) return refuse('action_forbidden');
    };
    const headers = async (context: ActionExecutorContext, actionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>) => {
        await assertHttpAuthority(context);
        const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        if (projection) {
            // A retained child spends its admitted root, not a new sub-read
            // Action. The projection and Home still admit the exact purpose.
            const child = readRequesterAccountActionContext(context.externalActionExecutionAuthorization)?.deploymentChild;
            const signed = await projection.createRequestHeaders({ ...request, effectActionId: child?.actionId ?? actionId,
                ...(context.signal ? { signal: context.signal } : {}) });
            if (!signed) return refuse('action_forbidden');
            return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...signed };
        }
        return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${host.credentials.token}` };
    };
    const artifactAuthorization = (context: ActionExecutorContext): ArtifactRequestAuthorizationHeaders => request => headers(context,
            context.externalActionExecutionAuthorization?.binding.actionId ?? 'deployments.deploy', request);
    const candidateArtifactAuthorization = (context: ActionExecutorContext): ArtifactRequestAuthorizationHeaders => request => headers(context,
        context.externalActionExecutionAuthorization?.binding.actionId === 'deployments.templates.instantiate'
            ? 'deployments.deploy' : context.externalActionExecutionAuthorization?.binding.actionId ?? 'deployments.deploy', request);
    const publicationSources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
        admitAccount: async (serverId, context) => { await assertHttpAuthority(context); return serverId === host.serverId ? null : failure('server_scope_mismatch'); },
        resolveRequestHeaders: headers });
    const candidateIdentity = async (environmentId: string, context: ActionExecutorContext, kind: 'receipt' | 'environment' = 'receipt',
        environment?: DeploymentEnvironmentDetailV1['environment']) => {
        const binding = context.externalActionExecutionAuthorization?.binding;
        if (!binding) return {};
        const operation = deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission);
        if (operation === undefined || operation === 'teardown') return {};
        let scope = binding.deploymentCandidatePublication;
        if (binding.actionId === 'deployments.templates.instantiate') {
            const current = environment ?? (await readEnvironmentMetadata({ environmentId, context })).environment;
            // Candidate publication consumes current normal Source authority,
            // not another template provenance pin or stored result observation.
            const source = await publicationSources.projectSourcesRead!({ serverId: host.serverId, sourceId: current.projectSourceId }, context);
            if (!source.ok) return refuse('errorCode' in source ? source.errorCode : source.error);
            scope = createDeploymentCandidatePublicationV1({ accountId: binding.accountId,
                serverIdentityId: binding.serverIdentityId, actionId: binding.actionId, requestId: binding.requestId,
                requestEnvelopeDigest: binding.requestEnvelopeDigest, environmentId,
                source: { id: source.source.id, revision: source.source.revision } });
        }
        if (!scope || scope.environmentId !== environmentId) return refuse('action_forbidden');
        const artifactId = kind === 'receipt' ? scope.contentArtifactId : scope.environmentContentArtifactId;
        if (!artifactId) return refuse('action_forbidden');
        return { artifactId };
    };
    const open = async (id: string, context: ActionExecutorContext) => {
        await assertCurrent(context);
        const authorizationHeaders = artifactAuthorization(context);
        return atHome(() => artifacts.read(id, { signal: context.signal, prepareRecipients: false,
            includeSharedAudience: false, authorizationHeaders }));
    };
    const openReceipt = async (deployment: DeploymentReceiptHeaderV1, context: ActionExecutorContext): Promise<DeploymentReceiptDetailV1> => {
        return openDeploymentReceiptForHost(deployment, context, { open, assertCurrent });
    };
    const readEnvironmentMetadata = async ({ environmentId, context }: Readonly<{ environmentId: string; context: ActionExecutorContext }>) => {
        const loaded = await storage('deployments.environments.get', { serverId: host.serverId, environmentId }, context);
        if ('errorCode' in loaded) return refuse(loaded.errorCode);
        const detail = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
        if (!detail.ok) return refuse(detail.error);
        return detail;
    };
    const assertEnvironmentContentOwnerCurrent = async (request: Readonly<{ environmentId: string; context: ActionExecutorContext }>,
        owner: DeploymentEnvironmentDetailV1['environment']['owner']) => {
        await assertCurrent(request.context);
        const current = (await readEnvironmentMetadata(request)).environment;
        if (!isDeepStrictEqual(current.owner, owner)) return refuse('deployment_conflict');
    };
    const targetHostReaders = {
        async readRetentionHeaders(request: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['readRetentionHeaders']>>[0]) {
            const [environment, loaded] = await Promise.all([
                readEnvironmentMetadata(request),
                storage('deployments.receipts.get', { serverId: host.serverId,
                    deploymentId: request.deploymentId }, request.context),
            ]);
            if ('errorCode' in loaded) return refuse(loaded.errorCode);
            const receipt = DeploymentReceiptGetResultV1Schema.parse(loaded);
            if (!receipt.ok) return refuse(receipt.error);
            const link = environment.targetLinks.find(link => link.id === request.targetLinkId);
            if (!link) return refuse('target_mismatch');
            await assertCurrent(request.context);
            return { environment: environment.environment, deployment: receipt.deployment, link };
        },
        async readEnvironmentMetadata(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>) {
            return (await readEnvironmentMetadata(request)).environment;
        },
        async readEnvironment({ environmentId, targetLinkId, context }: Readonly<{ environmentId: string; targetLinkId?: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1> {
            const detail = await readDeploymentEnvironmentForHost({ environmentId, context }, {
                readMetadata: readEnvironmentMetadata, open, assertCurrent,
            });
            // Native deployment execution consumes the selected workload and its
            // retained predecessor proofs, not other private target resources.
            const selected = detail.targetLinks.find(link => link.id === (targetLinkId ?? detail.environment.runtimeTargetLinkId));
            const lineage = selected?.role === 'runtime' ? getDeploymentTargetLinkLineageV1(selected, detail.targetLinks)
                : new Set(selected ? [selected.id] : []);
            const links = await Promise.all(detail.targetLinks.filter(link => lineage.has(link.id)).map(async targetLink => {
                const content = readDeploymentTargetLinkArtifactV1(targetLink, await open(targetLink.contentArtifactId, context));
                if (!content.ok) return refuse(content.error);
                return { targetLink, content: content.content };
            }));
            await assertCurrent(context);
            return { environment: detail.environment, content: detail.content, targetLinks: links };
        },
        async readAnyReceipt(request: Parameters<OwnServerDeploymentTargetHostInput['readReceipt']>[0]): Promise<DeploymentReceiptDetailV1> {
            const { environmentId, deploymentId, nativeIncumbentSource } = request;
            let context = request.context;
            const authorization = context.externalActionExecutionAuthorization;
            const projection = authorization?.requesterHttpProjection;
            const child = readRequesterAccountActionContext(authorization)?.deploymentChild;
            if (nativeIncumbentSource && child?.kind === 'review') {
                if (!authorization || !projection) return refuse('action_forbidden');
                context = { ...context, externalActionExecutionAuthorization: { ...authorization,
                    requesterHttpProjection: { ...projection, createRequestHeaders: request => projection.createRequestHeaders({
                        ...request, nativeIncumbentSource }) } } };
            }
            return readDeploymentReceiptForHost({ environmentId, deploymentId, context }, { open, assertCurrent,
                async readMetadata(request) {
                    const loaded = await storage('deployments.receipts.get', { serverId: host.serverId,
                        environmentId: request.environmentId, deploymentId: request.deploymentId }, request.context);
                    if ('errorCode' in loaded) return refuse(loaded.errorCode);
                    const detail = DeploymentReceiptGetResultV1Schema.parse(loaded);
                    if (!detail.ok) return refuse(detail.error);
                    return detail;
                } });
        },
        async readReceipt(request: Parameters<OwnServerDeploymentTargetHostInput['readReceipt']>[0]): ReturnType<OwnServerDeploymentTargetHostInput['readReceipt']> {
            const receipt = await targetHostReaders.readAnyReceipt(request);
            return { ...receipt, content: DeploymentOwnServerContentV1Schema.parse(receipt.content) };
        },
    };
    const sendChild = async (job: DeploymentChildRpcV1, context: ActionExecutorContext): Promise<unknown> => {
        await assertCurrent(context);
        const authorization = context.externalActionExecutionAuthorization;
        const requester = readRequesterAccountActionContext(authorization);
        const identity = readInstallationIdentityIfExistsSync();
        if (!authorization || !requester || !identity || !context.originalActionEnvelope) return refuse('action_forbidden');
        return callExactMachineRpc({ credentials: requester.credentials, serverUrl: requester.serverHttpBaseUrl,
            machineId: job.machineId, method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, request: job,
            requireCurrentMachine: true, requiredMachineKind: 'persistent', timeoutMs: null, waitForResultOnCancel: true,
            externalAction: { context, effectActionId: job.actionId, installationId: identity.installationId, privateKey: identity.privateKey },
            ...(context.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
            ...(context.signal ? { signal: context.signal } : {}) });
    };
    const readBuildInstallation = async (machineId: string, context: ActionExecutorContext) => {
        if (machineId === host.machineId) {
            const identity = readInstallationIdentityIfExistsSync();
            return identity?.installationId ?? refuse('target_mismatch');
        }
        const path = `/v1/machines/${encodeURIComponent(machineId)}`;
        const installed = await readExternalActionInstalledMachine({ serverHttpBaseUrl: host.serverHttpBaseUrl, machineId,
            headers: await headers(context, context.externalActionExecutionAuthorization?.binding.actionId ?? 'deployments.deploy', { method: 'GET', path }),
            ...(context.signal ? { signal: context.signal } : {}) });
        return installed?.installationId ?? refuse('machine_unavailable');
    };
    const readReceiptHistory = (request: Readonly<{ environmentId: string; context: ActionExecutorContext }>, lineage: ReadonlySet<string>) =>
        readOwnServerDeploymentReceiptHistoryForHost({ environmentId: request.environmentId, lineage,
            async readPage(cursor) {
                const loaded = await storage('deployments.receipts.list', { serverId: host.serverId,
                    environmentId: request.environmentId, ...(cursor ? { cursor } : {}) }, request.context);
                if ('errorCode' in loaded) return refuse(loaded.errorCode);
                return loaded;
            },
            readCurrent: deploymentId => targetHostReaders.readReceipt({ ...request, deploymentId }),
            open: deployment => openReceipt(deployment, request.context),
        });
    const readMemberVersions = async (request: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['readMemberVersions']>>[0],
        environment: DeploymentEnvironmentDetailV1): Promise<readonly DeploymentMachineResultV1[]> => {
        const link = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId)?.targetLink;
        if (!link) return refuse('target_mismatch');
        const retainedLinks = environment.targetLinks.map(item => item.targetLink);
        const lineage = getDeploymentTargetLinkLineageV1(link, retainedLinks);
        const projection = createDeploymentMemberVersionProjectionV1(link, retainedLinks);
        for await (const receipt of readReceiptHistory(request, lineage)) {
            if (projection.addReceipt(receipt)) break;
        }
        const versions = projection.getVersions();
        return link.members.map(member => ({ machineId: member.machineId, installationId: member.installationId,
            steps: [], activation: 'pending', health: 'unknown',
            ...(versions[member.machineId]?.deploymentId ? { currentDeploymentId: versions[member.machineId].deploymentId! } : {}) }));
    };
    const targetHost: Omit<OwnServerDeploymentTargetHostInput, 'writeTransition'> & Readonly<{
        writeTransition(request: Omit<OwnServerDeploymentTransition, 'content'> & Readonly<{ content: DeploymentContentV1 }>):
            ReturnType<OwnServerDeploymentTargetHostInput['writeTransition']>;
    }> = { ...host, ...targetHostReaders,
        async readStartFirstRoutes(request, input) {
            return createOwnServerStartFirstRoutesForHost({ ...host, open,
                list: async (query, signal) => DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(
                    await storage('deployments.domains.list', query, { ...request.context, signal })) })(request, input);
        },
        async dispatchBuild(request, receiptHeader) {
            const builder = receiptHeader.acceptedExecution!.builder!;
            return readChildResult(await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build', actionId: request.actionId,
                input: request.input, machineId: builder.machineId, installationId: builder.installationId,
                deploymentId: request.receipt.deploymentId,
                actionOperationId: request.context.operationAcceptance?.operationId }), request.context));
        },
        async *readBuildHistory(request) {
            const environment = request.environment ?? await targetHostReaders.readEnvironment(request);
            const link = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId)?.targetLink;
            if (!link) return refuse('target_mismatch');
            const lineage = getDeploymentTargetLinkLineageV1(link, environment.targetLinks.map(item => item.targetLink));
            yield* readReceiptHistory(request, lineage);
        },
        async dispatchMember(member) {
            const { request } = member;
            const result = await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: request.actionId,
                input: request.input, machineId: member.machineId, installationId: member.installationId,
                phase: member.phase, selectedDeploymentId: member.selectedDeploymentId, deploymentId: request.receipt.deploymentId,
                actionOperationId: request.context.operationAcceptance?.operationId }), request.context);
            return readChildResult(result);
        },
        async dispatchRetention(member) {
            const { request } = member;
            return readChildResult(await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'retention', actionId: request.actionId,
                input: request.input, machineId: member.machineId, installationId: member.installationId,
                deploymentId: request.receipt.deploymentId, actionOperationId: request.context.operationAcceptance?.operationId,
                settledTargetLinkRevision: member.settledTargetLinkRevision,
                settledDeploymentRevision: member.settledDeploymentRevision, activeDeploymentId: member.activeDeploymentId }), request.context));
        },
        async reviewMember(member): Promise<OwnServerDeploymentReview> {
            if (member.machineId === host.machineId) return target.reviewMember(member);
            const result = await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: member.request.actionId,
                input: member.request.input, machineId: member.machineId, installationId: member.installationId }), member.request.context);
            if (!result || typeof result !== 'object') return refuse('invalid_action_transport_output');
            if ('errorCode' in result && typeof result.errorCode === 'string')
                return refuse(readDeploymentSystemToolFailure(result.errorCode, result) ?? result.errorCode);
            if (!('inputBasis' in result) || !('reviewedEffect' in result) || !('runtimePlatform' in result)
                || typeof result.runtimePlatform !== 'string' || !result.runtimePlatform) return refuse('invalid_action_transport_output');
            return { inputBasis: OwnServerDeploymentInputBasisV1Schema.parse(result.inputBasis),
                reviewedEffect: normalizeStrictJsonValue(result.reviewedEffect), runtimePlatform: result.runtimePlatform };
        },
        async readMemberVersions(request): Promise<readonly DeploymentMachineResultV1[]> {
            return readMemberVersions(request, await targetHostReaders.readEnvironment(request));
        },
        async writeTransition(request) {
            let issued = false;
            try {
                await assertCurrent(request.context);
                const identity = readInstallationIdentityIfExistsSync();
                const accountId = readAccountIdFromToken(host.credentials.token);
                if (!identity || !accountId) return failure('target_mismatch');
                const receipt = request.receiptHeader;
                const artifact = await open(receipt.contentArtifactId, request.context);
                if (!artifact) return failure('deployment_content_unavailable');
                const title = artifact.header.title;
                if (typeof title !== 'string') return failure('deployment_content_unavailable');
                const prepared = await atHome(() => artifacts.prepareJsonUpdate({ artifactId: artifact.artifactId,
                    expectedRevision: artifact.revision, header: createDeploymentReceiptArtifactHeaderV1(title, request.content), body: JSON.stringify(request.content),
                    signal: request.context.signal, beforeWrite: () => assertCurrent(request.context),
                    authorizationHeaders: artifactAuthorization(request.context) }));
                if (!prepared.ok) return prepared;
                const settled = ['succeeded', 'running_unverified', 'failed', 'cancelled', 'outcome_unknown'].includes(request.state);
                const environment = receipt.operation !== 'teardown' && (request.state === 'succeeded' || request.state === 'running_unverified')
                    ? await readEnvironmentMetadata(request) : null;
                const link = environment?.targetLinks.find(item => item.id === receipt.targetLinkId);
                if (environment && !link) return failure('target_mismatch');
                const expectedTargetLinkRevision = link?.source.kind === 'plugin' && request.content.platform
                    && request.content.platform.targetLinkRevision === link.revision
                    ? link.revision
                    : link?.source.kind === 'host' ? readDeploymentUniformTargetLinkRevisionV1({ deploymentId: receipt.id,
                        targetLink: link, content: DeploymentOwnServerContentV1Schema.parse(request.content) }) : undefined;
                if (link && expectedTargetLinkRevision == null) return failure('deployment_conflict');
                const body: Omit<DeploymentTransitionInputV1, 'proof'> = {
                    serverId: request.context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? host.serverId,
                    environmentId: request.environmentId, deploymentId: request.deploymentId,
                    expectedRevision: request.expectedRevision, actionOperationId: receipt.actionOperationId,
                    machineId: host.machineId, installationId: identity.installationId,
                    kind: settled ? 'settle' : 'stage', state: request.state,
                    contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
                    contentBodyVersion: artifact.revision.bodyVersion, contentUpdate: prepared.mutation,
                    ...(expectedTargetLinkRevision == null ? {} : { expectedTargetLinkRevision }),
                    ...(request.teardownProof ? { teardownProof: request.teardownProof } : {}),
                };
                const proof = signMachineInstallationProof({ payload: { version: 1, machineId: host.machineId,
                    installationId: identity.installationId, accountId,
                    deploymentTransition: { serverId: body.serverId, environmentId: body.environmentId, deploymentId: body.deploymentId,
                        actionOperationId: body.actionOperationId, expectedRevision: body.expectedRevision,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: identity.privateKey });
                const wire = DeploymentTransitionInputV1Schema.parse({ ...body, proof });
                const path = `/v1/deployments/environments/${encodeURIComponent(request.environmentId)}/deployments/${encodeURIComponent(request.deploymentId)}/transitions`;
                await atHome(() => prepared.assertCurrent());
                const admittedHeaders = await headers(request.context, receipt.operation === 'rollback'
                    ? 'deployments.rollback' : receipt.operation === 'promote' ? 'deployments.promote'
                        : receipt.operation === 'teardown' ? 'deployments.teardown'
                        : 'deployments.deploy', { method: 'POST', path, body: wire });
                issued = true;
                const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                    headers: admittedHeaders, data: wire, signal: request.context.signal, validateStatus: () => true });
                const parsed = DeploymentReceiptResultV1Schema.safeParse(response.data);
                const result = parsed.success ? projectDeploymentTransitionResultForHost(parsed.data) : null;
                if (!result) return projectDeploymentTransitionOutcomeUnknownForHost({ response });
                if (result.ok) await atHome(() => prepared.afterCommit());
                return result;
            } catch (error) { return issued ? projectDeploymentTransitionOutcomeUnknownForHost(error) : failure(errorCode(error), error); }
        },
    };
    const target = createOwnServerDeploymentTargetForHost(targetHost);
    const teardown = createDeploymentTeardownExecutor({ ...targetHost, boundary: host.teardownBoundary });
    const readPreparedDeploymentContent = async (request: Readonly<{ input: DeploymentDeployInputV1; context: ActionExecutorContext }>) => {
        try {
            if (request.input.serverId !== host.serverId) return failure('server_scope_mismatch');
            await assertCurrent(request.context);
            const opened = readDeploymentReceiptArtifactV1(request.input,
                await open(request.input.contentArtifactId, request.context));
            if (!opened.ok) return failure(opened.error);
            await assertCurrent(request.context);
            return { ok: true as const, content: opened.content };
        } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
    };
    const createReceiptCandidate = async ({ environment, content, context, assertCurrent: assertCandidateCurrent }: Readonly<{
        environment: DeploymentEnvironmentDetailV1; content: DeploymentContentV1; context: ActionExecutorContext;
        assertCurrent(): Promise<void>;
    }>) => {
            const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                owner: environment.environment.owner, async assertCurrent() {
                    await assertCandidateCurrent();
                    await assertEnvironmentContentOwnerCurrent({ environmentId: environment.environment.id, context }, environment.environment.owner);
                }, content: { prepareRecipients: true,
                    ...await candidateIdentity(environment.environment.id, context, 'receipt', environment.environment),
                    header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, content),
                    body: JSON.stringify(content), signal: context.signal, beforeWrite: assertCandidateCurrent,
                    authorizationHeaders: candidateArtifactAuthorization(context),
                } }));
            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                contentBodyVersion: created.revision.bodyVersion };
    };
    const contributedTarget = createContributedDeploymentTargetForHost({ ...host,
        readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readAnyReceipt,
        readPreparedDeploymentContent, assertCurrent, writeTransition: targetHost.writeTransition,
        createCandidate: createReceiptCandidate,
    });
    const dataTeardown = createDataTeardownForHost({ ...host, assertCurrent,
        readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readAnyReceipt,
        writeTransition: targetHost.writeTransition,
        async findReceipt(input, context) {
            let cursor: string | undefined;
            for (;;) {
                const page = DeploymentReceiptListResultV1Schema.parse(await storage('deployments.receipts.list', {
                    serverId: host.serverId, environmentId: input.environmentId, ...(cursor ? { cursor } : {}),
                }, context));
                if (!page.ok) return refuse(page.error);
                const found = page.items.find(item => item.requestKey === input.requestKey);
                if (found) {
                    if (found.targetLinkId !== input.targetLinkId) return refuse('deployment_conflict');
                    return targetHostReaders.readAnyReceipt({ environmentId: input.environmentId, deploymentId: found.id, context });
                }
                if (!page.nextCursor) return null;
                cursor = page.nextCursor;
            }
        },
        async readContent(input, context) {
            const artifact = await open(input.contentArtifactId, context);
            if (!artifact) return refuse('deployment_content_unavailable');
            const opened = readDeploymentReceiptArtifactV1({ ...input,
                contentHeaderVersion: artifact.revision.headerVersion, contentBodyVersion: artifact.revision.bodyVersion }, artifact);
            return opened.ok ? opened.content : refuse(opened.error);
        },
        createCandidate: (environment, content, context) => createReceiptCandidate({ environment, content, context,
            assertCurrent: () => assertCurrent(context) }),
    });
    const creationDefaultsHost = (context: ActionExecutorContext): Parameters<typeof prepareDeploymentCreationDefaultsForHost>[1] => ({
        ...host, accountId: readAccountIdFromToken(host.credentials.token) ?? refuse('action_forbidden'),
        expectedScopeKey: resolveAccountSettingsScopeKey(host.credentials), open, headers,
        async assertCurrent(admittedContext) {
            await assertCurrent(admittedContext);
            if (host.savedSecretOperationContext && (host.savedSecretOperationContext.credentials.token !== host.credentials.token
                || !await host.savedSecretOperationContext.isCurrent(admittedContext.signal))) return refuse('action_forbidden');
        },
        async readAccountSnapshot() {
            if (host.savedSecretOperationContext) return host.savedSecretOperationContext.readSnapshot();
            if (context.externalActionExecutionAuthorization) return refuse('account_settings_unavailable');
            return bootstrapAccountSettingsContext({ credentials: host.credentials, mode: 'blocking',
                publication: 'invocation', refresh: 'force', honorAccountSettingsModeEnv: false });
        },
    });
    const readCreationDefaultInputs = (request: DeploymentCreationDefaultRequestForHost) => atHome(() =>
        readDeploymentCreationDefaultInputsForHost(request, creationDefaultsHost(request.context)));
    type CreatePreparation = Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareDeploymentEnvironmentCreate']>>>;
    type NativeCreatePreparation = Readonly<{ input: import('@happier-dev/protocol').DeploymentEnvironmentCreateInputV1;
        preview: import('@happier-dev/protocol/json/strictJsonValue').JsonValue }> | ActionExecuteFailure | Readonly<{ existingNative: Readonly<{
        environmentId: string; revision: number; targetLinkId: string;
    }> }>;
    type CreatePreparationRequest = Readonly<{
        input: DeploymentEnvironmentCreateIntentInputV1; context: ActionExecutorContext;
        creationReview?: import('@happier-dev/protocol').DeploymentEnvironmentCreationReviewV1;
        nativeOrigin?: import('@happier-dev/deployment-protocol').DeploymentNativeComposeOriginV1;
    }>;
    function prepareEnvironmentCreate(request: CreatePreparationRequest & { nativeOrigin: import('@happier-dev/deployment-protocol').DeploymentNativeComposeOriginV1 }): Promise<NativeCreatePreparation>;
    function prepareEnvironmentCreate(request: CreatePreparationRequest & { nativeOrigin?: undefined }): Promise<CreatePreparation>;
    async function prepareEnvironmentCreate({ input, context, creationReview, nativeOrigin }: CreatePreparationRequest): Promise<CreatePreparation | NativeCreatePreparation> {
        try {
            await requireDefinitionManage(context, 'deployment_access_denied');
            if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
            if (input.definition?.from === 'catalogApp') return templates.prepareCreate(input, context, creationReview);
            const defaultsHost = atHome(() => creationDefaultsHost(context));
            const createHost = { ...host, assertCurrent: defaultsHost.assertCurrent, resolveRequestHeaders: headers };
            const copy = await resolveEnvironmentCreateCopyForHost({ input, context }, {
                ...createHost, readMetadata: readEnvironmentMetadata,
            });
            if ('errorCode' in copy) return copy;
            const authored = copy.input;
            const defaults = await atHome(() => prepareDeploymentCreationDefaultsForHost({
                projectSourceId: authored.projectSourceId, newProject: authored.newProject, actionId: 'deployments.environments.create', context,
                explicit: { ...(authored.controllerMachineId === undefined ? {} : { controllerMachineId: authored.controllerMachineId }),
                    ...(authored.buildMachineId === undefined ? {} : { buildMachineId: authored.buildMachineId }),
                    ...(authored.retainPreviousDeployments === undefined ? {} : { retainPreviousDeployments: authored.retainPreviousDeployments }) },
                target: { kind: 'ownServer', machines: authored.firstTargetLink?.machines.map(machine => machine.machineId) ?? [] },
            }, defaultsHost));
            if (nativeOrigin) {
                const existing = await findExistingNativeComposeTargetLinkV1({ machineId: host.machineId, origin: nativeOrigin }, {
                    async list(selection, cursor) {
                        const path = '/v1/deployments/targets/list';
                        const body = { serverId: host.serverId, scope: defaults.projectOwner, selection, ...(cursor ? { cursor } : {}) };
                        const response = await axios.request({ method: 'POST', url: new URL(path, host.serverHttpBaseUrl).href,
                            data: body, signal: context.signal, validateStatus: () => true,
                            headers: await artifactAuthorization(context)({ method: 'POST', path, body }) });
                        return DeploymentTargetLinksListResultV1Schema.parse(response.data);
                    },
                    artifact: targetLink => open(targetLink.contentArtifactId, context),
                });
                if (existing) return { existingNative: { environmentId: existing.environment.id,
                    revision: existing.environment.revision, targetLinkId: existing.targetLink.id } };
            }
            if (defaults.values.controllerMachineId === undefined) return failure('client_required');
            const materializeCreate = createPrepareEnvironmentCreateForHost(createHost);
            const prepared = await materializeCreate({ input: { ...authored, ...defaults.values },
                projectOwner: defaults.projectOwner, context, copy, nativeOrigin });
            if ('errorCode' in prepared) return prepared;
            return { input: prepared, preview: normalizeStrictJsonValue({ creationDefaults: {
                values: defaults.values, sources: defaults.sources }, ...(defaults.reviewBasis ? { creationDefaultsBasis: defaults.reviewBasis } : {}),
                ...(copy.review ? { copy: copy.review } : {}) }) };
        } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
    }
    const storageDeps = createCliDeploymentActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
        admitAccount: async (serverId, context) => {
            if (serverId !== host.serverId) return failure('server_scope_mismatch');
            await assertHttpAuthority(context); return null;
        },
        resolveRequestHeaders: headers,
        prepareEnvironment: createPrepareEnvironmentContentForHost({ ...host, accountArtifacts: artifacts, resolveRequestHeaders: headers }),
        prepareBindings: createPrepareDeploymentBindingsForHost(host),
        async admitTeardown(input: DeploymentTeardownInputV1, context: ActionExecutorContext) {
            if (await dataTeardown.admit(input, context)) return null;
            if (!host.teardownBoundary) return failure('unsupported_action');
            await assertCurrent(context);
            const artifact = await open(input.contentArtifactId, context);
            if (!artifact) return failure('deployment_content_unavailable');
            const initial = artifact.revision.headerVersion === input.contentHeaderVersion
                && artifact.revision.bodyVersion === input.contentBodyVersion;
            const opened = readDeploymentReceiptArtifactV1({ ...input,
                contentHeaderVersion: artifact.revision.headerVersion,
                contentBodyVersion: artifact.revision.bodyVersion }, artifact);
            if (!opened.ok) return failure(opened.error);
            const intent = opened.content.teardown;
            // A newly prepared receipt contains intent only. Native completion
            // is admitted solely by the installation-signed transition owner.
            if (initial && intent?.proofs.length) return failure('deployment_invalid');
            // A changed head is only a retry candidate. Storage must resolve the
            // original requestKey and Artifact identity; new stale references
            // cannot pass storage admission. Execution then reads its pinned ref.
            const environment = await targetHostReaders.readEnvironment({ environmentId: input.environmentId, context });
            const link = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)?.targetLink;
            if (!intent || !link || intent.reason !== input.reason || intent.targetLinkRevision !== input.expectedTargetLinkRevision
                || !isDeepStrictEqual(intent.machines.map(member => member.machineId), input.machines ?? link.machines)
                || intent.machines.some(member => !link.members.some(current => current.machineId === member.machineId
                    && current.installationId === member.installationId))) return failure('deployment_conflict');
            return null;
        },
        async dispatchReceipt(request) {
            if (request.actionId === 'deployments.teardown') {
                const receipt = await targetHostReaders.readAnyReceipt({ environmentId: request.input.environmentId,
                    deploymentId: request.receipt.deploymentId, context: request.context });
                if (DeploymentDataTeardownContentV1Schema.safeParse(receipt.content).success) return dataTeardown.execute(request, receipt);
            }
            const environment = await readEnvironmentMetadata({ environmentId: request.input.environmentId, context: request.context });
            const link = environment.targetLinks.find(item => item.id === request.input.targetLinkId);
            if (!link) return failure('target_mismatch');
            return link.source.kind === 'plugin' ? contributedTarget.execute(request)
                : request.actionId === 'deployments.teardown' ? teardown(request) : target.execute(request);
        },
    });
    const storage = storageDeps.deploymentAction!;
    const domainActions = createOwnServerDomainActions({ ...host,
        storage, headers, dispatch: sendChild, open, readEnvironment: targetHostReaders.readEnvironment, readInstallation: readBuildInstallation,
        async createContent(content, owner, context) {
            const binding = context.externalActionExecutionAuthorization?.binding;
            const native = binding?.deploymentNativeAdmission;
            if (!binding || !isDeploymentDomainNativeAdmissionV1(native) || !native.authoredMetadataDigest)
                throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
            const created = await atHome(() => createDeploymentArtifactForHost({ artifacts, owner, publication: 'create',
                assertCurrent: async () => { context.signal?.throwIfAborted(); },
                content: { artifactId: createDeploymentDomainContentArtifactIdV1({ ...binding, deploymentNativeAdmission: native }),
                    header: { kind: DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, title: content.hostname }, body: JSON.stringify(content),
                    signal: context.signal, beforeWrite: async () => { context.signal?.throwIfAborted(); },
                    authorizationHeaders: artifactAuthorization(context) } }));
            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                contentBodyVersion: created.revision.bodyVersion };
        },
        persistPreparedContent: createOwnServerDomainContentWriter({ serverId: host.serverId,
            serverHttpBaseUrl: host.serverHttpBaseUrl, artifacts, headers }) });
    const templates = createDeploymentTemplateInstantiationForHost({ ...host, storage, headers, assertCurrent,
        async deploy(input, context) {
            const prepared = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input, context });
            if ('errorCode' in prepared) return prepared;
            if ('observePendingOperation' in prepared) {
                const observed = await prepared.observePendingOperation(context);
                return observed.ok ? DeploymentReceiptResultV1Schema.parse(observed.result) : observed;
            }
            return deps.deploymentAction('deployments.deploy', prepared.input, context, undefined);
        },
        readEnvironment: targetHostReaders.readEnvironment,
        readCreationDefaultInputs,
        async createContent(content, kind, context, authority) {
            const created = await atHome(() => createDeploymentArtifactForHost({ artifacts, owner: authority.owner,
                assertCurrent: async () => { context.signal?.throwIfAborted(); }, content: { header: { kind,
                    title: kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 ? DeploymentEnvironmentContentV1Schema.parse(content).name : 'Deployment content' },
                    body: JSON.stringify(content), signal: context.signal, beforeWrite: authority.assertCurrent,
                    authorizationHeaders: artifactAuthorization(context) } }));
            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                contentBodyVersion: created.revision.bodyVersion };
        } });
    const domainNative = createOwnServerDomainNative({ ...host, open, readEnvironment: targetHostReaders.readEnvironment });
    const deploymentChild = createDaemonDeploymentChildExecutor(targetHost, { target, open, storage, assertCurrent, domainNative,
        prepareCandidate: (request): Promise<DaemonDeploymentCandidateResult> => deps.prepareDeployCandidate(request) });
    const nativeReads = createOwnServerDeploymentReads({ ...targetHost, readEnvironmentMetadata,
        readRetentionHeaders: targetHostReaders.readRetentionHeaders, assertCurrent,
        ensureServiceObservations: host.ensureServiceObservations });
    const admitPreview = async (environment: DeploymentEnvironmentDetailV1, context: ActionExecutorContext) => {
        if (environment.environment.purpose !== 'preview') return;
        const templateEnvironmentId = environment.environment.previewTemplateEnvironmentId;
        if (!templateEnvironmentId) return refuse('deployment_content_unavailable');
        await admitPreviewEnvironmentForHost({ content: environment.content, templateEnvironmentId }, {
            readTemplate: environmentId => readDeploymentEnvironmentForHost({ environmentId, context }, {
                readMetadata: readEnvironmentMetadata, open, assertCurrent,
            }),
        });
    };
    const readCompactPending = (input: import('@happier-dev/protocol').DeploymentDeployIntentInputV1,
        context: ActionExecutorContext) => readCompactPendingDeploymentRecovery({ input, context,
        scope: { accountId: context.externalActionExecutionAuthorization?.binding.accountId ?? '', machineId: host.machineId },
        custody: { serverId: host.serverId, installationId: readInstallationIdentityIfExistsSync()?.installationId ?? '' },
        read: () => readEnvironmentMetadata({ environmentId: input.environmentId, context }),
        readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
            prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
        assertCurrent: () => assertCurrent(context),
    });
    const admitCandidateRequest = async (request: DaemonDeploymentCandidateRequest): Promise<void> => {
        // The child owner already admitted this controller-selected definition.
        if (readRequesterAccountActionContext(request.context.externalActionExecutionAuthorization)?.deploymentChild?.kind === 'prepare') return;
        const role = await definitionRole(request.context);
        if (role === 'use' && (request.sourceIntent !== undefined || request.sha !== undefined
            || request.sourceMethod !== undefined)) return refuse('action_forbidden');
    };
    const prepareAdmittedDeployCandidate = async (originalRequest: DaemonDeploymentCandidateRequest,
        observedEnvironment?: DeploymentEnvironmentDetailV1): Promise<DaemonDeploymentCandidateResult> => {
        try {
            const sourceIntent = originalRequest.sourceIntent ? structuredClone(originalRequest.sourceIntent) : undefined;
            await assertCurrent(originalRequest.context);
            const environment = observedEnvironment ?? await targetHostReaders.readEnvironment(originalRequest);
            // A dispatched preparation child consumes its controller's admission.
            if (readRequesterAccountActionContext(originalRequest.context.externalActionExecutionAuthorization)?.deploymentChild?.kind !== 'prepare')
                await admitPreview(environment, originalRequest.context);
            const targetLinkId = originalRequest.targetLinkId ?? environment.environment.runtimeTargetLinkId;
            if (!targetLinkId) return failure('target_mismatch');
            const request = { ...originalRequest, targetLinkId };
            const selectedLink = environment.targetLinks.find(item => item.targetLink.id === targetLinkId)?.targetLink;
            if (!selectedLink) return failure('target_mismatch');
            if (selectedLink.source.kind === 'plugin') return await contributedTarget.prepareCandidate(request, environment);
            if (request.sourceMethod !== undefined) return failure('unsupported_action');
            const machineResults = await readMemberVersions(request, environment);
            const builder = environment.environment.buildMachineId;
            if (!builder) return failure('target_mismatch');
            const link = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId)?.targetLink;
            if (!link) return failure('target_mismatch');
            const assertCandidateCurrent = () => assertCurrent(request.context);
            if (builder !== host.machineId) {
                const response = await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare',
                    actionId: 'deployments.deploy', input: { serverId: host.serverId, environmentId: request.environmentId,
                        targetLinkId: request.targetLinkId,
                        ...(sourceIntent ? { sourceIntent } : {}), ...(request.sha ? { sha: request.sha } : {}),
                        ...(request.requestKey ? { requestKey: request.requestKey } : {}),
                        ...(request.whenBusy ? { whenBusy: request.whenBusy } : {}) }, machineId: builder,
                    installationId: await readBuildInstallation(builder, request.context), expectedRevision: environment.environment.revision,
                    expectedTargetLinkRevision: link.revision }), request.context);
                if (response && typeof response === 'object' && 'errorCode' in response && typeof response.errorCode === 'string') return failure(response.errorCode);
                const candidate = z.strictObject({ ok: z.literal(true), input: DeploymentDeployInputV1Schema,
                    content: DeploymentContentV1Schema }).parse(response);
                await assertCandidateCurrent();
                if (candidate.input.serverId !== host.serverId || candidate.input.environmentId !== request.environmentId
                    || candidate.input.targetLinkId !== link.id || candidate.input.expectedRevision !== environment.environment.revision
                    || candidate.input.expectedTargetLinkRevision !== link.revision || candidate.content.buildMachineId !== builder
                    || !isDeepStrictEqual(candidate.content.machines, link.machines)
                    || !isDeepStrictEqual(candidate.content.machineResults, machineResults)) return failure('target_mismatch');
                if (sourceIntent && !isDeepStrictEqual(candidate.content.sourceIntent, sourceIntent)
                    || request.sha && (candidate.content.sourceIntent?.kind !== 'repository' || candidate.content.sourceIntent.sha !== request.sha)
                    || request.requestKey && candidate.input.requestKey !== request.requestKey
                    || (candidate.input.whenBusy ?? 'refuse') !== (request.whenBusy ?? 'refuse')) return failure('target_mismatch');
                const opened = readDeploymentReceiptArtifactV1(candidate.input, await open(candidate.input.contentArtifactId, request.context));
                if (!opened.ok) return failure(opened.error);
                if (!isDeepStrictEqual(opened.content, candidate.content)) return failure('target_mismatch');
                return candidate;
            }
            const staging: { artifact?: Awaited<ReturnType<typeof artifacts.create>> } = {};
            const content = await prepareOwnServerDeploymentCandidate({ ...request, sourceIntent, environment, runtime: host.runtime,
                machineId: host.machineId, machineResults, readReferenceEnvironment: targetHostReaders.readEnvironment,
                async stageContent(sourceIntent) {
                    const initial = DeploymentContentV1Schema.parse({ sourceIntent, machines: link.machines,
                        buildMachineId: builder, ...(environment.environment.ingress ? { ingress: environment.environment.ingress } : {}),
                        onFailure: 'rollbackAll', images: [], machineResults, steps: [] });
                    const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                        owner: environment.environment.owner,
                        assertCurrent: assertCandidateCurrent, content: { prepareRecipients: true,
                        ...await candidateIdentity(request.environmentId, request.context, 'receipt', environment.environment),
                        header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, initial),
                        body: JSON.stringify(initial), signal: request.context.signal,
                        beforeWrite: assertCandidateCurrent, authorizationHeaders: candidateArtifactAuthorization(request.context),
                    } }));
                    staging.artifact = created;
                    return created.artifactId;
                } });
            await assertCandidateCurrent();
            const staged = staging.artifact;
            if (!staged) return failure('deployment_content_unavailable');
            const updated = await atHome(() => artifacts.update({ artifactId: staged.artifactId, expectedRevision: staged.revision,
                header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, content), body: JSON.stringify(content),
                signal: request.context.signal, beforeWrite: assertCandidateCurrent,
                authorizationHeaders: candidateArtifactAuthorization(request.context) }));
            if (!updated.ok) return failure(updated.errorCode);
            return { ok: true, content, input: DeploymentDeployInputV1Schema.parse({ serverId: host.serverId,
                environmentId: request.environmentId, targetLinkId: request.targetLinkId,
                expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                requestKey: request.requestKey ?? randomUUID(), ...(request.whenBusy ? { whenBusy: request.whenBusy } : {}),
                contentArtifactId: staged.artifactId,
                contentHeaderVersion: updated.revision.headerVersion, contentBodyVersion: updated.revision.bodyVersion }) };
        } catch (error) { return failure(errorCode(error), error); }
    };
    const deps = {
        deploymentChild,
        prepareDeploymentTeardown: dataTeardown.prepare,
        async prepareHostReviewedChildren(request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0]) {
            if (request.actionId === 'machines.services.adopt') return prepareServiceAdoptionForHost(request, {
                ...host, prepareCreate: prepareEnvironmentCreate,
                readInstallation: context => readBuildInstallation(host.machineId, context),
                readEnvironment: request => readDeploymentEnvironmentForHost(request, {
                    readMetadata: readEnvironmentMetadata, open, assertCurrent,
                }),
            });
            if (request.actionId === 'deployments.publish') {
                const publish = DeploymentActionInputSchemasV1['deployments.publish'].safeParse(request.input);
                return publish.success ? { children: [{ action: 'deployments.deploy' as const, role: 'publish.deploy',
                    input: normalizeStrictJsonValue(publish.data.preparedChildren.deploy) }] } : failure('invalid_parameters');
            }
            if (request.actionId === 'deployments.domains.add' || request.actionId === 'deployments.domains.remove') {
                try { return await prepareOwnServerDomainReviewedChildren(request, { storage, open }); }
                catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (request.actionId === 'deployments.templates.instantiate') {
                const template = DeploymentTemplateInstantiateInputV1Schema.safeParse(request.input);
                return template.success && template.data.mode === 'apply' && template.data.deploy ? { children: [{
                    action: 'deployments.deploy' as const, role: 'template.deploy',
                }] } : null;
            }
            if (request.actionId === 'deployments.environments.create') {
                const copy = DeploymentEnvironmentCreateInputV1Schema.safeParse(request.input);
                return copy.success && copy.data.copyPlan?.bindings.length ? { children: [{
                    action: 'deployments.bindings.set' as const, role: COPY_ENVIRONMENT_BINDINGS_ROLE,
                }] } : null;
            }
            if (request.actionId !== 'deployments.teardown') return null;
            try {
                const input = DeploymentTeardownInputV1Schema.parse(request.input);
                if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
                const environment = await targetHostReaders.readEnvironment({ environmentId: input.environmentId, targetLinkId: input.targetLinkId, context: request.context });
                const link = environment.targetLinks.find(row => row.targetLink.id === input.targetLinkId)?.targetLink;
                if (!link) return failure('target_mismatch');
                // Data cleanup already declared its exact retained child during teardown preparation.
                if (link.role === 'data') return null;
                return link.source.kind === 'plugin'
                    ? await contributedTarget.prepareTeardownChildren({ environmentId: input.environmentId,
                        targetLinkId: input.targetLinkId, context: request.context }, environment) : null;
            } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        },
        deploymentAction: (async (actionId, input, context, creationReview = undefined) => {
            if (actionId === 'deployments.restart') {
                const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                if (!parsed.success) return failure('invalid_parameters');
                return createDeploymentRestartActionForHost({ ...host, assertCurrent })(parsed.data, context);
            }
            if (actionId === 'deployments.environments.update' || (actionId === 'deployments.environments.create'
                && ('contentArtifactId' in input || !('mode' in input) || input.mode !== 'preview'))) {
                try { await requireDefinitionManage(context,
                    actionId === 'deployments.environments.create' ? 'deployment_access_denied' : 'action_forbidden'); }
                catch (error) { return failure(errorCode(error), error); }
            }
            if (actionId === 'deployments.health.current') {
                const selected = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                if (!selected.success) return failure('invalid_parameters');
                const request = selected.data;
                let lease: ReturnType<typeof tryAcquireAuthoritativePluginRuntimeRegistryLease> = null;
                try {
                    await assertCurrent(context);
                    if (request.serverId !== host.serverId || request.machineId !== host.machineId) return failure('target_mismatch');
                    const detail = await readEnvironmentMetadata({ environmentId: request.environmentId, context });
                    const environment = detail.environment;
                    if (!environment.capabilities.read) return failure('action_forbidden');
                    const link = detail.targetLinks.find(item => item.id === request.targetLinkId);
                    if (!link || link.targetKind !== 'ownServer' || environment.runtimeTargetLinkId !== link.id
                        || environment.controllerMachineId !== request.machineId) return failure('target_mismatch');
                    lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                    const current = lease?.registry.currentDomainEdgeObservation;
                    const proof = current?.readProof(environment.id, link.id);
                    let observation = proof?.observation ?? null;
                    if (proof && (environment.ingress?.kind !== 'edgeCaddy'
                        || proof.observation.machineId !== environment.ingress.edgeMachineId
                        || proof.observation.targetLinkRevision !== link.revision)) observation = null;
                    if (proof && observation) {
                        const loaded = await storage('deployments.domains.get', { serverId: host.serverId,
                            environmentId: environment.id, domainId: proof.domainId }, context);
                        if ('errorCode' in loaded) { current?.withdrawDomain(environment.id, proof.domainId); return loaded; }
                        const domain = DeploymentDomainMutationResultV1Schema.parse(loaded);
                        if (!domain.ok) {
                            if (domain.error !== 'deployment_unavailable') {
                                current?.withdrawDomain(environment.id, proof.domainId);
                                return failure(domain.error);
                            }
                            observation = null;
                        } else if (domain.domain.id !== proof.domainId || domain.domain.environmentId !== environment.id
                            || domain.domain.targetLinkId !== link.id || domain.domain.revision !== proof.domainRevision
                            || domain.domain.deletedAtMs !== undefined) observation = null;
                    }
                    if (!observation && proof) current?.withdrawDomain(environment.id, proof.domainId);
                    await assertCurrent(context);
                    return DeploymentActionOutputSchemasV1[actionId].parse({ ok: true,
                        environmentId: environment.id, targetLinkId: link.id, observation });
                } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
                finally { await lease?.release(); }
            }
            if (isDeploymentDomainChildActionIdV1(actionId)) {
                const result = await domainActions(actionId, input, context);
                if ('ok' in result && result.ok && 'environmentId' in result && 'domain' in result) {
                    const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                    try { lease?.registry.currentDomainEdgeObservation?.withdrawDomain(result.environmentId, result.domain.id); }
                    finally { await lease?.release(); }
                }
                return result;
            }
            if (actionId === 'deployments.targets.link' && !('contentArtifactId' in input)) {
                try {
                    const intent = DeploymentActionInputSchemasV1[actionId].parse(input);
                    const prepared = await prepareTargetLinkForHost({ input: intent, context }, {
                        serverHttpBaseUrl: host.serverHttpBaseUrl, artifacts,
                        readMetadata: readEnvironmentMetadata, assertCurrent, artifactAuthorization,
                    });
                    return 'contentArtifactId' in prepared ? await storage(actionId, prepared, context) : prepared;
                } catch (error) {
                    return failure(context.signal?.aborted ? 'cancelled'
                        : error instanceof ArtifactEncryptionMaterialUnavailableError ? 'client_required' : errorCode(error));
                }
            }
            if (actionId === 'deployments.environments.create' && !('contentArtifactId' in input)) {
                const intent = DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input);
                if (!intent.success) return failure('client_required');
                if (intent.data.mode !== 'preview') return intent.data.definition?.from === 'catalogApp'
                    ? templates.instantiateCreate(intent.data, context, creationReview) : failure('client_required');
                const prepared = await prepareEnvironmentCreate({ input: intent.data, context });
                return 'errorCode' in prepared ? prepared : DeploymentEnvironmentCreatePreviewV1Schema.parse({
                    kind: 'preview', input: prepared.input, review: prepared.preview });
            }
            if (actionId === 'deployments.environments.create') {
                const prepared = DeploymentEnvironmentCreateInputV1Schema.safeParse(input);
                if (!prepared.success) return failure('client_required');
                if (prepared.data.copyFrom) return createEnvironmentWithCopyForHost({ input: prepared.data, context, creationReview }, {
                    create: storage,
                    readEnvironment: request => readDeploymentEnvironmentForHost(request, {
                        readMetadata: readEnvironmentMetadata, open, assertCurrent,
                    }),
                });
            }
            if (actionId === 'deployments.publish.prepare') return templates.preparePublishEntry(DeploymentActionInputSchemasV1[actionId].parse(input), context);
            if (isDeploymentNativeReadActionIdV1(actionId)) return nativeReads(actionId, input, context);
            if (actionId !== 'deployments.deploy') return storage(actionId, input, context, creationReview);
            const parsed = DeploymentDeployInputV1Schema.safeParse(input);
            if (!parsed.success || parsed.data.whenBusy !== 'supersede') return storage(actionId, input, context);
            try {
                if (parsed.data.serverId !== host.serverId) return failure('server_scope_mismatch');
                const prepared = await preparePendingDeploymentForHost({ input: parsed.data, context }, {
                    readEnvironment: () => readEnvironmentMetadata({ environmentId: parsed.data.environmentId, context }),
                    readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
                        prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
                    open: artifactId => open(artifactId, context), assertCurrent: () => assertCurrent(context),
                });
                const result = await storage(actionId, prepared.input, context);
                if ('errorCode' in result || !('ok' in result) || !result.ok || !('kind' in result) || result.kind !== 'pending') return result;
                if (result.environmentId !== prepared.input.environmentId
                    || result.actionOperationId !== prepared.intent.actionOperationId) return failure('deployment_conflict');
                return await waitForPendingDeploymentForHost({ ...prepared, result, context }, {
                    credentials: host.credentials, serverHttpBaseUrl: host.serverHttpBaseUrl,
                    readEnvironment: () => readEnvironmentMetadata({ environmentId: prepared.input.environmentId, context }),
                    readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
                        prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
                    readReceipts: () => storage('deployments.receipts.list', { serverId: prepared.input.serverId,
                        environmentId: prepared.input.environmentId, inProgressOnly: true }, context),
                    assertCurrent: () => assertCurrent(context),
                    async cancel(fresh) {
                        await fresh.assertCurrent();
                        const authorization = fresh.callerInputAuthorization;
                        // Never substitute the accepted Deploy root or the
                        // machine custodian's bearer for this fresh requester.
                        if (!authorization?.requesterAccountProjection || !authorization.requesterHttpProjection) return refuse('action_forbidden');
                        const address = await readReviewedActionOperationCancelAddress({ authorization,
                            envelope: fresh.originalActionEnvelope, signal: fresh.signal });
                        if (!address || address.operationId !== prepared.intent.actionOperationId
                            || address.machineId !== host.machineId
                            || !await isServerProfileHomeIdentity(host.serverId, authorization.binding.serverIdentityId)) return refuse('action_forbidden');
                        const currentContext = buildActionExecutorContextForRpc({ ...fresh,
                            actionId: 'action.operations.cancel', serverId: host.serverId,
                            runtimeAccountId: authorization.binding.accountId,
                            externalActionTarget: authorization.binding.target });
                        const serverId = authorization.binding.serverIdentityId;
                        const environmentId = prepared.input.environmentId;
                        const readPath = `/v1/deployments/environments/${encodeURIComponent(environmentId)}?serverId=${encodeURIComponent(serverId)}`;
                        await fresh.assertCurrent();
                        const readHeaders = await headers(currentContext, 'action.operations.cancel', { method: 'GET', path: readPath });
                        const read = await axios.request<unknown>({ method: 'GET', url: `${host.serverHttpBaseUrl}${readPath}`,
                            headers: readHeaders, signal: fresh.signal, validateStatus: () => true });
                        await fresh.assertCurrent();
                        await assertCurrent(currentContext);
                        const metadata = DeploymentEnvironmentGetResultV1Schema.parse(read.data);
                        if (!metadata.ok) return refuse(metadata.error);
                        if (read.status < 200 || read.status >= 300 || metadata.environment.id !== environmentId) return refuse('invalid_action_output');
                        if (!metadata.environment.capabilities.deploy) return refuse('deployment_access_denied');
                        if (!metadata.pendingDeploy) return;
                        if (!isDeepStrictEqual(metadata.pendingDeploy, prepared.input.pendingDeploy)) return refuse('deployment_conflict');
                        const body = DeploymentPendingCancelInputV1Schema.parse({ serverId, environmentId,
                            expectedRevision: metadata.environment.revision, actionOperationId: prepared.intent.actionOperationId,
                            pendingDeploy: prepared.input.pendingDeploy });
                        const path = `/v1/deployments/environments/${encodeURIComponent(environmentId)}/pending/cancel`;
                        await fresh.assertCurrent();
                        const requestHeaders = await headers(currentContext, 'action.operations.cancel', { method: 'POST', path, body });
                        const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                            headers: requestHeaders, data: body, signal: fresh.signal, validateStatus: () => true });
                        await fresh.assertCurrent();
                        await assertCurrent(currentContext);
                        const cleared = DeploymentEnvironmentCreateResultV1Schema.parse(response.data);
                        if (!cleared.ok) return refuse(cleared.error);
                        if (response.status < 200 || response.status >= 300 || cleared.environmentId !== environmentId
                            || cleared.revision !== metadata.environment.revision + 1) return refuse('invalid_action_output');
                    },
                    async resume(): Promise<ReturnType<typeof DeploymentReceiptResultV1Schema.parse> | ActionExecuteFailure> {
                        if (!host.executePreparedPendingDeploy) return failure('unsupported_action');
                        await definitionRole(context);
                        const fresh = await prepareAdmittedDeployCandidate({ environmentId: prepared.input.environmentId,
                            targetLinkId: prepared.input.targetLinkId, sourceIntent: prepared.intent.sourceIntent,
                            ...(prepared.intent.sourceMethod ? { sourceMethod: prepared.intent.sourceMethod } : {}),
                            requestKey: prepared.intent.requestKey, whenBusy: 'supersede', context });
                        if (!fresh.ok) return fresh;
                        if (!sameStrictJsonValue(fresh.content.sourceIntent, prepared.intent.sourceIntent)
                            || fresh.content.sourceMethod !== prepared.intent.sourceMethod) return failure('target_mismatch');
                        const resumed = await host.executePreparedPendingDeploy({ ...fresh.input,
                            pendingDeploy: prepared.input.pendingDeploy }, context);
                        return resumed.ok ? DeploymentReceiptResultV1Schema.parse(resumed.result) : resumed;
                    },
                });
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        }) satisfies NonNullable<ActionExecutorDeps['deploymentAction']>,
        async deploymentTemplateInstantiate(...args: Parameters<typeof templates.instantiate>) {
            try { await requireDefinitionManage(args[1]); return await templates.instantiate(...args); }
            catch (error) { return failure(errorCode(error), error); }
        },
        prepareDeploymentEnvironmentCreate: prepareEnvironmentCreate,
        async prepareDeploymentTemplateInstantiation({ input, context }: Readonly<{ input: Parameters<typeof templates.prepare>[0]; context: ActionExecutorContext }>) {
            try { await requireDefinitionManage(context); return await templates.prepare(input, context); }
            catch (error) { return failure(errorCode(error), error); }
        },
        resolveEnvironmentApprovalScope: storageDeps.resolveEnvironmentApprovalScope,
        readDeploymentEnvironment: targetHostReaders.readEnvironment,
        readPreparedDeploymentContent,
        readSetupAppArtifact: (input: Readonly<{ contentArtifactId: string }>, context: ActionExecutorContext) => open(input.contentArtifactId, context),
        async readPendingDeploymentRecovery(input: unknown, context: ActionExecutorContext) {
            const parsed = DeploymentDeployInputV1Schema.safeParse(input);
            if (!parsed.success || parsed.data.whenBusy !== 'supersede') return undefined;
            const authorization = context.externalActionExecutionAuthorization;
            const identity = readInstallationIdentityIfExistsSync();
            if (!authorization || !identity) return refuse('action_forbidden');
            return readPendingDeploymentRecoveryOperation({ input: parsed.data, context,
                scope: { accountId: authorization.binding.accountId, machineId: host.machineId },
                custody: { serverId: host.serverId, installationId: identity.installationId },
                read: () => readEnvironmentMetadata({ environmentId: parsed.data.environmentId, context }),
                async validate(currentInput, current, operationId) {
                    await validatePendingDeploymentInputForHost({ input: currentInput, current, operationId }, {
                        readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
                            prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
                        open: artifactId => open(artifactId, context), assertCurrent: () => assertCurrent(context),
                    });
                },
            });
        },
        async prepareDeployCandidate(originalRequest: DaemonDeploymentCandidateRequest,
            observedEnvironment?: DeploymentEnvironmentDetailV1): Promise<DaemonDeploymentCandidateResult> {
            try {
                await admitCandidateRequest(originalRequest);
                return await prepareAdmittedDeployCandidate(originalRequest, observedEnvironment);
            } catch (error) { return failure(errorCode(error), error); }
        },
        async prepareDeploymentAction(originalRequest: DaemonDeploymentPreparationRequest): Promise<DaemonDeploymentPreparationResult> {
            try {
                const originalInput = originalRequest.input;
                const parent = originalRequest.context.hostReviewedChild?.parent;
                const template = parent?.actionId === 'deployments.templates.instantiate'
                    ? DeploymentTemplateInstantiateInputV1Schema.safeParse(parent.input) : null;
                // The template parent reviews its explicit deploy effect before
                // creating the definition. It does not carry a pre-built Deploy candidate.
                const templateDeployment = template?.success && template.data.mode === 'apply'
                    && template.data.deploy !== undefined && template.data.deploy.requestKey === originalInput.requestKey;
                const replayingDeployment = originalRequest.context.approvedActionReplay && !templateDeployment;
                const authorsCandidate = !('contentArtifactId' in originalInput);
                let preparationEnvironment: DeploymentEnvironmentDetailV1 | undefined;
                let input: OwnServerDeploymentReviewRequest['input'];
                if ('contentArtifactId' in originalInput) input = originalInput;
                else if (originalRequest.actionId === 'deployments.rollback' && 'deploymentId' in originalInput) {
                    await definitionRole(originalRequest.context);
                    if (originalInput.serverId !== host.serverId) return failure('server_scope_mismatch');
                    if (replayingDeployment) return failure('invalid_parameters');
                    const request = { environmentId: originalInput.environmentId, context: originalRequest.context };
                    const prepared = await prepareRollbackForHost({ input: originalInput, context: request.context }, {
                        ...targetHostReaders,
                        async createCandidate(environment, content) {
                            const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                                owner: environment.environment.owner,
                                assertCurrent: () => assertEnvironmentContentOwnerCurrent(request, environment.environment.owner), content: { prepareRecipients: true,
                                    ...await candidateIdentity(originalInput.environmentId, request.context, 'receipt', environment.environment),
                                    header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, content),
                                    body: JSON.stringify(content), signal: request.context.signal,
                                    beforeWrite: () => assertCurrent(request.context), authorizationHeaders: candidateArtifactAuthorization(request.context),
                                } }));
                            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                                contentBodyVersion: created.revision.bodyVersion };
                        },
                    });
                    input = prepared.input;
                    preparationEnvironment = prepared.environment;
                }
                else {
                    if (originalRequest.actionId !== 'deployments.deploy' || 'deploymentId' in originalInput) return failure('invalid_parameters');
                    if (originalInput.serverId !== host.serverId) return failure('server_scope_mismatch');
                    await admitCandidateRequest({ environmentId: originalInput.environmentId, context: originalRequest.context,
                        ...(originalInput.sourceIntent ? { sourceIntent: originalInput.sourceIntent } : {}),
                        ...(originalInput.sha ? { sha: originalInput.sha } : {}),
                        ...(originalInput.sourceMethod ? { sourceMethod: originalInput.sourceMethod } : {}) });
                    const pending = await readCompactPending(originalInput, originalRequest.context);
                    const captured = pending?.captured;
                    if (pending && host.preparePendingDeploymentObservation) {
                        const observe = await host.preparePendingDeploymentObservation({ input: originalInput,
                            admission: pending.admission, pendingDeploy: pending.pendingDeploy, context: originalRequest.context,
                            async validateOriginalInput(original, context) {
                                const current = await readCompactPending(originalInput, context);
                                if (!current || !isDeepStrictEqual(current.admission, pending.admission)
                                    || !isDeepStrictEqual(current.pendingDeploy, pending.pendingDeploy)) return refuse('deployment_conflict');
                                // This is observation, not a new receipt claim. The original
                                // runner input intentionally retains its pre-pending CAS.
                                await validatePendingDeploymentInputForHost({ input: { ...original, pendingDeploy: current.pendingDeploy },
                                    current: current.current, operationId: pending.admission.actionOperationId }, {
                                    readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
                                        prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
                                    open: artifactId => open(artifactId, context), assertCurrent: () => assertCurrent(context),
                                });
                            },
                        });
                        if (observe) return { observePendingOperation: async context => {
                            try { return await observe(context); }
                            catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
                        } };
                    }
                    // An approved compact replay may only observe an already
                    // active invocation; it never authors a replacement candidate.
                    if (replayingDeployment) return failure('invalid_parameters');
                    preparationEnvironment = await targetHostReaders.readEnvironment({ environmentId: originalInput.environmentId,
                        context: originalRequest.context });
                    const candidate = await prepareAdmittedDeployCandidate({ environmentId: originalInput.environmentId,
                        targetLinkId: captured?.targetLinkId ?? originalInput.targetLinkId, context: originalRequest.context,
                        ...(captured ? { sourceIntent: captured.sourceIntent } : originalInput.sourceIntent ? { sourceIntent: originalInput.sourceIntent } : {}),
                        ...(!captured && originalInput.sha ? { sha: originalInput.sha } : {}),
                        ...(captured?.sourceMethod ? { sourceMethod: captured.sourceMethod }
                            : originalInput.sourceMethod ? { sourceMethod: originalInput.sourceMethod } : {}),
                        ...(originalInput.requestKey ? { requestKey: originalInput.requestKey } : {}),
                        ...(originalInput.whenBusy ? { whenBusy: originalInput.whenBusy } : {}) }, preparationEnvironment);
                    if (!candidate.ok) return candidate;
                    if (captured && (!sameStrictJsonValue(candidate.content.sourceIntent, captured.sourceIntent)
                        || candidate.content.sourceMethod !== captured.sourceMethod)) return failure('target_mismatch');
                    input = pending ? { ...candidate.input, pendingDeploy: pending.pendingDeploy } : candidate.input;
                }
                const request = { ...originalRequest, input };
                if (request.input.serverId !== host.serverId) return failure('server_scope_mismatch');
                await assertCurrent(request.context);
                const candidate = readDeploymentReceiptArtifactV1(request.input, await open(request.input.contentArtifactId, request.context));
                if (!candidate.ok) return failure(candidate.error);
                const environment = preparationEnvironment ?? await targetHostReaders.readEnvironment({
                    environmentId: request.input.environmentId, context: request.context });
                if (!authorsCandidate) {
                    await admitPreview(environment, request.context);
                    const role = await definitionRole(request.context);
                    if (role === 'use') {
                        if (request.actionId === 'deployments.promote') return failure('action_forbidden');
                        const retained = request.actionId === 'deployments.rollback' && 'deploymentId' in request.input
                            ? await targetHostReaders.readReceipt({ environmentId: request.input.environmentId,
                                deploymentId: request.input.deploymentId, context: request.context }) : undefined;
                        admitUseDeploymentDefinition(environment, candidate.content, request.input.targetLinkId, retained?.content);
                    }
                }
                const metadata = { environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) };
                const selectedLink = metadata.targetLinks.find(link => link.id === request.input.targetLinkId);
                if (!selectedLink) return failure('target_mismatch');
                if (selectedLink.source.kind === 'plugin') {
                    const platform = DeploymentPlatformContentV1Schema.safeParse(candidate.content);
                    if (!platform.success) return failure('invalid_parameters');
                    return await contributedTarget.prepareAction(request, platform.data, environment);
                }
                const nativeCandidate = DeploymentOwnServerContentV1Schema.parse(candidate.content);
                if (replayingDeployment && !nativeCandidate.ownServer) return failure('invalid_parameters');
                let effectInput = request.input;
                let content = nativeCandidate;
                let contentOwner: DeploymentEnvironmentDetailV1['environment']['owner'] | undefined = environment.environment.owner;
                const contentEnvironmentRequest = { environmentId: request.input.environmentId, context: request.context };
                const readContentOwner = async () => contentOwner ??= (await readEnvironmentMetadata(contentEnvironmentRequest)).environment.owner;
                const assertContentOwnerCurrent = async () => assertEnvironmentContentOwnerCurrent(contentEnvironmentRequest, await readContentOwner());
                let candidateEnvironmentContent: DeploymentEnvironmentDetailV1['content'] | undefined;
                let sourceImageArchives: NonNullable<DeploymentContentV1['ownServer']>['imageArchives'];
                let promotionReview: { artifact: 'image'; previousDocument: string; candidateDocument: string } | undefined;
                if (request.actionId === 'deployments.promote') {
                    if (!('sourceDeploymentId' in request.input)) return failure('deployment_invalid');
                    // The current native producer only admits immutable images.
                    // P41's explicit rebuild producer must co-land before this choice can execute.
                    if (request.input.artifact !== 'image') return failure('unsupported');
                    const promotion = await readStoredPromotionCandidateForHost({ input: request.input, context: request.context }, targetHostReaders);
                    const { sourceReceipt, destination, link } = promotion;
                    contentOwner = destination.environment.owner;
                    sourceImageArchives = sourceReceipt.content.ownServer?.imageArchives;
                    candidateEnvironmentContent = promotion.candidateEnvironmentContent;
                    if (candidateEnvironmentContent.definition.kind !== 'stored' || destination.content.definition.kind !== 'stored') return failure('deployment_invalid');
                    await admitStoredComposeDefinition(candidateEnvironmentContent.definition);
                    const { ownServer: _review, ...unreviewed } = nativeCandidate;
                    content = { sourceIntent: candidateEnvironmentContent.definition,
                        machines: link.machines, buildMachineId: promotion.buildMachineId,
                        ...(destination.environment.ingress ? { ingress: destination.environment.ingress } : {}),
                        onFailure: nativeCandidate.onFailure,
                        images: sourceReceipt.content.images, machineResults: [], steps: [] };
                    if (nativeCandidate.ownServer) {
                        if (!isDeepStrictEqual(unreviewed, content)) return failure('target_mismatch');
                        if (!isDeepStrictEqual(nativeCandidate.ownServer.imageArchives, sourceImageArchives)) return failure('target_mismatch');
                        const retained = readDeploymentEnvironmentArtifactV1(request.input.destinationContent,
                            await open(request.input.destinationContent.contentArtifactId, request.context));
                        if (!retained.ok || !isDeepStrictEqual(retained.content, candidateEnvironmentContent)) return failure('target_mismatch');
                        content = nativeCandidate;
                    } else {
                        const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                            owner: destination.environment.owner, assertCurrent: assertContentOwnerCurrent, content: {
                            ...await candidateIdentity(request.input.environmentId, request.context, 'environment', metadata.environment),
                            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: destination.content.name },
                            body: JSON.stringify(candidateEnvironmentContent), signal: request.context.signal,
                            beforeWrite: () => assertCurrent(request.context), authorizationHeaders: candidateArtifactAuthorization(request.context) } }));
                        effectInput = { ...request.input, destinationContent: { contentArtifactId: created.artifactId,
                            contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion } };
                    }
                    promotionReview = { artifact: 'image', previousDocument: destination.content.definition.document,
                        candidateDocument: candidateEnvironmentContent.definition.document };
                }
                if (!isDeepStrictEqual(content, candidate.content)) {
                    const owner = await readContentOwner();
                    const effective = await atHome(async () => createDeploymentArtifactForHost({ artifacts, owner,
                        assertCurrent: assertContentOwnerCurrent, content: { prepareRecipients: true, header: createDeploymentReceiptArtifactHeaderV1(candidate.title, content),
                        ...await candidateIdentity(request.input.environmentId, request.context, 'receipt', metadata.environment),
                        body: JSON.stringify(content), signal: request.context.signal, beforeWrite: () => assertCurrent(request.context),
                        authorizationHeaders: candidateArtifactAuthorization(request.context) } }));
                    effectInput = { ...effectInput, contentArtifactId: effective.artifactId,
                        contentHeaderVersion: effective.revision.headerVersion, contentBodyVersion: effective.revision.bodyVersion };
                }
                const reviewed = await target.review({ ...request, input: effectInput, content, environment,
                    ...(candidateEnvironmentContent ? { candidateEnvironmentContent } : {}) });
                const preview = promotionReview ? { deployment: reviewed.reviewedEffect, promotion: promotionReview } : reviewed.reviewedEffect;
                if (nativeCandidate.ownServer) {
                    if (!isDeepStrictEqual(nativeCandidate.ownServer.approvedInputBasis, reviewed.inputBasis)) return failure('deployment_conflict');
                    return { input: effectInput, preview };
                }
                const reviewedBody = JSON.stringify({ ...content, ownServer: { approvedInputBasis: reviewed.inputBasis,
                    ...(sourceImageArchives === undefined ? {} : { imageArchives: sourceImageArchives }) } });
                if (authorsCandidate || request.context.externalActionExecutionAuthorization?.binding.deploymentCandidatePublication
                    && effectInput.contentArtifactId === request.context.externalActionExecutionAuthorization.binding.deploymentCandidatePublication.contentArtifactId) {
                    // This invocation owns the fresh candidate. Retain the same
                    // identity P42 admitted; supplied/approved heads remain immutable.
                    const updated = await atHome(() => artifacts.update({ artifactId: effectInput.contentArtifactId,
                        expectedRevision: { headerVersion: effectInput.contentHeaderVersion, bodyVersion: effectInput.contentBodyVersion },
                        header: createDeploymentReceiptArtifactHeaderV1(candidate.title, content), body: reviewedBody,
                        signal: request.context.signal, beforeWrite: () => assertCurrent(request.context),
                        authorizationHeaders: candidateArtifactAuthorization(request.context) }));
                    if (!updated.ok) return failure(updated.errorCode);
                    return { input: { ...effectInput, contentHeaderVersion: updated.revision.headerVersion,
                        contentBodyVersion: updated.revision.bodyVersion }, preview };
                }
                const owner = await readContentOwner();
                const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts, owner,
                    assertCurrent: assertContentOwnerCurrent, content: { prepareRecipients: true, header: createDeploymentReceiptArtifactHeaderV1(candidate.title, content),
                    ...await candidateIdentity(request.input.environmentId, request.context, 'receipt', metadata.environment),
                    body: reviewedBody,
                    signal: request.context.signal, beforeWrite: () => assertCurrent(request.context),
                    authorizationHeaders: candidateArtifactAuthorization(request.context) } }));
                return { input: { ...effectInput, contentArtifactId: created.artifactId,
                    contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion },
                    preview };
            } catch (error) { return failure(originalRequest.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        },
    };
    return deps;
}
