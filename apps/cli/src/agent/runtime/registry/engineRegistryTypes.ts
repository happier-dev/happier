import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunBackendIsolation } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type {
    AnyTerminalRuntimeOps,
    ExternalSessionProviderOps,
    ProviderAttachOps,
    SessionHandoffProviderOps,
} from '@/backends/types';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol';
import type {
    ResolvedBackendContribution,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import type { EngineAdapter, RuntimeCore } from '@happier-dev/agents';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

export type BackendExecutionSurfaces = Readonly<{
    terminalRuntime: AnyTerminalRuntimeOps | null;
    externalSessions: ExternalSessionProviderOps | null;
    attach: ProviderAttachOps | null;
    sessionHandoff: SessionHandoffProviderOps | null;
}>;

export type CreateCliExecutionRunBackendParams = Readonly<{
    cwd: string;
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    modelId?: string;
    permissionMode: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: ExecutionRunBackendStartContext | null;
    isolation?: ExecutionRunBackendIsolation;
}>;

export type CliSessionRuntime = HostSessionRuntimePlan;
export type CliExecutionRunRuntime = ExecutionRunHostRuntime;

export type CliRuntimeCore = RuntimeCore<
    unknown,
    CliSessionRuntime,
    CreateCliExecutionRunBackendParams,
    CliExecutionRunRuntime
>;

export type CliRuntimeCoreParams = Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
    executionSurfaces: BackendExecutionSurfaces;
}>;

export type CliRuntimeCoreFactory = (params: CliRuntimeCoreParams) =>
    | CliEngineAdapter
    | Promise<CliEngineAdapter>;

export type CliRuntimeCoreGetter = () =>
    | CliRuntimeCoreFactory
    | Promise<CliRuntimeCoreFactory>;

export type CliEngineAdapter = EngineAdapter<
    unknown,
    CliSessionRuntime,
    CreateCliExecutionRunBackendParams,
    CliExecutionRunRuntime
>;

export type EngineResolutionDiagnosticCode =
    | 'engine_backend_missing'
    | 'engine_provider_missing'
    | 'engine_plugin_runtime_adapter_missing'
    | 'engine_plugin_runtime_adapter_non_daemon_target'
    | 'engine_plugin_daemon_entry_missing'
    | 'engine_plugin_daemon_module_load_failed'
    | 'engine_plugin_runtime_adapter_handler_missing'
    | 'engine_plugin_runtime_adapter_handler_invalid'
    | 'engine_plugin_registry_diagnostic';

export type EngineResolutionDiagnostic = Readonly<{
    code: EngineResolutionDiagnosticCode;
    message: string;
    backendId: string;
    providerId?: string;
    pluginId?: string;
    detailCode?: string;
}>;

export type EngineResolutionSelectedSource = 'system' | 'managed' | 'plugin';

export type EngineAdapterResolution = Readonly<{
    backendId: string;
    providerId: string;
    provenance: ResolvedContributionProvenance;
    selectedSource?: EngineResolutionSelectedSource;
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
    engineAdapter: CliEngineAdapter;
    executionSurfaces: BackendExecutionSurfaces;
    diagnostics: readonly EngineResolutionDiagnostic[];
}>;

export type ResolvedCliEngineRegistry = Readonly<{
    contributions: ResolvedContributionRegistry;
    resolveForBackendId(backendId: string): Promise<EngineAdapterResolution | null>;
    resolveExecutionSurfaces(backendId?: string | null): Promise<BackendExecutionSurfaces>;
}>;

export function createEmptyBackendExecutionSurfaces(): BackendExecutionSurfaces {
    return {
        terminalRuntime: null,
        externalSessions: null,
        attach: null,
        sessionHandoff: null,
    };
}
