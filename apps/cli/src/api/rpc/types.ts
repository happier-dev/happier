/**
 * Common RPC types and interfaces for both session and machine clients
 */

import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { CallerInputConstraintsV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type {
    SocketRpcRequestPayload,
    SessionActionRpcOriginV1,
    SocketRpcTransportAcknowledgementV1,
    SocketRpcMachineAdmissionContextV1,
    WorkspaceSyncSourceRoutingV1,
    WorkspaceSyncTargetRoutingV1,
    WorkspaceSyncSourceWriterTargetRoutingV1,
    WorkspaceSyncSeedRoutingV1,
} from '@happier-dev/protocol/socketRpc';

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 */
/**
 * Host-private Action context. In-process callers retain it directly; the daemon's
 * peer-admitted local Session channel projects only its serializable start facts.
 * It never exists in a public RPC request payload.
 */
export type RpcLocalActionContext = Readonly<Partial<Pick<
    ActionExecutorContext,
    'surface' | 'authority' | 'callerPermissionMode' | 'causalPermissionAuthority' | 'workspaceWrites' | 'callerInputConstraints' | 'actionRequestId' | 'actionCaller'
    | 'externalActionExecutionAuthorization' | 'approvalOrigin' | 'approvedActionReplay' | 'presentUserConfirmation'
    | 'presentUserApproval' | 'actionRequestAttributionV1' | 'handoffTargetReplacementApproval'
    | 'originalActionEnvelope' | 'signExternalActionApprovalInput' | 'externalActionTarget' | 'runtimeAccountId' | 'serverId'
    | 'agentStartContext' | 'agentStartWorkDepth' | 'agentStartWorkspaceWrites' | 'sessionAgentSpawnPolicyV1' | 'actionAutomationPort'
    | 'authenticatedLocalRootCustody' | 'admittedHostWorkflowRequester' | 'hostReviewedChild'
>> & {
    /** Admitted headless Resume invocation, retained only through the in-process native launcher. */
    resumeActionContext?: ActionExecutorContext;
    /** Exact common-issuer child retained by an in-process execution-run handoff. */
    reviewedChildActionContext?: ActionExecutorContext;
    /** Exact Workflow invocation store, admitted only by an in-process host. */
    executionRunPermissionRequestStore?: unknown;
    executionRunWorkflowObservationSink?: unknown;
    /** Identity from the admitted in-process Workflow caller; never transported in RPC input. */
    executionRunWorkflowRunId?: string;
    executionRunWorkflowScope?: ActionExecutorContext['executionRunWorkflowScope'];
    /** That same Run's accepted origin Session, as its Workflow context stamped it; never RPC input. */
    executionRunWorkflowOriginSessionId?: string;
    /** Accepted Workflow Machine ceiling from the in-process host, never RPC input. */
    executionRunTargetMachineId?: ActionExecutorContext['executionRunTargetMachineId'];
    operationProgress?: ActionExecutorContext['operationProgress'];
    operationAcceptance?: ActionExecutorContext['operationAcceptance'];
    runActionOperation?: ActionExecutorContext['runActionOperation'];
    operationOwnerUpdate?: ActionExecutorContext['operationOwnerUpdate'];
    operationCancellation?: ActionExecutorContext['operationCancellation'];
    operationReview?: import('@/daemon/actionOperations/actionOperationTypes').ActionOperationReviewContinuation;
    /** The controller owns graph retirement. The target reaches this port after cleanup. */
    retirePreparedWorkspaceCopy?: () => Promise<void>;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    /** Captured Account Environment read; never serialized or accepted from a Process DTO. */
    processEnvironmentRead?: (target: Readonly<{ serverId: string; environmentId: string }>) => Promise<boolean>;
    /** Home-resolved access to the exact Session supplying this SCM workspace. */
    scmSessionWorkspace?: Readonly<{ sessionId: string; access: 'edit' | 'owner' }>;
    /** The originating Action's reader for this captured source, passed only in-process. */
    scmPullRequestComparisonRead?: Readonly<{
        sourceAction: import('@/scm/comparisons/readPullRequestComparisonPage').PullRequestComparisonSourceAction;
        readPage: import('@/scm/comparisons/readPullRequestComparisonPage').ReadPullRequestComparisonPage;
    }>;
}>;

/** Content-free, host-owned operation observations; never part of an RPC DTO. */
export type RpcOperationDiagnostics = Readonly<{
    failedPhase?: string;
    causeCode?: string;
    phaseDurationsMs: Readonly<Record<string, number>>;
    phaseTimingsMs: readonly Readonly<{ phase: string; startedAtMs: number; finishedAtMs: number; durationMs: number }>[];
}>;

export type RpcHandlerContext = Readonly<{
    /** Private data opened after the signed retained-copy route was admitted. */
    retainedCheckoutTeardown?: Readonly<{ data: import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1').RetainedCheckoutTeardownDataV1 | null }>;
    /** The installed ingress retained a claimed host Workflow's Account custody for this exact typed operation. */
    admittedHostWorkflowRequester?: ActionExecutorContext['admittedHostWorkflowRequester'];
    /** Requester selected by receiving admission. SCM member placement uses that requester's child. */
    directWorkspaceRequester?: Exclude<import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostRequesterExecutionIdentity, { kind: 'unknown' }>
        & Readonly<{ scmPlacement?: 'member' }>;
    /** Exact host capture returned by Machine admission; never parsed from a request. */
    workspaceSyncPrivateExecution?: import('@/workspaces/sync/workspaceSyncHandoffAdapter').RetainedWorkspaceSyncPrivateExecution;
    /** Content codec admitted for this exact call (its reply uses it); absent when no material was admitted. */
    contentMode?: 'plain' | 'e2ee';
    /** Exact Session content admitted by authenticated Home ingress, retained by its Browser stream. */
    sessionBrowserContent?: import('@/api/machine/machineStoredContent').MachineContentCodec;
    reportOperationDiagnostics?: (diagnostics: RpcOperationDiagnostics) => void;
    /** Receiving Action adapter's effect target; activity only, never admission authority. */
    reportSessionEffect?: (effect: Readonly<{ sessionId: string; actionId: string }>) => void;
    /** Exact present-person decision admitted by the installed Session transport owner. */
    requesterApprovalDecision?: ActionExecutorContext['requesterApprovalDecision'];
    signal: AbortSignal;
    /** Host receipt time, so a domain budget includes request admission/decryption. */
    requestStartedAtMs?: number;
    /** Full receipt-anchored work deadline; operation owners govern terminal reply waiting. */
    deadlineAtMs?: number;
    /** Content-free host diagnostics only; this does not grant or change admission. */
    reportAdmissionDenial?: (predicate: RpcAdmissionPredicate) => void;
    /** Host-admitted private ordinary Session bootstrap, never a public Action field. */
    requesterSessionBootstrap?: AdmittedRequesterSessionBootstrap;
    /** Daemon-observed executable facts, supplied only to the private requester effect pipe. */
    capabilitySessionFactories?: import('@/agent/catalog/runtimeEntry').AgentSessionFactoryObservations;
    /** Host-owned admission immediately before physical launch; never transported. */
    beforeSessionRunnerLaunch?: SpawnSessionOptions['beforeSessionRunnerLaunch'];
    /** Verified server ingress authority; never read from decrypted caller input. */
    callerAuthority?: ActionExecutorContext['authority'];
    /** Validated Home stamp from the Session caller's currently hosting Machine. */
    sessionActionOrigin?: SessionActionRpcOriginV1;
    /** Validated server ingress constraints, never decrypted caller input. */
    callerInputConstraints?: CallerInputConstraintsV1;
    /** Home transport proof bound before decryption; signed token is verified by downstream admission. */
    callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
    /** Strict exact Project envelope, retained only after current Root admission. */
    originalActionEnvelope?: import('@happier-dev/protocol/actions/externalActionApi').ExternalActionRequestEnvelope;
    /** Home-retained original installed chosen-child packet for closed Project SOURCE. */
    workspaceSyncSourceExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
    /** Validated transport correlation; authenticated relays replace caller values before dispatch. */
    transportRequestId?: string;
    sendHostResourceWatchFrame?: (frame: unknown) => Promise<unknown>;
    sendAgentInstallJobUpdate?: (update: import('@happier-dev/protocol/daemon/agent-install-jobs').AgentInstallJobUpdate) => Promise<unknown>;
    followHostResource?: Pick<Parameters<import('@/plugins/runtime/invocation/services/uiResourceWatch').PluginUiResourceWatchOwner['followHost']>[0],
        'onOpen' | 'onEvent'>;
    /** Home-stamped request identity for an admitted Project Open operation. */
    projectOpenRequestId?: string;
    /**
     * Server-derived transport context. It is absent for local invocation so
     * an in-process caller cannot synthesize authenticated account authority.
     */
    authorization?: SocketRpcAuthorizationContext;
    /** Current Home-stamped actor and exact Machine installation, independently of Session authority. */
    machineAdmission?: SocketRpcMachineAdmissionContextV1;
    /** Home-validated physical SOURCE routing retaining the original child authority. */
    workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
    /** Home-validated physical TARGET routing retaining the original admitted child authority. */
    workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
    /** Home-validated original SOURCE root and exact physical writer-to-target custody. */
    workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
    /** Home-validated installed seed request retaining the original SOURCE actor and Target prepare. */
    workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
    /** Host-bound lifetime of the admitted request; checks local cancellation, never caller input. */
    verifyMachineAdmissionCurrent?: () => Promise<boolean>;
    localActionContext?: RpcLocalActionContext;
    /** Account rows for an exact managed Session Project-files child admitted by the installed Open receiver. */
    sessionProjectOpenRows?: Extract<import('@/workspaces/projectAccountRows').ProjectAccountRowsInput, { credentials: import('@/persistence').StoredCredentials }>;
    /** Exact active common-issuer context; host-only and never accepted from RPC DTOs. */
    reviewedChildActionContext?: ActionExecutorContext;
}>;

export type RpcHandler<TRequest = any, TResponse = any> = (
    data: TRequest,
    context?: RpcHandlerContext,
) => TResponse | Promise<TResponse>;

export type RpcHandlerRegistrar = Readonly<{
    registerHandler: <TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>,
    ) => void;
}>;

export type RpcHandlerInvoker = Readonly<{
    invokeLocal: (method: string, params: unknown, options?: Readonly<{
        signal?: AbortSignal;
        localActionContext?: RpcLocalActionContext;
        /** Only the signed peer-grant admission may supply this host-side context. */
        verifiedPeerAuthority?: 'present_user' | 'account_automation';
    }>) => Promise<unknown>;
}>;

export type RpcHandlerManagerLike = RpcHandlerRegistrar & RpcHandlerInvoker;

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>;

export type RpcRequest = SocketRpcRequestPayload;

/** Host-private labels, never arbitrary error text or a transported field. */
export const RPC_ADMISSION_PREDICATES = [
    'machine_admission', 'machine_target', 'machine_home', 'machine_actor', 'machine_role',
    'machine_custodian', 'machine_installation', 'machine_request_target', 'machine_scope',
    'machine_currentness', 'machine_authority_currentness', 'request_cancelled',
    'session_authorization', 'session_target', 'authorization_unavailable',
    'discussion_approval', 'discussion_reply_custody', 'discussion_reply_result', 'discussion_publication',
    'prepared_transfer_phase',
] as const;
export type RpcAdmissionPredicate = (typeof RPC_ADMISSION_PREDICATES)[number];

export type RpcAuthorizationResult =
    | Readonly<{ ok: true; workspaceSyncPrivateExecution?: RpcHandlerContext['workspaceSyncPrivateExecution']; admittedHostWorkflowRequester?: ActionExecutorContext['admittedHostWorkflowRequester'];
        directWorkspaceRequester?: RpcHandlerContext['directWorkspaceRequester'];
        localSessionAuthorization?: Extract<SocketRpcAuthorizationContext, { kind: 'session.write' }> }>
    | Readonly<{ ok: false; error: string; errorCode?: string; admissionPredicate?: RpcAdmissionPredicate;
        failureCause?: import('@happier-dev/protocol/actions/actionExecutionResult').ActionFailureCauseV1 }>;

export type RpcHandlerActiveExecution = Readonly<{
    method: string;
    activeForMs: number;
    sessionEffect?: Readonly<{ sessionId: string; actionId: string }>;
}>;

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: unknown) => void;

