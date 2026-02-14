import { diffLines } from 'diff';

import { splitUnifiedDiffByFile } from './splitUnifiedDiffByFile';

export type DiffFileEntry = {
    key: string;
    filePath?: string;
    unifiedDiff?: string;
    oldText?: string;
    newText?: string;
    added: number;
    removed: number;
    kind?: 'new' | 'deleted' | 'renamed';
};

export type DiffBlockInput = {
    filePath?: string;
    unifiedDiff?: string;
    oldText?: string;
    newText?: string;
};

const MAX_TEXT_STATS_BYTES = 120_000;

function countLines(value: string): number {
    if (value.length === 0) return 0;
    const parts = value.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts.length;
}

function computeTextDiffStats(oldText: string, newText: string): { added: number; removed: number } {
    const totalBytes = oldText.length + newText.length;
    // Avoid expensive full-line diffing for large payloads in list/summary views.
    if (totalBytes > MAX_TEXT_STATS_BYTES) {
        const oldLines = countLines(oldText);
        const newLines = countLines(newText);
        return {
            added: Math.max(0, newLines - oldLines),
            removed: Math.max(0, oldLines - newLines),
        };
    }

    const changes = diffLines(oldText, newText);
    let added = 0;
    let removed = 0;
    for (const change of changes) {
        const value = typeof change.value === 'string' ? change.value : '';
        if (change.added) added += countLines(value);
        if (change.removed) removed += countLines(value);
    }
    return { added, removed };
}

function computeUnifiedDiffStats(unifiedDiff: string): { added: number; removed: number } {
    const lines = unifiedDiff.split('\n');
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff --git ')) continue;
        if (line.startsWith('@@')) continue;
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
}

function inferTextDiffKind(oldText: string, newText: string): 'new' | 'deleted' | undefined {
    const oldEmpty = oldText.trim().length === 0;
    const newEmpty = newText.trim().length === 0;
    if (oldEmpty && !newEmpty) return 'new';
    if (!oldEmpty && newEmpty) return 'deleted';
    return undefined;
}

function inferUnifiedDiffKind(unifiedDiff: string): 'new' | 'deleted' | 'renamed' | undefined {
    const lines = unifiedDiff.split('\n');
    for (const line of lines) {
        if (line.startsWith('new file mode')) return 'new';
        if (line.startsWith('deleted file mode')) return 'deleted';
        if (line.startsWith('rename from') || line.startsWith('rename to')) return 'renamed';
        if (line.startsWith('--- /dev/null')) return 'new';
        if (line.startsWith('+++ /dev/null')) return 'deleted';
    }
    return undefined;
}

export function parseUnifiedDiff(unifiedDiff: string): { oldText: string; newText: string; fileName?: string } {
    const lines = unifiedDiff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let fileName: string | undefined;
    let inHunk = false;

    for (const line of lines) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            fileName = line.replace(/^\+\+\+ (b\/)?/, '');
            continue;
        }

        if (
            line.startsWith('diff --git') ||
            line.startsWith('index ') ||
            line.startsWith('---') ||
            line.startsWith('new file mode') ||
            line.startsWith('deleted file mode')
        ) {
            continue;
        }

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

    return {
        oldText: oldLines.join('\n'),
        newText: newLines.join('\n'),
        fileName,
    };
}

export function normalizeDiffFileInputs(input: unknown): DiffBlockInput[] {
    if (!input || typeof input !== 'object') return [];
    const files = (input as any).files;
    if (!Array.isArray(files)) return [];

    return files
        .filter((file: unknown): file is Record<string, unknown> => Boolean(file) && typeof file === 'object' && !Array.isArray(file))
        .map((file: Record<string, unknown>): DiffBlockInput | null => {
            const filePath =
                typeof file.file_path === 'string' && file.file_path.trim()
                    ? file.file_path
                    : typeof file.filePath === 'string' && file.filePath.trim()
                        ? file.filePath
                        : undefined;
            const unified = typeof file.unified_diff === 'string' ? file.unified_diff : undefined;
            if (typeof unified === 'string' && unified.trim().length > 0) {
                return { unifiedDiff: String(unified), filePath } satisfies DiffBlockInput;
            }

            const oldText =
                typeof file.oldText === 'string'
                    ? file.oldText
                    : typeof file.old_text === 'string'
                        ? file.old_text
                        : undefined;
            const newText =
                typeof file.newText === 'string'
                    ? file.newText
                    : typeof file.new_text === 'string'
                        ? file.new_text
                        : undefined;
            if (typeof oldText === 'string' && typeof newText === 'string') {
                return { oldText, newText, filePath } satisfies DiffBlockInput;
            }
            return null;
        })
        .filter((v: DiffBlockInput | null): v is DiffBlockInput => v != null);
}

export function buildDiffBlocks(input: unknown): DiffBlockInput[] {
    const normalizedFiles = normalizeDiffFileInputs(input);
    if (normalizedFiles.length > 0) return normalizedFiles;

    const unifiedDiff =
        input && typeof input === 'object' && typeof (input as any).unified_diff === 'string'
            ? (input as any).unified_diff
            : '';
    if (!unifiedDiff) return [];

    return splitUnifiedDiffByFile(unifiedDiff).map((block) => ({ unifiedDiff: block, filePath: undefined } satisfies DiffBlockInput));
}

export function buildDiffFileEntries(blocks: DiffBlockInput[]): DiffFileEntry[] {
    return blocks
        .map((entry, idx) => {
            const unified = typeof entry.unifiedDiff === 'string' ? String(entry.unifiedDiff) : '';
            const oldText = typeof entry.oldText === 'string' ? String(entry.oldText) : undefined;
            const newText = typeof entry.newText === 'string' ? String(entry.newText) : undefined;

            const fileStats =
                unified.trim().length > 0
                    ? computeUnifiedDiffStats(unified)
                    : (typeof oldText === 'string' && typeof newText === 'string')
                        ? computeTextDiffStats(oldText, newText)
                        : { added: 0, removed: 0 };

            const filePath = entry.filePath ?? (unified ? parseUnifiedDiff(unified).fileName : undefined);
            const kind = unified ? inferUnifiedDiffKind(unified) : inferTextDiffKind(oldText ?? '', newText ?? '');
            return {
                key: `${filePath ?? 'unknown'}::${idx}`,
                filePath,
                unifiedDiff: unified.trim().length > 0 ? unified : undefined,
                oldText,
                newText,
                added: fileStats.added,
                removed: fileStats.removed,
                kind,
            };
        })
        .filter((entry) => Boolean((entry.unifiedDiff && entry.unifiedDiff.trim().length > 0) || (entry.oldText != null && entry.newText != null)));
}
