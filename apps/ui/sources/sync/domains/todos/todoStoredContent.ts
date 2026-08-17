import { z } from 'zod';

import {
    AccountStoredJsonContentEncryptionMaterialUnavailableError,
    decodeAccountStoredJsonContent,
    encodeAccountStoredJsonContent,
} from '@/sync/encryption/accountStoredJsonContent';
import {
    decodeBase64StoredJsonContentEnvelope,
} from '@/sync/encryption/base64StoredJsonContent';

export const TODO_PREFIX = 'todo.';
export const TODO_INDEX_KEY = 'todo.index';

const TodoLinkedSessionSchema = z.object({
    title: z.string(),
    linkedAt: z.number(),
}).strict();

export const TodoItemSchema = z.object({
    id: z.string().min(1),
    title: z.string(),
    done: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
    completedAt: z.number().optional(),
    linkedSessions: z.record(z.string(), TodoLinkedSessionSchema).optional(),
}).strict();

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
    const envelope = decodeBase64StoredJsonContentEnvelope(params.encoded);
    const storedMode = envelope?.t === 'plain' ? 'plain' : 'e2ee';
    if (storedMode !== params.expectedMode) {
        throw new TodoStoredContentUnavailableError(
            params.key,
            'account_mode_mismatch',
        );
    }

    let value: unknown;
    try {
        value = await decodeAccountStoredJsonContent({
            encoded: params.encoded,
            encryption: params.encryption,
        });
    } catch (error) {
        if (isTodoStoredContentUnavailableError(error)) {
            throw error;
        }
        throw new TodoStoredContentUnavailableError(
            params.key,
            error instanceof AccountStoredJsonContentEncryptionMaterialUnavailableError
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
