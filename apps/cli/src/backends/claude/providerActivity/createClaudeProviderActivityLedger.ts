import { normalizeClaudeAgentSdkProviderTaskId } from '@happier-dev/protocol';

import {
    readClaudeBackgroundTaskFact,
    type ClaudeBackgroundTaskFact,
} from './claudeBackgroundTaskEvent';
import { resolveClaudeProviderTaskAdmission } from './claudeProviderTaskClassification';

export {
    isTerminalClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeAgentSdkProviderTaskId,
    normalizeClaudeAgentSdkProviderTaskStatus,
    readClaudeAgentSdkProviderTaskStatus,
} from '@happier-dev/protocol';

export const CLAUDE_RUNTIME_ACTIVITY_PROVIDER_ID = 'claude';

export type ClaudeProviderTaskIdentity = Readonly<{ sessionId: string; taskId: string }>;
export type ClaudeProviderTaskActivity =
    | (ClaudeProviderTaskIdentity & Readonly<{
        type: 'started';
        admission?: 'known-only';
        source?: ClaudeProviderTaskActivitySource;
    }>)
    | (ClaudeProviderTaskIdentity & Readonly<{ type: 'progress' }>)
    | (ClaudeProviderTaskIdentity & Readonly<{
        type: 'terminal';
        terminalStatus?: 'completed' | 'failed' | 'stopped';
        rememberIfUnknown?: true;
    }>);
export type ClaudeProviderTaskActivitySource =
    | 'hook-agent-launch'
    | 'hook-agent-resume'
    | 'system-task-started'
    | 'system-task-progress';
export type ClaudeProviderTaskBlocker = ClaudeProviderTaskIdentity & Readonly<{
    sources: readonly ClaudeProviderTaskActivitySource[];
}>;
export type ClaudeProviderTaskInterruptTargetEvidence = Readonly<{
    type: 'active' | 'terminal';
    taskId: string;
}>;
export type ClaudeProviderTaskEventFacts = Readonly<{
    activity: ClaudeProviderTaskActivity | null;
    interruptTarget: ClaudeProviderTaskInterruptTargetEvidence | null;
    /**
     * The durable-record projection of the SAME row (PLAN 4.9). Independent of `activity`: a
     * `known-only` start still describes a real task, and a terminal row still describes a real
     * outcome, even when neither moves liveness.
     */
    backgroundTask: ClaudeBackgroundTaskFact | null;
}>;

const NO_TASK_FACTS: ClaudeProviderTaskEventFacts = {
    activity: null,
    interruptTarget: null,
    backgroundTask: null,
};

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function normalizedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function exactTerminalStatus(value: unknown): 'completed' | 'failed' | 'stopped' | null {
    return value === 'completed' || value === 'failed' || value === 'stopped' ? value : null;
}

function isTerminalTaskStatus(value: unknown): boolean {
    return value === 'completed' || value === 'failed' || value === 'stopped' || value === 'killed';
}

function isFailedToolResponse(value: Readonly<Record<string, unknown>>): boolean {
    if (value.success === false || value.is_error === true || value.isError === true) return true;
    if (value.error !== null && value.error !== undefined) return true;
    const status = normalizedString(value.status)?.toLowerCase();
    return status === 'failed' || status === 'error' || status === 'denied' || status === 'rejected';
}

function readTaskId(value: unknown): string | null {
    const row = record(value);
    return normalizeClaudeAgentSdkProviderTaskId(
        row?.task_id
        ?? row?.taskId
        ?? row?.agent_id
        ?? row?.agentId,
    );
}

/**
 * Reads only the typed Claude SDK task lifecycle contract. Transcript prose,
 * tool results, hook snapshots and status aliases are deliberately inert.
 */
