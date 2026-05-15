import type { ReducerState } from '../reducer';

type SessionTodoStatus = 'pending' | 'in_progress' | 'completed';
type SessionTodoPriority = 'high' | 'medium' | 'low';

export type ClaudeTaskListTodo = {
    content: string;
    status: SessionTodoStatus;
    priority: SessionTodoPriority;
    id: string;
};

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizeStatus(value: unknown): SessionTodoStatus | 'deleted' | null {
    if (value === 'deleted') return 'deleted';
    if (value === 'completed' || value === 'complete') return 'completed';
    if (value === 'in_progress' || value === 'active' || value === 'running') return 'in_progress';
    if (value === 'pending') return 'pending';
    return null;
}

function normalizePriority(value: unknown): SessionTodoPriority {
    return value === 'high' || value === 'low' || value === 'medium' ? value : 'medium';
}

function readTaskTitle(record: Record<string, unknown>): string | null {
    return (
        readString(record.subject)
        ?? readString(record.title)
        ?? readString(record.content)
        ?? readString(record.description)
        ?? readString(record.activeForm)
    );
}

function readJsonValue(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first < 0 || last <= first) return null;
        try {
            return JSON.parse(text.slice(first, last + 1));
        } catch {
            return null;
        }
    }
}

function readToolResultPayloads(value: unknown): readonly unknown[] {
    const payloads: unknown[] = [];
    const block = readRecord(value);
    if (block?.tool_use_result !== undefined) payloads.push(block.tool_use_result);
    if (block?.toolUseResult !== undefined) payloads.push(block.toolUseResult);

    const content = block ? block.content : value;
    if (typeof content === 'string') {
        payloads.push(...[readJsonValue(content), content].filter((entry) => entry !== null));
    } else if (Array.isArray(content)) {
        payloads.push(...content.flatMap((entry): unknown[] => {
            const record = readRecord(entry);
            if (!record) return [entry];
            const text = readString(record.text);
            if (text) return [readJsonValue(text), text].filter((value) => value !== null);
            return [record];
        }));
    } else if (content !== undefined && content !== null) {
        payloads.push(content);
    }
    return payloads;
}

function readTaskRecordsFromPayload(payload: unknown): readonly unknown[] {
    const record = readRecord(payload);
    if (!record) return [];
    const snakeResult = readRecord(record.tool_use_result);
    if (snakeResult) return readTaskRecordsFromPayload(snakeResult);
    const camelResult = readRecord(record.toolUseResult);
    if (camelResult) return readTaskRecordsFromPayload(camelResult);
    if (Array.isArray(record.tasks)) return record.tasks;
    const task = readRecord(record.task);
    return task ? [task] : [];
}

function normalizeTaskRecord(record: unknown, fallbackId: string | null): ClaudeTaskListTodo | null {
    const task = readRecord(record);
    if (!task) return null;
    const status = normalizeStatus(task.status);
    if (status === 'deleted') return null;
    const id = readString(task.id) ?? readString(task.taskId) ?? fallbackId;
    if (!id) return null;
    const content = readTaskTitle(task) ?? id;
    return {
        id,
        content,
        status: status ?? 'pending',
        priority: normalizePriority(task.priority),
    };
}

function publishTaskTodos(state: ReducerState, timestamp: number): void {
    state.latestTodos = {
        todos: [...state.claudeTaskToolTodos.values()],
        timestamp,
    };
}

function upsertTaskTodo(state: ReducerState, todo: ClaudeTaskListTodo, timestamp: number): void {
    const previous = state.claudeTaskToolTodos.get(todo.id);
    state.claudeTaskToolTodos.set(todo.id, {
        ...(previous ?? {}),
        ...todo,
        status: todo.status ?? previous?.status ?? 'pending',
        priority: todo.priority ?? previous?.priority ?? 'medium',
    });
    publishTaskTodos(state, timestamp);
}

export function applyClaudeTaskToolUseTodos(params: Readonly<{
    state: ReducerState;
    toolName: string;
    toolUseId: string;
    input: unknown;
    timestamp: number;
}>): void {
    if (params.toolName === 'TaskList') {
        params.state.claudeTaskListToolUseIds.add(params.toolUseId);
        return;
    }

    if (params.toolName === 'TaskCreate') {
        const todo = normalizeTaskRecord(params.input, `tool_use:${params.toolUseId}`);
        if (!todo) return;
        params.state.claudeTaskCreateToolUseIdToTodoId.set(params.toolUseId, todo.id);
        upsertTaskTodo(params.state, todo, params.timestamp);
        return;
    }

    if (params.toolName !== 'TaskUpdate') return;
    const input = readRecord(params.input);
    const taskId = readString(input?.taskId);
    if (!taskId || !input) return;
    if (normalizeStatus(input.status) === 'deleted') {
        params.state.claudeTaskToolTodos.delete(taskId);
        publishTaskTodos(params.state, params.timestamp);
        return;
    }
    const todo = normalizeTaskRecord(input, taskId);
    if (!todo) return;
    upsertTaskTodo(params.state, todo, params.timestamp);
}

export function applyClaudeTaskToolResultTodos(params: Readonly<{
    state: ReducerState;
    toolUseId: string;
    result: unknown;
    timestamp: number;
}>): void {
    const records = readToolResultPayloads(params.result).flatMap(readTaskRecordsFromPayload);
    if (records.length === 0) return;

    const todos = records.flatMap((record): ClaudeTaskListTodo[] => {
        const todo = normalizeTaskRecord(record, null);
        return todo ? [todo] : [];
    });
    if (todos.length === 0) return;

    if (params.state.claudeTaskListToolUseIds.delete(params.toolUseId)) {
        params.state.claudeTaskToolTodos.clear();
    }

    const provisionalId = params.state.claudeTaskCreateToolUseIdToTodoId.get(params.toolUseId);
    const provisionalTodo = provisionalId ? params.state.claudeTaskToolTodos.get(provisionalId) : undefined;
    if (provisionalId) {
        params.state.claudeTaskCreateToolUseIdToTodoId.delete(params.toolUseId);
        params.state.claudeTaskToolTodos.delete(provisionalId);
    }

    for (const todo of todos) {
        const previous = params.state.claudeTaskToolTodos.get(todo.id) ?? provisionalTodo;
        params.state.claudeTaskToolTodos.set(todo.id, {
            ...(previous ?? {}),
            ...todo,
            status: todo.status ?? previous?.status ?? 'pending',
            priority: todo.priority ?? previous?.priority ?? 'medium',
        });
    }

    publishTaskTodos(params.state, params.timestamp);
}
