import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { applyTodoSessionLinkV1, TodoSessionLinkErrorV1 as TodoSessionLinkError,
    resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '@happier-dev/protocol';
import { storage } from '@/sync/domains/state/storage';
import {
    kvGet,
    kvList,
    kvMutate,
    kvSet,
    type KvMutation,
} from '@/sync/api/account/apiKv';
import type { ServerFetch } from '@/sync/http/client';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseToken } from '@/utils/auth/parseToken';
import { randomUUID } from '@/platform/randomUUID';
import { AsyncLock } from '@/utils/system/lock';
import {
    decodeTodoStoredContent,
    encodeTodoStoredContent,
    isTodoStoredContentUnavailableError,
    TodoStoredContentUnavailableError,
    TODO_INDEX_KEY,
    TODO_PREFIX,
    type TodoIndex,
    type TodoItem,
    type ZenTaskSource,
} from './todoStoredContent';
import {
    resolveAccountStorageContext,
    isRawAccountStorageEncryption,
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

async function createTodoDataEncoder(
    context: TodoAccountStorageContext,
): Promise<(key: string, data: unknown) => Promise<string>> {
    const encryption = isRawAccountStorageEncryption(context.encryption)
        ? context.encryption
        : null;
    return async (key, data) =>
        await encodeTodoStoredContent({
            key,
            mode: context.mode,
            value: data,
            encryption,
        });
}

async function decryptTodoIndex(
    encoded: string,
    context: TodoAccountStorageContext,
): Promise<TodoIndex> {
    const content = await decodeTodoStoredContent({
        key: TODO_INDEX_KEY,
        encoded,
        expectedMode: context.mode,
        encryption: context.encryption,
    });
    if (content.kind !== 'index') {
        throw new Error('Todo index codec returned an item');
    }
    return content.value;
}

async function decryptTodoItem(
    key: string,
    encoded: string,
    context: TodoAccountStorageContext,
): Promise<TodoItem> {
    const content = await decodeTodoStoredContent({
        key,
        encoded,
        expectedMode: context.mode,
        encryption: context.encryption,
    });
    if (content.kind !== 'item') {
        throw new Error('Todo item codec returned an index');
    }
    return content.value;
}

function handleTodoMutationFailure(
    error: unknown,
    message: string,
    priorState: TodoState,
): void {
    const code = error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : null;
    if (
        isTodoStoredContentUnavailableError(error)
        || code === 'client-upgrade-required'
    ) {
        storage.getState().applyTodos(priorState);
        throw error;
    }
    console.error(message, error);
}

//
// Fetch Functions
//

/**
 * Fetch all todos from the server and decrypt them
 */
export async function fetchTodos(
    credentials: AuthCredentials,
    opts: Readonly<{ retry?: 'default' | 'none'; request?: ServerFetch }> = {},
): Promise<TodoState> {
    const context = await resolveTodoAccountStorageContext(credentials, { request: opts.request });
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
            ...(opts.request ? { request: opts.request } : {}),
        });
        for (const item of response.items) {
            state.versions[item.key] = item.version;

            const content = await decodeTodoStoredContent({
                key: item.key,
                encoded: item.value,
                expectedMode: context.mode,
                encryption: context.encryption,
            });
            if (content.kind === 'index') {
                state.undoneOrder = content.value.undoneOrder;
                state.doneOrder = content.value.completedOrder;
            } else {
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

/**
 * Add a new todo
 */
export async function addTodo(
    credentials: AuthCredentials,
    title: string
): Promise<string> {
    const id = randomUUID();
    const now = Date.now();

    const newTodo: TodoItem = {
        id,
        title,
        done: false,
        createdAt: now,
        updatedAt: now,
        linkedSessions: {}  // Initialize with empty map
    };

    // Get current state
    const currentState = storage.getState();
    const priorState = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };
    const { todos, undoneOrder, doneOrder, versions } = priorState;

    // Apply optimistic update immediately
    const optimisticUndoneOrder = [...undoneOrder, id];
    storage.getState().applyTodos({
        todos: { ...todos, [id]: newTodo },
        undoneOrder: optimisticUndoneOrder,
        doneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            const context = await resolveTodoAccountStorageContext(credentials);
            // Fetch current index from backend
            const indexResponse = await kvGet(credentials, TODO_INDEX_KEY);
            let currentIndex: TodoIndex = { undoneOrder: [], completedOrder: [] };
            let indexVersion = -1;

            if (indexResponse) {
                indexVersion = indexResponse.version;
                currentIndex = await decryptTodoIndex(indexResponse.value, context);
            }

            // Merge our new todo into the server's index
            const mergedIndex: TodoIndex = {
                undoneOrder: (currentIndex.undoneOrder || []).includes(id)
                    ? (currentIndex.undoneOrder || [])
                    : [...(currentIndex.undoneOrder || []), id],
                completedOrder: (currentIndex.completedOrder || []).filter(tid => tid !== id)
            };

            // Write both todo and updated index
            const encodeTodoData = await createTodoDataEncoder(context);
            const mutations: KvMutation[] = [
                {
                    key: getTodoKey(id),
                    value: await encodeTodoData(getTodoKey(id), newTodo),
                    version: -1  // New key
                },
                {
                    key: TODO_INDEX_KEY,
                    value: await encodeTodoData(TODO_INDEX_KEY, mergedIndex),
                    version: indexVersion
                }
            ];

            const result = await kvMutate(credentials, mutations);

            if (result.success) {
                // Update versions
                const newVersions = { ...versions };
                for (const res of result.results) {
                    newVersions[res.key] = res.version;
                }

                storage.getState().applyTodos({
                    todos: { ...todos, [id]: newTodo },
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo add failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            handleTodoMutationFailure(error, 'Failed to sync new todo:', priorState);
        }
    });

    return id;
}

/**
 * Update a todo's title
 */
export async function updateTodoTitle(
    credentials: AuthCredentials,
    id: string,
    title: string
): Promise<void> {
    const currentState = storage.getState();
    const priorState = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };
    const { todos, undoneOrder, doneOrder, versions } = priorState;

    const todo = todos[id];
    if (!todo) {
        console.error(`Todo ${id} not found`);
        return;
    }

    const updatedTodo: TodoItem = {
        ...todo,
        title,
        updatedAt: Date.now()
    };

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [id]: updatedTodo },
        undoneOrder,
        doneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            const context = await resolveTodoAccountStorageContext(credentials);
            // Fetch current todo from backend with version
            const todoKey = getTodoKey(id);
            const todoResponse = await kvGet(credentials, todoKey);

            if (!todoResponse) {
                // Todo doesn't exist on backend, create it
                const encodeTodoData = await createTodoDataEncoder(context);
                const encrypted = await encodeTodoData(todoKey, updatedTodo);
                const newVersion = await kvSet(credentials, todoKey, encrypted, -1);

                // Update version
                const newVersions = { ...versions };
                newVersions[todoKey] = newVersion;

                storage.getState().applyTodos({
                    todos: { ...todos, [id]: updatedTodo },
                    undoneOrder,
                    doneOrder,
                    versions: newVersions
                });
            } else {
                // Merge with server version - only update if title actually changed
                const serverTodo = await decryptTodoItem(todoKey, todoResponse.value, context);

                // Merge: keep server data but update title and timestamp
                const mergedTodo: TodoItem = {
                    ...serverTodo,
                    title,
                    updatedAt: Date.now()
                };

                // Only write if something changed
                if (serverTodo.title !== title) {
                    const encodeTodoData = await createTodoDataEncoder(context);
                    const encrypted = await encodeTodoData(todoKey, mergedTodo);
                    const newVersion = await kvSet(credentials, todoKey, encrypted, todoResponse.version);

                    // Update version
                    const newVersions = { ...versions };
                    newVersions[todoKey] = newVersion;

                    storage.getState().applyTodos({
                        todos: { ...todos, [id]: mergedTodo },
                        undoneOrder,
                        doneOrder,
                        versions: newVersions
                    });
                } else {
                    // No change needed, just update version
                    const newVersions = { ...versions };
                    newVersions[todoKey] = todoResponse.version;

                    storage.getState().applyTodos({
                        todos: { ...todos, [id]: serverTodo },
                        undoneOrder,
                        doneOrder,
                        versions: newVersions
                    });
                }
            }
        } catch (error) {
            handleTodoMutationFailure(error, 'Failed to update todo title:', priorState);
        }
    });
}

