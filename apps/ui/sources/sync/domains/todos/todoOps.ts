import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import {
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import { decodeBase64 } from '@/encryption/base64';
import { storage } from '@/sync/domains/state/storage';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import {
    kvGet,
    kvList,
    kvMutate,
    kvSet,
    type KvMutation,
} from '@/sync/api/account/apiKv';
import { randomUUID } from '@/platform/randomUUID';
import { AsyncLock } from '@/utils/system/lock';
import {
    fetchAccountEncryptionCurrentness,
} from '@/sync/api/account/apiAccountEncryptionMode';
import {
    requireCurrentAccountStoredContentServerCompatibility,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';
import {
    decodeTodoStoredContent,
    encodeTodoStoredContent,
    isTodoStoredContentUnavailableError,
    TodoStoredContentUnavailableError,
    TODO_INDEX_KEY,
    TODO_PREFIX,
    type TodoIndex,
    type TodoItem,
} from './todoStoredContent';
import {
    resolveAccountScopedCryptoMaterialFromCredentials,
} from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

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

type TodoRawDecryption = Readonly<{
    decryptRaw: (value: string) => Promise<unknown>;
}>;

type TodoRawEncryption = TodoRawDecryption & Readonly<{
    encryptRaw: (value: unknown) => Promise<string>;
}>;

export type TodoAccountStorageContext = Readonly<{
    mode: 'plain' | 'e2ee';
    encryption: TodoRawDecryption | null;
}>;

function readAccountEncryption(): TodoRawEncryption | null {
    const sync = getSyncSingleton() as Readonly<{
        encryption?: {
            encryptRaw: (value: unknown) => Promise<string>;
            decryptRaw: (value: string) => Promise<unknown>;
        } | null;
    }>;
    return sync.encryption ?? null;
}

function isTodoRawEncryption(
    value: TodoRawDecryption | null,
): value is TodoRawEncryption {
    return value !== null && 'encryptRaw' in value;
}

export async function resolveTodoAccountStorageContext(
    credentials: AuthCredentials,
    options: Readonly<{
        encryption?: TodoAccountStorageContext['encryption'];
    }> = {},
): Promise<TodoAccountStorageContext> {
    let currentness: Awaited<
        ReturnType<typeof fetchAccountEncryptionCurrentness>
    >;
    try {
        currentness = await fetchAccountEncryptionCurrentness(credentials);
    } catch (error) {
        throw new TodoStoredContentUnavailableError(
            TODO_INDEX_KEY,
            'account_currentness_unavailable',
            error,
        );
    }
    const encryption = options.encryption === undefined
        ? readAccountEncryption()
        : options.encryption;
    if (currentness.mode === 'plain') {
        return { mode: 'plain', encryption };
    }

    if (!encryption || !currentness.contentKeyFingerprint) {
        throw new TodoStoredContentUnavailableError(
            TODO_INDEX_KEY,
            'account_currentness_unavailable',
        );
    }
    try {
        const material = resolveAccountScopedCryptoMaterialFromCredentials(
            credentials,
        );
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material,
            ...(isDataKeyAuthCredentials(credentials)
                ? {
                    dataKeyPublicKey: decodeBase64(
                        credentials.encryption.publicKey,
                        'base64',
                    ),
                }
                : {}),
        });
        if (
            convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                snapshot.contentPublicKeyFingerprint,
            )
                !== currentness.contentKeyFingerprint
        ) {
            throw new Error('Account content-key fingerprint mismatch');
        }
    } catch (error) {
        throw new TodoStoredContentUnavailableError(
            TODO_INDEX_KEY,
            'account_currentness_unavailable',
            error,
        );
    }
    return { mode: 'e2ee', encryption };
}

