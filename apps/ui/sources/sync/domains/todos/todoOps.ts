import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { applyTodoSessionLinkV1, TodoSessionLinkErrorV1 as TodoSessionLinkError } from '@happier-dev/protocol/todos/todoSessionLinkV1';
import { resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import { applyInternalTaskReorder, InternalTaskReorderError } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { storage } from '@/sync/domains/state/storage';
import { kvList } from '@/sync/api/account/apiKv';
import type { AccountEncryptionReadUsage } from '@/sync/api/account/apiAccountEncryptionMode';
import { createServerFetchForActiveServer, type ServerFetch } from '@/sync/http/client';
import { bindAccountEncryptionObservation, readAccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { createAccountKvJsonTransport, openUiAccountKvJsonRow, type AccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseToken } from '@/utils/auth/parseToken';
import { AsyncLock } from '@/utils/system/lock';
import {
    parseTodoStoredContent,
    isAccountStoredContentFailure,
    toTodoStoredContentUnavailableError,
    TodoStoredContentUnavailableError,
    TODO_INDEX_KEY,
    TODO_PREFIX,
    type TodoIndex,
    type TodoItem,
} from './todoStoredContent';
import {
    resolveAccountStorageContext,
    type AccountStorageContext,
} from '@/sync/encryption/accountStorageContext';

export type { TodoIndex, TodoItem } from './todoStoredContent';

//
// Lock Instance
//

const todoLock = new AsyncLock();

//
// Types
//

export interface TodoState {
    todos: Record<string, TodoItem>;
    undoneOrder: string[];
    doneOrder: string[];  // Keep storage compatible, but we'll order by completion time
    versions: Record<string, number>;  // Track KV versions for each key
}

//
// Constants
//

function getTodoKey(id: string): string {
    return `${TODO_PREFIX}${id}`;
}

export type TodoAccountStorageContext = AccountStorageContext;

export async function resolveTodoAccountStorageContext(
    credentials: AuthCredentials,
    options: Readonly<{
        encryption?: TodoAccountStorageContext['encryption'];
        request?: ServerFetch;
        usage?: AccountEncryptionReadUsage;
    }> = {},
): Promise<TodoAccountStorageContext> {
    try {
        return await resolveAccountStorageContext(credentials, options);
    } catch (error) {
        throw new TodoStoredContentUnavailableError(
            TODO_INDEX_KEY,
            'account_currentness_unavailable',
            error,
        );
    }
}

//
// Fetch Functions
//

/**
 * Fetch all todos from the server and decrypt them
 */
export async function fetchTodos(
    credentials: AuthCredentials,
    opts: Readonly<{ retry?: 'default' | 'none'; request?: ServerFetch; shouldContinue?: () => boolean }> = {},
): Promise<TodoState> {
    const requireCurrent = () => {
        if (opts.shouldContinue?.() === false) throw new TodoStoredContentUnavailableError(TODO_INDEX_KEY, 'account_currentness_unavailable');
    };
    requireCurrent();
    const request = opts.request ?? createServerFetchForActiveServer(undefined, { credentials, isCurrent: opts.shouldContinue });
    const context = await resolveTodoAccountStorageContext(credentials, { request, usage: 'identity' });
    const state: TodoState = {
        todos: {},
        undoneOrder: [],
        doneOrder: [],  // Will be mapped from completedOrder
        versions: {}
    };

    // The KV server owns a 1,000-row request maximum, not an Account Task cap.
    const pageSize = 1000;
    let afterKey: string | undefined;
    for (;;) {
        const response = await kvList(credentials, {
            prefix: TODO_PREFIX,
            limit: pageSize,
            ...(afterKey === undefined ? {} : { afterKey }),
            ...(opts.retry ? { retry: opts.retry } : {}),
            request,
        });
        for (const item of response.items) {
            let opened;
            try {
                opened = await openUiAccountKvJsonRow({ credentials, context, row: item, request, requireCurrent });
            } catch (error) {
                throw toTodoStoredContentUnavailableError(item.key, error);
            }
            state.versions[item.key] = opened.version;
            if (opened.tombstone) continue;
            const content = parseTodoStoredContent(item.key, opened.value, true);
            if (content.kind === 'index') {
                state.undoneOrder = content.value.undoneOrder;
                state.doneOrder = content.value.completedOrder;
            } else if (content.kind === 'item') {
                state.todos[content.todoId] = content.value;
            }
        }
        if (response.items.length < pageSize) break;
        afterKey = response.items[response.items.length - 1]!.key;
    }

    // Clean up orders - remove IDs that don't exist in todos
    state.undoneOrder = state.undoneOrder.filter(id => id in state.todos);
    state.doneOrder = state.doneOrder.filter(id => id in state.todos);

    // Add any todos that exist but aren't in any order list
    const allOrderedIds = new Set([...state.undoneOrder, ...state.doneOrder]);
    for (const todoId in state.todos) {
        if (!allOrderedIds.has(todoId)) {
            const todo = state.todos[todoId];
            if (todo.done) {
                state.doneOrder.push(todoId);
            } else {
                state.undoneOrder.push(todoId);
            }
        }
    }

    return state;
}

/**
 * Initialize todo sync and load initial data
 */
export async function initializeTodoSync(credentials: AuthCredentials): Promise<void> {
    const todoState = await fetchTodos(credentials);
    storage.getState().applyTodos(todoState);
}

//
// Mutation Functions
//

export type TodoSessionLinkIntent = Readonly<{
    source: Readonly<{ scope: ServerAccountScope; taskId: string; title?: string }>;
    session: Readonly<{ scope: ServerAccountScope; sessionId: string }>;
    linked?: boolean;
}>;

export { TodoSessionLinkError };

/** A stored row the Account cipher refuses is the same typed Todo failure the list read reports. */
function withTodoStoredContentFailures(key: string, transport: AccountKvJsonTransport): AccountKvJsonTransport {
    const typed = (error: unknown): never => {
        throw isAccountStoredContentFailure(error) ? toTodoStoredContentUnavailableError(key, error) : error;
    };
    return {
        read: () => transport.read().catch(typed),
        compareAndSet: (value, version) => transport.compareAndSet(value, version).catch(typed),
    };
}

/** Apply one accepted Session to the current task, never a captured replacement map. */
export async function applyTodoSessionLinkIntent(credentials: AuthCredentials, intent: TodoSessionLinkIntent,
    options: Readonly<{ signal?: AbortSignal; request?: ServerFetch }> = {}): Promise<void> {
    const [{ captureActiveServerAccountScopeLifetime }, { getActiveServerSnapshot }] = await Promise.all([
        import('@/sync/domains/scope/activeServerAccountScope'),
        import('@/sync/domains/server/serverRuntime'),
    ]);
    const lifetime = captureActiveServerAccountScopeLifetime();
    const snapshot = getActiveServerSnapshot();
    let credentialAccountId: string;
    try {
        credentialAccountId = parseToken(credentials.token);
    } catch (error) {
        throw new TodoSessionLinkError('task_scope_mismatch', error);
    }
    const requireCurrent = () => {
        if (options.signal?.aborted || !lifetime?.isCurrent() || !areServerAccountScopesEqual(lifetime.scope, intent.source.scope)
            || snapshot.serverId !== intent.source.scope.serverId
            || credentialAccountId !== intent.source.scope.accountId) {
            throw new TodoSessionLinkError('task_scope_mismatch');
        }
    };
    requireCurrent();
    const capturedRequest = options.request ?? createServerFetchForActiveServer(snapshot, {
        credentials, signal: options.signal, isCurrent: () => { try { requireCurrent(); return true; } catch { return false; } },
    });
    const request: ServerFetch = (path, init, requestOptions) => {
        requireCurrent();
        return capturedRequest(path, { ...init, ...(options.signal ? { signal: options.signal } : {}) }, { ...requestOptions, expectedActiveServer: { serverId: snapshot.serverId, generation: snapshot.generation } });
    };
    bindAccountEncryptionObservation(request, readAccountEncryptionObservationBinding(capturedRequest, credentials) ?? undefined);
    try {
        await todoLock.inLock(async () => {
            requireCurrent();
            const key = getTodoKey(intent.source.taskId);
            await applyTodoSessionLinkV1({ scope: intent.source.scope, taskId: intent.source.taskId,
                session: { ...intent.session.scope, sessionId: intent.session.sessionId }, ...(intent.linked === undefined ? {} : { linked: intent.linked }) },
                withTodoStoredContentFailures(key, createAccountKvJsonTransport({ credentials, key, request, shouldContinue: () => { requireCurrent(); return true; } })),
                { requireCurrent, title: intent.source.title,
                publish: (item, version) => {
                    requireCurrent();
                    const current = storage.getState().todoState;
                    if (!current?.todos[item.id]) return;
                    storage.getState().applyTodos({
                        ...current,
                        todos: { ...current.todos, [item.id]: item },
                        versions: { ...current.versions, [key]: version },
                    });
                },
            });
        });
    } catch (error) {
        if (error instanceof TodoSessionLinkError) throw error;
        throw new TodoSessionLinkError('task_link_failed', error);
    }
}

/**
 * Reorder todos
 */
export { InternalTaskReorderError as TodoReorderError };

/** Reorder only current undone membership; the task domain owns transitions. */
export async function reorderTodos(
    credentials: AuthCredentials,
    todoId: string,
    position: AnchoredListPositionV1,
    options: Readonly<{ request?: ServerFetch; isCurrent?: () => boolean; signal?: AbortSignal }> = {},
): Promise<void> {
    const requireCurrent = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) {
            throw new InternalTaskReorderError('todo_reorder_scope_changed');
        }
    };
    requireCurrent();
    await todoLock.inLock(async () => {
        requireCurrent();
        const [{ createTodoAccountKvTransport }, { getActiveServerSnapshot }] = await Promise.all([
            import('./todoAccountKvTransport'), import('@/sync/domains/server/serverRuntime'),
        ]);
        const snapshot = getActiveServerSnapshot();
        const scope = { serverId: snapshot.serverId, accountId: parseToken(credentials.token) };
        const request = options.request ?? createServerFetchForActiveServer(snapshot, {
            credentials, signal: options.signal, isCurrent: options.isCurrent,
        });
        await applyInternalTaskReorder({ input: { scope, sourceId: todoId, position }, scope, requireCurrent,
            port: createTodoAccountKvTransport({ credentials, request, requireCurrent }),
            onApplied: (_order, version) => {
                // Acknowledgement survives retirement; only publication is suppressed.
                if (options.signal?.aborted || options.isCurrent?.() === false) return;
                const current = storage.getState().todoState;
                if (!current) return;
                const eligible = current.undoneOrder.filter(id => current.todos[id] && !current.todos[id]!.done);
                const localOrder = resolveAnchoredListMoveV1(eligible, todoId, position);
                if (!localOrder) return;
                storage.getState().applyTodos({ ...current, undoneOrder: localOrder,
                    versions: { ...current.versions, [TODO_INDEX_KEY]: version } });
            },
        });
    });
}
