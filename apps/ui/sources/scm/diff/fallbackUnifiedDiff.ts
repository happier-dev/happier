import { decodeBase64 } from '@/encryption/base64';

export function decodeUtf8Base64(base64: string): string {
    const bytes = decodeBase64(base64);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function countTextLines(text: string): number {
    if (!text) return 0;
    // Normalize trailing newline so "a\n" counts as 1 line.
    const normalized = text.endsWith('\n') || text.endsWith('\r')
        ? text.replace(/(\r\n|\r|\n)+$/, '')
        : text;
    if (!normalized) return 0;
    return normalized.split(/\r\n|\r|\n/).length;
}

export function buildAddedFileUnifiedDiff(input: Readonly<{ filePath: string; newText: string }>): string {
    const path = input.filePath;
    const newLines = input.newText ? input.newText.split(/\r\n|\r|\n/) : [];
    const newLinesTrimmed = (newLines.length > 0 && newLines[newLines.length - 1] === '') ? newLines.slice(0, -1) : newLines;

    const header = [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        `--- /dev/null`,
        `+++ b/${path}`,
        `@@ -0,0 +1,${Math.max(1, newLinesTrimmed.length)} @@`,
    ];

    const body = newLinesTrimmed.map((line) => `+${line}`);
    return [...header, ...body, ''].join('\n');
}
