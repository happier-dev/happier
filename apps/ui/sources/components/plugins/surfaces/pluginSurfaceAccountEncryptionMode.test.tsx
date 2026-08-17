import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    invalidateAccountEncryptionModeCache,
} from '@/sync/api/account/apiAccountEncryptionMode';

import {
    usePluginSurfaceAccountEncryptionMode,
} from './pluginSurfaceContext';

const accountModeTransport = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    activeServer: {
        serverId: 'server-1',
        serverUrl: 'https://relay.example.test',
        generation: 1,
    },
}));

vi.mock('@/utils/timing/time', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/timing/time')>()),
    backoff: async <T,>(run: () => Promise<T>): Promise<T> => await run(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: unknown[]) => accountModeTransport.serverFetch(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => accountModeTransport.activeServer,
}));

type AccountModeDeferred = Readonly<{
    promise: Promise<Response>;
    resolve(response: Response): void;
}>;

function createDeferredResponse(): AccountModeDeferred {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function response(mode: 'plain' | 'e2ee'): Response {
    return new Response(JSON.stringify({ mode, updatedAt: 1 }), { status: 200 });
}

function createLifetime(accountId: string): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    retire(): void;
}> {
    let current = true;
    const listeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId }),
        isCurrent: () => current,
        onRetire(listener) {
            listeners.add(listener);
            return Object.freeze({ dispose: () => listeners.delete(listener) });
        },
    });
    return Object.freeze({
        lifetime,
        retire(): void {
            if (!current) return;
            current = false;
            for (const listener of [...listeners]) listener();
            listeners.clear();
        },
    });
}

const credentialsA: AuthCredentials = { token: 'token-a' };
const credentialsB: AuthCredentials = { token: 'token-b' };

describe('usePluginSurfaceAccountEncryptionMode', () => {
    beforeEach(() => {
        accountModeTransport.serverFetch.mockReset();
        invalidateAccountEncryptionModeCache();
    });

    afterEach(() => {
        standardCleanup();
        invalidateAccountEncryptionModeCache();
    });

    it('withholds stale Account A and invalidated snapshots until the current Account mode resolves', async () => {
        const accountA = createLifetime('account-a');
        const accountB = createLifetime('account-b');
        const accountAResponse = createDeferredResponse();
        const accountBResponse = createDeferredResponse();
        const refreshedAccountBResponse = createDeferredResponse();
        accountModeTransport.serverFetch
            .mockImplementationOnce(async () => await accountAResponse.promise)
            .mockImplementationOnce(async () => await accountBResponse.promise)
            .mockImplementationOnce(async () => await refreshedAccountBResponse.promise);

        const accountAIsCurrent = () => accountA.lifetime.isCurrent();
        const accountBIsCurrent = () => accountB.lifetime.isCurrent();
        const hook = await renderHook((input: Readonly<{
            lifetime: ActiveServerAccountScopeLifetime;
            credentials: AuthCredentials;
            isCurrent: () => boolean;
        }>) => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: input.lifetime,
            credentials: input.credentials,
            isCurrent: input.isCurrent,
        }), {
            initialProps: {
                lifetime: accountA.lifetime,
                credentials: credentialsA,
                isCurrent: accountAIsCurrent,
            },
            flushOptions: { cycles: 0 },
        });

        expect(hook.getCurrent()).toBeNull();

        await act(async () => {
            accountA.retire();
        });
        await hook.rerender({
            lifetime: accountB.lifetime,
            credentials: credentialsB,
            isCurrent: accountBIsCurrent,
        });
        expect(hook.getCurrent()).toBeNull();

        await act(async () => {
            accountBResponse.resolve(response('plain'));
        });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe('plain');

        await act(async () => {
            accountAResponse.resolve(response('e2ee'));
        });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe('plain');

        await act(async () => {
            invalidateAccountEncryptionModeCache();
        });
        expect(hook.getCurrent()).toBeNull();

        await act(async () => {
            refreshedAccountBResponse.resolve(response('e2ee'));
        });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe('e2ee');
        expect(accountModeTransport.serverFetch).toHaveBeenCalledTimes(3);

        await hook.unmount();
    });
});
