type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function coerceFirstItemDiff(items: unknown): UnknownRecord | null {
    if (!Array.isArray(items) || items.length === 0) return null;
    const first = items[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
    return first as UnknownRecord;
}

function coerceItemPath(item: UnknownRecord | null): string | null {
    if (!item) return null;
    const path =
        (typeof item.path === 'string' && item.path.trim().length > 0)
            ? item.path.trim()
            : (typeof item.filePath === 'string' && item.filePath.trim().length > 0)
                ? item.filePath.trim()
                : null;
    return path;
}

function coerceSingleLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length !== 1) return null;
    const first = locations[0];
    if (!first || typeof first !== 'object') return null;
    const obj = first as UnknownRecord;
    const path =
        (typeof obj.path === 'string' && obj.path.trim().length > 0)
            ? obj.path.trim()
            : (typeof obj.filePath === 'string' && obj.filePath.trim().length > 0)
                ? obj.filePath.trim()
                : null;
    return path;
}

function coerceItemText(item: UnknownRecord | null, key: 'old' | 'new'): string | null {
    if (!item) return null;
    const candidates =
        key === 'old'
            ? [item.oldText, item.old_string, item.oldString]
            : [item.newText, item.new_string, item.newString];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) return c;
    }
    return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
}

function parseJsonRecord(raw: string): UnknownRecord | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
        return asRecord(JSON.parse(trimmed));
    } catch {
        return null;
    }
}

