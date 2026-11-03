import { z } from 'zod/mini';
import { TodoItemV1Schema, TodoItemV1StoredSchema, TodoIndexV1Schema, TodoIndexV1StoredSchema } from '@happier-dev/protocol/todos/todoSessionLinkV1';
import { TODO_LABEL_CATALOG_KEY_V1, TodoLabelCatalogV1Schema, TodoLabelCatalogV1StoredSchema, type TodoLabelCatalogV1 } from '@happier-dev/protocol/todos/todoSessionLinkV1';

import {
    AccountStoredJsonContentEncryptionMaterialUnavailableError,
    AccountStoredJsonContentModeMismatchError,
    decodeAccountStoredJsonContent,
    encodeAccountStoredJsonContent,
} from '@/sync/encryption/accountStoredJsonContent';

export const TODO_PREFIX = 'todo.';
export const TODO_INDEX_KEY = 'todo.index';

export const TodoItemSchema = TodoItemV1Schema;

export const TodoIndexSchema = TodoIndexV1Schema;

export type TodoItem = z.infer<typeof TodoItemSchema>;
export type TodoIndex = z.infer<typeof TodoIndexSchema>;
const TodoIndexStoredSchema = TodoIndexV1StoredSchema;

type RawAccountEncryption = Readonly<{
    encryptRaw: (value: unknown) => Promise<string>;
    decryptRaw: (value: string) => Promise<unknown>;
}>;

export type TodoStoredContentUnavailableReason =
    | 'encryption_material_unavailable'
    | 'account_currentness_unavailable'
    | 'account_mode_mismatch'
    | 'content_unreadable'
    | 'schema_invalid';

export class TodoStoredContentUnavailableError extends Error {
    readonly code = 'todo_stored_content_unavailable';

    constructor(
        readonly key: string,
        readonly reason: TodoStoredContentUnavailableReason,
        readonly cause?: unknown,
    ) {
        super(`Todo stored content is unavailable for ${key}`);
        this.name = 'TodoStoredContentUnavailableError';
    }
}

export function isTodoStoredContentUnavailableError(
    error: unknown,
): error is TodoStoredContentUnavailableError {
    return error instanceof Error
        && (error as { code?: unknown }).code === 'todo_stored_content_unavailable';
}

/** A stored row the Account cipher refused, whichever module instance of its error class raised it. */
export function isAccountStoredContentFailure(error: unknown): boolean {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code === 'account_stored_json_mode_mismatch'
        || code === 'account_stored_json_encryption_material_unavailable'
        || code === 'account_kv_content_unreadable';
}

export function toTodoStoredContentUnavailableError(key: string, error: unknown): TodoStoredContentUnavailableError {
    if (isTodoStoredContentUnavailableError(error)) return error;
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return new TodoStoredContentUnavailableError(key,
        error instanceof AccountStoredJsonContentModeMismatchError || code === 'account_stored_json_mode_mismatch'
            ? 'account_mode_mismatch'
            : error instanceof AccountStoredJsonContentEncryptionMaterialUnavailableError || code === 'account_stored_json_encryption_material_unavailable'
                ? 'encryption_material_unavailable' : 'content_unreadable', error);
}

export type DecodedTodoStoredContent =
    | Readonly<{ kind: 'index'; value: TodoIndex }>
    | Readonly<{ kind: 'labelCatalog'; value: TodoLabelCatalogV1 }>
    | Readonly<{ kind: 'item'; todoId: string; value: TodoItem }>;

function resolveTodoKey(key: string):
    | Readonly<{ kind: 'index' }>
    | Readonly<{ kind: 'labelCatalog' }>
    | Readonly<{ kind: 'item'; todoId: string }> {
    if (key === TODO_LABEL_CATALOG_KEY_V1) return { kind: 'labelCatalog' };
    if (key === TODO_INDEX_KEY) {
        return { kind: 'index' };
    }

    const todoId = key.startsWith(TODO_PREFIX)
        ? key.slice(TODO_PREFIX.length)
        : '';
    if (!todoId || todoId === 'index') {
        throw new TodoStoredContentUnavailableError(key, 'schema_invalid');
    }
    return { kind: 'item', todoId };
}

export function parseTodoStoredContent(
    key: string,
    value: unknown,
    storedRead = false,
): DecodedTodoStoredContent {
    const resolvedKey = resolveTodoKey(key);
    if (resolvedKey.kind === 'labelCatalog') {
        const parsed = (storedRead ? TodoLabelCatalogV1StoredSchema : TodoLabelCatalogV1Schema).safeParse(value);
        if (!parsed.success) throw new TodoStoredContentUnavailableError(key, 'schema_invalid', parsed.error);
        return { kind: 'labelCatalog', value: parsed.data };
    }
    if (resolvedKey.kind === 'index') {
        const parsed = (storedRead ? TodoIndexStoredSchema : TodoIndexSchema).safeParse(value);
        if (!parsed.success) {
            throw new TodoStoredContentUnavailableError(
                key,
                'schema_invalid',
                parsed.error,
            );
        }
        return { kind: 'index', value: parsed.data };
    }

    const parsed = (storedRead ? TodoItemV1StoredSchema : TodoItemSchema).safeParse(value);
    if (!parsed.success || parsed.data.id !== resolvedKey.todoId) {
        throw new TodoStoredContentUnavailableError(
            key,
            'schema_invalid',
            parsed.success ? undefined : parsed.error,
        );
    }
    return {
        kind: 'item',
        todoId: resolvedKey.todoId,
        value: parsed.data,
    };
}

export async function decodeTodoStoredContent(params: Readonly<{
    key: string;
    encoded: string;
    expectedMode: 'plain' | 'e2ee';
    encryption: Pick<RawAccountEncryption, 'decryptRaw'> | null;
}>): Promise<DecodedTodoStoredContent> {
    let value: unknown;
    try {
        value = await decodeAccountStoredJsonContent({
            encoded: params.encoded,
            encryption: params.encryption,
            expectedMode: params.expectedMode,
        });
    } catch (error) {
        throw toTodoStoredContentUnavailableError(params.key, error);
    }

    return parseTodoStoredContent(params.key, value, true);
}

export async function encodeTodoStoredContent(params: Readonly<{
    key: string;
    mode: 'plain' | 'e2ee';
    value: unknown;
    encryption: RawAccountEncryption | null;
}>): Promise<string> {
    const content = parseTodoStoredContent(params.key, params.value);
    try {
        return await encodeAccountStoredJsonContent({
            mode: params.mode,
            value: content.value,
            encryption: params.encryption,
        });
    } catch (error) {
        throw new TodoStoredContentUnavailableError(
            params.key,
            error instanceof AccountStoredJsonContentEncryptionMaterialUnavailableError
                ? 'encryption_material_unavailable'
                : 'content_unreadable',
            error,
        );
    }
}
