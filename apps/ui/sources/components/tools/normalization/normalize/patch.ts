import { hasNonEmptyRecord } from './_shared';

type PatchChangeRecord = Record<string, unknown>;

function stripDiffPrefix(path: string): string {
    return path.replace(/^(a\/|b\/)/, '');
}

function parseApplyPatchTextChanges(patchText: string): Record<string, unknown> | null {
    const lines = patchText.replace(/\r\n/g, '\n').split('\n');
    const changes: Record<string, unknown> = {};
    let currentFilePath: string | null = null;

    for (const line of lines) {
        const match = line.match(/^\*\*\*\s+(Update File|Add File|Delete File):\s+(.+)\s*$/);
        if (match) {
            const filePath = match[2]?.trim();
            if (!filePath) continue;

            const label = String(match[1]).toLowerCase();
            const type = label.startsWith('add') ? 'add' : label.startsWith('delete') ? 'delete' : 'update';
            changes[filePath] = { type };
            currentFilePath = filePath;
            continue;
        }

        const moveMatch = line.match(/^\*\*\*\s+Move to:\s+(.+)\s*$/);
        if (!moveMatch || !currentFilePath) continue;
        const movedPath = moveMatch[1]?.trim();
        if (!movedPath) continue;

        const change = changes[currentFilePath];
        if (!change) continue;
        delete changes[currentFilePath];
        changes[movedPath] = change;
        currentFilePath = movedPath;
    }

    return Object.keys(changes).length > 0 ? changes : null;
}

function parseUnifiedDiffFileBlock(unifiedDiff: string): {
    filePath: string | null;
    change: PatchChangeRecord | null;
} {
    const lines = unifiedDiff.split('\n');
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let isDelete = false;
    let isAdd = false;
    let inHunk = false;
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('deleted file mode')) {
            isDelete = true;
            continue;
        }
        if (line.startsWith('new file mode')) {
            isAdd = true;
            continue;
        }
        if (line.startsWith('--- ')) {
            const raw = line.replace(/^--- /, '');
            oldPath = raw === '/dev/null' ? '/dev/null' : stripDiffPrefix(raw);
            continue;
        }
        if (line.startsWith('+++ ')) {
            const raw = line.replace(/^\+\+\+ /, '');
            newPath = raw === '/dev/null' ? '/dev/null' : stripDiffPrefix(raw);
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

    const filePath =
        (newPath && newPath !== '/dev/null' ? newPath : oldPath && oldPath !== '/dev/null' ? oldPath : null) ?? null;
    if (!filePath) return { filePath: null, change: null };

    let oldText = oldLines.join('\n');
    let newText = newLines.join('\n');
    if (oldText.endsWith('\n')) oldText = oldText.slice(0, -1);
    if (newText.endsWith('\n')) newText = newText.slice(0, -1);

    const next: PatchChangeRecord = {};
    if (isDelete || newPath === '/dev/null') {
        next.type = 'delete';
        next.delete = { content: oldText };
    } else if (isAdd || oldPath === '/dev/null') {
        next.type = 'add';
        next.add = { content: newText };
    } else {
        next.type = 'update';
        next.modify = { old_content: oldText, new_content: newText };
    }

    return { filePath, change: next };
}

export function normalizeDiffAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof input.unified_diff === 'string' && input.unified_diff.trim().length > 0) return null;

    const diff = typeof input.diff === 'string' ? input.diff : typeof input.patch === 'string' ? input.patch : null;
    if (!diff || diff.trim().length === 0) return null;
    return { ...input, unified_diff: diff };
}

export function normalizePatchFromUnifiedDiff(input: Record<string, unknown>): Record<string, unknown> | null {
    if (hasNonEmptyRecord(input.changes)) return null;

    const diff =
        typeof input.unified_diff === 'string'
            ? input.unified_diff
            : typeof input.diff === 'string'
                ? input.diff
                : typeof input.patch === 'string'
                    ? input.patch
                    : typeof input['patchText'] === 'string'
                        ? (input['patchText'] as string)
                        : typeof input['patch_text'] === 'string'
                            ? (input['patch_text'] as string)
                            : null;
    if (!diff || diff.trim().length === 0) return null;

    const blocks = diff.split(/\n(?=diff --git )/g);
    const changes: Record<string, unknown> = {};

    for (const block of blocks) {
        const { filePath, change } = parseUnifiedDiffFileBlock(block);
        if (!filePath || !change) continue;
        changes[filePath] = change;
    }

    if (Object.keys(changes).length > 0) {
        return { ...input, changes };
    }

    const inferred = parseApplyPatchTextChanges(diff);
    if (!inferred) return null;
    return { ...input, changes: inferred };
}
