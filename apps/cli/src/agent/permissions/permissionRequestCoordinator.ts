import { NativePermissionChoiceAnswerV1Schema, NativePermissionChoicesV1Schema, type NativePermissionChoiceAnswerV1, type NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { readRunScopedExecutionPermissionRequestIdentity } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { deepEqual } from '@/utils/deterministicJson';
import { logger } from '@/ui/logger';
import { isAgentStructuredQuestionRequest, isDurableAgentStructuredQuestionRequest } from './requestKind';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { SessionQuestionContextV1, SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import type { StructuredQuestionAnswerDetailsV1, StructuredQuestionAnswersV1 } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';
import type {
    AgentStateOutstandingRequest,
    AgentStateRequestCompletion,
    AgentStateRequestApplication,
    AppliedRequestCompletion,
    AgentStateRequestResponseTarget,
    AgentStateResponseTargetDispatch,
    AgentStateRequestCancellation,
    AgentStateQuestionHandlerChange,
    PermissionResponseClaim,
    PermissionResponseClaimAcquisition,
    PermissionResponseClaimRejoin,
    PermissionResponseClaimSettlement,
} from './agentStateRequestStore';
import { isSameAgentStateRequestOccurrence } from './agentStateRequestStore';
import {
    isPermissionRequestOwnedByPlugin,
    isPermissionRequestOwnedByPluginTurn,
    normalizePermissionRequestOwner,
    permissionRequestOwnersEqual,
    type PermissionRequestOwner,
} from './permissionRequestOwner';

export type PermissionRequestCoordinatorRequest = Readonly<{
    nativeChoices?: NativePermissionChoicesV1 | null;
    questionV1?: SessionQuestionContextV1;
    currentHandler?: SessionQuestionHandlerV1;
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt?: number;
    mcpTool?: ResolvedMcpToolIdentityV1;
    /** Host-stamped exact turn identity when this request has mediated source authority. */
    turnId?: string;
    lifetime?: 'turn' | 'occurrence';
    kind?: string;
    source?: string;
    sourceLocalId?: string | null;
    responseTarget?: AgentStateRequestResponseTarget | null;
    subagentRef?: unknown;
    sidechainId?: string | null;
    permissionSuggestions?: readonly unknown[] | null;
    owner?: PermissionRequestOwner | null;
}>;

export type PermissionRequestCoordinatorContext = Readonly<{
    nativeChoices?: NativePermissionChoicesV1 | null;
    questionV1?: SessionQuestionContextV1;
    currentHandler?: SessionQuestionHandlerV1;
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    mcpTool?: ResolvedMcpToolIdentityV1;
    turnId?: string;
    kind?: string;
    source?: string;
    sourceLocalId: string | null;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
    owner?: PermissionRequestOwner;
    correlation: 'record' | 'agent_state';
    status: 'live' | 'detached' | 'agent_state_only';
}>;

export type PermissionRequestCoordinatorCompletedRequest = Readonly<{
    answeredBy?: SessionQuestionHandlerV1;
    structuredAnswersV1?: StructuredQuestionAnswersV1;
    answerDetails?: StructuredQuestionAnswerDetailsV1;
    status: string;
    decision?: string;
    reason?: string;
    mode?: string;
    allowedTools?: readonly string[];
    updatedPermissions?: unknown;
    extraCompletedFields?: Readonly<Record<string, unknown>> | null;
    /** Evaluated by the incumbent AgentState writer immediately before terminal persistence. */
    isCurrent?: () => boolean;
}>;

export type PermissionRequestCoordinatorCompletion<TResult> = Readonly<{
    result: TResult;
    completedRequest: PermissionRequestCoordinatorCompletedRequest;
}>;

export type PermissionRequestCoordinatorStore = Readonly<{
    changeQuestionHandler?(params: AgentStateQuestionHandlerChange): Promise<boolean>;
    publishRequest(params: Readonly<{
        nativeChoices?: NativePermissionChoicesV1 | null;
        questionV1?: SessionQuestionContextV1;
        currentHandler?: SessionQuestionHandlerV1;
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        mcpTool?: ResolvedMcpToolIdentityV1;
        turnId?: string;
        lifetime?: 'turn' | 'occurrence';
        kind?: string;
        source?: string;
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
        owner?: PermissionRequestOwner | null;
    }>): void;
    captureRequestApplication?(requestId: string): AgentStateRequestApplication | null;
    readAppliedCompletion?(params: AgentStateRequestCompletion): AppliedRequestCompletion | null;
    recoverAppliedCompletions?(): Promise<void>;
    completeRequest(params: Readonly<{
        answeredBy?: SessionQuestionHandlerV1;
        structuredAnswersV1?: StructuredQuestionAnswersV1;
        answerDetails?: StructuredQuestionAnswerDetailsV1;
        requestId: string;
        status: string;
        decision?: string;
        reason?: string;
        mode?: string;
        allowedTools?: readonly string[] | undefined;
        updatedPermissions?: unknown;
        extraCompletedFields?: Readonly<Record<string, unknown>> | null;
        isCurrent?: () => boolean;
        applicationAcknowledged?: AgentStateRequestApplication;
        observedRetirement?: true;
        fallback?: Readonly<{
            nativeChoices?: NativePermissionChoicesV1 | null;
            questionV1?: SessionQuestionContextV1;
            currentHandler?: SessionQuestionHandlerV1;
            toolName: string;
            mcpTool?: ResolvedMcpToolIdentityV1;
            toolInput: unknown;
            createdAt: number;
            turnId?: string;
            lifetime?: 'turn' | 'occurrence';
            kind?: string;
            source?: string;
            responseTarget?: AgentStateRequestResponseTarget | null;
            subagentRef?: unknown;
            sidechainId?: string | null;
            permissionSuggestions?: readonly unknown[] | null;
            owner?: PermissionRequestOwner | null;
        }> | null;
    }>): boolean | void | Promise<boolean | void>;
    cancelAllRequests?(params: Readonly<{
        scope?: 'foreground';
        preserveQuestions?: boolean;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): Promise<readonly AgentStateRequestCancellation[]>;
    cancelRequestsByOwner?(params: Readonly<{
        owner: PermissionRequestOwner;
        turnId?: string;
        preserveQuestions?: boolean;
        observedRetirement?: true;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): Promise<readonly AgentStateRequestCancellation[]>;
    hasOutstandingRequest(requestId: string): boolean;
    hasPermissionResponseClaim?(requestId: string): boolean;
    readOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null;
    readCompletedResponseTarget?(requestId: string): AgentStateResponseTargetDispatch | null;
    listOutstandingRequests(): readonly AgentStateOutstandingRequest[];
    acquirePermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<PermissionResponseClaimAcquisition> | PermissionResponseClaimAcquisition;
    rejoinPermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<PermissionResponseClaimRejoin> | PermissionResponseClaimRejoin;
    releasePermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<void> | void;
    readCompletedPermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): PermissionResponseClaimSettlement;
}>;

export type PermissionRequestCoordinatorOptions = Readonly<{
    signal?: AbortSignal;
}>;

type PendingPermissionWaiter<TResult> = {
    id: string;
    resolve: (result: TResult) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abortHandler?: () => void;
    aborted: boolean;
};

type PendingPermissionRequest<TResult> = {
    nativeChoices?: NativePermissionChoicesV1 | null;
    questionV1?: SessionQuestionContextV1;
    currentHandler?: SessionQuestionHandlerV1;
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    turnId?: string;
    lifetime: 'turn' | 'occurrence';
    mcpTool?: ResolvedMcpToolIdentityV1;
    kind?: string;
    source?: string;
    sourceLocalId: string | null;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
    owner?: PermissionRequestOwner;
    status: 'live' | 'detached';
    waiters: Map<string, PendingPermissionWaiter<TResult>>;
    cancelReason: string | null;
    completionPersistence: Promise<boolean> | null;
    observedCompletion?: Readonly<{
        completion: PermissionRequestCoordinatorCompletion<TResult>;
        persistence: Promise<boolean>;
    }>;
};

type CachedPermissionDecision<TResult> = {
    nativeChoices?: NativePermissionChoicesV1 | null;
    result: TResult;
    toolName: string;
    toolInput: unknown;
    lifetime: 'turn' | 'occurrence';
    turnId?: string;
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget;
    owner?: PermissionRequestOwner;
};

export class PermissionRequestCoordinator<TResult> {
    private readonly store: PermissionRequestCoordinatorStore;
    private readonly resolveAutomaticDecision?: (request: PermissionRequestCoordinatorRequest) => PermissionRequestCoordinatorCompletion<TResult> | null;
    private readonly pendingRequests = new Map<string, PendingPermissionRequest<TResult>>();
    private readonly cachedDecisions = new Map<string, CachedPermissionDecision<TResult>>();
    /**
     * Serializes terminal-response admission for one request within this
     * canonical coordinator. It deliberately does not introduce a global
     * lock, durable lease, or another response owner.
     */
    private readonly responseClaims = new Map<string, Promise<void>>();
    private waiterSequence = 0;

    constructor(params: Readonly<{
        store: PermissionRequestCoordinatorStore;
        resolveAutomaticDecision?: (request: PermissionRequestCoordinatorRequest) => PermissionRequestCoordinatorCompletion<TResult> | null;
    }>) {
        this.store = params.store;
        this.resolveAutomaticDecision = params.resolveAutomaticDecision;
    }

    requestDecision(
        request: PermissionRequestCoordinatorRequest,
        options?: PermissionRequestCoordinatorOptions,
    ): Promise<TResult> {
        this.pruneDetachedRecords();

        if (options?.signal?.aborted) {
            return Promise.reject(createPermissionRequestAbortError());
        }

        const automatic = this.resolveAutomaticDecision?.(request);
        if (automatic) {
            return Promise.resolve(this.store.completeRequest({
                requestId: request.requestId,
                ...automatic.completedRequest,
                fallback: { ...request, createdAt: request.createdAt ?? Date.now() },
            })).then((recorded) => {
                if (recorded === false) throw new Error('permission_automatic_decision_not_recorded');
                return automatic.result;
            });
        }

        let entry = this.pendingRequests.get(request.requestId);
        if (entry) {
            if (entry.cancelReason) {
                return Promise.reject(createPermissionRequestAbortError(entry.cancelReason));
            }
            if (!isCompatiblePendingRequest(entry, request)) {
                return Promise.reject(
                    new Error(`Permission request ${request.requestId} is already pending with different owner or tool input`),
                );
            }
            if (entry.completionPersistence && entry.waiters.size === 0) {
                return Promise.reject(createPermissionRequestAbortError());
            }
            this.updateNativeChoices(entry, request);
            entry.status = 'live';
            return this.attachWaiter(entry, options?.signal);
        }

        const cached = this.cachedDecisions.get(request.requestId);
        if (cached) {
            this.cachedDecisions.delete(request.requestId);
            if (isCompatibleCachedDecision(cached, request)) {
                return Promise.resolve(cached.result);
            }
        }

        const outstanding = this.store.readOutstandingRequest(request.requestId);
        if (outstanding) {
            // A reload must rejoin the durable request, not republish a new
            // projection over it. In particular, a source-mediated request is
            // addressed by its host-stamped turn as well as its request ID.
            if (!isCompatibleOutstandingRequest(outstanding, request)) {
                return Promise.reject(
                    new Error(`Permission request ${request.requestId} has incompatible durable custody`),
                );
            }
            entry = createPendingRequestFromOutstanding<TResult>(outstanding, request.lifetime);
            this.updateNativeChoices(entry, request);
            this.pendingRequests.set(request.requestId, entry);
            return this.attachWaiter(entry, options?.signal);
        }

        const owner = normalizePermissionRequestOwner(request.owner);
        entry = {
            requestId: request.requestId,
            toolName: request.toolName,
            ...(typeof request.nativeChoices !== 'undefined' ? { nativeChoices: request.nativeChoices } : {}),
            toolInput: request.toolInput,
            createdAt: request.createdAt ?? Date.now(),
            ...(request.questionV1 ? { questionV1: request.questionV1 } : {}),
            ...(request.currentHandler ? { currentHandler: request.currentHandler } : {}),
            ...(request.mcpTool ? { mcpTool: request.mcpTool } : {}),
            lifetime: request.lifetime ?? 'turn',
            ...(typeof request.turnId === 'string' ? { turnId: request.turnId } : {}),
            ...(typeof request.kind === 'string' ? { kind: request.kind } : {}),
            ...(typeof request.source === 'string' ? { source: request.source } : {}),
            sourceLocalId: request.sourceLocalId ?? null,
            ...(request.responseTarget ? { responseTarget: request.responseTarget } : {}),
            ...(typeof request.subagentRef !== 'undefined' ? { subagentRef: request.subagentRef } : {}),
            ...(typeof request.sidechainId === 'string' ? { sidechainId: request.sidechainId } : {}),
            ...(Array.isArray(request.permissionSuggestions)
                ? { permissionSuggestions: [...request.permissionSuggestions] }
                : {}),
            ...(owner ? { owner } : {}),
            status: 'live',
            waiters: new Map(),
            cancelReason: null,
            completionPersistence: null,
        };

        this.pendingRequests.set(request.requestId, entry);
        try {
            this.store.publishRequest({
                requestId: entry.requestId,
                toolName: entry.toolName,
                ...(typeof entry.nativeChoices !== 'undefined' ? { nativeChoices: entry.nativeChoices } : {}),
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
                ...(entry.questionV1 ? { questionV1: entry.questionV1 } : {}),
                ...(entry.currentHandler ? { currentHandler: entry.currentHandler } : {}),
                ...(entry.mcpTool ? { mcpTool: entry.mcpTool } : {}),
                ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                ...(entry.lifetime === 'occurrence' ? { lifetime: entry.lifetime } : {}),
                ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                ...(entry.responseTarget ? { responseTarget: entry.responseTarget } : {}),
                ...(typeof entry.subagentRef !== 'undefined' ? { subagentRef: entry.subagentRef } : {}),
                ...(typeof entry.sidechainId === 'string' ? { sidechainId: entry.sidechainId } : {}),
                ...(typeof entry.permissionSuggestions !== 'undefined' ? { permissionSuggestions: entry.permissionSuggestions } : {}),
                ...(entry.owner ? { owner: entry.owner } : {}),
            });
        } catch (error) {
            if (this.pendingRequests.get(request.requestId) === entry) this.pendingRequests.delete(request.requestId);
            throw error;
        }

        return this.attachWaiter(entry, options?.signal);
    }

    private updateNativeChoices(entry: PendingPermissionRequest<TResult>, request: PermissionRequestCoordinatorRequest): void {
        if (request.nativeChoices === undefined || deepEqual(entry.nativeChoices, request.nativeChoices)) return;
        this.store.publishRequest({ ...request, createdAt: entry.createdAt });
        entry.nativeChoices = request.nativeChoices;
    }

    getResponseContext(requestId: string): PermissionRequestCoordinatorContext | null {
        this.pruneDetachedRecords();

        const entry = this.pendingRequests.get(requestId);
        if (entry) {
            if (entry.cancelReason) return null;
            if (entry.status === 'detached') return null;
            // The last caller has withdrawn while terminal persistence is pending.
            // Preserve an existing first-answer claim, which that persistence cannot cancel.
            if (entry.completionPersistence && entry.waiters.size === 0
                && this.store.hasPermissionResponseClaim?.(requestId) !== true) return null;
            const persisted = this.store.readOutstandingRequest(requestId);
            const nativeChoices = persisted?.nativeChoices !== undefined ? persisted.nativeChoices : entry.nativeChoices;
            return {
                requestId,
                toolName: entry.toolName,
                ...(typeof nativeChoices !== 'undefined' ? { nativeChoices } : {}),
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
                ...(entry.questionV1 ? { questionV1: entry.questionV1 } : {}),
                ...(entry.currentHandler ? { currentHandler: entry.currentHandler } : {}),
                ...(entry.mcpTool ? { mcpTool: entry.mcpTool } : {}),
                ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                ...(entry.responseTarget ? { responseTarget: entry.responseTarget } : {}),
                ...(typeof entry.subagentRef !== 'undefined' ? { subagentRef: entry.subagentRef } : {}),
                ...(typeof entry.sidechainId === 'string' ? { sidechainId: entry.sidechainId } : {}),
                ...(Array.isArray(entry.permissionSuggestions)
                    ? { permissionSuggestions: [...entry.permissionSuggestions] }
                    : {}),
                ...(entry.owner ? { owner: entry.owner } : {}),
                sourceLocalId: entry.sourceLocalId,
                correlation: 'record',
                status: entry.status,
            };
        }

        const outstanding = this.store.readOutstandingRequest(requestId);
        if (!outstanding) return null;

        return {
            requestId,
            toolName: outstanding.toolName,
            ...(typeof outstanding.nativeChoices !== 'undefined' ? { nativeChoices: outstanding.nativeChoices } : {}),
            toolInput: outstanding.toolInput,
            createdAt: outstanding.createdAt,
            ...(outstanding.questionV1 ? { questionV1: outstanding.questionV1 } : {}),
            ...(outstanding.currentHandler ? { currentHandler: outstanding.currentHandler } : {}),
            ...(outstanding.mcpTool ? { mcpTool: outstanding.mcpTool } : {}),
            ...(typeof outstanding.turnId === 'string' ? { turnId: outstanding.turnId } : {}),
            ...(typeof outstanding.kind === 'string' ? { kind: outstanding.kind } : {}),
            ...(typeof outstanding.source === 'string' ? { source: outstanding.source } : {}),
            ...(outstanding.responseTarget ? { responseTarget: outstanding.responseTarget } : {}),
            ...(typeof outstanding.subagentRef !== 'undefined' ? { subagentRef: outstanding.subagentRef } : {}),
            ...(typeof outstanding.sidechainId === 'string' ? { sidechainId: outstanding.sidechainId } : {}),
            ...(Array.isArray(outstanding.permissionSuggestions)
                ? { permissionSuggestions: [...outstanding.permissionSuggestions] }
                : {}),
            ...(outstanding.owner ? { owner: outstanding.owner } : {}),
            sourceLocalId: null,
            correlation: 'agent_state',
            status: 'agent_state_only',
        };
    }

    listResponseContexts(): readonly PermissionRequestCoordinatorContext[] {
        this.pruneDetachedRecords();
        const requestIds = new Set<string>(this.pendingRequests.keys());
        for (const outstanding of this.store.listOutstandingRequests()) {
            requestIds.add(outstanding.requestId);
        }
        const contexts: PermissionRequestCoordinatorContext[] = [];
        for (const requestId of requestIds) {
            const context = this.getResponseContext(requestId);
            if (context) contexts.push(context);
        }
        return contexts;
    }

    /** The answer owner holds withResponseClaim while admitting and passing up. */
    async changeQuestionHandler(params: AgentStateQuestionHandlerChange): Promise<boolean> {
        const entry = this.pendingRequests.get(params.requestId);
        if (entry?.cancelReason || entry?.completionPersistence) return false;
        const changed = await this.store.changeQuestionHandler?.(params) ?? false;
        if (changed && entry) {
            entry.currentHandler = this.store.readOutstandingRequest(params.requestId)?.currentHandler ?? params.currentHandler;
        }
        return changed;
    }

    async withResponseClaim<T>(
        requestId: string,
        work: () => Promise<T> | T,
    ): Promise<T> {
        const preceding = this.responseClaims.get(requestId) ?? Promise.resolve();
        let resolveHeld: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            resolveHeld = resolve;
        });
        const release = () => resolveHeld?.();
        const claim = preceding.then(() => held);
        this.responseClaims.set(requestId, claim);

        await preceding;
        try {
            return await work();
        } finally {
            release();
            if (this.responseClaims.get(requestId) === claim) {
                this.responseClaims.delete(requestId);
            }
        }
    }

    async acquireResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<PermissionResponseClaimAcquisition> {
        return await this.store.acquirePermissionResponseClaim(params);
    }

    async rejoinResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<PermissionResponseClaimRejoin> {
        return await this.store.rejoinPermissionResponseClaim(params);
    }

    async releaseResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<void> {
        await this.store.releasePermissionResponseClaim(params);
    }

    readCompletedResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): PermissionResponseClaimSettlement {
        return this.store.readCompletedPermissionResponseClaim(params);
    }

    async handleResponse(params: Readonly<{
        requestId: string;
        buildCompletion: (context: PermissionRequestCoordinatorContext) => PermissionRequestCoordinatorCompletion<TResult>;
    }>): Promise<boolean> {
        const context = this.getResponseContext(params.requestId);
        if (!context) return false;

        return this.completeResponse({
            context,
            completion: params.buildCompletion(context),
        });
    }

    /** Native application is already observed, including while an app ACK awaits that fact. */
    async completeObservedResponse(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
    }>): Promise<boolean> {
        const { context, completion } = params;
        const entry = this.pendingRequests.get(context.requestId);
        if (!entry || entry.cancelReason || entry.observedCompletion) return false;
        const application = this.store.captureRequestApplication?.(context.requestId);
        if (!application || !isSameAgentStateRequestOccurrence(application.pending, {
            ...entry, tool: entry.toolName, arguments: entry.toolInput,
        })) return false;
        const persistence = Promise.resolve(this.store.completeRequest({
            requestId: context.requestId,
            ...completion.completedRequest,
            applicationAcknowledged: application,
        })).then(saved => saved !== false);
        entry.observedCompletion = { completion, persistence: this.observeAppliedCompletion(entry, completion) ?? persistence };
        const saved = await persistence;
        if (saved && this.pendingRequests.get(context.requestId) === entry) {
            this.settleCompletedEntry(entry, completion.result);
        }
        return saved;
    }

    async completeResponse(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
        acknowledgeDecisionApplication?: (result: TResult) => Promise<void>;
    }>): Promise<boolean> {
        const { context, completion } = params;
        const entry = this.pendingRequests.get(context.requestId);
        if (entry) {
            if (entry.cancelReason) return false;
            if (entry.completionPersistence) return false;

            const precedingPersistence = entry.completionPersistence ?? Promise.resolve(true);
            const completionPersistence = precedingPersistence.then(async () => {
                // Application belongs to the same settlement admission as persistence.
                // A stale app row must not apply a decision after cancellation has begun.
                const retained = this.store.readAppliedCompletion?.({ requestId: entry.requestId,
                    ...completion.completedRequest });
                if (retained) {
                    if (!retained.matches) return false;
                    await this.store.recoverAppliedCompletions?.();
                    return await retained.acknowledgement;
                }
                if (entry.cancelReason || (completion.completedRequest.isCurrent && !completion.completedRequest.isCurrent())) return false;
                const application = params.acknowledgeDecisionApplication
                    ? this.store.captureRequestApplication?.(entry.requestId) : null;
                if (params.acknowledgeDecisionApplication && this.store.captureRequestApplication && !application) return false;
                if (params.acknowledgeDecisionApplication) {
                    await params.acknowledgeDecisionApplication(completion.result);
                }
                // The native result can settle during the callback. Never replace its actual
                // answer with the app's requested answer, even when that callback succeeds.
                if (entry.observedCompletion) {
                    const observed = entry.observedCompletion;
                    return await observed.persistence
                        && deepEqual(observed.completion.result, completion.result);
                }
                const persistence = this.store.completeRequest({
                    requestId: entry.requestId,
                    ...completion.completedRequest,
                    ...(application ? { applicationAcknowledged: application } : {}),
                    fallback: {
                        toolName: entry.toolName,
                        ...(typeof entry.nativeChoices !== 'undefined' ? { nativeChoices: entry.nativeChoices } : {}),
                        toolInput: entry.toolInput,
                        createdAt: entry.createdAt,
                        ...(entry.questionV1 ? { questionV1: entry.questionV1 } : {}),
                        ...(entry.currentHandler ? { currentHandler: entry.currentHandler } : {}),
                        ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                        lifetime: entry.lifetime,
                        ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                        ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                        ...(entry.responseTarget ? { responseTarget: entry.responseTarget } : {}),
                        ...(typeof entry.subagentRef !== 'undefined' ? { subagentRef: entry.subagentRef } : {}),
                        ...(typeof entry.sidechainId === 'string' ? { sidechainId: entry.sidechainId } : {}),
                        ...(typeof entry.permissionSuggestions !== 'undefined'
                            ? { permissionSuggestions: entry.permissionSuggestions }
                            : {}),
                        ...(entry.owner ? { owner: entry.owner } : {}),
                    },
                });
                this.observeAppliedCompletion(entry, completion);
                const persisted = await persistence;
                if (application && persisted === false) this.retireAppliedEntry(entry);
                if (persisted !== false) return true;
                // Response targets arrive after the store's terminal write. Rejoin
                // that exact completed subject rather than persisting it again.
                const delivered = this.store.readCompletedResponseTarget?.(entry.requestId);
                if (!delivered || !entry.responseTarget) return false;
                const completed = delivered.completedRequest;
                const expected = completion.completedRequest;
                return (!expected.isCurrent || expected.isCurrent())
                    && delivered.requestId === entry.requestId
                    && deepEqual(delivered.responseTarget, entry.responseTarget)
                    && completed.tool === entry.toolName
                    && deepEqual(completed.arguments, entry.toolInput)
                    && completed.createdAt === entry.createdAt
                    && completed.turnId === entry.turnId
                    && completed.source === entry.source
                    && deepEqual(completed.owner ?? null, entry.owner ?? null)
                    && completed.status === expected.status
                    && completed.decision === expected.decision
                    && completed.mode === expected.mode
                    && deepEqual(completed.allowedTools, expected.allowedTools)
                    && deepEqual(completed.updatedPermissions, expected.updatedPermissions)
                    && Object.entries(expected.extraCompletedFields ?? {}).every(
                        ([key, value]) => deepEqual(completed[key], value),
                    );
            });
            entry.completionPersistence = completionPersistence;
            let didComplete = false;
            try {
                didComplete = await completionPersistence;
            } finally {
                if (entry.completionPersistence === completionPersistence) {
                    entry.completionPersistence = null;
                }
            }

            if (!didComplete || entry.cancelReason) return false;

            if (this.pendingRequests.get(entry.requestId) === entry) {
                this.settleCompletedEntry(entry, completion.result);
            }

            return true;
        }

        if (!this.store.hasOutstandingRequest(context.requestId)) return false;

        const retained = this.store.readAppliedCompletion?.({ requestId: context.requestId,
            ...completion.completedRequest });
        if (retained) {
            if (!retained.matches) return false;
            await this.store.recoverAppliedCompletions?.();
            return await retained.acknowledgement;
        }
        const application = params.acknowledgeDecisionApplication
            ? this.store.captureRequestApplication?.(context.requestId) : null;
        if (params.acknowledgeDecisionApplication && this.store.captureRequestApplication && !application) return false;
        if (params.acknowledgeDecisionApplication) {
            await params.acknowledgeDecisionApplication(completion.result);
        }
        const persisted = await this.store.completeRequest({
            requestId: context.requestId,
            ...completion.completedRequest,
            ...(application ? { applicationAcknowledged: application } : {}),
        });
        return persisted !== false;
    }

    private observeAppliedCompletion(
        entry: PendingPermissionRequest<TResult>,
        completion: PermissionRequestCoordinatorCompletion<TResult>,
    ): Promise<boolean> | undefined {
        const applied = this.store.readAppliedCompletion?.({ requestId: entry.requestId,
            ...completion.completedRequest });
        if (!applied) return undefined;
        void applied.acknowledgement.then((saved) => {
            if (this.pendingRequests.get(entry.requestId) !== entry) return;
            if (saved && !entry.cancelReason) this.settleCompletedEntry(entry, completion.result);
            else this.retireAppliedEntry(entry);
        });
        return applied.acknowledgement;
    }

    private retireAppliedEntry(entry: PendingPermissionRequest<TResult>): void {
        if (this.pendingRequests.get(entry.requestId) !== entry) return;
        this.pendingRequests.delete(entry.requestId);
        for (const waiter of entry.waiters.values()) {
            rejectWaiter(waiter, createPermissionRequestAbortError('Applied request retired'));
        }
        entry.waiters.clear();
    }

    private settleCompletedEntry(entry: PendingPermissionRequest<TResult>, result: TResult): void {
        const waiters = [...entry.waiters.values()];
        const hasLiveWaiters = waiters.some((waiter) => !waiter.aborted);
        entry.waiters.clear();
        this.pendingRequests.delete(entry.requestId);
        if (!hasLiveWaiters && !entry.owner) {
            this.cachedDecisions.set(entry.requestId, {
                result: result,
                toolName: entry.toolName,
                ...(typeof entry.nativeChoices !== 'undefined' ? { nativeChoices: entry.nativeChoices } : {}),
                toolInput: entry.toolInput,
                lifetime: entry.lifetime,
                ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                ...(entry.responseTarget ? { responseTarget: entry.responseTarget } : {}),
                ...(entry.owner ? { owner: entry.owner } : {}),
            });
        }

        for (const waiter of waiters) {
            if (waiter.aborted) continue;
            detachWaiter(waiter);
            waiter.resolve(result);
        }

    }


    cancelRequest(requestId: string, reason: string): void {
        this.cachedDecisions.delete(requestId);
        const entry = this.pendingRequests.get(requestId);
        if (!entry) return;

        this.pendingRequests.delete(requestId);
        for (const waiter of entry.waiters.values()) {
            rejectWaiter(waiter, createPermissionRequestAbortError(reason));
        }
        entry.waiters.clear();
    }

    async cancelRequests(requestIds: readonly string[], reason: string): Promise<void> {
        const uniqueRequestIds = [...new Set(requestIds)];
        const cachedDecisions = uniqueRequestIds.map((requestId) => [requestId, this.cachedDecisions.get(requestId)] as const);
        const entries = uniqueRequestIds
            .map((requestId) => this.pendingRequests.get(requestId) ?? null)
            .filter((entry): entry is PendingPermissionRequest<TResult> => entry !== null);
        const entriesByRequestId = new Map(entries.map((entry) => [entry.requestId, entry]));
        await this.cancelEntries({
            entries,
            reason,
            persist: async (ids) => {
                await Promise.all(ids.map(async (requestId) => {
                    const entry = entriesByRequestId.get(requestId);
                    if (!entry) return;
                    await this.store.completeRequest({
                        requestId,
                        status: 'canceled',
                        decision: 'abort',
                        reason,
                        fallback: {
                            toolName: entry.toolName,
                            ...(typeof entry.nativeChoices !== 'undefined' ? { nativeChoices: entry.nativeChoices } : {}),
                            toolInput: entry.toolInput,
                            createdAt: entry.createdAt,
                            ...(entry.questionV1 ? { questionV1: entry.questionV1 } : {}),
                            ...(entry.currentHandler ? { currentHandler: entry.currentHandler } : {}),
                            ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                            lifetime: entry.lifetime,
                            ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                            ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                            ...(entry.responseTarget ? { responseTarget: entry.responseTarget } : {}),
                            ...(typeof entry.subagentRef !== 'undefined' ? { subagentRef: entry.subagentRef } : {}),
                            ...(typeof entry.sidechainId === 'string' ? { sidechainId: entry.sidechainId } : {}),
                            ...(typeof entry.permissionSuggestions !== 'undefined'
                                ? { permissionSuggestions: entry.permissionSuggestions }
                                : {}),
                            ...(entry.owner ? { owner: entry.owner } : {}),
                        },
                    });
                }));
            },
        });
        for (const [requestId, cached] of cachedDecisions) {
            if (cached && this.cachedDecisions.get(requestId) === cached) this.cachedDecisions.delete(requestId);
        }
    }

    async cancelAll(reason: string, options?: Readonly<{ scope?: 'foreground'; preserveQuestions?: boolean }>): Promise<void> {
        const isSelected = (requestId: string) => options?.scope !== 'foreground'
            || !readRunScopedExecutionPermissionRequestIdentity(requestId);
        const selectedEntries = [...this.pendingRequests.values()].filter(entry => isSelected(entry.requestId));
        const entries = selectedEntries.filter(entry => !options?.preserveQuestions || !isDurableAgentStructuredQuestionRequest(entry));
        const cachedDecisions = [...this.cachedDecisions.entries()].filter(([requestId]) => isSelected(requestId));
        // The Session store may hold requests without coordinator-local waiters.
        await this.cancelEntries({
            entries,
            reason,
            persist: async (requestIds) => await this.store.cancelAllRequests?.({
                ...(options?.scope ? { scope: options.scope } : {}),
                ...(options?.preserveQuestions ? { preserveQuestions: true } : {}),
                reason,
                decision: 'abort',
                requestIds,
            }),
        });
        if (options?.preserveQuestions) {
            for (const entry of selectedEntries) {
                if (isDurableAgentStructuredQuestionRequest(entry)) this.cancelRequest(entry.requestId, reason);
            }
        }
        for (const [requestId, cached] of cachedDecisions) {
            if (this.cachedDecisions.get(requestId) === cached) this.cachedDecisions.delete(requestId);
        }
    }

    async cancelByPluginTurn(pluginId: string, turnId: string, reason: string): Promise<void> {
        const normalizedPluginId = pluginId.trim();
        if (!normalizedPluginId || !turnId.trim()) return;
        const entries = [...this.pendingRequests.values()]
            .filter((entry) => !isAgentStructuredQuestionRequest(entry)
                && isPermissionRequestOwnedByPluginTurn(entry, normalizedPluginId, turnId));
        if (entries.length > 0 || this.store.listOutstandingRequests().some(
            entry => !isAgentStructuredQuestionRequest(entry)
                && isPermissionRequestOwnedByPluginTurn(entry, normalizedPluginId, turnId),
        )) {
            await this.cancelEntries({ entries, reason,
                persist: async requestIds => await this.store.cancelRequestsByOwner?.({
                    owner: { kind: 'plugin', pluginId: normalizedPluginId }, turnId,
                    preserveQuestions: true, reason, decision: 'abort', requestIds,
                    ...(entries.length === 0 ? { observedRetirement: true } : {}),
                }),
            });
        }
        for (const entry of this.pendingRequests.values()) {
            if (isDurableAgentStructuredQuestionRequest(entry)
                && isPermissionRequestOwnedByPlugin(entry.owner, normalizedPluginId)
                && (entry.turnId === undefined || entry.turnId === turnId)) this.cancelRequest(entry.requestId, reason);
        }
    }

    async cancelByPlugin(pluginId: string, reason: string): Promise<void> {
        const normalizedPluginId = pluginId.trim();
        if (!normalizedPluginId) return;
        const allOwnedEntries = [...this.pendingRequests.values()].filter(
            (entry) => isPermissionRequestOwnedByPlugin(entry.owner, normalizedPluginId),
        );
        const ownedEntries = allOwnedEntries.filter(entry => !isDurableAgentStructuredQuestionRequest(entry));
        if (ownedEntries.length > 0 || this.store.listOutstandingRequests().some(
            entry => isPermissionRequestOwnedByPlugin(entry.owner, normalizedPluginId),
        )) {
            await this.cancelEntries({
                entries: ownedEntries,
                reason,
                persist: async (requestIds) => await this.store.cancelRequestsByOwner?.({
                    owner: { kind: 'plugin', pluginId: normalizedPluginId },
                    preserveQuestions: true,
                    reason,
                    decision: 'abort',
                    requestIds,
                    ...(ownedEntries.length === 0 ? { observedRetirement: true } : {}),
                }),
            });
        }
        for (const entry of allOwnedEntries) {
            if (isDurableAgentStructuredQuestionRequest(entry)) this.cancelRequest(entry.requestId, reason);
        }
    }

    private async cancelEntries(params: Readonly<{
        entries: readonly PendingPermissionRequest<TResult>[];
        reason: string;
        persist: (requestIds: readonly string[]) => Promise<readonly AgentStateRequestCancellation[] | void>;
    }>): Promise<void> {
        const entriesToRetire = new Set(params.entries);
        const markedEntries = params.entries.filter(
            (entry) => !entry.cancelReason,
        );
        for (const entry of markedEntries) {
            entry.cancelReason = params.reason;
        }

        try {
            const inFlightPersistence = params.entries
                .map((entry) => entry.completionPersistence)
                .filter((persistence): persistence is Promise<boolean> => persistence !== null);
            if (inFlightPersistence.length > 0) {
                const outcomes = await Promise.allSettled(inFlightPersistence);
                const failure = outcomes.find((outcome) => outcome.status === 'rejected');
                if (failure && failure.status === 'rejected') throw failure.reason;
            }
            const canceled = await params.persist(markedEntries.map((entry) => entry.requestId));
            // Whole-Session/plugin selection belongs to the store. It may have
            // selected a request published while an older completion drained.
            for (const subject of canceled ?? []) {
                const entry = this.pendingRequests.get(subject.requestId);
                if (entry && isSameAgentStateRequestOccurrence(subject.completedRequest, {
                    ...entry,
                    tool: entry.toolName,
                    arguments: entry.toolInput,
                })) entriesToRetire.add(entry);
            }
        } catch (error) {
            for (const entry of markedEntries) {
                if (
                    this.pendingRequests.get(entry.requestId) === entry
                    && entry.cancelReason === params.reason
                ) {
                    entry.cancelReason = null;
                }
            }
            throw error;
        }

        for (const entry of entriesToRetire) {
            if (this.pendingRequests.get(entry.requestId) !== entry) continue;
            if (this.store.hasOutstandingRequest(entry.requestId)) {
                if (entry.cancelReason === params.reason) entry.cancelReason = null;
                entry.status = entry.waiters.size > 0 ? 'live' : 'detached';
                continue;
            }
            for (const waiter of entry.waiters.values()) {
                rejectWaiter(waiter, createPermissionRequestAbortError(params.reason));
            }
            entry.waiters.clear();
            this.pendingRequests.delete(entry.requestId);
        }
    }

    async reset(): Promise<void> {
        await this.cancelAll('Permission coordinator reset', { preserveQuestions: true });
    }

    async dispose(): Promise<void> {
        await this.cancelAll('Permission coordinator disposed', { preserveQuestions: true });
    }

    private attachWaiter(entry: PendingPermissionRequest<TResult>, signal: AbortSignal | undefined): Promise<TResult> {
        return new Promise<TResult>((resolve, reject) => {
            const waiter: PendingPermissionWaiter<TResult> = {
                id: `waiter-${++this.waiterSequence}`,
                resolve,
                reject,
                signal,
                aborted: false,
            };

            waiter.abortHandler = () => {
                this.abortWaiter(entry, waiter);
            };

            entry.waiters.set(waiter.id, waiter);

            if (signal) {
                if (signal.aborted) {
                    this.abortWaiter(entry, waiter);
                    return;
                }
                signal.addEventListener('abort', waiter.abortHandler, { once: true });
            }
        });
    }

    private abortWaiter(entry: PendingPermissionRequest<TResult>, waiter: PendingPermissionWaiter<TResult>): void {
        if (waiter.aborted) return;
        entry.waiters.delete(waiter.id);

        if (entry.waiters.size > 0) {
            rejectWaiter(waiter, createPermissionRequestAbortError());
            entry.status = 'live';
            return;
        }

        if (isDurableAgentStructuredQuestionRequest(entry)) {
            // The native waiter belongs to this runtime; its question belongs
            // to the durable Session and remains answerable after replacement.
            rejectWaiter(waiter, createPermissionRequestAbortError());
            this.cancelRequest(entry.requestId, 'Permission request detached');
            return;
        }

        if (
            entry.completionPersistence
            || entry.observedCompletion
            || this.store.hasPermissionResponseClaim?.(entry.requestId) === true
        ) {
            rejectWaiter(waiter, createPermissionRequestAbortError());
            return;
        }

        this.cancelRequestAfterLastWaiterAbort(entry, waiter);
    }

    private cancelRequestAfterLastWaiterAbort(
        entry: PendingPermissionRequest<TResult>,
        waiter: PendingPermissionWaiter<TResult>,
    ): void {
        const error = createPermissionRequestAbortError();
        waiter.aborted = true;
        detachWaiter(waiter);

        // The Agent State terminal mutation atomically keeps an outstanding
        // first-answer claim intact. Do not set a local cancellation marker
        // before that mutation: a remote CAS owner may otherwise observe the
        // marker after its row commits and lose its ordinary projection.
        const cancellationPersistence = Promise.resolve(this.store.completeRequest({
            requestId: entry.requestId,
            status: 'canceled',
            observedRetirement: true,
            decision: 'abort',
            reason: error.message,
            fallback: {
                toolName: entry.toolName,
                ...(entry.mcpTool ? { mcpTool: entry.mcpTool } : {}),
                ...(typeof entry.nativeChoices !== 'undefined' ? { nativeChoices: entry.nativeChoices } : {}),
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
                ...(entry.questionV1 ? { questionV1: entry.questionV1 } : {}),
                ...(entry.currentHandler ? { currentHandler: entry.currentHandler } : {}),
                ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                lifetime: entry.lifetime,
                ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                ...(entry.responseTarget ? { responseTarget: entry.responseTarget } : {}),
                ...(typeof entry.subagentRef !== 'undefined' ? { subagentRef: entry.subagentRef } : {}),
                ...(typeof entry.sidechainId === 'string' ? { sidechainId: entry.sidechainId } : {}),
                ...(typeof entry.permissionSuggestions !== 'undefined'
                    ? { permissionSuggestions: entry.permissionSuggestions }
                    : {}),
                owner: entry.owner,
            },
        })).then((didCancel) => didCancel !== false);
        entry.completionPersistence = cancellationPersistence;
        void cancellationPersistence.then(
            (didCancel) => {
                if (entry.completionPersistence === cancellationPersistence) {
                    entry.completionPersistence = null;
                }
                if (
                    this.pendingRequests.get(entry.requestId) === entry
                    && !didCancel
                    && this.store.hasOutstandingRequest(entry.requestId)
                ) {
                    entry.status = 'detached';
                } else if (this.pendingRequests.get(entry.requestId) === entry) {
                    this.pendingRequests.delete(entry.requestId);
                }
                waiter.reject(error);
            },
            (persistenceError: unknown) => {
                if (entry.completionPersistence === cancellationPersistence) {
                    entry.completionPersistence = null;
                }
                if (this.pendingRequests.get(entry.requestId) === entry) {
                    entry.status = 'detached';
                }
                logger.infoFile('[Permissions] Final waiter cancellation persistence failed', {
                    event: 'permission_request_cancellation_persistence_failed',
                    errorName: persistenceError instanceof Error ? persistenceError.name : typeof persistenceError,
                });
                waiter.reject(persistenceError instanceof Error ? persistenceError : error);
            },
        );
    }

    private pruneDetachedRecords(): void {
        for (const [requestId, entry] of this.pendingRequests) {
            if (entry.status !== 'detached') continue;
            if (this.store.hasOutstandingRequest(requestId)) continue;
            this.pendingRequests.delete(requestId);
        }
    }
}

