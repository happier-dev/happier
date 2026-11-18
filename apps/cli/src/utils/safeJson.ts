type DescribeError = (value: object) => Record<string, unknown> | undefined;

function describeJsonError(value: object): Record<string, unknown> | undefined {
    if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
    }

    const record = value as Record<string, unknown>;
    if (typeof record.stack === 'string' && record.stack) {
        return { name: record.name, message: record.message, stack: record.stack };
    }
}

export function safeJsonStringify(value: unknown, space?: number, describeError: DescribeError = describeJsonError): string {
    // Only objects on the current path are cycles; siblings can share ordinary data.
    const ancestors = new Set<object>();

    function project(value: unknown, key: string): unknown {
        if (typeof value === 'bigint') return `${value.toString()}n`;
        if (typeof value === 'function') return undefined;
        if (value === null || typeof value !== 'object') return value;
        if (ancestors.has(value)) return '[Circular]';

        ancestors.add(value);
        try {
            // JSON.stringify calls toJSON before its replacer. Describe errors first so
            // transport errors never serialize request configuration or live sockets.
            let data: unknown = describeError(value) ?? value;
            if (data === value) {
                const { toJSON } = value as { toJSON?: unknown };
                if (typeof toJSON === 'function') {
                    data = Reflect.apply(toJSON, value, [key]);
                    if (data && typeof data === 'object' && data !== value) {
                        data = describeError(data) ?? data;
                    }
                }
            }

            if (data === null || typeof data !== 'object') return project(data, key);
            if (Array.isArray(data)) return data.map((item, index) => project(item, String(index)));
            return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, project(item, key)]));
        } finally {
            ancestors.delete(value);
        }
    }

    return JSON.stringify(project(value, ''), null, space);
}
