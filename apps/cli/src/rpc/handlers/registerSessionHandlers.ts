import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { Metadata } from '@/api/types';
export { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
export type { SpawnSessionErrorCode, SpawnSessionErrorDetail } from '@happier-dev/protocol';
export type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { registerCapabilitiesHandlers } from './capabilities';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { registerPreviewEnvHandler } from './previewEnv';
import { registerBashHandler } from './bash';
import { registerRipgrepHandler } from './ripgrep';
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
export {
    readCanonicalSpawnRuntimeSelection,
    readSpawnRuntimeDescriptorV1,
    type CanonicalSpawnRuntimeSelection,
} from './spawnRuntimeSelection';

type RpcRegistrar = Readonly<{
    registerHandler(method: string, handler: (input: unknown) => Promise<unknown>): void;
}>;

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
 * Register all session RPC handlers with the daemon
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
            text: string;
            localId?: string;
            meta: Record<string, unknown>;
            structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        }) => Promise<void> | void) | null;
        sessionRuntimeControls?: SessionRuntimeControls | null;
        accessPolicy?: FilesystemAccessPolicy;
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
) {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };

    registerBashHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
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
    registerRipgrepHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    registerDifftasticHandler(rpcHandlerManager, workingDirectory, { accessPolicy });
    registerSessionUserMessageSendHandler(rpcHandlerManager, {
        workingDirectory,
        sessionId: opts?.sessionId ?? null,
        getSessionMetadata: opts?.getSessionMetadata ?? null,
        enqueueSessionUserMessage: opts?.enqueueSessionUserMessage ?? null,
        sessionRuntimeControls: opts?.sessionRuntimeControls ?? null,
    });
    registerSessionControlHandlers(rpcHandlerManager, {
        getSessionMetadata: opts?.getSessionMetadata ?? null,
        isUsageLimitRecoveryEnabled: opts?.isUsageLimitRecoveryEnabled ?? null,
        sessionRuntimeControls: opts?.sessionRuntimeControls ?? null,
        notifyUsageLimitWaitResumeCancelled: opts?.notifyUsageLimitWaitResumeCancelled ?? null,
    });
    registerSessionTranscriptRpcHandlers({
        rpcHandlerManager,
        ...(opts?.transcriptActionExecutor ? { actionExecutor: opts.transcriptActionExecutor } : {}),
        resolveActionExecutor: () => resolveProductionTranscriptActionExecutor({
            workingDirectory,
            accessPolicy,
            ...(opts?.machineAdmissionTransport
                ? { machineAdmissionTransport: opts.machineAdmissionTransport }
                : {}),
        }),
    });
}
