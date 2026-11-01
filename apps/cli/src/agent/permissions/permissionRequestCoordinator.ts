import { deepEqual } from '@/utils/deterministicJson';
import { isSameAgentStateRequestOccurrence, type AgentStateOutstandingRequest } from './agentStateRequestStore';
import { normalizeAskUserQuestionInputForPublication } from '@/agent/questions/normalizeAskUserQuestionInput';
import { logger } from '@/ui/logger';

export type PermissionRequestCoordinatorRequest = Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt?: number;
    kind?: string;
    source?: string;
    sourceLocalId?: string | null;
    permissionSuggestions?: readonly unknown[] | null;
}>;

export type PermissionRequestCoordinatorContext = Readonly<{
    requestId: string;
    occurrenceId?: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    kind?: string;
    source?: string;
    sourceLocalId: string | null;
    correlation: 'record' | 'agent_state';
    status: 'live' | 'detached' | 'agent_state_only';
}>;

export type PermissionRequestCoordinatorCompletedRequest = Readonly<{
    status: string;
    decision?: string;
    reason?: string;
    mode?: string;
    allowedTools?: readonly string[];
    updatedPermissions?: unknown;
    extraCompletedFields?: Readonly<Record<string, unknown>> | null;
}>;

export type PermissionRequestCoordinatorCompletion<TResult> = Readonly<{
    result: TResult;
    completedRequest: PermissionRequestCoordinatorCompletedRequest;
}>;

export type PermissionRequestCoordinatorStore = Readonly<{
    publishRequest(params: Readonly<{
        requestId: string;
        onOccurrenceAssigned?: (occurrenceId: string) => void;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        kind?: string;
        source?: string;
        permissionSuggestions?: unknown[] | null;
        replaceCompletedRequest?: boolean;
    }>): void;
    completeRequest(params: Readonly<{
        requestId: string;
        status: string;
        decision?: string;
        reason?: string;
        mode?: string;
        allowedTools?: readonly string[] | undefined;
        updatedPermissions?: unknown;
        extraCompletedFields?: Readonly<Record<string, unknown>> | null;
        fallback?: Readonly<{ occurrenceId?: string; toolName: string; toolInput: unknown; createdAt: number; kind?: string; source?: string }> | null;
        requireAck?: boolean;
        expectedOccurrenceId?: string;
        observedCompletion?: true;
    }>): Promise<void>;
    hasOutstandingRequest(requestId: string): boolean;
    isOutstandingRequestClaimed(requestId: string): boolean;
    readOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null;
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
    requestId: string;
    occurrenceId?: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    kind?: string;
    source?: string;
    sourceLocalId: string | null;
    status: 'live' | 'detached';
    waiters: Map<string, PendingPermissionWaiter<TResult>>;
    completionInProgress?: boolean;
};

type CachedPermissionDecision<TResult> = {
    result: TResult;
    toolName: string;
    toolInput: unknown;
    sourceLocalId: string | null;
};

export class PermissionRequestCoordinator<TResult> {
    private readonly store: PermissionRequestCoordinatorStore;
    private readonly pendingRequests = new Map<string, PendingPermissionRequest<TResult>>();
    private readonly cachedDecisions = new Map<string, CachedPermissionDecision<TResult>>();
    private readonly invalidatedDecisionRequestIds = new Set<string>();
    private waiterSequence = 0;

    constructor(params: Readonly<{ store: PermissionRequestCoordinatorStore }>) {
        this.store = params.store;
    }

    isRequestClaimed(requestId: string): boolean {
        return this.store.isOutstandingRequestClaimed(requestId);
    }

