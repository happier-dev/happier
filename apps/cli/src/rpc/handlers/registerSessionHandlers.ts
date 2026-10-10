import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { Metadata } from '@/api/types';
import { resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import { configuration } from '@/configuration';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { registerTransferDownloadRpcHandlers } from '@/transfers/rpc/registerTransferDownloadRpcHandlers';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';
export { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
export type { SpawnSessionErrorCode, SpawnSessionErrorDetail } from '@happier-dev/protocol';
export type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { registerCapabilitiesHandlers } from './capabilities';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { registerPreviewEnvHandler } from './previewEnv';
import { registerBashHandler } from './bash';
import { registerWorkspaceFileListHandler } from './workspaceFileList';
import { registerWorkspaceFileSearchHandler } from './workspaceFileSearch';
import { registerDifftasticHandler } from './difftastic';
import { registerSessionUserMessageSendHandler } from './sessionUserMessageSend';
import { registerSessionControlHandlers, type SessionRuntimeControls } from './sessionControls';
import {
    registerDaemonContributionRegistryProjectionHandler,
    type DaemonContributionRegistryProjectionRegistrationOptions,
} from './daemonContributionRegistryProjection';
import {
    registerDaemonPluginInvocationLogReadHandler,
    type DaemonPluginInvocationLogReadHandlerOptions,
} from './daemonPluginInvocationLogs';
import { registerDaemonLocalServicePreviewSnapshotHandler } from './daemonLocalServicePreviewSnapshot';
import { registerDaemonBrowserControlHandler } from './daemonBrowserControl';
import { registerDaemonBrowserDiagnosticsSnapshotHandler } from './daemonBrowserDiagnosticsSnapshot';
import { registerDaemonBrowserRecordingHandlers } from './daemonBrowserRecording';
import { registerDaemonSimulatorPreviewHandlers } from './daemonSimulatorPreview';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { SESSION_TRANSCRIPT_RPC_SCOPES } from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import { readStoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { SessionStructuredInputAdmissionPolicyV1 } from '@/session/services/admitSessionStructuredInputV1';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
export {
    readCanonicalSpawnRuntimeSelection,
    readSpawnRuntimeDescriptorV1,
    type CanonicalSpawnRuntimeSelection,
} from './spawnRuntimeSelection';

type RpcRegistrar = Readonly<{
    registerHandler(method: string, handler: (input: unknown) => Promise<unknown>): void;
}>;

function createAuthorizedSessionRpcRegistrar(
    delegate: RpcHandlerRegistrar,
    sessionId: string | null,
): RpcHandlerRegistrar {
    return {
        registerHandler: <TRequest, TResponse>(
            method: string,
            handler: RpcHandler<TRequest, TResponse>,
        ): void => {
            const authorization = resolveSocketRpcSessionAuthorization(method);
            if (!authorization) {
                throw new Error(`unclassified_session_rpc_method:${method}`);
            }
            // Protocol owns routing scope as well as authority. A Machine client has
            // no bound Session and must not publish Session-owned handlers under its id.
            if (!sessionId && authorization.routeToSessionOwnerDaemon) {
                return;
            }
            delegate.registerHandler(method, handler);
        },
    };
}

export function registerSessionTranscriptRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    actionExecutor?: RpcActionExecutor;
    resolveActionExecutor?: () => RpcActionExecutor | Promise<RpcActionExecutor>;
}>): void {
    registerActionSpecRpcHandlers({
        rpcHandlerManager: params.rpcHandlerManager,
        actionExecutor: params.actionExecutor,
        resolveActionExecutor: params.resolveActionExecutor,
        scopes: SESSION_TRANSCRIPT_RPC_SCOPES,
    });
}

async function resolveProductionTranscriptActionExecutor(params: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    machineAdmissionTransport?: NonNullable<
        Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
    >;
}>): Promise<RpcActionExecutor> {
    const credentials = await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return {
            execute: async () => ({
                ok: false,
                errorCode: 'not_authenticated',
                error: 'not_authenticated',
            }),
        };
    }
    return createCliActionExecutorFromCredentials({
        credentials,
        readCredentials: async () => await readStoredCredentials().catch(() => null),
        sessionLogAccess: {
            workingDirectory: params.workingDirectory,
            accessPolicy: params.accessPolicy,
        },
        ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
    });
}

