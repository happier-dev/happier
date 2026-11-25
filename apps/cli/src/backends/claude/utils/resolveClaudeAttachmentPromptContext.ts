import { posix, resolve } from 'node:path';

import { normalizeSessionMediaWorkspaceRelativeDir } from '@/transfers/sessionMedia/sessionMediaConfig';
import { sanitizeSessionMediaFileName } from '@/transfers/sessionMedia/sanitizeSessionMediaFileName';

function readWorkspaceAttachmentPath(line: string): string | null {
    if (!line.startsWith('- ')) return null;
    const metadata = /, [^,\r\n]+, \d+ bytes\)$/.exec(line);
    if (!metadata) return null;

    // An uploaded basename and its display name can both contain parentheses.
    // Use the stored basename to identify the separator between them.
    for (let separator = line.indexOf(' (', 2); separator >= 0 && separator < metadata.index;
        separator = line.indexOf(' (', separator + 2)) {
        const path = line.slice(2, separator);
        if (normalizeSessionMediaWorkspaceRelativeDir(path) !== path) continue;
        if (posix.basename(posix.dirname(posix.dirname(path))) !== 'messages') continue;
        const basename = posix.basename(path);
        const displayName = line.slice(separator + 2, metadata.index);
        if (/^[a-f0-9]{8}-/.test(basename) && basename.slice(9) === sanitizeSessionMediaFileName(displayName)) {
            return path;
        }
    }
    return null;
}

export function resolveClaudeAttachmentPromptContext(prompt: unknown, workspace: string): string | null {
    if (typeof prompt !== 'string' || !prompt.includes('[attachments]')) return null;

    const paths = new Set<string>();
    for (const block of prompt.matchAll(/^\[attachments\]\r?\n((?:- [^\r\n\0]*\r?\n)+)\[\/attachments\][ \t\r]*$/gm)) {
        for (const line of block[1].split(/\r?\n/)) {
            const path = readWorkspaceAttachmentPath(line);
            if (path) paths.add(resolve(workspace, path));
        }
    }
    if (paths.size === 0) return null;

    return 'Happier resolved the workspace attachments in this prompt. Use these absolute file paths with Read:\n'
        + [...paths].map((path) => JSON.stringify(path)).join('\n');
}
