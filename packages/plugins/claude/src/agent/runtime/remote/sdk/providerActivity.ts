import {
    isTerminalClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeAgentSdkProviderTaskId,
    normalizeClaudeAgentSdkProviderTaskStatus,
    readClaudeAgentSdkProviderTaskStatus,
} from './providerTaskStatus.js';

export type ClaudeProviderTaskActivity =
    | Readonly<{ type: 'background'; taskId: string }>
    | Readonly<{ type: 'started'; taskId: string }>
    | Readonly<{ type: 'progress'; taskId: string }>
    | Readonly<{ type: 'terminal'; taskId: string }>;

export type ClaudeProviderActivitySource =
    | 'assistant-auto-backgrounded-tool-result'
    | 'system-task-progress'
    | 'system-task-started';

/**
 * Backstop TTL (W-3) for a provider task in the "is the session still working?" ledger. A dropped
 * terminal `task_updated` (connection gap / mode switch) would otherwise keep the session pinned
 * "working" until the process restarts. A task with no progress/terminal event within this window
 * stops blocking `hasActiveProviderTasks()`. Hook reconciliation stays the canonical clearer; this
 * is only the safety net for the case where no event ever arrives.
 */
export const CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS = 10 * 60_000;

type ProviderTaskEntry = {
    taskId: string;
    sources: Set<ClaudeProviderActivitySource>;
    /** Wall-clock ms of the most recent event for this task; drives the TTL backstop (W-3). */
    lastEventAt: number;
};

/** Cancel handle for a scheduled expiry re-check. */
type CancelTimer = () => void;

export type ClaudeProviderActivityLedgerOptions = Readonly<{
    /** Injectable clock (default `Date.now`); tests advance it deterministically. */
    now?: () => number;
    /** Per-task inactivity TTL in ms (default {@link CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS}). */
    ttlMs?: number;
    /**
     * Invoked after a TTL sweep drops one or more tasks, so the owner can re-check idle emission
     * (the session may have gone completely silent with no further events to trigger the check).
     */
    onActiveTasksExpired?: () => void;
    /**
     * Injectable proactive-expiry scheduler (default `setTimeout` with `unref`). Tests pass a
     * manual scheduler so the sweep fires deterministically without real timers.
     */
    setExpiryTimer?: (fn: () => void, delayMs: number) => CancelTimer;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readProviderTaskId(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) return null;
    return normalizeClaudeAgentSdkProviderTaskId(
        record.task_id
        ?? record.taskId
        ?? record.agent_id
        ?? record.agentId,
    );
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTextContent(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return null;
    const texts: string[] = [];
    for (const item of value) {
        const text = readString(readRecord(item)?.text);
        if (text) texts.push(text);
    }
    return texts.length > 0 ? texts.join('\n') : null;
}

function readXmlTag(source: string, tag: string): string | null {
    const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'iu'));
    return match?.[1] !== undefined ? readString(match[1]) : null;
}

function isTaskNotificationXml(text: string): boolean {
    return /^\s*<task-notification\b/iu.test(text);
}

function readTaskNotificationXmlText(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) return null;

    if (record.type === 'queue-operation') {
        const text = readString(record.content);
        return text && isTaskNotificationXml(text) ? text : null;
    }

    if (record.type === 'attachment') {
        const attachment = readRecord(record.attachment);
        if (attachment?.type !== 'queued_command') return null;
        const text = readString(attachment.prompt);
        return text && isTaskNotificationXml(text) ? text : null;
    }

    if (record.type === 'user') {
        const nested = readRecord(record.message);
        const text = readTextContent(nested?.content);
        return text && isTaskNotificationXml(text) ? text : null;
    }

    return null;
}

function readTaskNotificationOrigin(value: unknown): Readonly<{ taskId: string | null; status: string | null }> | null {
    const origin = readRecord(readRecord(value)?.origin);
    if (readString(origin?.kind) !== 'task-notification') return null;
    return {
        taskId: normalizeClaudeAgentSdkProviderTaskId(origin?.taskId ?? origin?.task_id),
        status: normalizeClaudeAgentSdkProviderTaskStatus(origin?.status),
    };
}

