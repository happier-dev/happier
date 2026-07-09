import type {
    ExecutionRunHostBackendV1,
    ExecutionRunHostMessageV1,
    RuntimeDisposeReasonV1,
    RuntimeEventV1,
    RuntimeSendOptionsV1,
    RuntimeSendResultV1,
    SessionRuntimeV1,
} from './session.js';

export type PublicExecutionRunSessionRuntimeFactoryParamsV1 = Readonly<{
    resumeSessionId?: string;
    captureReplay?: boolean;
}>;

export type PublicExecutionRunSessionRuntimeFactoryV1 =
    (params?: PublicExecutionRunSessionRuntimeFactoryParamsV1) => SessionRuntimeV1 | Promise<SessionRuntimeV1>;

export type PublicExecutionRunTurnLivenessV1 = Readonly<{
    active: boolean;
    reason?: string;
    lastActivityAtMs?: number | null;
    diagnostics?: Readonly<Record<string, unknown>>;
}>;

export type PublicExecutionRunActivityStateV1 = 'active' | 'idle' | null;

export type CreateExecutionRunHostBackendFromSessionRuntimeOptionsV1 = Readonly<{
    createSessionRuntime: PublicExecutionRunSessionRuntimeFactoryV1;
    readResumeSupport?: (opts?: Readonly<{ captureReplay?: boolean }>) => boolean | Promise<boolean>;
    readRuntimeLiveness?: (runtime: SessionRuntimeV1) => PublicExecutionRunTurnLivenessV1 | null;
    readMessageActivity?: (message: ExecutionRunHostMessageV1) => PublicExecutionRunActivityStateV1;
    diagnostics?: Readonly<Record<string, unknown>>;
    supportsSteerPrompt?: boolean;
    waitForRuntimeTurnCompletion?: (runtime: SessionRuntimeV1, timeoutMs: number | null) => Promise<void>;
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

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRuntimeDeltaText(value: unknown): string | null {
    const directText = readString(value);
    if (directText) return directText;
    const record = readRecord(value);
    if (!record) return null;

    const content = readRecord(record.content);
    return readString(record.text)
        ?? readString(record.textDelta)
        ?? readString(record.deltaText)
        ?? readString(record.message)
        ?? readString(content?.text)
        ?? readString(content?.textDelta);
}

function isThinkingRuntimeDelta(value: unknown): boolean {
    return readRecord(value)?.thinking === true;
}

function readCommittedAssistantText(body: unknown): string | null {
    const record = readRecord(body);
    if (!record) return null;
    if (record.type !== 'message') return null;
    return readString(record.message)
        ?? readString(record.text)
        ?? readRuntimeDeltaText(record.content);
}

function toHostModelOutputMessage(event: RuntimeEventV1): ExecutionRunHostMessageV1 | null {
    if (event.kind === 'message-delta') {
        if (isThinkingRuntimeDelta(event.delta)) return null;
        const textDelta = readRuntimeDeltaText(event.delta);
        return textDelta ? { type: 'model-output', textDelta } : null;
    }

    if (event.kind === 'transcript-agent-message-committed') {
        const fullText = readCommittedAssistantText(event.body);
        return fullText ? { type: 'model-output', fullText } : null;
    }

    return null;
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

function isUserMessageSeq(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeNonEmptyStringList(values: readonly unknown[] | null | undefined): string[] {
    const normalized: string[] = [];
    for (const value of values ?? []) {
        const text = normalizeNonEmptyString(value);
        if (!text || normalized.includes(text)) continue;
        normalized.push(text);
    }
    return normalized;
}

function normalizeSeqList(values: readonly unknown[] | null | undefined): number[] {
    const normalized: number[] = [];
    for (const value of values ?? []) {
        if (!isUserMessageSeq(value) || normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function runtimeSendOptionsFromPromptMeta(
    meta: Parameters<ExecutionRunHostBackendV1['sendPrompt']>[2],
    deliverAs?: RuntimeSendOptionsV1['deliverAs'],
): RuntimeSendOptionsV1 | undefined {
    const localInputId = normalizeNonEmptyString(meta?.localInputId);
    const localInputIds = normalizeNonEmptyStringList([
        ...(localInputId ? [localInputId] : []),
        ...(meta?.localInputIds ?? []),
    ]);
    const providerClaimedPendingLocalIds = normalizeNonEmptyStringList(meta?.providerClaimedPendingLocalIds);
    const userMessageSeq = meta?.userMessageSeq;
    const userMessageSeqs = normalizeSeqList([
        ...(isUserMessageSeq(userMessageSeq) ? [userMessageSeq] : []),
        ...(meta?.userMessageSeqs ?? []),
    ]);
    const sendOptions: RuntimeSendOptionsV1 = {
        ...(deliverAs ? { deliverAs } : {}),
        ...(localInputId ? { localInputId } : {}),
        ...(localInputIds.length > 0 ? { localInputIds } : {}),
        ...(providerClaimedPendingLocalIds.length > 0 ? { providerClaimedPendingLocalIds } : {}),
        ...(isUserMessageSeq(userMessageSeq) ? { userMessageSeq } : {}),
        ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
    };
    return Object.keys(sendOptions).length > 0 ? sendOptions : undefined;
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

function defaultMessageActivity(message: ExecutionRunHostMessageV1): PublicExecutionRunActivityStateV1 {
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

function assertSendAccepted(result: RuntimeSendResultV1): void {
    if (result.status === 'accepted') return;
    const diagnostic = result.diagnostic ? `: ${result.diagnostic}` : '';
    throw new Error(`Runtime rejected execution-run prompt with status '${result.status}'${diagnostic}`);
}

function createRuntimeInput(prompt: string): Readonly<{ v: 1; text: string }> {
    return { v: 1, text: prompt };
}

export function createExecutionRunHostBackendFromSessionRuntime(
    options: CreateExecutionRunHostBackendFromSessionRuntimeOptionsV1,
): ExecutionRunHostBackendV1 {
    let runtimePromise: Promise<SessionRuntimeV1> | null = null;
    let runtime: SessionRuntimeV1 | null = null;
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

    const publishOneMessage = (message: ExecutionRunHostMessageV1): void => {
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

    const publishMessage = (message: RuntimeEventV1): void => {
        publishOneMessage(message);
        const modelOutputMessage = toHostModelOutputMessage(message);
        if (modelOutputMessage) {
            publishOneMessage(modelOutputMessage);
        }
    };

    const getRuntime = async (
        params?: PublicExecutionRunSessionRuntimeFactoryParamsV1,
    ): Promise<SessionRuntimeV1> => {
        if (disposed) throw new Error('Execution-run session runtime has been disposed.');
        if (runtime) return runtime;
        if (!runtimePromise) {
            runtimePromise = Promise.resolve()
                .then(() => options.createSessionRuntime(params))
                .then(async (created) => {
                    if (disposed) {
                        await created.dispose('runtime_recovery');
                        throw new Error('Execution-run session runtime has been disposed.');
                    }
                    runtime = created;
                    unsubscribeRuntime = created.events.subscribe((message: RuntimeEventV1) => {
                        publishMessage(message);
                    });
                    return created;
                }, (error: unknown) => {
                    runtimePromise = null;
                    throw error;
                });
        }
        return runtimePromise;
    };

    const ensureSession = async (
        requestedSessionId?: string | null,
        params?: Readonly<{ captureReplay?: boolean }>,
    ): Promise<string> => {
        const normalizedRequestedSessionId = normalizeNonEmptyString(requestedSessionId);
        if (sessionId && (!normalizedRequestedSessionId || normalizedRequestedSessionId === sessionId)) {
            return sessionId;
        }
        if (sessionId && normalizedRequestedSessionId && normalizedRequestedSessionId !== sessionId) {
            throw new Error('Execution-run session runtime cannot switch provider sessions.');
        }
        const activeRuntime = await getRuntime({
            ...(normalizedRequestedSessionId ? { resumeSessionId: normalizedRequestedSessionId } : {}),
            ...(params?.captureReplay === true ? { captureReplay: true } : {}),
        });
        const runtimeSessionId = normalizeNonEmptyString(activeRuntime.identity.read().providerSessionId);
        if (runtimeSessionId && normalizedRequestedSessionId && runtimeSessionId !== normalizedRequestedSessionId) {
            throw new Error('Execution-run session runtime returned a different provider session id.');
        }
        const nextSessionId = runtimeSessionId ?? normalizedRequestedSessionId;
        if (!nextSessionId) {
            throw new Error('Execution-run session runtime did not expose a provider session id.');
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
        const activeRuntime = runtime ?? (runtimePromise ? await getRuntime() : null);
        if (!activeRuntime) return;
        const normalizedTimeoutMs = normalizeCompletionTimeoutMs(timeoutMs);
        if (options.waitForRuntimeTurnCompletion) {
            await options.waitForRuntimeTurnCompletion(activeRuntime, normalizedTimeoutMs);
        }
        if (options.waitForTurnCompletion?.mode === 'untilIdle') {
            const pollIntervalMs = normalizePollIntervalMs(options.waitForTurnCompletion.pollIntervalMs);
            await withCompletionTimeout((async () => {
                while (active) {
                    await waitForPollInterval(pollIntervalMs);
                }
            })(), normalizedTimeoutMs);
        }
        markIdle();
    };

    const submitRuntimeInput = async (
        prompt: string,
        sendOptions?: RuntimeSendOptionsV1,
        trackPromptTurn = true,
    ): Promise<void> => {
        const activeRuntime = await getRuntime();
        markActive();
        let promptWork: Promise<void>;
        try {
            promptWork = Promise.resolve(activeRuntime.send(createRuntimeInput(prompt), sendOptions))
                .then(assertSendAccepted);
        } catch (error) {
            markIdle();
            throw error;
        }
        const currentPromptTurn = trackPromptTurn ? createPromptTurn(promptWork) : null;
        if (currentPromptTurn) promptTurn = currentPromptTurn;
        void promptWork.catch(() => undefined);
        try {
            await promptWork;
        } catch (error) {
            if (currentPromptTurn && promptTurn === currentPromptTurn) {
                promptTurn = null;
            }
            markIdle();
            throw error;
        }
    };

    return Object.freeze({
        get permissionCapability() {
            return runtime?.permissions?.capability;
        },
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
            const provisionedSessionId = await ensureSession(resumeSessionId, {
                ...(opts.captureReplay === true ? { captureReplay: true } : {}),
            });
            const initialPrompt = normalizeNonEmptyString(opts.initialPrompt);
            if (initialPrompt) {
                await submitRuntimeInput(initialPrompt);
                await waitForTurnCompletion(null);
            }
            return { sessionId: provisionedSessionId };
        },
        async sendPrompt(requestedSessionId, prompt, meta) {
            await ensureSession(requestedSessionId);
            await submitRuntimeInput(
                prompt,
                runtimeSendOptionsFromPromptMeta(meta),
            );
        },
        ...(options.supportsSteerPrompt === false
            ? {}
            : {
                async sendSteerPrompt(
                    requestedSessionId: string,
                    prompt: string,
                    meta?: RuntimeSendOptionsV1,
                ) {
                    await ensureSession(requestedSessionId);
                    await submitRuntimeInput(
                        prompt,
                        runtimeSendOptionsFromPromptMeta(meta, 'steer'),
                        false,
                    );
                },
            }),
        async cancel(_requestedSessionId) {
            const activeRuntime = runtime ?? (runtimePromise ? await getRuntime() : null);
            if (!activeRuntime) return;
            await activeRuntime.cancel?.({ reason: 'user' });
            markIdle();
        },
        subscribeMessages(handler) {
            messageHandlers.add(handler);
            return () => {
                messageHandlers.delete(handler);
            };
        },
        async respondToPermission(requestId, approved) {
            const activeRuntime = runtime ?? (runtimePromise ? await getRuntime() : null);
            if (!activeRuntime || !sessionId) {
                return { delivered: false, reason: 'no_active_session' };
            }
            const permissions = activeRuntime.permissions;
            if (permissions?.capability !== 'responds') {
                return { delivered: false, reason: 'unknown_request' };
            }
            return await permissions.respond({ requestId, approved });
        },
        waitForTurnCompletion,
        async probeTurnLiveness(_requestedSessionId) {
            const activeRuntime = runtime ?? (runtimePromise ? await getRuntime() : null);
            const runtimeLiveness = activeRuntime ? options.readRuntimeLiveness?.(activeRuntime) ?? null : null;
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
                const currentRuntime = runtime;
                if (currentRuntime) {
                    await currentRuntime.dispose('runtime_recovery');
                } else if (runtimePromise) {
                    await runtimePromise.catch(() => null);
                }
                runtimePromise = null;
                runtime = null;
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
