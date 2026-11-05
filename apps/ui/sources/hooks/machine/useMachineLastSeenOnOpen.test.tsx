import { afterEach, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getStorage } from '@/sync/domains/state/storageStore';

import { useMachineLastSeenOnOpen } from './useMachineLastSeenOnOpen';

afterEach(() => standardCleanup());

it('reads a whole open fleet once per Home, keeps captured timestamps, and refreshes on reopening', async () => {
    const store = getStorage();
    const previous = store.getState();
    let activeAt = 42_000;
    const homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://machine-open-a.test', accountId: 'owner-a' },
        { key: 'b', serverUrl: 'https://machine-open-b.test', accountId: 'owner-b' },
    ], route: request => {
        if (request.path !== '/v1/machines/read-batch') return undefined;
        if (!request.accountId) throw new Error('Expected authenticated Machine read');
        const accountId = request.accountId;
        return createMachineReadBatchResponseFixture(request.body, id => createPlainMachineRowFixture({ id, accountId,
            machine: createMachineFixture({ id, active: false, activeAt, presenceProtocolVersion: 1 }) }));
    } });
    const targets = Object.values(homes.homes).flatMap(home => Array.from({ length: 128 }, (_, index) => ({
        serverId: home.id, machineId: `machine-${index}`,
    })));
    for (const [key, home] of Object.entries(homes.homes)) store.getState().applyMachines(targets.filter(target => target.serverId === home.id)
        .map(target => createMachineFixture({ id: target.machineId, active: true, activeAt: 1_000, presenceProtocolVersion: 1 })), true,
    { sourceServerId: home.id, sourceAccountId: `owner-${key}` });
    let hook = await renderHook(useMachineLastSeenOnOpen, { initialProps: targets });
    const batches = () => homes.requests.filter(request => request.path === '/v1/machines/read-batch');
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().size).toBe(2));
        expect(batches().map(request => (request.body as { machineIds: string[] }).machineIds.length)).toEqual([128, 128]);
        expect(hook.getCurrent().get(homes.homes.a!.id)?.get('machine-0')).toBe(42_000);
        activeAt = 90_000;
        await hook.rerender([...targets].reverse());
        expect(batches()).toHaveLength(2);
        expect(hook.getCurrent().get(homes.homes.a!.id)?.get('machine-0')).toBe(42_000);
        await hook.unmount();
        hook = await renderHook(useMachineLastSeenOnOpen, { initialProps: targets });
        await waitForHomeGovernance(() => expect(hook.getCurrent().get(homes.homes.a!.id)?.get('machine-0')).toBe(90_000));
        expect(batches()).toHaveLength(4);
    } finally { await hook.unmount(); await homes.dispose(); store.setState(previous); }
});
