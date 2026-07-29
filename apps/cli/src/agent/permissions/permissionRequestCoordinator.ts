import { deepEqual } from '@/utils/deterministicJson';
import type {
    AgentStateOutstandingRequest,
    AgentStateRequestResponseTarget,
} from './agentStateRequestStore';
import {
    isPermissionRequestOwnedByPlugin,
    normalizePermissionRequestOwner,
    type PermissionRequestOwner,
} from './permissionRequestOwner';

export type PermissionRequestCoordinatorRequest = Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt?: number;
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
        fallback?: Readonly<{
            toolName: string;
            toolInput: unknown;
            createdAt: number;
            kind?: string;
            source?: string;
            responseTarget?: AgentStateRequestResponseTarget | null;
            subagentRef?: unknown;
            sidechainId?: string | null;
            permissionSuggestions?: readonly unknown[] | null;
            owner?: PermissionRequestOwner | null;
        }> | null;
    }>): void | Promise<void>;
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
    toolName: string;
    toolInput: unknown;
    createdAt: number;
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
    completionPersistence: Promise<void> | null;
};

type CachedPermissionDecision<TResult> = {
    result: TResult;
    toolName: string;
    toolInput: unknown;
    source?: string;
    owner?: PermissionRequestOwner;
};

export class PermissionRequestCoordinator<TResult> {
    private readonly store: PermissionRequestCoordinatorStore;
    private readonly pendingRequests = new Map<string, PendingPermissionRequest<TResult>>();
    private readonly cachedDecisions = new Map<string, CachedPermissionDecision<TResult>>();
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