/**
 * Register common Machine/Session RPCs and, for a bound Session, its authorized RPCs.
 */
export function registerSessionHandlers(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{
        sessionId?: string | null;
        getSessionMetadata?: () => Metadata | null;
        isUsageLimitRecoveryEnabled?: (() => Promise<boolean> | boolean) | null;
        notifyUsageLimitWaitResumeCancelled?: ((request: Readonly<{
            sessionId: string;
            attemptId: string;
        }>) => Promise<unknown> | unknown) | null;
        enqueueSessionUserMessage?: ((request: {
            callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
            text: string;
            localId?: string;
            meta: Record<string, unknown>;
            structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        }) => Promise<void> | void) | null;
        sessionRuntimeControls?: SessionRuntimeControls | null;
        accessPolicy?: FilesystemAccessPolicy;
        executionBudgetRegistry?: ExecutionBudgetRegistry;
        admissionDrain?: DaemonAdmissionDrain;
        transcriptActionExecutor?: RpcActionExecutor | null;
        localServicesPreview?: LocalServicePreviewRoutes | null;
        browserControl?: BrowserDaemonControlRoutes | null;
        browserDiagnostics?: BrowserDiagnosticsRoutes | null;
        browserRecording?: BrowserRecordingRoutes | null;
        simulatorPreview?: SimulatorPreviewRoutes | null;
        daemonContributionRegistryProjection?: DaemonContributionRegistryProjectionRegistrationOptions;
        daemonPluginInvocationLogs?: DaemonPluginInvocationLogReadHandlerOptions;
        machineAdmissionTransport?: NonNullable<
            Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
        >;
        getAgentCatalogObservation?: () => Readonly<{
            machineId: string;
            service: AgentProviderCatalogObservationService;
        }> | null;
        createCapabilitiesApiClient?: NonNullable<
            Parameters<typeof registerCapabilitiesHandlers>[1]
        >['createApiClient'];
        activateCapabilitiesPurposeBindings?: NonNullable<
            Parameters<typeof registerCapabilitiesHandlers>[1]
        >['activatePurposeBindings'];
    }>,
): Readonly<{ dispose: () => Promise<void> }> {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };
    const authorizedSessionRpcHandlerManager = createAuthorizedSessionRpcRegistrar(
        rpcHandlerManager,
        opts?.sessionId ?? null,
    );
    const sessionAttachmentStore = opts?.sessionId
        ? new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs, expiryTrigger: 'self' })
        : null;
    if (sessionAttachmentStore && opts?.sessionId) {
        const sessionId = opts.sessionId;
        const pathAllowanceRegistry = createTransferPathAllowanceRegistry();
        const sessionRpcTransferMaxBytes = resolveServerRoutedTransferMaxBytes();
        registerTransferUploadRpcHandlers(authorizedSessionRpcHandlerManager, {
            workingDirectory,
            accessPolicy,
            store: sessionAttachmentStore,
            sessionRpcTransferMaxBytes,
            sessionAttachment: { sessionId },
            attachmentUpload: {
                pathAllowanceRegistry,
                resolveSessionWorkingDirectory: async (requestedSessionId) => requestedSessionId === sessionId ? workingDirectory : null,
            },
        });
        registerTransferDownloadRpcHandlers(authorizedSessionRpcHandlerManager, {
            workingDirectory,
            accessPolicy,
            store: sessionAttachmentStore,
            sessionRpcTransferMaxBytes,
            sessionAttachment: { sessionId },
            getAdditionalAllowedReadDirs: () => pathAllowanceRegistry.getAdditionalAllowedReadDirs(),
        });
    }

    registerBashHandler(rpcHandlerManager, workingDirectory, { accessPolicy, executionBudgetRegistry: opts?.executionBudgetRegistry, admissionDrain: opts?.admissionDrain });
    // Checklist-based machine capability registry (replaces legacy detect-cli / detect-capabilities / dep-status).
    registerCapabilitiesHandlers(rpcHandlerManager, {
        ...(opts?.getAgentCatalogObservation
            ? { getAgentCatalogObservation: opts.getAgentCatalogObservation }
            : {}),
        ...(opts?.createCapabilitiesApiClient
            ? { createApiClient: opts.createCapabilitiesApiClient }
            : {}),
        ...(opts?.activateCapabilitiesPurposeBindings
            ? { activatePurposeBindings: opts.activateCapabilitiesPurposeBindings }
            : {}),
    });
    registerDaemonContributionRegistryProjectionHandler(
        rpcHandlerManager,
        opts?.daemonContributionRegistryProjection,
    );
    registerDaemonPluginInvocationLogReadHandler(
        rpcHandlerManager,
        opts?.daemonPluginInvocationLogs ?? {
            resolveCurrentTarget: async () => null,
        },
    );
    registerDaemonLocalServicePreviewSnapshotHandler(rpcHandlerManager, {
        localServicesPreview: opts?.localServicesPreview ?? null,
    });
    registerDaemonBrowserControlHandler(rpcHandlerManager, {
        browserControl: opts?.browserControl ?? null,
    });
    registerDaemonBrowserDiagnosticsSnapshotHandler(rpcHandlerManager, {
        browserDiagnostics: opts?.browserDiagnostics ?? null,
    });
    registerDaemonBrowserRecordingHandlers(rpcHandlerManager, {
        browserRecording: opts?.browserRecording ?? null,
    });
    registerDaemonSimulatorPreviewHandlers(rpcHandlerManager, {
        simulatorPreview: opts?.simulatorPreview ?? null,
    });
    registerPreviewEnvHandler(rpcHandlerManager);
    registerWorkspaceFileListHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    registerWorkspaceFileSearchHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    registerDifftasticHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    registerSessionUserMessageSendHandler(authorizedSessionRpcHandlerManager, {
        workingDirectory,
        sessionId: opts?.sessionId ?? null,
        getSessionMetadata: opts?.getSessionMetadata ?? null,
        enqueueSessionUserMessage: opts?.enqueueSessionUserMessage ?? null,
        sessionRuntimeControls: opts?.sessionRuntimeControls ?? null,
    });
    registerSessionControlHandlers(authorizedSessionRpcHandlerManager, {
        getSessionMetadata: opts?.getSessionMetadata ?? null,
        isUsageLimitRecoveryEnabled: opts?.isUsageLimitRecoveryEnabled ?? null,
        sessionRuntimeControls: opts?.sessionRuntimeControls ?? null,
        notifyUsageLimitWaitResumeCancelled: opts?.notifyUsageLimitWaitResumeCancelled ?? null,
    });
    registerSessionTranscriptRpcHandlers({
        rpcHandlerManager: authorizedSessionRpcHandlerManager,
        ...(opts?.transcriptActionExecutor ? { actionExecutor: opts.transcriptActionExecutor } : {}),
        resolveActionExecutor: () => resolveProductionTranscriptActionExecutor({
            workingDirectory,
            accessPolicy,
            ...(opts?.machineAdmissionTransport
                ? { machineAdmissionTransport: opts.machineAdmissionTransport }
                : {}),
        }),
    });
    if (opts?.transcriptActionExecutor) {
        registerActionSpecRpcHandlers({
            rpcHandlerManager: authorizedSessionRpcHandlerManager,
            actionExecutor: opts.transcriptActionExecutor,
            actionIds: ['session.role.set'],
        });
    }
    return { dispose: async () => { await sessionAttachmentStore?.dispose(); } };
}