async function createTodoDataEncoder(
    context: TodoAccountStorageContext,
): Promise<(key: string, data: unknown) => Promise<string>> {
    if (context.mode === 'plain') {
        await requireCurrentAccountStoredContentServerCompatibility();
    }
    const encryption = isTodoRawEncryption(context.encryption)
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
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<TodoState> {
    const context = await resolveTodoAccountStorageContext(credentials);
    // Fetch all KV items with todo prefix
    const response = await kvList(credentials, {
        prefix: TODO_PREFIX,
        limit: 1000,  // Should be enough for todos
        ...(opts.retry ? { retry: opts.retry } : {}),
    });

    const state: TodoState = {
        todos: {},
        undoneOrder: [],
        doneOrder: [],  // Will be mapped from completedOrder
        versions: {}
    };

    // Process each item
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
    try {
        const todoState = await fetchTodos(credentials);
        storage.getState().applyTodos(todoState);
    } catch (error) {
        if (isTodoStoredContentUnavailableError(error)) {
            throw error;
        }
        console.error('Failed to initialize todo sync:', error);
        // Initialize with empty state on error
        storage.getState().applyTodos({
            todos: {},
            undoneOrder: [],
            doneOrder: [],
            versions: {}
        });
    }
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

/**
 * Update a todo's linked sessions
 */
export async function updateTodoLinkedSessions(
    taskId: string,
    linkedSessions: TodoItem['linkedSessions']
): Promise<void> {
    const auth = (await import('@/auth/context/AuthContext')).getCurrentAuth();
    if (!auth?.credentials) {
        console.error('No auth credentials available');
        return;
    }

    const currentState = storage.getState();
    const priorState = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };
    const { todos, undoneOrder, doneOrder, versions } = priorState;

    const todo = todos[taskId];
    if (!todo) {
        console.error(`Todo ${taskId} not found`);
        return;
    }

    const updatedTodo: TodoItem = {
        ...todo,
        linkedSessions,
        updatedAt: Date.now()
    };

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [taskId]: updatedTodo },
        undoneOrder,
        doneOrder,
        versions
    });

    // Sync to server inside lock
    await todoLock.inLock(async () => {
        try {
            if (!auth.credentials) {
                console.error('No credentials available for sync');
                return;
            }
            const context = await resolveTodoAccountStorageContext(
                auth.credentials,
            );

            const todoKey = getTodoKey(taskId);
            const todoResponse = await kvGet(auth.credentials, todoKey);

            if (todoResponse) {
                const serverTodo = await decryptTodoItem(todoKey, todoResponse.value, context);
                const mergedTodo: TodoItem = {
                    ...serverTodo,
                    linkedSessions,
                    updatedAt: updatedTodo.updatedAt,
                };
                const encodeTodoData = await createTodoDataEncoder(context);
                const encrypted = await encodeTodoData(todoKey, mergedTodo);
                const newVersion = await kvSet(auth.credentials, todoKey, encrypted, todoResponse.version);

                // Update version
                const newVersions = { ...versions };
                newVersions[todoKey] = newVersion;

                storage.getState().applyTodos({
                    todos: { ...todos, [taskId]: mergedTodo },
                    undoneOrder,
                    doneOrder,
                    versions: newVersions
                });
            } else {
                // Todo doesn't exist on backend, create it
                const encodeTodoData = await createTodoDataEncoder(context);
                const encrypted = await encodeTodoData(todoKey, updatedTodo);
                const newVersion = await kvSet(auth.credentials, todoKey, encrypted, -1);

                // Update version
                const newVersions = { ...versions };
                newVersions[todoKey] = newVersion;

                storage.getState().applyTodos({
                    todos: { ...todos, [taskId]: updatedTodo },
                    undoneOrder,
                    doneOrder,
                    versions: newVersions
                });
            }
        } catch (error) {
            handleTodoMutationFailure(error, 'Failed to sync linked sessions update:', priorState);
        }
    });
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
export async function reorderTodos(
    credentials: AuthCredentials,
    todoId: string,
    targetIndex: number,
    targetList: 'done' | 'undone'
): Promise<void> {
    const currentState = storage.getState();
    const priorState = currentState.todoState || {
        todos: {},
        undoneOrder: [],
        doneOrder: [],
        versions: {}
    };
    const { todos, undoneOrder, doneOrder, versions } = priorState;

    const todo = todos[todoId];
    if (!todo) {
        console.error(`Todo ${todoId} not found`);
        return;
    }

    let updatedTodo = todo;
    let optimisticUndoneOrder = [...undoneOrder];
    let optimisticDoneOrder = [...doneOrder];

    // Remove from current position
    optimisticUndoneOrder = optimisticUndoneOrder.filter(id => id !== todoId);
    optimisticDoneOrder = optimisticDoneOrder.filter(id => id !== todoId);

    // Add to new position
    if (targetList === 'done') {
        if (!todo.done) {
            updatedTodo = { ...todo, done: true, updatedAt: Date.now() };
        }
        optimisticDoneOrder.splice(targetIndex, 0, todoId);
    } else {
        if (todo.done) {
            updatedTodo = { ...todo, done: false, updatedAt: Date.now() };
        }
        optimisticUndoneOrder.splice(targetIndex, 0, todoId);
    }

    // Apply optimistic update immediately
    storage.getState().applyTodos({
        todos: { ...todos, [todoId]: updatedTodo },
        undoneOrder: optimisticUndoneOrder,
        doneOrder: optimisticDoneOrder,
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

            // Apply reordering to server's index
            let newUndoneOrder = (currentIndex.undoneOrder || []).filter((id: string) => id !== todoId);
            let newCompletedOrder = (currentIndex.completedOrder || []).filter((id: string) => id !== todoId);

            // Insert at target position
            if (targetList === 'done') {
                // Ensure targetIndex is valid for the server's list
                const validIndex = Math.min(targetIndex, newCompletedOrder.length);
                newCompletedOrder.splice(validIndex, 0, todoId);
            } else {
                // Ensure targetIndex is valid for the server's list
                const validIndex = Math.min(targetIndex, newUndoneOrder.length);
                newUndoneOrder.splice(validIndex, 0, todoId);
            }

            const mergedIndex: TodoIndex = {
                undoneOrder: newUndoneOrder,
                completedOrder: newCompletedOrder
            };

            const mutations: KvMutation[] = [];
            const encodeTodoData = await createTodoDataEncoder(context);

            // If todo status changed, fetch and update it
            if (updatedTodo.done !== todo.done) {
                const todoKey = getTodoKey(todoId);
                const todoResponse = await kvGet(credentials, todoKey);
                let todoVersion = -1;
                let serverTodo = updatedTodo;

                if (todoResponse) {
                    todoVersion = todoResponse.version;
                    const existingTodo = await decryptTodoItem(todoKey, todoResponse.value, context);
                    serverTodo = {
                        ...existingTodo,
                        done: updatedTodo.done,
                        updatedAt: Date.now()
                    };
                }

                mutations.push({
                    key: todoKey,
                    value: await encodeTodoData(todoKey, serverTodo),
                    version: todoVersion
                });

                // Update local reference for final storage update
                updatedTodo = serverTodo;
            }

            // Always update index
            mutations.push({
                key: TODO_INDEX_KEY,
                value: await encodeTodoData(TODO_INDEX_KEY, mergedIndex),
                version: indexVersion
            });

            const result = await kvMutate(credentials, mutations);

            if (result.success) {
                // Update versions
                const newVersions = { ...versions };
                for (const res of result.results) {
                    newVersions[res.key] = res.version;
                }

                storage.getState().applyTodos({
                    todos: { ...todos, [todoId]: updatedTodo },
                    undoneOrder: mergedIndex.undoneOrder,
                    doneOrder: mergedIndex.completedOrder,  // Map completedOrder to doneOrder
                    versions: newVersions
                });
            } else {
                // On failure, refetch everything as last resort
                console.error('Todo reorder failed, refetching all todos...');
                await initializeTodoSync(credentials);
            }
        } catch (error) {
            handleTodoMutationFailure(error, 'Failed to reorder todos:', priorState);
        }
    });
}