        const owner = normalizePermissionRequestOwner(request.owner);
        entry = {
            requestId: request.requestId,
            toolName: request.toolName,
            toolInput: request.toolInput,
            createdAt: request.createdAt ?? Date.now(),
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
            return {
                requestId,
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
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

            const precedingPersistence = entry.completionPersistence ?? Promise.resolve();
            const completionPersistence = precedingPersistence.then(async () => {
                await this.store.completeRequest({
                    requestId: entry.requestId,
                    ...completion.completedRequest,
                    fallback: {
                        toolName: entry.toolName,
                        toolInput: entry.toolInput,
                        createdAt: entry.createdAt,
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
            });
            entry.completionPersistence = completionPersistence;
            try {
                await completionPersistence;
            } finally {
                if (entry.completionPersistence === completionPersistence) {
                    entry.completionPersistence = null;
                }
            }

            if (entry.cancelReason) return true;

            const waiters = [...entry.waiters.values()];
            const hasLiveWaiters = waiters.some((waiter) => !waiter.aborted);
            entry.waiters.clear();
            this.pendingRequests.delete(entry.requestId);
            if (!hasLiveWaiters && !entry.owner) {
                this.cachedDecisions.set(entry.requestId, {
                    result: completion.result,
                    toolName: entry.toolName,
                    toolInput: entry.toolInput,
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

        await this.store.completeRequest({
            requestId: context.requestId,
            ...completion.completedRequest,
        });
        return true;
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
        for (const entry of entries) {
            entry.cancelReason = reason;
            for (const waiter of entry.waiters.values()) {
                rejectWaiter(waiter, createPermissionRequestAbortError(reason));
            }
            entry.waiters.clear();
        }
        this.cachedDecisions.clear();
        const inFlightPersistence = entries
            .map((entry) => entry.completionPersistence)
            .filter((persistence): persistence is Promise<void> => persistence !== null);
        if (inFlightPersistence.length > 0) {
            await Promise.allSettled(inFlightPersistence);
        }
        await this.store.cancelAllRequests?.({
            reason,
            decision: 'abort',
            requestIds: entries.map((entry) => entry.requestId),
        });
        for (const entry of entries) {
            if (this.pendingRequests.get(entry.requestId) === entry) {
                this.pendingRequests.delete(entry.requestId);
            }
        }
    }

    async cancelByPlugin(pluginId: string, reason: string): Promise<void> {
        const normalizedPluginId = pluginId.trim();
        if (!normalizedPluginId) return;
        const ownedEntries: PendingPermissionRequest<TResult>[] = [];
        for (const [requestId, entry] of [...this.pendingRequests.entries()]) {
            if (isPermissionRequestOwnedByPlugin(entry.owner, normalizedPluginId)) {
                entry.cancelReason = reason;
                ownedEntries.push(entry);
                for (const waiter of entry.waiters.values()) {
                    rejectWaiter(waiter, createPermissionRequestAbortError(reason));
                }
                entry.waiters.clear();
                this.cachedDecisions.delete(requestId);
            }
        }
        for (const [requestId, cached] of [...this.cachedDecisions.entries()]) {
            if (isPermissionRequestOwnedByPlugin(cached.owner, normalizedPluginId)) {
                this.cachedDecisions.delete(requestId);
            }
        }
        await Promise.allSettled(
            ownedEntries
                .map((entry) => entry.completionPersistence)
                .filter((persistence): persistence is Promise<void> => persistence !== null),
        );
        await this.store.cancelRequestsByOwner?.({
            owner: { kind: 'plugin', pluginId: normalizedPluginId },
            reason,
            decision: 'abort',
            requestIds: ownedEntries.map((entry) => entry.requestId),
        });
        for (const entry of ownedEntries) {
            if (this.pendingRequests.get(entry.requestId) === entry) {
                this.pendingRequests.delete(entry.requestId);
            }
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

        if (entry.owner) {
            if (entry.completionPersistence) {
                rejectWaiter(waiter, createPermissionRequestAbortError());
                return;
            }
            this.cancelPluginOwnedRequestAfterLastWaiterAbort(entry, waiter);
            return;
        }

        rejectWaiter(waiter, createPermissionRequestAbortError());

        if (this.store.hasOutstandingRequest(entry.requestId)) {
            entry.status = 'detached';
            return;
        }

        this.pendingRequests.delete(entry.requestId);
    }

    private cancelPluginOwnedRequestAfterLastWaiterAbort(
        entry: PendingPermissionRequest<TResult>,
        waiter: PendingPermissionWaiter<TResult>,
    ): void {
        const error = createPermissionRequestAbortError();
        entry.cancelReason = error.message;
        waiter.aborted = true;
        detachWaiter(waiter);

        const cancellation = Promise.resolve(this.store.completeRequest({
            requestId: entry.requestId,
            status: 'canceled',
            decision: 'abort',
            reason: error.message,
            fallback: {
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                createdAt: entry.createdAt,
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
        }));
        entry.completionPersistence = cancellation;
        void cancellation.then(
            () => {
                if (this.pendingRequests.get(entry.requestId) === entry) {
                    this.pendingRequests.delete(entry.requestId);
                }
                entry.completionPersistence = null;
                waiter.reject(error);
            },
            (persistenceError: unknown) => {
                if (this.pendingRequests.get(entry.requestId) === entry) {
                    this.pendingRequests.delete(entry.requestId);
                }
                entry.completionPersistence = null;
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
        && permissionSourcesEqual(cached.source, request.source)
        && permissionOwnersEqual(cached.owner, normalizePermissionRequestOwner(request.owner));
}

function isCompatiblePendingRequest<TResult>(
    entry: PendingPermissionRequest<TResult>,
    request: PermissionRequestCoordinatorRequest,
): boolean {
    return entry.toolName === request.toolName
        && deepEqual(entry.toolInput, request.toolInput)
        && permissionSourcesEqual(entry.source, request.source)
        && permissionOwnersEqual(entry.owner, normalizePermissionRequestOwner(request.owner));
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
    const leftOwner = normalizePermissionRequestOwner(left);
    const rightOwner = normalizePermissionRequestOwner(right);
    if (!leftOwner && !rightOwner) return true;
    if (!leftOwner || !rightOwner) return false;
    return leftOwner.pluginId === rightOwner.pluginId && (leftOwner.runtimeId ?? '') === (rightOwner.runtimeId ?? '');
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
