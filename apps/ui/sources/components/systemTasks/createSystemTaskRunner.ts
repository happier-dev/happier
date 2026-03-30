import {
    SystemTaskEventSchema,
    SystemTaskResultSchema,
    SystemTaskSpecSchema,
    type SystemTaskEvent,
    type SystemTaskResult,
    type SystemTaskSpec,
} from '@happier-dev/protocol';

import type {
    SystemTaskRunState,
    SystemTaskRunner,
    SystemTaskRunStatus,
    SystemTasksBridge,
    SystemTaskBridgeListenerSet,
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
    state: SystemTaskRunState;
    listeners: Set<() => void>;
    unlistenBridge: (() => void) | null;
};

function getEventSignature(event: SystemTaskEvent): string {
    return JSON.stringify(event);
}

function insertEventInChronologicalOrder(
    events: readonly SystemTaskEvent[],
    nextEvent: SystemTaskEvent,
): SystemTaskEvent[] {
    const nextSignature = getEventSignature(nextEvent);
    if (events.some((event) => getEventSignature(event) === nextSignature)) {
        return [...events];
    }

    const nextEvents = [...events];
    const insertIndex = nextEvents.findIndex((event) => nextEvent.tsMs < event.tsMs);
    if (insertIndex === -1) {
        nextEvents.push(nextEvent);
        return nextEvents;
    }
    nextEvents.splice(insertIndex, 0, nextEvent);
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
        notifyTask(taskId);
        record.unlistenBridge?.();
        record.unlistenBridge = null;
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
        const nextEvents = insertEventInChronologicalOrder(record.state.events, event);
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
        notifyTask(taskId);
        record.unlistenBridge?.();
        record.unlistenBridge = null;
    };

    return {
        mode: options.mode ?? 'tauri',
        async start(spec: SystemTaskSpec): Promise<string> {
            const parsedSpec = SystemTaskSpecSchema.parse(spec);
            const taskId = await options.bridge.start(parsedSpec);
            const record: TaskRecord = {
                state: createInitialTaskState(taskId),
                listeners: new Set(),
                unlistenBridge: null,
            };
            tasks.set(taskId, record);
            record.unlistenBridge = await options.bridge.subscribe(taskId, {
                onEvent: (payload) => {
                    applyEvent(taskId, payload);
                },
                onResult: (payload) => {
                    applyResult(taskId, payload);
                },
            } satisfies SystemTaskBridgeListenerSet);
            notifyTask(taskId);
            return taskId;
        },
        async cancel(taskId: string): Promise<void> {
            const record = tasks.get(taskId);
            if (!record || record.state.result) {
                return;
            }

            record.state = {
                ...record.state,
                status: 'canceling',
                awaitingInput: false,
                cancelRequested: true,
            };
            notifyTask(taskId);
            await options.bridge.cancel(taskId);
        },
        async respond(taskId: string, answer: unknown): Promise<void> {
            const record = tasks.get(taskId);
            if (!record || record.state.result || !record.state.awaitingInput) {
                return;
            }
            await options.bridge.respond(taskId, answer);
        },
        getSnapshot(taskId: string): SystemTaskRunState | null {
            const record = tasks.get(taskId);
            return record ? record.state : null;
        },
        subscribe(taskId: string, listenerOrOnEvent?: (() => void) | ((event: SystemTaskEvent) => void), onResult?: (result: SystemTaskResult) => void): () => void {
            const record = tasks.get(taskId);
            if (!record) {
                return () => {};
            }
            if (typeof onResult === 'function') {
                const onEvent = listenerOrOnEvent as ((event: SystemTaskEvent) => void) | undefined;
                const seenEventSignatures = new Set<string>();
                let sawResult = false;
                const replay = () => {
                    const snapshot = record.state;
                    if (onEvent) {
                        for (const event of snapshot.events) {
                            const signature = getEventSignature(event);
                            if (seenEventSignatures.has(signature)) {
                                continue;
                            }
                            seenEventSignatures.add(signature);
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

export const createSystemTasksRunner = createSystemTaskRunner;
