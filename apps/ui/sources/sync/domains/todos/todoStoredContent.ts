import { z } from 'zod';
import { TodoItemV1Schema, TodoSessionLinkInputV1Schema } from '@happier-dev/protocol/todos/todoSessionLinkV1';

import {
    AccountStoredJsonContentEncryptionMaterialUnavailableError,
    AccountStoredJsonContentModeMismatchError,
    decodeAccountStoredJsonContent,
    encodeAccountStoredJsonContent,
} from '@/sync/encryption/accountStoredJsonContent';

export const TODO_PREFIX = 'todo.';
export const TODO_INDEX_KEY = 'todo.index';

export const ZenTaskSourceSchema = z.object({
    kind: z.literal('zen_task'),
    taskId: z.string().min(1),
    title: z.string(),
    scope: TodoSessionLinkInputV1Schema.shape.scope,
}).strict();

/** Local draft custody; never part of the synchronized authoring document. */
export type ZenTaskSource = z.infer<typeof ZenTaskSourceSchema>;

export const TodoItemSchema = TodoItemV1Schema;

export const TodoIndexSchema = z.object({
    undoneOrder: z.array(z.string()),
    completedOrder: z.array(z.string()),
}).strict();

export type TodoItem = z.infer<typeof TodoItemSchema>;
export type TodoIndex = z.infer<typeof TodoIndexSchema>;

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

export type DecodedTodoStoredContent =
    | Readonly<{ kind: 'index'; value: TodoIndex }>
    | Readonly<{ kind: 'item'; todoId: string; value: TodoItem }>;

function resolveTodoKey(key: string):
    | Readonly<{ kind: 'index' }>
    | Readonly<{ kind: 'item'; todoId: string }> {
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

function parseTodoStoredContent(
    key: string,
    value: unknown,
): DecodedTodoStoredContent {
    const resolvedKey = resolveTodoKey(key);
    if (resolvedKey.kind === 'index') {
        const parsed = TodoIndexSchema.safeParse(value);
        if (!parsed.success) {
            throw new TodoStoredContentUnavailableError(
                key,
                'schema_invalid',
                parsed.error,
            );
        }
        return { kind: 'index', value: parsed.data };
    }

    const parsed = TodoItemSchema.safeParse(value);
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
        if (isTodoStoredContentUnavailableError(error)) {
            throw error;
        }
        throw new TodoStoredContentUnavailableError(
            params.key,
            error instanceof AccountStoredJsonContentModeMismatchError
                ? 'account_mode_mismatch'
                : error instanceof AccountStoredJsonContentEncryptionMaterialUnavailableError
                ? 'encryption_material_unavailable'
                : 'content_unreadable',
            error,
        );
    }

    return parseTodoStoredContent(params.key, value);
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
