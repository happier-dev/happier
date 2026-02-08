type UnknownRecord = Record<string, unknown>;

import { splitUnifiedDiffByFile } from '@happier-dev/protocol';

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stripDiffPrefix(path: string): string {
    return path.replace(/^(a|b)\//, '');
}

function extractFilePathFromDiffBlock(block: string): string | null {
    const lines = block.split('\n');
    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const parts = line.split(/\s+/).slice(2);
            if (parts.length >= 2) {
                const candidate = parts[1] ?? '';
                if (candidate && candidate !== '/dev/null') return stripDiffPrefix(candidate);
            }
        }
        if (line.startsWith('+++ ')) {
            const candidate = (line.slice('+++ '.length).split('\t')[0] ?? '').trim();
            if (candidate && candidate !== '/dev/null') return stripDiffPrefix(candidate);
        }
        if (line.startsWith('--- ')) {
            const candidate = (line.slice('--- '.length).split('\t')[0] ?? '').trim();
            if (candidate && candidate !== '/dev/null') return stripDiffPrefix(candidate);
        }
    }
    return null;
}

function deriveFiles(unifiedDiff: string): Array<{ file_path?: string; unified_diff: string }> {
    return splitUnifiedDiffByFile(unifiedDiff).map((block) => {
        const filePath = extractFilePathFromDiffBlock(block);
        return filePath ? { file_path: filePath, unified_diff: block } : { unified_diff: block };
    });
}

export function normalizeDiffInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput);
    if (!record) {
        const diff = firstNonEmptyString(rawInput);
        if (!diff) return { value: rawInput };
        return { unified_diff: diff, files: deriveFiles(diff) };
    }

    const existingFiles = Array.isArray(record.files) ? record.files : null;

    const unified = firstNonEmptyString(record.unified_diff) ?? firstNonEmptyString(record.unifiedDiff) ?? null;
    if (unified) return { ...record, unified_diff: unified, files: existingFiles ?? deriveFiles(unified) };

    const diff = firstNonEmptyString(record.diff) ?? firstNonEmptyString(record.patch) ?? null;
    if (diff) return { ...record, unified_diff: diff, files: existingFiles ?? deriveFiles(diff) };

    return { ...record };
}
