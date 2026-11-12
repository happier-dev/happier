import type {
    PluginPath,
    PluginInvocationCaller,
    PluginServices,
    JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    PluginInvocationSurface } from '@happier-dev/plugin-sdk/interactions';
import type {
    ActionExecutorContext,
    PluginMachineMaterializationRefV1,
    SessionPermissionMode,
    SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import type { PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';
import type {
    HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { PluginSessionAccessScope } from '@/session/services/pluginSessionsInventory';
import type { ProcessOwnerRef } from '@/processes/ownerTag';
import type { ConnectedAccountHostAccessScope } from '@happier-dev/cli-common/connectedAccounts';

/** Host-private enrollment in the production invocation's existing redactor. */
export type BeginPluginInvocationDiagnosticScope = (
    scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
    signal: AbortSignal,
    input: JsonValue,
    secretInputPaths: readonly string[],
) => void;

export type AgentInvocationTurnAdmissionWitness = Readonly<{
    nativeRealtimeAdmission?: import('@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness').NativeRealtimeInputAdmissionV1;
    /** Exact host admission lifetime, distinct from the containing runtime. */
    signal?: AbortSignal;
    discussionAddressing?: import('@happier-dev/protocol/discussions/participants').DiscussionAddressingV1;
    actionRequestAttributionV1?: import('@happier-dev/protocol/actions/actionRequestAttributionV1').ActionRequestAttributionV1;
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

/** Exact host Run controller's Workflow identity and existing terminal failure sink. */
export type WorkflowAgentActionContext = Readonly<{
    readRunId(): string | undefined;
    fail(error: Error): void;
}>;

/**
 * Secret-free authority retained inside the host while an external PAT
 * invocation crosses an installed contributed Action. Plugin code never sees
 * this value; only the incumbent Actions service projects it onto nested host
 * Action calls.
 */
export type PluginExternalActionContext = Readonly<{
    authority: 'account_automation' | 'present_user';
    serverId: string;
    serverIdentityId: string;
    actionRequestId: string;
    externalActionCredential?: NonNullable<ActionExecutorContext['externalActionCredential']>;
    externalActionExecutionAuthorization: NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']>;
    externalActionTarget: NonNullable<ActionExecutorContext['externalActionTarget']>;
    signExternalActionApprovalInput?: NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>;
}>;

export type PluginInvocationServicesSeed = Readonly<{
    /** Account custody retained by the Session admission; never an SDK operand. */
    requesterAccount?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
    /** Exact host-admitted managed data role; no role, link, or ref reaches plugin input. */
    readDataRole?: NonNullable<PluginServices['secrets']['readDataRole']>;
    /** Exact resource admission, captured by the host before the handler starts. */
    managedWorkloads?: PluginServices['managedServices']['observeWorkload'];
    /** Host-private current Run attachment; never projected into plugin context. */
    readApprovalProfileId?: () => string | null;
    /** Bound by the actual Domain admission, never by plugin-authored operands. */
    machineConnectorSecrets?: PluginServices['machineConnectorSecrets'];
    /** Exact role source acquisition captured by the deployment admission owner. */
    deploymentSource?: Pick<Parameters<typeof import('@/deployments/targets/ownServer/exactCommitRelease').createDeploymentSourceMaterializationPort>[0], 'admit'> & Readonly<{
        identity: Readonly<Pick<import('@happier-dev/plugin-sdk').DeploymentSourceMaterializationRequestV1, 'environmentId' | 'deploymentId'>>;
        createExecEnv?(source: import('@happier-dev/plugin-sdk').DeploymentSourceMaterializationV1, signal: AbortSignal, retainCleanup: NonNullable<PluginInvocationServicesSeed['retainCleanup']>): import('@happier-dev/plugin-sdk/exec').DeploymentExecEnvPortV1;
    }>;
    /** Exact shared-save id/purpose/audience reviewed by the root Action. */
    sharedSaveAdmission?: import('@/plugins/runtime/context/secrets').PluginSharedSaveAdmission;
    /** Host-private binding to a detached Workflow Agent's live controller. */
    workflowActionContext?: WorkflowAgentActionContext;
    /** Bound only by the canonical daemon background-service lifecycle. */
    demandBackgroundService?: PluginServices['backgroundServices']['demand'];
    /** Host invocation identity; never projected into the public plugin context. */
    processOwner?: ProcessOwnerRef;
    /** Exact host-admitted managed row; never plugin input or SDK context. */
    managedBootstrapCredential?: ManagedBootstrapCredentialInvocationBinding;
    /** Host-admitted complete native apply; never copied from Action operands. */
    managedNativeCredentials?: ManagedNativeCredentialInvocationBinding;
    /** Canonical invocation owner retains private material cleanup. */
    retainCleanup?(cleanup: Readonly<{ dispose(): Promise<void> }>): void;
    /** Host-only observed read authority withdrawal; never a plugin-authored event. */
    retireReadObservation?(): void;
    /** Host-only absence of an admitted Session-list corpus. */
    sessionListAccess?: import('@happier-dev/protocol').ActionExecutorContext['sessionListAccess'];
    plugin: Readonly<{ id: string; version: string }>;
    contribution: Readonly<{ id: string; qualifiedId: string }>;
    /** Exact process-local occurrence; never plugin-authored invocation input. */
    occurrenceId: string;
    /** Durable source custody; never plugin-authored invocation input. */
    sourceCustody?: PluginSourceCustody;
    correlationId: string;
    /** Originating host request identity; never an authorization operand. */
    requestId?: string;
    surface: PluginInvocationSurface;
    /** Host-stamped provenance for a nested target invocation. */
    caller?: PluginInvocationCaller;
    /** Private initiating Action provenance; not projected into the SDK context. */
    initiatingActionCaller?: import('@happier-dev/protocol/actions').ActionCaller;
    /** Descriptive fact from authenticated host-control transport, never SDK input. */
    startedBy?: import('@happier-dev/protocol').WorkflowRunStartedByV1;
    /** Host-private external PAT authority; never projected into plugin input/context. */
    externalActionContext?: PluginExternalActionContext;
    /** Original host-admitted Action source; never part of the public plugin context. */
    approvalContext?: ActionExecutorContext;
    /** Normalized operands captured by the admitted Action owner, never discovery metadata. */
    actionInput?: unknown;
    /** Invocation-local source selection shared by enumeration and nested dispatch. */
    resolveAccountSourceMachine?(signal?: AbortSignal): ReturnType<typeof import('../actions/accountMachineActionTransport').resolveAccountMachineSourceActionMachine>;
    /** Existing issuer's admitted whole-operation parent; never public plugin input. */
    reviewedParent?: import('@happier-dev/protocol/actions/actionExecutor').HostReviewedParentV1;
    /** The handler admission owner's own-UI decision; host-private, never an SDK operand. */
    presentUserIntent?: 'confirmed';
    /** Existing finite operation owns nested effect progress and early transport acceptance. */
    finiteOperation?: Readonly<{
        operationAcceptance: NonNullable<ActionExecutorContext['operationAcceptance']>;
        operationOwnerUpdate: NonNullable<ActionExecutorContext['operationOwnerUpdate']>;
    }>;
    /** Produced only after the real Action declaration and normalized input were admitted. */
    fileDownload?: Readonly<{ destinationId: string; retirementSignal: AbortSignal;
        operationAcceptance?: ActionExecutorContext['operationAcceptance'];
        operationOwnerUpdate?: ActionExecutorContext['operationOwnerUpdate'];
        publish: NonNullable<ActionExecutorContext['prepareFileDownload']> }>;
    /** Accepted finite invocation cause; a live turn reader, when present, supersedes it. */
    actionRequestAttributionV1?: import('@happier-dev/protocol/actions/actionRequestAttributionV1').ActionRequestAttributionV1;
    /**
     * Host-private dispatch-time lookup for this invocation's own current
     * materialization. It deliberately prevents a service from capturing
     * caller authority at invocation construction.
     */
    resolveCurrentPluginMaterializationRef?(): PluginMachineMaterializationRefV1 | null;
    /** Current exact Machine/source authority, resolved by the runtime registry. */
    resolveCurrentPluginExecutionOrigin?(signal?: AbortSignal): Promise<import('@happier-dev/protocol').PluginMachineExecutionOriginV1 | null>;
    /** Untrusted, transient settlement from one mounted UI caller. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Re-read that mounted caller at the final provider-effect boundary. */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    /** Host-only exact current targeted declarations, never an SDK capability. */
    readUnavailableTargetedPlugins?(): readonly import('@happier-dev/protocol/plugins/manifest/ingest').PluginUnavailableSourceDiagnostic[];
    readCurrentTargetedDeclarations?(signal?: AbortSignal): Promise<readonly import('@happier-dev/cli-common/plugins/registration').TargetedContributionManifestDeclaration[]>;
    session?: Readonly<{ id: string }>;
    currentSession?: HostCurrentSessionUiServices;
    signal: AbortSignal;
    /** Existing plugin-generation retirement; closes open access, not admitted finite work. */
    retirementSignal?: AbortSignal;
    /** Host-stamped only for target-hook invocations to fence nested action interception. */
    bypassActionInterception?: true;
    /** Host-private lifetime for invocation-scoped diagnostic credential leases. */
    redactionLifetimeSignal?: AbortSignal;
    /** Host-private current-turn authority for runner-owned privileged effects. */
    readActiveTurnAdmissionWitness?(): AgentInvocationTurnAdmissionWitness | null;
    isOccurrenceCurrent(): boolean;
}>;

export type ManagedBootstrapCredentialInvocationBinding = import('@happier-dev/protocol/actions/executor/types').ManagedBootstrapCredentialInvocationBinding;

export type PluginProviderOperationsSource = Readonly<{
    bind(binding: Readonly<{
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): PluginServices['providers'] | null;
}>;

export type PluginConnectedAccountBindingScope = ConnectedAccountHostAccessScope;

export type ManagedNativeCredentialInvocationBinding = Readonly<{
    role: 'nativeCredentialApply';
    bindings: ReadonlyMap<string, Readonly<{
        readRenderedHeaders(): Promise<
            | Readonly<{ ok: true; headers: Readonly<Record<string, string>> }>
            | Readonly<{ ok: false; error: import('@happier-dev/protocol/providers/errors').ProviderErrorV1 }>
        >;
    }>>;
}>;

/**
 * Host-private invocation identity and captured resource-routing facts.
 * Concrete service construction owns availability.
 */
export type PluginInvocationServiceBinding = Readonly<{
    kind: 'plugin_invocation_service_binding_v1';
    id: string;
    occurrenceId: string;
    /**
     * Host-owned Account Data currentness for invocation paths whose ordinary
     * seed currentness is synchronous but whose committed authority is async.
     * Only the Account Data owner consumes this terminal mutation fence.
     */
    accountStorageCurrentness?: () => boolean | Promise<boolean>;
    /**
     * Host-owned push revocation for the exact current Connected Account
     * configuration snapshot, shared by requests and long-lived transports.
     */
    networkRevocationSignal?: AbortSignal;
    /**
     * Host-owned Session row constraints, including exact caller custody when
     * present. Manifest declarations do not set these constraints.
     */
    sessionScopes?: readonly PluginSessionAccessScope[];
    connectedAccountScopes?: readonly PluginConnectedAccountBindingScope[];
    /**
     * Host-private operation lease identity for one target-Action invocation.
     * Plugin code never receives or chooses this identifier.
     */
    exactPurposeBindingSubjectId?: string;
    /** Same requester purpose owner that admitted this operation and produced its subject. */
    connectedAccountsOwner?: import('./connectedAccounts').StablePluginConnectedAccountsOwner;
    /** Host-private managed bootstrap output observer; not an SDK capability. */
    execOutputObserver?: (output: import('@happier-dev/plugin-sdk/exec').PluginProcessOutput) => void;
    /** Host-private input of an admitted managed `stream` channel; not an SDK capability. */
    execChannelInput?: (process: Pick<import('@happier-dev/plugin-sdk/exec').PluginProcessHandle, 'write' | 'closeStdin'>) => () => void;
    /** Containing task's budget; only an explicitly selected invocation process consumes it. */
    execInvocationTimeoutMs?: number | null;
}>;

export type PluginFileSystemRoots = Readonly<{
    pluginData: string;
    workspace?: string;
    projects: ReadonlyMap<string, string>;
}>;

export type CreatePluginInvocationServices = (
    seed: PluginInvocationServicesSeed,
    binding: PluginInvocationServiceBinding,
) => PluginServices;

export type CreateAgentInvocationServices = (
    params: Readonly<{
        readApprovalProfileId?: PluginInvocationServicesSeed['readApprovalProfileId'];
        workflowActionContext?: WorkflowAgentActionContext;
        actionRequestAttributionV1?: ActionExecutorContext['actionRequestAttributionV1'];
        processOwner?: ProcessOwnerRef;
        pluginId: string;
        pluginVersion: string;
        agentId: string;
        occurrenceId: string;
        correlationId: string;
        /** Exact preflight operation's existing Connected Account custody. */
        exactPurposeBindingSubjectId?: string;
        /** Account owner admitted by the host for this exact operation. */
        connectedAccountsOwner?: import('./connectedAccounts').StablePluginConnectedAccountsOwner;
        cwd: string;
        environment?: Readonly<Record<string, string>>;
        /** Host-owned auxiliary callback lifetime; never accepted from plugin input. */
        auxiliaryNativeOperation?: Readonly<{
            retainCleanup(cleanup: Readonly<{ dispose(): Promise<void> }>): void;
        }>;
        /** Captured host preparation; generic Exec stays nonactivating. */
        prepareAgentNativeLaunch?: import('./exec').HostAgentNativeLaunchPreparation;
        /** Captured host authority, rechecked by the physical Exec owner before launch. */
        assertLaunchCurrent?: (signal: AbortSignal) => Promise<void>;
        projectSetupOperation?: import('@/workspaces/projectSetup/projectSetupExecution').ProjectSetupOperationContext;
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
) => PluginInvocationServiceBinding;
