export type ClaudeTerminalLifecycleObservation =
    | Readonly<{ type: 'prompt_submitted'; agentId: string; turnId: string | null; source: 'hook' | 'transcript'; promptText?: string; acceptanceEvidenceId?: string; observedAtMs?: number; providerEvidence?: 'queued_command' }>
    | Readonly<{ type: 'completion_candidate'; agentId: string; turnId: string | null; source: 'hook' | 'transcript' }>
    | Readonly<{ type: 'completion_candidate_invalidated'; agentId: string; turnId: string | null; reason: 'stop_hook_feedback' }>
    | Readonly<{ type: 'compaction_started'; agentId: string; turnId?: string | null; source: 'hook' | 'transcript' }>
    | Readonly<{ type: 'compaction_completed'; agentId: string; turnId?: string | null; source: 'hook' | 'transcript'; agentEventId?: string | null }>
    | Readonly<{ type: 'sidechain_activity'; agentId: string; source: 'hook'; sidechainAgentId: string }>
    | Readonly<{ type: 'sidechain_terminal'; agentId: string; source: 'hook'; sidechainAgentId: string }>
    | Readonly<{ type: 'turn_failed'; agentId: string; turnId: string | null; reason: 'stop_failure_hook'; detail?: string; evidence?: unknown; source: 'hook'; sidechainAgentId?: string | null }>
    | Readonly<{ type: 'turn_failed'; agentId: string; turnId: string | null; reason: 'transcript_api_error'; source: 'transcript' }>
    | Readonly<{ type: 'turn_aborted'; agentId: string; turnId: string | null; reason: 'user_interrupt'; detail: string; source: 'transcript' }>
    | Readonly<{ type: 'process_exited'; agentId: string; exitCode: number | null; signal: string | null; nativeExited?: true }>;

export type ClaudeTerminalHookEvent = Readonly<{
    agentId: string;
    eventName: string;
    turnId?: string | null;
    detail?: string;
    evidence?: unknown;
    promptText?: string;
    acceptanceEvidenceId?: string;
    observedAtMs?: number;
    /**
     * Sidechain (subagent) attribution from the raw Claude Code hook record (`agent_id`).
     * Sidechain hooks must never drive primary-turn lifecycle transitions (R-11); only the
     * StopFailure usage-evidence carve-out flows through, attributed (HF-3).
     */
    sidechainAgentId?: string | null;
}>;

export type ClaudeTerminalTranscriptEvent =
    | Readonly<{ agentId: string; kind: 'local_command_completed'; turnId?: string | null }>
    | Readonly<{
        agentId: string;
        kind: 'user_prompt';
        text: string;
        acceptanceEvidenceId?: string;
        turnId?: string | null;
        observedAtMs?: number;
    }>
    | Readonly<{
        agentId: string;
        kind: 'queued_command';
        text: string;
        acceptanceEvidenceId?: string;
        turnId?: string | null;
        observedAtMs?: number;
    }>
    | Readonly<{
        agentId: string;
        kind: 'assistant_api_error';
        turnId?: string | null;
    }>
    | Readonly<{
        agentId: string;
        kind: 'assistant_stop';
        stopReason?: string | null;
        turnId?: string | null;
    }>
    | Readonly<{
        agentId: string;
        kind: 'stop_hook_feedback';
        turnId?: string | null;
    }>
    | Readonly<{
        agentId: string;
        kind: 'compact_boundary';
        turnId?: string | null;
        agentEventId?: string | null;
    }>
    | Readonly<{
        agentId: string;
        kind: 'text';
        text: string;
        acceptanceEvidenceId?: string;
        turnId?: string | null;
        observedAtMs?: number;
    }>;