function readTranscriptTaskNotificationActivity(value: unknown): ClaudeProviderTaskActivity | null {
    const origin = readTaskNotificationOrigin(value);
    const xmlText = readTaskNotificationXmlText(value);
    if (!origin && !xmlText) return null;

    const taskId = origin?.taskId ?? normalizeClaudeAgentSdkProviderTaskId(
        xmlText ? readXmlTag(xmlText, 'task-id') : null,
    );
    if (!taskId) return null;
    const status = origin?.status ?? normalizeClaudeAgentSdkProviderTaskStatus(
        xmlText ? readXmlTag(xmlText, 'status') : null,
    );

    return isTerminalClaudeAgentSdkProviderTaskStatus(status)
        ? { type: 'terminal', taskId }
        : { type: 'progress', taskId };
}

export function buildClaudeProviderTaskRuntimeActivitySourceId(taskId: unknown): string | null {
    const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
    return normalizedTaskId ? `claude:provider-task:${normalizedTaskId}` : null;
}

export function isReplayClaudeAgentSdkMessage(value: unknown): boolean {
    const record = readRecord(value);
    return record?.isReplay === true || record?.is_replay === true;
}

export function readClaudeAgentSdkBackgroundTaskId(message: unknown): string | null {
    const record = readRecord(message);
    if (!record) return null;
    const taskResult = readRecord(record.tool_use_result ?? record.toolUseResult);
    if (!taskResult) return null;
    const status = normalizeClaudeAgentSdkProviderTaskStatus(taskResult.status);
    const launchedAsync = taskResult.assistantAutoBackgrounded === true
        || taskResult.assistant_auto_backgrounded === true
        || taskResult.isAsync === true
        || status === 'async_launched';
    if (
        !launchedAsync
        && (taskResult.assistantAutoBackgrounded === false || taskResult.assistant_auto_backgrounded === false)
    ) {
        return null;
    }
    const explicitBackgroundTaskId = normalizeClaudeAgentSdkProviderTaskId(
        taskResult.backgroundTaskId
        ?? taskResult.background_task_id,
    );
    if (explicitBackgroundTaskId) return explicitBackgroundTaskId;

    if (!launchedAsync) return null;

    return normalizeClaudeAgentSdkProviderTaskId(
        taskResult.taskId
        ?? taskResult.task_id
        ?? taskResult.agentId
        ?? taskResult.agent_id,
    );
}

export function isClaudeAgentSdkStopHookWithNoBackgroundTasks(message: unknown): boolean {
    const record = readRecord(message);
    if (!record) return false;
    const hookEventName = record.hook_event_name ?? record.hookEventName;
    if (hookEventName !== 'Stop') return false;
    const backgroundTasks = record.background_tasks ?? record.backgroundTasks;
    return Array.isArray(backgroundTasks) && backgroundTasks.length === 0;
}

export function readClaudeProviderTaskActivity(message: unknown): ClaudeProviderTaskActivity | null {
    const backgroundTaskId = readClaudeAgentSdkBackgroundTaskId(message);
    if (backgroundTaskId) {
        return { type: 'background', taskId: backgroundTaskId };
    }

    const transcriptTaskNotificationActivity = readTranscriptTaskNotificationActivity(message);
    if (transcriptTaskNotificationActivity) return transcriptTaskNotificationActivity;

    const record = readRecord(message);
    if (!record || record.type !== 'system') return null;
    const taskId = readProviderTaskId(record);
    if (!taskId) return null;
    const status = readClaudeAgentSdkProviderTaskStatus(record);
    const hasTerminalStatus = isTerminalClaudeAgentSdkProviderTaskStatus(status);
    switch (record.subtype) {
        case 'task_started':
            return hasTerminalStatus ? { type: 'terminal', taskId } : { type: 'started', taskId };
        case 'task_progress':
        case 'task_updated':
        case 'task_notification':
            return hasTerminalStatus ? { type: 'terminal', taskId } : { type: 'progress', taskId };
        default:
            return null;
    }
}

const defaultExpiryTimer = (fn: () => void, delayMs: number): CancelTimer => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
};

