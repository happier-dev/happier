import { extractMcpToolCallResultOutput } from '../runtime/sessionTurnLifecycle';

type RecordLike = Record<string, unknown>;

type ToolKind = 'command' | 'mcp' | 'file-change';

type NotificationEnvelope = Readonly<{
    method: string;
    params?: unknown;
}>;

type ServerRequestEnvelope = Readonly<{
    method: string;
    params?: unknown;
}>;

type ToolContext = Readonly<{
    toolKind: ToolKind;
    name: string;
    input: unknown;
}>;

export type CodexAppServerStreamUpdate =
    | Readonly<{ type: 'assistant-text-delta'; itemId: string; text: string }>
    | Readonly<{ type: 'assistant-text-final'; itemId: string; text: string }>
    | Readonly<{ type: 'reasoning-delta'; itemId: string; text: string }>
    | Readonly<{ type: 'reasoning-final'; itemId: string; text: string }>
    | Readonly<{ type: 'turn-diff-updated'; turnId: string | null; unifiedDiff: string }>
    | Readonly<{ type: 'tool-call'; toolKind: ToolKind; callId: string; name: string; input: unknown }>
    | Readonly<{ type: 'tool-result'; toolKind: ToolKind; callId: string; output: unknown }>
    | Readonly<{
        type: 'approval-request';
        requestKind: 'command-execution' | 'file-change';
        callId: string;
        toolName: string;
        input: unknown;
        approval: RecordLike;
    }>
    | Readonly<{
        type: 'user-input-request';
        callId: string;
        toolName: string;
        input: unknown;
        questions: unknown[];
    }>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readText(value: RecordLike, keys: readonly string[]): string | null {
    for (const key of keys) {
        const text = readString(value[key]);
        if (text) return text;
    }
    return null;
}

function readQuestions(value: RecordLike): unknown[] | null {
    return Array.isArray(value.questions) ? value.questions : null;
}

function normalizeType(value: string | null): string | null {
    if (!value) return null;
    return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function readItem(params: unknown): RecordLike | null {
    const record = asRecord(params);
    if (!record) return null;
    return asRecord(record.item) ?? record;
}

function readItemId(value: RecordLike): string | null {
    return readString(value.itemId) ?? readString(value.id) ?? readString(value.callId) ?? readString(value.call_id);
}

function readItemType(value: RecordLike): string | null {
    return normalizeType(readString(value.type) ?? readString(value.itemType));
}

function omitKeys(value: RecordLike, keys: readonly string[]): RecordLike {
    const next: RecordLike = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!keys.includes(key)) next[key] = entry;
    }
    return next;
}

function readToolContextFromItem(item: RecordLike): ToolContext | null {
    const itemType = readItemType(item);
    if (itemType === 'commandexecution') {
        const command = readString(item.command);
        const cwd = readString(item.cwd);
        if (!command && !cwd) return null;
        return {
            toolKind: 'command',
            name: 'CodexBash',
            input: omitKeys(item, ['id', 'itemId', 'type', 'itemType', 'stderr', 'stdout', 'exitCode', 'exit_code', 'status', 'success', 'error']),
        };
    }

    if (itemType === 'filechange') {
        if (!Object.prototype.hasOwnProperty.call(item, 'changes')) return null;
        return {
            toolKind: 'file-change',
            name: 'CodexPatch',
            input: omitKeys(item, ['id', 'itemId', 'type', 'itemType', 'stderr', 'stdout', 'exitCode', 'exit_code', 'status', 'success', 'error']),
        };
    }

    if (itemType !== 'mcptoolcall') return null;

    const server = readString(item.server);
    const tool = readString(item.tool) ?? readString(item.name);
    const name = server && tool ? `mcp__${server}__${tool}` : tool;
    if (!name) return null;

    return {
        toolKind: 'mcp',
        name,
        input: item.arguments ?? item.input ?? {},
    };
}

function readToolResultOutput(item: RecordLike, itemType: string | null, input?: unknown): unknown {
    const inputKeys = input && typeof input === 'object' && !Array.isArray(input)
        ? Object.keys(input as RecordLike)
        : [];
    const output = omitKeys(item, ['id', 'itemId', 'type', 'itemType', ...inputKeys]);
    return itemType === 'mcptoolcall' && 'result' in item ? extractMcpToolCallResultOutput(item.result) : output;
}

function readFinalReasoningText(item: RecordLike): string | null {
    const content = Array.isArray(item.content)
        ? item.content.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
    if (content.length > 0) return content.join('\n\n');
    const summary = Array.isArray(item.summary)
        ? item.summary.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
    return summary.length > 0 ? summary.join('\n\n') : null;
}

