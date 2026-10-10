import { afterEach, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from './homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from './realAppRuntimeHarness';

// Pay the real runtime's cold import cost during collection, not the behavior case.
await initializeRealAppRuntimeForTests();

const homes = createHomeGovernanceHarness();
afterEach(async () => { await homes.reset(); });

it('persists genuine Home credentials and retires a focused Account on replacement and reset', async () => {
    installHomeGovernanceBoundaries(homes);
    const id = await homes.addHome({ name: 'Governance', serverUrl: 'https://governance-custody.test', accountId: 'account-a' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://governance-custody.test', { serverId: id });
    if (!credentials) throw new Error('Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    const { getActiveServerAccountScope, captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-a' });
    const captured = captureActiveServerAccountScopeLifetime();
    expect(captured?.isCurrent()).toBe(true);
    let release: () => void = () => undefined;
    homes.answer(id, '/v1/lifetime-probe', { body: { account: 'a' }, respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    const { serverFetch, StaleServerGenerationError, ServerFetchAbortedForServerSwitchError } = await import('@/sync/http/client');
    const pending = serverFetch('/v1/lifetime-probe', undefined, { retry: 'none' }).then(
        () => false,
        error => error instanceof StaleServerGenerationError || error instanceof ServerFetchAbortedForServerSwitchError
            || (error instanceof DOMException && error.name === 'AbortError'),
    );
    await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/lifetime-probe')).toHaveLength(1));
    await homes.switchAccount(id, 'account-b');
    release();
    expect(await pending).toBe(true);
    expect(captured?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-b' });
    const replacement = captureActiveServerAccountScopeLifetime();
    await homes.reset();
    expect(replacement?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toBeNull();
    expect(await TokenStorage.getCredentialsForServerUrl('https://governance-custody.test', { serverId: id })).toBeNull();
});
