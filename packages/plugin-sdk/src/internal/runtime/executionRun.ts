import type {
    ExecutionRunHostBackendV1,
    ExecutionRunHostMessageV1,
    RuntimeDisposeReasonV1,
} from '../../runtime/session';
import type {
    InternalRuntimeTurnOperationsEnvelopeV1,
    InternalRuntimeTurnOperationsV1,
} from './session';

export type InternalExecutionRunTurnOperationsInputV1 =
    | InternalRuntimeTurnOperationsV1
    | InternalRuntimeTurnOperationsEnvelopeV1;

export type InternalExecutionRunTurnOperationsFactoryV1 =
    () => InternalExecutionRunTurnOperationsInputV1 | Promise<InternalExecutionRunTurnOperationsInputV1>;

export type InternalExecutionRunTurnLivenessV1 = Readonly<{
    active: boolean;
    reason?: string;
    lastActivityAtMs?: number | null;
    diagnostics?: Readonly<Record<string, unknown>>;
}>;

export type InternalExecutionRunStartOptionsInputV1 = Readonly<{
    resumeSessionId: string | null;
}>;

export type InternalExecutionRunActivityStateV1 = 'active' | 'idle' | null;

export type CreateExecutionRunHostBackendFromTurnOperationsOptionsV1 = Readonly<{
    createOperations: InternalExecutionRunTurnOperationsFactoryV1;
    readResumeSupport?: (opts?: Readonly<{ captureReplay?: boolean }>) => boolean | Promise<boolean>;
    buildStartOptions?: (
        input: InternalExecutionRunStartOptionsInputV1,
    ) => Readonly<Record<string, unknown>>;
    readRuntimeLiveness?: (
        operations: InternalRuntimeTurnOperationsV1,
    ) => InternalExecutionRunTurnLivenessV1 | null;
    readMessageActivity?: (message: ExecutionRunHostMessageV1) => InternalExecutionRunActivityStateV1;
    diagnostics?: Readonly<Record<string, unknown>>;
    supportsSteerPrompt?: boolean;
    waitForTurnCompletion?: Readonly<{
        mode?: 'once' | 'untilIdle';
        pollIntervalMs?: number;
    }>;
    onSubscriberError?: (error: unknown) => void;
}>;

type PromptTurnState = {
    promise: Promise<void>;
    settled: boolean;
};

const DEFAULT_COMPLETION_POLL_INTERVAL_MS = 25;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readSessionId(value: unknown): string | null {
    if (typeof value === 'string') return normalizeNonEmptyString(value);
    const record = readRecord(value);
    return normalizeNonEmptyString(record?.sessionId)
        ?? normalizeNonEmptyString(record?.providerSessionId);
}

function normalizeCompletionTimeoutMs(timeoutMs: number | null | undefined): number | null {
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.trunc(timeoutMs)
        : null;
}

function normalizePollIntervalMs(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : DEFAULT_COMPLETION_POLL_INTERVAL_MS;
}

function createPromptTurn(promise: Promise<void>): PromptTurnState {
    const turn: PromptTurnState = { promise, settled: false };
    promise.then(
        () => {
            turn.settled = true;
        },
        () => {
            turn.settled = true;
        },
    );
    return turn;
}

function unwrapOperations(input: InternalExecutionRunTurnOperationsInputV1): InternalRuntimeTurnOperationsV1 {
    const record = readRecord(input);
    const operations = record?.operations;
    return operations && typeof operations === 'object'
        ? operations as InternalRuntimeTurnOperationsV1
        : input as InternalRuntimeTurnOperationsV1;
}

function defaultStartOptions(
    input: InternalExecutionRunStartOptionsInputV1,
): Readonly<Record<string, unknown>> {
    return input.resumeSessionId
        ? { resumeId: input.resumeSessionId, importHistory: false }
        : {};
}

function defaultMessageActivity(message: ExecutionRunHostMessageV1): InternalExecutionRunActivityStateV1 {
    const record = readRecord(message);
    if (record?.type === 'status') {
        if (record.status === 'running') return 'active';
        if (record.status === 'idle') return 'idle';
    }
    if (record?.kind === 'turn-start') return 'active';
    if (
        record?.kind === 'turn-complete'
        || record?.kind === 'turn-failed'
        || record?.kind === 'turn-cancelled'
    ) {
        return 'idle';
    }
    return null;
}

