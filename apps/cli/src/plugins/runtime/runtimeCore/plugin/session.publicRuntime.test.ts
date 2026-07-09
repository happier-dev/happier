import type { RuntimeEventV1, RuntimeSendResultV1, SessionRuntimeV1 } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { isRuntimeTurnFailureAlreadySurfaced } from '@/agent/runtime/turns/runtimeTurnOperations';

import { createPublicPluginSessionRuntimePlan } from './session';
import { buildPluginSessionBindingInput } from './sessionLaunch';

type PublicHookRuntimeTestFacet = Readonly<{
    supportsInFlightSteer?: () => boolean;
    applyConfigDeltaInFlight?: (
        delta: Readonly<{ permissionMode: string }>,
    ) => Promise<Readonly<{ status: 'applied' }>>;
    steerPrompt?: (
        prompt: string,
        options?: Readonly<{
            localId?: string | null;
            localIds?: readonly string[];
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>,
    ) => Promise<void>;
    clearTerminalComposer?: (
        request: Readonly<{ sessionId: string; expectedStateAtMs?: number }>,
    ) => Promise<unknown>;
    setOnPromptAcceptedByProvider?: (
        handler: (info: Readonly<{ localIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void,
    ) => void;
    setOnPromptTerminallyRejectedBeforeProvider?: (
        handler: (info: Readonly<{ localIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void,
    ) => void;
}>;

type ObservedPromiseStatus = 'pending' | 'resolved' | 'rejected';

function observePromiseStatus(promise: Promise<unknown>) {
    let status: ObservedPromiseStatus = 'pending';
    let reason: unknown;
    promise.then(
        () => {
            status = 'resolved';
        },
        (error: unknown) => {
            status = 'rejected';
            reason = error;
        },
    );
    return {
        get status() {
            return status;
        },
        get reason() {
            return reason;
        },
    };
}

const credentials: Credentials = {
    token: 'test-token',
    encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
    },
};

function createBackendFixture() {
    return {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: {},
        richDefinition: {
            provenance: 'external',
            definition: {
                providerAgentId: 'claude',
            },
        },
        definition: {
            id: 'acme.sample.backend',
            providerId: 'acme.sample.provider',
            providerAgentId: 'claude',
        },
    } as never;
}

function createProviderFixture() {
    return {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeSpec: {
            title: 'Acme Sample Provider',
        },
        richDefinition: {
            provenance: 'external',
            definition: {
                providerAgentId: 'claude',
            },
        },
        definition: {
            id: 'acme.sample.provider',
            ownedBackendIds: ['acme.sample.backend'],
            providerAgentId: 'claude',
        },
    } as never;
}

function createRuntimeParams() {
    return {
        directory: '/tmp/plugin-backend',
        metadata: {} as never,
        machineId: 'machine-1',
        session: {
            sessionId: 'session-1',
        } as never,
        transcriptSession: {} as never,
        messageBuffer: {} as never,
        mcpServers: {},
        permissionHandler: {} as never,
        getPermissionMode: () => 'default' as const,
        setThinking: () => undefined,
        memoryRecallGuidanceEnabled: false,
    };
}

describe('createPublicPluginSessionRuntimePlan', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('passes resolved MCP servers into public plugin session runtimes', async () => {
        const capturedParams: Array<Readonly<Record<string, unknown>>> = [];
        const runtime: SessionRuntimeV1 = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: { subscribe: () => () => undefined },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            dispose: vi.fn(async () => undefined),
        };
        const resolvedMcpServers = {
            happier: { type: 'stdio', command: 'happier-mcp' },
            repo: { type: 'stdio', command: 'repo-mcp' },
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async (params) => {
                capturedParams.push(params);
                return runtime;
            },
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        await plan.config.createSessionRuntime({
            ...createRuntimeParams(),
            mcpServers: resolvedMcpServers,
        });

        expect(capturedParams[0]?.mcpServers).toEqual(resolvedMcpServers);
    });

    it('preserves pending identity, user-message seq, and provider-acceptance hooks through the public runtime bridge', async () => {
        const acceptedHandler = vi.fn();
        const terminallyRejectedHandler = vi.fn();
        const clearTerminalComposer = vi.fn(async () => ({ ok: true, status: 'cleared', sessionId: 'session-1' }));
        const applyConfigDeltaInFlight = vi.fn(async () => ({ status: 'applied' as const }));
        const setOnPromptAcceptedByProvider = vi.fn();
        const setOnPromptTerminallyRejectedBeforeProvider = vi.fn();
        const runtime: SessionRuntimeV1 & Readonly<{
            clearTerminalComposer: typeof clearTerminalComposer;
            applyConfigDeltaInFlight: typeof applyConfigDeltaInFlight;
            setOnPromptAcceptedByProvider: typeof setOnPromptAcceptedByProvider;
            setOnPromptTerminallyRejectedBeforeProvider: typeof setOnPromptTerminallyRejectedBeforeProvider;
        }> = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: { subscribe: () => () => undefined },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            clearTerminalComposer,
            applyConfigDeltaInFlight,
            setOnPromptAcceptedByProvider,
            setOnPromptTerminallyRejectedBeforeProvider,
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
                providerAcceptancePendingMaterialization: 'commitAtMaterialize',
            }),
        });
        expect(plan.config.userMessageDeliveryWatermarkMode).toBeUndefined();
        expect(plan.config.providerAcceptancePendingMaterialization).toBeUndefined();
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }
        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());
        const nativeRuntime = createdRuntime.nativeRuntime as typeof createdRuntime.nativeRuntime & PublicHookRuntimeTestFacet;

        await createdRuntime.operations.sendTurnPrompt('queued prompt', {
            providerClaimedPendingLocalIds: ['provider-claimed-normal', 'provider-claimed-normal'],
            userMessageSeq: 41,
        });
        await nativeRuntime?.steerPrompt?.('steered prompt', {
            localId: 'local-steer',
            localIds: ['local-steer-extra'],
            providerClaimedPendingLocalIds: ['provider-claimed-steer', 'provider-claimed-steer'],
            userMessageSeq: 42,
            userMessageSeqs: [42, 43],
        });
        await createdRuntime.operations.steerInFlightTurn('in-flight steer', {
            localId: 'local-in-flight',
            providerClaimedPendingLocalIds: ['provider-claimed-in-flight'],
            userMessageSeq: 44,
        });
        nativeRuntime?.setOnPromptAcceptedByProvider?.(acceptedHandler);
        nativeRuntime?.setOnPromptTerminallyRejectedBeforeProvider?.(terminallyRejectedHandler);
        await expect(nativeRuntime?.clearTerminalComposer?.({
            sessionId: 'session-1',
            expectedStateAtMs: 42,
        })).resolves.toEqual({ ok: true, status: 'cleared', sessionId: 'session-1' });
        await expect(nativeRuntime?.applyConfigDeltaInFlight?.({
            permissionMode: 'read-only',
        })).resolves.toEqual({ status: 'applied' });

        expect(runtime.send).toHaveBeenNthCalledWith(
            1,
            { v: 1, text: 'queued prompt' },
            {
                providerClaimedPendingLocalIds: ['provider-claimed-normal'],
                userMessageSeq: 41,
                userMessageSeqs: [41],
            },
        );
        expect(runtime.send).toHaveBeenNthCalledWith(
            2,
            { v: 1, text: 'steered prompt' },
            {
                deliverAs: 'steer',
                localInputId: 'local-steer',
                localInputIds: ['local-steer', 'local-steer-extra'],
                providerClaimedPendingLocalIds: ['provider-claimed-steer'],
                userMessageSeq: 42,
                userMessageSeqs: [42, 43],
            },
        );
        expect(runtime.send).toHaveBeenNthCalledWith(
            3,
            { v: 1, text: 'in-flight steer' },
            {
                deliverAs: 'steer',
                localInputId: 'local-in-flight',
                localInputIds: ['local-in-flight'],
                providerClaimedPendingLocalIds: ['provider-claimed-in-flight'],
                userMessageSeq: 44,
                userMessageSeqs: [44],
            },
        );
        expect(setOnPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
        const publicAcceptedHandler = setOnPromptAcceptedByProvider.mock.calls[0]?.[0];
        expect(typeof publicAcceptedHandler).toBe('function');
        publicAcceptedHandler?.({
            localInputId: 'local-accepted',
            localInputIds: ['local-accepted', 'local-accepted-extra'],
            userMessageSeq: 43,
            userMessageSeqs: [43, 44],
        });
        expect(acceptedHandler).toHaveBeenCalledWith({
            localIds: ['local-accepted', 'local-accepted-extra'],
            userMessageSeq: 43,
            userMessageSeqs: [43, 44],
        });

        expect(setOnPromptTerminallyRejectedBeforeProvider).toHaveBeenCalledTimes(1);
        const publicRejectedHandler = setOnPromptTerminallyRejectedBeforeProvider.mock.calls[0]?.[0];
        expect(typeof publicRejectedHandler).toBe('function');
        publicRejectedHandler?.({
            localInputId: 'local-rejected',
            userMessageSeq: 45,
            userMessageSeqs: [45],
        });
        expect(terminallyRejectedHandler).toHaveBeenCalledWith({
            localIds: ['local-rejected'],
            userMessageSeq: 45,
            userMessageSeqs: [45],
        });
        expect(clearTerminalComposer).toHaveBeenCalledWith({
            sessionId: 'session-1',
            expectedStateAtMs: 42,
        });
        expect(applyConfigDeltaInFlight).toHaveBeenCalledWith({ permissionMode: 'read-only' });
    });

    it('does not synthesize provider acceptance from public runtime send success', async () => {
        const acceptedHandler = vi.fn();
        const runtime: SessionRuntimeV1 = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: { subscribe: () => () => undefined },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());
        const nativeRuntime = createdRuntime.nativeRuntime as typeof createdRuntime.nativeRuntime & PublicHookRuntimeTestFacet;
        nativeRuntime?.setOnPromptAcceptedByProvider?.(acceptedHandler);
        await createdRuntime.operations.sendTurnPrompt('queued prompt', {
            localId: 'local-queued',
            localIds: ['local-queued-extra'],
            userMessageSeq: 41,
            userMessageSeqs: [41, 42],
        });

        expect(acceptedHandler).not.toHaveBeenCalled();
    });

    it('bounds public runtime waits when send was accepted but no terminal event is emitted', async () => {
        vi.useFakeTimers();
        const runtime: SessionRuntimeV1 = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: { subscribe: () => () => undefined },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());
        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.sendTurnPrompt('queued prompt', { userMessageSeq: 41 });

        const waitForCompletion = createdRuntime.operations.waitForTurnCompletion();
        const observed = observePromiseStatus(waitForCompletion);

        await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);

        expect(observed.status).toBe('rejected');
        expect(observed.reason).toBeInstanceOf(Error);
        expect((observed.reason as Error).message).toMatch(
            /Plugin session runtime turn did not complete within 1800000ms/,
        );
    });

    it('starts a fresh public runtime wait after timeout and ignores the timed-out turn terminal event', async () => {
        vi.useFakeTimers();
        let eventHandler: ((event: RuntimeEventV1) => void) | null = null;
        const runtime: SessionRuntimeV1 = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: {
                subscribe(handler) {
                    eventHandler = handler;
                    return () => {
                        if (eventHandler === handler) eventHandler = null;
                    };
                },
            },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());
        const emitRuntimeEvent = (event: RuntimeEventV1): void => {
            const handler = eventHandler;
            if (!handler) throw new Error('expected public runtime event subscription');
            handler(event);
        };

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.sendTurnPrompt('first prompt', { userMessageSeq: 41 });
        emitRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'provider',
        });
        const firstWait = createdRuntime.operations.waitForTurnCompletion();
        const firstObserved = observePromiseStatus(firstWait);
        firstWait.catch(() => undefined);

        await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);

        expect(firstObserved.status).toBe('rejected');

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.sendTurnPrompt('second prompt', { userMessageSeq: 42 });
        const secondWait = createdRuntime.operations.waitForTurnCompletion();
        const secondObserved = observePromiseStatus(secondWait);

        emitRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
        });
        await vi.advanceTimersByTimeAsync(1);

        expect(secondObserved.status).toBe('pending');

        emitRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-2',
            startedBy: 'provider',
        });
        emitRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 4,
            turnId: 'turn-2',
        });

        await expect(secondWait).resolves.toBeUndefined();
    });

    it('waits for a public runtime terminal event instead of treating send success as turn completion', async () => {
        let eventHandler: ((event: RuntimeEventV1) => void) | null = null;
        const runtime: SessionRuntimeV1 = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: {
                subscribe(handler) {
                    eventHandler = handler;
                    return () => {
                        if (eventHandler === handler) eventHandler = null;
                    };
                },
            },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.sendTurnPrompt('queued prompt', { userMessageSeq: 41 });
        let resolvedBeforeTerminalEvent = false;
        const waitForCompletion = createdRuntime.operations.waitForTurnCompletion({ timeoutMs: 50 })
            .then(() => {
                resolvedBeforeTerminalEvent = true;
            });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(resolvedBeforeTerminalEvent).toBe(false);

        const emitRuntimeEvent = (event: RuntimeEventV1): void => {
            const handler = eventHandler;
            if (!handler) throw new Error('expected public runtime event subscription');
            handler(event);
        };

        emitRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'provider',
        });
        emitRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
        });

        await expect(waitForCompletion).resolves.toBeUndefined();
    });

    it('rejects public runtime wait completion when the terminal event is turn-failed', async () => {
        let eventHandler: ((event: RuntimeEventV1) => void) | null = null;
        const runtime: SessionRuntimeV1 = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: {
                subscribe(handler) {
                    eventHandler = handler;
                    return () => {
                        if (eventHandler === handler) eventHandler = null;
                    };
                },
            },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.sendTurnPrompt('queued prompt', { userMessageSeq: 41 });
        let resolvedBeforeTerminalEvent = false;
        const waitForCompletion = createdRuntime.operations.waitForTurnCompletion({ timeoutMs: 50 })
            .then(() => {
                resolvedBeforeTerminalEvent = true;
            });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(resolvedBeforeTerminalEvent).toBe(false);

        const emitRuntimeEvent = (event: RuntimeEventV1): void => {
            const handler = eventHandler;
            if (!handler) throw new Error('expected public runtime event subscription');
            handler(event);
        };

        emitRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            issue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'provider_turn_failed',
                source: 'provider_session_error',
                occurredAt: 2,
                provider: 'pi',
                sanitizedPreview: 'Provider session failed',
            },
        });

        await expect(waitForCompletion).rejects.toThrow(/Provider session failed/);
        const error = await waitForCompletion.catch((caught: unknown) => caught);
        expect(isRuntimeTurnFailureAlreadySurfaced(error)).toBe(true);
    });

    it('rejects custom public runtime wait completion when a turn-failed event was observed', async () => {
        let eventHandler: ((event: RuntimeEventV1) => void) | null = null;
        let resolveCustomWaiter = (): void => {
            throw new Error('expected custom waiter resolver to be initialized');
        };
        const customWaiter = new Promise<void>((resolve) => {
            resolveCustomWaiter = resolve;
        });
        const waitForTurnCompletion = vi.fn(async (_opts?: Readonly<{ timeoutMs?: number | null }>) => {
            await customWaiter;
        });
        const runtime: SessionRuntimeV1 & Readonly<{
            waitForTurnCompletion: typeof waitForTurnCompletion;
        }> = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: {
                subscribe(handler) {
                    eventHandler = handler;
                    return () => {
                        if (eventHandler === handler) eventHandler = null;
                    };
                },
            },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            waitForTurnCompletion,
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.sendTurnPrompt('queued prompt', { userMessageSeq: 41 });
        const waitForCompletion = createdRuntime.operations.waitForTurnCompletion({ timeoutMs: 50 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(waitForTurnCompletion).toHaveBeenCalledWith({ timeoutMs: 50 });

        const emitRuntimeEvent = (event: RuntimeEventV1): void => {
            const handler = eventHandler;
            if (!handler) throw new Error('expected public runtime event subscription');
            handler(event);
        };

        emitRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            issue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'provider_turn_failed',
                source: 'provider_session_error',
                occurredAt: 2,
                provider: 'pi',
                sanitizedPreview: 'Provider session failed',
            },
        });
        resolveCustomWaiter();

        await expect(waitForCompletion).rejects.toThrow(/Provider session failed/);
        const error = await waitForCompletion.catch((caught: unknown) => caught);
        expect(isRuntimeTurnFailureAlreadySurfaced(error)).toBe(true);
    });

    it('bounds custom public runtime wait completion on the real no-options host path', async () => {
        vi.useFakeTimers();
        const waitForTurnCompletion = vi.fn(async (_opts?: Readonly<{ timeoutMs?: number | null }>) => {
            await new Promise(() => undefined);
        });
        const runtime: SessionRuntimeV1 & Readonly<{
            waitForTurnCompletion: typeof waitForTurnCompletion;
        }> = {
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: { subscribe: () => () => undefined },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            waitForTurnCompletion,
            dispose: vi.fn(async () => undefined),
        };

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime: async () => runtime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());

        createdRuntime.operations.beginTurnLifecycle();
        await createdRuntime.operations.sendTurnPrompt('queued prompt', { userMessageSeq: 41 });
        const waitForCompletion = createdRuntime.operations.waitForTurnCompletion();
        const observed = observePromiseStatus(waitForCompletion);
        waitForCompletion.catch(() => undefined);

        await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);

        expect(waitForTurnCompletion).toHaveBeenCalledWith({ timeoutMs: 1800000 });
        expect(observed.status).toBe('rejected');
        expect(observed.reason).toBeInstanceOf(Error);
        expect((observed.reason as Error).message).toMatch(
            /Plugin session runtime turn did not complete within 1800000ms/,
        );
    });

    it('recreates public plugin runtimes after reset and preserves host event and acceptance handlers', async () => {
        const acceptedHandler = vi.fn();
        const eventHandler = vi.fn();
        const createSessionRuntime = vi.fn(async (params): Promise<SessionRuntimeV1> => {
            const eventHandlers = new Set<(event: any) => void>();
            let promptAcceptedHandler: ((info: Readonly<{
                localInputId?: string | null;
                localInputIds?: readonly string[];
                userMessageSeq: number | null;
                userMessageSeqs?: readonly number[];
            }>) => void) | null = null;
            const providerSessionId =
                typeof params.resume === 'string' && params.resume.trim().length > 0
                    ? params.resume.trim()
                    : `provider-session-${createSessionRuntime.mock.calls.length}`;
            return {
                identity: { read: () => ({ providerSessionId }) },
                events: {
                    subscribe(handler) {
                        eventHandlers.add(handler);
                        return () => eventHandlers.delete(handler);
                    },
                },
                send: vi.fn(async (input, options): Promise<RuntimeSendResultV1> => {
                    for (const handler of eventHandlers) {
                        handler({
                            kind: 'message-delta',
                            sessionId: 'session-1',
                            turnId: options?.turnId ?? 'turn',
                            emittedAtMs: 1,
                            delta: { text: input.text },
                        });
                    }
                    promptAcceptedHandler?.({
                        localInputId: options?.localInputId,
                        localInputIds: options?.localInputIds,
                        userMessageSeq: typeof options?.userMessageSeq === 'number' ? options.userMessageSeq : null,
                        userMessageSeqs: options?.userMessageSeqs,
                    });
                    return { status: 'accepted' };
                }),
                setOnPromptAcceptedByProvider(handler) {
                    promptAcceptedHandler = handler;
                },
                dispose: vi.fn(async () => {
                    eventHandlers.clear();
                    promptAcceptedHandler = null;
                }),
            };
        });

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());
        const nativeRuntime = createdRuntime.nativeRuntime as typeof createdRuntime.nativeRuntime & PublicHookRuntimeTestFacet;
        createdRuntime.operations.subscribeRuntimeEvents(eventHandler);
        nativeRuntime?.setOnPromptAcceptedByProvider?.(acceptedHandler);

        await createdRuntime.operations.sendTurnPrompt('first prompt', {
            localId: 'local-first',
            userMessageSeq: 1,
        });
        await createdRuntime.operations.resetOrDisposeRuntime();
        await createdRuntime.operations.startOrLoadSession({ resumeId: 'provider-session-resume' });
        await createdRuntime.operations.sendTurnPrompt('second prompt', {
            localId: 'local-second',
            userMessageSeq: 2,
        });

        expect(createSessionRuntime).toHaveBeenCalledTimes(2);
        expect(createSessionRuntime.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            resume: 'provider-session-resume',
        }));
        expect(eventHandler).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'message-delta',
            delta: { text: 'second prompt' },
        }));
        expect(acceptedHandler).toHaveBeenCalledWith({
            localIds: ['local-second'],
            userMessageSeq: 2,
            userMessageSeqs: [2],
        });
    });

    it('fails closed when a recreated runtime drops a registered provider-acceptance seam', async () => {
        const acceptedHandler = vi.fn();
        const createSessionRuntime = vi.fn(async (): Promise<SessionRuntimeV1> => {
            if (createSessionRuntime.mock.calls.length === 1) {
                let promptAcceptedHandler: ((info: Readonly<{
                    localInputId?: string | null;
                    userMessageSeq: number | null;
                }>) => void) | null = null;
                return {
                    identity: { read: () => ({ providerSessionId: 'provider-session-initial' }) },
                    events: { subscribe: () => () => undefined },
                    send: vi.fn(async (input, options): Promise<RuntimeSendResultV1> => {
                        promptAcceptedHandler?.({
                            localInputId: options?.localInputId,
                            userMessageSeq: typeof options?.userMessageSeq === 'number' ? options.userMessageSeq : null,
                        });
                        return { status: 'accepted' };
                    }),
                    setOnPromptAcceptedByProvider(handler) {
                        promptAcceptedHandler = handler;
                    },
                    dispose: vi.fn(async () => undefined),
                };
            }

            return {
                identity: { read: () => ({ providerSessionId: 'provider-session-recreated' }) },
                events: { subscribe: () => () => undefined },
                send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
                dispose: vi.fn(async () => undefined),
            };
        });

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());
        const nativeRuntime = createdRuntime.nativeRuntime as typeof createdRuntime.nativeRuntime & PublicHookRuntimeTestFacet;

        nativeRuntime?.setOnPromptAcceptedByProvider?.(acceptedHandler);
        await createdRuntime.operations.sendTurnPrompt('initial prompt', {
            localId: 'local-initial',
            userMessageSeq: 1,
        });
        expect(acceptedHandler).toHaveBeenCalledWith({
            localIds: ['local-initial'],
            userMessageSeq: 1,
            userMessageSeqs: [1],
        });

        await createdRuntime.operations.resetOrDisposeRuntime();
        await expect(
            createdRuntime.operations.startOrLoadSession({ resumeId: 'provider-session-recreated' }),
        ).rejects.toThrow(/provider-acceptance seam/);
    });

    it('keeps safe optional public runtime capabilities live when a recreated runtime adds them', async () => {
        const respondToPermission = vi.fn(async () => ({ delivered: true }) as const);
        const rejectedHandler = vi.fn();
        const clearTerminalComposer = vi.fn(async () => ({
            ok: true,
            status: 'cleared',
            sessionId: 'session-1',
        }));
        const createSessionRuntime = vi.fn(async (): Promise<SessionRuntimeV1> => {
            if (createSessionRuntime.mock.calls.length === 1) {
                return {
                    identity: { read: () => ({ providerSessionId: 'provider-session-initial' }) },
                    events: { subscribe: () => () => undefined },
                    send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
                    dispose: vi.fn(async () => undefined),
                };
            }

            let terminallyRejectedHandler: ((info: Readonly<{
                localInputId?: string | null;
                localInputIds?: readonly string[];
                userMessageSeq: number | null;
                userMessageSeqs?: readonly number[];
            }>) => void) | null = null;
            const runtime: SessionRuntimeV1 & Readonly<{
                supportsInFlightSteer: () => boolean;
                clearTerminalComposer: typeof clearTerminalComposer;
            }> = {
                identity: { read: () => ({ providerSessionId: 'provider-session-recreated' }) },
                events: { subscribe: () => () => undefined },
                send: vi.fn(async (_input, options): Promise<RuntimeSendResultV1> => {
                    terminallyRejectedHandler?.({
                        localInputId: options?.localInputId,
                        localInputIds: options?.localInputIds,
                        userMessageSeq: typeof options?.userMessageSeq === 'number' ? options.userMessageSeq : null,
                        userMessageSeqs: options?.userMessageSeqs,
                    });
                    return { status: 'accepted' };
                }),
                permissions: {
                    capability: 'responds',
                    respond: respondToPermission,
                },
                supportsInFlightSteer: () => true,
                setOnPromptTerminallyRejectedBeforeProvider(handler) {
                    terminallyRejectedHandler = handler;
                },
                clearTerminalComposer,
                dispose: vi.fn(async () => undefined),
            };
            return runtime;
        });

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        const createdRuntime = await plan.config.createSessionRuntime(createRuntimeParams());
        const nativeRuntime = createdRuntime.nativeRuntime as typeof createdRuntime.nativeRuntime & PublicHookRuntimeTestFacet;

        expect(createdRuntime.operations.permissionCapability).toBeUndefined();
        expect(typeof nativeRuntime?.setOnPromptTerminallyRejectedBeforeProvider).toBe('function');
        expect(typeof nativeRuntime?.clearTerminalComposer).toBe('function');
        nativeRuntime?.setOnPromptTerminallyRejectedBeforeProvider?.(rejectedHandler);

        await createdRuntime.operations.resetOrDisposeRuntime();
        await createdRuntime.operations.startOrLoadSession({ resumeId: 'provider-session-recreated' });

        expect(createSessionRuntime).toHaveBeenCalledTimes(2);
        expect(createdRuntime.operations.permissionCapability).toBe('responds');
        expect(nativeRuntime?.supportsInFlightSteer?.()).toBe(true);
        await expect(createdRuntime.operations.respondToPermission?.('permission-1', true)).resolves.toEqual({
            delivered: true,
        });

        await createdRuntime.operations.sendTurnPrompt('after recreate', {
            localId: 'local-after',
            userMessageSeq: 9,
        });
        await expect(nativeRuntime?.clearTerminalComposer?.({
            sessionId: 'session-1',
            expectedStateAtMs: 123,
        })).resolves.toEqual({
            ok: true,
            status: 'cleared',
            sessionId: 'session-1',
        });

        expect(respondToPermission).toHaveBeenCalledWith({
            requestId: 'permission-1',
            approved: true,
        });
        expect(rejectedHandler).toHaveBeenCalledWith({
            localIds: ['local-after'],
            userMessageSeq: 9,
            userMessageSeqs: [9],
        });
        expect(clearTerminalComposer).toHaveBeenCalledWith({
            sessionId: 'session-1',
            expectedStateAtMs: 123,
        });
    });

    it('passes session environment variables to public plugin runtimes', async () => {
        const createSessionRuntime = vi.fn(async (): Promise<SessionRuntimeV1> => ({
            identity: { read: () => ({ providerSessionId: 'provider-session-1' }) },
            events: { subscribe: () => () => undefined },
            send: vi.fn(async (): Promise<RuntimeSendResultV1> => ({ status: 'accepted' })),
            dispose: vi.fn(async () => undefined),
        }));

        const plan = await createPublicPluginSessionRuntimePlan({
            backend: createBackendFixture(),
            provider: createProviderFixture(),
            createSessionRuntime,
            sessionInput: buildPluginSessionBindingInput({
                credentials,
                directory: '/tmp/plugin-backend',
                environmentVariables: {
                    HAPPIER_E2E_FAKE_AGY_LOG: '/tmp/fake-agy.jsonl',
                    EMPTY: '',
                },
            }),
        });
        if (typeof plan.config.createSessionRuntime !== 'function') {
            throw new Error('expected public plugin host plan to create a session runtime');
        }

        await plan.config.createSessionRuntime(createRuntimeParams());

        expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
            env: {
                HAPPIER_E2E_FAKE_AGY_LOG: '/tmp/fake-agy.jsonl',
                EMPTY: '',
            },
        }));
    });
});
