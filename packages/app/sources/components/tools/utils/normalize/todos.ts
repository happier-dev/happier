import { asRecord, firstNonEmptyString } from './_shared';

type TodoItem = { content?: string; status?: string; priority?: string; id?: string };

function normalizeTodoStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | null {
    if (typeof value !== 'string') return null;
    const s = value.trim().toLowerCase();
    if (s === 'pending' || s === 'todo') return 'pending';
    if (s === 'in_progress' || s === 'in-progress' || s === 'doing') return 'in_progress';
    if (s === 'completed' || s === 'done') return 'completed';
    return null;
}

function coerceTodoItemForRendering(value: unknown): TodoItem | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return { content: value.trim(), status: 'pending' };
    }
    const record = asRecord(value);
    if (!record) return null;

    const content =
        firstNonEmptyString((record as any).content) ??
        firstNonEmptyString((record as any).title) ??
        firstNonEmptyString((record as any).text) ??
        null;
    if (!content) return null;

    const status = normalizeTodoStatus((record as any).status) ?? normalizeTodoStatus((record as any).state) ?? 'pending';
    const next: TodoItem = { content, status };

    const priority = firstNonEmptyString((record as any).priority);
    if (priority) next.priority = priority;
    const id = firstNonEmptyString((record as any).id);
    if (id) next.id = id;

    return next;
}

function normalizeTodoListForRendering(value: unknown): TodoItem[] | null {
    if (!Array.isArray(value)) return null;
    const out: TodoItem[] = [];
    for (const item of value) {
        const coerced = coerceTodoItemForRendering(item);
        if (!coerced) continue;
        out.push(coerced);
    }
    return out;
}

export function normalizeTodoInputForRendering(input: Record<string, unknown>): Record<string, unknown> | null {
    if (Array.isArray((input as any).todos)) return null;

    const candidates =
        Array.isArray((input as any).items)
            ? (input as any).items
            : Array.isArray((input as any)._acp?.rawInput)
                ? (input as any)._acp.rawInput
                : null;
    if (!candidates) return null;

    const todos = normalizeTodoListForRendering(candidates) ?? [];
    return { ...input, todos };
}

export function normalizeTodoResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    const todosFromRecord = Array.isArray((record as any)?.todos) ? (record as any).todos : null;
    const todosFromNew = record && Array.isArray((record as any).newTodos) ? (record as any).newTodos : null;

    const current = todosFromRecord ?? todosFromNew;
    if (current) {
        const normalized = normalizeTodoListForRendering(current);
        if (!normalized) return null;
        return { ...record, todos: normalized };
    }

    if (Array.isArray(result)) {
        const normalized = normalizeTodoListForRendering(result) ?? [];
        return { todos: normalized };
    }

    return null;
}