function readTurnId(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function isClaudeTaskNotificationPromptText(value: string | null | undefined): boolean {
    return typeof value === 'string' && /^\s*<task-notification\b/iu.test(value);
}

export function mapClaudeHookEventToTerminalLifecycleObservation(
    event: ClaudeTerminalHookEvent,
): ClaudeTerminalLifecycleObservation | null {
    const turnId = readTurnId(event.turnId);

    if (event.eventName === 'UserPromptSubmit') {
        if (isClaudeTaskNotificationPromptText(event.promptText)) return null;
        return {
            type: 'prompt_submitted',
            agentId: event.agentId,
            turnId,
            source: 'hook',
            ...(event.acceptanceEvidenceId ? { acceptanceEvidenceId: event.acceptanceEvidenceId } : {}),
            ...(event.promptText ? { promptText: event.promptText } : {}),
            ...(typeof event.observedAtMs === 'number' ? { observedAtMs: event.observedAtMs } : {}),
        };
    }

    if (event.eventName === 'Stop') {
        return {
            type: 'completion_candidate',
            agentId: event.agentId,
            turnId,
            source: 'hook',
        };
    }

    if (event.eventName === 'StopFailure') {
        return {
            type: 'turn_failed',
            agentId: event.agentId,
            turnId,
            reason: 'stop_failure_hook',
            ...(event.detail ? { detail: event.detail } : {}),
            ...(event.evidence !== undefined ? { evidence: event.evidence } : {}),
            source: 'hook',
            ...(event.sidechainAgentId ? { sidechainAgentId: event.sidechainAgentId } : {}),
        };
    }

    if (event.eventName === 'PreCompact') {
        return {
            type: 'compaction_started',
            agentId: event.agentId,
            ...(turnId ? { turnId } : {}),
            source: 'hook',
        };
    }

    if (event.eventName === 'PostCompact') {
        return {
            type: 'compaction_completed',
            agentId: event.agentId,
            ...(turnId ? { turnId } : {}),
            source: 'hook',
        };
    }

    // SessionEnd is a native hook, not an OS process-terminal observation.
    // The terminal host supplies process exit status through subscribeExit.
    return null;
}

export function mapClaudeTranscriptEventToTerminalLifecycleObservation(
    event: ClaudeTerminalTranscriptEvent,
): ClaudeTerminalLifecycleObservation | null {
    const turnId = readTurnId(event.turnId);

    if (event.kind === 'queued_command') {
        return {
            type: 'prompt_submitted',
            agentId: event.agentId,
            turnId,
            source: 'transcript',
            promptText: event.text,
            ...(event.acceptanceEvidenceId ? { acceptanceEvidenceId: event.acceptanceEvidenceId } : {}),
            providerEvidence: 'queued_command',
            ...(typeof event.observedAtMs === 'number' ? { observedAtMs: event.observedAtMs } : {}),
        };
    }

    if (event.kind === 'assistant_stop' || event.kind === 'local_command_completed') {
        return event.kind === 'local_command_completed' || event.stopReason === 'end_turn'
            ? {
                type: 'completion_candidate',
                agentId: event.agentId,
                turnId,
                source: 'transcript',
            }
            : null;
    }

    if (event.kind === 'assistant_api_error') {
        return {
            type: 'turn_failed',
            agentId: event.agentId,
            turnId,
            reason: 'transcript_api_error',
            source: 'transcript',
        };
    }

    if (event.kind === 'stop_hook_feedback') {
        return {
            type: 'completion_candidate_invalidated',
            agentId: event.agentId,
            turnId,
            reason: 'stop_hook_feedback',
        };
    }

    if (event.kind === 'compact_boundary') {
        return {
            type: 'compaction_completed',
            agentId: event.agentId,
            ...(turnId ? { turnId } : {}),
            source: 'transcript',
            ...(event.agentEventId ? { agentEventId: event.agentEventId } : {}),
        };
    }

    if (event.text === '[Request interrupted by user]'
        || event.text === '[Request interrupted by user for tool use]') {
        return {
            type: 'turn_aborted',
            agentId: event.agentId,
            turnId,
            reason: 'user_interrupt',
            detail: event.text,
            source: 'transcript',
        };
    }

    return {
        type: 'prompt_submitted',
        agentId: event.agentId,
        turnId,
        source: 'transcript',
        promptText: event.text,
        ...(event.acceptanceEvidenceId ? { acceptanceEvidenceId: event.acceptanceEvidenceId } : {}),
        ...(typeof event.observedAtMs === 'number' ? { observedAtMs: event.observedAtMs } : {}),
    };
}
