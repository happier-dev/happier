type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function asNonEmptyRecord(value: unknown): UnknownRecord | null {
    const record = asRecord(value);
    if (!record) return null;
    return Object.keys(record).length > 0 ? record : null;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNonEmptyStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out = value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    return out.length > 0 ? out : null;
}

function normalizeSinglePatchChange(raw: unknown): UnknownRecord {
    const record = asRecord(raw);
    if (!record) return { value: raw };

    const type = firstNonEmptyString(record.type)?.toLowerCase() ?? null;
    const content = firstNonEmptyString(record.content);
    const unifiedDiff = firstNonEmptyString((record as any).unified_diff) ?? firstNonEmptyString((record as any).unifiedDiff);
    const oldContent =
        firstNonEmptyString(record.old_content) ??
        firstNonEmptyString(record.oldContent) ??
        null;
    const newContent =
        firstNonEmptyString(record.new_content) ??
        firstNonEmptyString(record.newContent) ??
        null;

    // Keep the original record keys for debugging; add normalized fields when possible.
    const next: UnknownRecord = { ...record };

    if (type === 'add' && content) {
        next.add = { content };
        return next;
    }

    if ((type === 'update' || type === 'modify') && oldContent && newContent) {
        next.modify = { old_content: oldContent, new_content: newContent };
        return next;
    }

    if ((type === 'update' || type === 'modify') && unifiedDiff) {
        const parsed = parseUnifiedDiffPreview(unifiedDiff);
        if (parsed.oldText.length > 0 || parsed.newText.length > 0) {
            next.modify = { old_content: parsed.oldText, new_content: parsed.newText };
            return next;
        }
    }

    if (type === 'delete' || type === 'remove') {
        next.delete = { content: content ?? oldContent ?? '' };
        return next;
    }

    // Unknown / insufficient information — return as-is.
    return next;
}

function parseUnifiedDiffPreview(unifiedDiff: string): { oldText: string; newText: string } {
    const lines = unifiedDiff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let inHunk = false;

    for (const line of lines) {
        if (line.startsWith('@@')) {
            inHunk = true;
            continue;
        }
        if (!inHunk) continue;

        if (line.startsWith('+')) {
            newLines.push(line.substring(1));
        } else if (line.startsWith('-')) {
            oldLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
            oldLines.push(line.substring(1));
            newLines.push(line.substring(1));
        } else if (line === '\\ No newline at end of file') {
            continue;
        } else if (line === '') {
            oldLines.push('');
            newLines.push('');
        }
    }

    let oldText = oldLines.join('\n');
    let newText = newLines.join('\n');
    if (oldText.endsWith('\n')) oldText = oldText.slice(0, -1);
    if (newText.endsWith('\n')) newText = newText.slice(0, -1);
    return { oldText, newText };
}

export function normalizePatchResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const trimmed = rawOutput.trim();
        if (trimmed.length === 0) return {};
        return { message: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const stdout = typeof (record as any).stdout === 'string' ? (record as any).stdout : undefined;
    const stderr = typeof (record as any).stderr === 'string' ? (record as any).stderr : undefined;
    const success =
        typeof (record as any).success === 'boolean'
            ? (record as any).success
            : typeof (record as any).ok === 'boolean'
                ? (record as any).ok
                : typeof (record as any).applied === 'boolean'
                    ? (record as any).applied
                    : undefined;

    const out: UnknownRecord = { ...record };
    if (typeof success === 'boolean') out.applied = success;
    if (stdout != null) out.stdout = stdout;
    if (stderr != null) out.stderr = stderr;

    if (out.applied === false && (out as any).errorMessage == null) {
        const err =
            (typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim() : null) ??
            (typeof (record as any).error === 'string' && String((record as any).error).trim().length > 0
                ? String((record as any).error).trim()
                : null) ??
            (typeof stdout === 'string' && stdout.trim().length > 0 ? stdout.trim() : null);
        if (err) (out as any).errorMessage = err;
    }
    return out;
}

export function normalizePatchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput);
    if (!record) return { changes: {}, value: rawInput };

    const changes = asNonEmptyRecord(record.changes);
    if (!changes) {
        // Some providers emit a standalone delete tool (e.g. Auggie) with file_paths.
        // Normalize it into a Patch changes map so the UI can reuse the Patch renderer.
        const filePaths = asNonEmptyStringArray((record as any).file_paths);
        if (!filePaths) return { ...record };

        const normalizedChanges: Record<string, unknown> = {};
        for (const filePath of filePaths) {
            normalizedChanges[filePath] = { delete: { content: '' }, type: 'delete' };
        }
        return { ...record, changes: normalizedChanges };
    }

    const normalizedChanges: Record<string, unknown> = {};
    for (const [path, change] of Object.entries(changes)) {
        normalizedChanges[path] = normalizeSinglePatchChange(change);
    }

    return { ...record, changes: normalizedChanges };
}
