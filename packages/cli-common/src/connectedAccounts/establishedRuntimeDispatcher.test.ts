import { describe, expect, it } from 'vitest';
import { createConnectedAccountEstablishedRuntimeDispatcher } from './establishedRuntimeDispatcher.js';
import type { ConnectedAccountRuntimeEstablishedInvocation } from './establishedRuntimeTypes.js';

function invocation(signal: AbortSignal, kind: 'refresh' | 'status' = 'refresh'): ConnectedAccountRuntimeEstablishedInvocation {
    const account = { service: { pluginId: 'acme.cloud', localId: 'oauth' }, accountId: 'selected' };
    return {
        target: { account, expectedCredentialRevision: 'credential-1', expectedRuntimeConfigurationRevision: 'configuration-1' },
        operation: kind === 'refresh' ? { kind, operationId: 'rotate', stagedCredentials: {
            get: async () => null, set: async () => {}, delete: async () => {},
        } } : { kind },
        context: { account, credentials: { get: async () => null }, configuration: {
            target: { kind: 'account', account, modeId: 'oauth' }, revision: 'configuration-1', values: {}, getSecret: async () => null,
        } },
        isConfigurationCurrent: () => true, isCredentialRevisionCurrent: () => true, signal,
    };
}

describe('established runtime callback cancellation', () => {
    it.each(['before_staging', 'during_staging', 'after_staging'] as const)(
        'finishes staging and returns the replacement after an exchange succeeds (%s)', async timing => {
            const dispatcher = createConnectedAccountEstablishedRuntimeDispatcher();
            const controller = new AbortController();
            const staged = new Map<string, string>([['expiresAt', 'old']]);
            const input: ConnectedAccountRuntimeEstablishedInvocation = {
                ...invocation(controller.signal),
                operation: {
                    kind: 'refresh', operationId: 'rotate', stagedCredentials: {
                        get: async (key, options) => { options?.signal?.throwIfAborted(); return staged.get(key) ?? null; },
                        set: async (key, value, options) => {
                            options?.signal?.throwIfAborted();
                            staged.set(key, value);
                            if (timing === 'during_staging') controller.abort();
                        },
                        delete: async (key, options) => { options?.signal?.throwIfAborted(); staged.delete(key); },
                    },
                },
            };
            const redacted: string[] = [];
            await expect(dispatcher.invokeEstablishedRuntime({
                async refresh(context, options) {
                    if (timing === 'before_staging') controller.abort();
                    await context.stagedCredentials.set('accessToken', 'access-new', options);
                    await context.stagedCredentials.set('refreshToken', 'refresh-new', options);
                    await context.stagedCredentials.delete('expiresAt', options);
                    if (timing === 'after_staging') controller.abort();
                    return { status: 'connected' };
                },
            }, { id: 'oauth', title: 'Cloud', authentication: { defaultModeId: 'oauth', modes: [] } },
            {}, input, value => { redacted.push(value); },
            phase => dispatcher.assertEstablishedFenceCurrent(input, { isCurrent: () => true }, controller.signal, phase),
            )).resolves.toEqual({ status: 'connected' });
            expect(Object.fromEntries(staged)).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-new' });
            expect(redacted).toEqual(['access-new', 'refresh-new']);
        },
    );

    it('keeps cancellation before a refresh and after a read-only callback', async () => {
        const dispatcher = createConnectedAccountEstablishedRuntimeDispatcher();
        const controller = new AbortController();
        const input = invocation(controller.signal);
        controller.abort();
        let invoked = false;
        await expect(dispatcher.invokeCurrentConnectedAccountCallback(
            phase => dispatcher.assertEstablishedFenceCurrent(input, { isCurrent: () => true }, controller.signal, phase),
            async () => { invoked = true; },
        )).rejects.toMatchObject({ name: 'AbortError' });
        expect(invoked).toBe(false);
        const readController = new AbortController();
        await expect(dispatcher.invokeCurrentConnectedAccountCallback(
            phase => dispatcher.assertEstablishedFenceCurrent(invocation(readController.signal, 'status'), { isCurrent: () => true }, readController.signal, phase),
            async () => { readController.abort(); return { status: 'connected' }; },
        )).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('preserves a provider rejection even when the caller cancels', async () => {
        const dispatcher = createConnectedAccountEstablishedRuntimeDispatcher();
        const controller = new AbortController();
        const input = invocation(controller.signal);
        const failure = new Error('token_exchange_refused');
        await expect(dispatcher.invokeCurrentConnectedAccountCallback(
            phase => dispatcher.assertEstablishedFenceCurrent(input, { isCurrent: () => true }, controller.signal, phase),
            async () => { controller.abort(); throw failure; },
        )).rejects.toBe(failure);
    });
});
