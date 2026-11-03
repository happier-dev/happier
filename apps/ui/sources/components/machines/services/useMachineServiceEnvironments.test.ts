import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useMachineServiceSourceName } = await import('./useMachineServiceEnvironments');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');

beforeEach(() => homes.reset());
afterEach(() => standardCleanup());

it('reads only the visible admitted Source name and releases hidden Services demand', async () => {
    const serverId = await homes.addHome({ name: 'Services', serverUrl: 'https://services-source.test',
        serverIdentityId: 'srv_services_source', accountId: 'account', currentAccount: true, active: false });
    const sourceId = 'source-a';
    const account = await captureLazyActionAccountContext(serverId);
    const path = `/v1/projects/sources/${sourceId}`;
    let reads = 0;
    let name = 'Storefront';
    homes.answer(serverId, `GET ${path}`, { select: () => {
        reads++;
        return { body: { ok: true, canManage: true, source: { id: sourceId, revision: reads, name,
            audience: [], createdByAccountId: 'account' } } };
    } });
    const readSourceName = ({ active }: { active: boolean }) => useMachineServiceSourceName(serverId, sourceId, active);
    let hook = await renderHook<string | null, { active: boolean }>(readSourceName,
        { initialProps: { active: false } });
    try {
        await flushHookEffects();
        expect(reads, 'retained hidden Services must not fetch Source headers').toBe(0);
        await hook.rerender({ active: true });
        await flushHookEffects();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent()).toBe('Storefront');
        });
        expect(reads).toBe(1);
        expect(homes.requestsFor('/v1/projects/sources')).toHaveLength(0);
        await hook.unmount();
        hook = await renderHook<string | null, { active: boolean }>(readSourceName,
            { initialProps: { active: true } });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe('Storefront');
        expect(reads, 'current Source name survives remount without another detail read').toBe(1);
        await hook.rerender({ active: false });
        await flushHookEffects();
        expect(reads).toBe(1);
        name = 'Renamed Storefront';
        publishHomeAccountChange(serverId, ['projects:sources'], { changeKinds: ['account'] });
        await flushHookEffects();
        expect(reads, 'hidden Source invalidation records stale state without fetching').toBe(1);
        await hook.rerender({ active: true });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent()).toBe(name);
        });
        expect(reads).toBe(2);
        await hook.unmount();
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl('https://services-source.test', { serverId }, { token });
        expect(account.accountLifetime.isCurrent()).toBe(false);
        const { useProjectSource } = await import('@/components/projects/sources/useProjectSources');
        const retired = await renderHook(() => useProjectSource(account.accountLifetime, sourceId));
        try {
            await flushHookEffects();
            expect(retired.getCurrent().source, 'retired Accounts cannot expose retained Source names').toBeNull();
            expect(reads).toBe(2);
        } finally { await retired.unmount(); }
    } finally { await hook.unmount(); account.dispose(); }
});
