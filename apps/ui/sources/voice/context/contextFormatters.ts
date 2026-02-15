import { Session } from "@/sync/domains/state/storageTypes";
import { Message } from "@/sync/domains/messages/messageTypes";
import { trimIdent } from "@/utils/strings/trimIdent";

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    homeDir?: string;
    [key: string]: any;
}

export interface VoiceContextFormatterPrefs {
    voiceShareSessionSummary?: boolean;
    voiceShareRecentMessages?: boolean;
    voiceRecentMessagesCount?: number;
    voiceShareToolNames?: boolean;
    voiceShareToolArgs?: boolean;
    voiceShareFilePaths?: boolean;
}

function clampInt(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const rounded = Math.floor(value);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
}

function redactFilePathsInString(value: string): string {
    return value
        .replace(/\/Users\/[^\s"'<>]+/g, '<path_redacted>')
        .replace(/\/home\/[^\s"'<>]+/g, '<path_redacted>')
        .replace(/\/tmp\/[^\s"'<>]+/g, '<path_redacted>')
        .replace(/[A-Za-z]:\\\\[^\s"'<>]+/g, '<path_redacted>')
        .replace(/\\\\\\\\[^\s"'<>]+/g, '<path_redacted>');
}

function redactFilePathsDeep(input: unknown): unknown {
    const seen = new Set<object>();
    const walk = (value: unknown, depth: number): unknown => {
        if (depth > 20) return value;
        if (typeof value === 'string') return redactFilePathsInString(value);
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value as object)) return null;
        seen.add(value as object);
        if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = walk(v, depth + 1);
        }
        return out;
    };
    return walk(input, 0);
}

function resolvePrefs(prefs?: VoiceContextFormatterPrefs) {
    return {
        voiceShareSessionSummary: prefs?.voiceShareSessionSummary ?? true,
        voiceShareRecentMessages: prefs?.voiceShareRecentMessages ?? true,
        voiceRecentMessagesCount: clampInt(prefs?.voiceRecentMessagesCount, { min: 0, max: 50, fallback: 10 }),
        voiceShareToolNames: prefs?.voiceShareToolNames ?? true,
        voiceShareToolArgs: prefs?.voiceShareToolArgs ?? true,
        voiceShareFilePaths: prefs?.voiceShareFilePaths ?? true,
    } as const;
}

/**
 * Format a permission request for natural language context.
 *
 * Note: tool args may contain sensitive data. This formatter only includes args
 * when explicitly enabled via prefs.
 */
export function formatPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolArgs: any,
    prefs?: VoiceContextFormatterPrefs,
): string {
    const resolved = resolvePrefs(prefs);
    const argsObj = resolved.voiceShareToolArgs
        ? (resolved.voiceShareFilePaths ? (toolArgs ?? null) : redactFilePathsDeep(toolArgs ?? null))
        : null;
    const args = argsObj !== null ? JSON.stringify(argsObj) : null;
    return trimIdent(`
        Coding assistant is requesting permission to use ${toolName} (session ${sessionId}):
        <request_id>${requestId}</request_id>
        <tool_name>${toolName}</tool_name>
        ${args ? `<tool_args>${args}</tool_args>` : '<tool_args_redacted>true</tool_args_redacted>'}
    `);
}

//
// Message formatting
//

export function formatMessage(message: Message, prefs?: VoiceContextFormatterPrefs): string | null {
    return formatMessageWithPrefs(message, prefs);
}

function formatMessageWithPrefs(message: Message, prefs?: VoiceContextFormatterPrefs): string | null {
    const resolved = resolvePrefs(prefs);

    // Lines
    let lines: string[] = [];
    if (message.kind === 'agent-text') {
        const text = resolved.voiceShareFilePaths ? message.text : redactFilePathsInString(message.text);
        lines.push(`Coding assistant: \n<text>${text}</text>`);
    } else if (message.kind === 'user-text') {
        const text = resolved.voiceShareFilePaths ? message.text : redactFilePathsInString(message.text);
        lines.push(`User sent message: \n<text>${text}</text>`);
    } else if (message.kind === 'tool-call' && resolved.voiceShareToolNames) {
        const toolDescription = message.tool.description ? ` - ${message.tool.description}` : '';
        lines.push(`Coding assistant is using ${message.tool.name}${toolDescription}`);
        if (resolved.voiceShareToolArgs) {
            const input = resolved.voiceShareFilePaths ? (message.tool.input ?? null) : redactFilePathsDeep(message.tool.input ?? null);
            lines.push(`<tool_args>${JSON.stringify(input)}</tool_args>`);
        } else {
            lines.push('<tool_args_redacted>true</tool_args_redacted>');
        }
    }
    if (lines.length === 0) {
        return null;
    }
    return lines.join('\n\n');
}

export function formatNewSingleMessage(sessionId: string, message: Message, prefs?: VoiceContextFormatterPrefs): string | null {
    let formatted = formatMessageWithPrefs(message, prefs);
    if (!formatted) {
        return null;
    }
    return 'New message in session: ' + sessionId + '\n\n' + formatted;
}

export function formatNewMessages(sessionId: string, messages: Message[], prefs?: VoiceContextFormatterPrefs): string | null {
    let formatted = [...messages].sort((a, b) => a.createdAt - b.createdAt).map((m) => formatMessageWithPrefs(m, prefs)).filter(Boolean);
    if (formatted.length === 0) {
        return null;
    }
    return 'New messages in session: ' + sessionId + '\n\n' + formatted.join('\n\n');
}

function formatRecentMessages(sessionId: string, messages: Message[], prefs?: VoiceContextFormatterPrefs): string | null {
    const resolved = resolvePrefs(prefs);
    if (!resolved.voiceShareRecentMessages) return null;
    if (resolved.voiceRecentMessagesCount <= 0) return null;

    const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    const recent = sorted.slice(Math.max(0, sorted.length - resolved.voiceRecentMessagesCount));
    const formatted = recent.map((m) => formatMessageWithPrefs(m, prefs)).filter(Boolean);
    if (formatted.length === 0) return null;
    return `Recent messages in session: ${sessionId}\n\n${formatted.join('\n\n')}`;
}

//
// Session states
//

export function formatSessionFull(session: Session, messages: Message[], prefs?: VoiceContextFormatterPrefs): string {
    const resolved = resolvePrefs(prefs);
    const sessionSummary = session.metadata?.summary?.text;
    const lines: string[] = [];

    // Add session context
    lines.push(`# Session ID: ${session.id}`);
    if (resolved.voiceShareFilePaths && session.metadata && typeof (session.metadata as any).path === 'string') {
        const path = String((session.metadata as any).path);
        if (path.trim().length > 0) {
            lines.push('## Session Path');
            lines.push(path);
        }
    }
    if (resolved.voiceShareSessionSummary && sessionSummary) {
        lines.push('## Session Summary');
        lines.push(sessionSummary);
    }

    const recent = formatRecentMessages(session.id, messages, prefs);
    if (recent) {
        lines.push('## Recent Messages');
        lines.push(recent);
    }

    return lines.join('\n\n');
}

export function formatSessionOffline(sessionId: string, metadata?: SessionMetadata): string {
    return `Session went offline: ${sessionId}`;
}

export function formatSessionOnline(sessionId: string, metadata?: SessionMetadata): string {
    return `Session came online: ${sessionId}`;
}

export function formatSessionFocus(sessionId: string, metadata?: SessionMetadata): string {
    return `Session became focused: ${sessionId}`;
}

export function formatReadyEvent(sessionId: string): string {
    return `Coding assistant done working in session: ${sessionId}. The previous message(s) summarize the work done. Report this to the human immediately.`;
}
