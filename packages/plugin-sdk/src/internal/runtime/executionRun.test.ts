import { describe, expect, it, vi } from 'vitest';

type TestOperations = Readonly<{
    beginTurnLifecycle: ReturnType<typeof vi.fn>;
    startOrLoadSession: ReturnType<typeof vi.fn>;
    sendTurnPrompt: ReturnType<typeof vi.fn>;
    steerInFlightTurn: ReturnType<typeof vi.fn>;
    waitForTurnCompletion: ReturnType<typeof vi.fn>;
    subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    respondToPermission: ReturnType<typeof vi.fn>;
    cancelTurn: ReturnType<typeof vi.fn>;
    readSessionIdentity: ReturnType<typeof vi.fn>;
    updateSessionRuntimeConfig: ReturnType<typeof vi.fn>;
    resetOrDisposeRuntime: ReturnType<typeof vi.fn>;
}>;

type TestBackend = Readonly<{
    readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean>;
    provisionSession(opts?: Readonly<{
        initialPrompt?: string;
        resumeSessionId?: string;
        captureReplay?: boolean;
    }>): Promise<Readonly<{ sessionId: string }>>;
    sendPrompt(sessionId: string, prompt: string): Promise<void>;
    sendSteerPrompt?(sessionId: string, prompt: string): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    subscribeMessages(handler: (message: unknown) => void): () => void;
    respondToPermission?(requestId: string, approved: boolean): Promise<void>;
    waitForTurnCompletion?(timeoutMs?: number | null): Promise<void>;
    probeTurnLiveness?(sessionId: string): Promise<Readonly<{
        active: boolean;
        lastActivityAtMs?: number | null;
        diagnostics?: Readonly<Record<string, unknown>>;
    }>>;
    dispose(): Promise<void>;
}>;

type Factory = (options: Readonly<{
    createOperations: () => TestOperations | Promise<TestOperations> | Readonly<{ operations: TestOperations }>;
    diagnostics?: Readonly<Record<string, unknown>>;
    readRuntimeLiveness?: (operations: TestOperations) => Readonly<{
        active: boolean;
        lastActivityAtMs?: number | null;
        diagnostics?: Readonly<Record<string, unknown>>;
    }> | null;
    waitForTurnCompletion?: Readonly<{
        mode?: 'once' | 'untilIdle';
        pollIntervalMs?: number;
    }>;
}>) => TestBackend;

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flushMicrotasks(times = 4): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        await Promise.resolve();
    }
}

function createOperations(overrides: Partial<TestOperations> = {}): TestOperations {
    let runtimeHandler: ((message: unknown) => void) | null = null;
    return {
        beginTurnLifecycle: vi.fn(),
        startOrLoadSession: vi.fn(async () => ({ sessionId: 'runtime-session-1' })),
        sendTurnPrompt: vi.fn(async () => undefined),
        steerInFlightTurn: vi.fn(async () => undefined),
        waitForTurnCompletion: vi.fn(async () => undefined),
        subscribeRuntimeEvents: vi.fn((handler: (message: unknown) => void) => {
            runtimeHandler = handler;
            return vi.fn(() => {
                runtimeHandler = null;
            });
        }),
        respondToPermission: vi.fn(async () => undefined),
        cancelTurn: vi.fn(async () => undefined),
        readSessionIdentity: vi.fn(() => ({ sessionId: 'runtime-session-1' })),
        updateSessionRuntimeConfig: vi.fn(async () => undefined),
        resetOrDisposeRuntime: vi.fn(async () => undefined),
        ...overrides,
        get runtimeHandler() {
            return runtimeHandler;
        },
    } as TestOperations;
}

async function loadFactory(): Promise<Factory> {
    const specifier = './executionRun.js';
    const loaded = await import(specifier).catch((error: unknown) => ({ error }));
    expect('error' in loaded ? loaded.error : null).toBeNull();
    expect(loaded).toHaveProperty('createExecutionRunHostBackendFromTurnOperations');
    return (loaded as Readonly<{
        createExecutionRunHostBackendFromTurnOperations: Factory;
    }>).createExecutionRunHostBackendFromTurnOperations;
}

