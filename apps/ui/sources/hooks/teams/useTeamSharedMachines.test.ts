import { useLayoutEffect } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
// Load the real Action graph during collection, outside the interaction deadline.
import '@/sync/ops/actions/defaultActionExecutor';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

beforeEach(async () => { await home.reset(); });
afterEach(async () => { standardCleanup(); await home.reset(); });

it('loads selected-Team Machine pages without replacing the Account inventory and withdraws after access loss', async () => {
    const { useTeamSharedMachines } = await import('./useTeamSharedMachines');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const serverId = await home.addHome({ name: 'Selected Home', serverUrl: 'https://team-machines.example', accountId: 'reader' });
    const retained = createMachineFixture({ id: 'unrelated-personal' });
    storage.setState({ machineListByServerId: { [serverId]: [retained] } });
    const path = '/v1/machines?sharedWithTeamId=selected-team';
    const otherPath = '/v1/machines?sharedWithTeamId=other-team';
    const row = { ...createPlainMachineRowFixture({ id: 'team-machine', accountId: 'reader' }), sharedWithTeamScope: 'group' };
    home.answer(serverId, path, { body: [row] });
    home.answer(serverId, otherPath, { body: [] });
    const screen = await renderHook((props: { teamId: string; enabled: boolean }) => useTeamSharedMachines({
        scope: { serverId, accountId: 'reader' }, address: { serverId, teamId: props.teamId }, enabled: props.enabled,
    }), { initialProps: { teamId: 'selected-team', enabled: false } });
    expect(home.requestsFor(path)).toHaveLength(0);
    await screen.rerender({ teamId: 'selected-team', enabled: true });
    await waitForHomeGovernance(() => expect(screen.getCurrent().rows.map(machine => machine.machineId)).toEqual(['team-machine']));
    expect(screen.getCurrent().rows[0]).toMatchObject({ sharedWithTeamScope: 'group' });
    expect(storage.getState().machineListByServerId[serverId]).toEqual([retained]);
    home.answer(serverId, path, { status: 503, body: { error: 'unavailable' } });
    await act(async () => { await screen.getCurrent().reload(); });
    expect(screen.getCurrent().status).toBe('error');
    expect(screen.getCurrent().rows.map(machine => machine.machineId)).toEqual(['team-machine']);
    home.answer(serverId, path, { status: 403, body: { error: 'permission_denied' } });
    await act(async () => { publishHomeAccountChange(serverId, undefined, { source: 'snapshot' }); });
    await waitForHomeGovernance(() => expect(screen.getCurrent().rows).toEqual([]));
    expect(screen.getCurrent().error?.kind).toBe('forbidden');
    await screen.rerender({ teamId: 'other-team', enabled: true });
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(true));
    expect(home.requestsFor(otherPath)).toHaveLength(1);
    await act(async () => { await home.switchAccount(serverId, 'replacement-reader'); });
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(false));
    expect(screen.getCurrent().rows).toEqual([]);
});

it('keeps a previously opened Team Machine list visible through a held reread', async () => {
    const { useTeamSharedMachines } = await import('./useTeamSharedMachines');
    const serverId = await home.addHome({ name: 'Machine Home', serverUrl: 'https://team-machines-remount.example', accountId: 'reader' });
    const path = '/v1/machines?sharedWithTeamId=selected-team';
    const row = { ...createPlainMachineRowFixture({ id: 'team-machine', accountId: 'reader' }), sharedWithTeamScope: 'group' };
    home.answer(serverId, path, { body: [row] });
    const read = () => useTeamSharedMachines({ scope: { serverId, accountId: 'reader' },
        address: { serverId, teamId: 'selected-team' }, enabled: true });
    const first = await renderHook(read);
    await waitForHomeGovernance(() => expect(first.getCurrent().isCurrent).toBe(true));
    await first.unmount();

    let releaseRefusal!: () => void;
    const respondAfter = new Promise<void>(resolve => { releaseRefusal = resolve; });
    home.answer(serverId, path, { status: 403, body: { error: 'permission_denied' }, respondAfter });
    const frames: Array<ReturnType<typeof read>> = [];
    const returned = await renderHook(() => {
        const list = read();
        useLayoutEffect(() => { frames.push(list); });
        return list;
    });
    expect(frames[0]).toMatchObject({ rows: [{ machineId: 'team-machine' }], status: 'refreshing', isCurrent: false });
    expect(returned.getCurrent().rows.map(machine => machine.machineId)).toEqual(['team-machine']);
    expect(returned.getCurrent().status).toBe('refreshing');
    expect(returned.getCurrent().isCurrent).toBe(false);
    await act(async () => { releaseRefusal(); });
    await waitForHomeGovernance(() => expect(returned.getCurrent()).toMatchObject({ rows: [], status: 'error' }));
    await returned.unmount();

    home.answer(serverId, path, { body: [], respondAfter: new Promise<void>(() => {}) });
    const afterRefusal = await renderHook(read);
    expect(afterRefusal.getCurrent()).toMatchObject({ rows: [], status: 'loading' });
    await afterRefusal.unmount();
});

it('does not send a Team address through another Home credential', async () => {
    const { useTeamSharedMachines } = await import('./useTeamSharedMachines');
    const serverId = await home.addHome({ name: 'Selected Home', serverUrl: 'https://machine-locality.example', accountId: 'reader' });
    const screen = await renderHook(() => useTeamSharedMachines({ scope: { serverId, accountId: 'reader' },
        address: { serverId: 'different-home', teamId: 'selected-team' }, enabled: true }));
    expect(screen.getCurrent().rows).toEqual([]);
    expect(screen.getCurrent().isCurrent).toBe(false);
    expect(home.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
});

it('honors the existing Machine list Action policy before reaching the native Team reader', async () => {
    const { useTeamSharedMachines } = await import('./useTeamSharedMachines');
    const serverId = await home.addHome({ name: 'Action Home', serverUrl: 'https://machine-action.example', accountId: 'reader' });
    await home.setActionPolicy(serverId, 'machines.list', 'ui', 'off');
    const path = '/v1/machines?sharedWithTeamId=selected-team';
    home.answer(serverId, path, { body: [] });
    const screen = await renderHook(() => useTeamSharedMachines({ scope: { serverId, accountId: 'reader' },
        address: { serverId, teamId: 'selected-team' }, enabled: true }));
    await waitForHomeGovernance(() => expect(screen.getCurrent().status).not.toBe('loading'));
    expect(screen.getCurrent().status).toBe('error');
    expect(screen.getCurrent().error?.code).toBe('action_disabled');
    expect(home.requestsFor(path)).toHaveLength(0);
});
