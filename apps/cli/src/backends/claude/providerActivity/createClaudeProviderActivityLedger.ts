import { normalizeClaudeAgentSdkProviderTaskId } from '@happier-dev/protocol';
import { readClaudeTaskLifecycleEnvelope } from '../taskNotifications/claudeTaskLifecycleEnvelope';

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
        confirmsActivity?: false;
        /** The task (an Agent) that owns this one, from the typed SDK row. */
        parentTaskId?: string;
    }>)
    | (ClaudeProviderTaskIdentity & Readonly<{
        type: 'progress';
        confirmsActivity?: false;
        source?: 'system-task-progress';
    }>)
    | (ClaudeProviderTaskIdentity & Readonly<{
        type: 'terminal';
        terminalStatus?: 'completed' | 'failed' | 'stopped';
        rememberIfUnknown?: boolean;
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
 * Reads typed Claude SDK lifecycle events and canonical native task envelopes.
 * Ordinary transcript prose and unmarked notification text carry no lifecycle authority.
 */
export function normalizeClaudeProviderTaskEvent(value: unknown, contextualSessionId?: string): ClaudeProviderTaskEventFacts {
    const row = record(value);
    if (!row) return NO_TASK_FACTS;

    const envelope = readClaudeTaskLifecycleEnvelope(row);
    const envelopeSessionId = envelope?.sourceSessionId ?? normalizedString(contextualSessionId);
    // Typed SDK notifications also carry task classification and durable background-task fields.
    // Keep that richer projection below while sharing their transcript outcome reader.
    if (envelope?.taskId && envelopeSessionId && !(row.type === 'system' && (row.subtype === 'task_notification' || row.subtype === 'task_started'))) {
        const { taskId, status } = envelope;
        const sessionId = envelopeSessionId;
        const terminalStatus = status === 'complete' ? 'completed' : status === 'failed' ? 'failed'
            : status === 'cancelled' ? 'stopped' : null;
        return {
            activity: envelope.subtype === 'async-launch' ? { type: 'started', source: 'hook-agent-launch', sessionId, taskId }
                : envelope.resumed ? { type: 'started', ...(envelope.knownOnly ? { admission: 'known-only' as const } : {}), source: 'hook-agent-resume', sessionId, taskId }
                : terminalStatus ? { type: 'terminal', terminalStatus, sessionId, taskId }
                : status === 'active' ? { type: 'progress', sessionId, taskId,
                    ...(envelope.subtype === 'handback' || envelope.knownOnly ? { confirmsActivity: false as const } : {}) } : null,
            interruptTarget: envelope.subtype === 'async-launch' ? { type: 'active', taskId } : terminalStatus ? { type: 'terminal', taskId } : null,
            backgroundTask: null,
        };
    }
    if (envelope?.subtype === 'async-launch' && envelope.taskId) {
        return { activity: null, interruptTarget: { type: 'active', taskId: envelope.taskId }, backgroundTask: null };
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
            row.is_backgrounded === true,
        );
        const parentTaskId = normalizeClaudeAgentSdkProviderTaskId(row.parent_task_id);
        return {
            activity: {
                type: 'started',
                sessionId,
                taskId,
                ...(admission === 'known-only'
                    ? { admission: 'known-only' as const }
                    : {}),
                ...(parentTaskId ? { parentTaskId } : {}),
            },
            interruptTarget,
            backgroundTask,
        };
    }
    if (row.subtype === 'task_progress') {
        return {
            activity: { type: 'progress', sessionId, taskId, source: 'system-task-progress' },
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
    contextualSessionId?: string,
): ClaudeProviderTaskActivity | null {
    return normalizeClaudeProviderTaskEvent(value, contextualSessionId).activity;
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
            ? { type: 'started', admission: 'known-only', source: 'hook-agent-resume', sessionId, taskId: sidechainAgentId }
            : null;
    }
    if (hookEventName === 'SubagentStop') {
        return sidechainAgentId
            ? { type: 'progress', sessionId, taskId: sidechainAgentId }
            : null;
    }
    if (hookEventName !== 'PostToolUse') return null;
    const nativeActivity = normalizeClaudeProviderTaskEvent(row).activity;
    if (nativeActivity?.type === 'terminal') return nativeActivity;
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
    if (nativeActivity) return nativeActivity;

    if (toolName !== 'TaskOutput' && toolName !== 'TaskStop') return null;
    const requestedTaskId = readTaskId(toolInput);
    if (!requestedTaskId) return null;
    const nestedTask = record(toolResponse.task);
    const confirmedTask = nestedTask ?? toolResponse;
    const confirmedTaskId = readTaskId(confirmedTask);
    const terminalStatus = confirmedTask.status === 'killed' ? 'stopped' : exactTerminalStatus(confirmedTask.status);
    if (confirmedTaskId !== requestedTaskId || !terminalStatus) return null;
    if (
        toolName === 'TaskOutput'
        && toolResponse.retrieval_status !== 'success'
        && toolResponse.retrievalStatus !== 'success'
    ) return null;
    // Tool retrieval/stop confirms a known task's outcome, without admitting an unknown identity.
    return {
        type: 'terminal',
        terminalStatus: toolName === 'TaskStop' ? 'stopped' : terminalStatus,
        sessionId,
        taskId: requestedTaskId,
        rememberIfUnknown: false,
    };
}

function withParent(parentTaskId: string | undefined): { parentTaskId?: string } {
    return parentTaskId ? { parentTaskId } : {};
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
            observed: boolean;
            parentTaskId?: string;
        }>
        | Readonly<{
            phase: 'terminal-before-confirmation';
            identity: ClaudeProviderTaskIdentity;
            backgroundConfirmed: boolean;
            /**
             * Claude reports an Agent `completed` each time it stops, including when it stops to
             * wait on background children it still owns; it wakes when they settle. Only the
             * Agent's own typed progress may then reactivate it, so an Agent that never wakes
             * cannot hold the count open.
             */
            awaitingChildren?: true;
            parentTaskId?: string;
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

    /** A child still owns live work while active or while it waits on its own children. */
    const hasActiveChild = (identity: ClaudeProviderTaskIdentity): boolean => {
        for (const entry of tasks.values()) {
            if (
                entry.parentTaskId === identity.taskId
                && entry.identity.sessionId === identity.sessionId
                && (entry.phase === 'active' || entry.awaitingChildren === true)
            ) return true;
        }
        return false;
    };

    const noteActive = (
        identity: ClaudeProviderTaskIdentity,
        source: ClaudeProviderTaskActivitySource,
        confirmsActivity = true,
        parentTaskId?: string,
    ): boolean => {
        const key = keyOf(identity);
        const current = tasks.get(key);
        if (current?.phase === 'terminal-before-confirmation') {
            if (source !== 'hook-agent-resume') {
                // A late genuine launch confirms background identity while its outcome stays terminal.
                if (!current.backgroundConfirmed) tasks.set(key, { ...current, backgroundConfirmed: true });
                return false;
            }
            tasks.set(key, {
                phase: 'active',
                identity,
                sources: new Set([source]),
                observed: confirmsActivity,
                ...withParent(current.parentTaskId),
            });
            return true;
        }
        if (current?.phase === 'active') {
            current.sources.add(source);
            // Hook and typed launches race; only the typed row carries the owning Agent.
            const parent = withParent(current.parentTaskId ?? parentTaskId);
            if (current.observed || !confirmsActivity) {
                if (parent.parentTaskId !== current.parentTaskId) tasks.set(key, { ...current, ...parent });
                return false;
            }
            tasks.set(key, { ...current, ...parent, observed: true });
            return true;
        }
        tasks.set(key, {
            phase: 'active',
            identity,
            sources: new Set([source]),
            observed: confirmsActivity,
            ...withParent(parentTaskId),
        });
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
                    const identity = { sessionId: activity.sessionId, taskId: activity.taskId };
                    // Only a completed stop can be interim; a failed or stopped Agent never wakes.
                    const awaitsChildren = activity.terminalStatus === 'completed' && hasActiveChild(identity);
                    tasks.set(key, {
                        phase: 'terminal-before-confirmation',
                        identity,
                        backgroundConfirmed: true,
                        ...(awaitsChildren ? { awaitingChildren: true as const } : {}),
                        ...withParent(current.parentTaskId),
                    });
                    return true;
                }
                if (current?.awaitingChildren === true && activity.terminalStatus !== 'completed') {
                    // A later stop/failure is final even when the Agent was already waiting.
                    // Duplicate completed rows still describe the same interim stop.
                    const { awaitingChildren: _settled, ...terminal } = current;
                    tasks.set(key, terminal);
                    return true;
                }
                if (!current && (activity.rememberIfUnknown ?? (activity.terminalStatus !== undefined))) {
                    tasks.set(key, {
                        phase: 'terminal-before-confirmation',
                        identity: { sessionId: activity.sessionId, taskId: activity.taskId },
                        backgroundConfirmed: false,
                    });
                }
                return false;
            }
            if (activity.type === 'progress' || activity.admission === 'known-only') {
                if (activity.type === 'progress' && activity.confirmsActivity === false) return false;
                if (
                    activity.type === 'progress'
                    && activity.source === 'system-task-progress'
                    && current?.phase === 'terminal-before-confirmation'
                    && current.awaitingChildren === true
                ) {
                    tasks.set(key, {
                        phase: 'active',
                        identity: current.identity,
                        sources: new Set(['system-task-progress']),
                        observed: true,
                        ...withParent(current.parentTaskId),
                    });
                    return true;
                }
                if (activity.type === 'started' && current && activity.source === 'hook-agent-resume') {
                    if (current.phase === 'terminal-before-confirmation' && !current.backgroundConfirmed) return false;
                    return noteActive({ sessionId: activity.sessionId, taskId: activity.taskId }, activity.source, activity.confirmsActivity !== false);
                }
                if (current?.phase !== 'active') return false;
                return noteActive(current.identity, 'system-task-progress');
            }
            return noteActive(
                { sessionId: activity.sessionId, taskId: activity.taskId },
                activity.source ?? 'system-task-started',
                activity.confirmsActivity !== false,
                activity.parentTaskId,
            );
        },
        /**
         * Forget every task still active when its provider observer was lost, returning them for
         * diagnostics. Nothing can settle those tasks any more: Claude Code orphans a stopped
         * process's background agents, so their terminal events never arrive.
         */
        abandonActiveProviderTasks(): ClaudeProviderTaskBlocker[] {
            const abandoned: ClaudeProviderTaskBlocker[] = [];
            for (const [key, entry] of tasks) {
                if (entry.phase !== 'active') continue;
                abandoned.push({ ...entry.identity, sources: [...entry.sources] });
                tasks.delete(key);
            }
            return abandoned;
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
        getObservedActiveProviderTaskCount: (): number => {
            let count = 0;
            for (const entry of tasks.values()) {
                if (entry.phase === 'active' && entry.observed) count += 1;
            }
            return count;
        },
        noteObservationLost(): void {
            // Retain unresolved identities for exact task operations; their old membership cannot
            // establish present liveness after the provider observer is lost.
            for (const [key, entry] of tasks) {
                if (entry.phase === 'active') tasks.set(key, { ...entry, observed: false });
            }
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