export function normalizeClaudeProviderTaskEvent(value: unknown): ClaudeProviderTaskEventFacts {
    const row = record(value);
    if (!row) return NO_TASK_FACTS;

    if (row.type === 'user') {
        const toolResult = record(row.toolUseResult ?? row.tool_use_result);
        const status = normalizedString(toolResult?.status);
        if (status !== 'async_launched' && status !== 'remote_launched') {
            return NO_TASK_FACTS;
        }
        const taskId = normalizeClaudeAgentSdkProviderTaskId(
            toolResult?.taskId
            ?? toolResult?.task_id
            ?? toolResult?.agentId
            ?? toolResult?.agent_id,
        );
        return {
            activity: null,
            interruptTarget: taskId ? { type: 'active', taskId } : null,
            backgroundTask: null,
        };
    }

    if (row.type !== 'system') return NO_TASK_FACTS;
    const sessionId = normalizedString(row.session_id);
    const taskId = normalizeClaudeAgentSdkProviderTaskId(row.task_id);
    if (!taskId) return NO_TASK_FACTS;
    const interruptTarget = row.subtype === 'task_started' || row.subtype === 'task_progress'
        ? { type: 'active' as const, taskId }
        : row.subtype === 'task_notification' || row.subtype === 'task_updated'
            ? { type: 'terminal' as const, taskId }
            : null;
    if (!sessionId) return { activity: null, interruptTarget, backgroundTask: null };
    // ONE parse, two projections: liveness below, durable record here. Both read the row the
    // identity checks above have already validated (PLAN 4.9.1 steps 1-2).
    const backgroundTask = readClaudeBackgroundTaskFact(row, { sessionId, taskId });

    if (row.subtype === 'task_started') {
        const admission = resolveClaudeProviderTaskAdmission(
            normalizedString(row.task_type ?? row.taskType),
        );
        return {
            activity: {
                type: 'started',
                sessionId,
                taskId,
                ...(admission === 'known-only'
                    ? { admission: 'known-only' as const }
                    : {}),
            },
            interruptTarget,
            backgroundTask,
        };
    }
    if (row.subtype === 'task_progress') {
        return {
            activity: { type: 'progress', sessionId, taskId },
            interruptTarget,
            backgroundTask,
        };
    }
    const notificationStatus = exactTerminalStatus(row.status);
    if (row.subtype === 'task_notification' && notificationStatus) {
        return {
            activity: { type: 'terminal', terminalStatus: notificationStatus, sessionId, taskId },
            interruptTarget,
            backgroundTask,
        };
    }
    const taskUpdatedStatus = record(row.patch)?.status;
    if (
        row.subtype === 'task_updated'
        && (
            taskUpdatedStatus === 'completed'
            || taskUpdatedStatus === 'failed'
            || taskUpdatedStatus === 'killed'
        )
    ) {
        return {
            activity: {
                type: 'terminal',
                terminalStatus: taskUpdatedStatus === 'killed' ? 'stopped' : taskUpdatedStatus,
                sessionId,
                taskId,
            },
            interruptTarget,
            backgroundTask,
        };
    }
    return NO_TASK_FACTS;
}

export function readClaudeProviderTaskActivity(
    value: unknown,
): ClaudeProviderTaskActivity | null {
    return normalizeClaudeProviderTaskEvent(value).activity;
}

/**
 * Normalizes one authenticated current-runtime Claude hook into a ledger fact.
 * The hook transport owns authentication; this adapter owns only exact evidence
 * admission and never retains membership of its own.
 */
