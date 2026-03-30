import { Session } from "@/sync/domains/state/storageTypes";
import { Message } from "@/sync/domains/messages/messageTypes";
import { trimIdent } from "@/utils/strings/trimIdent";
import { listPendingPermissionRequests, listPendingUserActionRequests } from "@/utils/sessions/sessionUtils";
import { resolveAgentRequestKind, type AgentRequestKind } from "@/utils/sessions/permissions/permissionPromptPolicy";
import { redactVoicePathLikeData, redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import { resolveVoiceSessionLabel } from "@/voice/context/resolveVoiceSessionLabel";
import { resolveVoiceToolResultHumanSummary } from "@/voice/context/resolveVoiceToolResultHumanSummary";
import { formatPermissionRequestSummary } from "@/components/tools/normalization/policy/permissionSummary";

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

interface AskUserQuestionOptionLike {
    label?: unknown;
    description?: unknown;
}

interface AskUserQuestionLike {
    header?: unknown;
    question?: unknown;
    options?: unknown;
}

interface VoicePendingRequestLike {
    id: string;
    toolName: string;
    requestKind: AgentRequestKind;
    toolArgs: unknown;
}

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function clampInt(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const rounded = Math.floor(value);
    if (rounded < min) return min;
    if (rounded > max) return max;
    return rounded;
}

function maybeRedactVoiceString(value: string, shareFilePaths: boolean): string {
    return shareFilePaths ? value : redactVoicePathLikeString(value);
}

function collectUserActionSummary(
    toolName: string,
    toolArgs: unknown,
    prefs: Readonly<{ voiceShareFilePaths: boolean }>,
): string | null {
    if (toolName !== 'AskUserQuestion') return null;
    const questions = Array.isArray((toolArgs as { questions?: unknown })?.questions)
        ? (toolArgs as { questions: ReadonlyArray<AskUserQuestionLike> }).questions
        : null;
    if (!questions || questions.length === 0) return null;

    const lines: string[] = [];
    for (const [index, rawQuestion] of questions.entries()) {
        if (!rawQuestion || typeof rawQuestion !== 'object') continue;
        const header = typeof rawQuestion.header === 'string' && rawQuestion.header.trim()
            ? maybeRedactVoiceString(rawQuestion.header.trim(), prefs.voiceShareFilePaths)
            : null;
        const question = typeof rawQuestion.question === 'string' && rawQuestion.question.trim()
            ? maybeRedactVoiceString(rawQuestion.question.trim(), prefs.voiceShareFilePaths)
            : null;
        const options = Array.isArray(rawQuestion.options)
            ? rawQuestion.options
                .map((option): string | null => {
                    if (!option || typeof option !== 'object') return null;
                    const labelValue = (option as AskUserQuestionOptionLike).label;
                    const descriptionValue = (option as AskUserQuestionOptionLike).description;
                    const label = typeof labelValue === 'string'
                        ? labelValue.trim()
                        : '';
                    const description = typeof descriptionValue === 'string'
                        ? maybeRedactVoiceString(descriptionValue.trim(), prefs.voiceShareFilePaths)
                        : '';
                    if (!label && !description) return null;
                    return description ? `${label} — ${description}` : label;
                })
                .filter((value): value is string => Boolean(value && value.trim()))
            : [];

        if (header) lines.push(`<question_header index="${index + 1}">${header}</question_header>`);
        if (question) lines.push(`<question_text index="${index + 1}">${question}</question_text>`);
        if (options.length > 0) {
            lines.push(`<question_options index="${index + 1}">${options.join(' | ')}</question_options>`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : null;
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

function formatSessionReference(
    sessionId: string,
    prefs: Readonly<{ voiceShareSessionSummary: boolean; voiceShareFilePaths: boolean }>,
    metadata?: SessionMetadata | null,
    fallbackLabel = 'the current session',
): string {
    const label = resolveVoiceSessionLabel(sessionId, prefs, { metadata, fallbackLabel });
    return label.startsWith('the ') ? label : `“${label}”`;
}

function resolveVoiceToolLabel(toolName: string, toolInput: unknown): string {
    const input = asObject(toolInput);
    const intent = typeof input?.intent === 'string' ? input.intent.trim().toLowerCase() : '';

    if (toolName === 'SubAgentRun') {
        if (intent === 'review') return 'review run';
        if (intent === 'plan') return 'plan run';
        if (intent === 'delegate') return 'delegate run';
        return 'sub-agent run';
    }

    return toolName;
}

function resolveToolResultVoiceSummary(
    toolName: string,
    toolInput: unknown,
    toolState: string,
    toolResult: unknown,
    prefs: Readonly<{ voiceShareFilePaths: boolean }>,
): string | null {
    const result = asObject(toolResult);
    if (!result) return null;
    const summary = resolveVoiceToolResultHumanSummary({
        toolName,
        toolInput,
        toolResult,
        shareFilePaths: prefs.voiceShareFilePaths,
    });
    if (!summary) return null;

    const resultStatus = typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
    const failed = toolState === 'error'
        || resultStatus === 'failed'
        || resultStatus === 'timeout'
        || resultStatus === 'error';
    const completed = resultStatus === 'succeeded' || resultStatus === 'completed' || toolState === 'completed';
    const toolLabel = resolveVoiceToolLabel(toolName, toolInput);

    if (failed) {
        return `${toolLabel} failed: ${summary}`;
    }

    if (completed) {
        return `${toolLabel} completed: ${summary}`;
    }

    return summary;
}

function listPendingTranscriptRequests(messages: Message[]): VoicePendingRequestLike[] {
    const requests: VoicePendingRequestLike[] = [];

    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const tool = message.tool;
        const permission = tool?.permission;
        const toolName = typeof tool?.name === 'string' ? tool.name.trim() : '';
        const requestId = typeof permission?.id === 'string'
            ? permission.id.trim()
            : typeof tool?.id === 'string'
                ? tool.id.trim()
                : '';

        if (!toolName || !requestId || permission?.status !== 'pending') continue;

        requests.push({
            id: requestId,
            toolName,
            requestKind: resolveAgentRequestKind({ toolName, requestKind: permission.kind }),
            toolArgs: tool?.input ?? null,
        });
    }

    return requests;
}

function listPendingRequestsForVoice(session: Session, messages: Message[]): VoicePendingRequestLike[] {
    if (session.active !== true) {
        return [];
    }
    const merged = new Map<string, VoicePendingRequestLike>();

    for (const request of listPendingUserActionRequests(session)) {
        merged.set(request.id, {
            id: request.id,
            toolName: request.tool,
            requestKind: request.kind,
            toolArgs: request.arguments,
        });
    }

    for (const request of listPendingPermissionRequests(session)) {
        merged.set(request.id, {
            id: request.id,
            toolName: request.tool,
            requestKind: request.kind,
            toolArgs: request.arguments,
        });
    }

    for (const request of listPendingTranscriptRequests(messages)) {
        if (!merged.has(request.id)) {
            merged.set(request.id, request);
        }
    }

    return Array.from(merged.values());
}

export function summarizeAgentRequestForVoiceHuman(
    requestKind: 'permission' | 'user_action',
    _requestId: string,
    toolName: string,
    toolArgs: unknown,
    prefs?: VoiceContextFormatterPrefs,
): string {
    const resolved = resolvePrefs(prefs);

    if (requestKind === 'permission') {
        const summarized = formatPermissionRequestSummary({
            toolName,
            toolInput: resolved.voiceShareFilePaths ? toolArgs : redactVoicePathLikeData(toolArgs ?? null),
        }).replace(/^Permission required:\s*/i, '').trim();
        return `The coding session needs permission for ${summarized}. Say approve or deny.`;
    }

    const summary = collectUserActionSummary(toolName, toolArgs, resolved);
    if (summary) {
        const firstQuestion = summary
            .split('\n')
            .find((line) => line.startsWith('<question_text '))
            ?.replace(/^<question_text[^>]*>/, '')
            ?.replace(/<\/question_text>$/, '')
            ?.trim();
        if (firstQuestion) {
            return `The coding session needs your input. ${firstQuestion}`;
        }
    }

  return 'The coding session needs your input. Answer the question so I can continue.';
}

export function summarizeAssistantMessagesForVoiceHuman(
    messages: ReadonlyArray<Message>,
    prefs?: VoiceContextFormatterPrefs,
): string | null {
    const resolved = resolvePrefs(prefs);
    const latestAssistantMessage = [...messages]
        .filter((message): message is Extract<Message, { kind: 'agent-text' }> => message?.kind === 'agent-text')
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1);

    if (!latestAssistantMessage) return null;
    return resolved.voiceShareFilePaths
        ? latestAssistantMessage.text
        : redactVoicePathLikeString(latestAssistantMessage.text);
}

export function summarizeMessagesForVoiceHuman(
    messages: ReadonlyArray<Message>,
    prefs?: VoiceContextFormatterPrefs,
): string | null {
    const assistantSummary = summarizeAssistantMessagesForVoiceHuman(messages, prefs);
    if (assistantSummary) return assistantSummary;

    const resolved = resolvePrefs(prefs);
    const latestToolCall = [...messages]
        .filter((message): message is Extract<Message, { kind: 'tool-call' }> => message?.kind === 'tool-call')
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1);
    if (!latestToolCall) return null;

    return resolveToolResultVoiceSummary(
        latestToolCall.tool.name,
        latestToolCall.tool.input,
        latestToolCall.tool.state,
        latestToolCall.tool.result,
        resolved,
    );
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
        ? (resolved.voiceShareFilePaths ? (toolArgs ?? null) : redactVoicePathLikeData(toolArgs ?? null))
        : null;
    const args = argsObj !== null ? JSON.stringify(argsObj) : null;
    const sessionReference = formatSessionReference(sessionId, resolved);
    return trimIdent(`
        Coding assistant is requesting permission to use ${toolName} in ${sessionReference}:
        <request_id>${requestId}</request_id>
        <tool_name>${toolName}</tool_name>
        ${args ? `<tool_args>${args}</tool_args>` : '<tool_args_redacted>true</tool_args_redacted>'}
        Interrupt your previous plan and tell the human about this request now.
        Do not call any tools or send new coding-session work until the human answers approve or deny.
        Ask the human to say approve or deny.
    `);
}

/**
 * Format a structured user-action request (for example AskUserQuestion) for natural language voice context.
 */
export function formatUserActionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolArgs: any,
    prefs?: VoiceContextFormatterPrefs,
): string {
    const resolved = resolvePrefs(prefs);
    const summary = collectUserActionSummary(toolName, toolArgs, resolved);
    const argsObj = resolved.voiceShareToolArgs
        ? (resolved.voiceShareFilePaths ? (toolArgs ?? null) : redactVoicePathLikeData(toolArgs ?? null))
        : null;
    const args = argsObj !== null ? JSON.stringify(argsObj) : null;
    const redactedActionGuidance = !summary && !args
        ? 'Review the request and approve, reject, or request changes based on the user intent.'
        : '';
    const sessionReference = formatSessionReference(sessionId, resolved);
    return trimIdent(`
        Coding assistant needs user input to continue in ${sessionReference}:
        <request_id>${requestId}</request_id>
        <request_kind>user_action</request_kind>
        <tool_name>${toolName}</tool_name>
        ${summary ? summary : ''}
        ${args ? `<request_payload>${args}</request_payload>` : '<request_payload_redacted>true</request_payload_redacted>'}
        ${redactedActionGuidance}
        Interrupt your previous plan and present this request to the human now.
        Do not call other tools or send new coding-session work until the human answers.
        Ask the human for the missing input. Reply with answerUserActionRequest using structured question/answer entries for this user_action request.
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
        const text = resolved.voiceShareFilePaths ? message.text : redactVoicePathLikeString(message.text);
        lines.push(`Coding assistant: \n<text>${text}</text>`);
    } else if (message.kind === 'user-text') {
        const text = resolved.voiceShareFilePaths ? message.text : redactVoicePathLikeString(message.text);
        lines.push(`User sent message: \n<text>${text}</text>`);
    } else if (message.kind === 'tool-call' && resolved.voiceShareToolNames) {
        const toolDescription = message.tool.description ? ` - ${message.tool.description}` : '';
        lines.push(`Coding assistant is using ${message.tool.name}${toolDescription}`);
        if (resolved.voiceShareToolArgs) {
            const input = resolved.voiceShareFilePaths ? (message.tool.input ?? null) : redactVoicePathLikeData(message.tool.input ?? null);
            lines.push(`<tool_args>${JSON.stringify(input)}</tool_args>`);
        } else {
            lines.push('<tool_args_redacted>true</tool_args_redacted>');
        }
        const toolResultSummary = resolveToolResultVoiceSummary(
            message.tool.name,
            message.tool.input,
            message.tool.state,
            message.tool.result,
            resolved,
        );
        if (toolResultSummary) {
            lines.push(`Coding assistant reported:\n<tool_result>${toolResultSummary}</tool_result>`);
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
    const resolved = resolvePrefs(prefs);
    return `New message in ${formatSessionReference(sessionId, resolved)}\n\n${formatted}`;
}

export function formatNewMessages(sessionId: string, messages: Message[], prefs?: VoiceContextFormatterPrefs): string | null {
    let formatted = [...messages].sort((a, b) => a.createdAt - b.createdAt).map((m) => formatMessageWithPrefs(m, prefs)).filter(Boolean);
    if (formatted.length === 0) {
        return null;
    }
    const resolved = resolvePrefs(prefs);
    return `New messages in ${formatSessionReference(sessionId, resolved)}\n\n${formatted.join('\n\n')}`;
}

function formatRecentMessages(sessionId: string, messages: Message[], prefs?: VoiceContextFormatterPrefs): string | null {
    const resolved = resolvePrefs(prefs);
    if (!resolved.voiceShareRecentMessages) return null;
    if (resolved.voiceRecentMessagesCount <= 0) return null;

    const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    const recent = sorted.slice(Math.max(0, sorted.length - resolved.voiceRecentMessagesCount));
    const formatted = recent.map((m) => formatMessageWithPrefs(m, prefs)).filter(Boolean);
    if (formatted.length === 0) return null;
    return `Recent messages in ${formatSessionReference(sessionId, resolved)}\n\n${formatted.join('\n\n')}`;
}

//
// Session states
//

export function formatSessionFull(session: Session, messages: Message[], prefs?: VoiceContextFormatterPrefs): string {
    const resolved = resolvePrefs(prefs);
    const rawSessionSummary = session.metadata?.summary?.text;
    const sessionSummary = typeof rawSessionSummary === 'string'
        ? maybeRedactVoiceString(rawSessionSummary, resolved.voiceShareFilePaths)
        : rawSessionSummary;
    const lines: string[] = [];

    // Add session context
    lines.push(`# Session: ${resolveVoiceSessionLabel(session.id, resolved, { metadata: session.metadata, fallbackLabel: 'the current session' })}`);
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

    const pendingRequestSections: string[] = [];
    for (const request of listPendingRequestsForVoice(session, messages)) {
        if (request.requestKind === 'user_action') {
            pendingRequestSections.push(
                formatUserActionRequest(
                    session.id,
                    request.id,
                    request.toolName,
                    request.toolArgs,
                    prefs,
                ),
            );
            continue;
        }

        pendingRequestSections.push(
            formatPermissionRequest(
                session.id,
                request.id,
                request.toolName,
                request.toolArgs,
                prefs,
            ),
        );
    }
    if (pendingRequestSections.length > 0) {
        lines.push('## Pending Requests');
        lines.push(pendingRequestSections.join('\n\n'));
    }

    const recent = formatRecentMessages(session.id, messages, prefs);
    if (recent) {
        lines.push('## Recent Messages');
        lines.push(recent);
    }

    return lines.join('\n\n');
}

export function formatSessionOffline(sessionId: string, metadata?: SessionMetadata): string {
    const prefs = resolvePrefs();
    return `${formatSessionReference(sessionId, prefs, metadata, 'the current session')} went offline.`;
}

export function formatSessionOnline(sessionId: string, metadata?: SessionMetadata): string {
    const prefs = resolvePrefs();
    return `${formatSessionReference(sessionId, prefs, metadata, 'the current session')} came online.`;
}

export function formatSessionFocus(sessionId: string, metadata?: SessionMetadata): string {
    const prefs = resolvePrefs();
    return `${formatSessionReference(sessionId, prefs, metadata, 'the current session')} became focused.`;
}

export function formatReadyEvent(
    sessionId: string,
    messages?: ReadonlyArray<Message>,
    prefs?: VoiceContextFormatterPrefs,
): string {
    const summary = summarizeAssistantMessagesForVoiceHuman(messages ?? [], prefs);
    const resolved = resolvePrefs(prefs);
    const sessionReference = formatSessionReference(sessionId, resolved);
    if (summary) {
        return `Coding assistant finished working in ${sessionReference}. Latest response: ${summary} Report this to the human immediately.`;
    }
    return `Coding assistant finished working in ${sessionReference}. The previous message(s) summarize the work done. Report this to the human immediately.`;
}