export function createPermissionRequestCoordinator<TResult>(
    params: ConstructorParameters<typeof PermissionRequestCoordinator<TResult>>[0],
): PermissionRequestCoordinator<TResult> {
    return new PermissionRequestCoordinator<TResult>(params);
}

function isCompatibleCachedDecision<TResult>(
    cached: CachedPermissionDecision<TResult>,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return cached.toolName === request.toolName
        && cached.lifetime === (request.lifetime ?? 'turn')
        && deepEqual(cached.toolInput, request.toolInput)
        && deepEqual(cached.nativeChoices, request.nativeChoices)
        && deepEqual(cached.responseTarget ?? null, request.responseTarget ?? null)
        && turnIdsEqual(cached.turnId, request.turnId)
        && permissionSourcesEqual(cached.source, request.source)
        && permissionOwnersEqual(cached.owner, normalizePermissionRequestOwner(request.owner));
}

function isCompatiblePendingRequest<TResult>(
    entry: PendingPermissionRequest<TResult>,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return entry.toolName === request.toolName
        && entry.lifetime === (request.lifetime ?? 'turn')
        && deepEqual(entry.toolInput, request.toolInput)
        && deepEqual(entry.responseTarget ?? null, request.responseTarget ?? null)
        && turnIdsEqual(entry.turnId, request.turnId)
        && permissionSourcesEqual(entry.source, request.source)
        && permissionOwnersEqual(entry.owner, normalizePermissionRequestOwner(request.owner));
}

