type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

export function normalizeWriteInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const filePath =
        typeof out.file_path === 'string' && out.file_path.trim().length > 0
            ? out.file_path.trim()
            : typeof out.filePath === 'string' && out.filePath.trim().length > 0
                ? out.filePath.trim()
                : typeof (out as any).filepath === 'string' && (out as any).filepath.trim().length > 0
                    ? (out as any).filepath.trim()
                : typeof out.path === 'string' && out.path.trim().length > 0
                    ? out.path.trim()
                    : null;
    if (filePath) out.file_path = filePath;

    const content =
        typeof out.content === 'string'
            ? out.content
            : typeof out.text === 'string'
                ? out.text
                : typeof out.data === 'string'
                    ? out.data
                    : typeof out.newText === 'string'
                        ? out.newText
                        : null;
    if (content != null && typeof out.content !== 'string') out.content = content;

    return out;
}