export function createCodexAppServerStreamEventBridge(): Readonly<{
    onNotification: (notification: NotificationEnvelope) => CodexAppServerStreamUpdate[];
    onServerRequest: (request: ServerRequestEnvelope) => CodexAppServerStreamUpdate[];
}> {
    const toolContextByCallId = new Map<string, ToolContext>();

    const rememberToolContext = (callId: string, toolContext: ToolContext): void => {
        toolContextByCallId.set(callId, toolContext);
    };

    const resolveToolContext = (params: unknown): Readonly<{ callId: string; toolContext: ToolContext }> | null => {
        const item = readItem(params);
        const record = asRecord(params);
        const callId = item ? readItemId(item) : record ? readItemId(record) : null;
        if (!callId) return null;

        const fromItem = item ? readToolContextFromItem(item) : null;
        if (fromItem) {
            rememberToolContext(callId, fromItem);
            return { callId, toolContext: fromItem };
        }

        const remembered = toolContextByCallId.get(callId);
        if (!remembered) return null;
        return { callId, toolContext: remembered };
    };

    return {
        onNotification: (notification): CodexAppServerStreamUpdate[] => {
            const params = asRecord(notification.params);
            if (!params) return [];

            if (notification.method === 'item/agentMessage/delta' || notification.method === 'item/plan/delta') {
                const itemId = readItemId(params);
                const text = readText(params, ['delta', 'text', 'message']);
                return itemId && text ? [{ type: 'assistant-text-delta', itemId, text }] : [];
            }

            if (notification.method === 'turn/diff/updated') {
                const unifiedDiff = readText(params, ['unifiedDiff', 'unified_diff', 'diff']);
                if (!unifiedDiff) return [];
                return [{
                    type: 'turn-diff-updated',
                    turnId: readString(params.turnId) ?? readString(params.id),
                    unifiedDiff,
                }];
            }

            if (notification.method === 'item/reasoning/summaryTextDelta' || notification.method === 'item/reasoning/textDelta') {
                const itemId = readItemId(params);
                const text = readText(params, ['delta', 'text']);
                return itemId && text ? [{ type: 'reasoning-delta', itemId, text }] : [];
            }

            if (notification.method === 'item/started') {
                const resolved = resolveToolContext(params);
                if (!resolved) return [];
                return [{
                    type: 'tool-call',
                    toolKind: resolved.toolContext.toolKind,
                    callId: resolved.callId,
                    name: resolved.toolContext.name,
                    input: resolved.toolContext.input,
                }];
            }

            if (notification.method !== 'item/completed') return [];

            const item = readItem(params);
            if (!item) return [];
            const itemId = readItemId(item);
            const itemType = readItemType(item);
            if (!itemId || !itemType) return [];

            if (itemType === 'agentmessage' || itemType === 'plan') {
                const text = readText(item, ['text', 'message', 'content']);
                return text ? [{ type: 'assistant-text-final', itemId, text }] : [];
            }

            if (itemType === 'reasoning') {
                const text = readFinalReasoningText(item);
                return text ? [{ type: 'reasoning-final', itemId, text }] : [];
            }

            const rememberedToolContext = toolContextByCallId.get(itemId) ?? null;
            const synthesizedToolContext = rememberedToolContext ?? readToolContextFromItem(item);
            if (!synthesizedToolContext) return [];
            toolContextByCallId.delete(itemId);
            if (rememberedToolContext) {
                return [{
                    type: 'tool-result',
                    toolKind: rememberedToolContext.toolKind,
                    callId: itemId,
                    output: readToolResultOutput(item, itemType),
                }];
            }
            return [
                {
                    type: 'tool-call',
                    toolKind: synthesizedToolContext.toolKind,
                    callId: itemId,
                    name: synthesizedToolContext.name,
                    input: synthesizedToolContext.input,
                },
                {
                    type: 'tool-result',
                    toolKind: synthesizedToolContext.toolKind,
                    callId: itemId,
                    output: readToolResultOutput(item, itemType, synthesizedToolContext.input),
                },
            ];
        },

        onServerRequest: (request): CodexAppServerStreamUpdate[] => {
            const params = asRecord(request.params);
            if (!params) return [];
            const callId = readItemId(params);
            if (!callId) return [];

            const resolved = resolveToolContext(params);
            if (!resolved) return [];

            if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
                return [{
                    type: 'approval-request',
                    requestKind: request.method === 'item/commandExecution/requestApproval' ? 'command-execution' : 'file-change',
                    callId,
                    toolName: resolved.toolContext.name,
                    input: resolved.toolContext.input,
                    approval: omitKeys(params, ['threadId', 'turnId', 'itemId']),
                }];
            }

            if (request.method !== 'item/tool/requestUserInput') return [];
            const questions = readQuestions(params);
            if (!questions) return [];

            return [{
                type: 'user-input-request',
                callId,
                toolName: resolved.toolContext.name,
                input: resolved.toolContext.input,
                questions,
            }];
        },
    };
}
