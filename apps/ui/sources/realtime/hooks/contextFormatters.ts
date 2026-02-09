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
    voiceShareFilePaths?: boolean;
}

function clampInt(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const rounded = Math.floor(value);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
}

function resolvePrefs(prefs?: VoiceContextFormatterPrefs) {
    return {
        voiceShareSessionSummary: prefs?.voiceShareSessionSummary ?? true,
        voiceShareRecentMessages: prefs?.voiceShareRecentMessages ?? true,
        voiceRecentMessagesCount: clampInt(prefs?.voiceRecentMessagesCount, { min: 0, max: 50, fallback: 10 }),
        voiceShareToolNames: prefs?.voiceShareToolNames ?? true,
        voiceShareFilePaths: prefs?.voiceShareFilePaths ?? false,
    } as const;
}


/**
 * Format a permission request for natural language context
 */
export function formatPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolArgs: any
): string {
    return trimIdent(`
        Claude Code is requesting permission to use ${toolName} (session ${sessionId}):
        <request_id>${requestId}</request_id>
        <tool_name>${toolName}</tool_name>
        <tool_args_redacted>true</tool_args_redacted>
    `);
}

//
// Message formatting
//

export function formatMessage(message: Message): string | null {
    return formatMessageWithPrefs(message);
}

function formatMessageWithPrefs(message: Message, prefs?: VoiceContextFormatterPrefs): string | null {
    const resolved = resolvePrefs(prefs);

    // Lines
    let lines: string[] = [];
    if (message.kind === 'agent-text') {
        lines.push(`Claude Code: \n<text>${message.text}</text>`);
    } else if (message.kind === 'user-text') {
        lines.push(`User sent message: \n<text>${message.text}</text>`);
    } else if (message.kind === 'tool-call' && resolved.voiceShareToolNames) {
        const toolDescription = message.tool.description ? ` - ${message.tool.description}` : '';
        lines.push(`Claude Code is using ${message.tool.name}${toolDescription}`);
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
    return `Claude Code done working in session: ${sessionId}. The previous message(s) are the summary of the work done. Report this to the human immediately.`;
}
