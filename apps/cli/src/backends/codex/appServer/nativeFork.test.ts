import { describe, expect, it, vi } from 'vitest';

import { createCodexAppServerRpcError } from './appServerCompatibility';
import type { DisposableCodexAppServerClient } from './client/createCodexAppServerClient';
import { forkCodexAppServerConversationNative } from './nativeFork';

function createClientDouble(requestImpl: DisposableCodexAppServerClient['request']): DisposableCodexAppServerClient {
    return {
        request: requestImpl,
        notify: vi.fn(async () => {}),
        registerRequestHandler: vi.fn(() => () => {}),
        registerNotificationHandler: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
        dispose: vi.fn(async () => {}),
    };
}

describe('forkCodexAppServerConversationNative', () => {
    it('reports native fork unsupported without creating a client when the parent session id is blank', async () => {
        const createClient = vi.fn(async () => createClientDouble(vi.fn()));

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: '   ',
            }, { createClient }),
        ).resolves.toEqual({ type: 'unsupported' });

        expect(createClient).not.toHaveBeenCalled();
    });

    it('reports initialize failure before fork dispatch without sending either fork method', async () => {
        const createClient = vi.fn(async () => {
            throw new Error('initialize timed out');
        });

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, { createClient }),
        ).resolves.toMatchObject({
            type: 'failed_before_dispatch',
            error: expect.objectContaining({ message: 'initialize timed out' }),
        });

        expect(createClient).toHaveBeenCalledTimes(1);
    });

    it('creates a fresh fork client with an initialize request that has no local hard timeout', async () => {
        const client = createClientDouble(vi.fn(async () => ({ threadId: 'forked-thread' })));
        const createClient = vi.fn(async () => client);

        await forkCodexAppServerConversationNative({
            directory: '/repo',
            parentCodexSessionId: 'parent-thread',
        }, { createClient });

        expect(createClient).toHaveBeenCalledWith({
            cwd: '/repo',
            processEnv: undefined,
            initializeRequestOptions: { timeoutMs: null },
        });
    });

    it('prefers thread/fork and reads nested thread ids from the response payload', async () => {
        const request = vi.fn(async () => ({ thread: { id: ' forked-thread ' } }));
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: ' parent-thread ',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ type: 'success', vendorSessionId: 'forked-thread' });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
            'thread/fork',
            { threadId: 'parent-thread', persistExtendedHistory: true },
            { timeoutMs: null },
        );
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('falls back to conversation/fork only after a definitive thread/fork method-not-found response', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValueOnce(createCodexAppServerRpcError({
                method: 'thread/fork',
                code: -32601,
                message: 'method not found',
            }))
            .mockResolvedValueOnce({ id: 'compat-thread' });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ type: 'success', vendorSessionId: 'compat-thread' });

        expect(request).toHaveBeenNthCalledWith(
            1,
            'thread/fork',
            { threadId: 'parent-thread', persistExtendedHistory: true },
            { timeoutMs: null },
        );
        expect(request).toHaveBeenNthCalledWith(
            2,
            'conversation/fork',
            { threadId: 'parent-thread', persistExtendedHistory: true },
            { timeoutMs: null },
        );
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it.each([
        [
            'another request',
            createCodexAppServerRpcError({
                method: 'conversation/fork',
                code: -32601,
                message: 'method not found',
            }),
        ],
        [
            'a non-application failure',
            Object.assign(new Error('transport rejected the request'), {
                name: 'PluginExecClientError',
                code: -32601,
                method: 'thread/fork',
            }),
        ],
    ])('does not alias a method-not-found code attributed to %s', async (_label, failure) => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValueOnce(failure);
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toMatchObject({ type: 'indeterminate_after_dispatch' });

        expect(request).toHaveBeenCalledTimes(1);
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not alias a malformed thread/fork success and disposes after it settles', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockResolvedValueOnce({ threadId: '   ' });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toMatchObject({ type: 'indeterminate_after_dispatch' });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
            'thread/fork',
            { threadId: 'parent-thread', persistExtendedHistory: true },
            { timeoutMs: null },
        );
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('waits for an ambiguous fork response to settle before disposing the client', async () => {
        let resolveRequest: ((value: unknown) => void) | null = null;
        let markRequestStarted: (() => void) | null = null;
        const requestStarted = new Promise<void>((resolve) => {
            markRequestStarted = resolve;
        });
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockImplementationOnce(() => new Promise<unknown>((resolve) => {
                resolveRequest = resolve;
                markRequestStarted?.();
            }));
        const client = createClientDouble(request);

        const nativeFork = forkCodexAppServerConversationNative({
            directory: '/repo',
            parentCodexSessionId: 'parent-thread',
        }, {
            createClient: async () => client,
        });

        await requestStarted;
        expect(client.dispose).not.toHaveBeenCalled();

        const settle = resolveRequest;
        if (!settle) throw new Error('Native fork request did not start');
        settle({ threadId: '' });

        await expect(nativeFork).resolves.toMatchObject({ type: 'indeterminate_after_dispatch' });
        expect(request).toHaveBeenCalledTimes(1);
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['timeout', new Error('Codex app-server request thread/fork timed out after 250ms')],
        ['abort', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })],
        ['transport loss', new Error('Codex app-server exited before completing the request')],
        ['untyped method error', new Error('method not found')],
    ])('does not alias or replay after a %s fork failure and disposes after settlement', async (_label, failure) => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValueOnce(failure);
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toMatchObject({ type: 'indeterminate_after_dispatch' });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
            'thread/fork',
            { threadId: 'parent-thread', persistExtendedHistory: true },
            { timeoutMs: null },
        );
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('emits structured diagnostics for the only alias-compatible failure and a malformed reply', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValueOnce(createCodexAppServerRpcError({
                method: 'thread/fork',
                code: -32601,
                message: 'method not found',
            }))
            .mockResolvedValueOnce({ threadId: '' });
        const client = createClientDouble(request);
        const diagnosticsLogger = { debug: vi.fn() };

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
                logger: diagnosticsLogger,
            }),
        ).resolves.toMatchObject({ type: 'indeterminate_after_dispatch' });

        expect(diagnosticsLogger.debug).toHaveBeenCalledWith(
            '[CodexAppServerNativeFork] method failed',
            expect.objectContaining({
                method: 'thread/fork',
                hasParentCodexSessionId: true,
                errorMessage: 'method not found',
                fallbackResult: 'try_alias_after_unsupported',
            }),
        );
        expect(diagnosticsLogger.debug).toHaveBeenCalledWith(
            '[CodexAppServerNativeFork] method returned no forked thread id',
            expect.objectContaining({
                method: 'conversation/fork',
                hasParentCodexSessionId: true,
                fallbackResult: 'indeterminate_after_dispatch',
            }),
        );
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not include raw provider resume ids in diagnostics', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValue(new Error('method unavailable'));
        const client = createClientDouble(request);
        const diagnosticsLogger = { debug: vi.fn() };

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'raw-parent-provider-thread-id',
            }, {
                createClient: async () => client,
                logger: diagnosticsLogger,
            }),
        ).resolves.toMatchObject({ type: 'indeterminate_after_dispatch' });

        expect(JSON.stringify(diagnosticsLogger.debug.mock.calls)).not.toContain('raw-parent-provider-thread-id');
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('redacts sensitive values embedded in native fork error diagnostics while keeping safe metadata', async () => {
        const parentCodexSessionId = '019d94f3-0a6f-7c41-bb18-d26425384658';
        const bearerToken = 'sk-proj-native-fork-secret-token-1234567890';
        const threadId = 'thread_native_fork_secret_abcdef';
        const failure = Object.assign(
            new Error(`cannot fork parent ${parentCodexSessionId}; Authorization: Bearer ${bearerToken}; CODEX_THREAD_ID=${threadId}`),
            { code: 'E_NATIVE_FORK' },
        );
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValue(failure);
        const client = createClientDouble(request);
        const diagnosticsLogger = { debug: vi.fn() };

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId,
            }, {
                createClient: async () => client,
                logger: diagnosticsLogger,
            }),
        ).resolves.toMatchObject({ type: 'indeterminate_after_dispatch' });

        const serializedDiagnostics = JSON.stringify(diagnosticsLogger.debug.mock.calls);
        expect(serializedDiagnostics).not.toContain(parentCodexSessionId);
        expect(serializedDiagnostics).not.toContain(bearerToken);
        expect(serializedDiagnostics).not.toContain(threadId);

        const failedMethodCall = diagnosticsLogger.debug.mock.calls.find(([message]) => message === '[CodexAppServerNativeFork] method failed');
        expect(failedMethodCall?.[1]).toEqual(expect.objectContaining({
            errorName: 'Error',
            errorCode: 'E_NATIVE_FORK',
            fallbackResult: 'indeterminate_after_dispatch',
        }));
        const errorMessage = String((failedMethodCall?.[1] as { errorMessage?: unknown } | undefined)?.errorMessage ?? '');
        expect(errorMessage).toContain('cannot fork parent');
        expect(errorMessage).toContain('[REDACTED]');
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });
});
