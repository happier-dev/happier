import { readExecutionRunIdFromToolPayload } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import type { Message } from '@/sync/domains/messages/messageTypes';

import { findMatchingSessionSubagentForTool } from '../../findMatchingSessionSubagentForTool';
import type { SessionSubagentAutoRecipientResolver } from '../types';

function normalizeEmbeddedJsonString(value: string): string {
    return value.replaceAll('\\"', '"');
}

function safeParseObjectFromString(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // Ignore malformed embedded JSON.
    }
    return null;
}

function readResultStatus(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === 'string') {
        const normalized = normalizeEmbeddedJsonString(value);
        const parsed = safeParseObjectFromString(normalized);
        if (parsed) return readResultStatus(parsed);
        const directMatch = normalized.match(/\bstatus\s*:\s*"?([a-z_]+)"?/i);
        return directMatch ? String(directMatch[1]).trim().toLowerCase() : null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const itemStatus = readResultStatus(item);
            if (itemStatus) return itemStatus;
        }
        return null;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const status = typeof record.status === 'string' ? String(record.status).trim().toLowerCase() : '';
        if (status) return status;
        for (const item of Object.values(record)) {
            const itemStatus = readResultStatus(item);
            if (itemStatus) return itemStatus;
        }
    }
    return null;
}

function deriveFocusedExecutionRunSignal(tool: { state: string; result?: unknown }): 'running' | 'unknown' | 'terminal' {
    const resultStatus = readResultStatus(tool.result);
    if (tool.state === 'running' || resultStatus === 'running') return 'running';
    if (tool.state === 'completed') return 'terminal';
    if (tool.state === 'error' && resultStatus && resultStatus !== 'running') return 'terminal';
    return 'unknown';
}

function focusedMessagesContainRunningExecutionSignal(messages: readonly Message[] | undefined): boolean {
    if (!Array.isArray(messages) || messages.length === 0) return false;

    for (const message of messages) {
        if (!message) continue;
        if (message.kind === 'tool-call') {
            if (deriveFocusedExecutionRunSignal(message.tool) === 'running') return true;
            continue;
        }
        if (message.kind !== 'agent-text') continue;
        const text = typeof (message as { text?: unknown }).text === 'string' ? String((message as { text: string }).text).toLowerCase() : '';
        if (!text) continue;
        if (text.includes('<status>running</status>')) return true;
        if (text.includes('command running in background')) return true;
        if (text.includes('background task is already running')) return true;
        if (/\bstatus\b[^a-z0-9]+running\b/.test(text)) return true;
    }

    return false;
}

export const resolveExecutionRunAutoRecipient: SessionSubagentAutoRecipientResolver = (context) => {
    if (context.tool.name !== 'SubAgentRun') return null;

    const runId = readExecutionRunIdFromToolPayload(context.tool);
    if (!runId) return null;

    const matchingSubagent = findMatchingSessionSubagentForTool(context);
    if (
        matchingSubagent?.kind === 'execution_run'
        && matchingSubagent.runRef?.runId === runId
        && matchingSubagent.status === 'cancelled'
    ) {
        return null;
    }

    if (context.canControlExecutionRuns === false) {
        return null;
    }

    if (deriveFocusedExecutionRunSignal(context.tool) === 'running') {
        return { kind: 'execution_run', runId };
    }
    if (focusedMessagesContainRunningExecutionSignal(context.focusedMessages)) {
        return { kind: 'execution_run', runId };
    }

    if (
        matchingSubagent?.recipient?.kind === 'execution_run'
        && matchingSubagent.status === 'running'
        && matchingSubagent.capabilities.canSend
    ) {
        return matchingSubagent.recipient;
    }

    return null;
};
