import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunBackendIsolation } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type {
    AnyTerminalRuntimeOps,
} from '@/agent/catalog/types';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { HostProviderCliAttachSurface } from '@/session/attach/providerCliAttach';
import type { AttachSurfaceV1, CheckpointSurfaceV1, ForkSurfaceV1, HandoffSurfaceV1 } from '@happier-dev/agents';
import type { AccountSettings, AcpConfigOptionOverridesV1, BackendTargetRefV2Input, HostSemanticEventV1, PortableRuntimeDescriptorV1, ProviderBoundModelRef, ProviderErrorV1, SessionEnvOverlayV1, SessionInputCausalPermissionAuthorityV1, SessionRunPromptReadActionIdV1, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import type {
    AgentSessionConfigurationSnapshot,
    AgentSessionOpenRequest,
    AgentSessionProviderBinding,
    AgentSessionRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { ExecutionRunOccurrenceWitnessV1 } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';
import type { EngineAdapter, RuntimeCore } from '@happier-dev/agents';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ExecutionRunRetainedInteractionScope } from '@/agent/runtime/bridges/executionRun/retainedInteractionEligibility';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { SessionFollowPreparedContext } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import type { ComposerAttachmentDispatchResolver } from '@/agent/runtime/runPermissionModePromptLoop';
import type { StructuredInputComposerReferenceResolver } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import type { RuntimeAuthRefreshViaDaemon } from '@/plugins/runtime/context/runtimeAuthRefresh';

/**
 * The exact Session-owned Execution Run a tool profile is being composed for.
 *
 * The parent Session stays the resource scope and keeps its configured server
 * profile; permission mode, working location, runtime lifetime and turn
 * authority come from this Run. `readCurrentRunOccurrence` projects the bridge's
 * canonical controller entry and is deliberately read per tool call, so
 * a resumed or replaced controller occurrence stops supplying authority without
 * rebuilding the profile.
 */
export type NativeAgentSessionRunToolBindingRequest = Readonly<{
    runId: string;
    /** Absolute depth frozen by the Run manager's host admission. */
    workDepth: number;
    cwd: string;
    /** This Run's runtime lifetime, not the parent Session's. */
    signal: AbortSignal;
    isCurrent: () => boolean;
    getPermissionMode: () => string;
    readActiveTurnAdmissionWitness: () => AgentInvocationTurnAdmissionWitness | null;
    readCurrentRunOccurrence: (runId: string) => ExecutionRunOccurrenceWitnessV1 | null;
}>;

export type NativeAgentSessionRunToolBinding = Readonly<{
    mcpServers?: AgentSessionOpenRequest['mcpServers'];
    /** Exact Session read Actions advertised by this occurrence's tool profile. */
    supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[];
    /** Releases only this Run's binding; the parent Session bridge is untouched. */
    dispose: () => void;
}>;

/** The parent Session's durable transcript writer, re-scoped to one Run sidechain. */
export type NativeAgentSessionRunTranscriptTarget = Pick<ApiSessionClient,
    | 'updateMetadata'
    | 'enqueueAgentMessageCommitted'
> & Readonly<{
    sessionId: string;
    requiresDurableTurnCompletionMarker: true;
}>;

/**
 * Host-only Run scope supplied by the Execution Run bridge, which owns the
 * controller occurrence registry and the Run's sidechain identity.
 */
export type ExecutionRunHostRunScopeBinding = Readonly<{
    runId: string;
    workDepth: number;
    sidechainId: string;
    readCurrentRunOccurrence: (runId: string) => ExecutionRunOccurrenceWitnessV1 | null;
    /** Publishes the materialized profile onto this exact controller occurrence. */
    publishSupportedSessionReadActions: (
        actionIds: readonly SessionRunPromptReadActionIdV1[],
        runtimeLifetimeSignal: AbortSignal,
    ) => void;
    /**
     * The Run-sidechain-scoped transcript target. Custody is re-resolved on every
     * write, so a superseded or missing controller refuses there instead of
     * falling back to the parent Session's main transcript.
     */
    projectRunTranscriptSession: () => NativeAgentSessionRunTranscriptTarget;
}>;

export type NativeAgentSessionInteractionHostBinding = Readonly<{
    /** Parent Session custody used by the hidden retained Voice interaction. */
    session: Pick<ApiSessionClient,
        | 'sessionId'
        | 'getMetadataSnapshot'
        | 'updateMetadata'
        | 'updateAgentState'
        | 'enqueueAgentMessageCommitted'
    > & Partial<Pick<ApiSessionClient,
        | 'publishUsageObservation'
        | 'enqueueSessionUserMessage'
        | 'enqueueSessionUserMessageWithDisposition'
        | 'bindExecutionRunPendingInput'
        | 'subscribeExecutionRunPendingTarget'
        | 'listExecutionRunPendingDeliveryStatuses'
        | 'blockExecutionRunPendingDelivery'
    >>;
    machineId: string;
    permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
    /** Exact owning Session's current structured-input catalogs. */
    listSkills?: () => Promise<unknown>;
    listVendorPlugins?: () => Promise<unknown>;
    /** Exact owning Session's current-generation Composer contribution resolvers. */
    resolveComposerReference?: StructuredInputComposerReferenceResolver['resolve'];
    resolveComposerAttachmentForDispatch?: ComposerAttachmentDispatchResolver;
    /** Parent hidden Voice Session's Account-Follow context seam. */
    prepareAccountVoiceFollowContext?: (input: Readonly<{
        executionRunId: string;
        requiredPrompt: string;
        signal: AbortSignal;
    }>) => Promise<SessionFollowPreparedContext | null>;
    /**
     * Composes this parent Session's effective tool profile for one Session-owned
     * Run through the existing Session MCP materialization owner. Absent for hosts
     * that have no tool profile to inherit.
     */
    composeRunToolBinding?: (
        request: NativeAgentSessionRunToolBindingRequest,
    ) => Promise<NativeAgentSessionRunToolBinding>;
    /** Opens an explicit Team selection, or the parent Session's current selection when omitted. */
    prepareRunTeamCredentialProviderBinding?: (request: Readonly<{
        runId: string;
        /** The Run's own Agent, which need not be its parent Session's. */
        agentId: string;
        selection?: TeamCredentialProviderModelSelectionV1;
    }>) => Promise<Readonly<{
        providerBinding: AgentSessionProviderBinding;
        environmentOverlay: SessionEnvOverlayV1;
        additionalRedactionValues: readonly string[];
        cleanup(): void | Promise<void>;
    }> | null>;
}>;

export type BackendExecutionSurfaces = Readonly<{
    resolveTerminalPresentation?: (
        selection: Parameters<NonNullable<AgentSessionRuntimeFactory['resolveTerminalPresentation']>>[0],
    ) => ReturnType<NonNullable<AgentSessionRuntimeFactory['resolveTerminalPresentation']>>;
    terminalRuntime: AnyTerminalRuntimeOps | null;
    externalSession: ExternalSessionExecutionSurface | null;
    attach: (AttachSurfaceV1 & Partial<Pick<HostProviderCliAttachSurface, 'attachManaged' | 'prepareInvocation'>>) | null;
    handoff: HandoffSurfaceV1 | null;
    fork: ForkSurfaceV1 | null;
    checkpoint: CheckpointSurfaceV1 | null;
}>;

export type CreateCliExecutionRunBackendParams = Readonly<{
  cwd: string;
  machineId?: string;
    runId?: string;
    controllerOccurrenceId?: string;
    callId?: string;
    sidechainId?: string;
    /** Host-authored ownership scope; detached Runs cannot consume parent Session services. */
    scope: ExecutionRunRetainedInteractionScope;
    getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    configuration?: AgentSessionConfigurationSnapshot;
    runtimeDescriptorV1?: PortableRuntimeDescriptorV1;
    providerBinding?: AgentSessionProviderBinding;
    revalidateProviderBeforeOpen?: () => Promise<Readonly<
        { ok: true } | { ok: false; error: ProviderErrorV1 }
    >>;
    sanitizeProviderDiagnosticText?: (value: string) => string;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    /** Host-only active-turn authority; never a public backend request field. */
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    accountSettings?: AccountSettings | null;
    start?: ExecutionRunBackendStartContext | null;
    isolation?: ExecutionRunBackendIsolation;
    parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
    /** Host-only owning Happier Session id for the Run scope; absent for detached Runs. */
    happierSessionId?: string;
    /** Host-only Session service custody for retained multi-turn Voice. */
    sessionInteractionHost?: NativeAgentSessionInteractionHostBinding;
    /**
     * Host-only Session-owned Run scope from the Execution Run bridge. Present
     * only for a Run owned by a Happier Session; detached Runs have no parent
     * occurrence registry, sidechain, or inherited tool profile.
     */
    sessionOwnedRunScope?: ExecutionRunHostRunScopeBinding;
    /** Captures the Run materialization's activation; never uses parent Session auth. */
    connectedServiceRuntimeAuthRefresh?: RuntimeAuthRefreshViaDaemon;
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
    publishHostEvent?: (event: HostSemanticEventV1) => void;
}>;

export type ResolvedCliEngineRegistry = Readonly<{
    contributions: ResolvedContributionRegistry;
    /** Builds the admitted execution-run profile catalog from the current serving runtime snapshot. */
    resolveExecutionRunProfileCatalog(
        options?: import('@/agent/executionRuns/profiles/intentRegistry').ExecutionRunProfileCatalogOptions,
    ): Promise<import('@/agent/executionRuns/profiles/intentRegistry').ExecutionRunProfileContributionCatalog>;
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
