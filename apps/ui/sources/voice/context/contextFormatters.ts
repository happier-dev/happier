import {
    formatPermissionRequestSummary,
    isAskUserQuestionToolName,
} from "@happier-dev/protocol";
import { Session } from "@/sync/domains/state/storageTypes";
import { Message } from "@/sync/domains/messages/messageTypes";
import { storage } from '@/sync/domains/state/storage';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { listPendingSessionRequests } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { trimIdent } from "@/utils/strings/trimIdent";
import { redactVoicePathLikeData, redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import { resolveVoiceSessionLabel } from "@/voice/context/resolveVoiceSessionLabel";
import { resolveVoiceToolResultHumanSummary } from "@/voice/context/resolveVoiceToolResultHumanSummary";
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { isInventoryPrivacyVoiceToolName } from '@/sync/domains/settings/actionSettingsPolicy';
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
    voiceSharePermissionRequests?: boolean;
    voiceShareDeviceInventory?: boolean;
}

export type ResolvedVoiceContextFormatterPrefs = Readonly<Required<VoiceContextFormatterPrefs>>;

interface AskUserQuestionOptionLike {
    label?: unknown;
    description?: unknown;
}

interface AskUserQuestionLike {
    header?: unknown;
    question?: unknown;
    options?: unknown;
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
    if (!isAskUserQuestionToolName(toolName)) return null;
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

function resolvePrefs(prefs?: VoiceContextFormatterPrefs): ResolvedVoiceContextFormatterPrefs {
    return {
        voiceShareSessionSummary: prefs?.voiceShareSessionSummary === true,
        voiceShareRecentMessages: prefs?.voiceShareRecentMessages === true,
        voiceRecentMessagesCount: clampInt(prefs?.voiceRecentMessagesCount, { min: 0, max: 50, fallback: 10 }),
        voiceShareToolNames: prefs?.voiceShareToolNames === true,
        voiceShareToolArgs: prefs?.voiceShareToolArgs === true,
        voiceShareFilePaths: prefs?.voiceShareFilePaths === true,
        voiceSharePermissionRequests: prefs?.voiceSharePermissionRequests === true,
        voiceShareDeviceInventory: prefs?.voiceShareDeviceInventory === true,
    };
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
    prefs: Readonly<{
        voiceShareToolNames: boolean;
        voiceShareFilePaths: boolean;
        voiceShareSessionSummary: boolean;
        voiceShareDeviceInventory: boolean;
    }>,
): string | null {
    if (!prefs.voiceShareToolNames) return null;
    if (!prefs.voiceShareDeviceInventory && isInventoryPrivacyVoiceToolName(toolName)) return null;
    const result = asObject(toolResult);
    if (!result) return null;
    const summary = resolveVoiceToolResultHumanSummary({
        toolName,
        toolInput,
        toolResult,
        shareFilePaths: prefs.voiceShareFilePaths,
        shareSessionSummary: prefs.voiceShareSessionSummary,
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

export function summarizeAgentRequestForVoiceHuman(
    requestKind: 'permission' | 'user_action',
    _requestId: string,
    toolName: string,
    toolArgs: unknown,
    prefs?: VoiceContextFormatterPrefs,
): string {
    const resolved = resolvePrefs(prefs);
    const sharedToolName = resolved.voiceShareToolNames ? toolName : 'the requested tool';

    if (requestKind === 'permission') {
        const summarized = formatPermissionRequestSummary({
            toolName: sharedToolName,
            toolInput: resolved.voiceShareFilePaths ? toolArgs : redactVoicePathLikeData(toolArgs ?? null),
        }).replace(/^Permission required:\s*/i, '').trim();
        return `The coding session needs permission for ${summarized}. Review it in the session UI to approve or deny.`;
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
    const sharedToolName = resolved.voiceShareToolNames ? toolName : null;
    const sessionReference = formatSessionReference(sessionId, resolved);
    return trimIdent(`
        Coding assistant is requesting permission to use ${sharedToolName ?? 'a tool'} in ${sessionReference}:
        <request_id>${requestId}</request_id>
        ${sharedToolName ? `<tool_name>${sharedToolName}</tool_name>` : '<tool_name_redacted>true</tool_name_redacted>'}
        ${args ? `<tool_args>${args}</tool_args>` : '<tool_args_redacted>true</tool_args_redacted>'}
        Interrupt your previous plan and tell the human about this request now.
        Do not call any tools or send new coding-session work while this permission remains pending.
        Tell the human to use the canonical session UI to approve or deny it.
        A spoken answer does not decide this permission request.
        Never claim it was settled until canonical session updates show the result.
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
    const sharedToolName = resolved.voiceShareToolNames ? toolName : null;
    const redactedActionGuidance = !summary && !args
        ? 'Review the request and approve, reject, or request changes based on the user intent.'
        : '';
    const sessionReference = formatSessionReference(sessionId, resolved);
    return trimIdent(`
        Coding assistant needs user input to continue in ${sessionReference}:
        <request_id>${requestId}</request_id>
        <request_kind>user_action</request_kind>
        ${sharedToolName ? `<tool_name>${sharedToolName}</tool_name>` : '<tool_name_redacted>true</tool_name_redacted>'}
        ${summary ? summary : ''}
        ${args ? `<request_payload>${args}</request_payload>` : '<request_payload_redacted>true</request_payload_redacted>'}
        ${redactedActionGuidance}
        Interrupt your previous plan and present this request to the human now.
        Do not call other tools or send new coding-session work until the human answers.
        Ask the human for the missing input. Reply with answerUserActionRequest using structured question/values entries for this user_action request.
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
    const state: any = storage.getState();
    const lookupSessionMetadata = resolveSessionListPreferredSessionMetadataFromState(state, session.id);
    const sharedSessionMetadata = lookupSessionMetadata ?? session.metadata;
    const ownerSessionMetadata = readVoiceSessionOwnerMetadataFromState(state, session.id);
    const rawSessionSummary =
        typeof sharedSessionMetadata?.summary?.text === 'string'
            ? sharedSessionMetadata.summary.text
            : typeof sharedSessionMetadata?.summaryText === 'string'
                ? sharedSessionMetadata.summaryText
                : null;
    const sessionSummary = rawSessionSummary
        ? maybeRedactVoiceString(rawSessionSummary, resolved.voiceShareFilePaths)
        : null;
    const lines: string[] = [];

    // Add session context
    lines.push(`# Session: ${resolveVoiceSessionLabel(session.id, resolved, { metadata: sharedSessionMetadata, fallbackLabel: 'the current session' })}`);
    if (resolved.voiceShareFilePaths && ownerSessionMetadata && typeof ownerSessionMetadata.path === 'string') {
        const path = String(ownerSessionMetadata.path);
        if (path.trim().length > 0) {
            lines.push('## Session Path');
            lines.push(path);
        }
    }
    if (resolved.voiceShareSessionSummary && sessionSummary) {
        lines.push('## Session Summary');
        lines.push(sessionSummary);
    }

    if (resolved.voiceSharePermissionRequests) {
        const pendingRequestSections: string[] = [];
        for (const request of listPendingSessionRequests(session, messages)) {
            if (request.kind === 'user_action') {
                pendingRequestSections.push(
                    formatUserActionRequest(
                        session.id,
                        request.id,
                        request.tool,
                        request.arguments,
                        prefs,
                    ),
                );
                continue;
            }

            pendingRequestSections.push(
                formatPermissionRequest(
                    session.id,
                    request.id,
                    request.tool,
                    request.arguments,
                    prefs,
                ),
            );
        }
        if (pendingRequestSections.length > 0) {
            lines.push('## Pending Requests');
            lines.push(pendingRequestSections.join('\n\n'));
        }
    }

    const recent = formatRecentMessages(session.id, messages, prefs);
    if (recent) {
        lines.push('## Recent Messages');
        lines.push(recent);
    }

    return lines.join('\n\n');
}

export function formatSessionOffline(
    sessionId: string,
    metadata: SessionMetadata | undefined,
    formatterPrefs: VoiceContextFormatterPrefs,
): string {
    const prefs = resolvePrefs(formatterPrefs);
    return `${formatSessionReference(sessionId, prefs, metadata, 'the current session')} went offline.`;
}

export function formatSessionOnline(
    sessionId: string,
    metadata: SessionMetadata | undefined,
    formatterPrefs: VoiceContextFormatterPrefs,
): string {
    const prefs = resolvePrefs(formatterPrefs);
    return `${formatSessionReference(sessionId, prefs, metadata, 'the current session')} came online.`;
}

export function formatReadyEvent(
    sessionId: string,
    messages?: ReadonlyArray<Message>,
    prefs?: VoiceContextFormatterPrefs,
): string {
    const resolved = resolvePrefs(prefs);
    const summary = resolved.voiceShareRecentMessages
        ? summarizeAssistantMessagesForVoiceHuman(messages ?? [], prefs)
        : null;
    const sessionReference = formatSessionReference(sessionId, resolved);
    if (summary) {
        return `Coding assistant finished working in ${sessionReference}. Latest response: ${summary} Report this to the human immediately.`;
    }
    return `Coding assistant finished working in ${sessionReference}. The previous message(s) summarize the work done. Report this to the human immediately.`;
}
