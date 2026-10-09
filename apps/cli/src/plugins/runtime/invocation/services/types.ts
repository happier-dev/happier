import type {
    HttpMethod } from '@happier-dev/plugin-sdk/http';
import type {
    ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type {
    PluginPath,
    PluginInvocationCaller,
    PluginServiceId,
    PluginServices,
} from '@happier-dev/plugin-sdk';
import type {
    PluginInvocationSurface } from '@happier-dev/plugin-sdk/interactions';
import type {
    ActionExecutorContext,
    PluginConnectedAccountMaterializationKind,
    PluginContributionIdentityV1,
    PluginMachineMaterializationRefV1,
    SessionPermissionMode,
    SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import type { PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';
import type { MachineProvisionerBootstrapCredentialRoleV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { PluginServiceUnavailableDiagnostic } from './unavailable';
import type {
    HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { PluginSessionAccessScope } from '@/session/services/pluginSessionsInventory';
export type AgentInvocationTurnAdmissionWitness = Readonly<{
    inputId: string;
    turnId: string;
    userMessageSeq: number | null;
    userMessageSeqs: readonly number[];
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    /** Live host Session mode, sampled with the active-turn witness. */
    callerPermissionMode?: SessionPermissionMode | null;
    /** Prepared host Session/turn facts; absent when this path has no Session caller. */
    agentStartCaller?: import('@happier-dev/protocol').AgentStartSessionCallerV1;
}>;

/**
 * Secret-free authority retained inside the host while an external PAT
 * invocation crosses an installed contributed Action. Plugin code never sees
 * this value; only the incumbent Actions service projects it onto nested host
 * Action calls.
 */
export type PluginExternalActionContext = Readonly<{
    authority: 'account_automation';
    serverId: string;
    serverIdentityId: string;
    actionRequestId: string;
    externalActionCredential: NonNullable<ActionExecutorContext['externalActionCredential']>;
    externalActionExecutionAuthorization: NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']>;
    externalActionTarget: NonNullable<ActionExecutorContext['externalActionTarget']>;
    signExternalActionApprovalInput?: NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>;
}>;

export type PluginInvocationServicesSeed = Readonly<{
    /** Exact host-admitted managed row; never plugin input or SDK context. */
    managedBootstrapCredential?: ManagedBootstrapCredentialInvocationBinding;
    /** Canonical invocation owner retains private material cleanup. */
    retainCleanup?(cleanup: Readonly<{ dispose(): Promise<void> }>): void;
    /** Host-only absence of an admitted Session-list corpus. */
    sessionListAccess?: import('@happier-dev/protocol').ActionExecutorContext['sessionListAccess'];
    plugin: Readonly<{ id: string; version: string }>;
    contribution: Readonly<{ id: string; qualifiedId: string }>;
    /** Exact process-local occurrence; never plugin-authored invocation input. */
    occurrenceId: string;
    /** Durable source custody; never plugin-authored invocation input. */
    sourceCustody?: PluginSourceCustody;
    correlationId: string;
    surface: PluginInvocationSurface;
    /** Host-stamped provenance for a nested target invocation. */
    caller?: PluginInvocationCaller;
    /** Private initiating Action provenance; not projected into the SDK context. */
    initiatingActionCaller?: import('@happier-dev/protocol/actions').ActionCaller;
    /** Descriptive fact from authenticated host-control transport, never SDK input. */
    startedBy?: import('@happier-dev/protocol').WorkflowRunStartedByV1;
    /** Host-private external PAT authority; never projected into plugin input/context. */
    externalActionContext?: PluginExternalActionContext;
    /**
     * Host-private dispatch-time lookup for this invocation's own current
     * materialization. It deliberately prevents a service from capturing
     * caller authority at invocation construction.
     */
    resolveCurrentPluginMaterializationRef?(): PluginMachineMaterializationRefV1 | null;
    /** Untrusted, transient settlement from one mounted UI caller. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Re-read that mounted caller at the final provider-effect boundary. */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    session?: Readonly<{ id: string }>;
    currentSession?: HostCurrentSessionUiServices;
    signal: AbortSignal;
    /** Host-stamped only for target-hook invocations to fence nested action interception. */
    bypassActionInterception?: true;
    /** Host-private lifetime for invocation-scoped diagnostic credential leases. */
    redactionLifetimeSignal?: AbortSignal;
    /** Host-private current-turn authority for runner-owned privileged effects. */
    readActiveTurnAdmissionWitness?(): AgentInvocationTurnAdmissionWitness | null;
    isOccurrenceCurrent(): boolean;
}>;

export type ManagedBootstrapCredentialInvocationBinding = Readonly<{
    role: MachineProvisionerBootstrapCredentialRoleV1;
    /** Returns owned bytes from this admitted row's retained SavedSecret only. */
    readBootstrapCredential(): Promise<Uint8Array>;
    isCurrent(): boolean | Promise<boolean>;
}>;

export type PluginProviderOperationsSource = Readonly<{
    bind(binding: Readonly<{
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): PluginServices['providers'] | null;
}>;

export type PluginMcpAuthorization = readonly Readonly<{
    serverRefs: readonly Readonly<{ pluginId: string; localId: string }>[];
    discoverySourceRefs: readonly Readonly<{ pluginId: string; localId: string }>[];
    operations: readonly ('listTools' | 'callTools' | 'discover')[];
}>[];

export type PluginConnectedAccountBindingScope = Readonly<{
    purpose: string;
    serviceRefs: readonly PluginContributionIdentityV1[];
    operations: readonly ('select' | 'use')[];
    materializationKinds?: readonly PluginConnectedAccountMaterializationKind[];
}>;

export type PluginNetworkBindingScope = Readonly<{
    authority: 'disclosure' | 'selectedResource';
    accessId: string;
    required: boolean;
    origins: readonly string[];
    /**
     * Declared `httpsHostSuffix` families, carried beside the exact origins so
     * every admission point asks the protocol-owned policy the one question.
     * A family never becomes a concrete origin here: the private-network and
     * address decisions still happen per request, against the real target.
     */
    hostSuffixes?: readonly string[];
    methods?: readonly HttpMethod[];
    privateNetwork: boolean;
    /**
     * Present only when the host resolved a semantic connectedAccountOrigin
     * target into the concrete origins above.
     */
    connectedAccountService?: PluginContributionIdentityV1;
}>;

/** Exact transport authority for HostAccess network.client; never grants HTTP. */
export type PluginNetworkClientBindingScope = Readonly<{
    authority: 'disclosure' | 'selectedResource';
    accessId: string;
    required: boolean;
    origins: readonly string[];
    /** Declared `httpsHostSuffix` families; see PluginNetworkBindingScope. */
    hostSuffixes?: readonly string[];
    transports: readonly ('websocket' | 'webrtc')[];
    privateNetwork: boolean;
    /** Present when a host-owned Connected Account resolved the target origin. */
    connectedAccountService?: PluginContributionIdentityV1;
}>;

/** Host-private Account Data admission, independent of ambient Storage scopes. */
export type PluginAccountStorageAvailability = 'available' | 'unavailable' | 'denied';

/**
 * Host-private capability token. Invocation code may verify its occurrenceId,
 * but only the host services owner interprets the binding id and service facts.
 */
export type PluginInvocationServiceBinding = Readonly<{
    kind: 'plugin_invocation_service_binding_v1';
    id: string;
    occurrenceId: string;
    availability: Readonly<Record<PluginServiceId, 'available' | 'unavailable' | 'denied'>>;
    /** Host-private, descriptor-derived reasons for deterministic unavailable services. */
    unavailableDiagnostics?: Readonly<Partial<Record<PluginServiceId, PluginServiceUnavailableDiagnostic>>>;
    /** Host-private HostAccess admission for `storage.account`, never a StorageService-wide state. */
    accountStorageAvailability: PluginAccountStorageAvailability;
    /**
     * Host-owned Account Data currentness for invocation paths whose ordinary
     * seed currentness is synchronous but whose committed authority is async.
     * Only the Account Data owner consumes this terminal mutation fence.
     */
    accountStorageCurrentness?: () => boolean | Promise<boolean>;
    filesystemScopes?: readonly Readonly<{ root: PluginPath['root']; projectId?: string; pathPrefix?: string; access: readonly ('read' | 'write' | 'delete')[] }>[];
    filesystemRequestIds?: readonly string[];
    processExecutables?: readonly ManagedExecutableRef[];
    processEnvKeys?: readonly string[];
    processRequestIds?: readonly string[];
    environmentRequestIds?: readonly string[];
    networkOrigins?: readonly string[];
    /** Declared HTTPS host-suffix families for the same disclosure surface. */
    networkHostSuffixes?: readonly string[];
    networkRequestIds?: readonly string[];
    networkScopes?: readonly PluginNetworkBindingScope[];
    networkClientOrigins?: readonly string[];
    networkClientHostSuffixes?: readonly string[];
    networkClientRequestIds?: readonly string[];
    networkClientScopes?: readonly PluginNetworkClientBindingScope[];
    /**
     * Host-owned terminal fence for bindings whose network authority depends on
     * a mutable Connected Account configuration revision.
     */
    networkCurrentness?: () => boolean | Promise<boolean>;
    /**
     * Host-owned push revocation for the exact current Connected Account
     * configuration snapshot. Only long-lived network transports consume it.
     */
    networkRevocationSignal?: AbortSignal;
    mcpScopes?: PluginMcpAuthorization;
    /**
     * Final HostAccess projection for Session inventory access. This is a
     * host-private binding consumed only by the canonical Session owner.
     */
    sessionScopes?: readonly PluginSessionAccessScope[];
    connectedAccountScopes?: readonly PluginConnectedAccountBindingScope[];
    /**
     * Host-private operation lease identity for one target-Action invocation.
     * Plugin code never receives or chooses this identifier.
     */
    exactPurposeBindingSubjectId?: string;
    /** Host-private managed bootstrap output observer; not an SDK capability. */
    execOutputObserver?: (output: import('@happier-dev/plugin-sdk/exec').PluginProcessOutput) => void;
    /** Containing task's budget; only an explicitly selected invocation process consumes it. */
    execInvocationTimeoutMs?: number | null;
}>;

export type PluginFileSystemRoots = Readonly<{
    pluginData: string;
    workspace: string;
    projects: ReadonlyMap<string, string>;
}>;

export type CreatePluginInvocationServices = (
    seed: PluginInvocationServicesSeed,
    binding: PluginInvocationServiceBinding,
) => PluginServices;

export type CreateAgentInvocationServices = (
    params: Readonly<{
        pluginId: string;
        pluginVersion: string;
        agentId: string;
        occurrenceId: string;
        correlationId: string;
        cwd: string;
        environment?: Readonly<Record<string, string>>;
        /** Host-private exact managed launch; plugin code never receives this binding. */
        agentCliLaunch?: import('@/packagedRuntime/managedTools/agentCliLaunchSpec').BoundAgentCliLaunchSpec;
        providerBindingActive?: boolean;
        signal: AbortSignal;
        session?: Readonly<{
            id: string;
            current: HostCurrentSessionUiServices;
        }>;
        /** Host-private interaction/presentation binding for a detached Run; never creates context.session. */
        currentSession?: HostCurrentSessionUiServices;
        readActiveTurnAdmissionWitness?():
            AgentInvocationTurnAdmissionWitness | null;
        isOccurrenceCurrent(): boolean;
    }>,
    ) => Promise<PluginServices>;

export type CreatePluginInvocationServiceBinding = (
    occurrenceId: string,
    id: string,
    hostAccessRequests?: readonly Readonly<{ request: import('@happier-dev/protocol').PluginHostAccessRequestV2; required: boolean }>[],
    contributionQualifiedId?: string,
) => PluginInvocationServiceBinding;
