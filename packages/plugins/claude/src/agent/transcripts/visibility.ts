import type { RawJSONLines } from './rawJsonLines.js';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBooleanFlag(value: unknown, key: string): boolean {
    return isRecord(value) && value[key] === true;
}

function readFirstMessageText(value: unknown): string | null {
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

function stripAnsiControlSequences(value: string): string {
    return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

export function isClaudeCompactHookLocalCommandStdout(value: unknown): boolean {
    const text = readFirstMessageText(value);
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('<local-command-stdout>')) return false;
    return /\b(?:PreCompact|PostCompact)\b/u.test(stripAnsiControlSequences(trimmed));
}

export function isClaudeLocalCommandTranscriptMessage(value: RawJSONLines): boolean {
    if (value.type !== 'user') return false;
    const text = readFirstMessageText(value);
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.startsWith('<local-command-caveat>')) return true;
    if (trimmed.startsWith('<local-command-stdout>') && isClaudeCompactHookLocalCommandStdout(value)) return true;
    return trimmed.includes('<command-name>/compact</command-name>');
}

/**
 * Generic slash-command transcript row shape: the `<command-name>…` echo row and the
 * `<local-command-stdout>…` output row Claude writes for ANY slash command. Unlike
 * `isClaudeLocalCommandTranscriptMessage` (which targets `/compact` artifacts everywhere),
 * this is a pure shape predicate — callers decide the policy (e.g. the unified provider
 * transcript drops these from one-time bind replays only, keeping live user-typed rows).
 */
export function isClaudeSlashCommandTranscriptRow(value: RawJSONLines): boolean {
    if (value.type !== 'user') return false;
    const text = readFirstMessageText(value);
    if (!text) return false;
    const trimmed = stripAnsiControlSequences(text).trim();
    return trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command-stdout>');
}

export function isClaudeInternalTranscriptMessage(value: RawJSONLines): boolean {
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
