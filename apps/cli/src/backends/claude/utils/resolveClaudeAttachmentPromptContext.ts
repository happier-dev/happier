import { posix, resolve } from 'node:path';

import { normalizeSessionMediaWorkspaceRelativeDir } from '@/transfers/sessionMedia/sessionMediaConfig';
import { sanitizeSessionMediaFileName } from '@/transfers/sessionMedia/sanitizeSessionMediaFileName';

const ATTACHMENT_METADATA_SUFFIX = /, [^,\r\n]+, \d+ bytes\)$/;

function readWorkspaceAttachmentPath(entry: string, metadataStart: number): string | null {
    // An uploaded basename and its display name can both contain parentheses.
    // Use the stored basename to identify the separator between them.
    for (let separator = entry.indexOf(' (', 2); separator >= 0 && separator < metadataStart;
        separator = entry.indexOf(' (', separator + 2)) {
        const path = entry.slice(2, separator);
        if (/[\r\n\0]/.test(path) || normalizeSessionMediaWorkspaceRelativeDir(path) !== path) continue;
        if (posix.basename(posix.dirname(posix.dirname(path))) !== 'messages') continue;
        const basename = posix.basename(path);
        const displayName = entry.slice(separator + 2, metadataStart);
        if (/^[a-f0-9]{8}-/.test(basename) && basename.slice(9) === sanitizeSessionMediaFileName(displayName)) {
            return path;
        }
    }
    return null;
}

export function resolveClaudeAttachmentPromptContext(prompt: unknown, workspace: string): string | null {
    if (typeof prompt !== 'string' || !prompt.includes('[attachments]')) return null;

    const paths = new Set<string>();
    let block: string[] | null = null;
    let entry = '';
    for (const line of prompt.split(/\r?\n/)) {
        if (line === '[attachments]') {
            block = [];
            entry = '';
        } else if (block && line.trimEnd() === '[/attachments]') {
            for (const path of block) paths.add(resolve(workspace, path));
            block = null;
        } else if (block && (entry || line.startsWith('- '))) {
            // The display name in the prompt can span lines even though the stored path cannot.
            const lineStart = entry ? entry.length + 1 : 0;
            entry = entry ? entry + '\n' + line : line;
            const metadata = ATTACHMENT_METADATA_SUFFIX.exec(line);
            if (!metadata) continue;
            const path = readWorkspaceAttachmentPath(entry, lineStart + metadata.index);
            if (path) block.push(path);
            entry = '';
        }
    }
    if (paths.size === 0) return null;

    return 'Happier resolved the workspace attachments in this prompt. Use these absolute file paths with Read:\n'
        + [...paths].map((path) => JSON.stringify(path)).join('\n');
}