/**
 * Toggle a todo's done status (dedicated mutation for done/undone)
 * When marking as done, adds to the beginning of completedOrder
 */
export async function toggleTodo(
    credentials: AuthCredentials,
    id: string
): Promise<void> {
    const currentState = storage.getState();
    const priorState = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };
    const { todos, undoneOrder, doneOrder, versions } = priorState;

    const todo = todos[id];
    if (!todo) {
        console.error(`Todo ${id} not found`);
        return;
    }

    const now = Date.now();
    const updatedTodo: TodoItem = {
        ...todo,
        done: !todo.done,
        updatedAt: now,
        completedAt: !todo.done ? now : undefined  // Set completedAt when marking as done
    };

    // Calculate new orders optimistically
    let optimisticUndoneOrder = [...undoneOrder];
    let optimisticDoneOrder = [...doneOrder];

    if (updatedTodo.done) {
        // Moving to done - remove from undone, add to beginning of done
        optimisticUndoneOrder = optimisticUndoneOrder.filter(tid => tid !== id);
        optimisticDoneOrder = [id, ...optimisticDoneOrder.filter(tid => tid !== id)];
    } else {
        // Moving to undone - remove from done, add to end of undone
        optimisticDoneOrder = optimisticDoneOrder.filter(tid => tid !== id);
        optimisticUndoneOrder = [...optimisticUndoneOrder.filter(tid => tid !== id), id];
    }

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [id]: updatedTodo },
        undoneOrder: optimisticUndoneOrder,
        doneOrder: optimisticDoneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            const context = await resolveTodoAccountStorageContext(credentials);
            // Fetch current todo and index from backend
            const todoKey = getTodoKey(id);
            const [todoResponse, indexResponse] = await Promise.all([
                kvGet(credentials, todoKey),
                kvGet(credentials, TODO_INDEX_KEY)
            ]);

            // Prepare todo for backend
            let serverTodo = updatedTodo;
            let todoVersion = -1;

            if (todoResponse) {
                todoVersion = todoResponse.version;
                const existingTodo = await decryptTodoItem(todoKey, todoResponse.value, context);
                serverTodo = {
                    ...existingTodo,
                    done: updatedTodo.done,
                    updatedAt: now,
                    completedAt: updatedTodo.done ? now : undefined
                };
            }

            // Prepare index for backend
            let currentIndex: TodoIndex = { undoneOrder: [], completedOrder: [] };
            let indexVersion = -1;

            if (indexResponse) {
                indexVersion = indexResponse.version;
                currentIndex = await decryptTodoIndex(indexResponse.value, context);
            }

            // Update index based on new done status
            let newUndoneOrder = (currentIndex.undoneOrder || []).filter(tid => tid !== id);
            let newCompletedOrder = (currentIndex.completedOrder || []).filter(tid => tid !== id);

            if (serverTodo.done) {
                // When marking as done, add to beginning of completed list
                newCompletedOrder = [id, ...newCompletedOrder];
            } else {
                // When marking as undone, add to end of undone list
                newUndoneOrder = [...newUndoneOrder, id];
            }

            const mergedIndex: TodoIndex = {
                undoneOrder: newUndoneOrder,
                completedOrder: newCompletedOrder
            };

            // Write both todo and index
            const encodeTodoData = await createTodoDataEncoder(context);
            const mutations: KvMutation[] = [
                {
                    key: todoKey,
                    value: await encodeTodoData(todoKey, serverTodo),
                    version: todoVersion
                },
                {
                    key: TODO_INDEX_KEY,
                    value: await encodeTodoData(TODO_INDEX_KEY, mergedIndex),
                    version: indexVersion
                }
            ];

            const result = await kvMutate(credentials, mutations);

            if (result.success) {
                // Update versions
                const newVersions = { ...versions };
                for (const res of result.results) {
                    newVersions[res.key] = res.version;
                }

                storage.getState().applyTodos({
                    todos: { ...todos, [id]: serverTodo },
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo toggle failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            handleTodoMutationFailure(error, 'Failed to toggle todo:', priorState);
        }
    });
}

