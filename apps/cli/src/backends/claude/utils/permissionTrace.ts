const REDACT_KEYS = new Set([
    'content',
    'text',
    'old_string',
    'new_string',
    'oldText',
    'newText',
    'oldContent',
    'newContent',
]);

export function isClaudeToolTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = env.HAPPIER_STACK_TOOL_TRACE;
    return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function redactClaudePermissionTraceValue(value: unknown, key?: string): unknown {
    if (typeof value === 'string') {
        if (key && REDACT_KEYS.has(key)) return `[redacted ${value.length} chars]`;
        if (value.length <= 1_000) return value;
        return `${value.slice(0, 1_000)}…(truncated ${value.length - 1_000} chars)`;
    }

    if (typeof value !== 'object' || value === null) return value;

    if (Array.isArray(value)) {
        const sliced = value.slice(0, 50).map((entry) => redactClaudePermissionTraceValue(entry));
        if (value.length <= 50) return sliced;
        return [...sliced, `…(truncated ${value.length - 50} items)`];
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    const sliced = entries.slice(0, 200);
    for (const [entryKey, entryValue] of sliced) {
        out[entryKey] = redactClaudePermissionTraceValue(entryValue, entryKey);
    }
    if (entries.length > 200) out._truncatedKeys = entries.length - 200;
    return out;
}
