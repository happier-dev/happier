import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createServerFetchForActiveServer, type ServerFetch } from '@/sync/http/client';
import { AccountKvScopeRetiredError, openUiAccountKvJsonRow } from '@/sync/ops/account/accountKvJsonTransport';
import type { KvSocketChange } from '@/sync/engine/socket/kvUpdateDispatcher';
import { log } from '@/log';
import { storage } from '@/sync/domains/state/storage';
import {
    fetchTodos as fetchTodosDomain,
    resolveTodoAccountStorageContext,
} from '@/sync/domains/todos/todoOps';
import {
    parseTodoStoredContent,
    toTodoStoredContentUnavailableError,
    TODO_INDEX_KEY,
    TODO_PREFIX,
} from '@/sync/domains/todos/todoStoredContent';

type RawEncryption = {
    decryptRaw: (value: string) => Promise<unknown>;
};

export async function fetchTodos(params: {
    credentials: AuthCredentials;
    request?: ServerFetch;
    shouldContinue?: () => boolean;
}): Promise<void> {
    const { credentials } = params;
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;

    log.log('📝 Fetching todos...');
    const todoState = await fetchTodosDomain(credentials, {
        retry: 'none',
        request: params.request,
        shouldContinue,
    });
    if (!shouldContinue()) return;
    storage.getState().applyTodos(todoState);
    log.log('📝 Todos loaded');
}

export async function applyTodoSocketUpdates(params: {
    changes: KvSocketChange[];
    credentials: AuthCredentials;
    encryption: RawEncryption | null;
    invalidateTodosSync: () => void;
    request?: ServerFetch;
    shouldContinue?: () => boolean;
}): Promise<void> {
    const { changes, encryption, invalidateTodosSync } = params;
    const request = params.request ?? createServerFetchForActiveServer();
    const requireCurrent = () => {
        if (params.shouldContinue?.() === false) throw new AccountKvScopeRetiredError();
    };
    requireCurrent();
    const context = await resolveTodoAccountStorageContext(
        params.credentials,
        { encryption, request },
    );
    requireCurrent();

    const currentState = storage.getState();
    const todoState = currentState.todoState;
    if (!todoState) {
        // No todo state yet, just refetch
        invalidateTodosSync();
        return;
    }

    const { todos, undoneOrder, doneOrder, versions } = todoState;
    const updatedTodos = { ...todos };
    const updatedVersions = { ...versions };
    let newUndoneOrder = undoneOrder;
    let newDoneOrder = doneOrder;

    // Build the complete next snapshot before publishing any part of the batch.
    for (const change of changes) {
        const key = change.key;
        let opened;
        try {
            opened = await openUiAccountKvJsonRow({ credentials: params.credentials, row: change, context, request, requireCurrent });
        } catch (error) { throw toTodoStoredContentUnavailableError(key, error); }
        updatedVersions[key] = opened.version;
        if (opened.tombstone) {
            if (key.startsWith(TODO_PREFIX) && key !== TODO_INDEX_KEY) {
                const todoId = key.slice(TODO_PREFIX.length);
                delete updatedTodos[todoId];
                newUndoneOrder = newUndoneOrder.filter((id) => id !== todoId);
                newDoneOrder = newDoneOrder.filter((id) => id !== todoId);
            }
            continue;
        }

        const content = parseTodoStoredContent(key, opened.value, true);
        if (content.kind === 'index') {
            newUndoneOrder = content.value.undoneOrder;
            newDoneOrder = content.value.completedOrder;
        } else if (content.kind === 'item') {
            updatedTodos[content.todoId] = content.value;
        }
    }

    // Apply the updated state
    requireCurrent();
    storage.getState().applyTodos({
        todos: updatedTodos,
        undoneOrder: newUndoneOrder,
        doneOrder: newDoneOrder,
        versions: updatedVersions,
    });

    log.log('📝 Applied todo socket updates successfully');
}