/**
 * A reloaded coordinator may attach a new in-memory waiter only to the exact
 * outstanding AgentState request. It must not republish incoming values over
 * durable custody: `createdAt`, kind, source, owner, and turn provenance are
 * all read from the persisted row after this comparison succeeds.
 */
function isCompatibleOutstandingRequest(
    outstanding: AgentStateOutstandingRequest,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    if (
        outstanding.toolName !== request.toolName
        || !deepEqual(outstanding.toolInput, request.toolInput)
        || !deepEqual(outstanding.responseTarget ?? null, request.responseTarget ?? null)
        || !permissionSourcesEqual(outstanding.source, request.source)
        || (outstanding.lifetime !== undefined && outstanding.lifetime !== (request.lifetime ?? 'turn'))
        || !permissionOwnersEqual(outstanding.owner, normalizePermissionRequestOwner(request.owner))
    ) {
        return false;
    }

    // Historical rows without a turn stay local-only and cannot enter the
    // remote projection. Once either side declares turn custody, however, a
    // reload must prove the exact same host turn rather than infer one.
    if (!requiresExactTurnCustody(outstanding, request)) return true;
    return typeof outstanding.turnId === 'string'
        && typeof request.turnId === 'string'
        && outstanding.turnId === request.turnId;
}

function requiresExactTurnCustody(
    outstanding: AgentStateOutstandingRequest,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return typeof outstanding.turnId === 'string' || typeof request.turnId === 'string';
}

