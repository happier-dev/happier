import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import { createDeferred, renderHook, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import {
    createHomeGovernanceHarness,
    createAccountTokenForTests,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } =
    await import('@/sync/domains/scope/activeServerAccountScope');
const { fetchAccountEncryptionMode, invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } =
    await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { usePluginSurfaceAccountEncryptionMode } = await import('./pluginSurfaceContext');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');

const modePath = '/v1/account/encryption';
let serverId: string;
let previous = storage.getState();
let previousApplied = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

async function currentAccount(accountId: string) {
    // This hook owns disclosure, not connection bootstrap. Publish the real
    // teardown/restoration facts while replacing credentials so the fixture's
    // delayed mode reply cannot also block an unrelated Sync cold restore.
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), false);
    await home.switchAccount(serverId, accountId);
    storage.getState().activateProfileScope({ serverId, accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const lifetime = captureActiveServerAccountScopeLifetime();
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://plugin-mode.test', { serverId });
    if (!lifetime || !credentials) throw new Error('Expected the fixture Home Account authority');
    return { lifetime, credentials };
}

describe('usePluginSurfaceAccountEncryptionMode', () => {
    beforeEach(async () => {
        previous = storage.getState();
        previousApplied = getAppliedActiveServerSnapshot();
        previousAvailable = isAppliedActiveServerRuntimeAvailable();
        await home.reset();
        serverId = await home.addHome({ serverUrl: 'https://plugin-mode.test', name: 'Account mode Home', accountId: 'account-a' });
        invalidateAccountEncryptionModeCache();
    });

    afterEach(async () => {
        await standardCleanup();
        apiSocket.disconnect();
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        await home.reset();
        storage.setState(previous);
        publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    });

    it('reads the mounted Home Account on remount while another Home is focused', async () => {
        await currentAccount('account-a');
        const otherServerId = await home.addHome({ serverUrl: 'https://focused-plugin-mode.test', name: 'Focused Home', accountId: 'other-account' });
        home.answer(otherServerId, modePath, { body: AccountEncryptionModeResponseSchema.parse({ mode: 'e2ee', updatedAt: 1 }) });
        const mount = () => renderHook(() => {
            const bindings = useServerCredentialAccountScopeBindings([serverId]);
            const accountLifetime = bindings.values().next().value ?? null;
            return usePluginSurfaceAccountEncryptionMode({ accountLifetime });
        });
        for (let index = 0; index < 2; index += 1) {
            const hook = await mount();
            try {
                await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
                const reads = home.requestsFor(modePath).length;
                for (let arrival = 0; arrival < 20; arrival += 1) await hook.rerender();
                expect(home.requestsFor(modePath)).toHaveLength(reads);
            } finally { await hook.unmount(); }
        }
        expect(home.requestsFor(modePath).filter(request => request.serverId === otherServerId)).toEqual([]);
    });

    it.each(['plain', 'e2ee'] as const)('settles a successful %s mode response across equivalent mount renders without re-reading', async (mode) => {
        const account = await currentAccount('account-a');
        const extraRead = createDeferred<void>();
        let modeReads = 0;
        // The wire boundary emits the exact strict response owned by the Home
        // route. Park only an unintended second read so old code cannot spin.
        home.answer(serverId, modePath, { select: () => ({
            body: AccountEncryptionModeResponseSchema.parse({ mode, updatedAt: 1 }),
            ...(modeReads++ === 0 ? {} : { respondAfter: extraRead.promise }),
        }) });
        const hook = await renderHook(() => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime,
            credentials: account.credentials,
        }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode }));
            const settledModeReads = home.requestsFor(modePath).length;
            const settledCurrentnessReads = home.requestsFor(`${modePath}/currentness`).length;
            for (let index = 0; index < 20; index += 1) await hook.rerender();
            await flushHookEffects();
            expect(hook.getCurrent()).toEqual({ status: 'ready', mode });
            expect(home.requestsFor(modePath).length - settledModeReads).toBe(0);
            expect(home.requestsFor(`${modePath}/currentness`).length - settledCurrentnessReads).toBe(0);
            expect(modeReads).toBe(1);
        } finally {
            await hook.unmount();
            extraRead.resolve();
        }
    });

    it('admits a successful mode 200 when the same credential material is recaptured during render', async () => {
        const account = await currentAccount('account-a');
        const extraRead = createDeferred<void>();
        let modeReads = 0;
        home.answer(serverId, modePath, { select: () => ({
            body: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }),
            ...(modeReads++ === 0 ? {} : { respondAfter: extraRead.promise }),
        }) });
        const hook = await renderHook(() => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime,
            credentials: { ...account.credentials },
        }));
        try {
            await waitForHomeGovernance(() => expect(modeReads).toBeGreaterThan(0));
            await flushHookEffects();
            expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' });
            expect(modeReads).toBe(1);
        } finally {
            await hook.unmount();
            extraRead.resolve();
        }
    });

    it('keeps the real admitted socket currentness settled until an encryption invalidation', async () => {
        const account = await currentAccount('account-a');
        const endpoint = 'https://plugin-mode.test';
        const generation = getActiveServerSnapshot().generation;
        installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
        apiSocket.initialize({ endpoint, serverId, generation, credentials: account.credentials,
            token: account.credentials.token,
            request: createServerFetchAtEndpoint({ endpointUrl: endpoint, serverId, credentials: account.credentials }),
            isCurrent: account.lifetime.isCurrent,
        }, null);
        const request = apiSocket.createRequestForPreparedTarget({ endpoint, serverId, generation });
        const resolveMode = async (_signal: AbortSignal) => (await fetchAccountEncryptionMode(account.credentials, {
            request, usage: 'identity',
        })).mode;
        const hook = await renderHook(() => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime, credentials: account.credentials, resolveMode,
        }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
            const modeReads = home.requestsFor(modePath).length;
            const currentnessReads = home.requestsFor(`${modePath}/currentness`).length;
            expect(currentnessReads).toBeGreaterThan(0);
            for (let index = 0; index < 20; index += 1) {
                await hook.rerender();
            }
            expect(home.requestsFor(modePath).length - modeReads).toBe(0);
            expect(home.requestsFor(`${modePath}/currentness`).length - currentnessReads).toBe(0);
            await act(async () => invalidateAccountEncryptionModeCache({ serverId }));
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
            expect(home.requestsFor(`${modePath}/currentness`).length - currentnessReads).toBe(1);
        } finally { await hook.unmount(); }
    });

    it('keeps settled disclosure through unrelated Home withdrawals and equal arrivals, then acquires once for its real mode change', async () => {
        const otherServerId = await home.addHome({ serverUrl: 'https://other-plugin-mode.test', name: 'Other Home', accountId: 'other-account', active: false });
        const account = await currentAccount('account-a');
        const pending = createDeferred<void>();
        const states: string[] = [];
        const hook = await renderHook(() => {
            const result = usePluginSurfaceAccountEncryptionMode({
                accountLifetime: captureActiveServerAccountScopeLifetime(),
                credentials: { ...account.credentials },
            });
            states.push(result.status);
            return result;
        });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
            const reads = home.requestsFor(modePath).length;
            states.length = 0;
            home.answer(serverId, modePath, { respondAfter: pending.promise,
                body: AccountEncryptionModeResponseSchema.parse({ mode: 'e2ee', updatedAt: 2 }) });
            for (let index = 0; index < 20; index += 1) {
                await act(async () => invalidateAccountEncryptionModeCache({ serverId: otherServerId, reason: 'transport-withdrawal' }));
                await hook.rerender();
            }
            expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' });
            expect(states).not.toContain('loading');
            expect(home.requestsFor(modePath).length - reads).toBe(0);

            await act(async () => invalidateAccountEncryptionModeCache({ serverId }));
            expect(hook.getCurrent()).toEqual({ status: 'loading' });
            await waitForHomeGovernance(() => expect(home.requestsFor(modePath).length - reads).toBe(1));
            // A different Home cannot retire this now-pending acquisition,
            // either. Its next borrower shares the same physical request.
            for (let index = 0; index < 20; index += 1) {
                await act(async () => invalidateAccountEncryptionModeCache({ serverId: otherServerId, reason: 'transport-withdrawal' }));
            }
            const borrower = fetchAccountEncryptionMode(account.credentials)
                .then(value => ({ value }), (error: unknown) => ({ error }));
            await flushHookEffects();
            expect(home.requestsFor(modePath).length - reads).toBe(1);
            await act(async () => pending.resolve());
            await expect(borrower).resolves.toMatchObject({ value: { mode: 'e2ee' } });
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'e2ee' }));
            expect(home.requestsFor(modePath).length - reads).toBe(1);
            expect(states.filter((status, index) => index === 0 || status !== states[index - 1]))
                .toEqual(['ready', 'loading', 'ready']);
        } finally {
            await hook.unmount();
            pending.resolve();
        }
    });

    it('withdraws the old mode when credential authority actually changes within the same captured Account', async () => {
        const account = await currentAccount('account-a');
        const hook = await renderHook((props: Readonly<{ credentials: AuthCredentials }>) => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime, credentials: props.credentials,
        }), { initialProps: { credentials: account.credentials } });
        const refreshed = createDeferred<void>();
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
            const credentials = { ...account.credentials, token: createAccountTokenForTests('account-a', { currentAccount: true }) };
            expect(credentials.token).not.toBe(account.credentials.token);
            home.answer(serverId, modePath, { respondAfter: refreshed.promise,
                body: AccountEncryptionModeResponseSchema.parse({ mode: 'e2ee', updatedAt: 2 }) });
            await hook.rerender({ credentials });
            expect(hook.getCurrent()).toEqual({ status: 'loading' });
            await act(async () => refreshed.resolve());
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'e2ee' }));
            expect(home.requestsFor(modePath)).toHaveLength(2);
        } finally {
            await hook.unmount();
            refreshed.resolve();
        }
    });

    it('keeps persisted Account mode available while a source execution controller is unavailable', async () => {
        const account = await currentAccount('account-a');
        let sourceCurrent = false;
        // Execution currentness is independent of this still-admitted Account.
        // The host used to lend its controller predicate to the mode reader.
        const input = { accountLifetime: account.lifetime, credentials: account.credentials,
            isCurrent: () => sourceCurrent };
        const hook = await renderHook(() => usePluginSurfaceAccountEncryptionMode(input));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
            const reads = home.requestsFor(modePath).length;
            sourceCurrent = true;
            await hook.rerender();
            sourceCurrent = false;
            await hook.rerender();
            expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' });
            expect(home.requestsFor(modePath)).toHaveLength(reads);
            await currentAccount('account-b');
            await hook.rerender();
            expect(hook.getCurrent()).toEqual({ status: 'unavailable' });
        } finally { await hook.unmount(); }
    });

    it('withholds stale Account A and invalidated snapshots until the current Account mode resolves', async () => {
        const accountA = await currentAccount('account-a');
        const accountAResponse = createDeferred<void>();
        const accountBResponse = createDeferred<void>();
        const refreshedAccountBResponse = createDeferred<void>();
        home.answer(serverId, modePath, { respondAfter: accountAResponse.promise, body: { mode: 'e2ee', updatedAt: 1 } });
        const hook = await renderHook((input: Readonly<{
            account: typeof accountA;
        }>) => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: input.account.lifetime,
            credentials: input.account.credentials,
        }), { initialProps: { account: accountA }, flushOptions: { cycles: 0 } });

        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(1));
        const accountB = await currentAccount('account-b');
        expect(accountA.lifetime.isCurrent()).toBe(false);
        home.answer(serverId, modePath, { respondAfter: accountBResponse.promise, body: { mode: 'plain', updatedAt: 1 } });
        await hook.rerender({ account: accountB });
        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(2));
        await act(async () => accountBResponse.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));

        await act(async () => accountAResponse.resolve());
        expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' });
        home.answer(serverId, modePath, { respondAfter: refreshedAccountBResponse.promise, body: { mode: 'e2ee', updatedAt: 1 } });
        await act(async () => invalidateAccountEncryptionModeCache());
        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(3));
        await act(async () => refreshedAccountBResponse.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'e2ee' }));
        expect(home.requestsFor(modePath)).toHaveLength(3);
        await hook.unmount();
    });

    it('recovers a transient exact-Home mode failure through canonical readiness without another invalidation', async () => {
        const account = await currentAccount('account-a');
        home.answer(serverId, modePath, { status: 503, body: {} });
        const hook = await renderHook(() => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime,
        }));
        try {
            await waitForHomeGovernance(() => expect(home.requestsFor(modePath).length).toBeGreaterThan(0));
            await flushHookEffects();
            expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', retrying: true,
                reason: { code: 'account-encryption-mode-unavailable' } });
            home.answer(serverId, modePath, { body: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) });
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
        } finally { await hook.unmount(); }
    });

    it('re-runs the same Account-mode read on Retry and stays unreachable until it answers', async () => {
        const account = await currentAccount('account-a');
        const answered = createDeferred<void>();
        let reads = 0;
        // The first read fails; the next one waits until the test answers, so only Retry can have sent it.
        home.answer(serverId, modePath, { select: () => reads++ === 0
            ? { status: 503, body: {} }
            : { respondAfter: answered.promise, body: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) } });
        const states: string[] = [];
        const hook = await renderHook(() => {
            const result = usePluginSurfaceAccountEncryptionMode({ accountLifetime: account.lifetime, });
            states.push(result.status);
            return result;
        });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'unavailable' }));
            const unavailable = hook.getCurrent();
            if (unavailable.status !== 'unavailable' || !unavailable.retry) throw new Error('Expected a Retry on the unreachable read');
            await waitForHomeGovernance(() => expect(reads).toBe(2));
            states.length = 0;
            await act(async () => unavailable.retry!());
            await waitForHomeGovernance(() => expect(reads).toBe(3));
            expect(hook.getCurrent()).toMatchObject({ status: 'unavailable' });
            await act(async () => answered.resolve());
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual(expect.objectContaining({ status: 'ready', mode: 'plain' })));
            // Retrying an unreachable Home never flashes the loading placeholder over the error.
            expect(states).not.toContain('loading');
        } finally {
            await hook.unmount();
            answered.resolve();
        }
    });

    it('reports a terminal refusal only after the pending mode request settles', async () => {
        const account = await currentAccount('account-a');
        const pending = createDeferred<void>();
        home.answer(serverId, modePath, { respondAfter: pending.promise, status: 401, body: {} });
        const hook = await renderHook(() => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime,
        }));

        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(1));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'unavailable' }));
        const reads = home.requestsFor(modePath).length;
        for (let index = 0; index < 20; index += 1) await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable' });
        expect(home.requestsFor(modePath)).toHaveLength(reads);
        await hook.unmount();
    });
});
