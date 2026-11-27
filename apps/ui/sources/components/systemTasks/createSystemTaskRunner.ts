import { CLI_ACQUISITION_PROGRESS_EVENT, parseCliAcquisitionProgress } from '@happier-dev/protocol/system/tasks/acquisitionProgress';
import { SystemTaskEventSchema, SystemTaskResultSchema, SystemTaskSpecSchema, type SystemTaskEvent, type SystemTaskResult, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';

import { getSystemTaskPromptSignature, readLatestSystemTaskPrompt } from './prompts/readLatestSystemTaskPrompt';
import { matchesThisComputerSetupScope, readThisComputerSetupScope } from './thisComputerSetup/thisComputerSetupScope';
import type {
    ActiveSetupTask,
    SystemTaskPromptContinuation,
    SystemTaskPromptContinuationRegistration,
    SystemTaskRunState,
    SystemTaskRunner,
    SystemTaskRunStatus,
    SystemTasksBridge,
    SystemTaskBridgeListenerSet,
    SystemTaskAccountScope,
    SystemTaskStartOptions,
} from './types';

type MutableSystemTaskRunState = {
    taskId: string;
    status: SystemTaskRunState['status'];
    currentStepId: string | null;
    latestMessage: string | null;
    awaitingInput: boolean;
    cancelRequested: boolean;
    events: SystemTaskEvent[];
    result: SystemTaskResult | null;
};

type TaskRecord = {
    spec: SystemTaskSpec;
    accountScope: SystemTaskAccountScope | null;
    state: SystemTaskRunState;
    eventSignatures: Set<string>;
    listeners: Set<() => void>;
    unlistenBridge: (() => void) | null;
    promptContinuation: SystemTaskPromptContinuation | null;
    answeredPromptSignatures: Set<string>;
    inFlightPromptSignatures: Set<string>;
};

function getEventSignature(event: SystemTaskEvent): string {
    return JSON.stringify(event);
}

function readProgress(event: SystemTaskEvent) {
    return event.type === CLI_ACQUISITION_PROGRESS_EVENT ? parseCliAcquisitionProgress(event.data) : null;
}

function neighboringProgress(events: readonly SystemTaskEvent[], index: number, direction: -1 | 1) {
    for (; index >= 0 && index < events.length; index += direction) {
        const event = events[index]!;
        const progress = readProgress(event);
        if (progress) return { index, event, progress };
    }
    return null;
}

function insertEventInChronologicalOrder(record: TaskRecord, nextEvent: SystemTaskEvent): SystemTaskEvent[] | null {
    const signature = getEventSignature(nextEvent);
    if (record.eventSignatures.has(signature)) return null;

    const events = record.state.events;
    const insertIndex = nextEvent.tsMs >= (events.at(-1)?.tsMs ?? 0)
        ? events.length : events.findIndex(event => nextEvent.tsMs < event.tsMs);
    let replacedIndex = -1;
    const progress = readProgress(nextEvent);
    if (progress && !progress.failure && progress.receivedBytes !== undefined) {
        const isSameTransfer = (neighbor: ReturnType<typeof neighboringProgress>) => neighbor
            && neighbor.event.stepId === nextEvent.stepId && neighbor.progress.phase === progress.phase
            && !neighbor.progress.failure && neighbor.progress.receivedBytes !== undefined;
        // Phase milestones break a transfer. A replayed sample only affects
        // the run of samples on its side of the closest milestone.
        if (isSameTransfer(neighboringProgress(events, insertIndex, 1))) return null;
        const previous = neighboringProgress(events, insertIndex - 1, -1);
        if (previous && isSameTransfer(previous)) {
            record.eventSignatures.delete(getEventSignature(previous.event));
            replacedIndex = previous.index;
        }
    }
    record.eventSignatures.add(signature);
    const nextEvents = [...events];
    nextEvents.splice(insertIndex, 0, nextEvent);
    if (replacedIndex >= 0) nextEvents.splice(replacedIndex, 1);
    return nextEvents;
}

function createInitialTaskState(taskId: string): SystemTaskRunState {
    return {
        taskId,
        status: 'running',
        currentStepId: null,
        latestMessage: null,
        awaitingInput: false,
        cancelRequested: false,
        events: [],
        result: null,
    };
}

function resolveResultStatus(result: SystemTaskResult): SystemTaskRunStatus {
    if (result.ok) {
        return 'succeeded';
    }
    return (result.error.code === 'cancelled' || result.error.code === 'canceled') ? 'canceled' : 'failed';
}

export type {
    SystemTaskBridgeListenerSet,
    SystemTaskRunState as SystemTaskSnapshot,
    SystemTasksBridge,
};

export function createSystemTaskRunner(options: Readonly<{
    bridge: SystemTasksBridge;
    mode?: SystemTaskRunner['mode'];
}>): SystemTaskRunner {
    const tasks = new Map<string, TaskRecord>();
    let activeSetupTask: ActiveSetupTask | null = null;
    let setupStart: Promise<string> | null = null;
    const setupListeners = new Set<() => void>();
    const notifySetup = () => { for (const listener of setupListeners) listener(); };
    const retireSetup = (taskId: string) => {
        if (activeSetupTask?.taskId !== taskId) return;
        activeSetupTask = null;
        setupStart = null;
        notifySetup();
    };

    const notifyTask = (taskId: string) => {
        const record = tasks.get(taskId);
        if (!record) {
            return;
        }
        for (const listener of record.listeners) {
            listener();
        }
    };

    const failTask = (taskId: string, errorCode: string, message: string) => {
        const record = tasks.get(taskId);
        if (!record || record.state.result) {
            return;
        }
        record.state = {
            ...record.state,
            awaitingInput: false,
            status: 'failed',
            result: {
                protocolVersion: 1,
                taskId,
                ok: false,
                error: {
                    code: errorCode,
                    message,
                },
            },
        };
        record.promptContinuation = null;
        retireSetup(taskId);
        notifyTask(taskId);
        record.unlistenBridge?.();
        record.unlistenBridge = null;
    };

    const respondToTask = async (taskId: string, answer: unknown): Promise<void> => {
        const record = tasks.get(taskId);
        if (!record || record.state.result || !record.state.awaitingInput) {
            return;
        }
        await options.bridge.respond(taskId, answer);
    };

    /**
     * Answer the task's current prompt through its registered continuation. The
     * signature guard keeps the answer exactly-once across re-registration and
     * repeated event replays; a continuation that declines leaves the prompt for
     * the user.
     */
    const continuePrompt = (taskId: string) => {
        const record = tasks.get(taskId);
        if (!record || record.state.result || !record.state.awaitingInput || !record.promptContinuation) {
            return;
        }
        const prompt = readLatestSystemTaskPrompt(record.state);
        if (!prompt) {
            return;
        }
        const signature = getSystemTaskPromptSignature(prompt);
        if (record.answeredPromptSignatures.has(signature) || record.inFlightPromptSignatures.has(signature)) {
            return;
        }
        record.inFlightPromptSignatures.add(signature);
        const continuation = record.promptContinuation;
        void (async () => {
            const answer = await continuation(prompt);
            if (answer === undefined) {
                record.answeredPromptSignatures.add(signature);
                return;
            }
            await respondToTask(taskId, answer);
            record.answeredPromptSignatures.add(signature);
        })().catch(() => {
            // Publication and bridge failures are retryable. The prompt remains
            // current and a remounted owner may register its continuation again.
            console.warn('[systemTasks] Prompt continuation failed; the current prompt can be retried', {
                taskId, promptKind: prompt.kind,
            });
        }).finally(() => {
            record.inFlightPromptSignatures.delete(signature);
            if (record.promptContinuation !== continuation
                && !record.answeredPromptSignatures.has(signature)) {
                continuePrompt(taskId);
            }
        });
    };

    const applyEvent = (taskId: string, payload: unknown) => {
        const record = tasks.get(taskId);
        if (!record || record.state.result) {
            return;
        }

        const parsed = SystemTaskEventSchema.safeParse(payload);
        if (!parsed.success || parsed.data.taskId !== taskId) {
            return;
        }

        const event = parsed.data;
        const nextEvents = insertEventInChronologicalOrder(record, event);
        if (!nextEvents) {
            continuePrompt(taskId);
            return;
        }
        const latestEvent = nextEvents[nextEvents.length - 1] ?? null;
        record.state = {
            ...record.state,
            events: nextEvents,
            currentStepId: latestEvent?.stepId ?? record.state.currentStepId,
            latestMessage: latestEvent?.message ?? record.state.latestMessage,
            awaitingInput: latestEvent?.type === 'prompt',
            status: record.state.status === 'canceling' ? 'canceling' : 'running',
        };
        notifyTask(taskId);
        continuePrompt(taskId);
    };

    const applyResult = (taskId: string, payload: unknown) => {
        const record = tasks.get(taskId);
        if (!record || record.state.result) {
            return;
        }

        const parsed = SystemTaskResultSchema.safeParse(payload);
        if (!parsed.success) {
            failTask(taskId, 'invalid_system_task_result', 'Received an invalid system task result payload.');
            return;
        }
        if (parsed.data.taskId !== taskId) {
            return;
        }

        const result = parsed.data;
        record.state = {
            ...record.state,
            awaitingInput: false,
            latestMessage: result.ok
                ? record.state.latestMessage
                : result.error.message,
            result,
            status: resolveResultStatus(result),
        };
        record.promptContinuation = null;
        retireSetup(taskId);
        notifyTask(taskId);
        record.unlistenBridge?.();
        record.unlistenBridge = null;
    };

    const startTask = async (parsedSpec: SystemTaskSpec, continuation?: SystemTaskPromptContinuation,
        accountScope?: SystemTaskAccountScope): Promise<string> => {
        const admittedScope = accountScope ? { ...accountScope } : null;
        const taskId = await options.bridge.start(parsedSpec);
        if (tasks.has(taskId)) return taskId;
        const record: TaskRecord = {
            spec: parsedSpec,
            accountScope: admittedScope,
            state: createInitialTaskState(taskId),
            eventSignatures: new Set(),
            listeners: new Set(),
            unlistenBridge: null,
            promptContinuation: continuation ?? null,
            answeredPromptSignatures: new Set(),
            inFlightPromptSignatures: new Set(),
        };
        tasks.set(taskId, record);
        if (activeSetupTask?.spec === parsedSpec) {
            activeSetupTask = { taskId, spec: parsedSpec };
            notifySetup();
        }
        let unlistenBridge: () => void;
        try {
            unlistenBridge = await options.bridge.subscribe(taskId, {
                onEvent: (payload) => {
                    applyEvent(taskId, payload);
                },
                onResult: (payload) => {
                    applyResult(taskId, payload);
                },
            } satisfies SystemTaskBridgeListenerSet);
        } catch (error) {
            failTask(taskId, 'system_task_start_failed', error instanceof Error ? error.message : 'system_task_start_failed');
            throw error;
        }
        if (record.state.result) unlistenBridge();
        else record.unlistenBridge = unlistenBridge;
        notifyTask(taskId);
        return taskId;
    };

    const cancelTask = async (taskId: string): Promise<void> => {
        const record = tasks.get(taskId);
        if (!record || record.state.result) return;
        record.state = { ...record.state, status: 'canceling', awaitingInput: false, cancelRequested: true };
        notifyTask(taskId);
        await options.bridge.cancel(taskId);
    };

    return {
        mode: options.mode ?? 'tauri',
        capabilities: options.bridge.capabilities,
        async start(spec: SystemTaskSpec, continuation?: SystemTaskPromptContinuation,
            startOptions?: SystemTaskStartOptions): Promise<string> {
            const parsedSpec = SystemTaskSpecSchema.parse(spec);
            const scope = readThisComputerSetupScope(parsedSpec);
            if (!scope) return startTask(parsedSpec, continuation, startOptions?.accountScope);
            if (activeSetupTask && setupStart) {
                if (startOptions?.adoptExisting !== false && matchesThisComputerSetupScope(activeSetupTask.spec, scope)) return setupStart;
                throw Object.assign(new Error('system_task_setup_in_progress'), {
                    code: 'system_task_setup_in_progress',
                });
            }
            activeSetupTask = { taskId: null, spec: parsedSpec };
            setupStart = startTask(parsedSpec, continuation, startOptions?.accountScope).catch((error: unknown) => {
                if (activeSetupTask?.spec === parsedSpec) {
                    activeSetupTask = null;
                    setupStart = null;
                    notifySetup();
                }
                throw error;
            });
            notifySetup();
            return setupStart;
        },
        getActiveSetupTask() { return activeSetupTask; },
        subscribeActiveSetupTask(listener: () => void) {
            setupListeners.add(listener);
            return () => { setupListeners.delete(listener); };
        },
        cancel: cancelTask,
        async cancelForAccount(taskId, scope) {
            const record = tasks.get(taskId);
            if (!record) return 'not_found';
            if (record.accountScope?.serverId !== scope.serverId || record.accountScope.accountId !== scope.accountId) return 'scope_mismatch';
            if (record.state.result) return 'already_settled';
            await cancelTask(taskId);
            return 'cancellation_requested';
        },
        async respond(taskId: string, answer: unknown): Promise<void> {
            await respondToTask(taskId, answer);
        },
        registerPromptContinuation(
            taskId: string,
            continuation: SystemTaskPromptContinuation,
            registrationOptions?: Readonly<{ preserveExisting?: boolean }>,
        ): void {
            const record = tasks.get(taskId);
            if (!record || record.state.result) {
                return;
            }
            if (!registrationOptions?.preserveExisting || !record.promptContinuation) {
                record.promptContinuation = continuation;
            }
            continuePrompt(taskId);
        },
        listActiveTasks() {
            return [...tasks.values()]
                .filter((record) => record.state.result === null)
                .map((record) => ({ taskId: record.state.taskId, spec: record.spec }));
        },
        listPromptContinuations(): readonly SystemTaskPromptContinuationRegistration[] {
            return [...tasks.values()]
                .filter((record) => record.promptContinuation !== null && record.state.result === null)
                .map((record) => ({ taskId: record.state.taskId, spec: record.spec }));
        },
        getSnapshot(taskId: string): SystemTaskRunState | null {
            const record = tasks.get(taskId);
            return record ? record.state : null;
        },
        getTaskSpec(taskId: string): SystemTaskSpec | null {
            return tasks.get(taskId)?.spec ?? null;
        },
        subscribe(taskId: string, listenerOrOnEvent?: (() => void) | ((event: SystemTaskEvent) => void), onResult?: (result: SystemTaskResult) => void): () => void {
            const record = tasks.get(taskId);
            if (!record) {
                return () => {};
            }
            if (typeof onResult === 'function') {
                const onEvent = listenerOrOnEvent as ((event: SystemTaskEvent) => void) | undefined;
                let seenEventSignatures = new Set<string>();
                let sawResult = false;
                const replay = () => {
                    const snapshot = record.state;
                    if (onEvent) {
                        const previousSignatures = seenEventSignatures;
                        // Update before callbacks, which can synchronously notify the runner.
                        // Compacted byte samples must not accumulate in subscriber memory.
                        seenEventSignatures = new Set(snapshot.events.map(getEventSignature));
                        for (const event of snapshot.events) {
                            const signature = getEventSignature(event);
                            if (previousSignatures.has(signature)) {
                                continue;
                            }
                            onEvent(event);
                        }
                    }
                    if (snapshot.result && !sawResult) {
                        sawResult = true;
                        onResult(snapshot.result);
                    }
                };
                replay();
                record.listeners.add(replay);
                return () => {
                    record.listeners.delete(replay);
                };
            }

            const listener = listenerOrOnEvent as (() => void) | undefined;
            if (!listener) {
                return () => {};
            }
            record.listeners.add(listener);
            return () => {
                record.listeners.delete(listener);
            };
        },
    };
}

/**
 * Await the terminal result for a task that was started through this runner.
 * System-task failures remain data (`ok: false`) so callers can preserve the
 * canonical error code and retry semantics; only an unknown task id rejects.
 */
export function waitForSystemTaskResult(
    runner: SystemTaskRunner,
    taskId: string,
    options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<SystemTaskResult> {
    const normalizedTaskId = String(taskId ?? '').trim();
    if (!normalizedTaskId) return Promise.reject(new Error('System task id is required.'));

    return new Promise<SystemTaskResult>((resolve, reject) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        const release = () => {
            unsubscribe?.();
            options.signal?.removeEventListener('abort', aborted);
        };
        const aborted = () => {
            if (settled) return;
            settled = true;
            release();
            const error = new Error('System task wait aborted.');
            error.name = 'AbortError';
            reject(options.signal?.reason ?? error);
        };
        const settle = (result: SystemTaskResult | null): void => {
            if (settled) return;
            if (!result) return;
            settled = true;
            release();
            resolve(result);
        };
        const inspect = (): void => {
            const snapshot = runner.getSnapshot(normalizedTaskId);
            if (!snapshot) {
                if (!unsubscribe) return;
                settled = true;
                release();
                reject(new Error(`Unknown system task: ${normalizedTaskId}`));
                return;
            }
            settle(snapshot.result);
        };
        if (options.signal?.aborted) { aborted(); return; }
        options.signal?.addEventListener('abort', aborted, { once: true });
        unsubscribe = runner.subscribe(normalizedTaskId, inspect);
        if (settled) release();
        inspect();
    });
}
