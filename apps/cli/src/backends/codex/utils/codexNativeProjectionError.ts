/** Report only a wire type identifier, never an item body, path, or control characters. */
export function codexNativeProjectionError(kind: 'user content' | 'transcript item', value: unknown): Error {
    const type = typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value) ? value : 'unknown';
    return new Error(`Codex native projection does not support ${kind} type '${type}'`);
}