export function readClaudeSessionHookProviderTaskActivity(
    value: unknown,
): ClaudeProviderTaskActivity | null {
    const row = record(value);
    if (!row) return null;
    const sessionId = normalizedString(row.session_id ?? row.sessionId);
    if (!sessionId) return null;
    const hookEventName = normalizedString(row.hook_event_name ?? row.hookEventName);
    const sidechainAgentId = normalizeClaudeAgentSdkProviderTaskId(row.agent_id ?? row.agentId);

    if (hookEventName === 'StopFailure') {
        return sidechainAgentId
            ? {
                type: 'terminal',
                terminalStatus: 'failed',
                sessionId,
                taskId: sidechainAgentId,
                rememberIfUnknown: true,
            }
            : null;
    }
    if (hookEventName === 'SubagentStart') {
        return sidechainAgentId
            ? { type: 'progress', sessionId, taskId: sidechainAgentId }
            : null;
    }
    if (hookEventName === 'SubagentStop') {
        return sidechainAgentId
            ? { type: 'terminal', sessionId, taskId: sidechainAgentId, rememberIfUnknown: true }
            : null;
    }
    if (hookEventName !== 'PostToolUse') return null;
    if (sidechainAgentId) {
        return { type: 'progress', sessionId, taskId: sidechainAgentId };
    }

    const toolName = normalizedString(row.tool_name ?? row.toolName);
    const toolInput = record(row.tool_input ?? row.toolInput);
    const toolResponse = record(
        row.tool_response
        ?? row.toolResponse
        ?? row.tool_use_result
        ?? row.toolUseResult,
    );
    if (!toolName || !toolResponse) return null;

    if (toolName === 'Agent') {
        if (toolResponse.status === 'async_launched') {
            const taskId = normalizeClaudeAgentSdkProviderTaskId(
                toolResponse.agentId ?? toolResponse.agent_id,
            );
            return taskId
                ? { type: 'started', sessionId, taskId }
                : null;
        }
        if (toolResponse.status === 'remote_launched') {
            const taskId = normalizeClaudeAgentSdkProviderTaskId(
                toolResponse.taskId ?? toolResponse.task_id,
            );
            return taskId
                ? { type: 'started', sessionId, taskId }
                : null;
        }
        return null;
    }

    if (toolName === 'Workflow') {
        const taskId = normalizeClaudeAgentSdkProviderTaskId(toolResponse.taskId);
        return (toolResponse.status === 'async_launched' || toolResponse.status === 'remote_launched') && taskId
            ? { type: 'started', sessionId, taskId }
            : null;
    }

    if (toolName === 'SendMessage') {
        if (isFailedToolResponse(toolResponse)) return null;
        const taskId = normalizeClaudeAgentSdkProviderTaskId(
            toolResponse.resumedAgentId ?? toolResponse.resumed_agent_id,
        );
        return taskId
            ? { type: 'started', sessionId, taskId, source: 'hook-agent-resume' }
            : null;
    }

    if (toolName !== 'TaskOutput' && toolName !== 'TaskStop') return null;
    const requestedTaskId = readTaskId(toolInput);
    if (!requestedTaskId) return null;
    const nestedTask = record(toolResponse.task);
    const confirmedTask = nestedTask ?? toolResponse;
    const confirmedTaskId = readTaskId(confirmedTask);
    if (confirmedTaskId !== requestedTaskId || !isTerminalTaskStatus(confirmedTask.status)) return null;
    if (
        toolName === 'TaskOutput'
        && toolResponse.retrieval_status !== 'success'
        && toolResponse.retrievalStatus !== 'success'
    ) return null;
    return { type: 'terminal', sessionId, taskId: requestedTaskId };
}

function keyOf(identity: ClaudeProviderTaskIdentity): string {
    return JSON.stringify([identity.sessionId, identity.taskId]);
}