/**
 * Configuration for RPC handler manager
 */
type RpcHandlerCommonConfig = {
    scopePrefix: string;
    /** Installed receiving lifecycle, never a caller-selected RPC parameter. */
    scopeKind?: 'session';
    /** Actual local runtime Machine, independently of Session metadata. */
    localMachineId?: string | null;
    /** Opens only the owner Session's existing codec after live Home admission. */
    resolveSessionDecisionContext?: (input: Readonly<{
        authorization: import('@happier-dev/protocol/socketRpc').SocketRpcSessionPermissionRespondAuthorizationContext;
        signal: AbortSignal;
    }>) => Promise<Readonly<{
        content: import('@happier-dev/sync-client').SocketRpcContent;
        isCurrent: () => Promise<boolean>;
    }> | null>;
    /** Select the existing Session key once for this Home-admitted Browser call. */
    resolveSessionBrowserContent?: (input: Readonly<{
        authorization: import('@happier-dev/protocol/socketRpc').SocketRpcSessionBrowserAuthorizationContext;
        signal: AbortSignal;
    }>) => Promise<import('@/api/machine/machineStoredContent').MachineContentCodec | null>;
    authorizeRequest?: (request: Readonly<{
        method: string;
        params: unknown;
        callerAuthority?: ActionExecutorContext['authority'];
        sessionActionOrigin?: SessionActionRpcOriginV1;
        /** Existing in-process provenance, never parsed from transported RPC input. */
        localActionContext?: RpcLocalActionContext;
        inheritedLocalActionContext?: RpcLocalActionContext;
        requesterSessionBootstrap?: AdmittedRequesterSessionBootstrap;
        authorization?: SocketRpcAuthorizationContext;
        transportResponseEnvelopeVersion?: 1;
        machineAdmission?: SocketRpcMachineAdmissionContextV1;
        /** Host-private admitted Session wake lifetime; never read from RPC input. */
        verifyMachineAdmissionCurrent?: () => Promise<boolean>;
        /** Home-only physical receiver fact; authorizer verifies provenance and exact tuple. */
        receivingMachineAdmission?: SocketRpcMachineAdmissionContextV1;
        workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
        workspaceSyncSourceExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
        workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
        workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
        workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
        /** Whole original SOURCE root, independently verified by Home before retention. */
        callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
        signal?: AbortSignal;
    }>, source?: 'authenticated_home_socket') => RpcAuthorizationResult | Promise<RpcAuthorizationResult>;
    /** Installation-private custody, opened only after the Home transport admission above. */
    prepareRequesterAccountContext?: import('@/daemon/externalActions/executeExternalAction').PrepareExternalActionRequesterAccountContext;
    /** The actual receiving Machine's incumbent V2 envelope key owner; never a relay's Account material. */
    resolveExternalActionEncryption?: import('@/daemon/externalActions/executeExternalAction').ResolveExternalActionEncryption;
    projectTransportAcknowledgement?: (request: Readonly<{
        method: string;
        params: unknown;
        result: unknown;
        authorization?: SocketRpcAuthorizationContext;
    }>) => SocketRpcTransportAcknowledgementV1 | null;
    logger?: (message: string, data?: unknown) => void;
    onRegistrationError?: (error: unknown) => void;
    onRegistrationAcknowledged?: (method: string) => void;
    /** Unprefixed handler identity, after installation or an active transport receipt. */
    onHandlerAvailabilityChanged?: (method: string) => void;
    nowMs?: () => number;
};

export type RpcHandlerConfig = RpcHandlerCommonConfig & (
    | Readonly<{
        encryptionMode: 'plain';
        /**
         * Retained only so older internal callers can migrate without a flag-day.
         * Plain transport never reads either value and keyless callers omit them.
         */
        encryptionKey?: Uint8Array;
        encryptionVariant?: 'legacy' | 'dataKey';
    }>
    | Readonly<{
        encryptionMode?: 'e2ee';
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
    }>
);

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = any> =
    | { success: true; data: T }
    | { success: false; error: string };
