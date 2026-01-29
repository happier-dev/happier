type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

export type TaskOperation = 'run' | 'create' | 'list' | 'update' | 'unknown';

function inferTaskOperation(opts: { rawToolName: string; input: UnknownRecord | null }): TaskOperation {
    const raw = opts.rawToolName.toLowerCase();
    if (raw === 'taskcreate' || raw.endsWith(':taskcreate') || raw.includes('taskcreate')) return 'create';
    if (raw === 'tasklist' || raw.endsWith(':tasklist') || raw.includes('tasklist')) return 'list';
    if (raw === 'taskupdate' || raw.endsWith(':taskupdate') || raw.includes('taskupdate')) return 'update';
    if (raw === 'task') return 'run';

    const input = opts.input;
    if (input) {
        if (typeof (input as any).subject === 'string') return 'create';
        if (typeof (input as any).taskId === 'string' || typeof (input as any).taskId === 'number') return 'update';
        if (typeof (input as any).status === 'string' && typeof (input as any).taskId !== 'undefined') return 'update';
        if (typeof (input as any).prompt === 'string') return 'run';
        if (typeof (input as any).description === 'string') return 'run';
    }

    if (raw.startsWith('task')) return 'run';
    return 'unknown';
}

export function normalizeTaskInput(rawToolName: string, rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput);
    const operation = inferTaskOperation({ rawToolName, input: record });
    if (!record) return { operation, value: rawInput };
    return { operation, ...record };
}

function coerceTextFromContentBlocks(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as UnknownRecord;
        if (typeof rec.text === 'string') parts.push(rec.text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

export function normalizeTaskResult(rawOutput: unknown): UnknownRecord {
    if (Array.isArray(rawOutput)) {
        const fromBlocks = coerceTextFromContentBlocks(rawOutput);
        if (fromBlocks) return { content: fromBlocks };
        return { tasks: rawOutput };
    }

    if (typeof rawOutput === 'string') {
        const trimmed = rawOutput.trim();
        if (trimmed.length === 0) return {};
        return { content: rawOutput };
    }

    const fromBlocks = coerceTextFromContentBlocks(rawOutput);
    if (fromBlocks) return { content: fromBlocks };

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const nested = coerceTextFromContentBlocks((record as any).content);
    if (nested) return { ...record, content: nested };

    const tasks = (record as any).tasks;
    if (Array.isArray(tasks)) return { ...record, tasks };

    return { ...record };
}
