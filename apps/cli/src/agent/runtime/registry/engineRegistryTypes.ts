import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunBackendIsolation } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type {
    AnyTerminalRuntimeOps,
    ProviderAttachOps,
} from '@/backends/types';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { CheckpointSurfaceV1, ForkSurfaceV1, HandoffSurfaceV1 } from '@happier-dev/agents';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol';
import type {
    ResolvedBackendContribution,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedProviderContribution,
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
    | 'engine_runtime_owner_conflict'
    | 'engine_runtime_owner_takeover_missing'
    | 'engine_plugin_backend_surface_missing'
    | 'engine_plugin_backend_surface_static_mismatch'
    | 'engine_plugin_backend_surface_non_daemon_target'
    | 'engine_plugin_daemon_entry_missing'
    | 'engine_plugin_daemon_module_load_failed'
    | 'engine_plugin_backend_surface_handler_missing'
    | 'engine_plugin_backend_surface_handler_invalid'
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

export type BackendRuntimeOwnerKind = 'legacy_host' | 'plugin_engine';

export type BackendRuntimeOwnerCandidate = Readonly<{
    kind: BackendRuntimeOwnerKind;
    ownerId: string;
    provenance: ResolvedContributionProvenance;
    pluginId?: string;
}>;

export type BackendRuntimeOwnerTakeoverMarker = Readonly<{
    selectedOwner: 'plugin_engine';
    acceptedBy: string;
}>;

export type BackendRuntimeOwnerResolution = Readonly<{
    backendId: string;
    selected: BackendRuntimeOwnerCandidate | null;
    candidates: readonly BackendRuntimeOwnerCandidate[];
    takeover?: BackendRuntimeOwnerTakeoverMarker;
    conflictDiagnostic?: EngineResolutionDiagnostic;
}>;

export type EngineAdapterResolution = Readonly<{
    backendId: string;
    providerId: string;
    provenance: ResolvedContributionProvenance;
    selectedSource?: EngineResolutionSelectedSource;
    runtimeOwner: BackendRuntimeOwnerResolution;
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
        externalSession: null,
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
    };
}