function waitForPollInterval(intervalMs: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        timer.unref?.();
    });
}

async function withCompletionTimeout<T>(operation: Promise<T>, timeoutMs: number | null): Promise<T> {
    if (timeoutMs === null) return await operation;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`Timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function createExecutionRunHostBackendFromTurnOperations(
    options: CreateExecutionRunHostBackendFromTurnOperationsOptionsV1,
): ExecutionRunHostBackendV1 {
    let operationsPromise: Promise<InternalRuntimeTurnOperationsV1> | null = null;
    let operations: InternalRuntimeTurnOperationsV1 | null = null;
    let unsubscribeRuntime: (() => void) | null = null;
    let sessionId: string | null = null;
    let active = false;
    let lastActivityAtMs: number | null = null;
    let promptTurn: PromptTurnState | null = null;
    let disposed = false;
    let disposePromise: Promise<void> | null = null;
    const messageHandlers = new Set<(message: ExecutionRunHostMessageV1) => void>();

    const markActive = (): void => {
        active = true;
        lastActivityAtMs = Date.now();
    };

    const markIdle = (): void => {
        active = false;
        lastActivityAtMs = Date.now();
    };

    const publishMessage = (message: ExecutionRunHostMessageV1): void => {
        const activity = options.readMessageActivity?.(message) ?? defaultMessageActivity(message);
        if (activity === 'active') markActive();
        if (activity === 'idle') markIdle();
        for (const handler of Array.from(messageHandlers)) {
            try {
                handler(message);
            } catch (error) {
                options.onSubscriberError?.(error);
            }
        }
    };

    const getOperations = async (): Promise<InternalRuntimeTurnOperationsV1> => {
        if (disposed) throw new Error('Execution-run turn operations have been disposed.');
        if (operations) return operations;
        if (!operationsPromise) {
            operationsPromise = Promise.resolve()
                .then(() => options.createOperations())
                .then(async (created) => {
                    const nextOperations = unwrapOperations(created);
                    if (disposed) {
                        await nextOperations.resetOrDisposeRuntime();
                        throw new Error('Execution-run turn operations have been disposed.');
                    }
                    operations = nextOperations;
                    unsubscribeRuntime = nextOperations.subscribeRuntimeEvents((message) => {
                        publishMessage(message as ExecutionRunHostMessageV1);
                    });
                    return nextOperations;
                }, (error: unknown) => {
                    operationsPromise = null;
                    throw error;
                });
        }
        return operationsPromise;
    };

    const ensureSession = async (requestedSessionId?: string | null): Promise<string> => {
        const normalizedRequestedSessionId = normalizeNonEmptyString(requestedSessionId);
        if (sessionId && (!normalizedRequestedSessionId || normalizedRequestedSessionId === sessionId)) {
            return sessionId;
        }
        const activeOperations = await getOperations();
        const started = await activeOperations.startOrLoadSession(
            (options.buildStartOptions ?? defaultStartOptions)({
                resumeSessionId: normalizedRequestedSessionId,
            }),
        );
        const nextSessionId = readSessionId(started)
            ?? readSessionId(activeOperations.readSessionIdentity().sessionId);
        if (!nextSessionId) {
            throw new Error('Execution-run turn operations did not return a session id.');
        }
        sessionId = nextSessionId;
        return nextSessionId;
    };

    const waitForSubmittedPrompt = async (): Promise<void> => {
        const currentPromptTurn = promptTurn;
        if (!currentPromptTurn) return;
        try {
            await currentPromptTurn.promise;
        } finally {
            if (promptTurn === currentPromptTurn) {
                promptTurn = null;
            }
        }
    };

    const waitForTurnCompletion = async (timeoutMs?: number | null): Promise<void> => {
        await waitForSubmittedPrompt();
        const activeOperations = operations ?? (operationsPromise ? await getOperations() : null);
        if (!activeOperations) return;
        const normalizedTimeoutMs = normalizeCompletionTimeoutMs(timeoutMs);
        const waitOnce = async (): Promise<void> => {
            await activeOperations.waitForTurnCompletion({ timeoutMs: normalizedTimeoutMs });
        };
        if (options.waitForTurnCompletion?.mode === 'untilIdle') {
            const pollIntervalMs = normalizePollIntervalMs(options.waitForTurnCompletion.pollIntervalMs);
            await withCompletionTimeout((async () => {
                while (active) {
                    await waitOnce();
                    if (active) await waitForPollInterval(pollIntervalMs);
                }
            })(), normalizedTimeoutMs);
        } else {
            await waitOnce();
        }
        markIdle();
    };

    const sendPrompt = async (requestedSessionId: string, prompt: string): Promise<void> => {
        await ensureSession(requestedSessionId);
        const activeOperations = await getOperations();
        activeOperations.beginTurnLifecycle();
        markActive();
        let promptWork: Promise<void>;
        try {
            promptWork = Promise.resolve(activeOperations.sendTurnPrompt(prompt));
        } catch (error) {
            markIdle();
            throw error;
        }
        const currentPromptTurn = createPromptTurn(promptWork);
        promptTurn = currentPromptTurn;
        void promptWork.catch(() => undefined);
        try {
            await promptWork;
        } catch (error) {
            if (promptTurn === currentPromptTurn) {
                promptTurn = null;
            }
            markIdle();
            throw error;
        }
    };

    return Object.freeze({
        async readResumeSupport(opts) {
            return options.readResumeSupport
                ? await options.readResumeSupport(opts)
                : opts?.captureReplay === true ? false : true;
        },
        async provisionSession(opts = {}) {
            const resumeSessionId = normalizeNonEmptyString(opts.resumeSessionId);
            if (resumeSessionId && opts.captureReplay === true) {
                throw new Error('Backend does not support resumable long-lived runs');
            }
            const provisionedSessionId = await ensureSession(resumeSessionId);
            const initialPrompt = normalizeNonEmptyString(opts.initialPrompt);
            if (initialPrompt) {
                await sendPrompt(provisionedSessionId, initialPrompt);
                await waitForTurnCompletion(null);
            }
            return { sessionId: provisionedSessionId };
        },
        sendPrompt,
        ...(options.supportsSteerPrompt === false
            ? {}
            : {
                async sendSteerPrompt(requestedSessionId: string, prompt: string) {
                    await ensureSession(requestedSessionId);
                    const activeOperations = await getOperations();
                    markActive();
                    await activeOperations.steerInFlightTurn(prompt);
                },
            }),
        async cancel(requestedSessionId) {
            await ensureSession(requestedSessionId);
            const activeOperations = await getOperations();
            await activeOperations.cancelTurn();
            markIdle();
        },
        subscribeMessages(handler) {
            messageHandlers.add(handler);
            return () => {
                messageHandlers.delete(handler);
            };
        },
        async respondToPermission(requestId, approved) {
            const activeOperations = await getOperations();
            await activeOperations.respondToPermission(requestId, approved);
        },
        waitForTurnCompletion,
        async probeTurnLiveness(_requestedSessionId) {
            const runtimeLiveness = operations ? options.readRuntimeLiveness?.(operations) ?? null : null;
            const effectiveActive = runtimeLiveness?.active ?? active;
            return {
                active: effectiveActive,
                ...(runtimeLiveness?.reason ? { reason: runtimeLiveness.reason } : {}),
                lastActivityAtMs: runtimeLiveness?.lastActivityAtMs ?? lastActivityAtMs,
                diagnostics: {
                    ...(runtimeLiveness?.diagnostics ?? {}),
                    ...(options.diagnostics ?? {}),
                    promptInFlight: promptTurn !== null && !promptTurn.settled,
                    turnInFlight: effectiveActive,
                },
            };
        },
        async dispose(_reason?: RuntimeDisposeReasonV1) {
            if (disposePromise) return await disposePromise;
            disposed = true;
            disposePromise = (async () => {
                unsubscribeRuntime?.();
                unsubscribeRuntime = null;
                const currentOperations = operations;
                if (currentOperations) {
                    await currentOperations.resetOrDisposeRuntime();
                } else if (operationsPromise) {
                    await operationsPromise.catch(() => null);
                }
                operationsPromise = null;
                operations = null;
                sessionId = null;
                promptTurn = null;
                active = false;
                lastActivityAtMs = null;
                messageHandlers.clear();
            })();
            return await disposePromise;
        },
    });
}
