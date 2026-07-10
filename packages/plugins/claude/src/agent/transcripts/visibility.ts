import type { RawJSONLines } from './rawJsonLines.js';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBooleanFlag(value: unknown, key: string): boolean {
    return isRecord(value) && value[key] === true;
}

export function readClaudeTranscriptMessageText(value: unknown): string | null {
    if (!isRecord(value)) return null;
    const message = isRecord(value.message) ? value.message : null;
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    for (const item of content) {
        if (!isRecord(item)) continue;
        const text = item.text ?? item.content;
        if (typeof text === 'string') return text;
    }
    return null;
}

export function stripClaudeAnsiControlSequences(value: string): string {
    return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

export function isClaudeCompactHookLocalCommandStdout(value: unknown): boolean {
    const text = readClaudeTranscriptMessageText(value);
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('<local-command-stdout>')) return false;
    return /\b(?:PreCompact|PostCompact)\b/u.test(stripClaudeAnsiControlSequences(trimmed));
}

export function isClaudeLocalCommandTranscriptMessage(value: RawJSONLines): boolean {
    if (value.type !== 'user') return false;
    const text = readClaudeTranscriptMessageText(value);
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.startsWith('<local-command-caveat>')) return true;
    return isClaudeSlashCommandTranscriptRow(value);
}

/**
 * Generic slash-command transcript row shape: the `<command-name>…` echo row and the
 * `<local-command-stdout>…` output row Claude writes for ANY slash command. The raw
 * session-message path treats these rows as internal; provider transcript projection may
 * relabel them into sanitized visible `slash_command` / `local_command_output` events.
 */
export function isClaudeSlashCommandTranscriptRow(value: RawJSONLines): boolean {
    if (value.type !== 'user') return false;
    const text = readClaudeTranscriptMessageText(value);
    if (!text) return false;
    const trimmed = stripClaudeAnsiControlSequences(text).trim();
    return trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command-stdout>');
}

function decodeXmlEntities(value: string): string {
    return value
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&amp;/gu, '&');
}

function readXmlTag(source: string, tag: string): string | null {
    const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'iu'));
    const value = match?.[1];
    if (value === undefined) return null;
    const normalized = decodeXmlEntities(stripClaudeAnsiControlSequences(value)).replace(/\s+/gu, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

export function readClaudeVisibleSlashCommandText(value: RawJSONLines): string | null {
    if (value.type !== 'user') return null;
    const text = readClaudeTranscriptMessageText(value);
    if (!text) return null;
    const commandName = readXmlTag(text, 'command-name');
    if (!commandName) return null;
    const args = readXmlTag(text, 'command-args');
    return args ? `${commandName} ${args}` : commandName;
}

export function readClaudeVisibleLocalCommandOutputText(value: RawJSONLines): string | null {
    if (value.type !== 'user') return null;
    const text = readClaudeTranscriptMessageText(value);
    if (!text) return null;
    const match = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/iu);
    const valueText = match?.[1];
    if (valueText === undefined) return null;
    const output = decodeXmlEntities(stripClaudeAnsiControlSequences(valueText))
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n')
        .trim();
    return output.length > 0 ? output : null;
}

export function readClaudeVisibleCompactSummaryText(value: RawJSONLines): string | null {
    if (value.type !== 'user' || !readBooleanFlag(value, 'isCompactSummary')) return null;
    const text = readClaudeTranscriptMessageText(value);
    return text ? stripClaudeAnsiControlSequences(text).replace(/\s+/gu, ' ').trim() || null : null;
}

export function isClaudeInternalTranscriptMessage(value: RawJSONLines): boolean {
    if (value.type === 'attachment' || value.type === 'result') {
        return true;
    }
    if (value.type === 'user') {
        if (
            readBooleanFlag(value, 'isCompactSummary') ||
            readBooleanFlag(value, 'isVisibleInTranscriptOnly') ||
            isClaudeLocalCommandTranscriptMessage(value)
        ) {
            return true;
        }
    }
    return isClaudeCompactHookLocalCommandStdout(value);
}