    requestDecision(
        request: PermissionRequestCoordinatorRequest,
        options?: PermissionRequestCoordinatorOptions,
    ): Promise<TResult> {
        const normalizedToolInput = normalizeAskUserQuestionInputForPublication(request.toolName, request.toolInput);
        this.pruneDetachedRecords();

        if (options?.signal?.aborted) {
            return Promise.reject(createPermissionRequestAbortError());
        }

        if (this.isRequestClaimed(request.requestId)) {
            return Promise.reject(createPermissionRequestClaimedError(request.requestId));
        }

        let entry = this.pendingRequests.get(request.requestId);
        if (entry) {
            if (!isCompatiblePendingRequest(entry, { ...request, toolInput: normalizedToolInput })) {
                return Promise.reject(
                    new Error(`Permission request ${request.requestId} is already pending with different tool input`),
                );
            }
            entry.status = 'live';
            return this.attachWaiter(entry, options?.signal);
        }

        const cached = this.cachedDecisions.get(request.requestId);
        const invalidatedDecision = this.invalidatedDecisionRequestIds.delete(request.requestId);
        const cachedCompatible = cached
            ? isCompatibleCachedDecision(cached, { ...request, toolInput: normalizedToolInput })
            : false;
        if (cached && cachedCompatible && !invalidatedDecision) {
            return Promise.resolve(cached.result);
        }
        const replaceCompletedRequest = invalidatedDecision || !!cached;
        if (cached && !cachedCompatible) {
            this.cachedDecisions.delete(request.requestId);
        }

        entry = {
            requestId: request.requestId,
            toolName: request.toolName,
            toolInput: normalizedToolInput,
            createdAt: request.createdAt ?? Date.now(),
            ...(typeof request.kind === 'string' ? { kind: request.kind } : {}),
            ...(typeof request.source === 'string' ? { source: request.source } : {}),
            sourceLocalId: request.sourceLocalId ?? null,
            status: 'live',
            waiters: new Map(),
        };

        this.pendingRequests.set(request.requestId, entry);
        try {
            const publishedEntry = entry;
            this.store.publishRequest({
                requestId: entry.requestId,
                // Retain the producer-assigned identity with this exact live entry, even
                // when an asynchronous publication outlives its persisted projection.
                onOccurrenceAssigned: (occurrenceId) => { publishedEntry.occurrenceId = occurrenceId; },
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
                ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                ...(Array.isArray(request.permissionSuggestions)
                    ? { permissionSuggestions: [...request.permissionSuggestions] }
                    : {}),
                ...(replaceCompletedRequest ? { replaceCompletedRequest: true } : {}),
            });
        } catch (error) {
            if (this.pendingRequests.get(request.requestId) === entry) {
                this.pendingRequests.delete(request.requestId);
            }
            throw error;
        }

        return this.attachWaiter(entry, options?.signal);
    }

    getResponseContext(requestId: string, expectedOccurrenceId?: string): PermissionRequestCoordinatorContext | null {
        if (this.isRequestClaimed(requestId)) return null;
        if (expectedOccurrenceId !== undefined && this.store.readOutstandingRequest(requestId)?.occurrenceId !== expectedOccurrenceId) return null;
        this.pruneDetachedRecords();

        const entry = this.pendingRequests.get(requestId);
        if (entry) {
            return {
                requestId,
                occurrenceId: this.store.readOutstandingRequest(requestId)?.occurrenceId ?? entry.occurrenceId,
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
                ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                sourceLocalId: entry.sourceLocalId,
                correlation: 'record',
                status: entry.status,
            };
        }

        const outstanding = this.store.readOutstandingRequest(requestId);
        if (!outstanding) return null;

        return {
            requestId,
            occurrenceId: outstanding.occurrenceId,
            toolName: outstanding.toolName,
            toolInput: outstanding.toolInput,
            createdAt: outstanding.createdAt,
            ...(typeof outstanding.kind === 'string' ? { kind: outstanding.kind } : {}),
            ...(typeof outstanding.source === 'string' ? { source: outstanding.source } : {}),
            sourceLocalId: null,
            correlation: 'agent_state',
            status: 'agent_state_only',
        };
    }

    /**
     * Returns response context only when this runtime still owns an active provider waiter.
     * Persisted agent state and detached records are deliberately insufficient for structured answers.
     */
    getLocallyOwnedLiveResponseContext(requestId: string, expectedOccurrenceId?: string): PermissionRequestCoordinatorContext | null {
        const context = this.getResponseContext(requestId, expectedOccurrenceId);
        const entry = this.pendingRequests.get(requestId);
        if (!context || !entry || entry.status !== 'live') return null;
        const hasLiveWaiter = [...entry.waiters.values()].some((waiter) => !waiter.aborted);
        if (!hasLiveWaiter) return null;
        return context;
    }

    private isInvalidatedDecision(requestId: string, status: string): boolean {
        return status !== 'canceled' && this.invalidatedDecisionRequestIds.has(requestId);
    }

    handleResponse(params: Readonly<{
        requestId: string;
        buildCompletion: (context: PermissionRequestCoordinatorContext) => PermissionRequestCoordinatorCompletion<TResult>;
        onAdmitted?: () => void;
        observedCompletion?: true;
    }>): boolean {
        if (this.isRequestClaimed(params.requestId)) return false;
        const context = this.getResponseContext(params.requestId);
        if (!context) return false;

        return this.completeResponse({
            context,
            completion: params.buildCompletion(context),
            onAdmitted: params.onAdmitted,
            observedCompletion: params.observedCompletion,
        });
    }

