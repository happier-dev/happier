import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getMachineSentenceName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { id: 'page-machine' },
}).module);

const { useMachinePageTarget } = await import('./useMachinePageTarget');

afterEach(() => standardCleanup());

it('pulls a known Machine last-active time once on page open without following later activity', async () => {
    const store = getStorage();
    const previous = store.getState();
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://page-last-seen.test', accountId: 'owner' }],
        route: request => request.path === '/v1/machines/read-batch'
            ? createMachineReadBatchResponseFixture(request.body, id => createPlainMachineRowFixture({ id, accountId: 'owner', machine: createMachineFixture({ id, activeAt: 42_000 }) }))
            : undefined });
    const serverId = homes.homes.a!.id;
    const machine = createMachineFixture({ id: 'page-machine', active: true, activeAt: 1_000 });
    store.getState().applyMachines([machine], true, { sourceServerId: serverId });
    const hook = await renderHook(useMachinePageTarget);
    try {
        await waitForHomeGovernance(() => expect(homes.requests.filter(request => request.path === '/v1/machines/read-batch')).toHaveLength(1));
        expect(hook.getCurrent()).toMatchObject({ lastSeenAtOnOpen: 42_000 });
        await act(async () => store.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: 90_000 }], { sourceServerId: serverId }));
        expect(hook.getCurrent()).toMatchObject({ lastSeenAtOnOpen: 42_000 });
        expect(homes.requests.filter(request => request.path === '/v1/machines/read-batch')).toHaveLength(1);
    } finally { await hook.unmount(); await homes.dispose(); store.setState(previous); }
});

it('keeps the page shell quiet when its Machine presence changes', async () => {
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://page-presence.test', serverIdentityId: 'srv_page_presence', accountId: 'owner' }], route: () => undefined });
    const serverId = homes.homes.a!.id;
    const store = getStorage();
    const previous = store.getState();
    const machine = createMachineFixture({ id: 'page-machine', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
    store.getState().applyMachines([machine], true, { sourceServerId: serverId });
    observeMachinePresenceForTest({ serverId, accountId: 'owner' }, [machine.id]);
    let renders = 0;
    const hook = await renderHook(() => { renders++; return useMachinePageTarget(); });
    try {
        const target = hook.getCurrent();
        const before = renders;
        await act(async () => publishMachineActivity(target.machine!, { active: false, activeAt: machine.activeAt }, []));
        expect(renders - before).toBe(0);
        expect(hook.getCurrent()).toBe(target);
    } finally {
        await hook.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});

// The Machine page's target names one Machine. Another Machine's daemon publications (live resource
// summaries advance `daemonStateVersion` every sample) are not facts of this page and must not redraw it.
it('keeps the page target quiet for other Machines and redraws once for its own name change', async () => {
    const store = getStorage();
    const previous = store.getState();
    const serverId = getActiveServerSnapshot().serverId;
    const page = createMachineFixture({ id: 'page-machine', active: true, activeAt: Date.now() });
    const other = createMachineFixture({ id: 'other-machine', active: true, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, displayName: 'Other box' } });
    store.getState().applyMachines([page, other], true, { sourceServerId: serverId });
    let renders = 0;
    const hook = await renderHook(() => { renders += 1; return useMachinePageTarget(); });
    try {
        expect(hook.getCurrent().machine?.id).toBe('page-machine');
        const first = hook.getCurrent();
        renders = 0;
        let otherNow: Machine = other;
        for (let sample = 1; sample <= 3; sample++) {
            otherNow = { ...otherNow, daemonStateVersion: (otherNow.daemonStateVersion ?? 0) + 1,
                daemonState: { ...(otherNow.daemonState ?? {}), resources: { v: 1, sampledAt: sample } } as Machine['daemonState'] };
            await act(async () => store.getState().applyMachines([otherNow], false, { sourceServerId: serverId }));
        }
        expect(renders).toBe(0);
        expect(hook.getCurrent()).toBe(first);
        await act(async () => store.getState().applyMachines([{ ...page, metadataVersion: page.metadataVersion + 1,
            metadata: { ...page.metadata!, displayName: 'Renamed box' } }], false, { sourceServerId: serverId }));
        expect(renders).toBe(1);
        expect(hook.getCurrent().machineName).toBe('Renamed box');
    } finally {
        await hook.unmount();
        store.setState(previous);
    }
});

it('joins the admitted managed name for page titles and sentences, including same-name peers and pushed renames', async () => {
    const store = getStorage();
    const previous = store.getState();
    let managed = ManagedMachineV1Schema.parse({ id: 'created', homeId: 'srv_page_names', custodianAccountId: 'owner', enrolledMachineId: 'page-machine',
        launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
        resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' },
    });
    const homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://page-names.test', serverIdentityId: managed.homeId, accountId: 'owner' },
    ], route: request => request.path === '/v1/machines/managed/actions/list' ? Response.json({ machines: [managed] }) : undefined });
    const serverId = homes.homes.a!.id;
    const page = createMachineFixture({ id: 'page-machine', active: true, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, displayName: '', host: 'lima-happier-generated-provider-host' } });
    const other = createMachineFixture({ id: 'other-machine', metadata: { ...page.metadata!, displayName: 'Build box', host: 'other-host' } });
    store.getState().applyMachines([page, other], true, { sourceServerId: serverId });
    const hook = await renderHook(useMachinePageTarget);
    try {
        const named = { ...page, managedName: managed.launch.name };
        const expected = resolveMachineDisplayNames([named, other]).get(page.id);
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineName).toBe(expected));
        expect(hook.getCurrent().machineName).not.toContain('lima-happier');
        expect(hook.getCurrent().machineSentenceName).toBe(getMachineSentenceName(named, expected));
        managed = { ...managed, launch: { ...managed.launch, name: 'Renamed build box' } };
        await act(async () => publishHomeAccountChange(serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineName).toBe('Renamed build box'));
        expect(hook.getCurrent().machineSentenceName).toBe('Renamed build box');
    } finally {
        await hook.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});
