import { describe, expect, it, vi } from 'vitest';

import type {
    RuntimeCancelRequestV1,
    RuntimeEventV1,
    RuntimeInputPayloadV1,
    RuntimePermissionResponseOutcomeV1,
    RuntimeSendOptionsV1,
    RuntimeSendResultV1,
    SessionRuntimeV1,
} from './session.js';

const COLD_PUBLIC_INDEX_IMPORT_TIMEOUT_MS = 30_000;

type TestFactory = (options: Readonly<{
    createSessionRuntime: () => SessionRuntimeV1 | Promise<SessionRuntimeV1>;
}>) => Readonly<{
    provisionSession(opts?: Readonly<{
        initialPrompt?: string;
        resumeSessionId?: string;
        captureReplay?: boolean;
    }>): Promise<Readonly<{ sessionId: string }>>;
    sendPrompt(
        sessionId: string,
        prompt: string,
        meta?: RuntimeSendOptionsV1,
    ): Promise<void>;
    sendSteerPrompt?(sessionId: string, prompt: string, meta?: RuntimeSendOptionsV1): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    subscribeMessages(handler: (message: unknown) => void): () => void;
    respondToPermission?(requestId: string, approved: boolean): Promise<RuntimePermissionResponseOutcomeV1>;
    permissionCapability?: SessionRuntimeV1['permissions'] extends infer TPermissions
        ? NonNullable<TPermissions>['capability']
        : never;
    dispose(): Promise<void>;
}>;

type TestRuntime = SessionRuntimeV1 & Readonly<{
    emitRuntimeEvent(event: RuntimeEventV1): void;
    unsubscribeRuntimeEvents: ReturnType<typeof vi.fn>;
}>;

async function loadPublicFactory(): Promise<TestFactory> {
    const loaded = await import('../index.js');
    expect(loaded).toHaveProperty('createExecutionRunHostBackendFromSessionRuntime');
    return (loaded as Readonly<{
        createExecutionRunHostBackendFromSessionRuntime: TestFactory;
    }>).createExecutionRunHostBackendFromSessionRuntime;
}

