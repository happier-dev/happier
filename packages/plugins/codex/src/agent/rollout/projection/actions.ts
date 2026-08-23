import {
    canonicalizeCodexRolloutToolName,
    normalizeCodexRolloutToolInput,
} from './toolInvocation.js';
import {
    formatCodexMcpToolSource,
    readCodexMcpToolSource,
    type CodexRolloutToolSource,
} from './mcpToolSource.js';

export type CodexRolloutAction =
    | { type: 'codex-session-id'; id: string }
    | { type: 'user-text'; text: string }
    | { type: 'assistant-text'; text: string }
    | { type: 'tool-call'; callId: string; name: string; input: unknown; source?: CodexRolloutToolSource }
    | { type: 'tool-result'; callId: string; output: unknown; isError?: boolean }
    | { type: 'collaboration-tool-call'; callId: string; name: 'spawn_agent' | 'wait_agent' | 'close_agent'; prompt: string | null; nickname: string | null; role: string | null }
    | { type: 'collaboration-tool-result'; callId: string; threadId: string | null; nickname: string | null }
    | { type: 'subagent-spawn'; threadId: string; prompt: string | null; nickname: string | null; role: string | null }
    | { type: 'subagent-complete'; threadId: string; status: 'completed' | 'interrupted'; summaryText: string | null }
    | { type: 'debug'; message: string; value?: unknown };

type RolloutEnvelope = { timestamp?: string; type?: string; payload?: unknown };

/**
 * Rollout envelopes the pinned recorder durably writes that carry no
 * recipient-facing transcript row. `compacted` restates history this reader
 * already published from the rows it replaces, `world_state` is environment
 * context rather than conversation, and `inter_agent_communication_metadata`
 * is turn-routing metadata. Advancing past them is safe; treating them as
 * unknown fails the whole page.
 */
const CODEX_KNOWN_NON_TRANSCRIPT_ENVELOPE_TYPES: ReadonlySet<string> = new Set([
    'compacted',
    'inter_agent_communication_metadata',
    'world_state',
]);

/**
 * `event_msg` payload families the pinned recorder persists that this leaf
 * intentionally does not publish: turn lifecycle, token accounting, sub-agent
 * activity pings, the tool-lifecycle echoes of the `response_item` call/output
 * pair, reasoning (which has no row in this leaf's transcript vocabulary), and
 * `user_message`, which always mirrors the canonical `response_item` user row
 * recorded immediately before it.
 */
const CODEX_KNOWN_NON_TRANSCRIPT_EVENT_MSG_TYPES: ReadonlySet<string> = new Set([
    'agent_reasoning',
    'context_compacted',
    'exec_command_end',
    'mcp_tool_call_end',
    'patch_apply_end',
    'sub_agent_activity',
    'task_complete',
    'task_started',
    'thread_rolled_back',
    'thread_settings_applied',
    'token_count',
    'turn_aborted',
    'user_message',
    'web_search_end',
]);

/**
 * `response_item` payload families the recorder persists that this leaf does
 * not publish: reasoning has no row in the Codex transcript vocabulary,
 * `ghost_snapshot` is git snapshot bookkeeping, and `agent_message` is the
 * inter-agent routing copy of a prompt already published from the
 * `spawn_agent` call that produced it.
 */
const CODEX_KNOWN_NON_TRANSCRIPT_RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
    'agent_message',
    'ghost_snapshot',
    'reasoning',
    'web_search_call',
]);

/**
 * Keeps strict source-record admission beside the Codex event parser. A record
 * can be known but intentionally content-free; an unknown or malformed record
 * must never be mistaken for one of those safe skips by a cursor owner.
 */