export type TodoSessionLinkIntent = Readonly<{
    source: Omit<ZenTaskSource, 'title'> & Readonly<{ title?: string }>;
    session: Readonly<{ scope: ServerAccountScope; sessionId: string }>;
}>;

export { TodoSessionLinkError };

/** Apply one accepted Session to the current task, never a captured replacement map. */
export async function applyTodoSessionLinkIntent(credentials: AuthCredentials, intent: TodoSessionLinkIntent,
    options: Readonly<{ signal?: AbortSignal; request?: ServerFetch }> = {}): Promise<void> {
    const [{ captureActiveServerAccountScopeLifetime }, { getActiveServerSnapshot }, { serverFetch }] = await Promise.all([
        import('@/sync/domains/scope/activeServerAccountScope'),
        import('@/sync/domains/server/serverRuntime'),
        import('@/sync/http/client'),
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
    const request: ServerFetch = (path, init, requestOptions) => {
        requireCurrent();
        return (options.request ?? serverFetch)(path, { ...init, ...(options.signal ? { signal: options.signal } : {}) }, { ...requestOptions, expectedActiveServer: { serverId: snapshot.serverId, generation: snapshot.generation } });
    };
    try {
        await todoLock.inLock(async () => {
            requireCurrent();
            const context = await resolveTodoAccountStorageContext(credentials, { request });
            requireCurrent();
            const key = getTodoKey(intent.source.taskId);
            const encode = await createTodoDataEncoder(context);
            await applyTodoSessionLinkV1({ scope: intent.source.scope, taskId: intent.source.taskId,
                session: { ...intent.session.scope, sessionId: intent.session.sessionId } }, {
                read: async () => {
                    const row = await kvGet(credentials, key, { request, retry: 'none' });
                    return { value: row ? await decryptTodoItem(key, row.value, context) : null, version: row?.version ?? -1 };
                },
                compareAndSet: async (item, version) => {
                    const value = await encode(key, item);
                    requireCurrent();
                    const result = await kvMutate(credentials, [{ key, value, version }], { request, retry: 'none' });
                    requireCurrent();
                    if (result.success) return { success: true, version: result.results[0]!.version };
                    const conflict = result.errors.find(error => error.key === key);
                    if (!conflict) throw new TodoSessionLinkError('task_link_failed');
                    return { success: false, value: conflict.value === null ? null : await decryptTodoItem(key, conflict.value, context), version: conflict.version };
                },
            }, { requireCurrent, title: intent.source.title,
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
 * Delete a todo
 */
export async function deleteTodo(
    credentials: AuthCredentials,
    id: string
): Promise<void> {
    const currentState = storage.getState();
    const priorState = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };
    const { todos, undoneOrder, doneOrder, versions } = priorState;

    if (!(id in todos)) {
        console.error(`Todo ${id} not found`);
        return;
    }

    // Remove from state optimistically
    const { [id]: deletedTodo, ...remainingTodos } = todos;
    const optimisticUndoneOrder = undoneOrder.filter(tid => tid !== id);
    const optimisticDoneOrder = doneOrder.filter(tid => tid !== id);

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: remainingTodos,
        undoneOrder: optimisticUndoneOrder,
        doneOrder: optimisticDoneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            const context = await resolveTodoAccountStorageContext(credentials);
            // Fetch current index from backend
            const todoKey = getTodoKey(id);
            const [indexResponse, todoResponse] = await Promise.all([
                kvGet(credentials, TODO_INDEX_KEY),
                kvGet(credentials, todoKey),
            ]);
            let currentIndex: TodoIndex = { undoneOrder: [], completedOrder: [] };
            let indexVersion = -1;

            if (indexResponse) {
                indexVersion = indexResponse.version;
                currentIndex = await decryptTodoIndex(indexResponse.value, context);
            }
            if (todoResponse) {
                await decryptTodoItem(todoKey, todoResponse.value, context);
            }

            // Remove todo from server's index
            const mergedIndex: TodoIndex = {
                undoneOrder: (currentIndex.undoneOrder || []).filter((tid: string) => tid !== id),
                completedOrder: (currentIndex.completedOrder || []).filter((tid: string) => tid !== id)
            };

            // Get todo version for deletion
            const todoVersion = todoResponse?.version ?? versions[todoKey] ?? 0;

            // Delete todo and update index
            const encodeTodoData = await createTodoDataEncoder(context);
            const mutations: KvMutation[] = [
                {
                    key: todoKey,
                    value: null,  // Delete
                    version: todoVersion
                },
                {
                    key: TODO_INDEX_KEY,
                    value: await encodeTodoData(TODO_INDEX_KEY, mergedIndex),
                    version: indexVersion
                }
            ];

            const result = await kvMutate(credentials, mutations);

            if (result.success) {
                // Update versions
                const newVersions = { ...versions };
                delete newVersions[todoKey];  // Remove deleted key version
                for (const res of result.results) {
                    if (res.key === TODO_INDEX_KEY) {
                        newVersions[res.key] = res.version;
                    }
                }

                storage.getState().applyTodos({
                    todos: remainingTodos,
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo delete failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            handleTodoMutationFailure(error, 'Failed to delete todo:', priorState);
        }
    });
}

/**
 * Reorder todos
 */
export class TodoReorderError extends Error {
    constructor(readonly code: 'todo_reorder_stale' | 'todo_reorder_conflict' | 'todo_reorder_scope_changed') {
        super(code);
        this.name = 'TodoReorderError';
    }
}

/** Reorder only current undone membership. Completion has its own toggle owner. */
export async function reorderTodos(
    credentials: AuthCredentials,
    todoId: string,
    position: AnchoredListPositionV1,
    options: Readonly<{ request?: ServerFetch; isCurrent?: () => boolean; signal?: AbortSignal }> = {},
): Promise<void> {
    const requireCurrent = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) {
            throw new TodoReorderError('todo_reorder_scope_changed');
        }
    };
    requireCurrent();
    await todoLock.inLock(async () => {
        requireCurrent();
        const context = await resolveTodoAccountStorageContext(credentials, { request: options.request });
        requireCurrent();
        const indexResponse = await kvGet(credentials, TODO_INDEX_KEY, { request: options.request, retry: 'none' });
        requireCurrent();
        if (!indexResponse) throw new TodoReorderError('todo_reorder_stale');
        const index = await decryptTodoIndex(indexResponse.value, context);
        const order = resolveAnchoredListMoveV1(index.undoneOrder, todoId, position);
        if (!order) throw new TodoReorderError('todo_reorder_stale');
        const source = await kvGet(credentials, getTodoKey(todoId), { request: options.request, retry: 'none' });
        requireCurrent();
        if (!source || (await decryptTodoItem(getTodoKey(todoId), source.value, context)).done) {
            throw new TodoReorderError('todo_reorder_stale');
        }
        if (position.anchorId !== null && position.anchorId !== todoId) {
            const anchor = await kvGet(credentials, getTodoKey(position.anchorId), { request: options.request, retry: 'none' });
            requireCurrent();
            if (!anchor || (await decryptTodoItem(getTodoKey(position.anchorId), anchor.value, context)).done) {
                throw new TodoReorderError('todo_reorder_stale');
            }
        }
        requireCurrent();
        if (order.every((id, offset) => id === index.undoneOrder[offset])) return;
        const encode = await createTodoDataEncoder(context);
        const value = await encode(TODO_INDEX_KEY, { ...index, undoneOrder: order });
        requireCurrent();
        const result = await kvMutate(credentials, [{
            key: TODO_INDEX_KEY, value, version: indexResponse.version,
        }], { request: options.request, retry: 'none' });
        if (!result.success) throw new TodoReorderError('todo_reorder_conflict');
        // Publish through the current local membership, never the pre-await snapshot.
        // A completed/deleted local source or anchor cannot be recreated by the acknowledgement.
        // Retirement suppresses publication, not the already-confirmed successful save.
        if (options.signal?.aborted || options.isCurrent?.() === false) return;
        const current = storage.getState().todoState;
        if (!current) return;
        const eligible = current.undoneOrder.filter(id => current.todos[id] && !current.todos[id]!.done);
        const localOrder = resolveAnchoredListMoveV1(eligible, todoId, position);
        if (!localOrder) return;
        storage.getState().applyTodos({
            ...current,
            undoneOrder: localOrder,
            versions: { ...current.versions, [TODO_INDEX_KEY]: result.results.find(row => row.key === TODO_INDEX_KEY)!.version },
        });
    });
}