function createRuntime(
    overrides: Partial<SessionRuntimeV1> = {},
): TestRuntime {
    let runtimeHandler: ((event: RuntimeEventV1) => void) | null = null;
    const unsubscribeRuntimeEvents = vi.fn(() => {
        runtimeHandler = null;
    });
    const send = vi.fn(
        async (_input: RuntimeInputPayloadV1, _options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1> => ({
            status: 'accepted',
            turnId: 'turn-1',
        }),
    );
    return {
        identity: {
            read: () => ({ providerSessionId: 'provider-session-1' }),
        },
        events: {
            subscribe: vi.fn((handler: (event: RuntimeEventV1) => void) => {
                runtimeHandler = handler;
                return unsubscribeRuntimeEvents;
            }),
        },
        send,
        cancel: vi.fn(async (_request: RuntimeCancelRequestV1) => ({ status: 'cancelled' })),
        dispose: vi.fn(async () => undefined),
        emitRuntimeEvent(event: RuntimeEventV1) {
            runtimeHandler?.(event);
        },
        unsubscribeRuntimeEvents,
        ...overrides,
    };
}

describe('createExecutionRunHostBackendFromSessionRuntime', () => {
    it('provisions from the public identity facet and sends an initial prompt through SessionRuntimeV1', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime();
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
        });

        await expect(backend.provisionSession({
            resumeSessionId: ' provider-session-1 ',
            initialPrompt: ' inspect ',
        })).resolves.toEqual({ sessionId: 'provider-session-1' });

        expect(runtime.events.subscribe).toHaveBeenCalledTimes(1);
        expect(runtime.send).toHaveBeenCalledWith(
            { v: 1, text: 'inspect' },
            undefined,
        );
    }, COLD_PUBLIC_INDEX_IMPORT_TIMEOUT_MS);

    it('passes resume context to the session runtime factory before reading identity', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime({
            identity: {
                read: () => ({ providerSessionId: 'resume-session-1' }),
            },
        });
        const createSessionRuntime = vi.fn(() => runtime);
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime,
        });

        await expect(backend.provisionSession({ resumeSessionId: ' resume-session-1 ' })).resolves.toEqual({
            sessionId: 'resume-session-1',
        });

        expect(createSessionRuntime).toHaveBeenCalledWith({
            resumeSessionId: 'resume-session-1',
        });
    });

    it('delegates turn completion waits to the runtime-specific wait hook', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime();
        const waitForRuntimeTurnCompletion = vi.fn(async () => undefined);
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
            waitForRuntimeTurnCompletion,
        });

        await expect(backend.provisionSession({
            initialPrompt: 'inspect',
        })).resolves.toEqual({ sessionId: 'provider-session-1' });

        expect(waitForRuntimeTurnCompletion).toHaveBeenCalledWith(runtime, null);
    });

    it('emits host model-output messages for runtime assistant text events', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime();
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
        });
        const messages: unknown[] = [];
        const unsubscribe = backend.subscribeMessages((message) => {
            messages.push(message);
        });

        await backend.provisionSession();
        runtime.emitRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'provider-session-1',
            turnId: 'turn-1',
            emittedAtMs: Date.now(),
            delta: { text: 'Hello ' },
        });
        runtime.emitRuntimeEvent({
            kind: 'transcript-agent-message-committed',
            sessionId: 'provider-session-1',
            emittedAtMs: Date.now(),
            provider: 'opencode',
            localId: 'message-1',
            body: {
                type: 'message',
                message: 'Hello marker',
            },
        });
        unsubscribe();

        expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'message-delta' }),
            { type: 'model-output', textDelta: 'Hello ' },
            expect.objectContaining({ kind: 'transcript-agent-message-committed' }),
            { type: 'model-output', fullText: 'Hello marker' },
        ]));
    }, 30_000);

    it('routes steer prompts through the public deliverAs mode with full pending identity', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime();
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
        });

        await backend.provisionSession();
        await backend.sendSteerPrompt?.('provider-session-1', 'steer prompt', {
            localInputId: 'local-steer',
            localInputIds: ['local-steer', 'local-steer-extra'],
            providerClaimedPendingLocalIds: ['provider-claimed-steer'],
            userMessageSeq: 42,
            userMessageSeqs: [42, 43],
        });

        expect(runtime.send).toHaveBeenLastCalledWith(
            { v: 1, text: 'steer prompt' },
            {
                deliverAs: 'steer',
                localInputId: 'local-steer',
                localInputIds: ['local-steer', 'local-steer-extra'],
                providerClaimedPendingLocalIds: ['provider-claimed-steer'],
                userMessageSeq: 42,
                userMessageSeqs: [42, 43],
            },
        );
    }, COLD_PUBLIC_INDEX_IMPORT_TIMEOUT_MS);

    it('routes normal prompts with full pending identity metadata', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime();
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
        });

        await backend.provisionSession();
        await backend.sendPrompt('provider-session-1', 'normal prompt', {
            localInputId: 'local-normal',
            localInputIds: ['local-normal', 'local-normal-extra'],
            providerClaimedPendingLocalIds: ['provider-claimed-normal'],
            userMessageSeq: 43,
            userMessageSeqs: [43, 44],
        });

        expect(runtime.send).toHaveBeenLastCalledWith(
            { v: 1, text: 'normal prompt' },
            {
                localInputId: 'local-normal',
                localInputIds: ['local-normal', 'local-normal-extra'],
                providerClaimedPendingLocalIds: ['provider-claimed-normal'],
                userMessageSeq: 43,
                userMessageSeqs: [43, 44],
            },
        );
    }, COLD_PUBLIC_INDEX_IMPORT_TIMEOUT_MS);

    it('drops non-integer and negative user message seq metadata before public runtime delivery', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime();
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
        });

        await backend.provisionSession();
        await backend.sendPrompt('provider-session-1', 'fractional prompt', { userMessageSeq: 4.5 });
        await backend.sendSteerPrompt?.('provider-session-1', 'negative steer', { userMessageSeq: -1 });

        expect(runtime.send).toHaveBeenNthCalledWith(
            1,
            { v: 1, text: 'fractional prompt' },
            undefined,
        );
        expect(runtime.send).toHaveBeenNthCalledWith(
            2,
            { v: 1, text: 'negative steer' },
            { deliverAs: 'steer' },
        );
    }, COLD_PUBLIC_INDEX_IMPORT_TIMEOUT_MS);

    it('does not create a session runtime for a cancel-before-start request', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const createSessionRuntime = vi.fn(() => createRuntime());
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime,
        });

        await expect(backend.cancel('provider-session-1')).resolves.toBeUndefined();

        expect(createSessionRuntime).not.toHaveBeenCalled();
    });

    it('cancels an in-flight session runtime after startup resolves', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        let resolveRuntime!: (runtime: TestRuntime) => void;
        const runtimePromise = new Promise<TestRuntime>((resolve) => {
            resolveRuntime = resolve;
        });
        const runtime = createRuntime();
        const createSessionRuntime = vi.fn(async () => await runtimePromise);
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime,
        });

        const provisionSession = backend.provisionSession();
        await Promise.resolve();
        const cancel = backend.cancel('provider-session-1');

        await Promise.resolve();
        expect(runtime.cancel).not.toHaveBeenCalled();
        resolveRuntime(runtime);

        await expect(cancel).resolves.toBeUndefined();
        await expect(provisionSession).resolves.toEqual({ sessionId: 'provider-session-1' });
        expect(createSessionRuntime).toHaveBeenCalledTimes(1);
        expect(runtime.cancel).toHaveBeenCalledTimes(1);
        expect(runtime.cancel).toHaveBeenCalledWith({ reason: 'user' });
    });

    it('disposes the session runtime idempotently for concurrent and repeated disposal', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const runtime = createRuntime();
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
        });

        await backend.provisionSession();
        await expect(Promise.all([backend.dispose(), backend.dispose()])).resolves.toEqual([undefined, undefined]);
        await expect(backend.dispose()).resolves.toBeUndefined();

        expect(runtime.unsubscribeRuntimeEvents).toHaveBeenCalledTimes(1);
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    it('uses the declared permission response capability instead of method-presence probing', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const respond = vi.fn(async () => ({ delivered: true as const }));
        const runtime = createRuntime({
            permissions: {
                capability: 'responds',
                respond,
            },
        });
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime: () => runtime,
        });

        await backend.provisionSession();
        expect(backend.permissionCapability).toBe('responds');
        await backend.respondToPermission?.('permission-1', true);

        expect(respond).toHaveBeenCalledWith({
            requestId: 'permission-1',
            approved: true,
        });
    });

    it('does not create a session runtime for a permission response before session provisioning', async () => {
        const createExecutionRunHostBackendFromSessionRuntime = await loadPublicFactory();
        const createSessionRuntime = vi.fn(() => createRuntime());
        const backend = createExecutionRunHostBackendFromSessionRuntime({
            createSessionRuntime,
        });

        await expect(backend.respondToPermission?.('permission-1', false)).resolves.toEqual({
            delivered: false,
            reason: 'no_active_session',
        });

        expect(createSessionRuntime).not.toHaveBeenCalled();
    });
});
