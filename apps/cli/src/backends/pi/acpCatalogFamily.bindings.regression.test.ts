import { describe, expect, it, vi } from 'vitest';

type AgentBackendLike = Readonly<{
    startSession: (initialPrompt?: string) => Promise<{ sessionId: string }>;
    readResumeSupport: (opts?: Readonly<{ captureReplay?: boolean }>) => Promise<boolean>;
    provisionSession: (opts?: Readonly<{ initialPrompt?: string; resumeSessionId?: string }>) => Promise<{ sessionId: string }>;
    sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
    cancel: (sessionId: string) => Promise<void>;
    onMessage: (handler: (msg: unknown) => void) => void;
    offMessage?: (handler: (msg: unknown) => void) => void;
    subscribeMessages: (handler: (msg: unknown) => void) => () => void;
    dispose: () => Promise<void>;
    waitForResponseComplete?: (timeoutMs: number) => Promise<void>;
    waitForTurnCompletion?: (timeoutMs: number) => Promise<void>;
}>;

type RuntimeBindingsLike = Readonly<{
    createExecutionRunBackend: (params: unknown) => AgentBackendLike;
    createSessionRuntime: (params: unknown) => Promise<unknown>;
}>;

async function resolveBindings(agent: Readonly<{ getBindings?: () => Promise<unknown> }>, providerId: string): Promise<RuntimeBindingsLike> {
    const getBindings = agent.getBindings;
    expect(getBindings).toBeTypeOf('function');

    const bindingFactoryOrCreator = await getBindings!.call(agent);
    expect(bindingFactoryOrCreator).toBeTypeOf('function');

    const bindingParams = {
        backend: {
            id: providerId,
            providerId,
            source: 'built_in',
            definition: { kindVersion: 1, id: providerId, providerId },
        },
        provider: {
            id: providerId,
            source: 'built_in',
            definition: { kindVersion: 1, id: providerId, ownedBackendIds: [providerId] },
        },
        executionSurfaces: {
            terminalRuntime: null,
            directSessions: null,
            attach: null,
            sessionHandoff: null,
        },
    };

    const maybeResolved = await (bindingFactoryOrCreator as (params?: unknown) => unknown)();
    const bindingFactory =
        typeof maybeResolved === 'function'
            ? maybeResolved as (params: unknown) => unknown
            : bindingFactoryOrCreator as (params: unknown) => unknown;
    const resolvedBinding =
        typeof maybeResolved === 'function'
            ? await bindingFactory(bindingParams)
            : maybeResolved;

    const bindings = (
        resolvedBinding &&
        typeof resolvedBinding === 'object' &&
        'bindings' in resolvedBinding
    )
        ? (resolvedBinding as { bindings: RuntimeBindingsLike }).bindings
        : resolvedBinding as RuntimeBindingsLike;

    expect(bindings.createExecutionRunBackend).toBeTypeOf('function');
    expect(bindings.createSessionRuntime).toBeTypeOf('function');
    return bindings;
}

const createdAcpBackendOptions: unknown[] = [];
const createdPiRpcBackendOptions: unknown[] = [];
const sessionRunnerCalls: Array<{ id: string; params: unknown }> = [];

vi.mock('@/backends/pi/bindings/session', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/backends/pi/bindings/session')>()),
    runPiSessionRuntime: vi.fn(async (params: unknown) => {
        sessionRunnerCalls.push({ id: 'pi', params });
    }),
}));

vi.mock('@/backends/qwen/bindings/session', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/backends/qwen/bindings/session')>()),
    runQwenSessionRuntime: vi.fn(async (params: unknown) => {
        sessionRunnerCalls.push({ id: 'qwen', params });
    }),
}));

vi.mock('@/backends/kimi/bindings/session', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/backends/kimi/bindings/session')>()),
    runKimiSessionRuntime: vi.fn(async (params: unknown) => {
        sessionRunnerCalls.push({ id: 'kimi', params });
    }),
}));

vi.mock('@/backends/kilo/bindings/session', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/backends/kilo/bindings/session')>()),
    runKiloSessionRuntime: vi.fn(async (params: unknown) => {
        sessionRunnerCalls.push({ id: 'kilo', params });
    }),
}));

vi.mock('@/backends/copilot/bindings/session', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/backends/copilot/bindings/session')>()),
    runCopilotSessionRuntime: vi.fn(async (params: unknown) => {
        sessionRunnerCalls.push({ id: 'copilot', params });
    }),
}));

vi.mock('@/backends/auggie/bindings/session', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/backends/auggie/bindings/session')>()),
    runAuggieSessionRuntime: vi.fn(async (params: unknown) => {
        sessionRunnerCalls.push({ id: 'auggie', params });
    }),
}));