export function createClaudeProviderActivityLedger() {
    type ProviderTaskRecord =
        | Readonly<{
            phase: 'active';
            identity: ClaudeProviderTaskIdentity;
            sources: Set<ClaudeProviderTaskActivitySource>;
        }>
        | Readonly<{
            phase: 'terminal-before-confirmation';
            identity: ClaudeProviderTaskIdentity;
        }>;
    const tasks = new Map<string, ProviderTaskRecord>();
    /**
     * Every Claude session id this ledger has been told it owns (PLAN 4.9.1 step 2).
     *
     * A LINEAGE, not a single current id: the ledger is created once per Happier session
     * (`session.ts` `getProviderTaskActivityLedger`) and outlives every provider session id it
     * passes through — resume, `init`, and each compact boundary mint a new one. Pinning a single
     * "current" id would make a live task foreign to its own ledger the moment the session
     * compacted.
     *
     * Empty means ownership was never declared, and an undeclared owner cannot call anything
     * foreign — so admission is unchanged for callers that never note an id.
     */
    const ownedSessionIds = new Set<string>();

    const isForeignSession = (sessionId: string): boolean => (
        ownedSessionIds.size > 0 && !ownedSessionIds.has(sessionId)
    );

    const noteActive = (
        identity: ClaudeProviderTaskIdentity,
        source: ClaudeProviderTaskActivitySource,
    ): boolean => {
        const key = keyOf(identity);
        const current = tasks.get(key);
        if (current?.phase === 'terminal-before-confirmation') {
            if (source !== 'hook-agent-resume') return false;
            tasks.set(key, { phase: 'active', identity, sources: new Set([source]) });
            return true;
        }
        if (current?.phase === 'active') {
            current.sources.add(source);
            return false;
        }
        tasks.set(key, { phase: 'active', identity, sources: new Set([source]) });
        return true;
    };

    return {
        /**
         * Declare one Claude session id this ledger speaks for. Called wherever the runtime learns
         * or re-learns its provider session identity, so ownership follows the session rather than
         * being guessed from traffic.
         */
        noteOwnedSessionId(sessionId: string): void {
            const normalized = normalizedString(sessionId);
            if (normalized) ownedSessionIds.add(normalized);
        },
        /**
         * The SAME predicate the admission gate applies, exposed so the durable background-task
         * path answers "is this our session?" from this one owner instead of re-deriving it from a
         * single current session id (which a compaction would invalidate).
         */
        isOwnedSessionId: (sessionId: string): boolean => !isForeignSession(sessionId),
        apply(activity: ClaudeProviderTaskActivity): boolean {
            // Identity gate: another session's typed lifecycle row must not raise THIS session's
            // active count, because that count holds this session's turn open.
            if (isForeignSession(activity.sessionId)) return false;
            const key = keyOf(activity);
            const current = tasks.get(key);
            if (activity.type === 'terminal') {
                if (current?.phase === 'active') {
                    tasks.set(key, {
                        phase: 'terminal-before-confirmation',
                        identity: { sessionId: activity.sessionId, taskId: activity.taskId },
                    });
                    return true;
                }
                if (!current && (activity.rememberIfUnknown === true || activity.terminalStatus !== undefined)) {
                    tasks.set(key, {
                        phase: 'terminal-before-confirmation',
                        identity: { sessionId: activity.sessionId, taskId: activity.taskId },
                    });
                }
                return false;
            }
            if (activity.type === 'progress') {
                if (current?.phase === 'active') current.sources.add('system-task-progress');
                return false;
            }
            if (activity.admission === 'known-only') {
                if (current?.phase === 'active') current.sources.add('system-task-progress');
                return false;
            }
            return noteActive(
                { sessionId: activity.sessionId, taskId: activity.taskId },
                activity.source ?? 'system-task-started',
            );
        },
        getActiveProviderTaskBlockers(): ClaudeProviderTaskBlocker[] {
            return [...tasks.values()]
                .filter((entry): entry is Extract<ProviderTaskRecord, { phase: 'active' }> => entry.phase === 'active')
                .map(({ identity, sources }) => ({ ...identity, sources: [...sources] }));
        },
        getActiveProviderTaskCount: (): number => {
            let count = 0;
            for (const entry of tasks.values()) {
                if (entry.phase === 'active') count += 1;
            }
            return count;
        },
        hasActiveProviderTasks: (): boolean => {
            for (const entry of tasks.values()) {
                if (entry.phase === 'active') return true;
            }
            return false;
        },
        hasActiveProviderTask: (identity: ClaudeProviderTaskIdentity): boolean => (
            tasks.get(keyOf(identity))?.phase === 'active'
        ),
    };
}