export type CodexRolloutRecordProjection = Readonly<{
    disposition: 'known' | 'unsupported';
    actions: CodexRolloutAction[];
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readCodexMessageContentText(content: unknown): string | null {
    const directText = readNonEmptyString(content);
    if (directText) return directText;
    if (!Array.isArray(content)) return null;

    const parts: string[] = [];
    for (const entry of content) {
        const record = asRecord(entry);
        if (!record) continue;
        const text = readNonEmptyString(record.text);
        if (text) parts.push(text);
    }

    return parts.length > 0 ? parts.join('\n') : null;
}

function shouldFilterHarnessBlob(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    // Known harness/system blobs embedded as user content.
    const patterns = [
        '# AGENTS.md instructions',
        '<environment_context>',
        '<turn_aborted>',
        '<INSTRUCTIONS>',
        '<subagent_notification>',
        'You are GPT-',
        'Codex CLI is an open source project',
    ];
    return patterns.some((p) => t.includes(p));
}

function safeJsonParse(value: string): unknown | null {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function readToolResultIsError(output: unknown): boolean | undefined {
    const success = asRecord(output)?.success;
    return typeof success === 'boolean' ? !success : undefined;
}

function parseSubagentNotification(text: string): Extract<CodexRolloutAction, { type: 'subagent-complete' }> | null {
    const match = text.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/);
    if (!match?.[1]) return null;
    const parsed = safeJsonParse(match[1]);
    const record = asRecord(parsed);
    if (!record) return null;

    const threadId = readStringField(record, 'agent_id');
    const status = readCollaborationStatus(record.status);
    if (!threadId || !status) return null;

    return {
        type: 'subagent-complete',
        threadId,
        status: status.status,
        summaryText: status.summaryText,
    };
}

function withLocalControlMeta(input: unknown): unknown {
    const record = asRecord(input);
    if (record) {
        const currentHappier = asRecord(record._happier) ?? {};
        const legacyHappy = asRecord(record._happy) ?? {};
        return {
            ...record,
            _happier: { ...legacyHappy, ...currentHappier, sessionMode: 'local_control' },
        };
    }
    return { _raw: input, _happier: { sessionMode: 'local_control' } };
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCollaborationStatus(statusValue: unknown): { status: 'completed' | 'interrupted'; summaryText: string | null } | null {
    const statusRecord = asRecord(statusValue);
    if (!statusRecord) return null;

    const completedText = readStringField(statusRecord, 'completed');
    if (completedText) {
        return { status: 'completed', summaryText: completedText };
    }

    const interruptedText =
        readStringField(statusRecord, 'interrupted')
        ?? readStringField(statusRecord, 'failed')
        ?? readStringField(statusRecord, 'error')
        ?? readStringField(statusRecord, 'cancelled');
    if (interruptedText) {
        return { status: 'interrupted', summaryText: interruptedText };
    }

    return null;
}

function readWaitingEndSubagentCompletions(payload: Record<string, unknown>): CodexRolloutAction[] {
    const actions: CodexRolloutAction[] = [];
    const agentStatuses = Array.isArray(payload.agent_statuses) ? payload.agent_statuses : [];
    for (const entry of agentStatuses) {
        const record = asRecord(entry);
        if (!record) continue;
        const threadId = readStringField(record, 'thread_id');
        const status = readCollaborationStatus(record.status);
        if (!threadId || !status) continue;
        actions.push({
            type: 'subagent-complete',
            threadId,
            status: status.status,
            summaryText: status.summaryText,
        });
    }
    return actions;
}

export function projectCodexRolloutRecord(
    event: unknown,
    opts: { debug: boolean },
): CodexRolloutRecordProjection {
    const env = asRecord(event) as RolloutEnvelope | null;
    if (!env || typeof env.type !== 'string') {
        return { disposition: 'unsupported', actions: [] };
    }

    if (env.type === 'session_meta') {
        const payload = asRecord(env.payload);
        const id = payload ? readNonEmptyString(payload.id) : null;
        return id
            ? { disposition: 'known', actions: [{ type: 'codex-session-id', id }] }
            : { disposition: 'unsupported', actions: [] };
    }

    // Codex emits this bounded turn metadata between transcript records. It is
    // a ratified source fact but has no recipient-facing transcript projection.
    if (env.type === 'turn_context' || CODEX_KNOWN_NON_TRANSCRIPT_ENVELOPE_TYPES.has(env.type)) {
        return asRecord(env.payload)
            ? { disposition: 'known', actions: [] }
            : { disposition: 'unsupported', actions: [] };
    }

    if (env.type === 'event_msg') {
        const payload = asRecord(env.payload);
        const payloadType = payload && typeof payload.type === 'string' ? String(payload.type) : '';
        if (!payload || !payloadType) {
            return {
                disposition: 'unsupported',
                actions: opts.debug
                    ? [{ type: 'debug', message: 'unhandled rollout event type: ', value: payload ?? {} }]
                    : [],
            };
        }

        if (payloadType === 'collab_agent_spawn_end') {
            const threadId = readStringField(payload, 'new_thread_id');
            return threadId
                ? {
                    disposition: 'known',
                    actions: [{
                        type: 'subagent-spawn',
                        threadId,
                        prompt: readStringField(payload, 'prompt'),
                        nickname: readStringField(payload, 'new_agent_nickname'),
                        role: readStringField(payload, 'new_agent_role'),
                    }],
                }
                : { disposition: 'unsupported', actions: [] };
        }

        if (payloadType === 'collab_waiting_end') {
            return {
                disposition: 'known',
                actions: readWaitingEndSubagentCompletions(payload),
            };
        }

        if (payloadType === 'collab_close_end') {
            const threadId = readStringField(payload, 'receiver_thread_id');
            const status = readCollaborationStatus(payload.status);
            return threadId && status
                ? {
                    disposition: 'known',
                    actions: [{
                        type: 'subagent-complete',
                        threadId,
                        status: status.status,
                        summaryText: status.summaryText,
                    }],
                }
                : { disposition: 'unsupported', actions: [] };
        }

        // The pinned recorder stops writing `response_item` assistant messages,
        // so from 0.145.0 this event is the only durable carrier of the
        // assistant turn. Pre-frontier rollouts record both; the semantic
        // tracker drops the duplicate so either era publishes the turn once.
        if (payloadType === 'agent_message') {
            const message = readCodexMessageContentText(payload.message ?? payload.content);
            return message
                ? { disposition: 'known', actions: [{ type: 'assistant-text', text: message }] }
                : { disposition: 'unsupported', actions: [] };
        }

        if (CODEX_KNOWN_NON_TRANSCRIPT_EVENT_MSG_TYPES.has(payloadType)) {
            return { disposition: 'known', actions: [] };
        }

        return {
            disposition: 'unsupported',
            actions: opts.debug
                ? [{ type: 'debug', message: `unhandled rollout event type: ${payloadType}`, value: payload }]
                : [],
        };
    }

    if (env.type !== 'response_item') {
        return { disposition: 'unsupported', actions: [] };
    }
    const payload = asRecord(env.payload);
    const payloadType = payload && typeof payload.type === 'string' ? String(payload.type) : '';
    if (!payload || !payloadType) {
        return {
            disposition: 'unsupported',
            actions: opts.debug
                ? [{ type: 'debug', message: 'unhandled rollout payload type: ', value: payload ?? {} }]
                : [],
        };
    }

    if (CODEX_KNOWN_NON_TRANSCRIPT_RESPONSE_ITEM_TYPES.has(payloadType)) {
        return { disposition: 'known', actions: [] };
    }

    if (payloadType === 'message') {
        const role = typeof payload.role === 'string' ? String(payload.role) : '';
        const content = readCodexMessageContentText(payload.content);
        if (!content) return { disposition: 'unsupported', actions: [] };

        if (role === 'developer') {
            return {
                disposition: 'known',
                actions: opts.debug ? [{ type: 'debug', message: 'developer message', value: payload }] : [],
            };
        }

        if (role === 'user') {
            const notification = parseSubagentNotification(content);
            if (notification) return { disposition: 'known', actions: [notification] };
            if (shouldFilterHarnessBlob(content)) return { disposition: 'known', actions: [] };
            return { disposition: 'known', actions: [{ type: 'user-text', text: content }] };
        }

        // Default: assistant/agent output.
        return { disposition: 'known', actions: [{ type: 'assistant-text', text: content }] };
    }

    if (payloadType === 'function_call') {
        const name = typeof payload.name === 'string' ? String(payload.name) : '';
        const callId = typeof payload.call_id === 'string' ? String(payload.call_id) : '';
        if (!name || !callId) return { disposition: 'unsupported', actions: [] };

        if (name === 'spawn_agent' || name === 'wait_agent' || name === 'close_agent') {
            const rawArgs = payload.arguments;
            const parsedArgs =
                typeof rawArgs === 'string'
                    ? safeJsonParse(rawArgs) ?? rawArgs
                    : rawArgs;
            const argsRecord = asRecord(parsedArgs);
            return {
                disposition: 'known',
                actions: [{
                    type: 'collaboration-tool-call',
                    callId,
                    name,
                    prompt:
                        readStringField(argsRecord ?? {}, 'message')
                        ?? readStringField(argsRecord ?? {}, 'prompt'),
                    nickname:
                        readStringField(argsRecord ?? {}, 'agent_nickname')
                        ?? readStringField(argsRecord ?? {}, 'nickname'),
                    role:
                        readStringField(argsRecord ?? {}, 'agent_role')
                        ?? readStringField(argsRecord ?? {}, 'agent_type')
                        ?? readStringField(argsRecord ?? {}, 'role'),
                }],
            };
        }

        const source = readCodexMcpToolSource(payload, name);
        const rawToolName = source ? formatCodexMcpToolSource(source) : name;
        const { canonicalToolName, visibility } = canonicalizeCodexRolloutToolName(rawToolName);
        if (visibility === 'ignore') return { disposition: 'known', actions: [] };
        if (visibility === 'debug-only' && !opts.debug) return { disposition: 'known', actions: [] };

        const rawArgs = payload.arguments;
        const parsedArgs =
            typeof rawArgs === 'string'
                ? safeJsonParse(rawArgs) ?? rawArgs
                : rawArgs;
        const input = withLocalControlMeta(normalizeCodexRolloutToolInput(name, parsedArgs));

        return {
            disposition: 'known',
            actions: [{ type: 'tool-call', callId, name: canonicalToolName, input, ...(source ? { source } : {}) }],
        };
    }

    if (payloadType === 'function_call_output') {
        const callId = typeof payload.call_id === 'string' ? String(payload.call_id) : '';
        if (!callId) return { disposition: 'unsupported', actions: [] };
        const outputRaw = payload.output;
        const output = typeof outputRaw === 'string' ? safeJsonParse(outputRaw) ?? outputRaw : outputRaw;
        const outputRecord = asRecord(output);
        const spawnedThreadId = readStringField(outputRecord ?? {}, 'agent_id');
        if (spawnedThreadId) {
            return {
                disposition: 'known',
                actions: [{
                    type: 'collaboration-tool-result',
                    callId,
                    threadId: spawnedThreadId,
                    nickname: readStringField(outputRecord ?? {}, 'nickname'),
                }],
            };
        }
        const isError = readToolResultIsError(output);
        return {
            disposition: 'known',
            actions: [{ type: 'tool-result', callId, output, ...(isError === undefined ? {} : { isError }) }],
        };
    }

    if (payloadType === 'custom_tool_call') {
        const name = typeof payload.name === 'string' ? String(payload.name) : '';
        const callId = typeof payload.call_id === 'string' ? String(payload.call_id) : '';
        if (!name || !callId) return { disposition: 'unsupported', actions: [] };

        const source = readCodexMcpToolSource(payload, name);
        const rawToolName = source ? formatCodexMcpToolSource(source) : name;
        const { canonicalToolName, visibility } = canonicalizeCodexRolloutToolName(rawToolName);
        if (visibility === 'ignore') return { disposition: 'known', actions: [] };
        if (visibility === 'debug-only' && !opts.debug) return { disposition: 'known', actions: [] };

        const input = withLocalControlMeta(normalizeCodexRolloutToolInput(name, payload.input));
        return {
            disposition: 'known',
            actions: [{ type: 'tool-call', callId, name: canonicalToolName, input, ...(source ? { source } : {}) }],
        };
    }

    if (payloadType === 'custom_tool_call_output') {
        const callId = typeof payload.call_id === 'string' ? String(payload.call_id) : '';
        if (!callId) return { disposition: 'unsupported', actions: [] };
        const outputRaw = payload.output;
        const output = typeof outputRaw === 'string' ? safeJsonParse(outputRaw) ?? outputRaw : outputRaw;
        const isError = readToolResultIsError(output);
        return {
            disposition: 'known',
            actions: [{ type: 'tool-result', callId, output, ...(isError === undefined ? {} : { isError }) }],
        };
    }

    return {
        disposition: 'unsupported',
        actions: opts.debug
            ? [{ type: 'debug', message: `unhandled rollout payload type: ${payloadType}`, value: payload }]
            : [],
    };
}

export function mapCodexRolloutEventToActions(
    event: unknown,
    opts: { debug: boolean },
): CodexRolloutAction[] {
    return projectCodexRolloutRecord(event, opts).actions;
}
