/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import axios from 'axios';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, TeamCredentialExternalProviderOperationRetireV1Schema, TeamCredentialExternalProviderOperationRetireResponseV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { randomBytes } from 'node:crypto';
import { MachineLiveStreamDecodedEnvelopeV1Schema, MachineLiveStreamRelayEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { hasMachineLiveStreamSensitiveContentV1, sealMachineLiveStreamEnvelopeV1, openMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import type { MachineLiveStreamPayloadErrorCodeV1, MachineLiveStreamWireEnvelopeV1 } from '@happier-dev/protocol';
import { isDeepStrictEqual } from 'node:util';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readStoredCredentials, readStoredCredentialsForServerId } from '@/persistence';
import { createExecutionRunRpcApprovalDeps } from '@/rpc/handlers/executionRuns/createExecutionRunRpcApprovalDeps';
import {
    readCurrentMessageActionReferenceRowV1,
    resolveMessageActionReferenceSnapshotV1,
} from '@/api/session/messageActionReference';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { FeaturesResponse, IrohEndpointDescriptorV1, ActionOperationRevisionEphemeralV1, ConnectedServiceExecutionAuthorityV1, ExternalSessionSourceUnavailableOccurrenceV1 } from '@happier-dev/protocol';
import { ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { fetchAccountProfile } from './accountProfile';
import { fetchAccountEncryptionCurrentness } from './client/connectedServiceCredentialApi';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { resolveMachineSessionInputAdmissionCapability } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { createCurrentMachineExecutionOriginContextResolver } from './machine/resolveCurrentMachineExecutionOriginContext';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { callSocketRpc, isSocketIoAckTimeoutError, type SocketRpcContent } from '@happier-dev/sync-client';
import type { SessionActionRpcTransport } from '@/session/actions/createCliActionDeps';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerAutomationReplyHandoffRpcHandler } from '@/rpc/handlers/automationReplyHandoff';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
    resolveExternalSessionOperationAccountScope,
    type ExternalSessionOperationAccountScope,
} from '@/session/actions/externalSessions/operationRecordStore';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import {
    createTrackedSessionHandoffCoordinator,
    createHostActionOperationRuntime,
    type HostActionOperationRuntime,
} from '@/daemon/actionOperations';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import {
    registerDaemonLocalServicePreviewSnapshotHandler,
} from '@/rpc/handlers/daemonLocalServicePreviewSnapshot';
import {
    registerDaemonLocalServicesMachineRpcHandlers,
    type DaemonLocalServicesMachineRpcRoutes,
} from '@/rpc/handlers/daemonLocalServices';
import {
    registerDaemonBrowserControlHandler,
} from '@/rpc/handlers/daemonBrowserControl';
import { registerDaemonComputerHandler } from '@/rpc/handlers/daemonComputer';
import type { ComputerRoutes } from '@/daemon/computer/routes';
import {
    registerDaemonBrowserContextHandler,
} from '@/rpc/handlers/daemonBrowserContext';
import {
    registerDaemonBrowserDiagnosticsSnapshotHandler,
} from '@/rpc/handlers/daemonBrowserDiagnosticsSnapshot';
import {
    registerDaemonBrowserRecordingHandlers,
} from '@/rpc/handlers/daemonBrowserRecording';
import {
    registerDaemonSimulatorPreviewHandlers,
} from '@/rpc/handlers/daemonSimulatorPreview';
import {
    registerDaemonLiveStreamRelayHandlers,
    type DaemonLiveStreamRelayRoutes,
} from '@/rpc/handlers/daemonLiveStreamRelay';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { registerWorkspaceAnchorHandlers } from '@/rpc/handlers/workspaceAnchors/registerWorkspaceAnchorHandlers';
import { registerWorkspaceFaviconHandlers } from '@/rpc/handlers/workspaceFavicon/registerWorkspaceFaviconHandlers';
import { backoff } from '@/utils/time';
import { createConnectedServicesProjectionRetryScheduler } from './connectedServices/connectedServicesProjectionRetryScheduler';
import { isConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import {
    RpcHandlerManager,
    type RpcHandlerRegistrationReadiness,
} from './rpc/RpcHandlerManager';
import type { RpcHandlerActiveExecution, RpcHandlerInvoker, RpcLocalActionContext } from './rpc/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1 } from '@happier-dev/protocol/sessions/external/operationActionsV1';
import { EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1 } from '@happier-dev/protocol/sessions/external/statusDemandV1';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol/transfers/relay/v2/socketEvents';
import type { ExternalSessionTranscriptInvalidationV1, ExternalSessionOperationSocketCommandV1, ExternalSessionOperationSocketResponseV1, ExternalSessionStatusDemandDaemonMessageV1, MachineLiveStreamRelayEnvelopeV1, MachineTransferReceiveEnvelope, MachineTransferSendEnvelope, PeerTcpTunnelRelayEnvelope, ExactSessionTurnEndMutationV1, TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { fetchChanges, fetchChangesAccountId } from './changes';
import { readAccountChangesCursor, writeAccountChangesCursor } from '@/persistence';
import {
    publishPluginAccountCollectionWatchInvalidation,
    publishPluginAccountSettingsWatchInvalidation,
    readPluginAccountCollectionWatchInvalidations,
    readPluginAccountSettingsWatchInvalidations,
    retirePluginAccountCollectionWatchScope,
} from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { hydrateSavedSecretCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { changesRequireSavedSecretCatalogRefresh } from '@/settings/secrets/savedSecretCatalogChangeInvalidation';
import {
    resolveServerHttpBaseUrl,
    resolveServerSocketIoTransports,
} from './client/serverHttpBaseUrl';
import { createAuthenticationHttpStatusError, isAuthenticationError, isAuthenticationStatus } from './client/httpStatusError';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import {
    createSessionSyncPendingInputServerContractController,
    type SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { createTransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { ConnectedAccountDaemonRuntime } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import { readAuthoritativeSessionDeletionChangeV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    registerMachineRpcHandlers,
    type MachineRpcHandlerDeps,
    type MachineRpcHandlers,
    type MachineRpcLifecycleRegistration,
} from './machine/rpcHandlers';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import {
    createMachineContentCodec,
    type MachineContentCodec,
} from './machine/machineStoredContent';
import {
    registerMachineConnectedAccountRpcHandlers,
} from './machine/rpcHandlers.connectedAccounts';
import { authorizeMachineRpcRequest } from './machine/machineRpcAuthorization';
import { projectIncomingMachineRpcDebugPayload } from './machine/projectIncomingMachineRpcDebugPayload';
import { projectMachineRpcTransportAcknowledgement } from './machine/projectMachineRpcTransportAcknowledgement';
import { resolveMachineRpcWorkingDirectory } from './machine/resolveMachineRpcWorkingDirectory';
import {
    resolveFilesystemAccessPolicy,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { createTransferSessionLifecycle } from '@happier-dev/transfers/node';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import type { TransferRelayV2DownloadSessionOwner } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { Socket } from 'socket.io-client';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createMachineSocketTransport } from '@/api/machine/connection/createMachineSocketTransport';
import {
    CURRENT_SESSION_RUNTIME_OPERATION_PROTOCOL_CAPABILITIES_V1,
    publishMachineOperationProtocolCapabilitiesOnSocket,
} from '@/api/machine/publishMachineOperationProtocolCapabilities';
import { publishSessionFollowWakeInvalidation } from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import { readMachineOwnerConflictFromSocketError, type MachineOwnerConflictDetails } from '@/api/machine/machineOwnerConflict';
import { readAccountSettingsVersionFromHint } from '@/settings/accountSettings/accountSettingsVersion';
import { buildInstallationProofForMachine } from '@/daemon/identity/proof';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import {
    emitSocketWithAck,
    SocketAckAbortError,
    SocketAckError,
} from '@/session/transport/shared/socketAck';
import { resolveSessionControlSocketAckTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
    createDaemonSessionClientDurableMutationOutbox,
    type DaemonSessionClientDurableMutationOutbox,
} from './session/client/transport/mutations/createDaemonSessionClientDurableMutationOutbox';
import {
    discoverDaemonSessionClientDurableMutationJournalSessionIds,
} from './session/client/transport/mutations/sessionClientDurableMutationPersistence';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, MachineSessionTerminalCaptureResponseV1Schema, MachineSessionTerminalFinalizeResponseV1Schema } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { SESSION_SERVER_START_DAEMON_RPC_METHOD_V1, SESSION_SERVER_START_INGRESS_EVENT_V1, SessionServerStartDispatchResultV1Schema, SessionServerStartIngressRequestV1Schema, SessionServerStartIngressResponseV1Schema } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema, SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2, SessionPendingExecutionRunEnqueueByMachineRequestV2Schema, SessionPendingExecutionRunEnqueueByMachineResponseV2Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import type { SessionPendingExecutionRunEnqueueByMachineRequestV2, MachineOperationProtocolCapabilitiesV1, MachineSessionTerminalAuthorityV1, MachineSessionTerminalCaptureResponseV1, MachineSessionTerminalFinalizeResponseV1, SessionPendingEnqueueByMachineRequestV1, SessionInputAdmissionResultV1, SessionServerStartDispatchResultV1, SessionServerStartIngressRequestV1 } from '@happier-dev/protocol';
import { ACCOUNT_STORED_CONTENT_SESSION_SPAWN_PLACEMENT_ORIGIN_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

export type AccountSettingsVersionHintSource = 'changes' | 'cursor-gone' | 'page-limit';

export function emitActionOperationSnapshotV1(params: Readonly<{
    socket: Pick<Socket<ServerToDaemonEvents, DaemonToServerEvents>, 'emit'> | null;
    machineId: string;
    ciphertext: string;
}>): void {
    params.socket?.emit(ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, {
        type: ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1,
        machineId: params.machineId,
        content: { t: 'encrypted', c: params.ciphertext },
    });
}

const REQUIRED_MACHINE_CONTROL_RPC_METHODS = Object.freeze([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW,
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    RPC_METHODS.STOP_SESSION,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
]);
const MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS = 10_000;

// Published only after the authenticated Machine enqueue and exact target
// settlement paths are both installed. The server uses this leaf as a strict
// admission prerequisite, so absent/older daemons continue to fail closed.
export const CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1:
    MachineOperationProtocolCapabilitiesV1 = Object.freeze({
        ...CURRENT_SESSION_RUNTIME_OPERATION_PROTOCOL_CAPABILITIES_V1,
        // Ordinary and restricted Session construction always installs the exact
        // Session/reconnect -> process Follow wake consumer. AccountChange adds
        // completeness invalidation when its optional feed is enabled.
        sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
        sessionInputAdmission: { protocolVersions: [1, 2] as const },
        sessionSpawn: { protocolVersions: [1, 2] as const },
        pluginWebhookClaim: { protocolVersions: [1] },
        externalActionExecutionAuthorization: { protocolVersions: [1] },
    });

export type AccountSettingsVersionHintNotification = Readonly<{
    settingsVersion: number | null;
    source: AccountSettingsVersionHintSource;
}>;

export type PendingSessionActivationHintNotification = Readonly<{
    sessionId: string;
    requestId: string;
    pendingVersion: number;
    source: 'changes' | 'live';
}>;

export type SessionDeletedChangeNotification = Readonly<{
    sessionId: string;
    cursor: number;
    /**
     * Pinned operation scope of the authenticated Account whose changes feed
     * delivered this durable deletion fact. Authoritative cleanup targets
     * exactly this Account's partition even if the ambient credentials rotate
     * before the listener runs.
     */
    accountScope: ExternalSessionOperationAccountScope;
}>;

/**
 * Durable Account-relative loss of access to a Session, proven by the
 * `/v2/changes` Session-access witness. Unlike a physical deletion it carries
 * no lifecycle hint: the witness itself is the authority. Consumers that hold
 * derived local state for the Session must clear it before the Account change
 * cursor advances, so the fact replays when their cleanup fails.
 */
export type SessionAccessRevokedNotification = Readonly<{
    sessionId: string;
    cursor: number;
}>;

/**
 * The Account change cursor is no longer replayable. Consumers with finite
 * derived Session state must re-check that retained set before the replacement
 * cursor is acknowledged.
 */
export type SessionAccessResetNotification = Readonly<{
    cursor: number;
}>;

export type ManagedProviderRetainedCurrentnessInvalidation = Readonly<{
    source: 'connect' | 'reconnect' | 'changes' | 'page-limit' | 'cursor-gone';
    signal: AbortSignal;
}>;

export type ConnectedServicesProjectionNotification = Readonly<{
    source: AccountSettingsVersionHintSource | 'startup' | 'reconnect' | 'live';
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
    signal: AbortSignal;
    connectedServicesV2: unknown;
    connectedServiceCredentialRevisionsV1: unknown;
}>;

export type ApiMachineClientLifecycleDependencies = Readonly<{
    liveStreamCaptureRegistry?: import('@/daemon/peer/mediation/stream/captureRegistry').MachineLiveStreamCaptureRegistry;
    resolveHostedSessionWorkingDirectory?: (sessionId: string) => Promise<string | null>;
    isDaemonQuiescing?: () => boolean;
    resolveServerFeaturesSnapshot?: () => Promise<Awaited<ReturnType<typeof fetchServerFeaturesSnapshot>> | undefined>;
    createCapabilitiesApiClient?: MachineRpcHandlerDeps['createCapabilitiesApiClient'];
    /** Test seam for the canonical Resource lifecycle owner. */
    resourceSessionLifecycle?: Pick<
        PluginReloadController,
        'applyResourceSessionAccessWitness'
    >;
    /** Daemon-owned workspace-sync adapter shared with the canonical handoff coordinator. */
    workspaceSyncHandoffAdapter?: WorkspaceSyncHandoffAdapter;
    /** Daemon-owned workspace-sync controller and target-local RPC authority. */
    workspaceSync?: MachineRpcHandlerDeps['workspaceSync'];
}>;

export type ApiMachineDaemonStatePublicationOptions = Readonly<{
    allowWhileQuiescing?: boolean;
}>;

export type MachinePublicationOutcome = 'published' | 'unchanged' | 'suppressed';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readSocketConnectErrorDiagnostic(error: unknown): Readonly<{
    message?: string;
    name?: string;
    code?: string;
    statusCode?: number;
}> {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const statusRaw = data?.statusCode ?? data?.status;
    const statusCode = typeof statusRaw === 'number' && Number.isFinite(statusRaw)
        ? statusRaw
        : null;
    return {
        ...(typeof record?.message === 'string' && record.message.trim() ? { message: record.message.trim() } : {}),
        ...(typeof record?.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
        ...(typeof record?.code === 'string' && record.code.trim() ? { code: record.code.trim() } : {}),
        ...(statusCode !== null ? { statusCode } : {}),
    };
}

function isMachineReplacedSocketError(error: unknown): boolean {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const errorCode = typeof data?.error === 'string' ? data.error.trim() : '';
    const message = typeof record?.message === 'string' ? record.message.trim() : '';
    const statusRaw = data?.statusCode ?? data?.status;
    const statusCode = typeof statusRaw === 'number' && Number.isFinite(statusRaw) ? statusRaw : null;
    return statusCode === 410 && (errorCode === 'machine-replaced' || errorCode === 'machine_replaced' || message === 'machine-replaced');
}

/** Serialize the consumed machine activity stream through one Account encryption boundary. */
export function createActionOperationSnapshotPublisher(input: Readonly<{
    resolveAccountId(): Promise<string | null>;
    readCredentials?: typeof readStoredCredentials;
    publishCiphertext(ciphertext: string): void;
}>) {
    let pending = Promise.resolve();
    return (snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): Promise<void> => {
        pending = pending.then(async () => {
            const credentials = await (input.readCredentials ?? readStoredCredentials)().catch(() => null);
            if (!credentials?.encryption) return;
            const accountId = await input.resolveAccountId();
            if (!accountId || snapshot.scope.accountId !== accountId || readAccountIdFromToken(credentials.token) !== accountId) {
                logger.warn('Withheld Action operation snapshot because the credential Account differs from the machine connection Account');
                return;
            }
            const material = credentials.encryption.type === 'legacy'
                ? { type: 'legacy' as const, secret: credentials.encryption.secret }
                : { type: 'dataKey' as const, machineKey: credentials.encryption.machineKey };
            input.publishCiphertext(sealAccountScopedBlobCiphertext({
                kind: 'action_operation_snapshot', material, payload: snapshot,
                randomBytes: (length) => new Uint8Array(randomBytes(length)),
            }));
        }).catch((error) => logger.warn('Failed to publish Action operation snapshot', { error }));
        return pending;
    };
}

export class ApiMachineClient {
    private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents> | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private readonly connectedClientRpcMethods = new Set<string>();
    private hasConnectedOnce = false;
    private accountIdPromise: Promise<string> | null = null;
    private readonly connectedServicesProjectionRetry = createConnectedServicesProjectionRetryScheduler();
    private projectionSchedulingClosed = false;
    private updateListeners = new Set<(update: Update) => boolean | void>();
    private accountSettingsVersionHintListeners = new Set<(hint: AccountSettingsVersionHintNotification) => void | Promise<void>>();
    private pendingSessionActivationHintListeners = new Set<(
        hint: PendingSessionActivationHintNotification,
    ) => void | Promise<void>>();
    private sessionDeletedChangeListeners = new Set<(
        change: SessionDeletedChangeNotification,
    ) => void | Promise<void>>();
    private sessionAccessRevokedListeners = new Set<(
        change: SessionAccessRevokedNotification,
    ) => void | Promise<void>>();
    private sessionAccessResetListeners = new Set<(
        change: SessionAccessResetNotification,
    ) => void | Promise<void>>();
    private managedProviderRetainedCurrentnessListeners = new Set<(
        change: ManagedProviderRetainedCurrentnessInvalidation,
    ) => void | Promise<void>>();
    private connectedServicesProjectionListener: ((notification: ConnectedServicesProjectionNotification) => void | Promise<void>) | null = null;
    private machineTransferListeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    private transferRelayV2Listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    private peerTcpTunnelRelayListeners = new Set<(payload: PeerTcpTunnelRelayEnvelope) => void>();
    private machineLiveStreamRelayListeners = new Set<(payload: MachineLiveStreamRelayEnvelopeV1) => void>();
    private externalSessionStatusDemandListeners = new Set<(payload: ExternalSessionStatusDemandDaemonMessageV1) => void>();
    private connectionStateListeners = new Set<(state: ManagedConnectionState) => void>();
    private connectionSupervisor: ManagedConnectionSupervisor | null = null;
    private daemonTerminalSessionMutationOutboxes = new Map<string, DaemonSessionClientDurableMutationOutbox>();
    private readonly machineRpcWorkingDirectory: string;
    private readonly filesystemAccessPolicy: FilesystemAccessPolicy;
    private additionalAllowedReadDirs: string[] = [];
    private additionalAllowedWriteDirs: string[] = [];
    private readonly transientSessionMediaReadAllowance = createTransientSessionMediaReadAllowance();
    private readonly fileSystemTransferRelayOwner: TransferRelayV2DownloadSessionOwner;
    private readonly rpcLifecycleRegistrations: MachineRpcLifecycleRegistration[] = [];
    private connectedAccountDaemonRuntime: ConnectedAccountDaemonRuntime | null = null;
    private connectedAccountPurposeBindingRuntime: Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions'
    > | null = null;
    private readonly activateCapabilitiesPurposeBindings: DaemonConnectedAccountPurposeBindingRuntime['activatePurposeBindings'] = (input) => {
        const runtime = this.connectedAccountPurposeBindingRuntime;
        if (!runtime) {
            throw new Error('Connected Account purpose authority is unavailable for this capability probe');
        }
        return runtime.activatePurposeBindings(input);
    };
    private sessionSpawnV1OutcomeRequired = false;
    private externalActionExecutionAuthorizationV1OutcomeRequired = false;
    private currentIrohMachineEndpoint: IrohEndpointDescriptorV1 | null = null;
    private localServicePreviewNativeAccessLive = false;
    private pendingPersistedIrohEndpointWithdrawal = false;
    /** Reflects only an installed provider-broker application handler; the
     * composition root owns the fact, this client only publishes it. */
    private providerBrokerIngressAdvertised = false;
    private agentCatalogObservation: AgentProviderCatalogObservationService | null = null;
    private activeTransportGeneration = 0;
    private advertisedOperationProtocolCapabilitiesGeneration: number | null = null;
    private machineControlReadinessFailureGeneration: number | null = null;
    private machineControlRunningGeneration: number | null = null;
    private machineControlReadinessPublication: Readonly<{
        generation: number;
        promise: Promise<boolean>;
    }> | null = null;
    private readonly sessionSyncPendingInputServerContractController:
        ReturnType<typeof createSessionSyncPendingInputServerContractController>;
    private sessionSyncPendingInputServerContractResult:
        SessionSyncPendingInputServerContractResult | null = null;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private readonly ownershipMetadata: Readonly<{
        runtimeId?: string;
        cliVersion?: string;
        publicReleaseChannel?: string;
        startupSource?: string;
        serviceManaged?: boolean;
        serviceLabel?: string;
    }>;
    private readonly lifecycleDependencies: ApiMachineClientLifecycleDependencies;
    private readonly machineContentCodec: MachineContentCodec;
    private readonly actionOperationRuntime: HostActionOperationRuntime;

    private shouldSuppressMachinePublication(allowWhileQuiescing = false): boolean {
        return !allowWhileQuiescing
            && this.lifecycleDependencies.isDaemonQuiescing?.() === true;
    }

    private teardownActiveSocket(): void {
        this.connectedClientRpcMethods.clear();
        if (!this.socket) {
            this.sessionSyncPendingInputServerContractResult = null;
            return;
        }
        this.sessionSyncPendingInputServerContractResult =
            this.sessionSyncPendingInputServerContractController.invalidate({
                sessionConnectionEpoch: this.activeTransportGeneration,
                socket: this.socket,
            });
        this.rpcHandlerManager.onSocketDisconnect();
        this.stopKeepAlive();
        this.socket = null;
    }

    private async publishMachineControlReadinessWhenReady(params: Readonly<{
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        transportGeneration: number;
        timeoutMs: number;
    }>): Promise<Readonly<{
        ready: boolean;
        readiness: RpcHandlerRegistrationReadiness;
    }>> {
        const { socket, transportGeneration, timeoutMs } = params;
        const missingCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
            (method) => !this.rpcHandlerManager.hasHandler(method),
        );
        if (missingCoreHandlers.length > 0) {
            return {
                ready: false,
                readiness: { status: 'disconnected', missingMethods: missingCoreHandlers },
            };
        }

        const readiness = await this.rpcHandlerManager.waitForRegisteredHandlers(
            REQUIRED_MACHINE_CONTROL_RPC_METHODS,
            { timeoutMs },
        );
        if (
            readiness.status !== 'ready'
            || this.socket !== socket
            || this.activeTransportGeneration !== transportGeneration
            || socket.connected !== true
        ) {
            return { ready: false, readiness };
        }
        if (this.machineControlRunningGeneration === transportGeneration) {
            return { ready: true, readiness };
        }
        if (this.machineControlReadinessPublication?.generation === transportGeneration) {
            const published = await this.machineControlReadinessPublication.promise;
            return { ready: published, readiness };
        }

        // A successful core registration receipt proves that the server has
        // installed its post-authentication RPC listener. Replay the manager's
        // complete current set once for this readiness publication so optional
        // registrations emitted during the admission fence are not silently
        // lost. The guards above prevent later optional acknowledgements from
        // repeatedly replaying the remaining set.
        this.rpcHandlerManager.replayUnacknowledgedHandlerRegistrations();

        const promise = (async () => {
            const capabilities = await this.resolveCurrentMachineOperationProtocolCapabilitiesForPublication();
            if (
                capabilities !== null
                && this.advertisedOperationProtocolCapabilitiesGeneration !== transportGeneration
            ) {
                // A rejected publication leaves the server's projection unknown, so it is
                // deliberately not recorded as advertised and is allowed to reject this
                // whole publication: without the running mark, the next registration
                // acknowledgement re-enters here and publishes the capabilities again.
                await this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities);
                this.advertisedOperationProtocolCapabilitiesGeneration = transportGeneration;
            }
            if (
                this.socket !== socket
                || this.activeTransportGeneration !== transportGeneration
                || socket.connected !== true
            ) {
                return false;
            }
            await this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now(),
            }));
            if (
                this.socket === socket
                && this.activeTransportGeneration === transportGeneration
                && socket.connected === true
            ) {
                this.machineControlRunningGeneration = transportGeneration;
                // Pairs with the unready warning below: an operator reading the daemon log
                // can tell a connection that recovered from one that never did.
                logger.info('[API MACHINE] Core machine-control RPC registration ready', {
                    advertisesOperationProtocolCapabilities: capabilities !== null,
                });
            }
            return true;
        })().catch((error) => {
            logger.warn('[API MACHINE] Failed to publish machine-control readiness; session spawn stays unadvertised until the next registration acknowledgement or reconnect', {
                message: error instanceof Error ? error.message : String(error),
            });
            return false;
        }).finally(() => {
            if (this.machineControlReadinessPublication?.generation === transportGeneration) {
                this.machineControlReadinessPublication = null;
            }
        });
        this.machineControlReadinessPublication = { generation: transportGeneration, promise };
        const published = await promise;
        return { ready: published, readiness };
    }

    private isCurrentConnectionState(state: ManagedConnectionState): boolean {
        return this.currentConnectionState.phase === state.phase
            && this.currentConnectionState.reason === state.reason
            && this.currentConnectionState.attempt === state.attempt
            && this.currentConnectionState.nextRetryAt === state.nextRetryAt
            && this.currentConnectionState.lastConnectedAt === state.lastConnectedAt
            && this.currentConnectionState.lastDisconnectedAt === state.lastDisconnectedAt
            && this.currentConnectionState.lastErrorMessage === state.lastErrorMessage;
    }

    private reportMachineControlReadinessPublicationFailure(params: Readonly<{
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        transportGeneration: number;
    }>): void {
        if (
            this.socket !== params.socket
            || params.socket.connected !== true
            || this.activeTransportGeneration !== params.transportGeneration
            || this.machineControlReadinessFailureGeneration === params.transportGeneration
        ) return;
        const supervisor = this.connectionSupervisor;
        const scope = supervisor?.captureProbeReportScope?.();
        if (!supervisor?.reportProbeResult || !scope) return;
        this.machineControlReadinessFailureGeneration = params.transportGeneration;
        supervisor.reportProbeResult({
            status: 'retry_later',
            reason: 'probe_failed',
            errorMessage: 'Machine capability publication did not establish readiness',
        }, scope);
    }

    private isActiveTransportGeneration(generation: number): boolean {
        return generation === this.activeTransportGeneration;
    }

    private handleTransportSocketDisconnect(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>, generation: number): void {
        logger.debug('[API MACHINE] Disconnected from server');
        if (!this.isActiveTransportGeneration(generation) || this.socket !== socket) {
            return;
        }
        this.teardownActiveSocket();
    }

    private normalizeMachineScopedRpcMethod(method: string): string | null {
        const trimmed = method.trim();
        if (!trimmed) return null;
        return trimmed.includes(':') ? trimmed : `${this.machine.id}:${trimmed}`;
    }

    private normalizeConnectedClientRpcAvailabilityMethod(method: unknown): string | null {
        if (typeof method !== 'string') return null;
        const trimmed = method.trim();
        const prefix = `${this.machine.id}:`;
        if (!trimmed.startsWith(prefix)) return null;
        const unprefixedMethod = trimmed.slice(prefix.length).trim();
        if (!unprefixedMethod) return null;
        if (this.rpcHandlerManager.hasHandler(unprefixedMethod)) return null;
        return `${this.machine.id}:${unprefixedMethod}`;
    }

    constructor(
        private token: string,
        private machine: Machine,
        ownershipMetadata?: Readonly<{
            runtimeId?: string;
            cliVersion?: string;
            publicReleaseChannel?: string;
            startupSource?: string;
            serviceManaged?: boolean;
            serviceLabel?: string;
        }>,
        lifecycleDependencies?: ApiMachineClientLifecycleDependencies,
    ) {
        this.machine.daemonState = this.discardUnverifiedIrohEndpoint(this.machine.daemonState);
        this.ownershipMetadata = ownershipMetadata ?? {};
        this.lifecycleDependencies = lifecycleDependencies ?? {};
        this.machineContentCodec = createMachineContentCodec(this.machine);
        this.sessionSyncPendingInputServerContractController =
            createSessionSyncPendingInputServerContractController({
                serverUrl: resolveServerHttpBaseUrl(),
                token: this.token,
            });
        const rpcTransportConfig = this.machine.encryptionMode === 'plain'
            ? { encryptionMode: 'plain' as const }
            : {
                encryptionMode: 'e2ee' as const,
                encryptionKey: this.machine.encryptionKey,
                encryptionVariant: this.machine.encryptionVariant,
            };
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            ...rpcTransportConfig,
            authorizeRequest: authorizeMachineRpcRequest,
            projectTransportAcknowledgement: projectMachineRpcTransportAcknowledgement,
            logger: (msg, data) => logger.debug(msg, data),
            onRegistrationError: (error) => {
                const probe = classifyTransportErrorToProbeResult(error);
                const supervisor = this.connectionSupervisor;
                const scope = supervisor?.captureProbeReportScope?.();
                if (probe && scope) {
                    supervisor?.reportProbeResult?.(probe, scope);
                }
            },
            onRegistrationAcknowledged: () => {
                const socket = this.socket;
                if (!socket) {
                    return;
                }
                const transportGeneration = this.activeTransportGeneration;
                void this.publishMachineControlReadinessWhenReady({
                    socket,
                    transportGeneration,
                    timeoutMs: 0,
                }).then((result) => {
                    if (result.readiness.status === 'ready' && !result.ready) {
                        this.reportMachineControlReadinessPublicationFailure({ socket, transportGeneration });
                    }
                });
            },
        });
        this.actionOperationRuntime = createHostActionOperationRuntime({
            machineId: this.machine.id,
            resolveAccountId: async () => await this.getAccountId(),
            publishSnapshot: createActionOperationSnapshotPublisher({
                resolveAccountId: async () => await this.getAccountId(),
                publishCiphertext: (ciphertext) => emitActionOperationSnapshotV1({
                    socket: this.socket, machineId: this.machine.id, ciphertext,
                }),
            }),
            supportsCoreCancellation: (actionId, input) => {
                if (actionId !== 'session.spawn_new') return true;
                if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
                const executionTarget = (input as Readonly<Record<string, unknown>>).executionTarget;
                return Boolean(
                    executionTarget
                    && typeof executionTarget === 'object'
                    && !Array.isArray(executionTarget)
                    && (executionTarget as Readonly<Record<string, unknown>>).machineId === this.machine.id,
                );
            },
        });

        this.machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        this.filesystemAccessPolicy = resolveFilesystemAccessPolicy();
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: configuration.serverUrl,
            resolveCurrentMachineId: () => this.machine.id,
        });
        registerSessionHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            accessPolicy: this.filesystemAccessPolicy,
            ...(this.lifecycleDependencies.createCapabilitiesApiClient
                ? {
                    createCapabilitiesApiClient:
                        this.lifecycleDependencies.createCapabilitiesApiClient,
                }
                : {}),
            activateCapabilitiesPurposeBindings: this.activateCapabilitiesPurposeBindings,
            getAgentCatalogObservation: () => this.agentCatalogObservation
                ? { machineId: this.machine.id, service: this.agentCatalogObservation }
                : null,
            machineAdmissionTransport: async (request, options) =>
                await this.enqueueSessionPendingByMachine(request, options),
            // G-RC4: thread the live server-features snapshot into the plugin-UI-tier projection so
            // a server that disables `plugins`/`plugins.ui` cascades the tiers OFF in the daemon
            // projection (master §3.5 "server disables X → daemon refuses"). Reuses the one fetch
            // source — no fresh probe path is introduced.
            daemonPluginInvocationLogs: {
                resolveCurrentTarget: async ({ signal }) => await resolveCurrentMachineExecutionOriginContext(signal),
            },
            daemonContributionRegistryProjection: {
                resolveCaptureRegistry: () => this.lifecycleDependencies.liveStreamCaptureRegistry ?? null,
                observePluginExecution: this.actionOperationRuntime.observePluginExecution,
                resolveServerFeaturesSnapshot: async () => (
                    await this.lifecycleDependencies.resolveServerFeaturesSnapshot?.()
                    ?? await fetchServerFeaturesSnapshot({ serverUrl: configuration.serverUrl })
                ),
                resolvePluginProjectionExecutionOriginContext: async () =>
                    await resolveCurrentMachineExecutionOriginContext(),
                resolveMessageActionReference: async ({ reference, signal }) => {
                    const credentials = await readStoredCredentials().catch(() => null);
                    signal?.throwIfAborted();
                    if (!credentials) return { status: 'unavailable' as const };
                    return await resolveMessageActionReferenceSnapshotV1({
                        token: this.token,
                        reference,
                        ...(signal ? { signal } : {}),
                        readCurrentMessage: async ({ reference, durableMessage, signal: rowSignal }) =>
                            await readCurrentMessageActionReferenceRowV1({
                                credentials,
                                token: this.token,
                                reference,
                                durableMessage,
                                ...(rowSignal ? { signal: rowSignal } : {}),
                            }),
                    });
                },
                resolveConnectedAccountPurposeBindingRuntime: () => (
                    this.connectedAccountPurposeBindingRuntime
                ),
            },
        });
        registerAutomationReplyHandoffRpcHandler(this.rpcHandlerManager, {
            machineId: this.machine.id,
            workflowRunStorage: createWorkflowRunStorageClient({ token: this.token, machineId: this.machine.id }),
            resolveAccountId: async (signal) => await this.getAccountId(signal),
            resolveInstallationId: () =>
                readInstallationIdentityIfExistsSync()?.installationId ?? null,
            resolveAccountEncryptionCurrentness: async (signal) =>
                await fetchAccountEncryptionCurrentness({
                    token: this.token,
                    ...(signal ? { signal } : {}),
                }),
            resolveAccountEncryptionMaterial: async (signal) => {
                const credentials = await readStoredCredentials().catch(() => null);
                signal?.throwIfAborted();
                if (!credentials || credentials.token !== this.token || !credentials.encryption) {
                    return null;
                }
                try {
                    return credentials.encryption.type === 'legacy'
                        ? createAccountScopedCryptoMaterialSnapshotV1({
                            accountEncryptionMode: 'e2ee',
                            material: {
                                type: 'legacy',
                                secret: credentials.encryption.secret,
                            },
                        })
                        : createAccountScopedCryptoMaterialSnapshotV1({
                            accountEncryptionMode: 'e2ee',
                            material: {
                                type: 'dataKey',
                                machineKey: credentials.encryption.machineKey,
                            },
                            dataKeyPublicKey: credentials.encryption.publicKey,
                        });
                } catch {
                    return null;
                }
            },
        });
        const composerMediaStageStore = createActiveDaemonComposerMediaStageStore({
            machineId: this.machine.id,
        });
        const fileSystemHandlers = registerFileSystemHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            resolveSessionWorkingDirectory: this.lifecycleDependencies.resolveHostedSessionWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => this.additionalAllowedReadDirs,
            getAdditionalAllowedReadFiles: () => this.transientSessionMediaReadAllowance.readAllowedReadFiles(),
            getAdditionalAllowedWriteDirs: () => this.additionalAllowedWriteDirs,
            composerMediaStage: {
                executionTarget: {
                    serverId: configuration.activeServerId,
                    machineId: this.machine.id,
                },
                store: composerMediaStageStore,
            },
        });
        this.fileSystemTransferRelayOwner = {
            store: fileSystemHandlers.transferSessionStore,
            lifecycle: createTransferSessionLifecycle({
                store: fileSystemHandlers.transferSessionStore,
                chunkSizeBytes: configuration.filesTransferChunkBytes,
            }),
        };
        registerMachineFileBrowserHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            workingDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceAnchorHandlers(this.rpcHandlerManager, {
            defaultDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceFaviconHandlers(this.rpcHandlerManager, {
            defaultDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerMachineConnectedAccountRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            machineId: this.machine.id,
            getRuntime: () => this.connectedAccountDaemonRuntime,
        });
        // SCM must be machine-scoped so the UI can view diffs/logs and perform staging/commit operations
        // even when no session is currently active.
        registerScmHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            accessPolicy: this.filesystemAccessPolicy,
            machineId: this.machine.id,
        });
    }

    setRPCHandlers({
        spawnSession,
        sessionSpawnV1OutcomeRequired,
        resolveSpawnSessionByNonce,
        stopSession,
        isSessionActive,
        loadLocalSessionMetadata,
        requestShutdown,
        memory,
        daemonServerWorkScheduler,
        voiceInference,
        machineTransferChannel,
        transferRelayV2Channel,
        directPeerTransfer,
        directTransferImport,
        directTransferExport,
    }: MachineRpcHandlers, deps?: Omit<MachineRpcHandlerDeps, 'externalAction'> & Readonly<{
        externalActionIngressOwner?: ExternalActionIngressOwner;
    }>): MachineRpcLifecycleRegistration {
        const executionRunRuntimeAccountId = readAccountIdFromToken(this.token) ?? undefined;
        const executionRunServerId = configuration.activeServerId;
        const executionRunApprovalDeps = createExecutionRunRpcApprovalDeps({ readCredentials: async () => {
            const credentials = await readStoredCredentialsForServerId(executionRunServerId).catch(() => null);
            return credentials?.token === this.token ? credentials : null;
        } });
        const actionsSettingsProvider = deps?.actionsSettingsProvider ?? createActionSettingsProvider({
            scopeKey: resolveAccountSettingsScopeKeyForToken(this.token),
        });
        this.sessionSpawnV1OutcomeRequired = sessionSpawnV1OutcomeRequired === true;
        this.externalActionExecutionAuthorizationV1OutcomeRequired =
            deps?.externalActionIngressOwner?.externalActionMachineRequestPrivateKey !== undefined;
        this.agentCatalogObservation = deps?.agentCatalogObservation ?? null;
        const machineRpcLifecycleRegistration = registerMachineRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            handlers: {
                spawnSession,
                ...(sessionSpawnV1OutcomeRequired === true
                    ? { sessionSpawnV1OutcomeRequired: true }
                    : {}),
                ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
                stopSession,
                ...(isSessionActive ? { isSessionActive } : {}),
                ...(loadLocalSessionMetadata ? { loadLocalSessionMetadata } : {}),
                requestShutdown,
                ...(memory ? { memory } : {}),
                ...(daemonServerWorkScheduler ? { daemonServerWorkScheduler } : {}),
                ...(voiceInference ? { voiceInference } : {}),
                ...(machineTransferChannel ? { machineTransferChannel } : {}),
                ...(transferRelayV2Channel ? { transferRelayV2Channel } : {}),
                ...(directPeerTransfer ? { directPeerTransfer } : {}),
                ...(directTransferImport ? { directTransferImport } : {}),
                ...(directTransferExport ? { directTransferExport } : {}),
            },
            deps: {
                ...deps,
                actionsSettingsProvider,
                currentMachineId: this.machine.id,
                ...(executionRunRuntimeAccountId ? { executionRunRuntimeAccountId } : {}),
                executionRunApprovalDeps,
                ...(deps?.externalActionIngressOwner
                    ? {
                        externalAction: {
                            ...deps.externalActionIngressOwner,
                            machineId: this.machine.id,
                            resolveAccountId: async (signal) => await this.getAccountId(signal),
                        },
                    }
                    : {}),
                actionOperations: {
                    attachOwner: this.actionOperationRuntime.attachOwner,
                    handlers: this.actionOperationRuntime.handlers,
                    observeExecution: this.actionOperationRuntime.observeExecution,
                },
                ...(this.lifecycleDependencies.workspaceSync
                    ? { workspaceSync: this.lifecycleDependencies.workspaceSync }
                    : {}),
                ...(this.lifecycleDependencies.resolveServerFeaturesSnapshot
                    ? { resolveServerFeaturesSnapshot: this.lifecycleDependencies.resolveServerFeaturesSnapshot }
                    : {}),
                ...(this.lifecycleDependencies.workspaceSyncHandoffAdapter
                    ? {
                        sessionHandoffCoordinator: createTrackedSessionHandoffCoordinator({
                            expectedAccountServerId: configuration.activeServerId,
                            readCredentials: async () => await readStoredCredentials().catch(() => null),
                            callMachine: async (input) => input.machineId === this.machine.id
                                ? await this.rpcHandlerManager.invokeLocal(
                                    input.method,
                                    input.request,
                                    input.signal ? { signal: input.signal } : undefined,
                                )
                                : await callMachineRpc(input),
                            workspaceSyncAdapter:
                                this.lifecycleDependencies.workspaceSyncHandoffAdapter,
                        }),
                    }
                    : {}),
                ...(this.lifecycleDependencies.createCapabilitiesApiClient
                    ? {
                        createCapabilitiesApiClient:
                            this.lifecycleDependencies.createCapabilitiesApiClient,
                    }
                    : {}),
                activateCapabilitiesPurposeBindings: this.activateCapabilitiesPurposeBindings,
                sessionServerStart: {
                    machineId: this.machine.id,
                    token: this.token,
                    readCredentials: async () => await readStoredCredentials().catch(() => null),
                    resolveAccountId: async (signal) => await this.getAccountId(signal),
                    resolveInstallationId: () =>
                        readInstallationIdentityIfExistsSync()?.installationId ?? null,
                    resolveAccountEncryptionCurrentness: async (signal) =>
                        await fetchAccountEncryptionCurrentness({
                            token: this.token,
                            ...(signal ? { signal } : {}),
                        }),
                    machineAdmissionTransport: async (request, options) =>
                        await this.enqueueSessionPendingByMachine(request, options),
                },
                externalSessionStatusDemandChannel: this,
                subscribeSessionArchivedStateChanges:
                    deps?.subscribeSessionArchivedStateChanges
                    ?? ((listener) => this.onSessionArchivedStateChange(listener)),
                subscribeSessionDeletedChanges: (listener) =>
                    this.onSessionDeletedChange(listener),
                workingDirectory: deps?.workingDirectory ?? this.machineRpcWorkingDirectory,
                filesystemAccessPolicy: deps?.filesystemAccessPolicy ?? this.filesystemAccessPolicy,
                getAdditionalAllowedWriteDirs: deps?.getAdditionalAllowedWriteDirs ?? (() => this.additionalAllowedWriteDirs),
                transientMediaReadAllowance: deps?.transientMediaReadAllowance ?? this.transientSessionMediaReadAllowance,
                extraTransferRelayV2DownloadOwners: [
                    this.fileSystemTransferRelayOwner,
                    ...(deps?.extraTransferRelayV2DownloadOwners ?? []),
                ],
            },
        });
        this.rpcLifecycleRegistrations.push(machineRpcLifecycleRegistration);
        return machineRpcLifecycleRegistration;
    }

    getPeerMediationMachineRpcHandlerManager(): RpcHandlerInvoker {
        return {
            invokeLocal: async (method, params, options) => await this.rpcHandlerManager.invokeLocal(
                method,
                params,
                options,
            ),
        };
    }

    /** Host-private exact-daemon Action transport; local context never reaches Socket.IO. */
    async invokeLocalMachineAction(
        method: string,
        request: unknown,
        options?: Readonly<{
            signal?: AbortSignal;
            executionRunPermissionRequestStore?: unknown;
            executionRunWorkflowObservationSink?: unknown;
            executionRunWorkflowRunId?: string;
            localActionContext?: RpcLocalActionContext;
        }>,
    ): Promise<unknown> {
        return await this.rpcHandlerManager.invokeLocal(method, request, {
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.executionRunPermissionRequestStore === undefined
                && options?.executionRunWorkflowObservationSink === undefined
                && options?.executionRunWorkflowRunId === undefined
                && options?.localActionContext === undefined
                ? {}
                : {
                    localActionContext: {
                        ...options?.localActionContext,
                        ...(options?.executionRunWorkflowRunId ? { executionRunWorkflowRunId: options.executionRunWorkflowRunId } : {}),
                        ...(options?.executionRunPermissionRequestStore === undefined
                            ? {}
                            : { executionRunPermissionRequestStore: options.executionRunPermissionRequestStore }),
                        ...(options?.executionRunWorkflowObservationSink === undefined
                            ? {}
                            : { executionRunWorkflowObservationSink: options.executionRunWorkflowObservationSink }),
                    },
                }),
        });
    }

    registerLocalServicesPreviewRoutes(localServicesPreview: LocalServicePreviewRoutes): void {
        registerDaemonLocalServicePreviewSnapshotHandler(this.rpcHandlerManager, {
            localServicesPreview,
        });
    }

    registerLocalServicesRoutes(localServices: DaemonLocalServicesMachineRpcRoutes): void {
        registerDaemonLocalServicesMachineRpcHandlers(this.rpcHandlerManager, localServices);
    }

    registerConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void {
        this.connectedAccountDaemonRuntime = runtime;
    }

    registerConnectedAccountPurposeBindingRuntime(runtime: Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions'
    >): void {
        this.connectedAccountPurposeBindingRuntime = runtime;
    }

    registerComputerRoutes(resolveComputer: () => ComputerRoutes | null): void {
        registerDaemonComputerHandler(this.rpcHandlerManager, { resolveComputer });
    }

    registerBrowserControlRoutes(browserControl: BrowserDaemonControlRoutes): void {
        registerDaemonBrowserControlHandler(this.rpcHandlerManager, {
            browserControl,
        });
    }

    registerBrowserContextRoutes(browserContext: BrowserContextRoutes): void {
        registerDaemonBrowserContextHandler(this.rpcHandlerManager, {
            browserContext,
        });
    }

    registerBrowserDiagnosticsRoutes(browserDiagnostics: BrowserDiagnosticsRoutes): void {
        registerDaemonBrowserDiagnosticsSnapshotHandler(this.rpcHandlerManager, {
            browserDiagnostics,
        });
    }

    registerBrowserRecordingRoutes(browserRecording: BrowserRecordingRoutes): void {
        registerDaemonBrowserRecordingHandlers(this.rpcHandlerManager, {
            browserRecording,
        });
    }

    registerSimulatorPreviewRoutes(simulatorPreview: SimulatorPreviewRoutes): void {
        registerDaemonSimulatorPreviewHandlers(this.rpcHandlerManager, {
            simulatorPreview,
        });
    }

    registerLiveStreamRelayRoutes(relay: DaemonLiveStreamRelayRoutes): void {
        registerDaemonLiveStreamRelayHandlers(this.rpcHandlerManager, {
            relay,
        });
    }

    onUpdate(listener: (update: Update) => boolean | void): () => void {
        this.updateListeners.add(listener);
        return () => {
            this.updateListeners.delete(listener);
        };
    }

    onAccountSettingsVersionHint(listener: (hint: AccountSettingsVersionHintNotification) => void | Promise<void>): () => void {
        this.accountSettingsVersionHintListeners.add(listener);
        return () => {
            this.accountSettingsVersionHintListeners.delete(listener);
        };
    }

    onPendingSessionActivationHint(
        listener: (hint: PendingSessionActivationHintNotification) => void | Promise<void>,
    ): () => void {
        this.pendingSessionActivationHintListeners.add(listener);
        return () => {
            this.pendingSessionActivationHintListeners.delete(listener);
        };
    }

    onSessionDeletedChange(
        listener: (
            change: SessionDeletedChangeNotification,
        ) => void | Promise<void>,
    ): () => void {
        this.sessionDeletedChangeListeners.add(listener);
        return () => {
            this.sessionDeletedChangeListeners.delete(listener);
        };
    }

    getSessionSyncPendingInputServerContractResult():
        SessionSyncPendingInputServerContractResult | null {
        const result = this.sessionSyncPendingInputServerContractResult;
        return (
            result
            && result.sessionConnectionEpoch === this.activeTransportGeneration
            && result.socket === this.socket
            && result.socket.connected === true
        )
            ? result
            : null;
    }

    private async notifyPendingSessionActivationHint(
        hint: PendingSessionActivationHintNotification,
    ): Promise<void> {
        for (const listener of this.pendingSessionActivationHintListeners) {
            try {
                await Promise.resolve(listener(hint));
            } catch (error) {
                logger.warn('[API MACHINE] Pending session activation listener failed; Pending custody retained', {
                    sessionId: hint.sessionId,
                    requestId: hint.requestId,
                    source: hint.source,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private async notifySessionDeletedChange(
        change: SessionDeletedChangeNotification,
    ): Promise<void> {
        for (const listener of this.sessionDeletedChangeListeners) {
            await Promise.resolve(listener(change));
        }
    }

    onSessionAccessRevoked(
        listener: (
            change: SessionAccessRevokedNotification,
        ) => void | Promise<void>,
    ): () => void {
        this.sessionAccessRevokedListeners.add(listener);
        return () => {
            this.sessionAccessRevokedListeners.delete(listener);
        };
    }

    private async notifySessionAccessRevoked(
        change: SessionAccessRevokedNotification,
    ): Promise<void> {
        for (const listener of this.sessionAccessRevokedListeners) {
            await Promise.resolve(listener(change));
        }
    }

    onSessionAccessReset(
        listener: (change: SessionAccessResetNotification) => void | Promise<void>,
    ): () => void {
        this.sessionAccessResetListeners.add(listener);
        return () => {
            this.sessionAccessResetListeners.delete(listener);
        };
    }

    private async notifySessionAccessReset(
        change: SessionAccessResetNotification,
    ): Promise<void> {
        for (const listener of this.sessionAccessResetListeners) {
            await Promise.resolve(listener(change));
        }
    }

    onManagedProviderRetainedCurrentnessInvalidation(
        listener: (
            change: ManagedProviderRetainedCurrentnessInvalidation,
        ) => void | Promise<void>,
    ): () => void {
        this.managedProviderRetainedCurrentnessListeners.add(listener);
        return () => {
            this.managedProviderRetainedCurrentnessListeners.delete(listener);
        };
    }

    private async notifyManagedProviderRetainedCurrentnessInvalidation(
        change: ManagedProviderRetainedCurrentnessInvalidation,
    ): Promise<void> {
        for (const listener of this.managedProviderRetainedCurrentnessListeners) {
            await Promise.resolve(listener(change));
        }
    }

    /**
     * Live archive-state transitions from the incumbent Session update stream.
     * This is the one archive-state seam; the machine RPC handlers and the
     * daemon memory owner both consume it rather than reading `update-session`
     * themselves.
     */
    onSessionArchivedStateChange(
        listener: (
            change: Readonly<{ sessionId: string; archived: boolean }>,
        ) => void | Promise<void>,
    ): () => void {
        return this.onUpdate((update) => {
            const body = update.body;
            if (body.t !== 'update-session' || body.archivedAt === undefined) {
                return false;
            }
            const change = { sessionId: body.id, archived: body.archivedAt !== null } as const;
            void Promise.resolve(listener(change)).catch((error) => {
                logger.warn('[API MACHINE] Session archive-state listener failed', {
                    sessionId: change.sessionId,
                    archived: change.archived,
                    message: error instanceof Error ? error.message : String(error),
                });
            });
            return true;
        });
    }

    onConnectedServicesProjection(
        listener: (notification: ConnectedServicesProjectionNotification) => void | Promise<void>,
    ): () => void {
        if (this.connectedServicesProjectionListener) {
            throw new Error('Connected-services projection reconciliation already has an owner');
        }
        this.connectedServicesProjectionListener = listener;
        return () => {
            if (this.connectedServicesProjectionListener === listener) {
                this.connectedServicesProjectionListener = null;
            }
        };
    }

    private async reconcileConnectedServicesProjection(
        notification: Omit<
            ConnectedServicesProjectionNotification,
            | 'signal'
            | 'connectedServicesV2'
            | 'connectedServiceCredentialRevisionsV1'
        >,
        signal: AbortSignal,
    ): Promise<void> {
        signal.throwIfAborted();
        if (!this.connectedServicesProjectionListener) {
            throw new Error('connected_services_projection_reconciler_unavailable');
        }
        const profile = await fetchAccountProfile({ token: this.token, signal });
        signal.throwIfAborted();
        try {
            await this.connectedServicesProjectionListener({
                ...notification,
                signal,
                connectedServicesV2: profile.connectedServicesV2,
                connectedServiceCredentialRevisionsV1: profile.connectedServiceCredentialRevisionsV1,
            });
        } catch (error) {
            if (!isConnectedServiceGenerationReconciliationNotAcknowledgeableError(error)) throw error;
            logger.debug('[API MACHINE] Connected-services generation reconciliation awaits another domain event', {
                source: notification.source,
            });
        }
        signal.throwIfAborted();
    }

    private async notifyAccountSettingsVersionHint(hint: AccountSettingsVersionHintNotification): Promise<void> {
        for (const listener of this.accountSettingsVersionHintListeners) {
            try {
                await Promise.resolve(listener(hint));
            } catch (error) {
                logger.warn('[API MACHINE] Account settings version hint listener failed; continuing changes catch-up', {
                    settingsVersion: hint.settingsVersion,
                    source: hint.source,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    onMachineTransferEnvelope(listener: (payload: MachineTransferReceiveEnvelope) => void): () => void {
        this.machineTransferListeners.add(listener);
        return () => {
            this.machineTransferListeners.delete(listener);
        };
    }

    onTransferRelayV2Envelope(listener: (payload: TransferRelayV2SendEnvelope) => void): () => void {
        this.transferRelayV2Listeners.add(listener);
        return () => {
            this.transferRelayV2Listeners.delete(listener);
        };
    }

    onPeerTcpTunnelRelayEnvelope(listener: (payload: PeerTcpTunnelRelayEnvelope) => void): () => void {
        this.peerTcpTunnelRelayListeners.add(listener);
        return () => {
            this.peerTcpTunnelRelayListeners.delete(listener);
        };
    }

    onMachineLiveStreamRelayEnvelope(listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void): () => void {
        this.machineLiveStreamRelayListeners.add(listener);
        return () => {
            this.machineLiveStreamRelayListeners.delete(listener);
        };
    }

    onExternalSessionStatusDemand(
        listener: (payload: ExternalSessionStatusDemandDaemonMessageV1) => void,
    ): () => void {
        this.externalSessionStatusDemandListeners.add(listener);
        return () => {
            this.externalSessionStatusDemandListeners.delete(listener);
        };
    }

    onConnectionStateChange(listener: (state: ManagedConnectionState) => void): () => void {
        this.connectionStateListeners.add(listener);
        listener(this.currentConnectionState);
        return () => {
            this.connectionStateListeners.delete(listener);
        };
    }

    /**
     * Whether this daemon can currently serve the machine-control RPCs the server dispatches
     * to it: an active transport whose registration reached the readiness publication.
     *
     * This is the only fact that separated a working daemon from the 56-minute pid-26058
     * outage — the process, its heartbeat, its control-server ping and its socket were all
     * healthy while every machine RPC was unreachable. It is read by the heartbeat so
     * `happier daemon status` and `happier doctor` can report it instead of a PID probe.
     */
    isMachineControlRegistrationReady(): boolean {
        return this.socket !== null
            && this.machineControlRunningGeneration === this.activeTransportGeneration;
    }

    sendMachineTransferEnvelope(payload: MachineTransferSendEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, payload);
    }

    hasConnectedClientRpcHandler(method: string): boolean {
        const normalized = this.normalizeMachineScopedRpcMethod(method);
        return normalized ? this.connectedClientRpcMethods.has(normalized) : false;
    }

    sendTransferRelayV2Envelope(payload: TransferRelayV2SendEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
    }

    sendPeerTcpTunnelRelayEnvelope(payload: PeerTcpTunnelRelayEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
    }

    async sendMachineLiveStreamRelayEnvelope(payload: MachineLiveStreamRelayEnvelopeV1): Promise<
        Readonly<{ ok: true } | { ok: false; code: MachineLiveStreamPayloadErrorCodeV1 }>
    > {
        const socket = this.socket;
        if (!socket) return { ok: false, code: 'stream_transport_unavailable' };
        const parsed = MachineLiveStreamDecodedEnvelopeV1Schema.safeParse(payload);
        if (!parsed.success) return { ok: false, code: 'stream_payload_invalid' };
        if (!hasMachineLiveStreamSensitiveContentV1(parsed.data)) {
            socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, MachineLiveStreamRelayEnvelopeV1Schema.parse(parsed.data));
            return { ok: true };
        }
        const codec = this.machineContentCodec;
        const sealed = await sealMachineLiveStreamEnvelopeV1(parsed.data, {
            mode: codec.mode,
            ...(codec.mode === 'e2ee' ? { cipher: {
                encryptRaw: (value: unknown) => codec.encodeRpc(value),
                decryptRaw: (value: string) => codec.decodeRpc(value),
            } } : {}),
        });
        if (!sealed.ok) {
            this.failMachineLiveStreamPayload(parsed.data, sealed.code);
            return sealed;
        }
        if (this.socket !== socket) return { ok: false, code: 'stream_transport_unavailable' };
        socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, sealed.value);
        return { ok: true };
    }

    private failMachineLiveStreamPayload(envelope: MachineLiveStreamRelayEnvelopeV1 | MachineLiveStreamWireEnvelopeV1, code: MachineLiveStreamPayloadErrorCodeV1): void {
        logger.warn('[API MACHINE] Live-stream payload rejected', { code });
        const message = envelope.message;
        if (message.kind !== 'frame' && message.kind !== 'sideband_control') return;
        const stopped = { ...envelope, message: {
            kind: 'control' as const, control: { v: 1 as const,
                streamId: message.kind === 'frame' ? message.frame.streamId : message.control.streamId,
                kind: 'stop' as const, reasonCode: code,
            },
        } } satisfies MachineLiveStreamRelayEnvelopeV1;
        this.socket?.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, stopped);
        for (const listener of this.machineLiveStreamRelayListeners) {
            try { listener(stopped); } catch { logger.warn('[API MACHINE] Live-stream stop listener threw'); }
        }
    }

    emitExternalSessionTranscriptUpdate(payload: ExternalSessionTranscriptInvalidationV1): void {
        if (!this.socket) return;
        this.socket.emit('external-session-transcript-invalidated', payload);
    }

    emitExternalSessionSourceUnavailableOccurrence(
        payload: ExternalSessionSourceUnavailableOccurrenceV1,
    ): void {
        if (!this.socket) return;
        this.socket.emit(EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1, payload);
    }

    async retireTeamCredentialExternalProviderOperation(input: Readonly<{
        externalApiKeyId: string;
        operationId: string;
    }>): Promise<void> {
        if (!this.socket?.connected) throw new Error('Machine socket is unavailable for broker retirement.');
        const request = TeamCredentialExternalProviderOperationRetireV1Schema.parse({ v: 1, ...input });
        const response = await this.socket.timeout(resolveSessionControlSocketAckTimeoutMs())
            .emitWithAck(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, request);
        const result = TeamCredentialExternalProviderOperationRetireResponseV1Schema.parse(response);
        if (!result.ok) throw new Error('Broker operation retirement was not authorized.');
    }

    async executeExternalSessionHistoricalImportCommand(
        command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> {
        if (!this.socket) {
            return {
                v: 1,
                kind: 'error',
                errorCode: 'internal_error',
                message: 'Machine socket is unavailable.',
            };
        }
        const socket = this.socket;
        const timeoutMs = resolveSessionControlSocketAckTimeoutMs();
        return await new Promise<ExternalSessionOperationSocketResponseV1>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('External session historical import command timed out.'));
            }, timeoutMs);
            socket.emit(EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1, command, (response) => {
                clearTimeout(timeout);
                resolve(response);
            });
        });
    }

    /**
     * Reverse (daemon -> connected client/UI) RPC call over the persistent machine socket (W2C-BA-1).
     *
     * The spawned cli daemon runs in a SEPARATE OS process and cannot drive client-owned surfaces
     * (e.g. the desktop Wry WebView) directly. This emits a machine-scoped `rpc-call` for
     * `<machineId>:<method>` exactly the way the client emits forward machine RPC, so the server
     * routes it to whichever connected client socket (the desktop UI) registered the method. Params +
     * result use the Machine's canonical content mode. Fails closed
     * (never throws) when the socket is down, the call times out, or no client is registered, so the
     * caller stays fail-safe.
     */
    async callConnectedClientRpc<TResult = unknown>(
        method: string,
        params: unknown,
        options?: Readonly<{ timeoutMs?: number | null; signal?: AbortSignal; onIssued?: () => void }>,
    ): Promise<Readonly<{ ok: true; result: TResult }> | Readonly<{ ok: false; error?: string; errorCode?: string }>> {
        const socket = this.socket;
        if (!socket) {
            return { ok: false, errorCode: 'machine_socket_unavailable' };
        }
        const timeoutMs = options?.timeoutMs === null ? null
            : options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 20_000;
        // Caller-lifetime reverse operations have no shorter ACK deadline. The
        // existing server advertisement retires their last answering handler.
        const handlerRetirement = timeoutMs === null ? new AbortController() : null;
        const signal = handlerRetirement
            ? options?.signal ? AbortSignal.any([options.signal, handlerRetirement.signal]) : handlerRetirement.signal
            : options?.signal;
        const onUnregistered = (data: unknown): void => {
            const retiredMethod = data && typeof data === 'object' && 'method' in data ? data.method : undefined;
            if (this.normalizeConnectedClientRpcAvailabilityMethod(retiredMethod)
                === this.normalizeMachineScopedRpcMethod(method)) handlerRetirement?.abort();
        };
        const codec = this.machineContentCodec;
        let resultDecodeFailed = false;
        const content: SocketRpcContent = codec.mode === 'plain' ? { mode: 'plain' } : {
            mode: 'e2ee',
            cipher: {
                encryptRaw: async (value) => codec.encodeRpc(value),
                decryptRaw: async (ciphertext) => {
                    try { return codec.decodeRpc(ciphertext); }
                    catch (error) { resultDecodeFailed = true; throw error; }
                },
            },
        };
        if (handlerRetirement) socket.on(SOCKET_RPC_EVENTS.UNREGISTERED, onUnregistered);
        try {
            const result = await callSocketRpc<TResult>({
                socket,
                target: { kind: 'machine', id: this.machine.id },
                method,
                params,
                content,
                timeoutMs,
                signal,
                onIssued: options?.onIssued,
            });
            if (socket.connected === false) return { ok: false, errorCode: 'machine_socket_unavailable' };
            return { ok: true, result };
        } catch (error) {
            if (resultDecodeFailed) return { ok: false, errorCode: 'machine_rpc_result_decrypt_failed' };
            const errorCode = readRpcErrorCode(error);
            return {
                ok: false,
                error: isSocketIoAckTimeoutError(error) ? 'RPC call timeout' : error instanceof Error ? error.message : 'RPC call failed',
                ...(errorCode ? { errorCode } : {}),
            };
        } finally {
            if (handlerRetirement) socket.off(SOCKET_RPC_EVENTS.UNREGISTERED, onUnregistered);
        }
    }

    /** Source Session custody is admitted by the daemon before using this verified Machine socket. */
    async callSessionActionRpc(request: Parameters<SessionActionRpcTransport>[0]): Promise<unknown> {
        const socket = this.socket;
        if (!socket?.connected) throw Object.assign(new Error('machine_socket_unavailable'), { code: 'machine_socket_unavailable' });
        return await callSocketRpc({
            socket, target: { kind: 'session', id: request.sessionId }, method: request.method,
            params: request.input, content: request.content,
            authorization: { kind: 'session.action', sessionId: request.sessionId, origin: request.origin },
            timeoutMs: null,
            ...(request.signal ? { signal: request.signal } : {}),
        });
    }

    private dispatchUpdate(update: Update): boolean {
        let handled = false;
        for (const listener of this.updateListeners) {
            try {
                if (listener(update) === true) {
                    handled = true;
                }
            } catch (error) {
                logger.warn('[API MACHINE] Update listener threw (ignored)', {
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return handled;
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async captureMachineSessionTerminal(
        sessionId: string,
    ): Promise<MachineSessionTerminalCaptureResponseV1> {
        if (!this.socket) {
            return { v: 1, status: 'rejected', sessionId, reason: 'unsupported' };
        }
        const raw = await emitSocketWithAck({
            socket: this.socket,
            event: MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
            payload: { v: 1, sessionId },
        });
        return MachineSessionTerminalCaptureResponseV1Schema.parse(raw);
    }

    async finalizeMachineSessionTerminal(
        target: Readonly<{ sessionId: string; authority: MachineSessionTerminalAuthorityV1 }>,
    ): Promise<MachineSessionTerminalFinalizeResponseV1> {
        if (!this.socket) {
            return {
                v: 1,
                status: 'rejected',
                sessionId: target.sessionId,
                reason: 'unsupported',
            };
        }
        const raw = await emitSocketWithAck({
            socket: this.socket,
            event: MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
            payload: {
                v: 1,
                sessionId: target.sessionId,
                authority: target.authority,
            },
        });
        return MachineSessionTerminalFinalizeResponseV1Schema.parse(raw);
    }

    /**
     * Publishes one complete, content-free exact-target capability projection.
     * A successful response is the server-assigned monotonic projection revision.
     */
    async publishOperationProtocolCapabilities(
        capabilities: MachineOperationProtocolCapabilitiesV1,
    ): Promise<number> {
        const socket = this.socket;
        if (!socket) {
            throw new Error('Machine socket is not connected');
        }
        return await this.publishOperationProtocolCapabilitiesOnSocket(
            socket,
            capabilities,
        );
    }

    async enqueueSessionPendingByMachine(
        request: SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2,
        options?: Readonly<{
            signal?: AbortSignal;
            callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        }>,
    ): Promise<SessionInputAdmissionResultV1> {
        if (options?.signal?.aborted) {
            return { status: 'rejected', code: 'session_input_cancelled' };
        }
        const socket = this.socket;
        if (!socket) {
            return {
                status: 'rejected',
                code: 'session_input_target_unavailable',
            };
        }
        const parsed = request.v === 2
            ? SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.parse(request)
            : SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
        // Caller-authored network proof is never the producer's signing input.
        const { externalAction: _incomingProof, ...unsignedPayload } = parsed;
        const event = unsignedPayload.v === 2
            ? SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2
            : SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
        const authorization = options?.callerInputAuthorization;
        const installation = authorization ? readInstallationIdentityIfExistsSync() : null;
        if (authorization && (!installation || authorization.binding.machineId !== this.machine.id)) {
            return { status: 'rejected', code: 'session_input_unauthorized' };
        }
        const target = { kind: 'session' as const, sessionId: unsignedPayload.sessionId };
        const externalAction = authorization && installation ? {
            v: 1 as const,
            authorization,
            effectActionId: 'session.message.send',
            target,
            installationId: installation.installationId,
            machineSignature: signExternalActionMachineRpcRequestV1({
                authorizationToken: authorization.token, effectActionId: 'session.message.send',
                target, installationId: installation.installationId, event, method: event,
                requestId: authorization.binding.requestId, params: unsignedPayload,
                privateKey: installation.privateKey,
            }),
        } : undefined;
        const payload = { ...unsignedPayload, ...(externalAction ? { externalAction } : {}) };
        try {
            // Keep the Socket.IO event and payload correlated for each protocol
            // version. Passing their unions through the generic ACK helper loses
            // that relationship and makes the real typed Machine socket invalid.
            const raw = payload.v === 2
                ? await emitSocketWithAck({
                    socket,
                    event: SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2,
                    payload,
                    ...(options?.signal ? { signal: options.signal } : {}),
                })
                : await emitSocketWithAck({
                    socket,
                    event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
                    payload,
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
            const parsed = payload.v === 2
                ? SessionPendingExecutionRunEnqueueByMachineResponseV2Schema.safeParse(raw)
                : SessionPendingEnqueueByMachineResponseV1Schema.safeParse(raw);
            return parsed.success
                ? parsed.data.result
                : {
                    status: 'outcomeUnknown',
                    localId: request.localId,
                    code: 'machine_admission_response_invalid',
                };
        } catch (error) {
            if (error instanceof SocketAckError && error.code === 'socket_not_connected') {
                return { status: 'rejected', code: 'session_input_target_unavailable' };
            }
            const code = error instanceof SocketAckAbortError
                ? 'machine_admission_cancelled_after_emit'
                : error instanceof SocketAckError && error.code === 'socket_ack_timeout'
                    ? 'machine_socket_ack_timeout'
                    : 'machine_socket_disconnected';
            return { status: 'outcomeUnknown', localId: request.localId, code };
        }
    }

    /**
     * Session-owned Automation ingress. The daemon sends only the frozen Run
     * correspondence and opaque plain V2 request to its authenticated server;
     * the server rederives authority and chooses direct/local versus exact
     * cross-machine dispatch. Automation never receives that routing choice.
     */
    async dispatchSessionServerStart(
        request: SessionServerStartIngressRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<SessionServerStartDispatchResultV1> {
        if (options?.signal?.aborted) {
            return { type: 'error', code: 'cancelled', retryable: true };
        }
        const socket = this.socket;
        if (!socket) {
            return { type: 'error', code: 'machine_offline', retryable: true };
        }
        const payload = SessionServerStartIngressRequestV1Schema.safeParse(request);
        if (!payload.success) {
            return { type: 'error', code: 'invalid_input', retryable: false };
        }

        try {
            const raw = await emitSocketWithAck({
                socket,
                event: SESSION_SERVER_START_INGRESS_EVENT_V1,
                payload: payload.data,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            const response = SessionServerStartIngressResponseV1Schema.safeParse(raw);
            if (!response.success) {
                // The server may have already submitted the effect, so only the
                // canonical creation key can resolve a malformed acknowledgement.
                return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
            }
            if (response.data.kind === 'result') return response.data.result;

            const local = await this.rpcHandlerManager.invokeLocal(
                SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
                response.data.dispatch,
                options?.signal ? { signal: options.signal } : undefined,
            );
            const result = SessionServerStartDispatchResultV1Schema.safeParse(local);
            return result.success
                ? result.data
                : { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
        } catch (error) {
            if (error instanceof SocketAckError && error.code === 'socket_not_connected') {
                return { type: 'error', code: 'machine_offline', retryable: true };
            }
            // A socket acknowledgement can be lost after the server receives
            // the ingress. Retrying the same immutable Session creation key is
            // the sole rejoin path; do not fabricate a local fallback.
            if (error instanceof SocketAckAbortError || error instanceof SocketAckError) {
                return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
            }
            return options?.signal?.aborted
                ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                : { type: 'error', code: 'spawn_failed', retryable: true };
        }
    }

    private async publishOperationProtocolCapabilitiesOnSocket(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        capabilities: MachineOperationProtocolCapabilitiesV1,
    ): Promise<number> {
        const revision = await publishMachineOperationProtocolCapabilitiesOnSocket({
            socket,
            machineId: this.machine.id,
            capabilities,
        });
        this.pendingPersistedIrohEndpointWithdrawal = false;
        return revision;
    }

    private currentMachineOperationProtocolCapabilities(
        includeSessionCapabilities = true,
    ): MachineOperationProtocolCapabilitiesV1 | null {
        const {
            externalActionExecutionAuthorization: _externalActionExecutionAuthorization,
            ...sessionCapabilities
        } = CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1;
        const capabilities: MachineOperationProtocolCapabilitiesV1 = {
            ...(includeSessionCapabilities && this.sessionSpawnV1OutcomeRequired
                ? sessionCapabilities
                : {}),
            ...(this.externalActionExecutionAuthorizationV1OutcomeRequired
                ? { externalActionExecutionAuthorization: { protocolVersions: [1] } }
                : {}),
            ...(this.currentIrohMachineEndpoint
                ? {
                    irohMachineEndpoint: {
                        protocolVersions: [1],
                        ...this.currentIrohMachineEndpoint,
                    },
                }
                : {}),
            ...(this.localServicePreviewNativeAccessLive
                ? { localServicePreviewNativeAccess: { protocolVersions: [1] } }
                : {}),
            ...(this.providerBrokerIngressAdvertised
                ? { providerBrokerIngress: { protocolVersions: [1] } }
                : {}),
        };
        return Object.keys(capabilities).length > 0 ? capabilities : null;
    }

    private async resolveCurrentMachineOperationProtocolCapabilitiesForPublication(
        includeSessionCapabilities = true,
        currentServerFeatures?: FeaturesResponse,
    ): Promise<MachineOperationProtocolCapabilitiesV1 | null> {
        let capabilities = this.currentMachineOperationProtocolCapabilities(includeSessionCapabilities);
        if (!capabilities) return null;

        // The Home's resolved server feature bit is both product enablement and
        // proof that its strict Machine projection accepts this new leaf. Older,
        // malformed, disabled, or dependency-disabled Homes therefore keep the
        // handler installed locally but receive no incompatible advertisement.
        const snapshot = currentServerFeatures
            ? { status: 'ready' as const, features: currentServerFeatures }
            : await this.lifecycleDependencies.resolveServerFeaturesSnapshot?.();
        if (
            capabilities.providerBrokerIngress
            && (
                snapshot?.status !== 'ready'
                || readServerEnabledBit(snapshot.features, 'teams.credentialResources') !== true
            )
        ) {
            const { providerBrokerIngress: _providerBrokerIngress, ...compatibleCapabilities } = capabilities;
            capabilities = Object.keys(compatibleCapabilities).length > 0
                ? compatibleCapabilities
                : null;
        }
        if (!capabilities) return null;
        if (!capabilities?.sessionSpawn) return capabilities;

        // Capability publication consumes only the daemon-wide cache supplied by
        // composition. Absence is unknown and must not trigger a per-publication
        // feature request or advertise a target route an older server cannot own.
        const sessionInputAdmission = resolveMachineSessionInputAdmissionCapability(snapshot);
        const requirements = snapshot?.status === 'ready'
            ? snapshot.features.capabilities.accountStoredContentCompatibility
            : undefined;
        const negotiatedCapabilities = {
            ...capabilities,
            sessionInputAdmission,
        };
        if (
            !requirements
            || requirements.currentProtocolVersion
                < ACCOUNT_STORED_CONTENT_SESSION_SPAWN_PLACEMENT_ORIGIN_PROTOCOL_VERSION
        ) return negotiatedCapabilities;

        return {
            ...negotiatedCapabilities,
            sessionSpawnPlacementOrigin: { protocolVersions: [1] },
        };
    }

    private async synchronizeIrohMachineEndpointAuthority(
        state: DaemonState,
        withdrewPersistedEndpoint = false,
    ): Promise<void> {
        const nextEndpoint = state.peerMediation?.iroh?.endpoint ?? null;
        if (isDeepStrictEqual(nextEndpoint, this.currentIrohMachineEndpoint)
            && !((withdrewPersistedEndpoint || this.pendingPersistedIrohEndpointWithdrawal)
                && nextEndpoint === null)) return;
        const previousEndpoint = this.currentIrohMachineEndpoint;
        this.currentIrohMachineEndpoint = nextEndpoint;

        const socket = this.socket;
        if (!socket || socket.connected !== true) return;
        // The server stores this as a replace-all projection. Endpoint changes
        // therefore have to republish the complete capability set; publishing
        // only the endpoint while readiness is still being established would
        // silently withdraw session and plugin capabilities.
        const capabilities = await this.resolveCurrentMachineOperationProtocolCapabilitiesForPublication() ?? {};
        try {
            await this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities);
        } catch (error) {
            this.currentIrohMachineEndpoint = previousEndpoint;
            throw error;
        }
        if (this.socket === socket && socket.connected === true) {
            this.advertisedOperationProtocolCapabilitiesGeneration = this.activeTransportGeneration;
        }
    }

    private discardUnverifiedIrohEndpoint(state: DaemonState | null): DaemonState | null {
        const peerMediation = state?.peerMediation;
        if (!state || !peerMediation?.iroh
            || isDeepStrictEqual(peerMediation.iroh.endpoint, this.currentIrohMachineEndpoint)) return state;
        // A stored endpoint is not proof of this process's live acceptor. This
        // also applies when a version-mismatch reloads older server state.
        this.pendingPersistedIrohEndpointWithdrawal = true;
        return { ...state, peerMediation: { ...peerMediation, iroh: undefined } };
    }

    /**
     * Publishes or withdraws the broker application capability. The composition
     * root calls this only when the exact provider-broker application handler
     * is installed; absence keeps the leaf withdrawn so every Machine stays
     * ineligible as a broker (fail closed).
     */
    async setProviderBrokerIngressLive(live: boolean): Promise<void> {
        if (this.providerBrokerIngressAdvertised === live) return;
        const previous = this.providerBrokerIngressAdvertised;
        this.providerBrokerIngressAdvertised = live;
        try {
            await this.refreshProviderBrokerIngressAdvertisement();
        } catch (error) {
            this.providerBrokerIngressAdvertised = previous;
            throw error;
        }
    }

    /** Re-evaluates Home support after the canonical feature snapshot changes. */
    async refreshProviderBrokerIngressAdvertisement(currentServerFeatures?: FeaturesResponse): Promise<void> {
        await this.refreshOperationProtocolCapabilitiesAdvertisement(currentServerFeatures);
    }

    /** Composition supplies the live native acceptor plus preview application fact. */
    async setLocalServicePreviewNativeAccessLive(live: boolean): Promise<void> {
        // Local adapter availability remains truthful even if Home acknowledgement
        // fails; reconnect publishes this same complete projection again.
        this.localServicePreviewNativeAccessLive = live;
        await this.refreshOperationProtocolCapabilitiesAdvertisement();
    }

    private async refreshOperationProtocolCapabilitiesAdvertisement(currentServerFeatures?: FeaturesResponse): Promise<void> {
        const socket = this.socket;
        if (!socket || socket.connected !== true) return;
        // Replace-all projection: republish the complete capability set so the
        // readiness changes never withdraw unrelated session or endpoint capabilities.
        const capabilities = await this.resolveCurrentMachineOperationProtocolCapabilitiesForPublication(
            true,
            currentServerFeatures,
        ) ?? {};
        await this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities);
        if (this.socket === socket && socket.connected === true) {
            this.advertisedOperationProtocolCapabilitiesGeneration = this.activeTransportGeneration;
        }
    }

    async updateMachineMetadata(
        handler: (metadata: MachineMetadata | null) => MachineMetadata,
    ): Promise<MachinePublicationOutcome> {
        if (this.shouldSuppressMachinePublication()) {
            return 'suppressed';
        }
        return await backoff(async () => {
            if (this.shouldSuppressMachinePublication()) {
                return 'suppressed';
            }
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const updated = handler(this.machine.metadata);

            // No-op: don't write if nothing changed.
            if (this.machine.metadata && JSON.stringify(updated) === JSON.stringify(this.machine.metadata)) {
                return 'unchanged';
            }

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-metadata',
                payload: {
                    machineId: this.machine.id,
                    metadata: this.machineContentCodec.encodeStored(updated),
                    expectedVersion: this.machine.metadataVersion,
                },
            });

            if (answer.result === 'success') {
                this.machine.metadata = this.machineContentCodec.decodeStored(answer.metadata) as MachineMetadata;
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
                return 'published';
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = this.machineContentCodec.decodeStored(answer.metadata) as MachineMetadata;
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
            throw new Error('Unexpected machine metadata update acknowledgement');
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(
        handler: (state: DaemonState | null) => DaemonState,
        options?: ApiMachineDaemonStatePublicationOptions,
    ): Promise<MachinePublicationOutcome> {
        if (this.shouldSuppressMachinePublication(options?.allowWhileQuiescing)) {
            return 'suppressed';
        }
        return await backoff(async () => {
            if (this.shouldSuppressMachinePublication(options?.allowWhileQuiescing)) {
                return 'suppressed';
            }
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const previousIrohEndpoint = this.machine.daemonState?.peerMediation?.iroh?.endpoint ?? null;
            const updated = handler(this.machine.daemonState);

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-state',
                payload: {
                    machineId: this.machine.id,
                    daemonState: this.machineContentCodec.encodeStored(updated),
                    expectedVersion: this.machine.daemonStateVersion,
                },
            });

            if (answer.result === 'success') {
                this.machine.daemonState = this.machineContentCodec.decodeStored(answer.daemonState) as DaemonState;
                this.machine.daemonStateVersion = answer.version;
                await this.synchronizeIrohMachineEndpointAuthority(
                    this.machine.daemonState,
                    previousIrohEndpoint !== null,
                );
                logger.debug('[API MACHINE] Daemon state updated successfully');
                return 'published';
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = this.discardUnverifiedIrohEndpoint(
                        this.machineContentCodec.decodeStored(answer.daemonState) as DaemonState,
                    );
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
            throw new Error('Unexpected machine daemon-state update acknowledgement');
        });
    }

    private getDaemonTerminalSessionMutationOutbox(
        sessionId: string,
        isShuttingDown: (() => boolean) | undefined = this.lifecycleDependencies.isDaemonQuiescing,
    ): DaemonSessionClientDurableMutationOutbox {
        const existing = this.daemonTerminalSessionMutationOutboxes.get(sessionId);
        if (existing) return existing;

        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: this.token,
            sessionId,
            getSocket: () => null,
            getSessionTurnServerContractMode: () => (
                this.getSessionSyncPendingInputServerContractResult()?.mode ?? null
            ),
            requestReconnect: () => undefined,
            ...(isShuttingDown ? { isShuttingDown } : {}),
        });
        this.daemonTerminalSessionMutationOutboxes.set(sessionId, outbox);
        return outbox;
    }

    async enqueueDaemonTerminalExactTurnEnd(mutation: ExactSessionTurnEndMutationV1): Promise<void> {
        await this.getDaemonTerminalSessionMutationOutbox(mutation.sessionId).enqueueExactTurnEnd(mutation);
    }

    async recoverDaemonTerminalSessionMutationJournals(params: Readonly<{
        bindUsageLimitRecoveryJournals: (sessionIds: readonly string[]) => Promise<Readonly<{
            boundSessionIds: readonly string[];
            retainedSessionIds: readonly string[];
        }>>;
        isShuttingDown?: () => boolean;
    }>): Promise<Readonly<{ recoveredSessionIds: readonly string[]; retainedSessionIds: readonly string[] }>> {
        const recoveredSessionIds: string[] = [];
        let retainedSessionIds: readonly string[] = [];
        const isShuttingDown = (): boolean => params.isShuttingDown?.() === true;
        if (isShuttingDown()) {
            return { recoveredSessionIds, retainedSessionIds };
        }
        const sessionIds = await discoverDaemonSessionClientDurableMutationJournalSessionIds(
            configuration.activeServerDir,
        );
        if (isShuttingDown()) {
            return { recoveredSessionIds, retainedSessionIds };
        }
        const usageBindings = await params.bindUsageLimitRecoveryJournals(sessionIds);
        retainedSessionIds = usageBindings.retainedSessionIds;
        for (const sessionId of sessionIds) {
            if (isShuttingDown()) break;
            const outbox = this.getDaemonTerminalSessionMutationOutbox(sessionId, isShuttingDown);
            if (isShuttingDown()) break;
            await outbox.awaitReady();
            if (isShuttingDown()) break;
            await outbox.flush('startup');
            recoveredSessionIds.push(sessionId);
        }
        return {
            recoveredSessionIds,
            retainedSessionIds,
        };
    }

    connect(params?: {
        takeover?: boolean;
        onConnect?: () => void | Promise<void>;
        onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
        onMachineReplaced?: (event: { machineId: string }) => void;
        prepareServerTransportForReconnect?: () => Promise<ReadinessProbeResult>;
    }) {
        logger.debug(`[API MACHINE] Connecting to ${resolveServerHttpBaseUrl()}`);
        let takeoverOnNextConnect = params?.takeover === true;

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                classifyTransportErrorToProbeResult,
                createTransport: () => {
                    const serverUrl = resolveServerHttpBaseUrl();
                    const transportGeneration = this.activeTransportGeneration + 1;
                    this.activeTransportGeneration = transportGeneration;
                    const installationIdentity = configuration.installationIdentityFile
                        ? readInstallationIdentityIfExistsSync()
                        : null;
                    const installationProof = installationIdentity
                        ? buildInstallationProofForMachine({
                            identity: installationIdentity,
                            machineId: this.machine.id,
                            token: this.token,
                        })
                        : null;
                    const { socket, transport } = createMachineSocketTransport({
                        serverUrl,
                        token: this.token,
                        machineId: this.machine.id,
                        ...(installationProof
                            ? {
                                installationId: installationProof.installationId,
                                installationPublicKey: installationProof.installationPublicKey,
                                installationProof: installationProof.installationProof,
                            }
                            : null),
                        ...this.ownershipMetadata,
                        takeover: takeoverOnNextConnect,
                        transports: resolveServerSocketIoTransports(),
                        env: process.env,
                    });
                    this.connectedClientRpcMethods.clear();
                    this.socket = socket;
                    this.installSocketEventHandlers(
                        socket,
                        transportGeneration,
                        params,
                    );
                    socket.on('disconnect', () => {
                        this.handleTransportSocketDisconnect(socket, transportGeneration);
                    });
                    return transport;
                },
                probeReadiness: async () => {
                    const prepared = await params?.prepareServerTransportForReconnect?.();
                    if (prepared && prepared.status !== 'ready') return prepared;
                    return await createLoopbackReadinessProbe({
                        serverUrl: resolveServerHttpBaseUrl(),
                        token: this.token,
                    })();
                },
                onStateChange: (state) => {
                    this.currentConnectionState = state;
                    for (const listener of this.connectionStateListeners) {
                        listener(state);
                    }
                },
                onConnected: async () => {
                    logger.debug('[API MACHINE] Connected to server');
                    const isReconnect = this.hasConnectedOnce;
                    this.hasConnectedOnce = true;
                    takeoverOnNextConnect = false;

                    const socket = this.socket;
                    const transportGeneration =
                        this.activeTransportGeneration;
                    const missingCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
                        (method) => !this.rpcHandlerManager.hasHandler(method),
                    );
                    if (socket) {
                        this.rpcHandlerManager.onSocketConnect(socket);
                        // A persisted projection replaces rather than merges, so publishing an
                        // empty one withdraws sessionSpawn until something republishes it.
                        // Publish it only when it is true of this daemon — the exact-target
                        // handlers are absent, or the creation-outcome attestation is missing —
                        // which is the server's fail-closed input. Otherwise leave the server's
                        // projection alone and let the readiness publication below assert the
                        // real capabilities: a daemon that holds the capability must never
                        // advertise itself as capability-less, because every path that would
                        // undo that can fail.
                        if (
                            missingCoreHandlers.length > 0
                            || this.currentMachineOperationProtocolCapabilities() === null
                        ) {
                            const failClosedCapabilities =
                                this.currentMachineOperationProtocolCapabilities(false) ?? {};
                            await this
                                .publishOperationProtocolCapabilitiesOnSocket(socket, failClosedCapabilities)
                                .catch(() => {
                                    logger.warn('[API MACHINE] Failed to publish the fail-closed operation protocol capability projection on connect');
                                });
                        }
                        const contractResult =
                            await this
                                .sessionSyncPendingInputServerContractController
                                .resolve({
                                    sessionConnectionEpoch:
                                        transportGeneration,
                                    socket,
                                    machineId: this.machine.id,
                                });
                        if (
                            this.socket === socket
                            && this.activeTransportGeneration
                                === transportGeneration
                            && socket.connected === true
                        ) {
                            this.sessionSyncPendingInputServerContractResult =
                                contractResult;
                            for (const outbox of this.daemonTerminalSessionMutationOutboxes.values()) {
                                void outbox.flush('connect').catch((error) => {
                                    logger.warn('[API MACHINE] Daemon terminal mutation reconnect flush failed', {
                                        error: serializeAxiosErrorForLog(error),
                                    });
                                });
                            }
                        }
                    }

                    if (missingCoreHandlers.length > 0) {
                        logger.warn('[API MACHINE] Core machine-control RPC handlers are not installed', {
                            missingMethods: missingCoreHandlers,
                        });
                    } else if (socket) {
                        // Deliberately not awaited. The deadline below bounds how long this
                        // attempt watches for the server's registration acknowledgements before
                        // reporting them as outstanding; it is not a functional cutoff, because
                        // every later acknowledgement re-enters the same publication. Awaiting
                        // it here would only delay keep-alive and changes sync by the deadline.
                        void (async () => {
                            let registrationResult =
                                await this.publishMachineControlReadinessWhenReady({
                                    socket,
                                    transportGeneration,
                                    timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                });
                            const isCurrentTransport = () => (
                                this.socket === socket
                                && this.activeTransportGeneration === transportGeneration
                                && socket.connected === true
                            );
                            if (
                                registrationResult.readiness.status === 'timeout'
                                && isCurrentTransport()
                            ) {
                                this.rpcHandlerManager.replayUnacknowledgedHandlerRegistrations();
                                registrationResult =
                                    await this.publishMachineControlReadinessWhenReady({
                                        socket,
                                        transportGeneration,
                                        timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                    });
                            }
                            if (
                                registrationResult.readiness.status === 'ready'
                                && !registrationResult.ready
                                && isCurrentTransport()
                            ) {
                                this.reportMachineControlReadinessPublicationFailure({
                                    socket,
                                    transportGeneration,
                                });
                                return;
                            }
                            if (
                                registrationResult.readiness.status === 'timeout'
                                && isCurrentTransport()
                            ) {
                                logger.warn('[API MACHINE] Core machine-control RPC registration did not become ready', {
                                    status: registrationResult.readiness.status,
                                    missingMethods: registrationResult.readiness.missingMethods,
                                });
                            }
                        })().catch((error) => {
                            logger.warn('[API MACHINE] Machine-control readiness publication failed', {
                                message: error instanceof Error ? error.message : String(error),
                            });
                        });
                    }

                    this.startChangesSyncWithRetry({ reason: isReconnect ? 'reconnect' : 'connect' });
                    this.startKeepAlive();

                    if (params?.onConnect) {
                        await Promise.resolve(params.onConnect()).catch(() => {});
                    }
                },
                onDisconnected: async () => {
                    // The transport socket that actually disconnected owns teardown via its
                    // socket-scoped disconnect handler. This avoids stale callbacks from an
                    // older transport clearing a newer active socket.
                },
                onAuthFailed: async (ctx) => {
                    logger.debug('[API MACHINE] Auth failed');
                    if (!this.isCurrentConnectionState(ctx.state)) {
                        return;
                    }
                    this.teardownActiveSocket();
                },
            });
        }

        void this.connectionSupervisor.start().catch((error) => {
            logger.warn('[API MACHINE] Failed to start machine connection supervisor', {
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }

    requestServerTransportReconnect(): boolean {
        const supervisor = this.connectionSupervisor;
        const scope = supervisor?.captureProbeReportScope?.();
        if (!supervisor?.reportProbeResult || !scope) return false;
        supervisor.reportProbeResult({
            status: 'server_unreachable',
            errorMessage: 'The active Home transport descriptor changed',
        }, scope);
        return true;
    }

    private installSocketEventHandlers(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        transportGeneration: number,
        params?: {
            takeover?: boolean;
            onConnect?: () => void | Promise<void>;
            onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
            onMachineReplaced?: (event: { machineId: string }) => void;
        },
    ) {
        socket.on('connect_error', (error: unknown) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const ownershipConflict = readMachineOwnerConflictFromSocketError(error);
            if (!ownershipConflict) {
                const diagnostic = readSocketConnectErrorDiagnostic(error);
                logger.warn('[API MACHINE] Machine socket connect error', diagnostic);
                if (isMachineReplacedSocketError(error)) {
                    void this.connectionSupervisor?.stop().catch(() => {});
                    params?.onMachineReplaced?.({ machineId: this.machine.id });
                }
                return;
            }
            void this.connectionSupervisor?.stop().catch(() => {});
            params?.onOwnershipConflict?.(ownershipConflict);
        });

        socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: unknown }, callback: (response: unknown) => void) => {
            const isCurrentTransport = () => (
                this.isActiveTransportGeneration(transportGeneration)
                && socket === this.socket
            );
            if (!isCurrentTransport()) {
                return;
            }
            logger.debugLargeJson(
                `[API MACHINE] Received RPC request:`,
                projectIncomingMachineRpcDebugPayload(data),
            );
            const response = await this.rpcHandlerManager.handleRequest(data);
            if (!isCurrentTransport()) {
                return;
            }
            callback(response);
        });

        socket.on(SOCKET_RPC_EVENTS.REGISTERED, (data: { method: string }) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const method = this.normalizeConnectedClientRpcAvailabilityMethod(data.method);
            if (method) {
                this.connectedClientRpcMethods.add(method);
            }
        });

        socket.on(SOCKET_RPC_EVENTS.UNREGISTERED, (data: { method: string }) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const method = this.normalizeConnectedClientRpcAvailabilityMethod(data.method);
            if (method) {
                this.connectedClientRpcMethods.delete(method);
            }
        });

        socket.on(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, (data: MachineTransferReceiveEnvelope) => {
            for (const listener of this.machineTransferListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Machine transfer listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(TRANSFER_RELAY_V2_SOCKET_EVENT, (data: TransferRelayV2SendEnvelope) => {
            for (const listener of this.transferRelayV2Listeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Transfer relay v2 listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (data: PeerTcpTunnelRelayEnvelope) => {
            for (const listener of this.peerTcpTunnelRelayListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Peer TCP tunnel relay listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, async (raw: unknown) => {
            const parsed = MachineLiveStreamRelayEnvelopeV1Schema.safeParse(raw);
            if (!parsed.success) {
                logger.warn('[API MACHINE] Live-stream payload rejected', { code: 'stream_payload_invalid' });
                return;
            }
            const codec = this.machineContentCodec;
            const opened = hasMachineLiveStreamSensitiveContentV1(parsed.data)
                ? await openMachineLiveStreamEnvelopeV1(parsed.data, {
                    mode: codec.mode,
                    ...(codec.mode === 'e2ee' ? { cipher: {
                        encryptRaw: (value: unknown) => codec.encodeRpc(value),
                        decryptRaw: (value: string) => codec.decodeRpc(value),
                    } } : {}),
                })
                : { ok: true as const, value: MachineLiveStreamDecodedEnvelopeV1Schema.parse(parsed.data) };
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) return;
            if (!opened.ok) {
                this.failMachineLiveStreamPayload(parsed.data, opened.code);
                return;
            }
            const data = opened.value;
            for (const listener of this.machineLiveStreamRelayListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Machine live-stream relay listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(
            EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
            (data: ExternalSessionStatusDemandDaemonMessageV1) => {
                if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                    return;
                }
                for (const listener of this.externalSessionStatusDemandListeners) {
                    try {
                        listener(data);
                    } catch (error) {
                        logger.warn('[API MACHINE] External-session status-demand listener threw (ignored)', {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            },
        );

        socket.on('update', (data: Update) => {
            if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = this.machineContentCodec.decodeStored(update.metadata.value) as MachineMetadata;
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = this.machineContentCodec.decodeStored(update.daemonState.value) as DaemonState;
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
                return;
            }

            const handled = this.dispatchUpdate(data);
            if (data.body.t === 'pending-changed') {
                const requestId = typeof data.body.pendingActivationRequestId === 'string'
                    ? data.body.pendingActivationRequestId.trim()
                    : '';
                const sessionId = typeof data.body.sessionId === 'string'
                    ? data.body.sessionId.trim()
                    : data.body.sid.trim();
                if (requestId && sessionId) {
                    void this.notifyPendingSessionActivationHint({
                        sessionId,
                        requestId,
                        pendingVersion: data.body.pendingVersion,
                        source: 'live',
                    });
                }
            }
            if (
                data.body.t === 'account-change'
                || (
                    data.body.t === 'update-account'
                    && 'connectedServices' in data.body
                    && data.body.connectedServices !== undefined
                )
            ) {
                this.startChangesSyncWithRetry({ reason: 'live' });
            }
            if (!handled && process.env.DEBUG) {
                logger.debug(`[API MACHINE] Ignored update type: ${(data.body as any).t}`);
            }
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            if (!this.socket) {
                return;
            }
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    async shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        // Socket reconnects retain this Account scope; process-terminal
        // shutdown is the canonical point that retires its Collection cursor
        // retention and active local observers.
        retirePluginAccountCollectionWatchScope(resolveAccountSettingsScopeKeyForToken(this.token));
        this.projectionSchedulingClosed = true;
        this.activeTransportGeneration += 1;
        this.teardownActiveSocket();
        this.connectedServicesProjectionRetry.close();
        if (this.connectionSupervisor) {
            await this.connectionSupervisor.stop();
        }
        await this.connectedServicesProjectionRetry.waitForIdle();
        await this.rpcHandlerManager.waitForIdle();
        await this.disposeRpcLifecycleRegistrations();
        await this.fileSystemTransferRelayOwner.store.dispose();
        const daemonTerminalOutboxes = Array.from(this.daemonTerminalSessionMutationOutboxes.values());
        this.daemonTerminalSessionMutationOutboxes.clear();
        await Promise.all(daemonTerminalOutboxes.map(async (outbox) => {
            try {
                await outbox.close();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to close session-end mutation outbox', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    private async disposeRpcLifecycleRegistrations(): Promise<void> {
        const registrations = this.rpcLifecycleRegistrations.splice(0);
        await Promise.all(registrations.map(async (registration) => {
            try {
                await registration.dispose();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to dispose RPC lifecycle registration', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    async awaitPendingRpcRequests(): Promise<void> {
        await this.rpcHandlerManager.waitForIdle();
    }

    getActiveRpcHandlerExecutions(): readonly RpcHandlerActiveExecution[] {
        return this.rpcHandlerManager.getActiveHandlerExecutions();
    }

    /**
     * Resolves one exact Session access fact through the incumbent Account
     * change carrier. The returned cursor is admission evidence only: this
     * method never persists or acknowledges it as consumed feed progress.
     */
    async resolvePluginResourceSessionAccess(params: Readonly<{
        accountId: string;
        sessionId: string;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        accountId: string;
        throughCursor: number;
        status: 'available' | 'unavailable';
    }>> {
        params.signal.throwIfAborted();
        const accountId = await this.getAccountId(params.signal);
        params.signal.throwIfAborted();
        if (!accountId || accountId !== params.accountId) {
            throw new Error('plugin_resource_session_access_unavailable');
        }
        const result = await fetchChanges({
            token: this.token,
            after: 0,
            limit: 1,
            sessionAccessSessionId: params.sessionId,
            signal: params.signal,
        });
        params.signal.throwIfAborted();
        if (result.status !== 'ok') {
            throw new Error('plugin_resource_session_access_unavailable');
        }
        const probe = result.response.sessionAccessProbe;
        if (!probe || probe.sessionId !== params.sessionId) {
            // Supported older servers omit the additive exact proof. The
            // affected Session-scoped operation fails closed without changing
            // global Account Resources or the ordinary change cursor.
            throw new Error('plugin_resource_session_access_unavailable');
        }
        return Object.freeze({
            accountId,
            throughCursor: probe.throughCursor,
            status: probe.status,
        });
    }

    private async getAccountId(signal?: AbortSignal): Promise<string | null> {
        if (this.accountIdPromise) {
            return await this.accountIdPromise.catch((error) => {
                if (isAuthenticationError(error)) {
                    if (this.connectionSupervisor) {
                        return null;
                    }
                    throw error;
                }
                return null;
            });
        }

        const request = () => fetchChangesAccountId({ token: this.token, ...(signal ? { signal } : {}) });
        const supervisor = this.connectionSupervisor;
        const p = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch (error) {
            this.accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        }
    }

    private async refreshMachineFromServer(signal?: AbortSignal): Promise<void> {
        try {
            const serverUrl = resolveServerHttpBaseUrl();
            const request = async () => {
                const response = await axios.get(`${serverUrl}/v1/machines/${this.machine.id}`, {
                    headers: {
                        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15_000,
                    ...(signal ? { signal } : {}),
                    validateStatus: () => true,
                });
                if (isAuthenticationStatus(response.status)) {
                    throw createAuthenticationHttpStatusError(
                        response.status,
                        `Authentication failed while refreshing machine snapshot (${response.status})`,
                    );
                }
                return response;
            };
            const response = this.connectionSupervisor
                ? await runSupervisedRequest({
                    supervisor: this.connectionSupervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                    readStatusCode: (result) => result.status,
                })
                : await request();

            if (response.status !== 200) {
                return;
            }

            const raw = (response.data as any)?.machine;
            if (!raw || typeof raw !== 'object') {
                return;
            }

            const nextMetadata =
                typeof raw.metadata === 'string'
                    ? this.machineContentCodec.decodeStored(raw.metadata) as MachineMetadata
                    : null;
            const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : this.machine.metadataVersion;

            const nextDaemonState =
                typeof raw.daemonState === 'string'
                    ? this.machineContentCodec.decodeStored(raw.daemonState) as DaemonState
                    : null;
            const nextDaemonStateVersion = typeof raw.daemonStateVersion === 'number' ? raw.daemonStateVersion : this.machine.daemonStateVersion;

            if (nextMetadataVersion > this.machine.metadataVersion) {
                this.machine.metadata = nextMetadata;
                this.machine.metadataVersion = nextMetadataVersion;
            }
            if (nextDaemonStateVersion > this.machine.daemonStateVersion) {
                this.machine.daemonState = nextDaemonState;
                this.machine.daemonStateVersion = nextDaemonStateVersion;
            }
        } catch (error) {
            logger.debug('[API MACHINE] Failed to refresh machine snapshot', {
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    /** The Account-change carrier is the only source of Session access proof. */
    private applyResourceSessionAccessWitness(
        params: Parameters<PluginReloadController['applyResourceSessionAccessWitness']>[0],
    ): void {
        const lifecycle = this.lifecycleDependencies.resourceSessionLifecycle
            ?? pluginReloadController;
        lifecycle.applyResourceSessionAccessWitness(params);
    }

    /**
     * Synchronizes the Account-scoped Saved Secret catalog through its one
     * feature decision. Shared Saved Secrets belong to Teams itself; the
     * narrower credential-resource product is not their activation owner.
     */
    private async synchronizeSavedSecretCatalog(signal: AbortSignal): Promise<void> {
        let snapshot: Awaited<ReturnType<NonNullable<
            ApiMachineClientLifecycleDependencies['resolveServerFeaturesSnapshot']
        >>> | undefined;
        try {
            snapshot = await this.lifecycleDependencies.resolveServerFeaturesSnapshot?.();
        } catch (error) {
            signal.throwIfAborted();
            logger.debug('[API MACHINE] Saved Secret feature decision unavailable; withdrawing shared catalog', {
                message: error instanceof Error ? error.message : String(error),
            });
            snapshot = undefined;
        }
        signal.throwIfAborted();
        await hydrateSavedSecretCatalog({
            token: this.token,
            serverFeatures: snapshot?.status === 'ready' ? snapshot.features : null,
            signal,
        });
    }

    private async syncChangesOnConnect(
        opts: { reason: 'connect' | 'reconnect' | 'live' },
        signal: AbortSignal = new AbortController().signal,
    ): Promise<void> {
        // Startup/reconnect recover the full projection; live wakes classify the changes page first.
        const executionAuthority = opts.reason === 'live'
            ? 'runtime_recovery' as const
            : 'passive_projection' as const;
        const requestSupervisionScope = this.connectionSupervisor?.captureProbeReportScope?.();
        signal.throwIfAborted();
        if (opts.reason !== 'live') {
            try {
                await this.reconcileConnectedServicesProjection({
                    source: opts.reason === 'connect' ? 'startup' : 'reconnect',
                    executionAuthority,
                }, signal);
            } catch (error) {
                if (handleRequestAuthenticationFailure({
                    supervisor: this.connectionSupervisor,
                    error,
                    hadAuth: true,
                    scope: requestSupervisionScope,
                })) {
                    return;
                }
                throw error;
            }
        }

        const enabled = (() => {
            const raw = process.env.HAPPY_ENABLE_V2_CHANGES;
            if (!raw) return true;
            return ['true', '1', 'yes'].includes(raw.toLowerCase());
        })();
        if (!enabled) {
            return;
        }

        signal.throwIfAborted();
        const accountId = await this.getAccountId(signal);
        signal.throwIfAborted();
        if (!accountId) throw new Error('account_changes_account_id_unavailable');
        const accountScopeKey = resolveAccountSettingsScopeKeyForToken(this.token);

        const CHANGES_PAGE_LIMIT = 200;
        const after = await readAccountChangesCursor(accountId);
        const result = await fetchChanges({ token: this.token, after, limit: CHANGES_PAGE_LIMIT, signal });
        signal.throwIfAborted();

        if (result.status === 'cursor-gone') {
            publishSessionFollowWakeInvalidation();
            this.applyResourceSessionAccessWitness({ accountId });
            signal.throwIfAborted();
            await this.notifySessionAccessReset({ cursor: result.currentCursor });
            signal.throwIfAborted();
            await this.refreshMachineFromServer(signal);
            signal.throwIfAborted();
            await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'cursor-gone' });
            signal.throwIfAborted();
            publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
            publishPluginAccountCollectionWatchInvalidation({
                accountScopeKey,
                kind: 'reset',
                changeCursor: result.currentCursor,
            });
            await this.reconcileConnectedServicesProjection({ source: 'cursor-gone', executionAuthority }, signal);
            signal.throwIfAborted();
            await this.synchronizeSavedSecretCatalog(signal);
            signal.throwIfAborted();
            await this.notifyManagedProviderRetainedCurrentnessInvalidation({
                source: 'cursor-gone',
                signal,
            });
            signal.throwIfAborted();
            await writeAccountChangesCursor(accountId, result.currentCursor);
            signal.throwIfAborted();
            return;
        }
        if (result.status !== 'ok') {
            if (handleRequestAuthenticationFailure({
                supervisor: this.connectionSupervisor,
                error: result.error,
                hadAuth: true,
                scope: requestSupervisionScope,
            })) {
                return;
            }

            // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
            // On reconnect, fall back to a snapshot refresh.
            const changesEndpointUnavailable = asRecord(result.error)?.status === 404;
            if (changesEndpointUnavailable) {
                this.applyResourceSessionAccessWitness({ accountId });
                signal.throwIfAborted();
            }
            if (opts.reason === 'reconnect' || opts.reason === 'live') {
                await this.refreshMachineFromServer(signal);
            }
            if (changesEndpointUnavailable) return;

            // A snapshot does not acknowledge a transient changes-feed failure.
            // Let the canonical retry owner retain and retry the current work.
            throw result.error;
        }

        const changes = result.response.changes;
        if (opts.reason !== 'live' || changes.length >= CHANGES_PAGE_LIMIT || changes.some((change) => change.kind === 'session')) {
            publishSessionFollowWakeInvalidation();
        }
        const nextCursor = result.response.nextCursor;
        this.applyResourceSessionAccessWitness({
            accountId,
            ...(result.response.sessionAccessWitness === undefined
                ? {}
                : { witness: result.response.sessionAccessWitness }),
        });
        signal.throwIfAborted();
        const pluginAccountSettingsInvalidations = readPluginAccountSettingsWatchInvalidations(changes);
        const pluginAccountCollectionInvalidations = readPluginAccountCollectionWatchInvalidations(changes);

        const hasRelevantMachineChange = changes.some(
            (c) => c.kind === 'machine' && c.entityId === this.machine.id,
        );
        const accountSettingsVersions = changes
            .filter((c) => c.kind === 'account' && c.entityId === 'self')
            .map((c) => readAccountSettingsVersionFromHint(c.hint))
            .filter((version): version is number => version !== null);
        const highestAccountSettingsVersion = accountSettingsVersions.length > 0
            ? Math.max(...accountSettingsVersions)
            : null;
        const hasConnectedServicesChange = changes.some((change) => {
            if (change.kind !== 'account' || change.entityId !== 'self') return false;
            const hint = change.hint;
            return hint !== null
                && typeof hint === 'object'
                && !Array.isArray(hint)
                && (hint as { connectedServices?: unknown }).connectedServices === true;
        });
        const hasSavedSecretCatalogChange = changesRequireSavedSecretCatalogRefresh(changes);
        const hasTeamChange = changes.some((change) => (
            change.kind === 'account'
            && change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
        ));
        const pendingActivationHints = changes.flatMap((change): PendingSessionActivationHintNotification[] => {
            if (change.kind !== 'session') return [];
            const hint = asRecord(change.hint);
            if (!hint) return [];
            const requestId = typeof hint.pendingActivationRequestId === 'string'
                ? hint.pendingActivationRequestId.trim()
                : '';
            const sessionId = change.entityId.trim();
            const pendingVersion = hint.pendingVersion;
            if (
                !requestId
                || !sessionId
                || typeof pendingVersion !== 'number'
                || !Number.isSafeInteger(pendingVersion)
                || pendingVersion < 0
            ) return [];
            return [{ sessionId, requestId, pendingVersion, source: 'changes' }];
        });
        const deletedSessionChangeNotifications = changes.flatMap((change) => {
            const deletion = readAuthoritativeSessionDeletionChangeV1(change);
            if (!deletion) return [];
            // A durable Session-deletion fact is delivered only by the
            // authenticated Account whose changes feed produced it. Pin that
            // Account's operation scope onto the notification so cleanup
            // targets exactly the partition owning the deleted Session's
            // operation records, even if the ambient credentials rotate
            // before the listener runs. Fail closed when the delivering
            // Account cannot be established: the cursor stays untouched and
            // the fact replays.
            const accountScope = resolveExternalSessionOperationAccountScope(
                configuration.activeServerDir,
                this.token,
            );
            if (!accountScope) {
                throw new Error('account_changes_account_scope_unavailable');
            }
            return [{ ...deletion, accountScope }];
        });

        if (changes.length >= CHANGES_PAGE_LIMIT || hasRelevantMachineChange) {
            await this.refreshMachineFromServer(signal);
            signal.throwIfAborted();
        }
        if (highestAccountSettingsVersion !== null) {
            await this.notifyAccountSettingsVersionHint({
                settingsVersion: highestAccountSettingsVersion,
                source: 'changes',
            });
        } else if (changes.length >= CHANGES_PAGE_LIMIT) {
            await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'page-limit' });
        }
        if (changes.length >= CHANGES_PAGE_LIMIT) {
            publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
            publishPluginAccountCollectionWatchInvalidation({
                accountScopeKey,
                kind: 'reset',
                changeCursor: nextCursor,
            });
        } else {
            for (const invalidation of pluginAccountSettingsInvalidations) {
                publishPluginAccountSettingsWatchInvalidation(invalidation);
            }
            for (const invalidation of pluginAccountCollectionInvalidations) {
                publishPluginAccountCollectionWatchInvalidation({
                    ...invalidation,
                    accountScopeKey,
                });
            }
        }
        signal.throwIfAborted();

        if (hasConnectedServicesChange || changes.length >= CHANGES_PAGE_LIMIT) {
            await this.reconcileConnectedServicesProjection({
                source: hasConnectedServicesChange ? 'changes' : 'page-limit',
                executionAuthority,
            }, signal);
        }
        if (opts.reason !== 'live' || hasSavedSecretCatalogChange || changes.length >= CHANGES_PAGE_LIMIT) {
            await this.synchronizeSavedSecretCatalog(signal);
            signal.throwIfAborted();
        }
        for (const activationHint of pendingActivationHints) {
            signal.throwIfAborted();
            await this.notifyPendingSessionActivationHint(activationHint);
        }
        for (const deletion of deletedSessionChangeNotifications) {
            signal.throwIfAborted();
            // Cleanup is part of consuming this durable deletion fact. A
            // listener failure leaves the Account cursor untouched so the
            // incumbent changes retry owner replays the exact same deletion.
            await this.notifySessionDeletedChange(deletion);
        }
        for (const entry of result.response.sessionAccessWitness?.entries ?? []) {
            if (entry.status !== 'unavailable') continue;
            signal.throwIfAborted();
            // Same custody rule as deletion: derived local state for a Session
            // the Account can no longer reach is cleared before the cursor
            // advances, so a failed purge replays instead of being lost.
            await this.notifySessionAccessRevoked({
                sessionId: entry.sessionId,
                cursor: entry.cursor,
            });
        }

        if (
            opts.reason !== 'live'
            || changes.length >= CHANGES_PAGE_LIMIT
            || hasTeamChange
            || hasConnectedServicesChange
            || hasSavedSecretCatalogChange
        ) {
            signal.throwIfAborted();
            await this.notifyManagedProviderRetainedCurrentnessInvalidation({
                source: changes.length >= CHANGES_PAGE_LIMIT
                    ? 'page-limit'
                    : opts.reason === 'live' ? 'changes' : opts.reason,
                signal,
            });
        }

        signal.throwIfAborted();
        await writeAccountChangesCursor(accountId, nextCursor);
        signal.throwIfAborted();
    }

    private startChangesSyncWithRetry(opts: { reason: 'connect' | 'reconnect' | 'live' }): void {
        if (this.projectionSchedulingClosed) return;
        this.connectedServicesProjectionRetry.schedule(async (signal) => {
            try {
                await this.syncChangesOnConnect(opts, signal);
            } catch (error) {
                if (!signal.aborted) {
                    logger.warn('[API MACHINE] /v2/changes sync failed; retry scheduled', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
                throw error;
            }
        }, { runImmediately: true });
    }
}