export function createClaudeProviderActivityLedger(options?: ClaudeProviderActivityLedgerOptions) {
    const activeProviderTasks = new Map<string, ProviderTaskEntry>();
    const now = options?.now ?? Date.now;
    const ttlMs = options?.ttlMs ?? CLAUDE_PROVIDER_TASK_ACTIVITY_TTL_MS;
    const onActiveTasksExpired = options?.onActiveTasksExpired;
    const setExpiryTimer = options?.setExpiryTimer ?? defaultExpiryTimer;
    let cancelExpiryTimer: CancelTimer | null = null;

    /** Drop tasks whose last event is older than the TTL. Returns the dropped task ids. */
    const pruneExpiredProviderTasks = (): string[] => {
        const nowMs = now();
        const expired: string[] = [];
        for (const [taskId, entry] of activeProviderTasks) {
            if (entry.lastEventAt + ttlMs <= nowMs) {
                activeProviderTasks.delete(taskId);
                expired.push(taskId);
            }
        }
        return expired;
    };

    const clearExpiryTimer = (): void => {
        if (cancelExpiryTimer) {
            cancelExpiryTimer();
            cancelExpiryTimer = null;
        }
    };

    /** (Re)arm a single proactive sweep at the earliest task deadline so a silent session still idles. */
    const rescheduleExpiryTimer = (): void => {
        clearExpiryTimer();
        if (activeProviderTasks.size === 0) return;
        const nowMs = now();
        let earliestDeadline = Infinity;
        for (const entry of activeProviderTasks.values()) {
            earliestDeadline = Math.min(earliestDeadline, entry.lastEventAt + ttlMs);
        }
        const delayMs = Math.max(0, earliestDeadline - nowMs);
        cancelExpiryTimer = setExpiryTimer(() => {
            cancelExpiryTimer = null;
            const expired = pruneExpiredProviderTasks();
            rescheduleExpiryTimer();
            if (expired.length > 0) onActiveTasksExpired?.();
        }, delayMs);
    };

    const noteProviderTask = (
        taskId: unknown,
        source: ClaudeProviderActivitySource,
    ): string | null => {
        const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
        if (!normalizedTaskId) return null;
        const nowMs = now();
        const existing = activeProviderTasks.get(normalizedTaskId);
        if (existing) {
            existing.sources.add(source);
            existing.lastEventAt = nowMs;
        } else {
            activeProviderTasks.set(normalizedTaskId, {
                taskId: normalizedTaskId,
                sources: new Set([source]),
                lastEventAt: nowMs,
            });
        }
        rescheduleExpiryTimer();
        return normalizedTaskId;
    };

    return {
        getActiveProviderTaskIds: (): readonly string[] => {
            pruneExpiredProviderTasks();
            return [...activeProviderTasks.keys()];
        },
        getActiveProviderTaskCount: (): number => {
            pruneExpiredProviderTasks();
            return activeProviderTasks.size;
        },
        hasActiveProviderTasks: (): boolean => {
            pruneExpiredProviderTasks();
            return activeProviderTasks.size > 0;
        },
        hasProviderTask: (taskId: unknown): boolean => {
            const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
            if (!normalizedTaskId) return false;
            pruneExpiredProviderTasks();
            return activeProviderTasks.has(normalizedTaskId);
        },
        noteBackgroundProviderTask: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'assistant-auto-backgrounded-tool-result',
        ),
        noteProviderTaskFinished: (taskId: unknown): string | null => {
            const normalizedTaskId = normalizeClaudeAgentSdkProviderTaskId(taskId);
            if (!normalizedTaskId) return null;
            const deleted = activeProviderTasks.delete(normalizedTaskId);
            rescheduleExpiryTimer();
            if (!deleted) return null;
            return normalizedTaskId;
        },
        noteProviderTaskProgress: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'system-task-progress',
        ),
        noteProviderTaskStarted: (taskId: unknown): string | null => noteProviderTask(
            taskId,
            'system-task-started',
        ),
        clearProviderTasks: (): void => {
            activeProviderTasks.clear();
            clearExpiryTimer();
        },
    };
}
