import { maybeParseJson } from './parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

/**
 * ACP-style tool results (Pi) carry output as text blocks in a `content` array with
 * metadata beside it (`details.exit_code`, …) instead of stream keys. Joining by direct
 * concatenation matches how those blocks were streamed.
 */
function readAcpContentText(value: unknown): string | undefined {
    const record = asRecord(value);
    const content = record?.content;
    if (!Array.isArray(content)) return undefined;

    let text = '';
    for (const item of content) {
        const entry = asRecord(item);
        if (!entry || entry.type !== 'text') continue;
        const chunk = typeof entry.text === 'string' ? entry.text : undefined;
        if (chunk === undefined) continue;
        text += chunk;
    }
    return text.length > 0 ? text : undefined;
}

export type StdStreams = { stdout?: string; stderr?: string };

export function extractStdStreams(result: unknown): StdStreams | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string') {
        return parsed.length > 0 ? { stdout: parsed } : null;
    }
    const obj = asRecord(parsed);
    if (!obj) return null;

    const stdout =
        typeof obj.stdout === 'string'
            ? obj.stdout
            : typeof obj.aggregated_output === 'string'
                ? obj.aggregated_output
                : typeof obj.formatted_output === 'string'
                    ? obj.formatted_output
                    : readAcpContentText(obj);
    const stderr = typeof obj.stderr === 'string' ? obj.stderr : undefined;
    if (!stdout && !stderr) return null;

    return { stdout, stderr };
}

export function tailTextWithEllipsis(text: string, maxChars: number): string {
    if (maxChars <= 0) return '';
    if (text.length <= maxChars) return text;
    return `…${text.slice(-maxChars)}`;
}
