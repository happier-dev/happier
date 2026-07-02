import type { RawJSONLines } from './rawJsonLines.js';
import { isClaudeInternalTranscriptMessage } from './visibility.js';

function isTaskNotificationUserText(message: RawJSONLines): boolean {
    if (message.type !== 'user') return false;
    if ((message as { isSidechain?: unknown }).isSidechain === true) return false;
    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (typeof content !== 'string') return false;
    return /^\s*<task-notification>/i.test(content);
}

function extractTaskNotification(payload: string): { taskId: string; result: string } | null {
    const raw = String(payload ?? '');
    const taskId = raw.match(/<task-id>\s*([^<\n\r]+?)\s*<\/task-id>/i)?.[1]?.trim() ?? '';
    if (!taskId) return null;
    const result = raw.match(/<result>\s*([\s\S]*?)\s*<\/result>/i)?.[1]?.trim() ?? '';
    if (!result) return null;
    return { taskId, result };
}

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return `summary: ${message.leafUuid}: ${message.summary}`;
    } else if (message.type === 'system') {
        return message.uuid;
    } else if (message.type === 'progress') {
        const uuid = typeof (message as { uuid?: unknown }).uuid === 'string' ? String((message as { uuid: string }).uuid) : '';
        if (uuid) return `progress:${uuid}`;
        const progressRecord = message as Record<string, unknown>;
        const ts = typeof progressRecord.timestamp === 'string' ? progressRecord.timestamp : '';
        if (ts) return `progress:timestamp:${ts}`;
        return `progress:${JSON.stringify(message)}`;
    }
    throw Error('Unsupported Claude message type');
}

function isInformationalSystemMessage(message: RawJSONLines): boolean {
    return message.type === 'system';
}

export function createMessageRouter(params: Readonly<{
    onMessage: (message: RawJSONLines) => void;
    logEvent: (event: string, message: RawJSONLines) => void;
}>): Readonly<{
    observeSessionMessage: (message: RawJSONLines) => void;
    emitImportedSidechainMessage: (message: RawJSONLines) => void;
    emitImportedTeamInboxMessage: (message: RawJSONLines) => void;
    emitSessionMessage: (message: RawJSONLines, shouldEmit: boolean) => void;
    reset: () => void;
}> {
    const processedMessageKeys = new Set<string>();
    const taskToolUseIdByAgentId = new Map<string, string>();

    function observeTaskToolResultMapping(message: RawJSONLines): void {
        if (message.type !== 'user') return;
        const toolUseResult = (message as { toolUseResult?: unknown }).toolUseResult;
        if (!toolUseResult || typeof toolUseResult !== 'object') return;
        const agentId =
            typeof (toolUseResult as { agentId?: unknown }).agentId === 'string'
                ? String((toolUseResult as { agentId: string }).agentId).trim()
                : '';
        if (!agentId) return;

        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) return;
        for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            if ((item as { type?: unknown }).type !== 'tool_result') continue;
            const toolUseId = typeof (item as { tool_use_id?: unknown }).tool_use_id === 'string'
                ? String((item as { tool_use_id: string }).tool_use_id).trim()
                : '';
            if (!toolUseId) continue;
            taskToolUseIdByAgentId.set(agentId, toolUseId);
        }
    }

    function maybeRewriteTaskNotificationToToolResult(message: RawJSONLines): RawJSONLines | null | undefined {
        if (!isTaskNotificationUserText(message)) return message;
        const content = String((message as { message: { content: string } }).message.content ?? '');
        const parsed = extractTaskNotification(content);
        if (!parsed) return null;

        const toolUseId = taskToolUseIdByAgentId.get(parsed.taskId) ?? null;
        if (!toolUseId) {
            return null;
        }

        return {
            ...message,
            isMeta: true,
            type: 'user',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: [{ type: 'text', text: parsed.result }],
                        is_error: false,
                    },
                ],
            },
        } as RawJSONLines;
    }

    function emitObservedMessage(message: RawJSONLines, eventName: string, shouldEmit: boolean): void {
        const key = messageKey(message);
        if (processedMessageKeys.has(key)) {
            return;
        }
        processedMessageKeys.add(key);

        if (!shouldEmit) {
            return;
        }

        if (isInformationalSystemMessage(message)) {
            return;
        }
        if (isClaudeInternalTranscriptMessage(message)) {
            return;
        }

        const rewritten = maybeRewriteTaskNotificationToToolResult(message);
        if (rewritten === null) {
            return;
        }

        const nextMessage = rewritten ?? message;
        params.logEvent(eventName, nextMessage);
        params.onMessage(nextMessage);
    }

    function emitImportedMessage(message: RawJSONLines, eventName: string): void {
        const key = messageKey(message);
        if (processedMessageKeys.has(key)) return;
        processedMessageKeys.add(key);
        params.logEvent(eventName, message);
        params.onMessage(message);
    }

    return {
        observeSessionMessage: observeTaskToolResultMapping,
        emitImportedSidechainMessage: (message: RawJSONLines) => emitImportedMessage(message, 'emit:sidechain-import'),
        emitImportedTeamInboxMessage: (message: RawJSONLines) => emitImportedMessage(message, 'emit:team-inbox'),
        emitSessionMessage: (message: RawJSONLines, shouldEmit: boolean) => emitObservedMessage(message, `emit:${String((message as { type?: unknown })?.type ?? 'unknown')}`, shouldEmit),
        reset: () => {
            processedMessageKeys.clear();
            taskToolUseIdByAgentId.clear();
        },
    };
}
