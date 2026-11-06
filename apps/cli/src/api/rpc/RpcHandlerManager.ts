import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { SessionGoalControlFailureV1Schema, type SessionGoalControlFailureV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { createHash, randomUUID } from 'node:crypto';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import type {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
    RpcHandlerActiveExecution,
    RpcHandlerContext,
    RpcOperationDiagnostics,
    RpcAuthorizationResult,
} from './types';
import { RPC_ADMISSION_PREDICATES, type RpcAdmissionPredicate } from './types';
import type { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS, SocketRpcCancellationPayloadSchema, SocketRpcRequestIdSchema, SessionTransferRoutingV1Schema, SessionTransferRpcMethodV1Schema, SessionActionRpcOriginV1Schema, isSessionActionRpcMethodV1, SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcTransportAcknowledgementV1 } from '@happier-dev/protocol/socketRpc';
import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/automations/event';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityReadRequestV1Schema, ManagedAdmissionDrainConfirmRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { SESSION_SERVER_START_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { isSocketRpcActionApiServerOriginAuthorizationContext, isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext, isSocketRpcSessionServerStartServerOriginAuthorizationContext, isSocketRpcMachineAccessLossServerOriginAuthorizationContext, isSocketRpcSessionAuthorizationNamespace, parseSocketRpcAuthorizationContext, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { CallerInputConstraintsV1Schema } from '@happier-dev/protocol/auth/callerInputConstraintsV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { computeExternalActionSocketRpcRequestDigestV1, isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { isSocketRpcMachineReadServerOriginAuthorizationContext, SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema,
    WorkspaceSyncSeedRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, WorkspaceSyncPrepareBetweenRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { isDeepStrictEqual } from 'node:util';
import { resolveMachineRpcExternalActionEffectV1, resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { doesWorkspaceSyncSourceRootMatchRouting, doesWorkspaceSyncSourceWriterTargetRootMatchRouting,
    doesWorkspaceSyncTargetRoutingMatchWriterTarget, doesWorkspaceSyncProjectSourceRequestMatchRouting,
    doesWorkspaceSyncSeedRootMatchRouting, doesWorkspaceSyncFinitePrepareRequestMatchRouting } from '@/api/machine/machineRpcAuthorization';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { resolveExternalActionRootInvocationAuthority, isReviewedServiceMoveChild, isReviewedSecondOpinionModelSpawnChild, claimReviewedServiceMoveStart } from '@/api/externalActionExecutionAuthorization';
import { isDiscussionSecondOpinionModelRpcMethodV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { readProjectServiceMoveChildEffectV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRoleActionIdV1 } from '@happier-dev/protocol/prompts/roles/roleActionIdsV1';
import { isWorkspaceSyncTargetInstalledContent, openWorkspaceSyncTargetContent } from './workspaceSyncTargetContent';
import { waitForObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { timeWebLatencyPhase, withStorageReadTrace, withWebLatencyTrace } from '@/daemon/externalActions/webLatencyTrace';
import { AgentModelsProbeObservationSchema, type AgentModelsProbeObservation } from '@happier-dev/protocol/capabilities';
import { SpawnFailureV1Schema, type SpawnFailureV1 } from '@happier-dev/protocol/machines/processes/spawnFailureV1';
import { ActionFailureCauseV1Schema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';

type OwnedHandlerRegistrationContext = {
    ownerId: string;
    previousMethods: ReadonlySet<string>;
    nextMethods: Set<string>;
};

type PausedRequestAdmission = Readonly<{
    details?: unknown;
    revalidate?: (signal: AbortSignal) => Promise<void>;
    wait?: (signal: AbortSignal) => Promise<void>;
}>;

export type RpcHandlerRegistrationReadiness =
    | Readonly<{ status: 'ready' }>
    | Readonly<{
        status: 'timeout' | 'disconnected';
        missingMethods: readonly string[];
    }>;

type RegistrationReadinessWaiter = Readonly<{
    requiredMethods: readonly string[];
    requiredPrefixedMethods: ReadonlySet<string>;
    resolve: (result: RpcHandlerRegistrationReadiness) => void;
    timeout: ReturnType<typeof setTimeout>;
}>;

type ModelProbeDiagnostic = Readonly<{
    source?: AgentModelsProbeObservation['source'];
    refreshError?: boolean;
    availableModelsCount: number;
    spawnFailure?: Readonly<{ code: SpawnFailureV1['reason'] }>;
}>;

type RequestDiagnostic = {
    requestId: string;
    method: string;
    transportCorrelated: boolean;
    outcomeCode: string;
    callerClass: 'unadmitted' | 'unattributed' | 'machine_custodian' | 'machine_guest' | 'session' | 'server_origin' | 'local';
    admissionPredicate: string;
    admissionDenied?: boolean;
    acknowledgementOutcomeCode?: string;
    goalControlFailure?: SessionGoalControlFailureV1;
    modelProbe?: ModelProbeDiagnostic;
    failure?: Readonly<{
        failedPhase?: string;
        cancelled?: boolean;
        phaseDurationsMs: Readonly<Record<string, number>>;
        phaseTimingsMs?: RpcOperationDiagnostics['phaseTimingsMs'];
        causeCode?: string;
    }>;
};

// One family table owns both request decoding and response encoding. Dual-use
// reads retain ordinary encrypted client admission; the other families are Home-only.
const SERVER_ORIGIN_RPC_FAMILIES: readonly Readonly<{
    methods: readonly string[];
    isAuthorization: (value: unknown) => boolean;
    serverOnly: boolean;
    requiresMachineAdmission?: boolean;
    bindsMachineRead?: boolean;
}>[] = [
    { methods: [AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1], isAuthorization: isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext, serverOnly: true },
    { methods: [SESSION_SERVER_START_DAEMON_RPC_METHOD_V1], isAuthorization: isSocketRpcSessionServerStartServerOriginAuthorizationContext, serverOnly: true },
    { methods: [EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, MANAGED_FINITE_WAKE_RPC_METHOD], isAuthorization: isSocketRpcActionApiServerOriginAuthorizationContext, serverOnly: true },
    { methods: [RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS], isAuthorization: isSocketRpcMachineAccessLossServerOriginAuthorizationContext, serverOnly: true },
    { methods: [RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION], isAuthorization: isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext, serverOnly: true, requiresMachineAdmission: true },
    { methods: SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS, isAuthorization: isSocketRpcMachineReadServerOriginAuthorizationContext, serverOnly: false, bindsMachineRead: true },
];

function readOutcomeCode(value: unknown, thrown = false): string {
    if (!value || typeof value !== 'object') return thrown ? 'unclassified_error' : 'ok';
    const result = value as Record<string, unknown>;
    const domainCode = result.status === 'error' && result.error && typeof result.error === 'object'
        && 'code' in result.error ? result.error.code : undefined;
    const code = (thrown && result.code === 'RPC_REQUEST_TIMEOUT' ? result.code : undefined)
        ?? readRpcErrorCode(value) ?? result.errorCode
        ?? (thrown || result.ok === false ? result.code : undefined)
        ?? (result.ok === false ? result.error : undefined) ?? domainCode;
    // Retain typed native refusals as well as transport codes, never error prose.
    // Match the existing RPC provider diagnostic token budget (128 characters).
    // The end assertion rejects trailing newlines too, unlike JavaScript's `$`.
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}(?![\s\S])/.test(code)) return code;
    if (thrown && result.name === 'AbortError') return 'request_cancelled';
    return thrown || code !== undefined || typeof result.error === 'string' || result.ok === false || result.status === 'error'
        ? 'unclassified_error' : 'ok';
}

function readModelProbeDiagnostic(method: string, value: unknown): ModelProbeDiagnostic | undefined {
    if (method !== RPC_METHODS.CAPABILITIES_INVOKE || !value || typeof value !== 'object'
        || !('ok' in value) || value.ok !== true || !('result' in value)) return;
    const observation = value.result;
    if (!observation || typeof observation !== 'object' || !('availableModels' in observation)
        || !Array.isArray(observation.availableModels)) return;
    // Project only closed scalar facts. Revalidating model rows would add work
    // proportional to the catalog and risk disclosing native model/error text.
    const source = AgentModelsProbeObservationSchema.shape.source.safeParse('source' in observation ? observation.source : undefined);
    const failure = 'spawnFailure' in observation ? observation.spawnFailure : undefined;
    const reason = SpawnFailureV1Schema.shape.reason.safeParse(
        failure && typeof failure === 'object' && 'reason' in failure ? failure.reason : undefined,
    );
    return {
        ...(source.success && source.data !== undefined ? { source: source.data } : {}),
        ...('refreshError' in observation && typeof observation.refreshError === 'boolean'
            ? { refreshError: observation.refreshError } : {}),
        availableModelsCount: observation.availableModels.length,
        // The diagnostic code is the canonical closed cause, never a raw OS error.
        ...(reason.success ? { spawnFailure: { code: reason.data } } : {}),
    };
}

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly localMachineId: string | null;
    private rpcContent: SocketRpcContent | null;
    private readonly scopeKind: RpcHandlerConfig['scopeKind'];
    private readonly authorizeRequest: RpcHandlerConfig['authorizeRequest'];
    private readonly resolveSessionDecisionContext: RpcHandlerConfig['resolveSessionDecisionContext'];
    private readonly prepareRequesterAccountContext: RpcHandlerConfig['prepareRequesterAccountContext'];
    private readonly resolveExternalActionEncryption: RpcHandlerConfig['resolveExternalActionEncryption'];
    private readonly projectTransportAcknowledgement:
        RpcHandlerConfig['projectTransportAcknowledgement'];
    private readonly logger: (message: string, data?: unknown) => void;
    private readonly completionLogger: (message: string, data?: unknown) => void;
    private readonly onRegistrationError: RpcHandlerConfig['onRegistrationError'];
    private readonly onRegistrationAcknowledged:
        RpcHandlerConfig['onRegistrationAcknowledged'];
    private readonly nowMs: () => number;
    private socket: Socket | null = null;
    private readonly observedSockets = new WeakSet<Socket>();
    private readonly permanentlyRejectedRegistrationMethods = new Set<string>();
    private acknowledgedRegistrationMethods = new Set<string>();
    private registrationReadinessWaiters = new Set<RegistrationReadinessWaiter>();
    private readonly inFlightRequestCounts = new Map<string, number>();
    private readonly pausedRequestAdmission = new Map<string, PausedRequestAdmission>();
    private activeTransportRequestControllers = new Set<AbortController>();
    /**
     * The authenticated relay stamps this short-lived id immediately before it
     * dispatches here. It is deliberately transport-local: a caller cannot
     * cancel another caller's work by reusing its own outbound id.
     */
    private activeTransportRequestControllersByRequestId = new Map<string, AbortController>();
    private idleResolvers = new Set<() => void>();
    private nextHandlerExecutionId = 1;
    private activeHandlerExecutions = new Map<number, Readonly<{
        method: string;
        startedAtMs: number;
        sessionEffect?: RpcHandlerActiveExecution['sessionEffect'];
    }>>();
    private readonly ownedHandlerMethodsByOwner = new Map<string, Set<string>>();
    private ownedHandlerRegistration: OwnedHandlerRegistrationContext | null = null;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.localMachineId = config.localMachineId ?? null;
        this.rpcContent = this.createEncryptionContent(config);
        this.scopeKind = config.scopeKind;
        const authorizeRequest = config.authorizeRequest;
        this.authorizeRequest = authorizeRequest ? async request => {
            request.signal?.throwIfAborted();
            const pending = Promise.resolve(authorizeRequest(request));
            // Admission cannot retain a retired request even when a shared read
            // or external transport settles later. Accepted work omits this signal.
            return await (request.signal ? waitForObservation(pending, request.signal) : pending);
        } : undefined;
        this.resolveSessionDecisionContext = config.resolveSessionDecisionContext;
        this.prepareRequesterAccountContext = config.prepareRequesterAccountContext;
        this.resolveExternalActionEncryption = config.resolveExternalActionEncryption;
        this.projectTransportAcknowledgement =
            config.projectTransportAcknowledgement;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
        this.completionLogger = config.logger ?? ((msg, data) => defaultLogger.infoFile(msg, data));
        this.onRegistrationError = config.onRegistrationError;
        this.onRegistrationAcknowledged = config.onRegistrationAcknowledged;
        this.nowMs = config.nowMs ?? (() => performance.now());
    }

    adoptEncryptionContext(context: Pick<RpcHandlerConfig, 'encryptionMode' | 'encryptionKey' | 'encryptionVariant'>): void {
        this.rpcContent = this.createEncryptionContent(context);
    }

    retireEncryptionContext(): void {
        this.rpcContent = null;
    }

    private createEncryptionContent(context: Pick<RpcHandlerConfig, 'encryptionMode' | 'encryptionKey' | 'encryptionVariant'>): SocketRpcContent {
        if (context.encryptionMode === 'plain') return { mode: 'plain' };
        if (!context.encryptionKey || !context.encryptionVariant) throw new Error('RPC encryption material is unavailable');
        const key = new Uint8Array(context.encryptionKey);
        const variant = context.encryptionVariant;
        return { mode: 'e2ee', cipher: {
            encryptRaw: async (value) => encodeBase64(encrypt(key, variant, value)),
            decryptRaw: async (ciphertext) => decrypt(key, variant, decodeBase64(ciphertext)),
        } };
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const ownedRegistration = this.ownedHandlerRegistration;
        if (ownedRegistration) {
            ownedRegistration.nextMethods.add(method);
        } else {
            for (const methods of this.ownedHandlerMethodsByOwner.values()) {
                methods.delete(method);
            }
        }
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);
        this.permanentlyRejectedRegistrationMethods.delete(prefixedMethod);

        if (this.socket) {
            this.acknowledgedRegistrationMethods.delete(prefixedMethod);
            this.publishHandlerRegistration(prefixedMethod);
        }
    }

    private publishHandlerRegistration(prefixedMethod: string): boolean {
        const socket = this.socket;
        if (!socket) return false;
        const auth = socket.auth;
        if (typeof auth === 'object' && auth.clientType === 'machine-scoped') {
            const method = this.readUnprefixedMethod(prefixedMethod);
            const sessionAuthorization = resolveSocketRpcSessionAuthorization(method);
            // Keep daemon Action handlers available in-process; only their socket
            // publication is scoped. The closed map also declares Session writes
            // carried by the Machine lifecycle, alongside spawn and bulk transfers.
            if (method !== RPC_METHODS.SESSION_SPAWN_NEW
                && !SessionTransferRpcMethodV1Schema.safeParse(method).success
                && ((isSocketRpcSessionAuthorizationNamespace(method) && !sessionAuthorization)
                    || (sessionAuthorization?.routeToSessionOwnerDaemon === true && sessionAuthorization.machineScope !== true))) {
                return false;
            }
        }
        socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        return true;
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        const requestStartedAtMs = Date.now();
        // Diagnostic correlation never supplies cancellation or admission authority.
        const trace = SocketRpcRequestIdSchema.safeParse(request.traceId);
        const diagnosticId = trace.success ? trace.data : request.requestId;
        const traceRequestId = typeof diagnosticId === 'string' ? diagnosticId.replace(/^rpc_/u, '') : diagnosticId;
        return withWebLatencyTrace(traceRequestId, () => this.observeRequest(request.method, diagnosticId,
            diagnostic => this.dispatchRequest(request, diagnostic, requestStartedAtMs, trace.success)));
    }

    private async observeRequest(
        method: string, requestId: unknown, dispatch: (diagnostic: RequestDiagnostic) => Promise<unknown>, local = false,
    ): Promise<unknown> {
        const receivedAtMs = this.nowMs();
        const parsed = SocketRpcRequestIdSchema.safeParse(requestId);
        const registeredMethod = this.handlers.has(method) ? this.readUnprefixedMethod(method) : null;
        // Only registered declarations supply diagnostic names, never caller routes/scopes.
        const safeMethod = registeredMethod === null ? '<unregistered>'
            : /^[a-zA-Z0-9_.-]+$/.test(registeredMethod) ? registeredMethod : '<registered>';
        // The relay mints rpc_<UUID>. Opaque ids are correlated by digest, never copied as
        // text: the typed transport slot also accepts paths, credentials and LF.
        const diagnostic: RequestDiagnostic = {
            method: safeMethod, transportCorrelated: !local && parsed.success,
            requestId: parsed.success ? /^(?:rpc_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.data)
                ? parsed.data : `sha256:${createHash('sha256').update(parsed.data).digest('hex')}` : randomUUID(),
            outcomeCode: 'unclassified_error', callerClass: local ? 'local' : 'unattributed', admissionPredicate: 'request_admission',
        };
        try {
            if (diagnostic.transportCorrelated) this.completionLogger('[RPC] Request received', {
                method: diagnostic.method, requestId: diagnostic.requestId,
            });
            const storageRead = registeredMethod === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET
                || registeredMethod === RPC_METHODS.DAEMON_STORAGE_SCAN_GET
                || registeredMethod === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST;
            const response = await (storageRead ? withStorageReadTrace(diagnostic.requestId,
                () => timeWebLatencyPhase('storage.dispatch', () => dispatch(diagnostic))) : dispatch(diagnostic));
            if (local) {
                diagnostic.outcomeCode = readOutcomeCode(response);
                diagnostic.modelProbe = readModelProbeDiagnostic(diagnostic.method, response);
                const failure = SessionGoalControlFailureV1Schema.safeParse(
                    response && typeof response === 'object' ? Reflect.get(response, 'goalControlFailure') : undefined);
                if (failure.success) diagnostic.goalControlFailure = failure.data;
            }
            return response;
        } catch (error) {
            diagnostic.outcomeCode = readOutcomeCode(error, true);
            throw error;
        } finally {
            this.completionLogger('[RPC] Request completed', {
                method: diagnostic.method, requestId: diagnostic.requestId,
                durationMs: Math.max(0, Math.round(this.nowMs() - receivedAtMs)),
                outcomeCode: diagnostic.outcomeCode, callerClass: diagnostic.callerClass,
                ...(diagnostic.admissionDenied || diagnostic.outcomeCode === RPC_ERROR_CODES.FORBIDDEN
                    ? { admissionPredicate: diagnostic.admissionPredicate } : {}),
                ...(diagnostic.acknowledgementOutcomeCode ? { acknowledgementOutcomeCode: diagnostic.acknowledgementOutcomeCode } : {}),
                ...(diagnostic.goalControlFailure ? { goalControlFailure: diagnostic.goalControlFailure } : {}),
                ...(diagnostic.modelProbe ? { modelProbe: diagnostic.modelProbe } : {}),
                ...(diagnostic.failure ?? {}),
            });
        }
    }

    private reportAdmissionDenial(diagnostic: RequestDiagnostic, predicate: RpcAdmissionPredicate): void {
        if (RPC_ADMISSION_PREDICATES.some(known => known === predicate)) {
            diagnostic.admissionPredicate = predicate;
            diagnostic.admissionDenied = true;
        }
    }

    private reportOperationDiagnostics(diagnostic: RequestDiagnostic, operation: RpcOperationDiagnostics): void {
        diagnostic.failure = { ...diagnostic.failure, ...operation,
            phaseDurationsMs: { ...diagnostic.failure?.phaseDurationsMs, ...operation.phaseDurationsMs } };
    }

    private async dispatchRequest(request: RpcRequest, diagnostic: RequestDiagnostic, requestStartedAtMs: number, hasDiagnosticTrace: boolean): Promise<unknown> {
        // Admission captures its reply codec; later key adoption only affects new requests.
        const admittedContent = this.rpcContent;
        if (!admittedContent) {
            diagnostic.outcomeCode = RPC_ERROR_CODES.UPDATE_REQUIRED;
            return { error: 'RPC encryption material is unavailable', errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED };
        }
        let rpcContent: SocketRpcContent = admittedContent;
        const privateMethod = this.readUnprefixedMethod(request.method);
        const confidential = privateMethod === RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE
            || privateMethod === RPC_METHODS.DAEMON_SECRET_SOURCE_INVOKE
            || privateMethod === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ
            || privateMethod === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY
            || privateMethod === RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY;
        let callId: string | null = null;
        const respond = (request: RpcRequest, result: unknown, acknowledgement: SocketRpcTransportAcknowledgementV1 | null = null) => {
            diagnostic.outcomeCode = readOutcomeCode(result);
            diagnostic.modelProbe = readModelProbeDiagnostic(diagnostic.method, result);
            const failure = SessionGoalControlFailureV1Schema.safeParse(
                result && typeof result === 'object' ? Reflect.get(result, 'goalControlFailure') : undefined);
            if (failure.success) diagnostic.goalControlFailure = failure.data;
            return this.encodeTransportResponse(request, result, acknowledgement, callId, rpcContent);
        };
        const deny = (predicate: string, result: unknown = { error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN }) => {
            if (diagnostic.callerClass === 'unattributed') diagnostic.callerClass = 'unadmitted';
            diagnostic.admissionPredicate = predicate;
            diagnostic.admissionDenied = true;
            return respond(request, result);
        };
        const machineAdmission = request.machineAdmission === undefined
            ? null : SocketRpcMachineAdmissionContextV1Schema.safeParse(request.machineAdmission);
        if (machineAdmission && (!machineAdmission.success || !this.authorizeRequest)) {
            diagnostic.callerClass = 'unadmitted';
            return await deny('machine_admission');
        }
        const workspaceSyncSourceRouting = request.workspaceSyncSourceRouting === undefined
            ? null : WorkspaceSyncSourceRoutingV1Schema.safeParse(request.workspaceSyncSourceRouting);
        const workspaceSyncSourceExecution = request.workspaceSyncSourceExecution === undefined
            ? null : WorkspaceSyncSourceExecutionV1Schema.safeParse(request.workspaceSyncSourceExecution);
        const originalActionEnvelope = request.originalActionEnvelope === undefined
            ? null : ExternalActionRequestEnvelopeSchema.safeParse(request.originalActionEnvelope);
        const isProjectSource = this.readUnprefixedMethod(request.method) === RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN;
        const isFiniteSource = this.readUnprefixedMethod(request.method) === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN
            && workspaceSyncSourceRouting !== null;
        const workspaceSyncTargetRouting = request.workspaceSyncTargetRouting === undefined
            ? null : WorkspaceSyncTargetRoutingV1Schema.safeParse(request.workspaceSyncTargetRouting);
        const workspaceSyncSourceWriterTargetRouting = request.workspaceSyncSourceWriterTargetRouting === undefined
            ? null : WorkspaceSyncSourceWriterTargetRoutingV1Schema.safeParse(request.workspaceSyncSourceWriterTargetRouting);
        const workspaceSyncSeedRouting = request.workspaceSyncSeedRouting === undefined
            ? null : WorkspaceSyncSeedRoutingV1Schema.safeParse(request.workspaceSyncSeedRouting);
        const isWorkspaceSourcePhase = isProjectSource || isFiniteSource
            || this.readUnprefixedMethod(request.method) === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE;
        const targetMethod = this.readUnprefixedMethod(request.method);
        const isWorkspaceTargetPhase = targetMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
            || targetMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
            || targetMethod === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE;
        if (workspaceSyncSeedRouting && (!workspaceSyncSeedRouting.success || !machineAdmission?.success
            || !this.authorizeRequest || workspaceSyncSourceRouting || workspaceSyncTargetRouting || workspaceSyncSourceWriterTargetRouting
            || request.method !== `${this.scopePrefix}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
            || workspaceSyncSeedRouting.data.sourceWriterTarget.sourceWriter.machineId !== this.scopePrefix
            || !isWorkspaceSyncTargetInstalledContent(request.params))) {
            return await deny('workspace_seed_routing');
        }
        if (workspaceSyncSourceWriterTargetRouting && (!workspaceSyncSourceWriterTargetRouting.success || !isWorkspaceTargetPhase
            || !machineAdmission?.success || !this.authorizeRequest || workspaceSyncSourceRouting
            || workspaceSyncTargetRouting && (!workspaceSyncTargetRouting.success
                || !doesWorkspaceSyncTargetRoutingMatchWriterTarget(workspaceSyncTargetRouting.data, workspaceSyncSourceWriterTargetRouting.data))
            || request.method !== `${this.scopePrefix}:${targetMethod}`)) {
            return await deny('workspace_writer_target_routing');
        }
        if (isWorkspaceSyncTargetInstalledContent(request.params)) {
            const installation = readInstallationIdentityIfExistsSync();
            const installedRouting = workspaceSyncSeedRouting?.success ? workspaceSyncSeedRouting.data
                : workspaceSyncSourceWriterTargetRouting?.success ? workspaceSyncSourceWriterTargetRouting.data
                : (isProjectSource || isFiniteSource) && workspaceSyncSourceRouting?.success ? workspaceSyncSourceRouting.data : undefined;
            const content = installation && installedRouting && typeof request.params === 'string'
                ? openWorkspaceSyncTargetContent({ ciphertext: request.params, installation, machineId: this.scopePrefix,
                    method: request.method, routing: installedRouting }) : null;
            if (!content) return await respond(request, { error: 'Installed workspace target content is unavailable', errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
            rpcContent = content;
        }
        if (workspaceSyncTargetRouting && (!isWorkspaceTargetPhase || !workspaceSyncTargetRouting.success
            || !machineAdmission?.success || !this.authorizeRequest || workspaceSyncSourceRouting
            || request.method !== `${this.scopePrefix}:${targetMethod}`)) {
            return await deny('workspace_target_routing');
        }
        if ((isWorkspaceSourcePhase || workspaceSyncSourceRouting) && (!isWorkspaceSourcePhase
            || !workspaceSyncSourceRouting?.success || !machineAdmission?.success || !this.authorizeRequest
            || request.method !== `${this.scopePrefix}:${isFiniteSource ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN
                : isProjectSource ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN
                : RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`
            || (isProjectSource || isFiniteSource) && (!workspaceSyncSourceExecution?.success
                || workspaceSyncSourceExecution.data.method !== request.method
                || isFiniteSource && workspaceSyncSourceExecution.data.params !== request.params))) {
            return await deny('workspace_source_routing');
        }
        const workspaceContext = workspaceSyncSourceRouting?.success ? workspaceSyncSourceRouting.data.sourceContext
            : workspaceSyncTargetRouting?.success ? workspaceSyncTargetRouting.data.targetContext
                : workspaceSyncSeedRouting?.success ? workspaceSyncSeedRouting.data.sourceWriterTarget.source.sourceContext : undefined;
        if (workspaceContext && (!isDeepStrictEqual(workspaceContext.machineAdmission, machineAdmission?.success ? machineAdmission.data : undefined)
            || workspaceContext.callerAuthority !== request.callerAuthority
            || !isDeepStrictEqual(workspaceContext.sessionActionOrigin, request.sessionActionOrigin)
            || !isDeepStrictEqual(workspaceContext.callerInputConstraints, request.callerInputConstraints))) {
            return await deny('workspace_caller_context');
        }
        const parsedInputAuthorization = request.callerInputAuthorization === undefined
            ? null : ExternalActionExecutionAuthorizationV1Schema.safeParse(request.callerInputAuthorization);
        const serviceMoveChild = Boolean(parsedInputAuthorization?.success && originalActionEnvelope?.success
            && workspaceSyncSourceExecution?.success && machineAdmission?.success && this.authorizeRequest
            && (parsedInputAuthorization.data.binding.actionId === 'projects.service.relocate'
                && workspaceSyncSourceExecution.data.externalActionExecution.effectActionId === readProjectServiceMoveChildEffectV1(targetMethod)
              || parsedInputAuthorization.data.binding.actionId === 'discussion.second_opinion.start'
                && isDiscussionSecondOpinionModelRpcMethodV1(targetMethod)
                && workspaceSyncSourceExecution.data.externalActionExecution.effectActionId === 'session.spawn_new')
            && workspaceSyncSourceExecution.data.externalActionExecution.installationId === parsedInputAuthorization.data.binding.installationId
            && isDeepStrictEqual(workspaceSyncSourceExecution.data.externalActionExecution.authorization, parsedInputAuthorization.data)
            && isDeepStrictEqual(workspaceSyncSourceExecution.data.originalActionEnvelope, originalActionEnvelope.data)
            && workspaceSyncSourceExecution.data.method === request.method
            && sameStrictJsonValue(workspaceSyncSourceExecution.data.params, request.params)
            && machineAdmission.data.machineId === this.scopePrefix && this.scopePrefix === this.localMachineId
            && machineAdmission.data.actorAccountId === parsedInputAuthorization.data.binding.accountId
            && request.callerAuthority === resolveExternalActionRootInvocationAuthority(parsedInputAuthorization.data)
            && isDeepStrictEqual(request.sessionActionOrigin, parsedInputAuthorization.data.binding.sessionActionOrigin));
        const projectWriterTarget = workspaceSyncSourceWriterTargetRouting?.success
            && parsedInputAuthorization?.success && parsedInputAuthorization.data.binding.actionId === 'projects.open';
        const seedInputAuthorizationMatchesRequest = !!(workspaceSyncSeedRouting?.success && parsedInputAuthorization?.success
            && workspaceSyncSourceExecution?.success && machineAdmission?.success && this.authorizeRequest
            && doesWorkspaceSyncSeedRootMatchRouting(parsedInputAuthorization.data, workspaceSyncSeedRouting.data,
                workspaceSyncSourceExecution.data));
        if (workspaceSyncSeedRouting && !seedInputAuthorizationMatchesRequest) {
            return await deny('workspace_seed_authorization');
        }
        if (projectWriterTarget && workspaceSyncSourceWriterTargetRouting?.success && parsedInputAuthorization?.success
            && workspaceSyncSourceWriterTargetRouting.data.target.phase !== 'release'
            && (!workspaceSyncSourceExecution?.success
                || workspaceSyncSourceExecution.data.method !== `${workspaceSyncSourceWriterTargetRouting.data.sourceWriter.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`
                || workspaceSyncSourceExecution.data.externalActionExecution.installationId !== parsedInputAuthorization.data.binding.installationId
                || !isDeepStrictEqual(workspaceSyncSourceExecution.data.externalActionExecution.authorization, parsedInputAuthorization.data))) {
            return await deny('workspace_source_execution');
        }
        if (workspaceSyncSourceExecution && ((!serviceMoveChild && !isProjectSource && !isFiniteSource && !projectWriterTarget && !seedInputAuthorizationMatchesRequest) || !workspaceSyncSourceExecution.success)
            || originalActionEnvelope && (!originalActionEnvelope.success || !parsedInputAuthorization?.success
                || !(serviceMoveChild || parsedInputAuthorization.data.binding.actionId === 'projects.open' && targetMethod === RPC_METHODS.PROJECTS_OPEN
                    || parsedInputAuthorization.data.binding.actionId === 'projects.script.run' && targetMethod === RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN
                    || parsedInputAuthorization.data.binding.actionId === 'projects.compute.exec' && targetMethod === RPC_METHODS.DAEMON_PROJECTS_COMPUTE_EXEC)
                || request.method !== `${this.scopePrefix}:${targetMethod}`
                || !isExternalActionAuthorizationBoundToEnvelope(parsedInputAuthorization.data.binding,
                    { actionId: parsedInputAuthorization.data.binding.actionId, machineId: serviceMoveChild ? parsedInputAuthorization.data.binding.machineId : this.scopePrefix, envelope: originalActionEnvelope.data }))) {
            return await deny('original_action_binding');
        }
        const writerTargetInputAuthorizationMatchesRequest = !!(parsedInputAuthorization?.success
            && workspaceSyncSourceWriterTargetRouting?.success && machineAdmission?.success && this.authorizeRequest
            && doesWorkspaceSyncSourceWriterTargetRootMatchRouting(parsedInputAuthorization.data,
                workspaceSyncSourceWriterTargetRouting.data, machineAdmission.data)
            && workspaceSyncSourceWriterTargetRouting.data.source.sourceContext.callerAuthority === request.callerAuthority
            && isDeepStrictEqual(workspaceSyncSourceWriterTargetRouting.data.source.sourceContext.sessionActionOrigin, request.sessionActionOrigin)
            && isDeepStrictEqual(workspaceSyncSourceWriterTargetRouting.data.source.sourceContext.callerInputConstraints, request.callerInputConstraints));
        const sourceInputAuthorizationMatchesRequest = (() => {
            if (!parsedInputAuthorization?.success || !machineAdmission?.success
                || !workspaceSyncSourceRouting?.success || !workspaceContext || !this.authorizeRequest) return false;
            if (isFiniteSource && (!workspaceSyncSourceExecution?.success
                || workspaceSyncSourceExecution.data.externalActionExecution.effectActionId !== parsedInputAuthorization.data.binding.actionId
                || workspaceSyncSourceExecution.data.externalActionExecution.installationId !== parsedInputAuthorization.data.binding.installationId
                || !isDeepStrictEqual(workspaceSyncSourceExecution.data.externalActionExecution.authorization, parsedInputAuthorization.data))) return false;
            return doesWorkspaceSyncSourceRootMatchRouting(parsedInputAuthorization.data, workspaceSyncSourceRouting.data);
        })();
        const machineInputAuthorizationMatchesRequest = (() => {
            if (!parsedInputAuthorization?.success || !machineAdmission?.success || !this.authorizeRequest) return false;
            const binding = parsedInputAuthorization.data.binding;
            const admission = machineAdmission.data;
            // The Home already verified the installed signer and opaque request. Keep its original
            // Action identity distinct from the relay's target-local cancellation correlation.
            const expectedAuthority = resolveExternalActionRootInvocationAuthority(parsedInputAuthorization.data);
            return binding.machineId === this.scopePrefix && binding.machineId === this.localMachineId
                && admission.machineId === binding.machineId && admission.installationId === binding.installationId
                && admission.actorAccountId === binding.accountId && admission.custodianAccountId === binding.custodianAccountId
                && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
                && request.method === `${this.scopePrefix}:${this.readUnprefixedMethod(request.method)}`
                && resolveMachineRpcExternalActionEffectV1(this.readUnprefixedMethod(request.method), binding) === binding.actionId
                && request.callerAuthority === expectedAuthority
                && isDeepStrictEqual(binding.sessionActionOrigin, request.sessionActionOrigin);
        })();
        const sessionTransitionInputAuthorizationMatchesRequest = (() => {
            if (!parsedInputAuthorization?.success || !this.localMachineId
                || this.scopePrefix === this.localMachineId) return false;
            const binding = parsedInputAuthorization.data.binding;
            const privateAccountCustody = !!parsedInputAuthorization.data.requesterAccountContext && !!this.prepareRequesterAccountContext;
            const apiRootAdmission = 'grant' in binding && !parsedInputAuthorization.data.requesterAccountContext && !!this.authorizeRequest;
            if (!privateAccountCustody && !apiRootAdmission) return false;
            const expectedAuthority = 'authentication' in binding && !binding.sessionActionOrigin && !binding.workflowActionOrigin
                ? 'present_user' : 'account_automation';
            return binding.actionId === 'session.agent.transition' && binding.machineId === this.localMachineId
                && (binding.target.kind === 'machine' && binding.target.machineId === this.localMachineId
                    || binding.target.kind === 'session' && binding.target.sessionId === this.scopePrefix)
                && (targetMethod === SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION
                    || targetMethod === SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)
                && request.method === `${this.scopePrefix}:${targetMethod}` && request.callerAuthority === expectedAuthority
                && isDeepStrictEqual(binding.sessionActionOrigin, request.sessionActionOrigin);
        })();
        const workflowRoleInputAuthorizationMatchesRequest = (() => {
            if (!parsedInputAuthorization?.success) return false;
            const binding = parsedInputAuthorization.data.binding;
            return !!binding.workflowActionOrigin?.sessionAuthority && binding.target.kind === 'session'
                && binding.target.sessionId === this.scopePrefix && request.callerAuthority === 'account_automation'
                && request.method === `${this.scopePrefix}:${targetMethod}`
                && (binding.actionId === targetMethod && targetMethod.startsWith('session.') && isRoleActionIdV1(targetMethod)
                    || binding.actionId === 'session.roles.apply_to_reports' && targetMethod === SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET);
        })();
        const sessionActionOrigin = request.sessionActionOrigin === undefined
            ? null : SessionActionRpcOriginV1Schema.safeParse(request.sessionActionOrigin);
        if (sessionActionOrigin && (!sessionActionOrigin.success
            || request.callerAuthority !== 'account_automation'
            || isWorkspaceTargetPhase && !workspaceSyncTargetRouting?.success
                && (!machineAdmission?.success || machineAdmission.data.machineId !== this.scopePrefix || !this.authorizeRequest)
            || !serviceMoveChild && !machineInputAuthorizationMatchesRequest && !sessionTransitionInputAuthorizationMatchesRequest && !sourceInputAuthorizationMatchesRequest
                && !writerTargetInputAuthorizationMatchesRequest && !seedInputAuthorizationMatchesRequest
                && !isSessionActionRpcMethodV1(this.readUnprefixedMethod(request.method)))) {
            return await deny('session_action_origin', { error: 'Invalid Session Action origin', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        }
        const parsedTransferRouting = request.transferRouting === undefined
            ? null : SessionTransferRoutingV1Schema.safeParse(request.transferRouting);
        if (parsedTransferRouting && (!parsedTransferRouting.success
            || parsedTransferRouting.data.sessionId !== this.scopePrefix
            || request.method !== `${parsedTransferRouting.data.sessionId}:${parsedTransferRouting.data.method}`)) {
            return await deny('session_transfer_routing', { error: 'Invalid Session transfer routing', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        }
        const parsedConstraints = request.callerInputConstraints === undefined
            ? null
            : CallerInputConstraintsV1Schema.safeParse(request.callerInputConstraints);
        if (parsedConstraints && !parsedConstraints.success) {
            return await deny('caller_input_constraints', {
                error: 'Invalid RPC caller input constraints',
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            });
        }
        const parsedRequestId = request.requestId === undefined
            ? null
            : SocketRpcRequestIdSchema.safeParse(request.requestId);
        if (parsedRequestId && !parsedRequestId.success) {
            return await deny('request_correlation', {
                error: 'Invalid RPC request correlation',
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            });
        }
        const requestId = parsedRequestId && parsedRequestId.success
            ? parsedRequestId.data
            : null;
        if (parsedInputAuthorization) {
            let matchesRequest = serviceMoveChild || machineInputAuthorizationMatchesRequest || sessionTransitionInputAuthorizationMatchesRequest || sourceInputAuthorizationMatchesRequest
                || writerTargetInputAuthorizationMatchesRequest || seedInputAuthorizationMatchesRequest || workflowRoleInputAuthorizationMatchesRequest;
            if (!matchesRequest && parsedInputAuthorization.success && requestId) {
                const binding = parsedInputAuthorization.data.binding;
                try {
                    matchesRequest = (binding.actionId === 'session.message.send'
                            && targetMethod === SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND
                        || binding.actionId === 'session.user_action.answer'
                            && targetMethod === RPC_METHODS.SESSION_USER_ACTION_ANSWER)
                        && binding.requestId === requestId
                        && binding.machineId === this.localMachineId
                        && binding.target.kind === 'session'
                        && binding.target.sessionId === this.scopePrefix
                        && request.method === `${this.scopePrefix}:${targetMethod}`
                        && binding.requestEnvelopeDigest === computeExternalActionSocketRpcRequestDigestV1({
                            method: request.method, requestId, params: request.params, target: binding.target,
                        });
                } catch { matchesRequest = false; }
            }
            if (!matchesRequest) {
                return await deny('caller_input_authorization', {
                    error: 'Invalid RPC caller input authorization', errorCode: RPC_ERROR_CODES.FORBIDDEN,
                });
            }
        }
        if (requestId && this.activeTransportRequestControllersByRequestId.has(requestId)) {
            // A duplicate target-side id must not replace the first controller:
            // doing so would let one cancel event abort the wrong live effect.
            return await deny('request_correlation_collision', {
                error: 'RPC request correlation collision',
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            });
        }
        const receivingMethod = this.readUnprefixedMethod(request.method);
        let countedInFlight = !this.pausedRequestAdmission.has(receivingMethod);
        if (countedInFlight) this.beginInFlightRequest(receivingMethod);
        const controller = new AbortController();
        this.activeTransportRequestControllers.add(controller);
        if (requestId) {
            this.activeTransportRequestControllersByRequestId.set(requestId, controller);
        }
        const timeoutMs = typeof request.timeoutMs === 'number'
            && Number.isSafeInteger(request.timeoutMs)
            && request.timeoutMs > 0
            ? request.timeoutMs
            : null;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cancellationDeadlineAtMs = timeoutMs === null ? null : requestStartedAtMs + timeoutMs;
        const deadlineAtMs = cancellationDeadlineAtMs;
        const armDeadline = () => {
            if (cancellationDeadlineAtMs === null) return;
            timeout = setTimeout(() => {
                if (Date.now() < cancellationDeadlineAtMs) { armDeadline(); return; }
                controller.abort(Object.assign(new Error('RPC request timed out'), {
                    code: 'RPC_REQUEST_TIMEOUT', rpcErrorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE,
                }));
            }, Math.min(2_147_483_647, Math.max(0, cancellationDeadlineAtMs - Date.now())));
        };
        armDeadline();
        let handlerExecutionId: number | null = null;
        let disposeRequesterAccountContext: (() => Promise<void>) | undefined;
        let phase = 'request_admission';
        let phaseStartedAtMs = this.nowMs();
        const phaseDurationsMs: Record<string, number> = {};
        const nextPhase = (next: string) => {
            const now = this.nowMs();
            phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + Math.max(0, Math.round(now - phaseStartedAtMs));
            phase = next;
            phaseStartedAtMs = now;
        };
        try {
            const pausedAtArrival = this.pausedRequestAdmission.get(this.readUnprefixedMethod(request.method));
            const admissionRevalidation = this.revalidatePausedRequestAdmission(this.readUnprefixedMethod(request.method), controller.signal);
            if (admissionRevalidation) await admissionRevalidation;
            if (!this.pausedRequestAdmission.has(receivingMethod) && !countedInFlight && !controller.signal.aborted) {
                this.beginInFlightRequest(receivingMethod);
                countedInFlight = true;
            }
            const pausedAdmission = this.pausedRequestAdmission.get(this.readUnprefixedMethod(request.method))
                ?? (controller.signal.aborted ? pausedAtArrival : undefined);
            if (pausedAdmission) {
                // Bind an encrypted refusal to the actual request before encoding it.
                // An unbound transport error cannot carry definite no-effect evidence.
                try {
                    const decoded = await socketRpcCodec.decodeRequestParams(rpcContent, request.params, request.method);
                    callId = decoded.callId;
                } catch (error) {
                    return await respond(request, { error: 'Unable to open RPC content',
                        errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.UPDATE_REQUIRED });
                }
                return await deny('handler_admission', { error: 'RPC client temporarily unavailable', errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE,
                    ...(pausedAdmission.details === undefined ? {} : { details: pausedAdmission.details }) });
            }
            controller.signal.throwIfAborted();
            const sessionDecisionAuthorization = parseSocketRpcAuthorizationContext(request.authorization);
            const isRequesterDecisionMethod = request.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`);
            const isSessionDecisionRoute = isRequesterDecisionMethod
                && (request.method !== `${this.scopePrefix}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`
                    || sessionDecisionAuthorization?.kind === 'session.permission.respond');
            let requesterApprovalDecision: RpcHandlerContext['requesterApprovalDecision'];
            if (isSessionDecisionRoute) {
                if (request.callerAuthority !== 'present_user' || sessionDecisionAuthorization?.kind !== 'session.permission.respond'
                    || !sessionDecisionAuthorization.authentication
                    || request.method !== `${sessionDecisionAuthorization.sessionId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`
                    || !this.resolveSessionDecisionContext) return await deny('session_decision_authorization');
                const admitted = await this.resolveSessionDecisionContext({ authorization: sessionDecisionAuthorization, signal: controller.signal });
                if (!admitted) return await deny('session_decision_currentness');
                rpcContent = admitted.content;
                requesterApprovalDecision = { sessionId: sessionDecisionAuthorization.sessionId,
                    actor: sessionDecisionAuthorization.actor,
                    isCurrent: async () => {
                        try { return !controller.signal.aborted && await admitted.isCurrent() && !controller.signal.aborted; }
                        catch { return false; }
                    } };
                if (!await requesterApprovalDecision.isCurrent()) return await deny('session_decision_currentness');
            }
            const serverOriginFamily = this.readServerOriginRpcFamily(request);
            const isServerOriginRequest = this.isServerOriginRequest(request);
            if ((serverOriginFamily?.serverOnly && !isServerOriginRequest)
                || (serverOriginFamily?.requiresMachineAdmission && (!machineAdmission?.success || !this.authorizeRequest))) {
                return await deny('reserved_server_origin', {
                    error: RPC_ERROR_MESSAGES.FORBIDDEN,
                    errorCode: RPC_ERROR_CODES.FORBIDDEN,
                });
            }

            // Decrypt the incoming params (unless session is plaintext).
            let decryptedParams: unknown;
            try {
                const decoded = await socketRpcCodec.decodeRequestParams(
                    isServerOriginRequest || this.isContentFreeManagedActivityRequest(request) ? { mode: 'plain' } : rpcContent,
                    request.params,
                    request.method,
                );
                decryptedParams = decoded.params;
                callId = decoded.callId;
                if (!hasDiagnosticTrace && request.requestId === undefined && callId !== null) diagnostic.requestId = callId;
            } catch (error) {
                return await respond(request, {
                    error: confidential ? 'confidential_continuation_failed' : error instanceof Error ? error.message : 'Unable to open RPC content',
                    errorCode: confidential ? 'confidential_continuation_failed' : readRpcErrorCode(error) ?? RPC_ERROR_CODES.UPDATE_REQUIRED,
                });
            }

            const handler = this.handlers.get(request.method)
                ?? (requesterApprovalDecision ? this.handlers.get(`${this.scopePrefix}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`) : undefined);
            if (!handler) {
                return await respond(request, { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            }
            if (requesterApprovalDecision && (!decryptedParams || typeof decryptedParams !== 'object' || Array.isArray(decryptedParams)
                || !('sessionId' in decryptedParams) || decryptedParams.sessionId !== requesterApprovalDecision.sessionId)) {
                return await deny('session_decision_target');
            }
            if (requesterApprovalDecision && decryptedParams && typeof decryptedParams === 'object'
                && 'decisionSource' in decryptedParams) {
                // Display modality belongs to this authenticated requester packet,
                // never the public Action input or the receiving transport surface.
                const { decisionSource, ...actionInput } = decryptedParams;
                if (decisionSource !== 'voice') return await deny('session_decision_source');
                requesterApprovalDecision = { ...requesterApprovalDecision, decisionSource };
                decryptedParams = actionInput;
            }

            if (parsedTransferRouting?.success) {
                const routing = parsedTransferRouting.data;
                const isInit = routing.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT
                    || routing.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT;
                if (isInit && (!decryptedParams || typeof decryptedParams !== 'object' || Array.isArray(decryptedParams)
                    || (decryptedParams as Record<string, unknown>).t !== routing.t
                    || (routing.t === 'session_attachment_upload_v1'
                        && (decryptedParams as Record<string, unknown>).sessionId !== routing.sessionId))) {
                    return await deny('session_transfer_payload', { error: 'Session transfer payload does not match routing', errorCode: RPC_ERROR_CODES.FORBIDDEN });
                }
            }

            const authorizationRequest = Object.freeze({
                    method: request.method,
                    params: decryptedParams,
                    authorization: request.authorization,
                    transportResponseEnvelopeVersion: request.transportResponseEnvelopeVersion,
                    ...(machineAdmission?.success ? { machineAdmission: Object.freeze(machineAdmission.data) } : {}),
                    ...(workspaceSyncSourceRouting?.success ? { workspaceSyncSourceRouting: Object.freeze(workspaceSyncSourceRouting.data) } : {}),
                    ...(workspaceSyncSourceExecution?.success ? { workspaceSyncSourceExecution: Object.freeze(workspaceSyncSourceExecution.data) } : {}),
                    ...(workspaceSyncTargetRouting?.success ? { workspaceSyncTargetRouting: Object.freeze(workspaceSyncTargetRouting.data) } : {}),
                    ...(workspaceSyncSourceWriterTargetRouting?.success ? { workspaceSyncSourceWriterTargetRouting: Object.freeze(workspaceSyncSourceWriterTargetRouting.data) } : {}),
                    ...(workspaceSyncSeedRouting?.success ? { workspaceSyncSeedRouting: Object.freeze(workspaceSyncSeedRouting.data) } : {}),
                    ...((serviceMoveChild || sessionTransitionInputAuthorizationMatchesRequest || sourceInputAuthorizationMatchesRequest || writerTargetInputAuthorizationMatchesRequest || seedInputAuthorizationMatchesRequest || workflowRoleInputAuthorizationMatchesRequest) && parsedInputAuthorization?.success
                        ? { callerInputAuthorization: parsedInputAuthorization.data } : {}),
                    signal: controller.signal,
            });
            let workspaceSyncPrivateExecution: RpcHandlerContext['workspaceSyncPrivateExecution'];
            if (this.authorizeRequest) {
                nextPhase('authorize_request');
                diagnostic.callerClass = 'unadmitted';
                diagnostic.admissionPredicate = 'authorize_request';
                const authorization = await timeWebLatencyPhase('machineRpc.authorize', () => this.authorizeRequest!(authorizationRequest));
                // Home verification can settle false because this request was cancelled.
                // Preserve that lifecycle result before interpreting an access refusal.
                controller.signal.throwIfAborted();
                if (!authorization.ok) {
                    const failedPhase = phase;
                    nextPhase('response');
                    diagnostic.failure = { failedPhase, cancelled: false, phaseDurationsMs: { ...phaseDurationsMs } };
                    diagnostic.admissionDenied = true;
                    if (authorization.admissionPredicate) this.reportAdmissionDenial(diagnostic, authorization.admissionPredicate);
                    return await respond(request, {
                        error: confidential ? 'confidential_continuation_failed' : authorization.error,
                        ...(confidential ? { errorCode: 'confidential_continuation_failed' } : authorization.errorCode ? { errorCode: authorization.errorCode } : {}),
                        effectAttempted: false,
                    });
                }
                workspaceSyncPrivateExecution = authorization.workspaceSyncPrivateExecution;
            }
            nextPhase('input_binding');
            // Session handlers validate the relay's actor themselves and need
            // not install a manager admission callback. Attribute its parsed
            // stamp without treating the presence of authorization as denial.
            const sessionAuthorization = parseSocketRpcAuthorizationContext(request.authorization);
            diagnostic.callerClass = machineAdmission?.success
                ? machineAdmission.data.actorAccountId === machineAdmission.data.custodianAccountId ? 'machine_custodian' : 'machine_guest'
                : isServerOriginRequest ? 'server_origin'
                    : sessionAuthorization?.sessionId === this.scopePrefix ? 'session' : 'unattributed';

            if (parsedInputAuthorization?.success && parsedInputAuthorization.data.binding.actionId === 'projects.open'
                && parsedInputAuthorization.data.binding.machineId === this.scopePrefix
                && (machineInputAuthorizationMatchesRequest && targetMethod === RPC_METHODS.PROJECTS_OPEN
                    || writerTargetInputAuthorizationMatchesRequest && workspaceSyncSourceWriterTargetRouting?.success
                        && workspaceSyncSourceWriterTargetRouting.data.target.phase !== 'release')) {
                // Only D can open its original protected Project input. P1/P2
                // retain the exact envelope and D's packet, never D's key.
                const authorization = parsedInputAuthorization.data;
                const binding = authorization.binding;
                const source = workspaceSyncSourceWriterTargetRouting?.success
                    ? workspaceSyncSourceWriterTargetRouting.data.source : undefined;
                const retainedEnvelope = source?.originalActionEnvelope ?? (originalActionEnvelope?.success ? originalActionEnvelope.data : undefined);
                const parsedEnvelope = ExternalActionRequestEnvelopeSchema.safeParse(retainedEnvelope ?? { v: 1,
                    requestId: binding.requestId, target: binding.target, input: decryptedParams });
                if (!parsedEnvelope.success) {
                    return await deny('project_envelope');
                }
                const envelope = parsedEnvelope.data;
                let originalInput: unknown = envelope.v === 1 ? envelope.input : undefined;
                if (envelope.v === 2) {
                    const encryption = await this.resolveExternalActionEncryption?.(controller.signal, authorization).catch(() => null);
                    if (encryption?.serverIdentityId === binding.serverIdentityId) {
                        originalInput = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, material: encryption.material, binding: {
                            serverIdentityId: binding.serverIdentityId, accountId: binding.accountId,
                            actionId: binding.actionId, requestId: binding.requestId, target: binding.target,
                            ...('authentication' in binding ? { authentication: {
                                kind: binding.authentication.kind, tokenEpoch: binding.authentication.tokenEpoch,
                            } } : { credentialId: binding.credentialId }),
                        } })?.input;
                    }
                }
                const opened = OpenProjectInputV1Schema.safeParse(originalInput);
                const body = source ? undefined : OpenProjectInputV1Schema.safeParse(decryptedParams);
                const matches = isExternalActionAuthorizationBoundToEnvelope(binding,
                    { actionId: 'projects.open', machineId: this.scopePrefix, envelope }) && opened.success
                    && (source && workspaceSyncSourceWriterTargetRouting?.success
                        ? doesWorkspaceSyncProjectSourceRequestMatchRouting(opened.data, authorization, source)
                            && opened.data.materialization.kind === 'sync'
                            && opened.data.materialization.targetPath === workspaceSyncSourceWriterTargetRouting.data.target.targetRootPath
                        : body?.success && isDeepStrictEqual(opened.data, body.data));
                if (!matches || controller.signal.aborted) {
                    return await deny(controller.signal.aborted ? 'request_cancelled' : 'project_input_binding');
                }
            }

            let admittedTargetRouting = workspaceSyncTargetRouting?.success ? workspaceSyncTargetRouting.data : undefined;
            const admittedWriterTarget = workspaceSyncSourceWriterTargetRouting?.success
                ? workspaceSyncSourceWriterTargetRouting.data : undefined;
            if (!admittedTargetRouting && writerTargetInputAuthorizationMatchesRequest
                && admittedWriterTarget?.source.sourceContext && machineAdmission?.success
                && this.scopePrefix !== admittedWriterTarget.target.targetMachineId) {
                // Home has independently admitted D and this installed receiver. Keep the
                // original caller ceiling; the target owner must still prove D maps to this
                // physical Machine/root through its current native bind before any effect.
                admittedTargetRouting = WorkspaceSyncTargetRoutingV1Schema.parse({ ...admittedWriterTarget.target,
                    targetContext: { ...admittedWriterTarget.source.sourceContext, machineAdmission: machineAdmission.data } });
            }

            if (sourceInputAuthorizationMatchesRequest && parsedInputAuthorization?.success) {
                // The actual parent has now verified its installation and the original child admission
                // at Home. Bind the decrypted chosen target before retaining the child's root.
                const phase = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.safeParse(decryptedParams);
                const handoff = parsedInputAuthorization.data.binding.handoffAdmission;
                const sourceBodyMatches = isFiniteSource
                    ? workspaceSyncSourceRouting?.success && doesWorkspaceSyncFinitePrepareRequestMatchRouting(decryptedParams,
                        parsedInputAuthorization.data, workspaceSyncSourceRouting.data)
                    : isProjectSource
                    ? workspaceSyncSourceRouting?.success && doesWorkspaceSyncProjectSourceRequestMatchRouting(decryptedParams,
                        parsedInputAuthorization.data, workspaceSyncSourceRouting.data)
                    : phase.success && handoff && phase.data.input.targetMachineId === handoff.targetMachineId
                        && phase.data.input.sourceMachineId === handoff.sourceMachineId && phase.data.input.sourceSessionId === handoff.sessionId;
                if (!sourceBodyMatches) {
                    return await deny('workspace_source_body');
                }
            }

            let callerInputAuthorization = parsedInputAuthorization?.success ? parsedInputAuthorization.data : undefined;
            let requesterInvocation: import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1').ExternalActionRequesterInvocationV1 | undefined;
            if (machineInputAuthorizationMatchesRequest && callerInputAuthorization?.binding.actionId === 'session.agent.transition') {
                const phase = decryptedParams && typeof decryptedParams === 'object' && !Array.isArray(decryptedParams)
                    ? decryptedParams as Record<string, unknown> : null;
                if (!phase || typeof phase.sessionId !== 'string' || !phase.sessionId.trim()
                    || targetMethod !== RPC_METHODS.STOP_SESSION && phase.type !== 'resume-session') {
                    return await respond(request, { error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN });
                }
            }
            if (sessionTransitionInputAuthorizationMatchesRequest && targetMethod === SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION) {
                const phase = decryptedParams && typeof decryptedParams === 'object' && !Array.isArray(decryptedParams)
                    ? decryptedParams as Record<string, unknown> : null;
                if (phase?.serviceId !== 'session.agentTransition' || (phase.action !== 'enforce' && phase.action !== 'clear')) {
                    return await respond(request, { error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN });
                }
            }
            if (callerInputAuthorization?.requesterAccountContext) {
                const finitePreparation = isFiniteSource && sourceInputAuthorizationMatchesRequest;
                if ((!serviceMoveChild && !machineInputAuthorizationMatchesRequest && !sessionTransitionInputAuthorizationMatchesRequest && !finitePreparation) || !this.prepareRequesterAccountContext
                    || controller.signal.aborted) {
                    return await deny('requester_account_admission');
                }
                const installation = finitePreparation || serviceMoveChild ? readInstallationIdentityIfExistsSync() : null;
                const preparationRequest = finitePreparation ? WorkspaceSyncPrepareBetweenRequestV1Schema.safeParse(decryptedParams) : null;
                if (finitePreparation && (!installation || !preparationRequest?.success)) return await deny('requester_account_admission');
                nextPhase('requester_preparation');
                const prepared = await timeWebLatencyPhase('machineRpc.requesterPreparation', () => this.prepareRequesterAccountContext!({ authorization: callerInputAuthorization!,
                    purpose: finitePreparation && installation && preparationRequest?.success
                        ? { kind: 'workspace_sync_prepare', controller: { machineId: this.scopePrefix, installationId: installation.installationId },
                            request: preparationRequest.data }
                        : { kind: 'machine_rpc', method: this.readUnprefixedMethod(request.method), params: decryptedParams,
                            ...(serviceMoveChild && installation ? { recipient: { machineId: this.scopePrefix, installationId: installation.installationId } } : {}) },
                    ...(serviceMoveChild ? { verifyServiceMoveChildCurrent: async () => {
                        try { return !controller.signal.aborted && this.authorizeRequest !== undefined
                            && (await this.authorizeRequest(authorizationRequest)).ok; } catch { return false; }
                    } } : {}),
                    ...(finitePreparation ? { verifyWorkspaceSyncPrepareCurrent: async () => {
                        try { return !controller.signal.aborted && this.authorizeRequest !== undefined
                            && (await this.authorizeRequest(authorizationRequest)).ok; } catch { return false; }
                    } } : {}), signal: controller.signal }));
                nextPhase('input_binding');
                if (!prepared) {
                    return await deny('requester_account_preparation');
                }
                disposeRequesterAccountContext = prepared.dispose;
                if (controller.signal.aborted || prepared.authorization.token !== callerInputAuthorization.token
                    || !isDeepStrictEqual(prepared.authorization.binding, callerInputAuthorization.binding)) {
                    return await deny('requester_account_binding');
                }
                callerInputAuthorization = prepared.authorization;
                requesterInvocation = prepared.invocation;
            }

            if (serviceMoveChild) {
                if (!callerInputAuthorization || !originalActionEnvelope?.success) return await deny('caller_input_authorization');
                const opinionChild = callerInputAuthorization.binding.actionId === 'discussion.second_opinion.start';
                const child = opinionChild ? isDiscussionSecondOpinionModelRpcMethodV1(targetMethod) ? 'session.spawn_new' : null
                    : readProjectServiceMoveChildEffectV1(targetMethod);
                const review = opinionChild ? isReviewedSecondOpinionModelSpawnChild : isReviewedServiceMoveChild;
                if (!child || !await review({ authorization: callerInputAuthorization,
                    envelope: originalActionEnvelope.data, signal: controller.signal,
                    actionId: child, machineId: this.scopePrefix, params: decryptedParams,
                    ...(opinionChild ? { method: targetMethod } : {}) })) {
                    return await deny('caller_input_authorization');
                }
                if (child === 'localServices.launcher.start') {
                    const claim = await claimReviewedServiceMoveStart({ authorization: callerInputAuthorization,
                        envelope: originalActionEnvelope.data, signal: controller.signal });
                    if (claim.kind !== 'claimed') return await respond(request, {
                        ok: false, error: claim.reasonCode, errorCode: claim.reasonCode,
                    });
                }
            }

            // Call the handler
            nextPhase('handler');
            diagnostic.admissionPredicate = 'handler_admission';
            if (diagnostic.transportCorrelated) this.completionLogger('[RPC] Request admitted', {
                method: diagnostic.method, requestId: diagnostic.requestId, callerClass: diagnostic.callerClass,
            });
            handlerExecutionId = this.beginHandlerExecution(
                this.readUnprefixedMethod(request.method),
            );
            const result = await handler(decryptedParams, Object.freeze({
                ...(workspaceSyncPrivateExecution ? { workspaceSyncPrivateExecution } : {}),
                // The same codec choice as encodeResponse for this call, fixed at admission.
                contentMode: this.isServerOriginRequest(request) || this.isContentFreeManagedActivityRequest(request)
                    ? 'plain' : rpcContent.mode,
                signal: controller.signal,
                reportSessionEffect: (effect: NonNullable<RpcHandlerActiveExecution['sessionEffect']>) => this.reportSessionEffect(handlerExecutionId, effect),
                reportOperationDiagnostics: (operation: RpcOperationDiagnostics) => this.reportOperationDiagnostics(diagnostic, operation),
                requestStartedAtMs,
                ...(deadlineAtMs === null ? {} : { deadlineAtMs }),
                reportAdmissionDenial: (predicate: RpcAdmissionPredicate) => this.reportAdmissionDenial(diagnostic, predicate),
                callerAuthority: requesterInvocation?.authority === 'account_automation' ? 'account_automation'
                    : request.callerAuthority === 'present_user' ? request.callerAuthority : 'account_automation',
                ...(sessionActionOrigin?.success ? { sessionActionOrigin: sessionActionOrigin.data } : {}),
                ...(workspaceSyncSourceRouting?.success ? { workspaceSyncSourceRouting: workspaceSyncSourceRouting.data } : {}),
                ...(workspaceSyncSourceExecution?.success ? { workspaceSyncSourceExecution: workspaceSyncSourceExecution.data } : {}),
                ...(originalActionEnvelope?.success && (serviceMoveChild || machineInputAuthorizationMatchesRequest)
                    ? { originalActionEnvelope: originalActionEnvelope.data } : {}),
                ...(admittedTargetRouting ? { workspaceSyncTargetRouting: admittedTargetRouting } : {}),
                ...(workspaceSyncSourceWriterTargetRouting?.success ? { workspaceSyncSourceWriterTargetRouting: workspaceSyncSourceWriterTargetRouting.data } : {}),
                ...(workspaceSyncSeedRouting?.success ? { workspaceSyncSeedRouting: workspaceSyncSeedRouting.data } : {}),
                ...(callerInputAuthorization ? {
                    callerInputAuthorization,
                ...(requesterInvocation?.callerInputConstraints ? { callerInputConstraints: requesterInvocation.callerInputConstraints }
                  : 'grant' in callerInputAuthorization.binding ? {
                    callerInputConstraints: {
                        models: callerInputAuthorization.binding.grant.models,
                        permissionModes: callerInputAuthorization.binding.grant.permissionModes,
                    },
                    } : {}),
                } : parsedConstraints?.success ? { callerInputConstraints: parsedConstraints.data } : {}),
                ...(requestId ? { transportRequestId: requestId } : {}),
                ...(request.authorization ? { authorization: request.authorization } : {}),
                ...(requesterApprovalDecision ? { requesterApprovalDecision } : {}),
                ...(machineAdmission?.success ? {
                    machineAdmission: machineAdmission.data,
                    verifyMachineAuthorityCurrent: async () => {
                        try {
                            // Accepted daemon-owned work outlives the caller's transport lifetime.
                            // Access is still re-derived through the canonical live admission owner.
                            return this.authorizeRequest !== undefined
                                && (await this.authorizeRequest({ ...authorizationRequest, signal: undefined })).ok;
                        } catch { return false; }
                    },
                    verifyMachineAdmissionCurrent: async () => {
                        try {
                            return !controller.signal.aborted && this.authorizeRequest !== undefined
                                && (await this.authorizeRequest(authorizationRequest)).ok
                                && !controller.signal.aborted;
                        } catch { return false; }
                    },
                } : {}),
            }));

            // Encrypt and return the response
            nextPhase('response');
            const acknowledgement = confidential ? null : this.projectAcknowledgement(
                request,
                decryptedParams,
                result,
                diagnostic,
            );
            const response = await respond(request, result, acknowledgement);
            return response;
        } catch (error) {
            const failedPhase = phase;
            nextPhase('response');
            const causeCode = error instanceof Error && error.cause ? readOutcomeCode(error.cause, true) : 'unclassified_error';
            diagnostic.failure = { failedPhase, cancelled: controller.signal.aborted,
                ...(['RPC_REQUEST_TIMEOUT', 'ERR_CANCELED', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT']
                    .includes(causeCode) ? { causeCode } : {}),
                ...diagnostic.failure,
                phaseDurationsMs: { ...phaseDurationsMs, ...diagnostic.failure?.phaseDurationsMs } };
            if (confidential) {
                return await respond(request, { error: 'confidential_continuation_failed', errorCode: 'confidential_continuation_failed' });
            }
            const rpcErrorCode = readRpcErrorCode(controller.signal.aborted ? controller.signal.reason : error)
                ?? readRpcErrorCode(error);
            const forwardedCause = ActionFailureCauseV1Schema.safeParse(
                error && typeof error === 'object' && 'failureCause' in error ? error.failureCause : undefined,
            );
            const errorResponse = {
                error: redactBugReportSensitiveText(error instanceof Error ? error.message : 'Unknown error'),
                ...(rpcErrorCode ? { errorCode: rpcErrorCode } : {}),
                failureCause: forwardedCause.success ? forwardedCause.data : projectActionFailureCauseV1(error, 'rpc.handler'),
            };
            const outcomeCode = readOutcomeCode(controller.signal.aborted ? controller.signal.reason : error, true);
            const response = await respond(request, errorResponse);
            // Native OS/process codes and cancellation are diagnostic facts;
            // preserve them before the existing transport projection drops them.
            diagnostic.outcomeCode = outcomeCode;
            return response;
        } finally {
            nextPhase('requester_cleanup');
            await timeWebLatencyPhase('machineRpc.requesterCleanup', () => disposeRequesterAccountContext?.());
            nextPhase('complete');
            if (handlerExecutionId !== null) {
                this.activeHandlerExecutions.delete(handlerExecutionId);
            }
            if (timeout) clearTimeout(timeout);
            this.activeTransportRequestControllers.delete(controller);
            if (requestId && this.activeTransportRequestControllersByRequestId.get(requestId) === controller) {
                this.activeTransportRequestControllersByRequestId.delete(requestId);
            }
            if (countedInFlight) this.finishInFlightRequest(receivingMethod);
        }
    }

    /**
     * Invoke a registered handler in-process (no encryption/decryption).
     *
     * This is intended for internal control-plane surfaces (e.g. MCP tools) that
     * must delegate to the same handler implementations as session RPC.
     */
    async invokeLocal(method: string, params: unknown, options?: Readonly<{
        signal?: AbortSignal;
        admissionResult?: Extract<RpcAuthorizationResult, { ok: true }>;
        localActionContext?: import('./types').RpcLocalActionContext;
        verifiedPeerAuthority?: 'present_user' | 'account_automation';
        /** Installed host forwards an already-admitted requester; input never supplies authority. */
        rpcContext?: Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent' | 'callerInputAuthorization'
            | 'callerAuthority' | 'callerInputConstraints' | 'sessionActionOrigin' | 'originalActionEnvelope' | 'requesterSessionBootstrap' | 'localActionContext'>;
    }>): Promise<unknown> {
        return await this.invokeLocalHandler(method, params, this.handlers.get(this.getPrefixedMethod(method)), options);
    }

    /** Retain an owning lifecycle's local handler while sharing RPC admission, diagnostics and idle draining. */
    async invokeLocalHandler(
        method: string,
        params: unknown,
        handler: RpcHandler<unknown, unknown> | undefined,
        options?: Parameters<RpcHandlerManager['invokeLocal']>[2],
    ): Promise<unknown> {
        const prefixedMethod = this.getPrefixedMethod(method);
        const requestStartedAtMs = Date.now();
        // In-process admission fixes the content mode at invocation, like a dispatched call.
        const admittedContentMode = this.rpcContent?.mode;
        const callerInputConstraints = options?.rpcContext?.callerInputConstraints
            ?? options?.localActionContext?.callerInputConstraints;
        // Admission and the native handler consume the same host-private authority.
        const callerAuthority = options?.localActionContext?.authority === 'account_automation'
            || options?.localActionContext?.actionCaller?.kind === 'session' ? 'account_automation'
            : options?.rpcContext?.callerAuthority ?? options?.verifiedPeerAuthority ?? options?.localActionContext?.authority;
        return this.observeRequest(prefixedMethod, undefined, async diagnostic => {
            diagnostic.admissionPredicate = 'handler_admission';
            if (!handler) {
                return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const signal = options?.signal ?? new AbortController().signal;
            const localRequester = options?.rpcContext !== undefined
                || options?.localActionContext?.authority === 'account_automation'
                || options?.localActionContext?.actionCaller?.kind === 'session'
                || options?.verifiedPeerAuthority === 'account_automation';
            if ((localRequester || this.scopeKind === 'session')
                && resolveMachineRpcRoutePolicy(method).requesterExecutionIsolationRequired === true) {
                // A fresh Action's local delegation is not an owner-person default.
                // Re-enter the installed receiving owner unless this exact direct
                // invocation already completed its admission at that owner.
                // Closed host calls with no requester keep their own authority.
                if ((!options?.rpcContext && this.scopeKind !== 'session') || !this.authorizeRequest) return {
                    errorCode: 'agent_isolation_unavailable',
                    error: 'Requester execution admission is unavailable. Update or restart the controller daemon and retry through authenticated Machine ingress.',
                    effectAttempted: false,
                };
                const authorization = options?.admissionResult ?? await this.authorizeRequest({ method: prefixedMethod, params,
                    machineAdmission: options?.rpcContext?.machineAdmission,
                    verifyMachineAdmissionCurrent: options?.rpcContext?.verifyMachineAdmissionCurrent,
                    callerAuthority,
                    callerInputAuthorization: options?.rpcContext?.callerInputAuthorization,
                    sessionActionOrigin: options?.rpcContext?.sessionActionOrigin,
                    localActionContext: options?.localActionContext,
                    inheritedLocalActionContext: options?.rpcContext?.localActionContext,
                    requesterSessionBootstrap: options?.rpcContext?.requesterSessionBootstrap,
                    signal,
                });
                signal.throwIfAborted();
                if (!authorization.ok) return { error: authorization.error,
                    ...(authorization.errorCode ? { errorCode: authorization.errorCode } : {}), effectAttempted: false };
            }
            let countedInFlight = !this.pausedRequestAdmission.has(method);
            if (countedInFlight) this.beginInFlightRequest(method);
            let handlerExecutionId: number | null = null;
            try {
                const pausedAtArrival = this.pausedRequestAdmission.get(method);
                const admissionRevalidation = this.revalidatePausedRequestAdmission(method, signal);
                if (admissionRevalidation) await admissionRevalidation;
                if (!this.pausedRequestAdmission.has(method) && !countedInFlight && !signal.aborted) {
                    this.beginInFlightRequest(method);
                    countedInFlight = true;
                }
                const pausedAdmission = this.pausedRequestAdmission.get(method)
                    ?? (signal.aborted ? pausedAtArrival : undefined);
                if (pausedAdmission) {
                    return { error: 'RPC client temporarily unavailable', errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE,
                        ...(pausedAdmission.details === undefined ? {} : { details: pausedAdmission.details }) };
                }
                signal.throwIfAborted();
                handlerExecutionId = this.beginHandlerExecution(method);
                return await handler(params, Object.freeze({
                    ...(options?.admissionResult?.workspaceSyncPrivateExecution
                        ? { workspaceSyncPrivateExecution: options.admissionResult.workspaceSyncPrivateExecution } : {}),
                    ...(options?.rpcContext ? {
                        machineAdmission: options.rpcContext.machineAdmission,
                        verifyMachineAdmissionCurrent: options.rpcContext.verifyMachineAdmissionCurrent,
                        callerInputAuthorization: options.rpcContext.callerInputAuthorization,
                        sessionActionOrigin: options.rpcContext.sessionActionOrigin,
                        originalActionEnvelope: options.rpcContext.originalActionEnvelope,
                        requesterSessionBootstrap: options.rpcContext.requesterSessionBootstrap,
                    } : {}),
                    ...(callerInputConstraints ? { callerInputConstraints } : {}),
                    ...(admittedContentMode ? { contentMode: admittedContentMode } : {}),
                    signal,
                    requestStartedAtMs,
                    reportSessionEffect: (effect: NonNullable<RpcHandlerActiveExecution['sessionEffect']>) => this.reportSessionEffect(handlerExecutionId, effect),
                    reportOperationDiagnostics: (operation: RpcOperationDiagnostics) => this.reportOperationDiagnostics(diagnostic, operation),
                    reportAdmissionDenial: (predicate: RpcAdmissionPredicate) => this.reportAdmissionDenial(diagnostic, predicate),
                    ...((options?.rpcContext?.callerAuthority ?? options?.verifiedPeerAuthority)
                        ? { callerAuthority: options?.rpcContext?.callerAuthority ?? options?.verifiedPeerAuthority } : {}),
                    ...(options?.localActionContext
                        ? { localActionContext: options.localActionContext }
                        : {}),
                }));
            } finally {
                if (handlerExecutionId !== null) this.activeHandlerExecutions.delete(handlerExecutionId);
                if (countedInFlight) this.finishInFlightRequest(method);
            }
        }, true);
    }

    onSocketConnect(socket: Socket): void {
        if (this.socket && this.socket !== socket) {
            this.settleRegistrationReadinessWaiters('disconnected');
        }
        this.socket = socket;
        this.acknowledgedRegistrationMethods.clear();
        // Rejection policy belongs to the relay admission that produced it.
        // Every connect starts fresh admission, including reuse of the same Socket.
        this.permanentlyRejectedRegistrationMethods.clear();
        if (!this.observedSockets.has(socket)) {
            this.observedSockets.add(socket);
            socket.on(SOCKET_RPC_EVENTS.ERROR, (error: unknown) => {
                if (this.socket !== socket) {
                    return;
                }
                const type = error && typeof error === 'object' && !Array.isArray(error)
                    ? (error as Record<string, unknown>).type
                    : null;
                if (type !== 'register') {
                    return;
                }
                const rejection = error as Record<string, unknown>;
                const method = typeof rejection.method === 'string' && this.handlers.has(rejection.method)
                    ? rejection.method : undefined;
                if (method && rejection.retryable === false) {
                    this.permanentlyRejectedRegistrationMethods.add(method);
                }
                // The relay owns rejection policy. Log only its bounded error code
                // and a method we actually registered, never arbitrary response bags.
                const safeErrors = ['Forbidden', 'Invalid method name', 'Machine replaced',
                    'Machine unavailable', 'Internal error', 'client-upgrade-required', RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE];
                this.logger('[RPC] [ERROR] Handler registration rejected', {
                    ...(method ? { method } : {}),
                    error: typeof rejection.error === 'string' && safeErrors.includes(rejection.error)
                        ? rejection.error : 'Registration rejected',
                    ...(typeof rejection.retryable === 'boolean' ? { retryable: rejection.retryable } : {}),
                });
                this.onRegistrationError?.(error);
            });
            socket.on(SOCKET_RPC_EVENTS.REGISTERED, (data: unknown) => {
                if (this.socket !== socket) {
                    return;
                }
                const method = data && typeof data === 'object' && !Array.isArray(data)
                    ? (data as Record<string, unknown>).method
                    : null;
                if (typeof method !== 'string' || !this.handlers.has(method)) {
                    return;
                }
                this.acknowledgedRegistrationMethods.add(method);
                this.permanentlyRejectedRegistrationMethods.delete(method);
                this.settleReadyRegistrationWaiters();
                this.onRegistrationAcknowledged?.(method);
            });
            socket.on(SOCKET_RPC_EVENTS.CANCEL, (payload: unknown) => {
                if (this.socket !== socket) {
                    return;
                }
                const parsed = SocketRpcCancellationPayloadSchema.safeParse(payload);
                if (!parsed.success) {
                    return;
                }
                this.activeTransportRequestControllersByRequestId
                    .get(parsed.data.requestId)
                    ?.abort(new Error('RPC request cancelled by caller'));
            });
        }
        for (const [prefixedMethod] of this.handlers) {
            if (this.permanentlyRejectedRegistrationMethods.has(prefixedMethod)) continue;
            this.publishHandlerRegistration(prefixedMethod);
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
        this.acknowledgedRegistrationMethods.clear();
        this.settleRegistrationReadinessWaiters('disconnected');
        this.cancelTransportRequests();
    }

    /** Retire callers while their reply socket is still available during close. */
    cancelTransportRequests(): void {
        for (const controller of this.activeTransportRequestControllers) {
            controller.abort(new Error('RPC target transport disconnected'));
        }
        this.activeTransportRequestControllersByRequestId.clear();
    }

    async waitForRegisteredHandlers(
        methods: readonly string[],
        options: Readonly<{ timeoutMs: number }>,
    ): Promise<RpcHandlerRegistrationReadiness> {
        const requiredMethods = Array.from(new Set(methods.map((method) => method.trim()).filter(Boolean)));
        const requiredPrefixedMethods = new Set(requiredMethods.map((method) => this.getPrefixedMethod(method)));
        if (this.areRegistrationMethodsAcknowledged(requiredPrefixedMethods)) {
            return { status: 'ready' };
        }
        if (!this.socket) {
            return {
                status: 'disconnected',
                missingMethods: this.readMissingRegistrationMethods(requiredMethods),
            };
        }

        return await new Promise<RpcHandlerRegistrationReadiness>((resolve) => {
            let waiter!: RegistrationReadinessWaiter;
            const timeout = setTimeout(() => {
                this.registrationReadinessWaiters.delete(waiter);
                resolve({
                    status: 'timeout',
                    missingMethods: this.readMissingRegistrationMethods(requiredMethods),
                });
            }, Math.max(0, options.timeoutMs));
            waiter = {
                requiredMethods,
                requiredPrefixedMethods,
                resolve,
                timeout,
            };
            this.registrationReadinessWaiters.add(waiter);
            this.settleReadyRegistrationWaiters();
        });
    }

    /**
     * Replay only registrations whose receipt has not reached the active socket.
     *
     * Socket.IO can deliver a client's initial registration burst before a
     * server finishes post-connect admission and installs its listener. The
     * caller owns when a replay is justified; this manager preserves the
     * receipt/current-socket boundary and never replays acknowledged handlers.
     */
    replayUnacknowledgedHandlerRegistrations(methods?: readonly string[]): readonly string[] {
        const socket = this.socket;
        if (!socket) return [];

        const replayedMethods: string[] = [];
        const candidates = methods === undefined
            ? Array.from(this.handlers.keys(), (method) => this.readUnprefixedMethod(method))
            : methods;
        for (const method of new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))) {
            const prefixedMethod = this.getPrefixedMethod(method);
            if (
                !this.handlers.has(prefixedMethod)
                || this.acknowledgedRegistrationMethods.has(prefixedMethod)
                || this.permanentlyRejectedRegistrationMethods.has(prefixedMethod)
            ) {
                continue;
            }
            if (this.publishHandlerRegistration(prefixedMethod)) {
                replayedMethods.push(method);
            }
        }
        return replayedMethods;
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    getInFlightRequestCount(): number {
        return Array.from(this.inFlightRequestCounts.values()).reduce((total, count) => total + count, 0);
    }

    getActiveHandlerExecutions(): readonly RpcHandlerActiveExecution[] {
        const observedAtMs = this.nowMs();
        return Array.from(this.activeHandlerExecutions.values(), (execution) => ({
            method: execution.method,
            activeForMs: Math.max(0, Math.round(observedAtMs - execution.startedAtMs)),
            ...(execution.sessionEffect ? { sessionEffect: execution.sessionEffect } : {}),
        }));
    }

    /** The single planned-restart owner closes admission; existing requests retain their lifetimes. */
    pauseRequestAdmission(methods: readonly string[], refusal: PausedRequestAdmission = {}): () => void {
        const selected = new Set(methods);
        for (const method of selected) this.pausedRequestAdmission.set(method, refusal);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const method of selected) {
                if (this.pausedRequestAdmission.get(method) === refusal) this.pausedRequestAdmission.delete(method);
            }
        };
    }

    private revalidatePausedRequestAdmission(method: string, signal: AbortSignal): Promise<void> | undefined {
        // An unreadable owner cannot reopen admission. The callback releases only
        // its own pause after observing definitive retirement at that owner.
        const pause = this.pausedRequestAdmission.get(method);
        return pause && (pause.wait ?? pause.revalidate)?.(signal).catch(() => undefined);
    }

    /** Includes receiving authorization and cleanup, before/after handler execution. */
    async waitForIdle(signal?: AbortSignal, methods?: readonly string[]): Promise<void> {
        signal?.throwIfAborted();
        const selected = methods ? new Set(methods) : null;
        const busy = () => selected
            ? Array.from(selected).some(method => this.inFlightRequestCounts.has(method))
            : this.inFlightRequestCounts.size > 0;
        if (!busy()) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                this.idleResolvers.delete(onIdle);
                signal?.removeEventListener('abort', onAbort);
            };
            const onIdle = () => { if (!busy()) { cleanup(); resolve(); } };
            const onAbort = () => { cleanup(); reject(signal?.reason); };
            this.idleResolvers.add(onIdle);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
    }

    /** Whether the existing relay has acknowledged this handler's registration. */
    isHandlerRegistrationAcknowledged(method: string): boolean {
        return this.acknowledgedRegistrationMethods.has(this.getPrefixedMethod(method));
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const ownedRegistration = this.ownedHandlerRegistration;
        if (ownedRegistration) {
            if (ownedRegistration.nextMethods.has(method)) {
                return true;
            }
            if (ownedRegistration.previousMethods.has(method)) {
                return false;
            }
        }
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    unregisterHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        const removed = this.handlers.delete(prefixedMethod);
        this.permanentlyRejectedRegistrationMethods.delete(prefixedMethod);
        if (!removed) {
            return false;
        }
        for (const methods of this.ownedHandlerMethodsByOwner.values()) {
            methods.delete(method);
        }
        if (this.socket) {
            this.acknowledgedRegistrationMethods.delete(prefixedMethod);
            this.socket.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method: prefixedMethod });
        }
        return true;
    }

    replaceOwnedHandlers<T>(ownerId: string, register: () => T): T {
        const normalizedOwnerId = ownerId.trim();
        if (!normalizedOwnerId) {
            throw new Error('RPC handler owner id is required');
        }
        if (this.ownedHandlerRegistration) {
            throw new Error(`Nested RPC handler replacement is not supported: ${normalizedOwnerId}`);
        }

        const previousMethods = new Set(this.ownedHandlerMethodsByOwner.get(normalizedOwnerId) ?? []);
        const previousHandlers = new Map<string, RpcHandler>();
        for (const method of previousMethods) {
            const handler = this.handlers.get(this.getPrefixedMethod(method));
            if (handler) {
                previousHandlers.set(method, handler);
            }
        }
        const context: OwnedHandlerRegistrationContext = {
            ownerId: normalizedOwnerId,
            previousMethods,
            nextMethods: new Set(),
        };
        this.ownedHandlerRegistration = context;

        try {
            const result = register();
            this.ownedHandlerMethodsByOwner.set(normalizedOwnerId, context.nextMethods);
            for (const staleMethod of previousMethods) {
                if (!context.nextMethods.has(staleMethod)) {
                    this.unregisterHandler(staleMethod);
                }
            }
            return result;
        } catch (error) {
            for (const nextMethod of context.nextMethods) {
                if (!previousMethods.has(nextMethod)) {
                    this.unregisterHandler(nextMethod);
                }
            }
            for (const [method, handler] of previousHandlers) {
                this.handlers.set(this.getPrefixedMethod(method), handler);
            }
            this.ownedHandlerMethodsByOwner.set(normalizedOwnerId, previousMethods);
            throw error;
        } finally {
            this.ownedHandlerRegistration = null;
        }
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.permanentlyRejectedRegistrationMethods.clear();
        this.acknowledgedRegistrationMethods.clear();
        this.ownedHandlerMethodsByOwner.clear();
        this.logger('Cleared all RPC handlers');
    }

    private encodeResponse(request: RpcRequest, response: unknown, callId: string | null, rpcContent: SocketRpcContent): Promise<unknown> {
        return socketRpcCodec.encodeResponse(
            this.isServerOriginRequest(request) || this.isContentFreeManagedActivityRequest(request) ? { mode: 'plain' } : rpcContent,
            response,
            callId,
        );
    }

    private async encodeTransportResponse(
        request: RpcRequest,
        result: unknown,
        acknowledgement: SocketRpcTransportAcknowledgementV1 | null = null,
        callId: string | null = null,
        rpcContent: SocketRpcContent,
    ): Promise<unknown> {
        const encodedResult = await this.encodeResponse(request, result, callId, rpcContent);
        if (
            request.transportResponseEnvelopeVersion
            !== SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1
        ) {
            return encodedResult;
        }
        return {
            v: SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
            result: encodedResult,
            ...(acknowledgement ? { acknowledgement } : {}),
        };
    }

    private projectAcknowledgement(
        request: RpcRequest,
        params: unknown,
        result: unknown,
        diagnostic: RequestDiagnostic,
    ): SocketRpcTransportAcknowledgementV1 | null {
        if (
            request.transportResponseEnvelopeVersion
            !== SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1
            || !this.projectTransportAcknowledgement
        ) {
            return null;
        }
        try {
            return this.projectTransportAcknowledgement({
                method: request.method,
                params,
                result,
                ...(request.authorization
                    ? { authorization: request.authorization }
                    : {}),
            });
        } catch (error) {
            diagnostic.acknowledgementOutcomeCode = readOutcomeCode(error, true);
            return null;
        }
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }

    private readUnprefixedMethod(method: string): string {
        const prefix = `${this.scopePrefix}:`;
        return method.startsWith(prefix) ? method.slice(prefix.length) : method;
    }

    private beginHandlerExecution(method: string): number {
        const id = this.nextHandlerExecutionId;
        this.nextHandlerExecutionId += 1;
        this.activeHandlerExecutions.set(id, {
            method,
            startedAtMs: this.nowMs(),
        });
        return id;
    }

    private reportSessionEffect(id: number | null, effect: NonNullable<RpcHandlerActiveExecution['sessionEffect']>): void {
        const execution = id === null ? undefined : this.activeHandlerExecutions.get(id);
        if (execution && id !== null) this.activeHandlerExecutions.set(id, {
            ...execution, sessionEffect: Object.freeze({ ...effect }),
        });
    }

    private isContentFreeManagedActivityRequest(request: RpcRequest): boolean {
        if (this.localMachineId !== this.scopePrefix || request.machineAdmission?.machineId !== this.scopePrefix) return false;
        if (request.method === this.getPrefixedMethod(MANAGED_ACTIVITY_READ_RPC_METHOD)) return ManagedActivityReadRequestV1Schema.safeParse(request.params).success;
        return request.method === this.getPrefixedMethod(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD)
            && ManagedAdmissionDrainConfirmRequestV1Schema.safeParse(request.params).success;
    }

    private readServerOriginRpcFamily(request: RpcRequest) {
        return SERVER_ORIGIN_RPC_FAMILIES.find(family => family.methods.some(method => request.method === this.getPrefixedMethod(method)));
    }

    private isServerOriginRequest(request: RpcRequest): boolean {
        const family = this.readServerOriginRpcFamily(request);
        if (!family?.isAuthorization(request.authorization)) return false;
        if (!family.bindsMachineRead) return true;
        return isSocketRpcMachineReadServerOriginAuthorizationContext(request.authorization)
            && request.authorization.machineId === this.scopePrefix
            && this.localMachineId === this.scopePrefix
            && this.authorizeRequest !== undefined;
    }

    private areRegistrationMethodsAcknowledged(methods: ReadonlySet<string>): boolean {
        for (const method of methods) {
            if (!this.acknowledgedRegistrationMethods.has(method)) {
                return false;
            }
        }
        return true;
    }

    private readMissingRegistrationMethods(methods: readonly string[]): readonly string[] {
        return methods.filter((method) => (
            !this.acknowledgedRegistrationMethods.has(this.getPrefixedMethod(method))
        ));
    }

    private settleReadyRegistrationWaiters(): void {
        for (const waiter of Array.from(this.registrationReadinessWaiters)) {
            if (!this.areRegistrationMethodsAcknowledged(waiter.requiredPrefixedMethods)) {
                continue;
            }
            this.registrationReadinessWaiters.delete(waiter);
            clearTimeout(waiter.timeout);
            waiter.resolve({ status: 'ready' });
        }
    }

    private settleRegistrationReadinessWaiters(status: 'disconnected'): void {
        for (const waiter of Array.from(this.registrationReadinessWaiters)) {
            this.registrationReadinessWaiters.delete(waiter);
            clearTimeout(waiter.timeout);
            waiter.resolve({
                status,
                missingMethods: this.readMissingRegistrationMethods(waiter.requiredMethods),
            });
        }
    }

    private beginInFlightRequest(method: string): void {
        this.inFlightRequestCounts.set(method, (this.inFlightRequestCounts.get(method) ?? 0) + 1);
    }

    private finishInFlightRequest(method: string): void {
        const count = this.inFlightRequestCounts.get(method) ?? 0;
        if (count <= 1) this.inFlightRequestCounts.delete(method);
        else this.inFlightRequestCounts.set(method, count - 1);
        if (this.idleResolvers.size > 0) {
            const resolvers = Array.from(this.idleResolvers);
            for (const resolve of resolvers) {
                resolve();
            }
        }
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
