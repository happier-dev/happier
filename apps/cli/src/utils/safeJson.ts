export function createCircularSafeJsonReplacer(): (this: unknown, key: string, value: unknown) => unknown {
    // Only objects on the current path are cycles; the same object reached through siblings is shared data.
    const ancestors: object[] = [];
    return function (this: unknown, _key: string, value: unknown): unknown {
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
            while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
            if (ancestors.includes(value)) return '[Circular]';
            ancestors.push(value);

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
