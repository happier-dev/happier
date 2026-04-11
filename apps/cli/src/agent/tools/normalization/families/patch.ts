import { normalizePatchInputRecord } from '@happier-dev/protocol/tools/v2';

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
        if (filePaths) {
            const normalizedChanges: Record<string, unknown> = {};
            for (const filePath of filePaths) {
                normalizedChanges[filePath] = { delete: { content: '' }, type: 'delete' };
            }
            return { ...record, changes: normalizedChanges };
        }

        const patchText =
            firstNonEmptyString((record as any).patchText) ??
            firstNonEmptyString((record as any).patch_text) ??
            firstNonEmptyString((record as any).patch);
        if (patchText) {
            return normalizePatchInputRecord(record);
        }

        return normalizePatchInputRecord(record);
    }

    return normalizePatchInputRecord(record);
}
