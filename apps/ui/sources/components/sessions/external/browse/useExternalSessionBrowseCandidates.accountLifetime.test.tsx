import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const candidatesListSpy = vi.hoisted(() => vi.fn());
const appliedRuntime = vi.hoisted(() => ({ serverId: '' }));
const credentials = vi.hoisted(() => ({
    accountByServerId: new Map<string, string>(),
    listeners: new Set<(event: import('@/auth/storage/tokenStorage').HomeCredentialMutationEvent) => void>(),
}));

// Secure storage and its mutation notifications are the boundary; credential scopes remain real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (_serverUrl, options) => {
                const accountId = credentials.accountByServerId.get(options?.serverId ?? '');
                return accountId ? { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.signature` } : null;
            },
        },
        subscribeHomeCredentialMutations: (listener) => {
            credentials.listeners.add(listener);
            return () => credentials.listeners.delete(listener);
        },
    });
});

// Applied runtime identity is a connection boundary; Account fencing remains real.
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => appliedRuntime,
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionsCandidatesList: (...args: unknown[]) => candidatesListSpy(...args),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer, upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StorageState } from '@/sync/store/types';

const params = {
    machineId: 'machine-1',
    providerId: 'codex' as const,
    source: { kind: 'codexHome' as const, home: 'user' as const },
};

/**
 * The canonical Account scope owner reads the registered storage state. Driving the
 * real owner (rather than mocking it) is what makes this an Account-switch test and
 * not a restatement of the hook's own branches.
 */
let profileScope: ServerAccountScope | null = null;

describe('useExternalSessionBrowseCandidates Account lifetime', () => {
    beforeEach(async () => {
        candidatesListSpy.mockReset();
        credentials.accountByServerId.clear();
        const profile = await upsertAndActivateServer({ serverUrl: 'https://account-lifetime.test' });
        appliedRuntime.serverId = profile.id;
        profileScope = { serverId: profile.id, accountId: 'account-a' };
        registerStorageStateReader(() => ({ profileScope } as unknown as StorageState));
    });

    afterEach(() => {
        profileScope = null;
        registerStorageStateReader(() => (null as unknown as StorageState));
        standardCleanup();
        credentials.accountByServerId.clear();
    });

    it('keeps an exact foreign Home request current when the foreground Account switches', async () => {
        const foreignHome = await upsertServerProfileOnly({ serverUrl: 'https://foreign-lifetime.test' });
        credentials.accountByServerId.set(foreignHome.id, 'foreign-account');
        const { useServerCredentialAccountScopes } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const scopes = await renderHook(() => useServerCredentialAccountScopes([foreignHome.id]));
        await vi.waitFor(() => expect(scopes.getCurrent().get(foreignHome.id)?.accountId).toBe('foreign-account'));
        // The credential reader loads real storage; register this boundary after that initialization.
        registerStorageStateReader(() => ({ profileScope } as unknown as StorageState));
        expect(getActiveServerAccountScope()).toEqual(profileScope);
        const accountLifetime = scopes.getCurrent().get(foreignHome.id)!;
        const inFlight = createDeferred<{ ok: true; candidates: readonly { remoteSessionId: string; updatedAtMs: number }[]; nextCursor: null }>();
        candidatesListSpy.mockImplementationOnce(() => inFlight.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const exactParams = { ...params, serverId: foreignHome.id, accountLifetime };
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(exactParams));

        profileScope = { serverId: profileScope!.serverId, accountId: 'unrelated-foreground-account' };
        await act(async () => {
            inFlight.resolve({ ok: true, candidates: [{ remoteSessionId: 'foreign-row', updatedAtMs: 1 }], nextCursor: null });
            await flushHookEffects();
        });
        expect(accountLifetime.isCurrent()).toBe(true);
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['foreign-row']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
    });

    it('aborts a retired exact credential request and restarts for its replacement lifetime', async () => {
        const foreignHome = await upsertServerProfileOnly({ serverUrl: 'https://foreign-lifetime.test' });
        credentials.accountByServerId.set(foreignHome.id, 'foreign-account');
        const { useServerCredentialAccountScopes } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const scopes = await renderHook(() => useServerCredentialAccountScopes([foreignHome.id]));
        await vi.waitFor(() => expect(scopes.getCurrent().get(foreignHome.id)?.accountId).toBe('foreign-account'));
        registerStorageStateReader(() => ({ profileScope } as unknown as StorageState));
        expect(getActiveServerAccountScope()).toEqual(profileScope);
        let accountLifetime = scopes.getCurrent().get(foreignHome.id)!;
        const oldLifetime = accountLifetime;
        const inFlight = createDeferred<{ ok: true; candidates: readonly { remoteSessionId: string; updatedAtMs: number }[]; nextCursor: null }>();
        candidatesListSpy.mockImplementationOnce(() => inFlight.promise)
            .mockResolvedValueOnce({ ok: true, candidates: [{ remoteSessionId: 'replacement-row', updatedAtMs: 2 }], nextCursor: null });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => {
            const exactParams = { ...params, serverId: foreignHome.id, accountLifetime };
            return useExternalSessionBrowseCandidates(exactParams);
        });
        const signal = candidatesListSpy.mock.calls[0][1].signal as AbortSignal;
        await act(async () => {
            for (const listener of credentials.listeners) listener({ kind: 'credentials_set', serverId: foreignHome.id, serverUrl: foreignHome.serverUrl });
        });
        expect(oldLifetime.isCurrent()).toBe(false);
        expect(signal.aborted).toBe(true);
        await vi.waitFor(() => {
            const replacement = scopes.getCurrent().get(foreignHome.id);
            expect(replacement).not.toBe(oldLifetime);
            expect(replacement?.isCurrent()).toBe(true);
        });
        accountLifetime = scopes.getCurrent().get(foreignHome.id)!;
        await hook.rerender();
        await act(async () => {
            inFlight.resolve({ ok: true, candidates: [{ remoteSessionId: 'retired-row', updatedAtMs: 1 }], nextCursor: null });
            await flushHookEffects();
        });
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['replacement-row']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
    });

    it('does not publish rows captured under one Account after a switch to another', async () => {
        const inFlight = createDeferred<{
            ok: true;
            candidates: readonly { remoteSessionId: string; title: string; updatedAtMs: number }[];
            nextCursor: string | null;
        }>();
        candidatesListSpy.mockImplementationOnce(() => inFlight.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(1);

        // The user switches Account while the listing request is in flight. The
        // canonical owner's scope moves; the request still carries Account A's machine.
        profileScope = { serverId: profileScope!.serverId, accountId: 'account-b' };

        await act(async () => {
            inFlight.resolve({
                ok: true,
                candidates: [{ remoteSessionId: 'account-a-only', title: 'Account A session', updatedAtMs: 1 }],
                nextCursor: 'account-a-cursor',
            });
            await flushHookEffects();
        });

        expect(hook.getCurrent().candidates).toEqual([]);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(false);
        expect(hook.getCurrent().nextCursor).toBeNull();
    });

    it('publishes rows normally while the capturing Account is still current', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [{ remoteSessionId: 'same-account', title: 'Same Account session', updatedAtMs: 1 }],
            nextCursor: null,
        });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await flushHookEffects();

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId))
            .toEqual(['same-account']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
    });
});
