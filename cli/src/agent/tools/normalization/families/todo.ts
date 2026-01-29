type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function normalizeTodoStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | undefined {
    if (typeof value !== 'string') return undefined;
    const s = value.trim().toLowerCase();
    if (s === 'pending' || s === 'todo') return 'pending';
    if (s === 'in_progress' || s === 'in-progress' || s === 'doing') return 'in_progress';
    if (s === 'completed' || s === 'done') return 'completed';
    return undefined;
}

function coerceTodoItem(value: unknown): UnknownRecord | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return { content: value.trim(), status: 'pending' };
    }
    const record = asRecord(value);
    if (!record) return null;

    const content =
        typeof (record as any).content === 'string'
            ? String((record as any).content)
            : typeof (record as any).title === 'string'
                ? String((record as any).title)
                : typeof (record as any).text === 'string'
                    ? String((record as any).text)
                    : null;
    if (!content || content.trim().length === 0) return null;

    const status =
        normalizeTodoStatus((record as any).status)
        ?? normalizeTodoStatus((record as any).state)
        ?? 'pending';

    const out: UnknownRecord = { content: content.trim(), status };

    const priority =
        typeof (record as any).priority === 'string'
            ? String((record as any).priority)
            : undefined;
    if (priority) out.priority = priority;

    const id = typeof (record as any).id === 'string' ? String((record as any).id) : undefined;
    if (id) out.id = id;

    return out;
}

function coerceTodosArray(rawInput: unknown): UnknownRecord[] | null {
    const record = asRecord(rawInput);
    const direct =
        Array.isArray((record as any)?.todos)
            ? (record as any).todos
            : Array.isArray((record as any)?.items)
                ? (record as any).items
                : Array.isArray((record as any)?._acp?.rawInput)
                    ? (record as any)._acp.rawInput
                    : Array.isArray(rawInput)
                        ? rawInput
                        : null;

    if (!direct) return null;
    const out: UnknownRecord[] = [];
    for (const item of direct) {
        const coerced = coerceTodoItem(item);
        if (!coerced) continue;
        out.push(coerced);
    }
    return out;
}

export function normalizeTodoWriteInput(rawInput: unknown): UnknownRecord {
    const todos = coerceTodosArray(rawInput) ?? [];
    return { todos };
}

export function normalizeTodoReadInput(_rawInput: unknown): UnknownRecord {
    // TodoRead typically does not have meaningful input; keep the schema minimal.
    return {};
}

export function normalizeTodoResult(rawOutput: unknown): UnknownRecord {
    const record = asRecord(rawOutput);

    const newTodosCandidate = record && Array.isArray((record as any).newTodos) ? (record as any).newTodos : null;
    const todosCandidate =
        newTodosCandidate
        ?? (record && Array.isArray((record as any).todos) ? (record as any).todos : null)
        ?? (Array.isArray(rawOutput) ? rawOutput : null);

    const todos = coerceTodosArray(todosCandidate) ?? [];

    if (record) {
        return { ...record, todos };
    }

    if (todosCandidate == null && rawOutput != null) {
        return { todos, value: rawOutput };
    }

    return { todos };
}

