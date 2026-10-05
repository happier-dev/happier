import type { SystemTaskEvent, SystemTaskJsonObject, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';

export type SystemTaskRunnerMode = 'tauri' | 'native' | 'dev' | 'unavailable';

export type NativeSshSystemTaskCapability = Readonly<{
    available: boolean;
    supportsLoopbackTunnel?: boolean;
    unavailableReason?:
        | 'feature-disabled'
        | 'native-module-missing'
        | 'unsupported-platform'
        | 'build-not-included'
        | 'engine-unavailable'
        | 'missing-credentials'
        | 'host-key-untrusted';
    supportedTaskKinds: readonly ['remote.ssh.bootstrapMachine.v1'];
}>;

export type SystemTaskBridgeCapabilities = Readonly<{
    nativeSsh?: NativeSshSystemTaskCapability;
}>;

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

export type SystemTaskPromptEnvelope = Readonly<{
    kind: string;
    message: string;
    data: SystemTaskJsonObject;
}>;

/**
 * A task-lifetime answer for the prompts a running system task raises. The
 * runner owns delivery and exactly-once response; a continuation resolving
 * `undefined` declines the prompt and leaves it unanswered for the user.
 */
export type SystemTaskPromptContinuation = (prompt: SystemTaskPromptEnvelope) => Promise<unknown>;

export type SystemTaskPromptContinuationRegistration = Readonly<{
    taskId: string;
    spec: SystemTaskSpec;
}>;

export type ActiveSetupTask = Readonly<{ taskId: string | null; spec: SystemTaskSpec }>;

export type SystemTaskBridgeListenerSet = Readonly<{
    onEvent: (payload: unknown) => void;
    onResult: (payload: unknown) => void;
}>;

export type SystemTaskBridge = Readonly<{
    capabilities?: SystemTaskBridgeCapabilities;
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
    capabilities?: SystemTaskBridgeCapabilities;
    start: (
        spec: SystemTaskSpec,
        continuation?: SystemTaskPromptContinuation,
        options?: Readonly<{ adoptExisting?: boolean }>,
    ) => Promise<string>;
    /** One admitted setup, published before native launch returns its task id. */
    getActiveSetupTask: () => ActiveSetupTask | null;
    subscribeActiveSetupTask: (listener: () => void) => () => void;
    cancel: (taskId: string) => Promise<void>;
    respond: (taskId: string, answer: unknown) => Promise<void>;
    /**
     * Bind a prompt answerer to a started task for the rest of that task's life.
     * Continuations outlive any view that started the task, so navigating away
     * cannot strand a task waiting on an answer.
     */
    registerPromptContinuation?: (taskId: string, continuation: SystemTaskPromptContinuation) => void;
    /** Tasks that are still running with a registered continuation, so a remounted surface can rediscover them. */
    listPromptContinuations?: () => readonly SystemTaskPromptContinuationRegistration[];
    /** Tasks this runner started that have no result yet — the one fact of what is in flight. */
    listActiveTasks?: () => readonly Readonly<{ taskId: string; spec: SystemTaskSpec }>[];
    getSnapshot: (taskId: string) => SystemTaskRunState | null;
    /** Original spec remains owned by this runner, including after task settlement. */
    getTaskSpec?: (taskId: string) => SystemTaskSpec | null;
    subscribe(taskId: string, listener: () => void): () => void;
    subscribe(taskId: string, onEvent?: (event: SystemTaskEvent) => void, onResult?: (result: SystemTaskResult) => void): () => void;
}>;

export type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec };
