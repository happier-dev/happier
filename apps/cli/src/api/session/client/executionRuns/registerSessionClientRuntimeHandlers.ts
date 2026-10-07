import { randomUUID } from 'node:crypto';

import { resolveAgentIdFromSessionMetadata, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { parseSessionPermissionModeAlias } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { SessionAccessGrantSetActionInputV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import type { AccountSettings, ActionExecutorDeps, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { notifyDaemonConnectedServiceUsageLimitWaitResumeCancel } from '@/daemon/controlClient';
import { createExecutionBudgetRegistry } from '@/daemon/executionBudget/createExecutionBudgetRegistry';
import type { StoredCredentials } from '@/persistence';
import {
    createActionSettingsProvider,
    type RuntimeActionSettingsProvider,
} from '@/settings/actionsSettingsProvider';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { applyRunnerMcpSessionContext, type RunnerMcpSessionWithContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import type { NativeAgentSessionRunToolBindingRequest } from '@/agent/runtime/registry/engineRegistryTypes';

import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerSessionRoleConfigurationHandler } from '@/rpc/handlers/sessionRoleConfiguration';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { ROLE_ACTION_IDS_V1 } from '@happier-dev/protocol/prompts/roles/roleActionIdsV1';
import type { RoleSourceReader } from '@/session/roles/roleSources';
import type { RoleWorkspaceWritesPolicyPreparer } from '@/session/actions/roleActions';
import type { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createExecutionRunRpcApprovalDeps } from '@/rpc/handlers/executionRuns/createExecutionRunRpcApprovalDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import {
    createRestrictedCurrentSessionListActionDependency,
    createSessionListActionDependency,
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
import { fetchSessionById, importHistoricalSessionTranscript } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator, resolveAccountVoiceFollowDisclosure } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { resolveSessionFollowContextUtf8AllowanceV1 } from '@/agent/runtime/session/follow/sessionFollowContextBudget';

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
        sessionId: string;
        session?: RunnerMcpSessionWithContext<ApiSessionClient>;
        getSessionMetadata: () => Metadata | null;
        readRoleSources?: RoleSourceReader;
        getCurrentResolvedRoles?: () => import('@happier-dev/protocol').ResolvedRolesSnapshotV1;
        getCurrentWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
        prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
        sessionRuntimeControls?: SessionRuntimeControls | null;
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
): ReturnType<typeof registerSessionHandlers> {
    const readOwnerAccountCredentials = params.readOwnerAccountCredentials;
    const actionsSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider({
        scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
    });
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
    const sessionMachineId = typeof (params.metadata as { machineId?: unknown })?.machineId === 'string'
        ? (params.metadata as { machineId: string }).machineId.trim()
        : '';
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
    const resolveOwnerAccountSettingsSnapshot = async (input?: Readonly<{
        secretReferenceOverlay?: import('@happier-dev/protocol').SecretReferenceOverlayV1;
    }>) => {
        const credentials = await readOwnerAccountCredentials();
        if (!credentials) {
            ownerAccountSettingsForRuntime = null;
            return null;
        }
        const context = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
        const operationSnapshot = input?.secretReferenceOverlay
            ? await refreshSavedSecretCatalogForOperation({
                expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                secretReferenceOverlay: input.secretReferenceOverlay,
            })
            : null;
        const resolved = operationSnapshot ?? context;
        ownerAccountSettingsForRuntime = resolved.settings ?? null;
        return resolved;
    };
    const resolveOwnerAccountSettings = async (): Promise<AccountSettings | null> => {
        return (await resolveOwnerAccountSettingsSnapshot())?.settings ?? null;
    };
    const readCodingPromptBehavior = () => params.sessionRuntimeControls?.readCodingPromptBehavior?.() ?? null;
    const sessionInteractionHost = parentSessionForTools
        ? {
            session: parentSessionForTools,
            machineId: sessionMachineId,
            readCodingPromptBehavior,
            permissionHandler: createProviderEnforcedPermissionHandler({
                session: parentSessionForTools,
                logPrefix: '[Voice Agent Session]',
                getAccountSettings: () => ownerAccountSettingsForRuntime,
                getCodingPromptBehavior: readCodingPromptBehavior,
            }),
            ...(typeof params.sessionRuntimeControls?.listSkills === 'function'
                ? { listSkills: () => params.sessionRuntimeControls!.listSkills!() }
                : {}),
            ...(typeof params.sessionRuntimeControls?.listVendorPlugins === 'function'
                ? { listVendorPlugins: () => params.sessionRuntimeControls!.listVendorPlugins!() }
                : {}),
            ...(typeof params.sessionRuntimeControls?.resolveComposerReference === 'function'
                ? { resolveComposerReference: params.sessionRuntimeControls.resolveComposerReference }
                : {}),
            ...(typeof params.sessionRuntimeControls?.resolveComposerAttachmentForDispatch === 'function'
                ? { resolveComposerAttachmentForDispatch: params.sessionRuntimeControls.resolveComposerAttachmentForDispatch }
                : {}),
            prepareRunTeamCredentialProviderBinding: async ({ runId, agentId, selection: explicitSelection }: Readonly<{
                runId: string;
                agentId: string;
                selection?: TeamCredentialProviderModelSelectionV1;
            }>) => {
                const prepare = params.sessionRuntimeControls?.prepareRunTeamCredentialProviderBinding;
                if (!prepare) return null;
                const inherited = explicitSelection
                    ? null
                    : SessionModelSelectionV2Schema.safeParse(
                        (parentSessionForTools.getMetadataSnapshot() as Record<string, unknown> | null)?.modelSelectionIntentV2,
                    );
                const resourceId = explicitSelection?.resourceId
                    ?? (inherited?.success && inherited.data.ref.source === 'team_resource'
                        ? inherited.data.ref.resourceId
                        : null);
                const modelId = explicitSelection?.modelId
                    ?? (inherited?.success && inherited.data.ref.source === 'team_resource'
                        ? inherited.data.ref.modelId
                        : null);
                if (!resourceId || !modelId) return null;
                return await prepare({
                    runId,
                    agentId,
                    resourceId,
                    modelId,
                    ...(explicitSelection ? { selection: explicitSelection } : {}),
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
            composeRunToolBinding: async (request: NativeAgentSessionRunToolBindingRequest) => {
                const ownerCredentials = await readOwnerAccountCredentials();
                const credentials = ownerCredentials ?? restrictedRuntimeAdmission?.credentials ?? null;
                if (!credentials) return {
                    supportedSessionReadActions: [],
                    dispose: () => undefined,
                };
                const { toAgentSessionMcpLaunchConfigs } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSession');
                const accountSettingsSnapshot = ownerCredentials
                    ? await resolveOwnerAccountSettingsSnapshot()
                    : null;
                const accountSettings = accountSettingsSnapshot?.settings ?? null;
                // An explicit view, not a spread of the live client: the durable
                // Session client owns prototype-bound behavior the MCP seam must
                // reach through its real methods.
                const parentMcpSession: HappyMcpSessionClient = applyRunnerMcpSessionContext({
                    sessionId: parentSessionForTools.sessionId,
                    rpcHandlerManager: params.rpcHandlerManager,
                    updateMetadata: (updater) => parentSessionForTools.updateMetadata(updater),
                    getMetadataSnapshot: () => parentSessionForTools.getMetadataSnapshot(),
                    getBackendTarget: () => parentSessionForTools.getBackendTarget?.() ?? null,
                    getServerBinding: () => ({
                        serverId: approvalServerId,
                        serverUrl: approvalServerApiUrl,
                    }),
                    confirmSessionAction: (confirmation, binding) =>
                        parentSessionForTools.confirmSessionAction(confirmation, binding),
                    // The Run's Board and Discussions are its parent Session's,
                    // opened with the material this client already holds.
                    getStoredContentEncryptionContext: () => transcriptQueryContext.encryptionMode === 'plain'
                        ? { mode: 'plain' as const }
                        : { mode: 'e2ee' as const, ctx: transcriptQueryContext },
                }, {
                    getCurrentSessionLocation: () => ({
                        path: workingDirectory,
                        machineId: sessionMachineId,
                    }),
                });
                const resolved = await resolveRunnerMcpServers({
                    session: parentMcpSession,
                    credentials,
                    accountCredentials: ownerCredentials,
                    sessionList,
                    accountSettings,
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
                return {
                    ...(mcpServers ? { mcpServers } : {}),
                    supportedSessionReadActions: resolved.happierMcpServer.supportedSessionReadActions,
                    dispose: () => resolved.happierMcpServer.stop(),
                };
            },
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
            ? createSessionListActionDependency({
                credentials,
                serverId: approvalServerId,
                serverHttpBaseUrl: approvalServerApiUrl,
            })
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
    const sessionActionParams = {
        token: params.token,
        sessionId: params.sessionId,
        getCurrentSessionMetadata: params.getSessionMetadata,
        readRoleSources: params.readRoleSources ?? parentSessionForTools?.readRoleSources,
        getCurrentResolvedRoles: params.getCurrentResolvedRoles ?? (parentSessionForTools?.getCurrentResolvedRoles
            ? () => parentSessionForTools.getCurrentResolvedRoles!() : undefined),
        getCurrentWorkspaceWrites: params.getCurrentWorkspaceWrites ?? (parentSessionForTools?.getCurrentWorkspaceWrites
            ? () => parentSessionForTools.getCurrentWorkspaceWrites!() : undefined),
        prepareWorkspaceWritesPolicy: params.prepareWorkspaceWritesPolicy ?? parentSessionForTools?.prepareWorkspaceWritesPolicy,
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
    const resolveCredentialedRoleParams = async () => runWithServerHttpBaseUrl(approvalServerApiUrl, async () => {
        const credentials = await readOwnerAccountCredentials();
        if (!credentials || readAccountIdFromToken(credentials.token) !== runtimeAccountId) return null;
        await resolveOwnerAccountSettings();
        return { ...sessionActionParams, token: credentials.token, credentials,
            serverId: approvalServerId, serverHttpBaseUrl: approvalServerApiUrl };
    });

    registerActionSpecRpcHandlers({
        rpcHandlerManager: params.rpcHandlerManager,
        resolveActionExecutor: async () => {
            const roleParams = await resolveCredentialedRoleParams();
            return roleParams ? createCliActionExecutor(roleParams) : transcriptActionExecutor;
        },
        actionIds: ROLE_ACTION_IDS_V1.filter((actionId) => actionId.startsWith('session.')),
    });
    registerSessionRoleConfigurationHandler({
        rpcHandlerManager: params.rpcHandlerManager,
        sessionId: params.sessionId,
        readSessionMetadata: params.getSessionMetadata,
        readRoleSources: params.readRoleSources ?? parentSessionForTools?.readRoleSources,
        prepareWorkspaceWritesPolicy: params.prepareWorkspaceWritesPolicy ?? parentSessionForTools?.prepareWorkspaceWritesPolicy,
        readSettingsOverrides: async () => runWithServerHttpBaseUrl(approvalServerApiUrl,
            async () => (await resolveOwnerAccountSettings())?.rolesV1.overrides ?? {}),
        resolveAgentStartContext: async (context) => {
            const roleParams = await resolveCredentialedRoleParams();
            if (!roleParams) return null;
            return await runWithServerHttpBaseUrl(approvalServerApiUrl, () =>
                createCliActionDeps(roleParams).resolveAgentStartContext?.(context) ?? null);
        },
        sessionList: async (input) => {
            const roleParams = await resolveCredentialedRoleParams();
            if (!roleParams) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
            return await createSessionListActionDependency({ credentials: roleParams.credentials,
                serverId: approvalServerId, serverHttpBaseUrl: approvalServerApiUrl })(input);
        },
        readCurrentReportLead: async (signal) => {
            const roleParams = await resolveCredentialedRoleParams();
            if (!roleParams) return null;
            const session = await runWithServerHttpBaseUrl(approvalServerApiUrl, () => fetchSessionById({
                token: roleParams.token, sessionId: params.sessionId, signal, accessProjectionVersion: 1,
            }));
            return session?.effectiveAccess?.level === 'owner' ? session.reportsTo?.sessionId ?? null : null;
        },
        readCallerWorkspaceWrites: async (context) => {
            if (context.actionCaller?.kind !== 'session') return null;
            const roleParams = await resolveCredentialedRoleParams();
            if (!roleParams) return null;
            const sessionId = context.actionCaller.sessionId;
            const transport = await runWithServerHttpBaseUrl(approvalServerApiUrl, () => resolveSessionTransportContext({
                credentials: roleParams.credentials, idOrPrefix: sessionId, signal: context.signal,
            }));
            if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.effectiveAccess?.level !== 'owner') return null;
            const metadata = tryDecryptSessionOwnerMetadataView({ credentials: roleParams.credentials,
                accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession });
            if (!metadata) return null;
            const sources = await runWithServerHttpBaseUrl(approvalServerApiUrl,
                async () => await roleParams.readRoleSources?.(context.signal) ?? []);
            return readSessionWorkspaceWritesV1(metadata, {
                settingsRoles: Object.fromEntries(sources.map((entry) => [entry.roleId, entry.role])),
                settingsOverrides: actionsSettingsProvider.getAccountSettings?.()?.rolesV1.overrides,
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
        sessionRuntimeControls: params.sessionRuntimeControls ?? null,
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

    registerExecutionRunHandlers(params.rpcHandlerManager, {
        sessionId: params.sessionId,
        readPromptCredentials: readOwnerAccountCredentials,
        resolveAgentStartContext: async (context) => {
            // Public Session RPC carries role identity, never private admission
            // facts. Materialize them here from this exact Session/Home owner.
            if (context.authority !== 'present_user') return null;
            const credentials = await readOwnerAccountCredentials();
            const deps = createCliActionDeps({
                token: params.token,
                ...(credentials ? { credentials } : {}),
                serverId: approvalServerId, serverHttpBaseUrl: approvalServerApiUrl,
                sessionId: params.sessionId,
                rawSession: { machineId: sessionMachineId, path: workingDirectory, workDepth: 0 },
                getCurrentSessionMetadata: params.getSessionMetadata,
                getCurrentSessionBackendTarget: () => parentSessionForTools?.getBackendTarget?.() ?? null,
                readRoleSources: params.readRoleSources ?? parentSessionForTools?.readRoleSources,
                actionsSettingsProvider, ...transcriptTransportContext,
            });
            return await deps.resolveAgentStartContext?.({ ...context,
                defaultSessionId: params.sessionId, callerPermissionMode: 'yolo' }) ?? null;
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
        grantAttachedRunTeamVisibility: async ({ sessionId, teamId, requiredTeamCredential }) => {
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
                });
                const failure = result && typeof result === 'object' && 'ok' in result && result.ok === false
                    ? result as Readonly<{ errorCode?: unknown }>
                    : null;
                if (!failure) return { ok: true };
                return {
                    ok: false,
                    error: 'The Session could not be made visible to the selected Team',
                    errorCode: 'execution_run_team_session_binding_rejected',
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
                        source: 'sidechainId' in normalizedBody && typeof normalizedBody.sidechainId === 'string'
                            ? 'sidechain'
                            : 'external',
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
        resolveAccountSettings: async () => {
            return await resolveOwnerAccountSettings();
        },
        resolveAccountSettingsSnapshot: resolveOwnerAccountSettingsSnapshot,
        actionsSettingsProvider,
        actionApprovalDeps: createExecutionRunRpcApprovalDeps({
            readCredentials: readOwnerAccountCredentials,
            isApprovalExecutionOriginCurrent,
        }),
    });
    return sessionHandlersRegistration;
}