function splitDiffLines(value: string): string[] {
    const lines = value.replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function diffHunkFromTexts(params: { beforeText: string; afterText: string; lineStart?: number }): string {
    const beforeLines = splitDiffLines(params.beforeText);
    const afterLines = splitDiffLines(params.afterText);
    const lineStart = typeof params.lineStart === 'number' && Number.isFinite(params.lineStart)
        ? Math.max(0, Math.floor(params.lineStart))
        : 0;
    const beforeLen = Math.max(1, beforeLines.length);
    const afterLen = Math.max(1, afterLines.length);

    const body = [
        ...beforeLines.map((line) => `-${line}`),
        ...afterLines.map((line) => `+${line}`),
    ];
    return [`@@ -${lineStart + 1},${beforeLen} +${lineStart + 1},${afterLen} @@`, ...body].join('\n');
}

function ensureMetadata(record: UnknownRecord): UnknownRecord {
    const metadata = asRecord(record.metadata);
    if (metadata) {
        record.metadata = metadata;
        return metadata;
    }
    const created: UnknownRecord = {};
    record.metadata = created;
    return created;
}

function buildDiffFromFileDiff(filediff: UnknownRecord): string | null {
    const filePath = firstNonEmptyString(filediff.file, filediff.path) ?? 'unknown-file';
    const beforeText = firstNonEmptyString(filediff.before, filediff.oldText, filediff.old_text);
    const afterText = firstNonEmptyString(filediff.after, filediff.newText, filediff.new_text);
    if (!beforeText && !afterText) return null;

    const hunk = diffHunkFromTexts({
        beforeText: beforeText ?? '',
        afterText: afterText ?? '',
    });
    return [`--- a/${filePath}`, `+++ b/${filePath}`, hunk].join('\n');
}

function buildDiffFromToolUseDiff(toolUseDiff: UnknownRecord): string | null {
    const path = firstNonEmptyString(toolUseDiff.path, toolUseDiff.file, toolUseDiff.file_path) ?? 'unknown-file';
    const rawEdits = Array.isArray(toolUseDiff.edits) ? toolUseDiff.edits : [];
    const hunks = rawEdits
        .map((rawEdit) => asRecord(rawEdit))
        .filter((edit): edit is UnknownRecord => !!edit)
        .map((edit) => {
            const beforeText = firstNonEmptyString(edit.before_text, edit.beforeText, edit.old_text, edit.oldText, edit.before);
            const afterText = firstNonEmptyString(edit.after_text, edit.afterText, edit.new_text, edit.newText, edit.after);
            if (!beforeText && !afterText) return null;
            const lineStart = typeof edit.line_start === 'number'
                ? edit.line_start
                : typeof edit.lineStart === 'number'
                    ? edit.lineStart
                    : undefined;
            return diffHunkFromTexts({
                beforeText: beforeText ?? '',
                afterText: afterText ?? '',
                lineStart,
            });
        })
        .filter((hunk): hunk is string => typeof hunk === 'string' && hunk.length > 0);

    if (hunks.length === 0) return null;
    return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n');
}

function enrichEditResultWithDiffMetadata(record: UnknownRecord): void {
    const metadata = ensureMetadata(record);
    const existingDiff = firstNonEmptyString(metadata.diff);
    if (existingDiff) return;

    const detailsDiff = firstNonEmptyString(asRecord(record.details)?.diff, asRecord(asRecord(record.output)?.details)?.diff);
    if (detailsDiff) {
        metadata.diff = detailsDiff;
        return;
    }

    const nestedOutputRecord = (() => {
        const outputValue = record.output;
        if (typeof outputValue === 'string') return parseJsonRecord(outputValue);
        return asRecord(outputValue);
    })();

    const metadataFileDiff = asRecord(metadata.filediff);
    const nestedOutputFileDiff = asRecord(asRecord(asRecord(record.output)?.metadata)?.filediff);
    const parsedNestedOutputFileDiff = asRecord(asRecord(nestedOutputRecord?.metadata)?.filediff);
    const fileDiff = metadataFileDiff ?? nestedOutputFileDiff ?? parsedNestedOutputFileDiff;
    if (fileDiff) {
        const diff = buildDiffFromFileDiff(fileDiff);
        if (diff) {
            metadata.diff = diff;
            return;
        }
    }

    const metrics = asRecord(record.metrics);
    const nestedMetrics = asRecord(nestedOutputRecord?.metrics);
    const toolUseDiff =
        asRecord(metrics?.tool_use_diff) ??
        asRecord(record.tool_use_diff) ??
        asRecord(nestedMetrics?.tool_use_diff) ??
        asRecord(nestedOutputRecord?.tool_use_diff);
    if (!toolUseDiff) return;
    const diff = buildDiffFromToolUseDiff(toolUseDiff);
    if (diff) metadata.diff = diff;
}

export function normalizeEditInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const firstItem = coerceFirstItemDiff(record.items);

    const filePath =
        (typeof record.file_path === 'string' && record.file_path.trim().length > 0)
            ? record.file_path.trim()
            : (typeof record.path === 'string' && record.path.trim().length > 0)
                ? record.path.trim()
                : (typeof record.filePath === 'string' && record.filePath.trim().length > 0)
                    ? record.filePath.trim()
                    : null;
    const fromItem = filePath ? null : coerceItemPath(firstItem);
    const fromLocations = filePath || fromItem ? null : coerceSingleLocationPath(record.locations);
    const normalizedPath = filePath ?? fromItem ?? fromLocations;
    if (normalizedPath) out.file_path = normalizedPath;

    const oldText =
        (typeof record.old_string === 'string' && record.old_string.trim().length > 0)
            ? record.old_string.trim()
            : (typeof record.oldText === 'string' && record.oldText.trim().length > 0)
                ? record.oldText.trim()
                : (typeof record.oldString === 'string' && record.oldString.trim().length > 0)
                    ? record.oldString.trim()
                    : coerceItemText(firstItem, 'old');
    const newText =
        (typeof record.new_string === 'string' && record.new_string.trim().length > 0)
            ? record.new_string.trim()
            : (typeof record.newText === 'string' && record.newText.trim().length > 0)
                ? record.newText.trim()
                : (typeof record.newString === 'string' && record.newString.trim().length > 0)
                    ? record.newString.trim()
                    : coerceItemText(firstItem, 'new');

    if (oldText) out.old_string = oldText;
    if (newText) out.new_string = newText;

    // Keep Gemini/Codex compatibility fields when present.
    if (typeof record.oldText === 'string' && record.oldText.trim().length > 0) out.oldText = record.oldText;
    if (typeof record.newText === 'string' && record.newText.trim().length > 0) out.newText = record.newText;

    const replaceAll = record.replace_all ?? record.replaceAll;
    if (typeof replaceAll === 'boolean') out.replace_all = replaceAll;

    return out;
}

export function normalizeEditResult(rawOutput: unknown): UnknownRecord {
    const record = typeof rawOutput === 'string'
        ? parseJsonRecord(rawOutput)
        : asRecord(rawOutput);
    if (typeof rawOutput === 'string' && !record) {
        const trimmed = rawOutput.trim();
        if (trimmed.length === 0) return {};
        return { message: rawOutput };
    }
    if (!record) return { value: rawOutput };

    const out: UnknownRecord = { ...record };
    const applied =
        typeof (record as any).applied === 'boolean'
            ? Boolean((record as any).applied)
            : typeof (record as any).success === 'boolean'
                ? Boolean((record as any).success)
                : typeof (record as any).ok === 'boolean'
                    ? Boolean((record as any).ok)
                    : undefined;
    if (typeof applied === 'boolean') out.applied = applied;

    if (typeof out.applied !== 'boolean') {
        const hasError = typeof (record as any).error === 'string' && (record as any).error.trim().length > 0;
        if (hasError) out.applied = false;
    }

    enrichEditResultWithDiffMetadata(out);

    return out;
}
