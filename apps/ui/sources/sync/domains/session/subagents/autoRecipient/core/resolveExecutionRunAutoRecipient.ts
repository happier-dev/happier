import { readExecutionRunIdFromToolPayload } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    deriveTranscriptExecutionRunStatus,
    isTerminalSubagentStatus,
} from '../../executionRuns/executionRunSubagentStatus';
import { findMatchingSessionSubagentForTool } from '../../findMatchingSessionSubagentForTool';
import type { SessionSubagentAutoRecipientResolver } from '../types';

/**
 * Liveness phrases an agent writes about work it launched. They are the last resort, and they are
 * unreachable once any structured evidence says the run finished: this resolver decides where the
 * user's *next message* is addressed, so a subagent narrating "status: running" must never be able
 * to re-open routing to a run that is already terminal.
 */
const RUNNING_PROSE_PHRASES = [
    '<status>running</status>',
    'command running in background',
    'background task is already running',
] as const;

const RUNNING_PROSE_PATTERN = /\bstatus\b[^a-z0-9]+running\b/;

function messageTextContainsRunningProse(message: Message): boolean {
    const raw = (message as { text?: unknown }).text;
    const text = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!text) return false;
    return RUNNING_PROSE_PHRASES.some((phrase) => text.includes(phrase)) || RUNNING_PROSE_PATTERN.test(text);
}

function focusedMessagesContainRunningExecutionSignal(messages: readonly Message[] | undefined): boolean {
    if (!Array.isArray(messages) || messages.length === 0) return false;

    for (const message of messages) {
        if (!message) continue;
        if (message.kind === 'tool-call') {
            if (deriveTranscriptExecutionRunStatus(message.tool) === 'running') return true;
            continue;
        }
        if (message.kind !== 'agent-text') continue;
        if (messageTextContainsRunningProse(message)) return true;
    }

    return false;
}

export const resolveExecutionRunAutoRecipient: SessionSubagentAutoRecipientResolver = (context) => {
    if (context.tool.name !== 'SubAgentRun') return null;

    const runId = readExecutionRunIdFromToolPayload(context.tool);
    if (!runId) return null;

    const matchingSubagent = findMatchingSessionSubagentForTool(context);
    const focusedRunSubagent = matchingSubagent?.kind === 'execution_run' && matchingSubagent.runRef?.runId === runId
        ? matchingSubagent
        : null;

    if (focusedRunSubagent?.status === 'cancelled') {
        return null;
    }

    if (context.canControlExecutionRuns === false) {
        return null;
    }

    // Status comes from the structured payload the execution-run manager writes, read through the
    // one owner of that vocabulary — never from a regex over the result or a walk into nested
    // values, both of which let a subagent's own words decide the parent's routing.
    const focusedRunStatus = deriveTranscriptExecutionRunStatus(context.tool);
    if (focusedRunStatus === 'running') {
        return { kind: 'execution_run', runId };
    }

    // Terminal authority, strongest first: the derived roster status (which already merges the live
    // run registry with the transcript) then the focused tool's own outcome.
    const hasTerminalEvidence = focusedRunSubagent
        ? isTerminalSubagentStatus(focusedRunSubagent.status)
        : isTerminalSubagentStatus(focusedRunStatus);

    if (!hasTerminalEvidence && focusedMessagesContainRunningExecutionSignal(context.focusedMessages)) {
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