function createPendingRequestFromOutstanding<TResult>(
    outstanding: AgentStateOutstandingRequest,
    lifetime: 'turn' | 'occurrence' = 'turn',
): PendingPermissionRequest<TResult> {
    return {
        requestId: outstanding.requestId,
        toolName: outstanding.toolName,
        ...(outstanding.mcpTool ? { mcpTool: outstanding.mcpTool } : {}),
        ...(typeof outstanding.nativeChoices !== 'undefined' ? { nativeChoices: outstanding.nativeChoices } : {}),
        toolInput: outstanding.toolInput,
        createdAt: outstanding.createdAt,
        ...(outstanding.questionV1 ? { questionV1: outstanding.questionV1 } : {}),
        ...(outstanding.currentHandler ? { currentHandler: outstanding.currentHandler } : {}),
        lifetime: outstanding.lifetime ?? lifetime,
        ...(typeof outstanding.turnId === 'string' ? { turnId: outstanding.turnId } : {}),
        ...(typeof outstanding.kind === 'string' ? { kind: outstanding.kind } : {}),
        ...(typeof outstanding.source === 'string' ? { source: outstanding.source } : {}),
        sourceLocalId: null,
        ...(outstanding.responseTarget ? { responseTarget: outstanding.responseTarget } : {}),
        ...(typeof outstanding.subagentRef !== 'undefined' ? { subagentRef: outstanding.subagentRef } : {}),
        ...(typeof outstanding.sidechainId === 'string' ? { sidechainId: outstanding.sidechainId } : {}),
        ...(Array.isArray(outstanding.permissionSuggestions)
            ? { permissionSuggestions: [...outstanding.permissionSuggestions] }
            : {}),
        ...(outstanding.owner ? { owner: outstanding.owner } : {}),
        status: 'live',
        waiters: new Map(),
        cancelReason: null,
        completionPersistence: null,
    };
}

function turnIdsEqual(left: string | undefined, right: string | undefined): boolean {
    return left === right;
}

function permissionSourcesEqual(left: string | null | undefined, right: string | null | undefined): boolean {
    const normalizedLeft = typeof left === 'string' ? left.trim() : '';
    const normalizedRight = typeof right === 'string' ? right.trim() : '';
    return normalizedLeft === normalizedRight;
}

function permissionOwnersEqual(
    left: PermissionRequestOwner | null | undefined,
    right: PermissionRequestOwner | null | undefined,
): boolean {
    return permissionRequestOwnersEqual(left, right);
}

function detachWaiter<TResult>(waiter: PendingPermissionWaiter<TResult>): void {
    if (!waiter.signal || !waiter.abortHandler) return;
    waiter.signal.removeEventListener('abort', waiter.abortHandler);
}

function rejectWaiter<TResult>(waiter: PendingPermissionWaiter<TResult>, error: Error): void {
    if (waiter.aborted) return;
    waiter.aborted = true;
    detachWaiter(waiter);
    waiter.reject(error);
}

function createPermissionRequestAbortError(reason = 'Permission request aborted'): Error {
    return new Error(reason);
}
