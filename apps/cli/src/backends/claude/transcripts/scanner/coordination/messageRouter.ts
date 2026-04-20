import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';

function isTaskNotificationUserText(message: RawJSONLines): boolean {
    if (message.type !== 'user') return false;
    if ((message as any).isSidechain === true) return false;
    const content = (message as any)?.message?.content;
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
        const uuid = typeof (message as any).uuid === 'string' ? (message as any).uuid : '';
        if (uuid) return `progress:${uuid}`;
        const ts = typeof (message as any).timestamp === 'string' ? (message as any).timestamp : '';
        if (ts) return `progress:timestamp:${ts}`;
        return `progress:${JSON.stringify(message)}`;
    }
    throw Error('Unsupported Claude message type');
}

// Claude Code `system` lines are out-of-band side-channels (init, stop-hook summaries, inactivity
// recaps, etc.) — none of them are agent transcript content. Drop them wholesale; if a future
// subtype ever needs to render, opt it in explicitly rather than leak informational messages.
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
        const toolUseResult = (message as any).toolUseResult;
        if (!toolUseResult || typeof toolUseResult !== 'object') return;
        const agentId =
            typeof (toolUseResult as any).agentId === 'string' ? String((toolUseResult as any).agentId).trim() : '';
        if (!agentId) return;

        const content = (message as any)?.message?.content;
        if (!Array.isArray(content)) return;
        for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            if ((item as any).type !== 'tool_result') continue;
            const toolUseId = typeof (item as any).tool_use_id === 'string' ? String((item as any).tool_use_id).trim() : '';
            if (!toolUseId) continue;
            taskToolUseIdByAgentId.set(agentId, toolUseId);
        }
    }

    function maybeRewriteTaskNotificationToToolResult(message: RawJSONLines): RawJSONLines | null | undefined {
        if (!isTaskNotificationUserText(message)) return message;
        const content = String((message as any).message.content ?? '');
        const parsed = extractTaskNotification(content);
        if (!parsed) return null;

        const toolUseId = taskToolUseIdByAgentId.get(parsed.taskId) ?? null;
        if (!toolUseId) {
            return null;
        }

        return {
            ...(message as any),
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
        emitSessionMessage: (message: RawJSONLines, shouldEmit: boolean) => emitObservedMessage(message, `emit:${String((message as any)?.type ?? 'unknown')}`, shouldEmit),
        reset: () => {
            processedMessageKeys.clear();
            taskToolUseIdByAgentId.clear();
        },
    };
}
