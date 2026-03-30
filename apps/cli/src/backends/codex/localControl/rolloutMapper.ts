import {
    canonicalizeCodexRolloutToolName,
    normalizeCodexRolloutToolInput,
} from './rolloutToolNameMapping';
import { readCodexMessageContentText } from '../utils/readCodexMessageContentText';

export type CodexRolloutAction =
    | { type: 'codex-session-id'; id: string }
    | { type: 'user-text'; text: string }
    | { type: 'assistant-text'; text: string }
    | { type: 'tool-call'; callId: string; name: string; input: unknown }
    | { type: 'tool-result'; callId: string; output: unknown }
    | { type: 'collaboration-tool-call'; callId: string; name: 'spawn_agent' | 'wait_agent' | 'close_agent'; prompt: string | null; nickname: string | null; role: string | null }
    | { type: 'collaboration-tool-result'; callId: string; threadId: string | null; nickname: string | null }
    | { type: 'subagent-spawn'; threadId: string; prompt: string | null; nickname: string | null; role: string | null }
    | { type: 'subagent-complete'; threadId: string; status: 'completed' | 'interrupted'; summaryText: string | null }
    | { type: 'debug'; message: string; value?: unknown };

type RolloutEnvelope = { timestamp?: string; type?: string; payload?: any };

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
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
        const currentHappier = asRecord((record as any)._happier) ?? {};
        const legacyHappy = asRecord((record as any)._happy) ?? {};
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

export function mapCodexRolloutEventToActions(event: unknown, opts: { debug: boolean }): CodexRolloutAction[] {
    const env = asRecord(event) as RolloutEnvelope | null;
    if (!env || typeof env.type !== 'string') return [];

    if (env.type === 'session_meta') {
        const payload = asRecord(env.payload);
        const id = payload && typeof payload.id === 'string' ? payload.id : null;
        if (!id) return [];
        return [{ type: 'codex-session-id', id }];
    }

    if (env.type === 'event_msg') {
        const payload = asRecord(env.payload) ?? {};
        const payloadType = typeof payload.type === 'string' ? String(payload.type) : '';

        if (payloadType === 'collab_agent_spawn_end') {
            const threadId = readStringField(payload, 'new_thread_id');
            if (!threadId) return [];
            return [{
                type: 'subagent-spawn',
                threadId,
                prompt: readStringField(payload, 'prompt'),
                nickname: readStringField(payload, 'new_agent_nickname'),
                role: readStringField(payload, 'new_agent_role'),
            }];
        }

        if (payloadType === 'collab_waiting_end') {
            return readWaitingEndSubagentCompletions(payload);
        }

        if (payloadType === 'collab_close_end') {
            const threadId = readStringField(payload, 'receiver_thread_id');
            const status = readCollaborationStatus(payload.status);
            if (!threadId || !status) return [];
            return [{
                type: 'subagent-complete',
                threadId,
                status: status.status,
                summaryText: status.summaryText,
            }];
        }

        return opts.debug ? [{ type: 'debug', message: `unhandled rollout event type: ${payloadType}`, value: payload }] : [];
    }

    if (env.type !== 'response_item') return [];
    const payload = asRecord(env.payload) ?? {};
    const payloadType = typeof (payload as any).type === 'string' ? String((payload as any).type) : '';

    if (payloadType === 'message') {
        const role = typeof (payload as any).role === 'string' ? String((payload as any).role) : '';
        const content = readCodexMessageContentText((payload as any).content);
        if (!content) return [];

        if (role === 'developer') {
            return opts.debug ? [{ type: 'debug', message: 'developer message', value: payload }] : [];
        }

        if (role === 'user') {
            const notification = parseSubagentNotification(content);
            if (notification) return [notification];
            if (shouldFilterHarnessBlob(content)) return [];
            return [{ type: 'user-text', text: content }];
        }

        // Default: assistant/agent output.
        return [{ type: 'assistant-text', text: content }];
    }

    if (payloadType === 'function_call') {
        const name = typeof (payload as any).name === 'string' ? String((payload as any).name) : '';
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!name || !callId) return [];

        if (name === 'spawn_agent' || name === 'wait_agent' || name === 'close_agent') {
            const rawArgs = (payload as any).arguments;
            const parsedArgs =
                typeof rawArgs === 'string'
                    ? safeJsonParse(rawArgs) ?? rawArgs
                    : rawArgs;
            const argsRecord = asRecord(parsedArgs);
            return [{
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
            }];
        }

        const { canonicalToolName, visibility } = canonicalizeCodexRolloutToolName(name);
        if (visibility === 'ignore') return [];
        if (visibility === 'debug-only' && !opts.debug) return [];

        const rawArgs = (payload as any).arguments;
        const parsedArgs =
            typeof rawArgs === 'string'
                ? safeJsonParse(rawArgs) ?? rawArgs
                : rawArgs;
        const input = withLocalControlMeta(normalizeCodexRolloutToolInput(name, parsedArgs));

        return [{ type: 'tool-call', callId, name: canonicalToolName, input }];
    }

    if (payloadType === 'function_call_output') {
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!callId) return [];
        const outputRaw = (payload as any).output;
        const output = typeof outputRaw === 'string' ? safeJsonParse(outputRaw) ?? outputRaw : outputRaw;
        const outputRecord = asRecord(output);
        const spawnedThreadId = readStringField(outputRecord ?? {}, 'agent_id');
        if (spawnedThreadId) {
            return [{
                type: 'collaboration-tool-result',
                callId,
                threadId: spawnedThreadId,
                nickname: readStringField(outputRecord ?? {}, 'nickname'),
            }];
        }
        return [{ type: 'tool-result', callId, output }];
    }

    if (payloadType === 'custom_tool_call') {
        const name = typeof (payload as any).name === 'string' ? String((payload as any).name) : '';
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!name || !callId) return [];

        const { canonicalToolName, visibility } = canonicalizeCodexRolloutToolName(name);
        if (visibility === 'ignore') return [];
        if (visibility === 'debug-only' && !opts.debug) return [];

        const input = withLocalControlMeta(normalizeCodexRolloutToolInput(name, (payload as any).input));
        return [{ type: 'tool-call', callId, name: canonicalToolName, input }];
    }

    if (payloadType === 'custom_tool_call_output') {
        const callId = typeof (payload as any).call_id === 'string' ? String((payload as any).call_id) : '';
        if (!callId) return [];
        const outputRaw = (payload as any).output;
        const output = typeof outputRaw === 'string' ? safeJsonParse(outputRaw) ?? outputRaw : outputRaw;
        return [{ type: 'tool-result', callId, output }];
    }

    return opts.debug ? [{ type: 'debug', message: `unhandled rollout payload type: ${payloadType}`, value: payload }] : [];
}
