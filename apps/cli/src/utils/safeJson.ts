export function createCircularSafeJsonReplacer(): (key: string, value: unknown) => unknown {
    const seen = new WeakSet<object>();
    return (_key: string, value: unknown): unknown => {
        if (typeof value === 'bigint') {
            return `${value.toString()}n`;
        }

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack,
            };
        }

        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);

            const record = value as Record<string, unknown>;
            const stack = typeof record.stack === 'string' ? record.stack : undefined;
            const message = typeof record.message === 'string' ? record.message : undefined;
            const name = typeof record.name === 'string' ? record.name : undefined;
            if (stack) {
                return { name, message, stack };
            }
        }

        return value;
    };
}

export function safeJsonStringify(value: unknown, space?: number): string {
    return JSON.stringify(value, createCircularSafeJsonReplacer(), space);
}
