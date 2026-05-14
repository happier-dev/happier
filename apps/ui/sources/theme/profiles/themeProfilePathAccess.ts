export type ThemeProfilePathSegment = string | number;
export type ThemeProfilePath = readonly ThemeProfilePathSegment[];

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readPathNode = (source: unknown, path: ThemeProfilePath): unknown => {
    let current: unknown = source;

    for (const segment of path) {
        if (Array.isArray(current) && typeof segment === 'number') {
            current = current[segment];
            continue;
        }

        if (isRecord(current) && typeof segment === 'string') {
            current = current[segment];
            continue;
        }

        return undefined;
    }

    return current;
};

export const readThemeProfilePathValue = (source: unknown, path: ThemeProfilePath): string | undefined => {
    const value = readPathNode(source, path);
    return typeof value === 'string' ? value : undefined;
};

const writePathNode = (source: unknown, path: ThemeProfilePath, index: number, value: string): unknown => {
    const segment = path[index];
    const isTerminal = index === path.length - 1;

    if (Array.isArray(source) && typeof segment === 'number') {
        const next = [...source];
        next[segment] = isTerminal ? value : writePathNode(source[segment], path, index + 1, value);
        return next;
    }

    if (isRecord(source) && typeof segment === 'string') {
        return {
            ...source,
            [segment]: isTerminal ? value : writePathNode(source[segment], path, index + 1, value),
        };
    }

    return source;
};

export const setThemeProfilePathValue = <TSource>(source: TSource, path: ThemeProfilePath, value: string): TSource => {
    if (path.length === 0 || readThemeProfilePathValue(source, path) === undefined) {
        return source;
    }

    return writePathNode(source, path, 0, value) as TSource;
};
