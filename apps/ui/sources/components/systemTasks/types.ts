import type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';

export type SystemTaskRunnerMode = 'tauri' | 'dev' | 'unavailable';

export type SystemTaskRunStatus =
    | 'running'
    | 'canceling'
    | 'succeeded'
    | 'failed'
    | 'canceled';

export type SystemTaskRunState = Readonly<{
    taskId: string;
    status: SystemTaskRunStatus;
    currentStepId: string | null;
    latestMessage: string | null;
    awaitingInput: boolean;
    cancelRequested: boolean;
    events: readonly SystemTaskEvent[];
    result: SystemTaskResult | null;
}>;

export type SystemTaskStatus = SystemTaskRunStatus;
export type SystemTaskSnapshot = SystemTaskRunState;

export type SystemTaskBridgeListenerSet = Readonly<{
    onEvent: (payload: unknown) => void;
    onResult: (payload: unknown) => void;
}>;

export type SystemTaskBridge = Readonly<{
    start: (spec: SystemTaskSpec) => Promise<string>;
    subscribe: (
        taskId: string,
        listeners: SystemTaskBridgeListenerSet,
    ) => Promise<() => void>;
    cancel: (taskId: string) => Promise<void>;
    respond: (taskId: string, answer: unknown) => Promise<void>;
}>;

export type SystemTasksBridge = SystemTaskBridge;

export type SystemTaskRunner = Readonly<{
    mode: SystemTaskRunnerMode;
    start: (spec: SystemTaskSpec) => Promise<string>;
    cancel: (taskId: string) => Promise<void>;
    respond: (taskId: string, answer: unknown) => Promise<void>;
    getSnapshot: (taskId: string) => SystemTaskRunState | null;
    subscribe(taskId: string, listener: () => void): () => void;
    subscribe(taskId: string, onEvent?: (event: SystemTaskEvent) => void, onResult?: (result: SystemTaskResult) => void): () => void;
}>;
