import { deepEqual } from '@/utils/deterministicJson';
import type {
    AgentStateOutstandingRequest,
    AgentStateRequestResponseTarget,
    PermissionResponseClaim,
    PermissionResponseClaimAcquisition,
    PermissionResponseClaimRejoin,
    PermissionResponseClaimSettlement,
} from './agentStateRequestStore';
import {
    isPermissionRequestOwnedByPlugin,
    normalizePermissionRequestOwner,
    permissionRequestOwnersEqual,
    type PermissionRequestOwner,
} from './permissionRequestOwner';

export type PermissionRequestCoordinatorRequest = Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt?: number;
    /** Host-stamped exact turn identity when this request has mediated source authority. */
    turnId?: string;
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
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
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
    publishRequest(params: Readonly<{
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        turnId?: string;
        kind?: string;
        source?: string;
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
        owner?: PermissionRequestOwner | null;
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
        isCurrent?: () => boolean;
        fallback?: Readonly<{
            toolName: string;
            toolInput: unknown;
            createdAt: number;
            turnId?: string;
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
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): void | Promise<void>;
    cancelRequestsByOwner?(params: Readonly<{
        owner: PermissionRequestOwner;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): void | Promise<void>;
    hasOutstandingRequest(requestId: string): boolean;
    hasPermissionResponseClaim?(requestId: string): boolean;
    readOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null;
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
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    turnId?: string;
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
};

type CachedPermissionDecision<TResult> = {
    result: TResult;
    toolName: string;
    toolInput: unknown;
    turnId?: string;
    source?: string;
    owner?: PermissionRequestOwner;
};

export class PermissionRequestCoordinator<TResult> {
    private readonly store: PermissionRequestCoordinatorStore;
    private readonly pendingRequests = new Map<string, PendingPermissionRequest<TResult>>();
    private readonly cachedDecisions = new Map<string, CachedPermissionDecision<TResult>>();
    /**
     * Serializes terminal-response admission for one request within this
     * canonical coordinator. It deliberately does not introduce a global
     * lock, durable lease, or another response owner.
     */
    private readonly responseClaims = new Map<string, Promise<void>>();
    private waiterSequence = 0;

    constructor(params: Readonly<{ store: PermissionRequestCoordinatorStore }>) {
        this.store = params.store;
    }

    requestDecision(
        request: PermissionRequestCoordinatorRequest,
        options?: PermissionRequestCoordinatorOptions,
    ): Promise<TResult> {
        this.pruneDetachedRecords();

        if (options?.signal?.aborted) {
            return Promise.reject(createPermissionRequestAbortError());
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
            entry = createPendingRequestFromOutstanding<TResult>(outstanding);
            this.pendingRequests.set(request.requestId, entry);
            return this.attachWaiter(entry, options?.signal);
        }

        const owner = normalizePermissionRequestOwner(request.owner);
        entry = {
            requestId: request.requestId,
            toolName: request.toolName,
            toolInput: request.toolInput,
            createdAt: request.createdAt ?? Date.now(),
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
        this.store.publishRequest({
            requestId: entry.requestId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            createdAt: entry.createdAt,
            ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
            ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
            ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
            ...(entry.responseTarget ? { responseTarget: entry.responseTarget } : {}),
            ...(typeof entry.subagentRef !== 'undefined' ? { subagentRef: entry.subagentRef } : {}),
            ...(typeof entry.sidechainId === 'string' ? { sidechainId: entry.sidechainId } : {}),
            ...(typeof entry.permissionSuggestions !== 'undefined' ? { permissionSuggestions: entry.permissionSuggestions } : {}),
            ...(entry.owner ? { owner: entry.owner } : {}),
        });

        return this.attachWaiter(entry, options?.signal);
    }

    getResponseContext(requestId: string): PermissionRequestCoordinatorContext | null {
        this.pruneDetachedRecords();

        const entry = this.pendingRequests.get(requestId);
        if (entry) {
            if (entry.cancelReason) return null;
            if (entry.status === 'detached') return null;
            return {
                requestId,
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
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
            toolInput: outstanding.toolInput,
            createdAt: outstanding.createdAt,
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

    async completeResponse(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
    }>): Promise<boolean> {
        const { context, completion } = params;
        const entry = this.pendingRequests.get(context.requestId);
        if (entry) {
            if (entry.cancelReason) return false;
            if (entry.completionPersistence) return false;

            const precedingPersistence = entry.completionPersistence ?? Promise.resolve(true);
            const completionPersistence = precedingPersistence.then(async () => {
                const persisted = await this.store.completeRequest({
                    requestId: entry.requestId,
                    ...completion.completedRequest,
                    fallback: {
                        toolName: entry.toolName,
                        toolInput: entry.toolInput,
                        createdAt: entry.createdAt,
                        ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
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
                return persisted !== false;
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

            const waiters = [...entry.waiters.values()];
            const hasLiveWaiters = waiters.some((waiter) => !waiter.aborted);
            entry.waiters.clear();
            this.pendingRequests.delete(entry.requestId);
            if (!hasLiveWaiters && !entry.owner) {
                this.cachedDecisions.set(entry.requestId, {
                    result: completion.result,
                    toolName: entry.toolName,
                    toolInput: entry.toolInput,
                    ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                    ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                    ...(entry.owner ? { owner: entry.owner } : {}),
                });
            }

            for (const waiter of waiters) {
                if (waiter.aborted) continue;
                detachWaiter(waiter);
                waiter.resolve(completion.result);
            }

            return true;
        }

        if (!this.store.hasOutstandingRequest(context.requestId)) return false;

        const persisted = await this.store.completeRequest({
            requestId: context.requestId,
            ...completion.completedRequest,
        });
        return persisted !== false;
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

    async cancelAll(reason: string): Promise<void> {
        const entries = [...this.pendingRequests.values()];
        const markedEntries = entries.filter(
            (entry) => entry.completionPersistence !== null
                && !entry.cancelReason
                && this.store.hasPermissionResponseClaim?.(entry.requestId) !== true,
        );
        for (const entry of markedEntries) {
            entry.cancelReason = reason;
        }
        const inFlightPersistence = entries
            .map((entry) => entry.completionPersistence)
            .filter((persistence): persistence is Promise<boolean> => persistence !== null);
        if (inFlightPersistence.length > 0) {
            const outcomes = await Promise.allSettled(inFlightPersistence);
            const failure = outcomes.find((outcome) => outcome.status === 'rejected');
            if (failure && failure.status === 'rejected') {
                for (const entry of markedEntries) {
                    if (this.pendingRequests.get(entry.requestId) === entry && entry.cancelReason === reason) {
                        entry.cancelReason = null;
                    }
                }
                throw failure.reason;
            }
        }
        try {
            await this.store.cancelAllRequests?.({
                reason,
                decision: 'abort',
                requestIds: markedEntries.map((entry) => entry.requestId),
            });
        } catch (error) {
            for (const entry of markedEntries) {
                if (this.pendingRequests.get(entry.requestId) === entry && entry.cancelReason === reason) {
                    entry.cancelReason = null;
                }
            }
            throw error;
        }

        this.cachedDecisions.clear();
        for (const entry of entries) {
            if (this.pendingRequests.get(entry.requestId) !== entry) continue;
            if (this.store.hasOutstandingRequest(entry.requestId)) {
                if (entry.cancelReason === reason) entry.cancelReason = null;
                entry.status = entry.waiters.size > 0 ? 'live' : 'detached';
                continue;
            }
            for (const waiter of entry.waiters.values()) {
                rejectWaiter(waiter, createPermissionRequestAbortError(reason));
            }
            entry.waiters.clear();
            this.pendingRequests.delete(entry.requestId);
        }
    }

    async cancelByPlugin(pluginId: string, reason: string): Promise<void> {
        const normalizedPluginId = pluginId.trim();
        if (!normalizedPluginId) return;
        const ownedEntries = [...this.pendingRequests.values()].filter(
            (entry) => isPermissionRequestOwnedByPlugin(entry.owner, normalizedPluginId),
        );
        const markedEntries = ownedEntries.filter(
            (entry) => entry.completionPersistence !== null
                && !entry.cancelReason
                && this.store.hasPermissionResponseClaim?.(entry.requestId) !== true,
        );
        for (const entry of markedEntries) {
            entry.cancelReason = reason;
        }
        const inFlightPersistence = ownedEntries
            .map((entry) => entry.completionPersistence)
            .filter((persistence): persistence is Promise<boolean> => persistence !== null);
        if (inFlightPersistence.length > 0) {
            const outcomes = await Promise.allSettled(inFlightPersistence);
            const failure = outcomes.find((outcome) => outcome.status === 'rejected');
            if (failure && failure.status === 'rejected') {
                for (const entry of markedEntries) {
                    if (this.pendingRequests.get(entry.requestId) === entry && entry.cancelReason === reason) {
                        entry.cancelReason = null;
                    }
                }
                throw failure.reason;
            }
        }
        try {
            await this.store.cancelRequestsByOwner?.({
                owner: { kind: 'plugin', pluginId: normalizedPluginId },
                reason,
                decision: 'abort',
                requestIds: markedEntries.map((entry) => entry.requestId),
            });
        } catch (error) {
            for (const entry of markedEntries) {
                if (this.pendingRequests.get(entry.requestId) === entry && entry.cancelReason === reason) {
                    entry.cancelReason = null;
                }
            }
            throw error;
        }

        for (const [requestId, cached] of [...this.cachedDecisions.entries()]) {
            if (isPermissionRequestOwnedByPlugin(cached.owner, normalizedPluginId)) {
                this.cachedDecisions.delete(requestId);
            }
        }
        for (const entry of ownedEntries) {
            if (this.pendingRequests.get(entry.requestId) !== entry) continue;
            if (this.store.hasOutstandingRequest(entry.requestId)) {
                if (entry.cancelReason === reason) entry.cancelReason = null;
                entry.status = entry.waiters.size > 0 ? 'live' : 'detached';
                continue;
            }
            for (const waiter of entry.waiters.values()) {
                rejectWaiter(waiter, createPermissionRequestAbortError(reason));
            }
            entry.waiters.clear();
            this.pendingRequests.delete(entry.requestId);
        }
    }

    async reset(): Promise<void> {
        await this.cancelAll('Permission coordinator reset');
    }

    async dispose(): Promise<void> {
        await this.cancelAll('Permission coordinator disposed');
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

        if (
            entry.completionPersistence
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
            decision: 'abort',
            reason: error.message,
            fallback: {
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
                ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
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
    params: Readonly<{ store: PermissionRequestCoordinatorStore }>,
): PermissionRequestCoordinator<TResult> {
    return new PermissionRequestCoordinator<TResult>(params);
}

function isCompatibleCachedDecision<TResult>(
    cached: CachedPermissionDecision<TResult>,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return cached.toolName === request.toolName
        && deepEqual(cached.toolInput, request.toolInput)
        && turnIdsEqual(cached.turnId, request.turnId)
        && permissionSourcesEqual(cached.source, request.source)
        && permissionOwnersEqual(cached.owner, normalizePermissionRequestOwner(request.owner));
}

function isCompatiblePendingRequest<TResult>(
    entry: PendingPermissionRequest<TResult>,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return entry.toolName === request.toolName
        && deepEqual(entry.toolInput, request.toolInput)
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
        || !permissionSourcesEqual(outstanding.source, request.source)
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
): PendingPermissionRequest<TResult> {
    return {
        requestId: outstanding.requestId,
        toolName: outstanding.toolName,
        toolInput: outstanding.toolInput,
        createdAt: outstanding.createdAt,
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
