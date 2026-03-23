import type { PendingNormalizedToolChange } from './normalizedToolChangeTypes';

function readStringField(input: Record<string, unknown>, keys: string | readonly string[]): string | null {
    const candidates = Array.isArray(keys) ? keys : [keys];
    for (const key of candidates) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return null;
}

function readEditArray(input: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
    const value = input.edits;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

function normalizeChangeToolName(toolName: string): string {
    const trimmed = toolName.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (lower === 'diff') return 'Diff';
    if (lower === 'edit') return 'Edit';
    if (lower === 'write') return 'Write';
    if (lower === 'multiedit') return 'MultiEdit';
    if (lower === 'notebookedit') return 'NotebookEdit';
    return trimmed;
}

function readCanonicalDiffFiles(input: Record<string, unknown>): ReadonlyArray<Readonly<{
    filePath: string;
    unifiedDiff?: string;
    oldText?: string;
    newText?: string;
    description?: string;
}>> {
    const rawFiles = input.files;
    if (!Array.isArray(rawFiles)) return [];
    return rawFiles
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .flatMap((entry) => {
            const filePath = readStringField(entry, ['file_path', 'filePath', 'path']);
            if (!filePath) return [];
            return [{
                filePath,
                unifiedDiff: typeof entry.unified_diff === 'string' ? entry.unified_diff : undefined,
                oldText: typeof entry.oldText === 'string' ? entry.oldText : typeof entry.old_text === 'string' ? entry.old_text : undefined,
                newText: typeof entry.newText === 'string' ? entry.newText : typeof entry.new_text === 'string' ? entry.new_text : undefined,
                description: typeof entry.description === 'string' ? entry.description : undefined,
            }];
        });
}

export function buildPlaceholderUnifiedDiff(filePath: string, description: string): string {
    return [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -0,0 +0,0 @@`,
        `# ${description}`,
    ].join('\n');
}

export function derivePendingNormalizedToolChange(
    toolName: string,
    input: Record<string, unknown>,
): PendingNormalizedToolChange | null {
    const normalizedToolName = normalizeChangeToolName(toolName);

    if (normalizedToolName === 'Diff') {
        const files = readCanonicalDiffFiles(input);
        if (files.length === 0) return null;
        return {
            kind: 'canonical-diff',
            files,
        };
    }

    if (normalizedToolName === 'Edit') {
        const filePath = readStringField(input, ['file_path', 'filePath', 'path']);
        const oldText = typeof input.old_string === 'string' ? input.old_string : null;
        const newText = typeof input.new_string === 'string' ? input.new_string : null;
        if (!filePath || oldText == null || newText == null) return null;
        return {
            kind: 'text-diff',
            filePath,
            oldText,
            newText,
        };
    }

    if (normalizedToolName === 'Write') {
        const filePath = readStringField(input, ['file_path', 'filePath', 'path']);
        if (!filePath) return null;
        return {
            kind: 'placeholder-diff',
            filePath,
            description: 'Write',
        };
    }

    if (normalizedToolName === 'MultiEdit') {
        const filePath = readStringField(input, ['file_path', 'filePath', 'path']);
        if (!filePath) return null;
        const edits = readEditArray(input);
        if (edits.length === 1) {
            const first = edits[0];
            const oldText = typeof first.old_string === 'string'
                ? first.old_string
                : typeof first.oldText === 'string'
                    ? first.oldText
                    : null;
            const newText = typeof first.new_string === 'string'
                ? first.new_string
                : typeof first.newText === 'string'
                    ? first.newText
                    : null;
            if (oldText != null && newText != null) {
                return {
                    kind: 'text-diff',
                    filePath,
                    oldText,
                    newText,
                    description: 'MultiEdit',
                };
            }
        }
        return {
            kind: 'placeholder-diff',
            filePath,
            description: `MultiEdit (${edits.length || 'unknown'} edits)`,
        };
    }

    if (normalizedToolName === 'NotebookEdit') {
        const filePath = readStringField(input, ['notebook_path', 'notebookPath']) ?? readStringField(input, ['file_path', 'filePath', 'path']);
        if (!filePath) return null;
        return {
            kind: 'placeholder-diff',
            filePath,
            description: 'NotebookEdit',
        };
    }

    return null;
}