vi.mock('@/agent/acp/AcpBackend', () => {
    class MockAcpBackend implements AgentBackendLike {
        startSession = vi.fn(async () => ({ sessionId: 'mock-session-1' }));
        readResumeSupport = vi.fn(async () => true);
        provisionSession = vi.fn(async () => ({ sessionId: 'mock-session-1' }));
        sendPrompt = vi.fn(async () => undefined);
        cancel = vi.fn(async () => undefined);
        onMessage = vi.fn((_handler: (msg: unknown) => void) => {});
        subscribeMessages = vi.fn((_handler: (msg: unknown) => void) => () => undefined);
        dispose = vi.fn(async () => undefined);
        waitForResponseComplete = vi.fn(async () => undefined);
        waitForTurnCompletion = vi.fn(async () => undefined);

        constructor(opts: unknown) {
            createdAcpBackendOptions.push(opts);
        }
    }

    return { AcpBackend: MockAcpBackend };
});

vi.mock('@/backends/pi/rpc/PiRpcBackend', () => {
    class MockPiRpcBackend implements AgentBackendLike {
        startSession = vi.fn(async () => ({ sessionId: 'mock-session-1' }));
        readResumeSupport = vi.fn(async () => true);
        provisionSession = vi.fn(async () => ({ sessionId: 'mock-session-1' }));
        sendPrompt = vi.fn(async () => undefined);
        cancel = vi.fn(async () => undefined);
        onMessage = vi.fn((_handler: (msg: unknown) => void) => {});
        subscribeMessages = vi.fn((_handler: (msg: unknown) => void) => () => undefined);
        dispose = vi.fn(async () => undefined);
        waitForResponseComplete = vi.fn(async () => undefined);
        waitForTurnCompletion = vi.fn(async () => undefined);

        constructor(opts: unknown) {
            createdPiRpcBackendOptions.push(opts);
        }
    }

    return { PiRpcBackend: MockPiRpcBackend };
});

vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
    requireProviderCliLaunchSpec: vi.fn((_agentId: string) => ({
        command: '/usr/bin/env',
        args: [],
    })),
}));

const providers = Object.freeze([
    { id: 'pi', expectsAcpBackend: false, importAgent: async () => (await import('@/backends/pi')).agent },
    { id: 'qwen', expectsAcpBackend: true, importAgent: async () => (await import('@/backends/qwen')).agent },
    { id: 'kimi', expectsAcpBackend: true, importAgent: async () => (await import('@/backends/kimi')).agent },
    { id: 'kilo', expectsAcpBackend: true, importAgent: async () => (await import('@/backends/kilo')).agent },
    { id: 'copilot', expectsAcpBackend: true, importAgent: async () => (await import('@/backends/copilot')).agent },
    { id: 'auggie', expectsAcpBackend: true, importAgent: async () => (await import('@/backends/auggie')).agent },
] as const);

describe('ACP catalog family bindings regressions', () => {
    it('emits runtime identity events for each ACP execution-run-capable provider', async () => {
        for (const provider of providers) {
            createdAcpBackendOptions.length = 0;
            createdPiRpcBackendOptions.length = 0;
            const agent = await provider.importAgent();
            const bindings = await resolveBindings(
                agent as { getBindings?: () => Promise<unknown> },
                provider.id,
            );

            const backend = bindings.createExecutionRunBackend({
                cwd: process.cwd(),
                backendId: provider.id,
                permissionMode: 'read_only',
                accountSettings: null,
                start: { intent: 'review', retentionPolicy: 'ephemeral' },
            });

            expect(backend.readResumeSupport).toBeTypeOf('function');
            expect(backend.provisionSession).toBeTypeOf('function');
            expect(backend.subscribeMessages).toBeTypeOf('function');
            expect((backend as unknown as { startSession?: unknown }).startSession).toBeUndefined();
            expect((backend as unknown as { onMessage?: unknown }).onMessage).toBeUndefined();

            const events: Array<{ name: string; payload: unknown }> = [];
            const unsubscribe = backend.subscribeMessages((msg) => {
                const message = msg as { type?: string; name?: string; payload?: unknown };
                if (message?.type === 'event' && typeof message.name === 'string') {
                    events.push({ name: message.name, payload: message.payload });
                }
            });

            await expect(backend.provisionSession({ initialPrompt: 'hello' })).resolves.toMatchObject({
                sessionId: expect.any(String),
            });
            unsubscribe();
            expect(events.map((event) => event.name)).toEqual(expect.arrayContaining(['runtime.descriptor', 'runtime.capabilities']));
            expect(createdAcpBackendOptions.length).toBe(provider.expectsAcpBackend ? 1 : 0);
            expect(createdPiRpcBackendOptions.length).toBe(provider.id === 'pi' ? 1 : 0);
        }
    });
});

describe('ACP catalog family bindings (sessions)', () => {
    it('constructs a host-owned session runtime plan for each ACP execution-run-capable provider', async () => {
        for (const provider of providers) {
            sessionRunnerCalls.length = 0;
            const agent = await provider.importAgent();
            const bindings = await resolveBindings(
                agent as { getBindings?: () => Promise<unknown> },
                provider.id,
            );

            const sessionParams = {
                credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
                marker: provider.id,
            };
            await expect(bindings.createSessionRuntime(sessionParams)).resolves.toEqual(expect.objectContaining({
                    kind: 'hostSessionRuntimePlan',
                    providerId: provider.id,
                    opts: sessionParams,
                    config: expect.objectContaining({
                        createSessionRuntime: expect.any(Function),
                    }),
                }));
            expect(sessionRunnerCalls).toEqual([]);
        }
    });
});
