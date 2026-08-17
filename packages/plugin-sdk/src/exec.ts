/** @moduleRealm daemon */
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
    run(
        request: PluginExecSpawnRequest & { timeoutMs?: number },
        options?: { signal?: AbortSignal },
    ): Promise<PluginProcessResult>;
    spawn(
        request: PluginExecSpawnRequest,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProcessHandle>;
    readonly clients: ProtocolClientsService;
}
