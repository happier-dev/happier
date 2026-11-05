/** @moduleRealm daemon */
/** Read local GitHub CLI credentials through the shared system/managed tool resolver. */
export { resolveGhNativeToken } from '@happier-dev/cli-common/agents';
/** @realm any */
export type {
    PluginSystemToolContributionV1 as SystemToolContribution,
} from '@happier-dev/protocol';
export type { ExecSpawnRequest } from './managed-services/contract.js';
import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type {
    PluginAgentCliReadinessRequest,
    PluginAgentCliReadinessResult,
    PluginExecSpawnRequest,
    PluginProcessHandle,
    PluginProcessResult,
    ProtocolClientsService,
} from './services/io.js';

declare const agentNativeLaunchQualifier: unique symbol;

/** Host-issued cold launch intent for this exact Exec service; grants no Project permission. */
export type AgentNativeLaunchQualifier = Readonly<{ [agentNativeLaunchQualifier]: true }>;

export type {
    PluginExecSpawnRequest,
    PluginProcessHandle,
    PluginProcessObservedTermination,
    PluginProcessOutput,
    PluginProcessResult,
    PluginProcessTerminationRequest,
} from './services/io.js';

export interface AgentCliReadinessService {
    checkReadiness(request: PluginAgentCliReadinessRequest): Promise<PluginAgentCliReadinessResult>;
}

export type SystemToolResolveRequest = Readonly<{
    toolId: string;
    purpose: string;
    cwd?: string;
    preferredPath?: string | null;
    signal?: AbortSignal;
}>;

export type SystemToolDiagnostic = Readonly<{
    code: string;
    detail?: Readonly<Record<string, string | number>>;
}>;

export type ResolvedSystemTool = Readonly<{
    /** The observed root process exit is the provider exit only for a direct launch. */
    providerExitOwnership?: 'direct';
    executable: ManagedExecutableRef;
    executablePath: string;
    diagnostics?: readonly SystemToolDiagnostic[];
}>;

export interface SystemToolsService {
    resolve(request: SystemToolResolveRequest): Promise<ResolvedSystemTool>;
}

export interface ExecService {
    readonly agentCli: AgentCliReadinessService;
    readonly systemTools: SystemToolsService;
    /** Prepare one transient Unix transport leaf for this held native identity.
     * The returned qualifier prepares its native-owned alias parent on server
     * launch; clients retain their original qualifier and use nativeProxy.
     */
    prepareNativeSocketDirectory(options?: Readonly<{
        nativeLaunch?: AgentNativeLaunchQualifier;
    }>): Promise<Readonly<{
        path: string;
        nativeProxy: boolean;
        nativeLaunch?: AgentNativeLaunchQualifier;
        dispose(): Promise<void>;
    }>>;
    /** Run admission under the launch's cancellation signal after preparation
     * and immediately before each scoped process is spawned. Existing protocol
     * connections keep their lifecycle.
     */
    withSpawnAdmission<TResult>(
        admit: (signal: AbortSignal) => Promise<void>,
        effect: (exec: ExecService) => Promise<TResult>,
    ): Promise<TResult>;
    run(
        request: PluginExecSpawnRequest & { timeoutMs?: number },
        options?: {
            signal?: AbortSignal;
            nativeLaunch?: AgentNativeLaunchQualifier;
            /** Leave daemonized descendants to the native tool after an unrequested
             * root exit with code zero. Cancellation, timeout, early disposal and
             * failed exit still terminate the tree. Default: terminate.
             */
            descendantDisposition?: 'terminate' | 'preserve-on-success';
            /** Select the process carrying an admitted invocation's live output.
             * Without a host-private observer this remains ordinary captured output.
             */
            outputDelivery?: 'captured' | 'invocation';
        },
    ): Promise<PluginProcessResult>;
    spawn(
        request: PluginExecSpawnRequest,
        options?: {
            signal?: AbortSignal;
            nativeLaunch?: AgentNativeLaunchQualifier;
            /** Same successful native descendant handoff as run; no managed-service custody transfer. */
            descendantDisposition?: 'terminate' | 'preserve-on-success';
        },
    ): Promise<PluginProcessHandle>;
    readonly clients: ProtocolClientsService;
}

export type { GhCommandDeps, GhCommandParams, GhCommandResult, GhNativeTokenResult } from '@happier-dev/cli-common/agents';
