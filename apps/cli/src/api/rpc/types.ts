import type { AuthenticatedLocalRootCustody } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
/**
 * Common RPC types and interfaces for both session and machine clients
 */

import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { CallerInputConstraintsV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
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
 * Host-private Action context for an in-process invocation. It never exists
 * on a transported RPC request, so callers cannot supply causal authority in
 * the public request payload.
 */
export type RpcLocalActionContext = Readonly<Partial<Pick<
    ActionExecutorContext,
    'surface' | 'authority' | 'callerPermissionMode' | 'causalPermissionAuthority' | 'callerInputConstraints' | 'actionRequestId' | 'actionCaller'
    | 'externalActionExecutionAuthorization'
    | 'agentStartContext' | 'agentStartWorkDepth' | 'agentStartWorkspaceWrites' | 'sessionAgentSpawnPolicyV1'
>> & {
    /** Captured authenticated private-root identity; never serialized in an RPC request. */
    authenticatedLocalRootCustody?: AuthenticatedLocalRootCustody;
    /** Admitted headless Resume invocation, retained only through the in-process native launcher. */
    resumeActionContext?: ActionExecutorContext;
    /** Exact Workflow invocation store, admitted only by an in-process host. */
    executionRunPermissionRequestStore?: unknown;
    executionRunWorkflowObservationSink?: unknown;
    /** Identity from the admitted in-process Workflow caller; never transported in RPC input. */
    executionRunWorkflowRunId?: string;
    executionRunWorkflowScope?: ActionExecutorContext['executionRunWorkflowScope'];
    /** Accepted Workflow Machine ceiling from the in-process host, never RPC input. */
    executionRunTargetMachineId?: ActionExecutorContext['executionRunTargetMachineId'];
    operationProgress?: ActionExecutorContext['operationProgress'];
    operationAcceptance?: ActionExecutorContext['operationAcceptance'];
    runActionOperation?: ActionExecutorContext['runActionOperation'];
    operationOwnerUpdate?: ActionExecutorContext['operationOwnerUpdate'];
    operationCancellation?: ActionExecutorContext['operationCancellation'];
    operationReview?: import('@/daemon/actionOperations/actionOperationTypes').ActionOperationReviewContinuation;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
}>;

/** Content-free, host-owned operation observations; never part of an RPC DTO. */
export type RpcOperationDiagnostics = Readonly<{
    failedPhase?: string;
    causeCode?: string;
    phaseDurationsMs: Readonly<Record<string, number>>;
    phaseTimingsMs: readonly Readonly<{ phase: string; startedAtMs: number; finishedAtMs: number; durationMs: number }>[];
}>;

export type RpcHandlerContext = Readonly<{
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
    /** Host-owned handoff acceptance immediately before physical launch; never transported. */
    beforeSessionRunnerLaunch?: () => Promise<boolean>;
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
    /** Host-bound final admission check after preparation, never accepted from caller input. */
    verifyMachineAdmissionCurrent?: () => Promise<boolean>;
    /** Same current Machine admission owner, independent of a completed/cancelled transport request. */
    verifyMachineAuthorityCurrent?: () => Promise<boolean>;
    localActionContext?: RpcLocalActionContext;
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
] as const;
export type RpcAdmissionPredicate = (typeof RPC_ADMISSION_PREDICATES)[number];

export type RpcAuthorizationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string; errorCode?: string; admissionPredicate?: RpcAdmissionPredicate }>;

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
    authorizeRequest?: (request: Readonly<{
        method: string;
        params: unknown;
        authorization?: SocketRpcAuthorizationContext;
        transportResponseEnvelopeVersion?: 1;
        machineAdmission?: SocketRpcMachineAdmissionContextV1;
        workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
        workspaceSyncSourceExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
        workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
        workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
        workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
        /** Whole original SOURCE root, independently verified by Home before retention. */
        callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
        signal?: AbortSignal;
    }>) => RpcAuthorizationResult | Promise<RpcAuthorizationResult>;
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
