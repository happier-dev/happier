import { randomUUID } from 'node:crypto';
import { registerDiscussionAgentPublisher } from '@/discussions/discussionAgentPublisher';
import { registerSessionMessageReplyObservation } from '@/rpc/handlers/sessionMessageReply';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { createRunnerExecutionRunSnapshotResolver } from '@/agent/runtime/session/process/runnerExecutionRunSnapshot';
import { createRunnerReviewHostPluginAuthorityReader } from '@/agent/executionRuns/profiles/review/pluginAuthority';

import { resolveAgentIdFromSessionMetadata, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { parseSessionPermissionModeAlias } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { SessionAccessGrantSetActionInputV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import type { SessionUpdatePostInputV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import type { AccountSettings, ActionExecutorDeps, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { notifyDaemonConnectedServiceUsageLimitWaitResumeCancel } from '@/daemon/controlClient';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readLatestUsageLimitFailureIssue } from '@/session/usageLimitRecoveryControls/readLatestUsageLimitFailureIssue';
import { createExecutionBudgetRegistry } from '@/daemon/executionBudget/createExecutionBudgetRegistry';
import type { StoredCredentials } from '@/persistence';
import {
    createActionSettingsProvider,
    type RuntimeActionSettingsProvider,
} from '@/settings/actionsSettingsProvider';
import { createExecutionRunAccountSettingsSnapshotResolver } from '@/api/machine/resolveExecutionRunAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { readPreparedAccountRoleOverrides } from '@/session/roles/sessionRoleContext';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { resolveRunnerSkills, type RunnerSkillsResult } from '@/prompts/skills/runtime/resolveRunnerSkills';
import { renderSkillIndexV1 } from '@happier-dev/protocol/prompts/library/skills/skillIndexV1';
import { publishRunnerSkillNotice } from '@/prompts/skills/runtime/publishRunnerSkillNotice';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { projectMcpToolLaunchPolicies } from '@/mcp/runtime/projectMcpToolLaunchPolicy';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { applyRunnerMcpSessionContext, type RunnerMcpSessionWithContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import type { NativeAgentSessionRunToolBindingRequest } from '@/agent/runtime/registry/engineRegistryTypes';

import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerSessionRoleConfigurationHandler } from '@/rpc/handlers/sessionRoleConfiguration';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { ROLE_ACTION_IDS_V1 } from '@happier-dev/protocol/prompts/roles/roleActionIdsV1';
import { createRoleSourceReader, type RoleSourceReader } from '@/session/roles/roleSources';
import type { RoleWorkspaceWritesPolicyPreparer } from '@/session/actions/roleActions';
import { hasReceivedWorkflowSessionRoleAuthority } from '@/session/actions/sessionRoleRpcOrigin';
import type { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createExecutionRunRpcApprovalDeps } from '@/rpc/handlers/executionRuns/createExecutionRunRpcApprovalDeps';
import { createAccountScopedProviderModelProjectionReader } from '@/providers/modelManagement/remoteProjection';
import { createExecutionRunManagedProviderEndpointPreparer, type ExecutionRunManagedProviderEndpointPreparer } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import { createRunnerManagedProviderRunSourceOpener } from '@/agent/runtime/session/process/runnerManagedProviderConsumerAccess';
import type { ResolveManagedProviderPurposeBindingIntent } from '@/providers/managed/resolvePurposeBindingSnapshot';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import {
    createRestrictedCurrentSessionListActionDependency,
    createSessionListActionDeps,
} from '@/session/actions/sessionListActionDependency';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserUiAutomationRouteOwner } from '@/daemon/runtimeActionExecutor';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type {
    BrowserRecordingComposerAttachInput,
    BrowserRecordingComposerAttachResult,
} from '@/daemon/browser/recording/attachToComposer';
import type { LocalServicesRuntimeActionRoutes } from '@/daemon/local/services/actions/runtimeActionExecutor';
import type { DaemonPeerMediationObservabilityRuntimeActionContext } from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveUsageLimitRecoveryEnabled } from '@/features/usageLimitRecoveryFeatureGate';
import { fetchSessionById, importHistoricalSessionTranscript } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { createServerBackedSessionTranscriptStore } from '@/api/session/createServerBackedSessionTranscriptStore';
import {
    DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Metadata } from '@/api/types';
import type { ACPMessageData, ACPProvider } from '../../sessionMessageTypes';
import { deriveVoiceAgentTurnLocalId, readVoiceAgentTurnPayloadFromMeta } from '@happier-dev/protocol/messages/structured/voiceAgentTurnLocalId';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { EphemeralSendResult } from '@/api/session/client/transcript/ephemeralSendOutcome';
import type { VoiceAgentTranscriptTurnCommitParams } from '@/api/session/client/transcript/sessionClientTranscriptApi';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { createExecutionRunTranscriptCustodyError } from '@/agent/runtime/bridges/executionRun/executionRunTranscriptPublisher';
import { resolveExecutionRunPublicBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { hashProcessCommand, readSessionMarkerForPid } from '@/daemon/sessionRegistry';
import { processGenerationMatches, readProcessIdentityByPid } from '@/daemon/processIdentity';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator, resolveAccountVoiceFollowDisclosure } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { resolveSessionFollowContextUtf8AllowanceV1 } from '@/agent/runtime/session/follow/sessionFollowContextBudget';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';

export function resolveSessionClientParentProvider(metadata: unknown): ACPProvider {
    const configuredAcpBackendId = typeof readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId === 'string'
        ? String(readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId).trim()
        : '';
    if (configuredAcpBackendId) {
        return configuredAcpBackendId;
    }

    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    if (agentId) return agentId;

    throw new Error('Missing canonical session parent provider identity');
}

export function registerSessionClientRuntimeHandlers(
    params: Readonly<{
        rpcHandlerManager: RpcHandlerManager;
        token: string;
        /** Exact qualified Home captured by the owning Session composition. */
        serverId: string;
        /** Immutable HTTP origin carried by this Session's transport. */
        serverUrl: string;
        /** Verified restricted-runtime principal; absent for ordinary Account clients. */
        runtimePrincipalAccountId?: string;
        /**
         * The Account credentials the owning composition may use for
         * Account-scoped Action policy and approval storage. A restricted
         * Session-runtime composition supplies none, so those consumers return
         * their canonical unavailable outcome instead of borrowing an
         * unrelated Account signed in on that machine.
         */
        readOwnerAccountCredentials: () => Promise<StoredCredentials | null>;
        actionsSettingsProvider?: RuntimeActionSettingsProvider;
        metadataPath: string;
        metadata: unknown;
        /** Machine already bound by the hosting Session's transport composition. */
        localMachineId?: string | null;
        sessionId: string;
        session?: RunnerMcpSessionWithContext<ApiSessionClient>;
        getSessionMetadata: () => Metadata | null;
        getCurrentSessionSkillItems?: import('@/mcp/runtime/applyRunnerMcpSessionContext').RunnerMcpSessionContextAccessors['getCurrentSessionSkillItems'];
        readRoleSources?: RoleSourceReader;
        getCurrentResolvedRoles?: () => import('@happier-dev/protocol').ResolvedRolesSnapshotV1;
        getCurrentWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
        prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
        sessionRuntimeControls?: SessionRuntimeControls | null;
        revalidateExplicitUserRequest?: NonNullable<Parameters<typeof registerSessionHandlers>[2]>['revalidateExplicitUserRequest'];
        waitForSessionRuntimeControls?: (signal?: AbortSignal) => Promise<boolean>;
        /** Join the owning Session's initial control installation, without a separate startup deadline. */
        waitForAppliedChildSelectionReader?: (signal: AbortSignal) => Promise<boolean>;
        enqueueSessionUserMessage: (request: Readonly<{
            callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
            text: string;
            localId?: string;
            meta?: Record<string, unknown>;
            requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
            recipient?: import('@happier-dev/protocol').ParticipantRecipientV1;
        }>) => Promise<void> | void;
        enqueueUserTextMessageCommitted: (
            text: string,
            opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
        ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
        enqueueAgentMessageCommitted: (
            provider: ACPProvider,
            body: ACPMessageData,
            opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
        ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
        enqueueVoiceAgentTranscriptTurnCommitted: (
            provider: ACPProvider,
            params: VoiceAgentTranscriptTurnCommitParams,
        ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
        sendAgentMessageEphemeral: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number }) => EphemeralSendResult;
        sendAgentMessageEphemeralDelta?: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> }) => EphemeralSendResult;
        getEphemeralStreamConnectionEpoch?: () => number;
        enqueueRegisteredSessionStateFieldMutation?: (mutation: RegisteredSessionStateFieldMutationV1) => void | Promise<void>;
        getTranscriptQueryContext: () => Readonly<
            | { encryptionMode: 'plain' }
            | {
                encryptionMode: 'e2ee';
                encryptionKey: Uint8Array;
                encryptionVariant: 'legacy' | 'dataKey';
            }
        >;
        getAgentStateRequestStore?: ExecutionRunPermissionRequestStoreProvider;
        getBrowserDaemonControlRoutes?: (() => BrowserDaemonControlRoutes | null) | null;
        getBrowserDaemonContextRoutes?: (() => BrowserContextRoutes | null) | null;
        getBrowserDaemonAutomationRoutes?: (() => BrowserAutomationRoutes | null) | null;
        getBrowserUiAutomation?: (() => BrowserUiAutomationRouteOwner | null) | null;
        getBrowserDiagnosticsActionRoutes?: (() => BrowserDiagnosticsActionRoutes | null) | null;
        getBrowserRecordingRoutes?: (() => BrowserRecordingRoutes | null) | null;
        attachBrowserRecordingToComposer?: (
            input: BrowserRecordingComposerAttachInput,
        ) => Promise<BrowserRecordingComposerAttachResult>;
        getLocalServicesRuntimeActionRoutes?: (() => LocalServicesRuntimeActionRoutes | null) | null;
        getSimulatorPreviewRoutes?: (() => SimulatorPreviewRoutes | null) | null;
        getPeerMediationObservabilityRuntimeActionContext?: (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null;
        getServerFeaturesSnapshot?: (() => CliServerFeaturesSnapshot | undefined) | null;
        createCapabilitiesApiClient?: NonNullable<
            Parameters<typeof registerCapabilitiesHandlers>[1]
        >['createApiClient'];
        persistVoiceAgentRunMetadataFromPublicRun: (run: unknown, welcomedEpoch?: number) => void;
        socketEmitExecutionRunUpdated: (run: unknown) => void;
        observeExecutionRunPublicState?: (run: unknown) => void;
    }>,
): ReturnType<typeof registerSessionHandlers> & Readonly<{
    refreshDemandedMcpCatalog(signal?: AbortSignal): Promise<void>;
    disposeExecutionRuns(): Promise<void>;
}> {
    if (params.session) {
        registerDiscussionAgentPublisher({ rpcHandlerManager: params.rpcHandlerManager, serverId: params.serverId,
            serverUrl: params.serverUrl, session: params.session, readOwnerAccountCredentials: params.readOwnerAccountCredentials,
            getServerIdentityId: () => params.session?.getServerIdentityId(),
            isApprovalExecutionOriginCurrent: args => isApprovalExecutionOriginCurrent(args),
            executeSourceAction: async (actionId, input, context) => {
                if (actionId !== 'session.transcript.get' && actionId !== 'doc.read' && actionId !== 'workflow.run.invocations.get') {
                    return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
                }
                const credentialed = await resolveCredentialedRoleParams(context.signal);
                if (!credentialed) return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
                return await createCliActionExecutor(credentialed).execute(actionId, input, context);
            } });
        registerSessionMessageReplyObservation({ rpcHandlerManager: params.rpcHandlerManager, session: params.session });
    }
    const readOwnerAccountCredentials = params.readOwnerAccountCredentials;
    const roleAccountScopeKey = runWithServerHttpBaseUrl(params.serverUrl,
        () => resolveAccountSettingsScopeKeyForToken(params.token));
    const roleAccountLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const actionsSettingsProvider: RuntimeActionSettingsProvider = params.actionsSettingsProvider ?? {
        ...createActionSettingsProvider({
        scopeKey: roleAccountScopeKey,
        getAccountSettings: () => ownerAccountSettingsForRuntime,
        }),
        getAccountRoleOverrides: () => {
            const snapshot = ownerAccountSettingsForRuntime ? ownerAccountOperationContext?.readSnapshot() : null;
            return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot)
                : { status: 'unavailable', reason: 'source-unavailable' };
        },
    };
    const approvalServerId = params.serverId;
    const approvalServerApiUrl = params.serverUrl;
    const tokenAccountId = readAccountIdFromToken(params.token);
    const restrictedRuntimeAdmission = params.runtimePrincipalAccountId !== undefined
        && tokenAccountId !== null
        && params.runtimePrincipalAccountId === tokenAccountId
        ? Object.freeze({
            accountId: tokenAccountId,
            credentials: Object.freeze({ token: params.token, encryption: null }),
        })
        : null;
    const runtimeAccountId = params.runtimePrincipalAccountId !== undefined
        ? restrictedRuntimeAdmission?.accountId
        : tokenAccountId ?? undefined;
    const markerReadScope = Object.freeze({ happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing });
    const readRequesterWorkAttributionV1 = async () => {
        if (!runtimeAccountId) return null;
        const credentials = await readOwnerAccountCredentials();
        if (!credentials || credentials.token !== params.token) return null;
        const scope = credentials.requesterSessionCredentialScope;
        if (scope && (scope.serverId !== params.serverId
            || scope.serverHttpBaseUrl !== normalizeServerHttpBaseUrl(params.serverUrl))) return null;
        const child = scope?.requesterSession;
        if (child) {
            return child.sessionId === params.sessionId
                && child.attribution.serverId === params.serverId
                && child.attribution.accountId === runtimeAccountId ? child.attribution : null;
        }
        // Ordinary daemon-launched custody already has a canonical accepted
        // marker. Only its exact live process generation may supply this fact.
        const [marker, identity] = await Promise.all([
            readSessionMarkerForPid(process.pid, markerReadScope), readProcessIdentityByPid(process.pid),
        ]);
        const stamp = marker?.requesterWorkAttributionV1;
        if (!marker || !identity || !stamp || marker.pid !== process.pid
            || marker.happySessionId !== params.sessionId
            || stamp.serverId !== params.serverId || stamp.accountId !== runtimeAccountId
            || marker.processStartTimeMs === undefined || identity.processStartTimeMs === undefined
            || !processGenerationMatches(marker.processStartTimeMs, identity.processStartTimeMs)
            || !marker.processCommandHash || marker.processCommandHash !== hashProcessCommand(identity.command)) return null;
        return Object.freeze(RequesterWorkAttributionV1Schema.parse(stamp));
    };
    const transcriptQueryContext = params.getTranscriptQueryContext();
    const transcriptTransportContext: SessionStoredContentCryptoContext =
        transcriptQueryContext.encryptionMode === 'plain'
            ? { mode: 'plain', ctx: null }
            : { mode: 'e2ee', ctx: transcriptQueryContext };
    const sessionTransportMaterial = transcriptQueryContext.encryptionMode === 'plain'
        ? { mode: 'plain' as const }
        : { mode: 'e2ee' as const, dataEncryptionKey: transcriptQueryContext.encryptionKey };
    const parentProvider = resolveSessionClientParentProvider(params.metadata);
    const workingDirectory = params.metadataPath ?? process.cwd();
    const metadataMachineId = typeof (params.metadata as { machineId?: unknown })?.machineId === 'string'
        ? (params.metadata as { machineId: string }).machineId.trim()
        : '';
    const currentMetadataMachineId = params.getSessionMetadata()?.machineId;
    const sessionMachineId = params.localMachineId?.trim()
        || (typeof currentMetadataMachineId === 'string' ? currentMetadataMachineId.trim() : '')
        || metadataMachineId;
    const parentSessionForTools = params.session;
    const accountVoiceFollowReconciler = parentSessionForTools && runtimeAccountId
        ? createSessionFollowContextReconciler({
            session: parentSessionForTools,
            observer: {
                kind: 'account_voice',
                accountId: runtimeAccountId,
                voiceSessionId: parentSessionForTools.sessionId,
            },
            hydrateObservation: async (input) => {
                const credentials = await readOwnerAccountCredentials();
                if (!credentials) return null;
                // The Account's Voice disclosure policy bounds this daemon read
                // exactly as it bounds the foreground Voice path: content switches,
                // update level (`none` discloses nothing), the user-message filter
                // and the snippet count, all from the same Protocol owners.
                const disclosure = resolveAccountVoiceFollowDisclosure(await resolveOwnerAccountSettings());
                return await createSessionFollowSourceHydrator({
                    session: parentSessionForTools,
                    credentials,
                    disclosure,
                })(input);
            },
        })
        : null;
    let ownerAccountSettingsForRuntime: AccountSettings | null = null;
    let ownerAccountOperationContext: SavedSecretOperationContextV1 | undefined;
    let disposed = false;
    const runtimeControlsLifetime = new AbortController();
    const ownerAccountIsCurrent = async () => {
        if (disposed) return false;
        const credentials = await readOwnerAccountCredentials();
        const scope = credentials?.requesterSessionCredentialScope;
        return !disposed && credentials?.token === params.token && (!scope || scope.serverId === params.serverId
            && scope.serverHttpBaseUrl === normalizeServerHttpBaseUrl(params.serverUrl));
    };
    const ownerAccountSnapshots = createExecutionRunAccountSettingsSnapshotResolver({ machineId: sessionMachineId, serverHttpBaseUrl: params.serverUrl,
        readCredentials: async () => await ownerAccountIsCurrent() ? await readOwnerAccountCredentials() : null,
        isOwnerCurrent: () => !disposed, onSettings: settings => { ownerAccountSettingsForRuntime = settings; } });
    const resolveOwnerAccountSettingsSnapshot = Object.assign(async (input?: Readonly<{
        secretReferenceOverlay?: import('@happier-dev/protocol').SecretReferenceOverlayV1;
        mcpServerCatalog?: boolean;
        savedSecretReferences?: readonly import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationReferenceV1[];
        signal?: AbortSignal;
    }>) => {
        const snapshot = await ownerAccountSnapshots(input);
        ownerAccountOperationContext = ownerAccountSnapshots.readOperationContext() ?? undefined;
        return snapshot;
    }, { readOperationContext: ownerAccountSnapshots.readOperationContext });
    const resolveOwnerAccountSettings = async (): Promise<AccountSettings | null> => {
        return (await resolveOwnerAccountSettingsSnapshot())?.settings ?? null;
    };
    const readManagedRunServices = () => disposed ? undefined : params.sessionRuntimeControls?.managedProviderRunServices;
    const resolveManagedPurposeBindingIntent: ResolveManagedProviderPurposeBindingIntent = async input => {
        const managedRunServices = readManagedRunServices();
        if (!managedRunServices) throw createProviderErrorV1('provider_authorization_changed', {});
        const snapshot = await resolveOwnerAccountSettingsSnapshot({ signal: input.signal });
        const isCurrent = async () => await ownerAccountIsCurrent() && readManagedRunServices() === managedRunServices;
        if (!snapshot?.scopeKey || !await isCurrent()) throw createProviderErrorV1('provider_authorization_changed', {});
        const result = await managedRunServices.resolvePurpose({ ...input, serviceRefs: [...input.serviceRefs],
            expectedAccountSettingsScopeKey: snapshot.scopeKey });
        input.signal.throwIfAborted();
        if (!await isCurrent()) throw createProviderErrorV1('provider_authorization_changed', {});
        return result.binding;
    };
    const prepareManagedEndpoint: ExecutionRunManagedProviderEndpointPreparer = async input => {
        const managedRunServices = readManagedRunServices();
        if (!managedRunServices || !runtimeAccountId) throw createProviderErrorV1('provider_authorization_changed', {});
        // A retained endpoint belongs to the services that opened it. Replacement
        // must withdraw that authority rather than switch its reads to a new owner.
        const isOwnerCurrent = async () => await ownerAccountIsCurrent() && readManagedRunServices() === managedRunServices;
        return await createExecutionRunManagedProviderEndpointPreparer({ machineId: sessionMachineId, accountId: runtimeAccountId,
            readAccountSettingsSnapshot: resolveOwnerAccountSettingsSnapshot,
            resolveManagedPurposeBindingIntent,
            openSource: createRunnerManagedProviderRunSourceOpener({ services: managedRunServices, isOwnerCurrent }),
        })(input);
    };
    const readCodingPromptBehavior = () => disposed ? null : params.sessionRuntimeControls?.readCodingPromptBehavior?.() ?? null;
    const readAppliedChildSelection = async (options?: Readonly<{ waitForReady?: boolean }>) => {
        if (options?.waitForReady && !params.sessionRuntimeControls?.readAppliedChildSelection && !disposed) {
            await params.waitForAppliedChildSelectionReader?.(runtimeControlsLifetime.signal);
        }
        const controls = params.sessionRuntimeControls;
        const reader = controls?.readAppliedChildSelection;
        if (disposed || !reader) {
            const reason = controls ? 'applied_child_selection_reader_unavailable' : 'session_runtime_controls_unavailable';
            logger.infoFile('[Session] Applied parent selection unavailable', {
                sessionId: params.sessionId, runnerPid: process.pid, reason,
            });
            return { status: 'unavailable' as const };
        }
        const selection = await reader();
        return disposed || params.sessionRuntimeControls?.readAppliedChildSelection !== reader
            ? { status: 'unavailable' as const } : selection ?? { status: 'unavailable' as const };
    };
    const permissionOwnerUnavailable = () => Object.assign(new Error('Session permission owner is unavailable'), {
        code: 'execution_run_interaction_unavailable',
    });
    function readRuntimeCallback<Args extends unknown[], Result>(read: () => ((...args: Args) => Promise<Result>) | undefined) {
        const callback = disposed ? undefined : read();
        if (!callback) return undefined;
        return async (...args: Args): Promise<Result> => {
            if (disposed || read() !== callback) throw permissionOwnerUnavailable();
            const result = await callback(...args);
            if (disposed || read() !== callback) throw permissionOwnerUnavailable();
            return result;
        };
    }
    const sessionInteractionHost = parentSessionForTools
        ? {
            session: parentSessionForTools,
            machineId: sessionMachineId,
            readOwnerAccountCredentials,
            readCodingPromptBehavior,
            readAppliedChildSelection,
            get readReferenceAction() {
                return readRuntimeCallback(() => params.sessionRuntimeControls?.readReferenceAction);
            },
            get permissionHandler() {
                const handler = disposed ? null : params.sessionRuntimeControls?.readPermissionHandler?.();
                if (!handler) throw permissionOwnerUnavailable();
                return handler;
            },
            get listSkills() {
                return readRuntimeCallback(() => params.sessionRuntimeControls?.listSkills);
            },
            get listVendorPlugins() {
                return readRuntimeCallback(() => params.sessionRuntimeControls?.listVendorPlugins);
            },
            get resolveComposerReference() {
                return readRuntimeCallback(() => params.sessionRuntimeControls?.resolveComposerReference);
            },
            get resolveComposerAttachmentForDispatch() {
                return readRuntimeCallback(() => params.sessionRuntimeControls?.resolveComposerAttachmentForDispatch);
            },
            prepareRunTeamCredentialProviderBinding: async ({ runId, agentId, selection: explicitSelection }: Readonly<{
                runId: string;
                agentId: string;
                selection?: TeamCredentialProviderModelSelectionV1;
            }>) => {
                const prepare = params.sessionRuntimeControls?.prepareRunTeamCredentialProviderBinding;
                if (!prepare || !explicitSelection) return null;
                return await prepare({
                    runId,
                    agentId,
                    resourceId: explicitSelection.resourceId,
                    modelId: explicitSelection.modelId,
                    selection: explicitSelection,
                });
            },
            ...(accountVoiceFollowReconciler
                ? {
                    prepareAccountVoiceFollowContext: async (input: Readonly<{
                        executionRunId: string;
                        requiredPrompt: string;
                        signal: AbortSignal;
                    }>) => {
                        const allowance = resolveSessionFollowContextUtf8AllowanceV1({
                            requiredPrompt: input.requiredPrompt,
                            activeModelId: null,
                            contextUsage: null,
                        });
                        return await accountVoiceFollowReconciler({
                            signal: input.signal,
                            maxFollowContextUtf8Bytes: allowance.maxUtf8Bytes,
                            executionRunId: input.executionRunId,
                        });
                    },
                }
                : {}),
            /**
             * Composes this parent Session's effective tool profile for one
             * Session-owned Run. Configured third-party servers stay exactly as the
             * Session materialization owner resolved them; only the built-in Happier
             * bridge is rebound to the Run's permission mode, location, lifetime and
             * own admitted turn.
             */
            composeRunToolBinding: (request: NativeAgentSessionRunToolBindingRequest) => runWithServerHttpBaseUrl(params.serverUrl, async () => {
                const ownerCredentials = await readOwnerAccountCredentials();
                const credentials = ownerCredentials ?? restrictedRuntimeAdmission?.credentials ?? null;
                if (!credentials) return {
                    supportedSessionReadActions: [],
                    dispose: (): void => undefined,
                };
                const { toAgentSessionMcpLaunchConfigs } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSession');
                const accountSettingsSnapshot = ownerCredentials
                    ? await resolveOwnerAccountSettingsSnapshot({ mcpServerCatalog: true, signal: request.signal })
                    : null;
                const accountSettings = accountSettingsSnapshot?.settings ?? null;
                // An explicit view, not a spread of the live client: the durable
                // Session client owns prototype-bound behavior the MCP seam must
                // reach through its real methods.
                let runSkills: RunnerSkillsResult | null = null;
                const parentMcpSession = applyRunnerMcpSessionContext({
                    sessionId: parentSessionForTools.sessionId,
                    rpcHandlerManager: params.rpcHandlerManager,
                    updateMetadata: (updater) => parentSessionForTools.updateMetadata(updater),
                    enqueueSessionEventCommitted: (...args) => parentSessionForTools.enqueueSessionEventCommitted(...args),
                    getMetadataSnapshot: () => parentSessionForTools.getMetadataSnapshot(),
                    getBackendTarget: () => parentSessionForTools.getBackendTarget?.() ?? null,
                    getPluginMcpRuntimeRegistry: () => parentSessionForTools.getPluginMcpRuntimeRegistry?.() ?? null,
                    getMcpRequestAuthPort: () => parentSessionForTools.getMcpRequestAuthPort?.(),
                    getServerBinding: () => ({
                        serverId: approvalServerId,
                        serverUrl: approvalServerApiUrl,
                    }),
                    getServerFeaturesSnapshot: () => params.getServerFeaturesSnapshot?.(),
                    confirmSessionAction: (confirmation, binding) =>
                        parentSessionForTools.confirmSessionAction(confirmation, binding),
                    // The Run's Board and Discussions are its parent Session's,
                    // opened with the material this client already holds.
                    getStoredContentEncryptionContext: () => transcriptQueryContext.encryptionMode === 'plain'
                        ? { mode: 'plain' as const }
                        : { mode: 'e2ee' as const, ctx: transcriptQueryContext },
                } satisfies HappyMcpSessionClient, {
                    getCurrentSessionSkillItems: () => request.isCurrent() && !request.signal.aborted && runSkills && !runSkills.unavailable
                        ? runSkills.plan.items.filter(item => item.state === 'delivered')
                            .map(({ skillId, name, digest }) => ({ skillId, name, digest }))
                        : null,
                    getCurrentSessionLocation: () => ({
                        path: workingDirectory,
                        machineId: sessionMachineId,
                    }),
                });
                const agentToolCapabilities = readAgentCatalogSnapshot().catalogEntriesById[request.agentId];
                const resolved = await resolveRunnerMcpServers({
                    mcpToolCallIdMetaKey: agentToolCapabilities?.mcpToolCallIdMetaKey,
                    session: parentMcpSession,
                    credentials,
                    accountCredentials: ownerCredentials,
                    sessionList,
                    accountSettings,
                    accountSettingsSnapshot,
                    ...(ownerAccountOperationContext ? { operationContext: ownerAccountOperationContext } : {}),
                    ...(params.actionsSettingsProvider
                        ? { actionsSettingsProvider: params.actionsSettingsProvider }
                        : {}),
                    ...(accountSettingsSnapshot?.savedSecretResources
                        ? { savedSecretResources: accountSettingsSnapshot.savedSecretResources }
                        : {}),
                    ...(accountSettingsSnapshot?.savedSecretCatalogState
                        ? { savedSecretCatalogState: accountSettingsSnapshot.savedSecretCatalogState }
                        : {}),
                    machineId: sessionMachineId,
                    agentId: request.agentId,
                    agentAcceptsUserMcp: agentReceivesUserMcpServersV1(resolveAgentToolsDelivery(request.agentId)),
                    mcpPermissionHandler: request.mcpPermissionHandler,
                    // The parent Session directory owns the configured server selection.
                    directory: workingDirectory,
                    sessionMetadata: parentSessionForTools.getMetadataSnapshot() ?? null,
                    executionRun: {
                        ...request,
                        // The host carries a raw mode token; the canonical Session
                        // parser owns its meaning at this boundary.
                        getPermissionMode: () =>
                            parseSessionPermissionModeAlias(request.getPermissionMode()),
                    },
                });
                const mcpServers = toAgentSessionMcpLaunchConfigs(resolved.mcpServers);
                const capturedMcpAccount = ownerAccountOperationContext;
                const getMcpToolContext = capturedMcpAccount && capturedMcpAccount.readSnapshot()?.scopeKey === accountSettingsSnapshot?.scopeKey
                    ? () => ({ mcpServerIdentities: resolved.mcpServerIdentities ?? {},
                        catalog: capturedMcpAccount.readSnapshot()?.mcpServerCatalog ?? null })
                    : undefined;
                const mcpToolControl = readAgentCatalogSnapshot().catalogEntriesById[request.agentId]?.mcpToolControl;
                const resolveMcpToolPolicy = () => {
                    const liveCatalog = getMcpToolContext?.().catalog;
                    return getMcpToolContext ? projectMcpToolLaunchPolicies({ catalog: liveCatalog?.status === 'ready' ? liveCatalog.catalog : { v: 1, servers: [], bindings: [] }, mcpServerIdentities: resolved.mcpServerIdentities ?? {},
                        control: mcpToolControl, permissionMode: parseAgentPermissionIntentV1Alias(request.getPermissionMode()) ?? 'default' })
                    : undefined;
                };
                const mcpToolPolicy = resolveMcpToolPolicy();
                runSkills = ownerCredentials ? await resolveRunnerSkills({
                    ownerKey: `${params.sessionId}/runs/${request.runId}`,
                    agentId: request.agentId, machineId: sessionMachineId, directory: request.cwd,
                    sessionMetadata: parentSessionForTools.getMetadataSnapshot() ?? null,
                    credentials: ownerCredentials, accountSnapshot: accountSettingsSnapshot,
                    ...(ownerAccountOperationContext ? { operationContext: ownerAccountOperationContext } : {}),
                    agentHasActionChannel: resolveAgentToolsDelivery(request.agentId) !== 'unsupported',
                    isCurrent: async () => request.isCurrent()
                        && (!ownerAccountOperationContext || await ownerAccountOperationContext.isCurrent()),
                }) : null;
                if (runSkills) await publishRunnerSkillNotice(parentSessionForTools, runSkills);
                const skillIndex = runSkills?.plan.plan === 'index'
                    ? renderSkillIndexV1(runSkills.indexItems, params.sessionId) : '';
                return {
                    ...(mcpServers ? { mcpServers } : {}),
                    ...(resolved.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: resolved.mcpServersStrictMode } : {}),
                    mcpServerIdentities: resolved.mcpServerIdentities,
                    resolvedMcpServers: resolved.resolvedServers,
                    ...(mcpToolPolicy ? { mcpToolPolicy } : {}),
                    ...(getMcpToolContext ? { getMcpToolContext } : {}),
                    ...(mcpToolControl?.approval === 'native' && capturedMcpAccount ? {
                        subscribeMcpToolPolicy: (listener: (policy: NonNullable<typeof mcpToolPolicy>) => void) => {
                            let previous = mcpToolPolicy;
                            const publish = () => {
                                if (!request.isCurrent() || request.signal.aborted) return;
                                const next = resolveMcpToolPolicy();
                                if (!next || JSON.stringify(next) === JSON.stringify(previous)) return;
                                previous = next;
                                listener(next);
                            };
                            const unsubscribe = capturedMcpAccount.subscribeMcpCatalog(publish);
                            publish();
                            return unsubscribe;
                        },
                    } : {}),
                    ...(runSkills?.delivery ? { skills: runSkills.delivery } : {}),
                    ...(runSkills?.delivery && ownerCredentials && runtimeAccountId ? {
                        observeSkillUse: async (event: Extract<import('@happier-dev/protocol').AgentSessionRuntimeEvent, { kind: 'skill-usage' }>) => {
                            if (!request.isCurrent() || request.signal.aborted || !runSkills?.delivery
                                || ownerAccountOperationContext && !await ownerAccountOperationContext.isCurrent()) return;
                            await projectRuntimeTranscriptEvent({ session: { sessionId: params.sessionId }, event,
                                skillDelivery: runSkills.delivery,
                                usageAccount: { accountId: runtimeAccountId, serverHttpBaseUrl: approvalServerApiUrl } });
                        },
                    } : {}),
                    ...(skillIndex ? { skillIndex } : {}),
                    resolveMcpToolNaming: resolved.resolveMcpToolNaming,
                    supportedSessionReadActions: resolved.happierMcpServer.supportedSessionReadActions,
                    dispose: () => resolved.happierMcpServer.stop(),
                };
            }),
        }
        : null;
    const executionBudgetRegistry = createExecutionBudgetRegistry();
    let executionRunManager: ExecutionRunHostBridgeContract | null = null;
    const sessionList: ActionExecutorDeps['sessionList'] = async (input) => {
        if (
            input.context.sessionListAccess !== 'current_session'
            || input.context.defaultSessionId !== params.sessionId
            || input.context.runtimeAccountId !== runtimeAccountId
        ) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
        }
        const ownerCredentials = await readOwnerAccountCredentials();
        const credentials = ownerCredentials ?? restrictedRuntimeAdmission?.credentials ?? null;
        if (!credentials || credentials.token !== params.token) {
            return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        // This ad-hoc Run read has no client list-membership owner: it returns the
        // canonical Action result only and cannot replace ordinary/query membership.
        return await (ownerCredentials
            ? createSessionListActionDeps({
                credentials,
                serverId: approvalServerId,
                serverHttpBaseUrl: approvalServerApiUrl,
            }).sessionList
            : createRestrictedCurrentSessionListActionDependency({
                credentials,
                sessionId: params.sessionId,
                serverId: approvalServerId,
                serverHttpBaseUrl: approvalServerApiUrl,
                material: sessionTransportMaterial,
            }))(input);
    };
    const isApprovalExecutionOriginCurrent: NonNullable<
        ActionExecutorDeps['isApprovalExecutionOriginCurrent']
    > = async (args) => {
        const credentials = await readOwnerAccountCredentials();
        if (!credentials || !sessionMachineId) return false;
        const checker = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
            credentials,
            machineId: sessionMachineId,
            serverId: approvalServerId,
            serverApiUrl: approvalServerApiUrl,
            isSessionCallerCurrent: async ({ caller, signal }) => {
                const lifetime = params.session?.getRuntimeLifetimeSignal?.();
                return caller.sessionId === params.sessionId && Boolean(lifetime && !lifetime.aborted)
                    && !signal?.aborted && await ownerAccountIsCurrent();
            },
            resolveCurrentPermissionMode: async (origin) => {
                if (origin.runId) {
                    const run = executionRunManager?.get(origin.runId);
                    return run?.sessionId === params.sessionId
                        ? parseSessionPermissionModeAlias(run.permissionMode)
                        : null;
                }
                if (origin.sessionId !== params.sessionId) return null;
                return resolvePermissionIntentFromSessionMetadata(params.getSessionMetadata())?.intent ?? null;
            },
            resolveCurrentSessionAgentSpawnPolicyV1: async () => (
                await resolveOwnerAccountSettings()
            )?.sessionAgentSpawnPolicyV1 ?? null,
        });
        return checker ? await checker(args) : false;
    };
    // Session RPCs register before the host installs native policy controls.
    // Resolve the current control at invocation, including after runtime retirement.
    const prepareWorkspaceWritesPolicy: RoleWorkspaceWritesPolicyPreparer = async (workspaceWrites, context) => {
        const prepare = params.prepareWorkspaceWritesPolicy ?? parentSessionForTools?.prepareWorkspaceWritesPolicy;
        return prepare ? await prepare(workspaceWrites, context)
            : { ok: false, errorCode: 'role_policy_unenforceable' };
    };
    const sessionActionParams = {
        token: params.token,
        serverId: approvalServerId,
        serverHttpBaseUrl: approvalServerApiUrl,
        ...(params.getServerFeaturesSnapshot
            ? { resolveServerFeaturesSnapshot: params.getServerFeaturesSnapshot }
            : {}),
        sessionId: params.sessionId,
        getCurrentSessionMetadata: params.getSessionMetadata,
        ...(parentSessionForTools ? {
            postSessionUpdate: async (report: SessionUpdatePostInputV1) => await parentSessionForTools.enqueueSessionEventCommitted({ type: 'worker-report', ...report }),
            sessionMessageReplyPublisher: parentSessionForTools,
        } : {}),
        getCurrentSessionSkillItems: () => params.getCurrentSessionSkillItems
            ? params.getCurrentSessionSkillItems()
            : parentSessionForTools?.getCurrentSessionSkillItems?.() ?? null,
        getCurrentAppliedChildSelection: readAppliedChildSelection,
        readRoleSources: params.readRoleSources ?? parentSessionForTools?.readRoleSources,
        getCurrentResolvedRoles: params.getCurrentResolvedRoles ?? (parentSessionForTools?.getCurrentResolvedRoles
            ? () => parentSessionForTools.getCurrentResolvedRoles!() : undefined),
        getCurrentWorkspaceWrites: params.getCurrentWorkspaceWrites ?? (parentSessionForTools?.getCurrentWorkspaceWrites
            ? () => parentSessionForTools.getCurrentWorkspaceWrites!() : undefined),
        prepareWorkspaceWritesPolicy,
        ...(params.enqueueRegisteredSessionStateFieldMutation ? {
            stageSessionStateMutation: async (mutation) => { await params.enqueueRegisteredSessionStateFieldMutation!(mutation); },
        } : {}),
        actionsSettingsProvider,
        isApprovalExecutionOriginCurrent,
        ...transcriptTransportContext,
        transcriptSessionId: params.sessionId,
        transcriptStore: createServerBackedSessionTranscriptStore({
            token: params.token,
            sessionId: params.sessionId,
            ...transcriptTransportContext,
            ...(parentSessionForTools ? { readOpenedSessionState: (versions) => parentSessionForTools.readOpenedSessionStateSnapshot(versions) } : {}),
        }),
        // A.13 watcher bound floor: idle TTL must be >= 600_000 ms (10 min) per packet body section 2.
        transcriptFollowLeaseRegistry: createSessionTranscriptFollowLeaseRegistry({
            idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
        }),
        writeTranscriptItems: async (_sessionId: string, items: readonly SessionTranscriptActionItem[]) =>
            await importHistoricalSessionTranscript({
                token: params.token,
                sessionId: params.sessionId,
                items,
            }),
        sessionLogAccess: {
            workingDirectory,
            accessPolicy: { kind: 'osUser' },
        },
    } satisfies Parameters<typeof createCliActionExecutor>[0];
    const transcriptActionExecutor = createCliActionExecutor(sessionActionParams);
    const roleOverridesUnavailable = (reason: string) => {
        const error = Object.assign(new Error('account_role_overrides_unavailable'), {
            code: 'account_role_overrides_unavailable', reason, contextSource: 'account_lifetime',
        });
        logger.infoFile('[Session] Role Action refused', readSessionPreparationFailureDiagnostic(error));
        return null;
    };
    const resolveCredentialedRoleParams = async (signal?: AbortSignal) => runWithServerHttpBaseUrl(approvalServerApiUrl, async () => {
        const credentials = await readOwnerAccountCredentials();
        if (!credentials || readAccountIdFromToken(credentials.token) !== runtimeAccountId) {
            await ownerAccountOperationContext?.isCurrent();
            return roleOverridesUnavailable(credentials ? 'account-mismatch' : 'credentials-unavailable');
        }
        const sessionRoles = parentSessionForTools?.getSessionRoleContext?.();
        // The Session's prepared Account holder is authoritative once installed.
        // Finite/standalone receivers retain their existing credentialed holder.
        if (!sessionRoles && !await resolveOwnerAccountSettings()) return roleOverridesUnavailable('source-unavailable');
        const operationContext = sessionRoles ? sessionRoles.readOperationContext?.() : ownerAccountOperationContext;
        if (!operationContext) return roleOverridesUnavailable('source-unavailable');
        if (operationContext.credentials.token !== credentials.token
            || operationContext.readSnapshot()?.scopeKey !== roleAccountScopeKey
            || normalizeServerHttpBaseUrl(operationContext.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(approvalServerApiUrl)
            || !await operationContext.isCurrent()) {
            return roleOverridesUnavailable('not-current');
        }
        const prepareOverrides = async (readSignal?: AbortSignal) => {
            if (sessionRoles) await sessionRoles.prepare(readSignal, true);
            else await prepareActiveAccountRoleOverrides({ credentials, scopeKey: roleAccountScopeKey,
                lifetimeToken: roleAccountLifetimeToken, signal: readSignal, operationContext });
        };
        // Each explicit Action attempt may recover a prior failed demand. A
        // still-running Session demand is joined by its existing Role owner.
        await prepareOverrides(signal);
        const readReadyAccountRoleOverrides = (readSignal?: AbortSignal) => sessionRoles
            ? sessionRoles.readAccountOverrides(readSignal)
            : readPreparedAccountRoleOverrides({
                read: () => {
                    const snapshot = operationContext.readSnapshot();
                    return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot)
                        : { status: 'unavailable', reason: 'scope-retired' };
                },
                prepare: prepareOverrides,
            }, readSignal);
        const overrides = await readReadyAccountRoleOverrides(signal);
        if (overrides.status !== 'ready') return roleOverridesUnavailable(overrides.reason);
        const sourceReader = sessionRoles?.readRoleSources ?? sessionActionParams.readRoleSources ?? createRoleSourceReader({
            artifactStore: createCredentialedAccountArtifactStore(credentials), accountId: runtimeAccountId,
            readRawAccountSettings: async () => {
                const current = operationContext.readSnapshot();
                if (!current || current.source === 'none' || !current.rawSettings) {
                    throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
                }
                return current.rawSettings;
            },
        });
        const readRoleSources: RoleSourceReader = async (readSignal) => {
            const prepared = await readReadyAccountRoleOverrides(readSignal);
            if (prepared.status !== 'ready') {
                roleOverridesUnavailable(prepared.reason);
                throw Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable', reason: prepared.reason });
            }
            const inventory = await sourceReader(readSignal);
            if (!await operationContext.isCurrent() || !operationContext.readSnapshot()) {
                roleOverridesUnavailable('not-current');
                throw Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable', reason: 'not-current' });
            }
            return inventory;
        };
        return { ...sessionActionParams, token: credentials.token, credentials,
            serverId: approvalServerId, serverHttpBaseUrl: approvalServerApiUrl, readRoleSources,
            ...(sessionRoles ? { getSessionRoleContext: () => sessionRoles } : {}),
            readReadyAccountRoleOverrides,
            savedSecretOperationContext: operationContext };
    }).catch((error: unknown) => {
        const diagnostic = readSessionPreparationFailureDiagnostic(error);
        if (diagnostic.originalCode === 'context_source_unavailable' || diagnostic.originalCode === 'role_overrides_unavailable') {
            return roleOverridesUnavailable(diagnostic.reason);
        }
        throw error;
    });

    registerActionSpecRpcHandlers({
        rpcHandlerManager: params.rpcHandlerManager,
        resolveActionExecutor: async ({ actionId, ingress }) => {
            if (actionId === 'session.update.post' || actionId === 'session.message.reply') return transcriptActionExecutor;
            if (actionId === 'skills.read') {
                const credentials = await readOwnerAccountCredentials();
                if (!credentials) return {
                    execute: async () => ({ ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' }),
                };
                const snapshot = await resolveOwnerAccountSettingsSnapshot();
                return snapshot && ownerAccountOperationContext ? createCliActionExecutor({ ...sessionActionParams, credentials,
                    token: credentials.token, serverId: approvalServerId, serverHttpBaseUrl: approvalServerApiUrl,
                    savedSecretOperationContext: ownerAccountOperationContext }) : {
                    execute: async () => ({ ok: false as const, errorCode: 'catalog_unavailable', error: 'catalog_unavailable' }),
                };
            }
            const roleParams = await resolveCredentialedRoleParams(ingress?.signal);
            return roleParams ? createCliActionExecutor(roleParams) : {
                execute: async () => ({
                    ok: false as const,
                    errorCode: 'account_role_overrides_unavailable',
                    error: 'account_role_overrides_unavailable',
                }),
            };
        },
        actionIds: [...ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('session.')), 'skills.read', 'session.update.post', 'session.message.reply'],
    });
    registerSessionRoleConfigurationHandler({
        rpcHandlerManager: params.rpcHandlerManager,
        sessionId: params.sessionId,
        readSessionMetadata: params.getSessionMetadata,
        readRoleSources: async (signal) => {
            const roleParams = await resolveCredentialedRoleParams(signal);
            if (!roleParams) throw Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable' });
            return await runWithServerHttpBaseUrl(approvalServerApiUrl, () => roleParams.readRoleSources(signal));
        },
        prepareWorkspaceWritesPolicy,
        readSettingsOverrides: async signal => {
            const roleParams = await resolveCredentialedRoleParams(signal);
            return roleParams ? await roleParams.readReadyAccountRoleOverrides(signal)
                : { status: 'unavailable', reason: 'source-unavailable' };
        },
        isWorkflowAuthorizationCurrent: async context => {
            if (context.actionCaller?.kind !== 'workflowRun') return false;
            const credentials = await readOwnerAccountCredentials();
            const accountId = credentials && readAccountIdFromToken(credentials.token);
            if (!credentials || !accountId) return false;
            return hasReceivedWorkflowSessionRoleAuthority({ context, accountId, sessionId: params.sessionId });
        },
        resolveAgentStartContext: async (context) => {
            const roleParams = await resolveCredentialedRoleParams(context.signal);
            if (!roleParams) return null;
            return await runWithServerHttpBaseUrl(approvalServerApiUrl, () =>
                createCliActionDeps({ ...roleParams, getCurrentAppliedChildSelection: readAppliedChildSelection })
                    .resolveAgentStartContext?.(context) ?? null);
        },
        sessionList: async (input) => {
            const roleParams = await resolveCredentialedRoleParams();
            if (!roleParams) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
            return await createSessionListActionDeps({ credentials: roleParams.credentials,
                serverId: approvalServerId, serverHttpBaseUrl: approvalServerApiUrl }).sessionList(input);
        },
        readCurrentReportLead: async (signal) => {
            const roleParams = await resolveCredentialedRoleParams(signal);
            if (!roleParams) return null;
            const session = await runWithServerHttpBaseUrl(approvalServerApiUrl, () => fetchSessionById({
                token: roleParams.token, sessionId: params.sessionId, signal, accessProjectionVersion: 1, reason: 'session-action',
            }));
            return session?.effectiveAccess?.level === 'owner' ? readSessionManagerSessionIdV1(session) : null;
        },
        readCallerWorkspaceWrites: async (context) => {
            if (context.actionCaller?.kind !== 'session') return null;
            const roleParams = await resolveCredentialedRoleParams(context.signal);
            if (!roleParams) return null;
            const sessionId = context.actionCaller.sessionId;
            const transport = await runWithServerHttpBaseUrl(approvalServerApiUrl, () => resolveSessionTransportContext({
                credentials: roleParams.credentials, idOrPrefix: sessionId, signal: context.signal, reason: 'session-action',
            }));
            if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.effectiveAccess?.level !== 'owner') return null;
            const metadata = tryDecryptSessionOwnerMetadataView({ credentials: roleParams.credentials,
                accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession });
            if (!metadata) return null;
            const roleSourceInventory = await runWithServerHttpBaseUrl(approvalServerApiUrl,
                async () => await roleParams.readRoleSources(context.signal));
            const overridesRead = actionsSettingsProvider.getAccountRoleOverrides?.();
            if (overridesRead?.status !== 'ready') return null;
            return readSessionWorkspaceWritesV1(metadata, {
                roleSourceInventory,
                settingsOverrides: overridesRead.overrides,
            }) ?? null;
        },
        ...(params.enqueueRegisteredSessionStateFieldMutation ? {
            stageSessionStateMutation: async (mutation) => { await params.enqueueRegisteredSessionStateFieldMutation!(mutation); },
        } : {}),
    });
    const sessionHandlersRegistration = registerSessionHandlers(params.rpcHandlerManager, workingDirectory, {
        sessionId: params.sessionId,
        ...(params.createCapabilitiesApiClient
            ? { createCapabilitiesApiClient: params.createCapabilitiesApiClient }
            : {}),
        getSessionMetadata: () => params.getSessionMetadata(),
        isUsageLimitRecoveryEnabled: () => resolveUsageLimitRecoveryEnabled({ serverUrl: params.serverUrl }),
        sessionRuntimeControls: params.sessionRuntimeControls ?? null,
        revalidateExplicitUserRequest: params.revalidateExplicitUserRequest,
        waitForSessionRuntimeControls: params.waitForSessionRuntimeControls,
        enqueueSessionUserMessage: (request: Readonly<{
            callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
            text: string;
            localId?: string;
            meta?: Record<string, unknown>;
            requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
            recipient?: import('@happier-dev/protocol').ParticipantRecipientV1;
        }>) => params.enqueueSessionUserMessage(request),
        transcriptActionExecutor,
        notifyUsageLimitWaitResumeCancelled: async (request) =>
            await notifyDaemonConnectedServiceUsageLimitWaitResumeCancel(request),
        readCurrentUsageLimitRecoveryIssue: async (sessionId) => {
            const credentials = await readOwnerAccountCredentials();
            if (!credentials || !await ownerAccountIsCurrent()) throw new Error('usage_limit_recovery_account_unavailable');
            const rawSession = await runWithServerHttpBaseUrl(params.serverUrl, () => fetchSessionById({
                token: credentials.token, sessionId, reason: 'session-control',
            }));
            if (!rawSession) throw new Error('usage_limit_recovery_session_unavailable');
            return readLatestUsageLimitFailureIssue(rawSession);
        },
        checkRuntimeAuthUsageLimitRecovery: async (request) => {
            const machineId = params.getSessionMetadata()?.machineId;
            if (!machineId) return { ok: false, errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable' };
            try {
                const credentials = await readOwnerAccountCredentials();
                if (!credentials) return { ok: false, errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable' };
                return await callMachineRpc({
                    credentials, machineId, serverUrl: params.serverUrl,
                    method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
                    request: { sessionId: request.sessionId,
                        ...(request.resumePromptMode !== undefined ? { resumePromptMode: request.resumePromptMode } : {}),
                    },
                });
            } catch {
                return { ok: false, errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable' };
            }
        },
    });

    const transcriptWriter = {
        appendUserTextCommitted: async (
            text: string,
            options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
        ) => {
            const admission = await params.enqueueUserTextMessageCommitted(text, {
                localId: options.localId,
                meta: options.meta,
                provenance: { kind: 'non_dependent', source: 'external' },
            });
            if (!admission.persisted) {
                throw new Error('Execution-run user transcript row was not admitted to durable custody');
            }
            return admission;
        },
        appendAssistantTextCommitted: async (
            text: string,
            options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
        ) => {
            return await params.enqueueAgentMessageCommitted(
                parentProvider as ACPProvider,
                { type: 'message', message: text },
                {
                    localId: options.localId,
                    meta: options.meta,
                    provenance: { kind: 'non_dependent', source: 'external' },
                },
            );
        },
        commitVoiceAgentTranscriptTurn: async (turn: Readonly<{
            turnId: string;
            user: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }>;
            assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
        }>) => {
            const userTurn = readVoiceAgentTurnPayloadFromMeta(turn.user.meta);
            const assistantTurn = readVoiceAgentTurnPayloadFromMeta(turn.assistant.meta);
            if (!userTurn || !assistantTurn) {
                throw new Error('Voice-agent transcript turn metadata is required for durable pair commit');
            }
            if (
                userTurn.role !== 'user'
                || assistantTurn.role !== 'assistant'
                || userTurn.streamId !== turn.turnId
                || assistantTurn.streamId !== turn.turnId
                || userTurn.voiceAgentId !== assistantTurn.voiceAgentId
                || userTurn.runId !== assistantTurn.runId
                || userTurn.epoch !== assistantTurn.epoch
            ) {
                throw new Error('Voice-agent transcript pair must describe one canonical user/assistant turn');
            }
            return await params.enqueueVoiceAgentTranscriptTurnCommitted(parentProvider as ACPProvider, {
                turnId: turn.turnId,
                user: {
                    text: turn.user.text,
                    localId: turn.user.localId,
                    meta: turn.user.meta,
                },
                assistant: {
                    text: turn.assistant.text,
                    localId: deriveVoiceAgentTurnLocalId(assistantTurn),
                    meta: turn.assistant.meta,
                },
            });
        },
    };

    const resolveExecutionRunProfileCatalog = createRunnerExecutionRunSnapshotResolver({ sessionId: params.sessionId,
        ...(sessionMachineId ? { machineId: sessionMachineId } : {}) });
    const executionRunHandlersRegistration = registerExecutionRunHandlers(params.rpcHandlerManager, {
        sessionId: params.sessionId,
        resolveExecutionRunProfileCatalog: async (...input) => {
            // Explicit child selection skips applied-parent model readiness, but
            // native children still consume the owning Session's permission handler.
            if (sessionInteractionHost && !params.sessionRuntimeControls?.readPermissionHandler
                && params.waitForSessionRuntimeControls) {
                if (!await params.waitForSessionRuntimeControls(runtimeControlsLifetime.signal)) {
                    throw permissionOwnerUnavailable();
                }
                void sessionInteractionHost.permissionHandler;
            }
            if (disposed) throw permissionOwnerUnavailable();
            return await resolveExecutionRunProfileCatalog(...input);
        },
        readPromptCredentials: readOwnerAccountCredentials,
        ...(runtimeAccountId ? { resolveRunReportPolicy: createSessionRunReportPolicyReader({
            serverId: params.serverId, serverHttpBaseUrl: params.serverUrl, accountId: runtimeAccountId,
            readCredentials: readOwnerAccountCredentials, isCurrent: ownerAccountIsCurrent,
        }) } : {}),
        readModelProjection: createAccountScopedProviderModelProjectionReader({ serverUrl: params.serverUrl,
            readCredentials: readOwnerAccountCredentials, readAccountSettingsSnapshot: resolveOwnerAccountSettingsSnapshot,
            isCurrent: ownerAccountIsCurrent }),
        resolveManagedPurposeBindingIntent,
        prepareManagedEndpoint,
        resolveAgentStartContext: async (context) => {
            // Public Session RPC carries role identity, never private admission
            // facts. Materialize them here from this exact Session/Home owner.
            if (context.authority !== 'present_user') return null;
            const roleParams = await resolveCredentialedRoleParams(context.signal);
            if (!roleParams) {
                context.recordActionStartDiagnostic?.({ phase: 'agent_start_context', refusalReason: 'role_overrides_unavailable' });
                return null;
            }
            const deps = createCliActionDeps({
                ...roleParams,
                rawSession: { machineId: sessionMachineId, path: workingDirectory, workDepth: 0 },
                getCurrentSessionBackendTarget: () => parentSessionForTools?.getBackendTarget?.() ?? null,
            });
            return await runWithServerHttpBaseUrl(approvalServerApiUrl, () => deps.resolveAgentStartContext?.({ ...context,
                defaultSessionId: params.sessionId, callerPermissionMode: 'yolo' }) ?? null);
        },
        serverId: approvalServerId,
        resolveReviewCommentActor: () => {
            const target = params.session?.getBackendTarget?.();
            return target ? { kind: 'agent', agentId: resolveExecutionRunPublicBackendId(target), sessionId: params.sessionId } : null;
        },
        sessionList,
        ...(runtimeAccountId ? { runtimeAccountId } : {}),
        cwd: workingDirectory,
        ...(sessionMachineId.length > 0
            ? { machineId: sessionMachineId }
            : {}),
        ...(sessionInteractionHost ? { sessionInteractionHost } : {}),
        grantAttachedRunTeamVisibility: async ({ sessionId, teamId, requiredTeamCredential, signal: callerSignal }) => {
            const signal = callerSignal
                ? AbortSignal.any([callerSignal, runtimeControlsLifetime.signal]) : runtimeControlsLifetime.signal;
            if (sessionId !== params.sessionId) {
                return {
                    ok: false,
                    error: 'Execution-run parent Session scope changed',
                    errorCode: 'execution_run_scope_mismatch',
                };
            }
            const credentials = await readOwnerAccountCredentials();
            if (!credentials || credentials.token !== params.token) {
                return {
                    ok: false,
                    error: 'Session owner credentials are unavailable',
                    errorCode: 'execution_run_team_session_binding_unavailable',
                };
            }
            // The same Team grant the Home's own consent path writes
            // (`grantRequiredTeamVisibilityAndValidateBindingInTx`), through the
            // Session access owner's canonical Account adapter.
            const sessionAccessAction = createAccountServerActionDeps({
                token: credentials.token,
                credentials,
                isCredentialCurrent: async () => (await readOwnerAccountCredentials())?.token === credentials.token,
                serverId: approvalServerId,
                serverHttpBaseUrl: approvalServerApiUrl,
                ...(params.getServerFeaturesSnapshot
                    ? { resolveServerFeaturesSnapshot: params.getServerFeaturesSnapshot }
                    : {}),
            }).sessionAccessAction;
            if (!sessionAccessAction) {
                return {
                    ok: false,
                    error: 'Session access owner is unavailable',
                    errorCode: 'execution_run_team_session_binding_unavailable',
                };
            }
            try {
                const result = await sessionAccessAction({
                    actionId: 'session.access.grant.set',
                    input: SessionAccessGrantSetActionInputV1Schema.parse({
                        sessionId,
                        subject: { kind: 'team', teamId },
                        accessLevel: 'edit',
                        canApprovePermissions: false,
                        requiredTeamCredential,
                    }),
                    context: {},
                    signal,
                });
                const failure = result && typeof result === 'object' && 'ok' in result && result.ok === false
                    ? result as Readonly<{ errorCode?: unknown }>
                    : null;
                if (!failure) return { ok: true };
                return {
                    ok: false,
                    error: 'The Session could not be made visible to the selected Team',
                    // Run-start's strict detail projection cannot retain a nested
                    // Action failure. Keep issued-mutation uncertainty in its code.
                    errorCode: failure.errorCode === 'outcome_unknown'
                        ? 'outcome_unknown' : 'execution_run_team_session_binding_rejected',
                    details: failure,
                };
            } catch (error) {
                return {
                    ok: false,
                    error: error instanceof Error ? error.message : 'Team visibility grant failed',
                    errorCode: 'execution_run_team_session_binding_rejected',
                };
            }
        },
        onManagerCreated: (manager) => {
            executionRunManager = manager;
            params.session?.setExecutionRunWorkerUpdateSource(manager);
            if (parentSessionForTools?.subscribeExecutionRunPendingTarget) {
                parentSessionForTools.subscribeExecutionRunPendingTarget((runId) =>
                    manager.reconcilePendingExecutionRunTarget(runId));
            }
        },
        serverUrl: approvalServerApiUrl,
        readRequesterWorkAttributionV1,
        parentProvider,
        browserControl: params.getBrowserDaemonControlRoutes?.() ?? null,
        browserContext: params.getBrowserDaemonContextRoutes?.() ?? null,
        browserAutomation: params.getBrowserDaemonAutomationRoutes?.() ?? null,
        getBrowserUiAutomation: params.getBrowserUiAutomation ?? undefined,
        browserDiagnostics: params.getBrowserDiagnosticsActionRoutes?.() ?? null,
        browserRecording: params.getBrowserRecordingRoutes?.() ?? null,
        attachBrowserRecordingToComposer: params.attachBrowserRecordingToComposer,
        localServices: params.getLocalServicesRuntimeActionRoutes?.() ?? null,
        simulatorPreview: params.getSimulatorPreviewRoutes?.() ?? null,
        peerMediationObservability: params.getPeerMediationObservabilityRuntimeActionContext?.() ?? null,
        // G9-E: forward the daemon-wide cached server-features accessor so the runtime-action front
        // door's feature gate reads the live server bits cold instead of failing closed.
        ...(params.getServerFeaturesSnapshot ? { getServerFeaturesSnapshot: params.getServerFeaturesSnapshot } : {}),
        sendAcp: async (provider, body, opts) => {
            const normalizedBody = body as ACPMessageData;
            const localId = 'id' in normalizedBody && typeof normalizedBody.id === 'string'
                ? normalizedBody.id
                : randomUUID();
            const admission = await params.enqueueAgentMessageCommitted(
                provider as ACPProvider,
                normalizedBody,
                {
                    localId,
                    ...(opts?.meta ? { meta: opts.meta } : {}),
                    provenance: {
                        kind: 'non_dependent',
                        // The final Run result belongs on its parent's tool call,
                        // but retains the same independent Run output custody.
                        source: 'sidechain',
                    },
                },
            );
            if (!admission.persisted) {
                throw createExecutionRunTranscriptCustodyError();
            }
        },
        streamedTranscriptSession: {
            sendAgentMessageEphemeral: (provider, body, opts) =>
                params.sendAgentMessageEphemeral(provider as ACPProvider, body as ACPMessageData, opts),
            sendAgentMessageEphemeralDelta:
                typeof params.sendAgentMessageEphemeralDelta === 'function'
                    ? (provider, body, opts) =>
                        params.sendAgentMessageEphemeralDelta!(provider as ACPProvider, body as ACPMessageData, opts)
                    : undefined,
            getEphemeralStreamConnectionEpoch: params.getEphemeralStreamConnectionEpoch,
            enqueueAgentMessageCommitted: (provider, body, opts) =>
                params.enqueueAgentMessageCommitted(provider as ACPProvider, body as ACPMessageData, opts),
        },
        transcriptWriter,
        budgetRegistry: executionBudgetRegistry,
        getPermissionRequestStore: params.getAgentStateRequestStore,
        parentSessionStateTarget: typeof params.enqueueRegisteredSessionStateFieldMutation === 'function'
            ? {
                sessionId: params.sessionId,
                enqueueRegisteredSessionStateFieldMutation: params.enqueueRegisteredSessionStateFieldMutation,
            }
            : null,
        onExecutionRunPublicStateUpdated: (run) => {
            try {
                params.observeExecutionRunPublicState?.(run);
                params.persistVoiceAgentRunMetadataFromPublicRun(run);
                params.socketEmitExecutionRunUpdated(run);
            } catch {
                // best effort
            }
        },
        onExecutionRunVoiceAgentWelcomed: (run, welcomedEpoch) => {
            params.persistVoiceAgentRunMetadataFromPublicRun(run, welcomedEpoch);
        },
        policy: {
            maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
            boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
            reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
            maxTurns: configuration.executionRunsMaxTurns,
        },
        resolveAccountSettings: async (actionId) => {
            // Restricted Session readers carry host-reviewed policy, not owner
            // Account credentials. Their Action owner still admits the exact
            // principal/corpus; resolving policy must not demand owner material.
            if (actionId === 'session.list' && !await ownerAccountIsCurrent() && !disposed) {
                return actionsSettingsProvider.getAccountSettings?.() ?? null;
            }
            return await resolveOwnerAccountSettings();
        },
        resolveAccountSettingsSnapshot: resolveOwnerAccountSettingsSnapshot,
        get savedSecretOperationContext() { return ownerAccountOperationContext; },
        actionsSettingsProvider,
        actionApprovalDeps: createExecutionRunRpcApprovalDeps({
            readCredentials: readOwnerAccountCredentials,
            isApprovalExecutionOriginCurrent,
            resolveReviewHostPluginAuthority: createRunnerReviewHostPluginAuthorityReader(params.sessionId),
        }),
    });
    let executionRunsDisposal: Promise<void> | null = null;
    const disposeExecutionRuns = (): Promise<void> => {
        disposed = true;
        runtimeControlsLifetime.abort();
        executionRunsDisposal ??= Promise.resolve().then(() => executionRunManager?.dispose?.());
        return executionRunsDisposal;
    };
    let disposePromise: Promise<void> | null = null;
    return { refreshDemandedMcpCatalog: ownerAccountSnapshots.refreshDemandedMcpCatalog,
        resolveSessionAttachment: sessionHandlersRegistration.resolveSessionAttachment,
        disposeExecutionRuns,
        dispose: () => {
            disposePromise ??= (async () => {
                try {
                    // Child native runtimes belong to this Session, including
                    // idle retained Runs. Retire them before their Account and
                    // transport resources are withdrawn by Session close.
                    await disposeExecutionRuns();
                } finally {
                    executionRunHandlersRegistration.dispose();
                    try { await ownerAccountSnapshots.dispose(); }
                    finally { await sessionHandlersRegistration.dispose(); }
                }
            })();
            return disposePromise;
        } };
}