    completeResponse(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
        onAdmitted?: () => void;
        observedCompletion?: true;
    }>): boolean {
        if (this.isRequestClaimed(params.context.requestId)) return false;
        const entry = this.pendingRequests.get(params.context.requestId);
        if (entry && this.isInvalidatedDecision(params.context.requestId, params.completion.completedRequest.status)) return false;
        if (entry?.completionInProgress && params.observedCompletion !== true) return false;
        if (!entry && !this.store.hasOutstandingRequest(params.context.requestId)) return false;
        void this.completeResponseWithAdmission(params).catch(() => {
            logger.infoFile('[Permissions] Request settlement admission failed; response can be retried');
        });
        return true;
    }

    async completeRpcResponse(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
        onAdmitted?: () => void;
        expectedOccurrenceId?: string;
    }>): Promise<boolean> {
        return await this.completeResponseWithAck(params);
    }

    async completeResponseWithAck(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
        onAdmitted?: () => void;
        expectedOccurrenceId?: string;
    }>): Promise<boolean> {
        return await this.completeResponseWithAdmission({ ...params, requireAck: true });
    }

    async completeCancellationResponse(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        result: TResult;
        reason: string;
    }>): Promise<boolean> {
        const entry = this.pendingRequests.get(params.context.requestId);
        try {
            return await this.completeResponseWithAdmission({
                context: params.context,
                completion: { result: params.result, completedRequest: { status: 'canceled', reason: params.reason } },
            });
        } catch (error) {
            if (entry && this.pendingRequests.get(params.context.requestId) === entry) {
                this.detachCanceledWaiters(entry, params.reason);
            }
            throw error;
        }
    }

    private async completeResponseWithAdmission(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
        onAdmitted?: () => void;
        observedCompletion?: true;
        requireAck?: boolean;
        expectedOccurrenceId?: string;
    }>): Promise<boolean> {
        const { context, completion } = params;
        if (params.expectedOccurrenceId !== undefined
            && this.store.readOutstandingRequest(context.requestId)?.occurrenceId !== params.expectedOccurrenceId) return false;
        if (this.isRequestClaimed(context.requestId)) return false;
        const entry = this.pendingRequests.get(context.requestId);
        const isLifecycleCancellation = completion.completedRequest.status === 'canceled' && params.requireAck !== true;
        if (entry && isLifecycleCancellation) this.invalidatedDecisionRequestIds.add(context.requestId);
        if (entry && this.isInvalidatedDecision(context.requestId, params.completion.completedRequest.status)) return false;
        if (entry?.completionInProgress && params.observedCompletion !== true && !isLifecycleCancellation) return false;
        if (!entry && !this.store.hasOutstandingRequest(context.requestId)) return false;
        if (entry) entry.completionInProgress = true;
        try {
            await this.store.completeRequest(entry
                ? { ...this.buildEntryCompletion(entry, completion), requireAck: params.requireAck,
                    expectedOccurrenceId: params.expectedOccurrenceId,
                    observedCompletion: params.observedCompletion }
                : { requestId: context.requestId, ...completion.completedRequest, requireAck: params.requireAck,
                    expectedOccurrenceId: params.expectedOccurrenceId,
                    observedCompletion: params.observedCompletion,
                    fallback: { occurrenceId: context.occurrenceId, toolName: context.toolName, toolInput: context.toolInput,
                        createdAt: context.createdAt, kind: context.kind, source: context.source },
                });
            if (entry && this.pendingRequests.get(context.requestId) !== entry) return false;
            if (entry && this.isInvalidatedDecision(context.requestId, completion.completedRequest.status)) return false;
            if (this.isRequestClaimed(context.requestId)) return false;
            const current = this.store.readOutstandingRequest(context.requestId);
            if (current && params.expectedOccurrenceId !== undefined
                && current.occurrenceId !== params.expectedOccurrenceId) return false;
            if (current && !isSameAgentStateRequestOccurrence({
                tool: current.toolName, arguments: current.toolInput, createdAt: current.createdAt, source: current.source,
            }, {
                tool: context.toolName, arguments: context.toolInput, createdAt: context.createdAt, source: context.source,
            })) return false;
            params.onAdmitted?.();
            if (entry && this.pendingRequests.get(context.requestId) === entry) {
                this.finishPendingResponse(entry, completion.result);
            }
            return true;
        } finally {
            if (entry) entry.completionInProgress = false;
        }
    }

    private buildEntryCompletion(
        entry: PendingPermissionRequest<TResult>,
        completion: Pick<PermissionRequestCoordinatorCompletion<TResult>, 'completedRequest'>,
    ) {
        return {
            requestId: entry.requestId,
            ...completion.completedRequest,
            fallback: {
                occurrenceId: entry.occurrenceId,
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
                ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
            },
        };
    }

    private finishPendingResponse(entry: PendingPermissionRequest<TResult>, result: TResult): void {
        const waiters = [...entry.waiters.values()];
        entry.waiters.clear();
        this.pendingRequests.delete(entry.requestId);
        this.cachedDecisions.set(entry.requestId, {
            result,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            sourceLocalId: entry.sourceLocalId,
        });
        for (const waiter of waiters) {
            if (waiter.aborted) continue;
            detachWaiter(waiter);
            waiter.resolve(result);
        }
    }

    cancelRequest(requestId: string, reason: string): void {
        if (this.cachedDecisions.delete(requestId)) {
            this.invalidatedDecisionRequestIds.add(requestId);
        }
        const entry = this.pendingRequests.get(requestId);
        if (!entry) return;

        if (this.isRequestClaimed(requestId)) {
            entry.status = 'detached';
            for (const waiter of entry.waiters.values()) {
                rejectWaiter(waiter, createPermissionRequestAbortError(reason));
            }
            entry.waiters.clear();
            return;
        }

        this.pendingRequests.delete(requestId);
        for (const waiter of entry.waiters.values()) {
            rejectWaiter(waiter, createPermissionRequestAbortError(reason));
        }
        entry.waiters.clear();
    }

    async cancelAll(reason: string): Promise<void> {
        const entries = [...this.pendingRequests.entries()];
        const requestIds = entries.filter(([requestId]) => !this.isRequestClaimed(requestId)).map(([requestId]) => requestId);
        for (const requestId of requestIds) this.invalidatedDecisionRequestIds.add(requestId);
        for (const requestId of this.cachedDecisions.keys()) {
            this.invalidatedDecisionRequestIds.add(requestId);
        }
        this.cachedDecisions.clear();
        const results = await Promise.allSettled(entries.map(async ([requestId, entry]) => {
            if (entry && !this.isRequestClaimed(requestId)) {
                entry.completionInProgress = true;
                try {
                    await this.store.completeRequest(this.buildEntryCompletion(entry, {
                        completedRequest: { status: 'canceled', decision: 'abort', reason },
                    }));
                } catch (error) {
                    if (this.pendingRequests.get(requestId) === entry) {
                        this.detachCanceledWaiters(entry, reason);
                    }
                    throw error;
                } finally {
                    entry.completionInProgress = false;
                }
            }
            if (this.pendingRequests.get(requestId) === entry) {
                this.cancelRequest(requestId, reason);
            }
        }));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
    }

    private detachCanceledWaiters(entry: PendingPermissionRequest<TResult>, reason: string): void {
        entry.status = 'detached';
        this.invalidatedDecisionRequestIds.add(entry.requestId);
        for (const waiter of entry.waiters.values()) {
            rejectWaiter(waiter, createPermissionRequestAbortError(reason));
        }
        entry.waiters.clear();
    }

    reset(): void {
        void this.cancelAll('Permission coordinator reset').catch(() => {
            logger.infoFile('[Permissions] Reset request settlement admission failed');
        });
    }

    dispose(): void {
        void this.cancelAll('Permission coordinator disposed').catch(() => {
            logger.infoFile('[Permissions] Disposal request settlement admission failed');
        });
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
        rejectWaiter(waiter, createPermissionRequestAbortError());

        if (entry.waiters.size > 0) {
            entry.status = 'live';
            return;
        }

        if (this.store.hasOutstandingRequest(entry.requestId)) {
            entry.status = 'detached';
            return;
        }

        this.pendingRequests.delete(entry.requestId);
    }

    private pruneDetachedRecords(): void {
        for (const [requestId, entry] of this.pendingRequests) {
            if (entry.status !== 'detached') continue;
            if (entry.completionInProgress) continue;
            if (this.invalidatedDecisionRequestIds.has(requestId)) continue;
            if (this.store.hasOutstandingRequest(requestId)) continue;
            this.pendingRequests.delete(requestId);
        }
    }
}

export function createPermissionRequestCoordinator<TResult>(
    params: Readonly<{ store: PermissionRequestCoordinatorStore }>,
): PermissionRequestCoordinator<TResult> {
    return new PermissionRequestCoordinator<TResult>(params);
}

function isCompatibleCachedDecision<TResult>(
    cached: CachedPermissionDecision<TResult>,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return cached.toolName === request.toolName && deepEqual(cached.toolInput, request.toolInput);
}

function isCompatiblePendingRequest<TResult>(
    entry: PendingPermissionRequest<TResult>,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return entry.toolName === request.toolName && deepEqual(entry.toolInput, request.toolInput);
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

function createPermissionRequestClaimedError(requestId: string): Error {
    return new Error(`Permission request ${requestId} is reserved by a newer runtime`);
}
