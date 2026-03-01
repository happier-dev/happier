import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

const TRAILING_PUNCTUATION = /[.,)\]}]+$/;

function isLikelyWorkspacePath(raw: string): boolean {
    if (!raw) return false;
    if (raw.startsWith('happier/')) return false; // reserved structured message prefix (e.g. @happier/...)
    // Avoid accidental user mentions like "@bob".
    if (!raw.includes('/') && !raw.includes('.')) return false;
    if (!isSafeWorkspaceRelativePath(raw)) return false;
    // Keep this conservative; UI is best-effort and should avoid capturing arbitrary tokens.
    return /^[A-Za-z0-9._/-]+\/?$/.test(raw);
}

export function extractWorkspaceFileMentions(text: string): readonly string[] {
    if (!text) return [];

    const out: string[] = [];
    const seen = new Set<string>();

    const pattern = /@([^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const token = match[1] ?? '';
        const trimmed = token.replace(TRAILING_PUNCTUATION, '');
        if (!isLikelyWorkspacePath(trimmed)) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }

    return out;
}
