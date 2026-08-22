import { maybeParseJson } from './parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export type StdStreams = { stdout?: string; stderr?: string; exitCode?: number };

function readFirstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'string') return value;
    }
    return undefined;
}

function readFirstNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

function readContentText(obj: Record<string, unknown>): string | undefined {
    if (!Array.isArray(obj.content)) return undefined;
    let text = '';
    for (const item of obj.content) {
        const entry = asRecord(item);
        if (!entry || entry.type !== 'text' || typeof entry.text !== 'string') continue;
        text += entry.text;
    }
    return text.length > 0 ? text : undefined;
}

export function extractStdStreams(result: unknown): StdStreams | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string') {
        return parsed.length > 0 ? { stdout: parsed } : null;
    }
    const obj = asRecord(parsed);
    if (!obj) return null;

    const stdout = readFirstString(obj, [
        'stdout',
        'out',
        'aggregatedOutput',
        'aggregated_output',
        'formattedOutput',
        'formatted_output',
    ]) ?? readContentText(obj);
    const stderr = readFirstString(obj, ['stderr', 'err']);
    const exitCode = readFirstNumber(obj, ['exitCode', 'exit_code', 'code']);
    if (stdout === undefined && stderr === undefined && exitCode === undefined) return null;

    return {
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
    };
}

export function tailTextWithEllipsis(text: string, maxChars: number): string {
    if (maxChars <= 0) return '';
    if (text.length <= maxChars) return text;
    return `…${text.slice(-maxChars)}`;
}
