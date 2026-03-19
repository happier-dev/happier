type DragEventLike = Readonly<{
    dataTransfer?: Readonly<{ types?: unknown }> | null;
}>;

function hasContains(types: unknown): types is Readonly<{ contains: (value: string) => boolean }> {
    return typeof (types as any)?.contains === 'function';
}

function isStringIterable(types: unknown): types is Iterable<string> {
    return typeof (types as any)?.[Symbol.iterator] === 'function';
}

export function isWebFileDragEvent(event: DragEventLike): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    if (hasContains(types)) {
        return types.contains('Files');
    }
    if (Array.isArray(types)) {
        return types.includes('Files');
    }
    if (isStringIterable(types)) {
        return Array.from(types).includes('Files');
    }
    return false;
}
