import { deepEqual } from '@/utils/deterministicJson';
import type { AgentStateOutstandingRequest } from './agentStateRequestStore';

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
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        kind?: string;
        source?: string;
        permissionSuggestions?: unknown[] | null;
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
        fallback?: Readonly<{ toolName: string; toolInput: unknown; createdAt: number; kind?: string; source?: string }> | null;
    }>): void;
    cancelAllRequests?(params: Readonly<{ reason: string; decision?: string }>): void;
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
    status: 'live' | 'detached';
    waiters: Map<string, PendingPermissionWaiter<TResult>>;
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
            if (!isCompatiblePendingRequest(entry, request)) {
                return Promise.reject(
                    new Error(`Permission request ${request.requestId} is already pending with different tool input`),
                );
            }
            entry.status = 'live';
            return this.attachWaiter(entry, options?.signal);
        }

        const cached = this.cachedDecisions.get(request.requestId);
        if (cached && isCompatibleCachedDecision(cached, request)) {
            return Promise.resolve(cached.result);
        }

        entry = {
            requestId: request.requestId,
            toolName: request.toolName,
            toolInput: request.toolInput,
            createdAt: request.createdAt ?? Date.now(),
            ...(typeof request.kind === 'string' ? { kind: request.kind } : {}),
            ...(typeof request.source === 'string' ? { source: request.source } : {}),
            sourceLocalId: request.sourceLocalId ?? null,
            status: 'live',
            waiters: new Map(),
        };

        this.pendingRequests.set(request.requestId, entry);
        this.store.publishRequest({
            requestId: entry.requestId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            createdAt: entry.createdAt,
            ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
            ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
            ...(Array.isArray(request.permissionSuggestions)
                ? { permissionSuggestions: [...request.permissionSuggestions] }
                : {}),
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
            sourceLocalId: null,
            correlation: 'agent_state',
            status: 'agent_state_only',
        };
    }

    handleResponse(params: Readonly<{
        requestId: string;
        buildCompletion: (context: PermissionRequestCoordinatorContext) => PermissionRequestCoordinatorCompletion<TResult>;
    }>): boolean {
        const context = this.getResponseContext(params.requestId);
        if (!context) return false;

        return this.completeResponse({
            context,
            completion: params.buildCompletion(context),
        });
    }

    completeResponse(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        completion: PermissionRequestCoordinatorCompletion<TResult>;
    }>): boolean {
        const { context, completion } = params;
        const entry = this.pendingRequests.get(context.requestId);
        if (entry) {
            this.store.completeRequest({
                requestId: entry.requestId,
                ...completion.completedRequest,
                fallback: {
                    toolName: entry.toolName,
                    toolInput: entry.toolInput,
                    createdAt: entry.createdAt,
                    ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
                    ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                },
            });

            const waiters = [...entry.waiters.values()];
            entry.waiters.clear();
            this.pendingRequests.delete(entry.requestId);
            this.cachedDecisions.set(entry.requestId, {
                result: completion.result,
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                sourceLocalId: entry.sourceLocalId,
            });

            for (const waiter of waiters) {
                if (waiter.aborted) continue;
                detachWaiter(waiter);
                waiter.resolve(completion.result);
            }

            return true;
        }

        if (!this.store.hasOutstandingRequest(context.requestId)) return false;

        this.store.completeRequest({
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

    cancelAll(reason: string): void {
        for (const requestId of [...this.pendingRequests.keys()]) {
            this.cancelRequest(requestId, reason);
        }
        this.cachedDecisions.clear();
        this.store.cancelAllRequests?.({ reason, decision: 'abort' });
    }

    reset(): void {
        this.cancelAll('Permission coordinator reset');
    }

    dispose(): void {
        this.cancelAll('Permission coordinator disposed');
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
