export type ClaudeRawJsonlTranscriptForwardCursorV1 = Readonly<{
    v: 1;
    kind: 'claudeScannerForward';
    sessionFilePath: string;
    offsetBytes: number;
}>;

export function encodeClaudeRawJsonlTranscriptForwardCursor(value: ClaudeRawJsonlTranscriptForwardCursorV1): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeClaudeRawJsonlTranscriptForwardCursor(raw: string | null | undefined): ClaudeRawJsonlTranscriptForwardCursorV1 | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ClaudeRawJsonlTranscriptForwardCursorV1>;
        if (parsed.v !== 1 || parsed.kind !== 'claudeScannerForward') return null;
        if (typeof parsed.sessionFilePath !== 'string' || parsed.sessionFilePath.trim().length === 0) return null;
        if (typeof parsed.offsetBytes !== 'number' || !Number.isFinite(parsed.offsetBytes) || parsed.offsetBytes < 0) return null;
        return {
            v: 1,
            kind: 'claudeScannerForward',
            sessionFilePath: parsed.sessionFilePath,
            offsetBytes: Math.trunc(parsed.offsetBytes),
        };
    } catch {
        return null;
    }
}