describe('createExecutionRunHostBackendFromTurnOperations', () => {
    it('dispatches an initial prompt during provisioning and waits for completion', async () => {
        const createExecutionRunHostBackendFromTurnOperations = await loadFactory();
        const operations = createOperations({
            startOrLoadSession: vi.fn(async () => ({ providerSessionId: 'provider-session-1' })),
        });
        const backend = createExecutionRunHostBackendFromTurnOperations({
            createOperations: () => ({ operations }),
        });

        await expect(backend.provisionSession({
            resumeSessionId: ' provider-session-1 ',
            initialPrompt: ' inspect ',
        })).resolves.toEqual({ sessionId: 'provider-session-1' });

        expect(operations.startOrLoadSession).toHaveBeenCalledWith({
            resumeId: 'provider-session-1',
            importHistory: false,
        });
        expect(operations.beginTurnLifecycle).toHaveBeenCalledTimes(1);
        expect(operations.sendTurnPrompt).toHaveBeenCalledWith('inspect');
        expect(operations.waitForTurnCompletion).toHaveBeenCalledWith({ timeoutMs: null });
    });

    it('forwards host actions to the active turn operations', async () => {
        const createExecutionRunHostBackendFromTurnOperations = await loadFactory();
        const operations = createOperations();
        const backend = createExecutionRunHostBackendFromTurnOperations({
            createOperations: () => operations,
        });

        await backend.provisionSession();
        await backend.sendPrompt('runtime-session-1', 'next prompt');
        await backend.sendSteerPrompt?.('runtime-session-1', 'steer prompt');
        await backend.respondToPermission?.('permission-1', true);
        await backend.cancel('runtime-session-1');

        expect(operations.sendTurnPrompt).toHaveBeenCalledWith('next prompt');
        expect(operations.steerInFlightTurn).toHaveBeenCalledWith('steer prompt');
        expect(operations.respondToPermission).toHaveBeenCalledWith('permission-1', true);
        expect(operations.cancelTurn).toHaveBeenCalledTimes(1);
    });

    it('isolates subscriber failures while forwarding runtime messages', async () => {
        const createExecutionRunHostBackendFromTurnOperations = await loadFactory();
        let runtimeHandler: ((message: unknown) => void) | null = null;
        const operations = createOperations({
            subscribeRuntimeEvents: vi.fn((handler: (message: unknown) => void) => {
                runtimeHandler = handler;
                return vi.fn();
            }),
        });
        const backend = createExecutionRunHostBackendFromTurnOperations({
            createOperations: () => operations,
        });
        const received: unknown[] = [];
        backend.subscribeMessages(() => {
            throw new Error('subscriber failed');
        });
        backend.subscribeMessages((message) => {
            received.push(message);
        });

        await backend.provisionSession();
        const message = { type: 'status', status: 'running' };

        expect(() => runtimeHandler?.(message)).not.toThrow();
        expect(received).toEqual([message]);
    });

    it('polls turn completion until activity events report idle', async () => {
        const createExecutionRunHostBackendFromTurnOperations = await loadFactory();
        let runtimeHandler: ((message: unknown) => void) | null = null;
        let waitCalls = 0;
        const operations = createOperations({
            subscribeRuntimeEvents: vi.fn((handler: (message: unknown) => void) => {
                runtimeHandler = handler;
                return vi.fn();
            }),
            waitForTurnCompletion: vi.fn(async () => {
                waitCalls += 1;
                runtimeHandler?.({
                    type: 'status',
                    status: waitCalls === 1 ? 'running' : 'idle',
                });
            }),
        });
        const backend = createExecutionRunHostBackendFromTurnOperations({
            createOperations: () => operations,
            waitForTurnCompletion: {
                mode: 'untilIdle',
                pollIntervalMs: 1,
            },
            diagnostics: { source: 'test-runtime' },
        });

        await backend.provisionSession();
        await backend.sendPrompt('runtime-session-1', 'work');
        await expect(backend.waitForTurnCompletion?.(100)).resolves.toBeUndefined();

        expect(operations.waitForTurnCompletion).toHaveBeenCalledTimes(2);
        await expect(backend.probeTurnLiveness?.('runtime-session-1')).resolves.toMatchObject({
            active: false,
            diagnostics: {
                source: 'test-runtime',
                turnInFlight: false,
            },
        });
    });

    it('reports runtime liveness diagnostics when the operations expose them', async () => {
        const createExecutionRunHostBackendFromTurnOperations = await loadFactory();
        const operations = createOperations();
        const backend = createExecutionRunHostBackendFromTurnOperations({
            createOperations: () => operations,
            readRuntimeLiveness: () => ({
                active: true,
                lastActivityAtMs: 123,
                diagnostics: {
                    source: 'runtime-hook',
                    threadId: 'thread-1',
                },
            }),
        });

        await backend.provisionSession();

        await expect(backend.probeTurnLiveness?.('runtime-session-1')).resolves.toMatchObject({
            active: true,
            lastActivityAtMs: 123,
            diagnostics: {
                source: 'runtime-hook',
                threadId: 'thread-1',
            },
        });
    });

    it('clears prompt bookkeeping when prompt submission fails', async () => {
        const createExecutionRunHostBackendFromTurnOperations = await loadFactory();
        const operations = createOperations({
            sendTurnPrompt: vi.fn(async () => {
                throw new Error('provider rejected prompt');
            }),
        });
        const backend = createExecutionRunHostBackendFromTurnOperations({
            createOperations: () => operations,
        });

        await backend.provisionSession();

        await expect(backend.sendPrompt('runtime-session-1', 'work')).rejects.toThrow(
            'provider rejected prompt',
        );
        await expect(backend.probeTurnLiveness?.('runtime-session-1')).resolves.toMatchObject({
            active: false,
            diagnostics: {
                promptInFlight: false,
                turnInFlight: false,
            },
        });
        await expect(backend.waitForTurnCompletion?.(10)).resolves.toBeUndefined();
    });

    it('disposes operations that finish creating after host disposal', async () => {
        const createExecutionRunHostBackendFromTurnOperations = await loadFactory();
        const creation = createDeferred<TestOperations>();
        const resetComplete = createDeferred<void>();
        const operations = createOperations({
            resetOrDisposeRuntime: vi.fn(async () => {
                await resetComplete.promise;
            }),
        });
        const backend = createExecutionRunHostBackendFromTurnOperations({
            createOperations: () => creation.promise,
        });

        const provision = backend.provisionSession().then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );
        await Promise.resolve();
        const dispose = backend.dispose();
        creation.resolve(operations);
        await flushMicrotasks();

        expect(operations.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
        resetComplete.resolve();
        await expect(dispose).resolves.toBeUndefined();
        await expect(provision).resolves.toMatchObject({ ok: false });
    });
});
