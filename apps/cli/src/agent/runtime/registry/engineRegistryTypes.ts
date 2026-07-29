import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunBackendIsolation } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type {
    AnyTerminalRuntimeOps,
    ProviderAttachOps,
} from '@/agent/catalog/types';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { CheckpointSurfaceV1, ForkSurfaceV1, HandoffSurfaceV1 } from '@happier-dev/agents';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV2Input } from '@happier-dev/protocol';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';
import type { EngineAdapter, RuntimeCore } from '@happier-dev/agents';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

export type BackendExecutionSurfaces = Readonly<{
    terminalRuntime: AnyTerminalRuntimeOps | null;
    externalSession: ExternalSessionExecutionSurface | null;
    attach: ProviderAttachOps | null;
    handoff: HandoffSurfaceV1 | null;
    fork: ForkSurfaceV1 | null;
    checkpoint: CheckpointSurfaceV1 | null;
}>;

export type CreateCliExecutionRunBackendParams = Readonly<{
    cwd: string;
    runId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    modelId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    permissionMode: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: ExecutionRunBackendStartContext | null;
    isolation?: ExecutionRunBackendIsolation;
    parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
}>;

export type CliSessionRuntime = HostSessionRuntimePlan;
export type CliExecutionRunRuntime = ExecutionRunHostRuntime;

export type CliRuntimeCore = RuntimeCore<
    unknown,
    CliSessionRuntime,
    CreateCliExecutionRunBackendParams,
    CliExecutionRunRuntime
>;

export type CliEngineAdapter = EngineAdapter<
    unknown,
    CliSessionRuntime,
    CreateCliExecutionRunBackendParams,
    CliExecutionRunRuntime
>;

export type EngineResolutionDiagnosticCode =
    | 'engine_backend_missing'
    | 'engine_plugin_backend_surface_missing'
    | 'engine_plugin_backend_surface_static_mismatch'
    | 'engine_plugin_daemon_module_load_failed'
    | 'engine_plugin_backend_surface_handler_invalid'
    | 'engine_plugin_registry_diagnostic';

export type EngineResolutionDiagnostic = Readonly<{
    code: EngineResolutionDiagnosticCode;
    message: string;
    backendId: string;
    agentId?: string;
    pluginId?: string;
    detailCode?: string;
}>;

export type EngineResolutionSelectedSource = 'system' | 'managed' | 'plugin' | 'configured';

export type ConfiguredEngineResolutionSource = Readonly<{ kind: 'configured' }>;
export type EngineResolutionProvenance = ResolvedContributionProvenance | 'configured';
export type EngineResolutionBackend = ResolvedAgentRuntimeContribution | Readonly<
    Omit<ResolvedAgentRuntimeContribution, 'provenance' | 'source'> & {
        provenance: 'configured';
        source: ConfiguredEngineResolutionSource;
    }
>;
export type EngineResolutionAgent = ResolvedAgentContribution | Readonly<
    Omit<ResolvedAgentContribution, 'provenance' | 'source'> & {
        provenance: 'configured';
        source: ConfiguredEngineResolutionSource;
    }
>;

export type BackendRuntimeOwnerKind = 'plugin_engine' | 'host_configured';

export type BackendRuntimeOwnerCandidate = Readonly<{
    kind: BackendRuntimeOwnerKind;
    ownerId: string;
    provenance: EngineResolutionProvenance;
    pluginId?: string;
}>;

export type BackendRuntimeOwnerResolution = Readonly<{
    backendId: string;
    selected: BackendRuntimeOwnerCandidate | null;
    candidates: readonly BackendRuntimeOwnerCandidate[];
}>;

export type EngineAdapterResolution = Readonly<{
    backendId: string;
    agentId: string;
    provenance: EngineResolutionProvenance;
    selectedSource?: EngineResolutionSelectedSource;
    runtimeOwner: BackendRuntimeOwnerResolution;
    backend: EngineResolutionBackend;
    agent: EngineResolutionAgent;
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
        externalSession: null,
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
    };
}
