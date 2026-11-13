import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { ProviderSettingsMigrationPendingConflictV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useLegacyProfileMigrationTarget } = await import('./useLegacyProfileMigrationTarget');
const { useAllProfileMachineInventorySnapshots } = await import('@/sync/domains/machines/useMachineInventorySnapshots');
const before = storage.getState();
afterEach(async () => { await standardCleanup(); storage.setState(before, true); clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

async function activateMigrationHome(suffix: string, accountId = `account-migration-${suffix}`) {
    const serverUrl = `https://migration-${suffix}.test`;
    await network.addHome(serverUrl, accountId);
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: `srv_migration_${suffix}`, canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
    if (!home.serverIdentityId) throw new Error('Expected migration Home identity');
    await setActiveServerId(home.id);
    return { home, scope: { serverId: home.serverIdentityId, accountId } };
}

it('offers only executable migration targets and withdraws a selected target after request failure', async () => {
    const { scope } = await activateMigrationHome('eligibility');
    const machines = [
        createMachineFixture({ id: 'replaced', activeAt: Date.now(), replacedByMachineId: 'first' }),
        createMachineFixture({ id: 'first', activeAt: Date.now() }),
        createMachineFixture({ id: 'second', activeAt: Date.now() }),
        createMachineFixture({ id: 'offline', active: false, activeAt: 0 }),
        createMachineFixture({ id: 'locked', activeAt: Date.now(), availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }),
        createMachineFixture({ id: 'revoked', activeAt: Date.now(), revokedAt: Date.now() }),
    ];
    storage.setState({ profileScope: scope, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    const hook = await renderHook(() => useLegacyProfileMigrationTarget());
    await act(async () => { await vi.waitFor(() => {
        expect(hook.getCurrent().targetMachines.map(machine => machine.id)).toEqual(['first', 'second']);
    }); });
    expect(hook.getCurrent().machineId).toBeNull();
    await act(async () => hook.getCurrent().setPreferredMachineId('second'));
    expect(hook.getCurrent().machineId).toBe('second');
    await act(async () => recordMachineRequestFailed({ ...scope, accountId: 'another-account', machineId: 'second' }));
    expect(hook.getCurrent().machineId).toBe('second');
    await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'second' }));
    expect(hook.getCurrent().machineId).toBe('first');
    expect(hook.getCurrent().targetMachines.map(machine => machine.id)).toEqual(['first']);
    await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'first' }));
    expect(hook.getCurrent().machineId).toBeNull();
    expect(hook.getCurrent().targetMachines).toEqual([]);
    expect(network.requests).toEqual([]);
});

it('resolves the focused Home inventory through its portable identity, keeps it through a failed list read, and retires it when signed out', async () => {
    const { scope } = await activateMigrationHome('inventory');
    const machine = createMachineFixture({ id: 'canonical-member', activeAt: Date.now() });
    storage.setState({ profileScope: scope, machines: {},
        machineListByServerId: { [scope.serverId]: [machine], 'foreign-home': [createMachineFixture({ id: 'foreign' })] },
        machineListStatusByServerId: { [scope.serverId]: 'idle', 'foreign-home': 'idle' } });
    const hook = await renderHook(() => useLegacyProfileMigrationTarget());
    await act(async () => { await vi.waitFor(() => {
        expect(hook.getCurrent().machineId).toBe(machine.id);
    }); });
    expect(hook.getCurrent().serverId).toBe(scope.serverId);
    expect(hook.getCurrent().targetMachines.map(target => target.id)).toEqual([machine.id]);
    await act(async () => storage.setState({ machineListStatusByServerId: { [scope.serverId]: 'error' } }));
    expect(hook.getCurrent().machineId).toBe(machine.id);
    await act(async () => storage.setState({ machineListStatusByServerId: { [scope.serverId]: 'signedOut' } }));
    expect(hook.getCurrent().machineId).toBeNull();
    expect(hook.getCurrent().targetMachines).toEqual([]);
});

it.each(['migration', 'conflict'] as const)('keeps %s target selection available until an explicit choice admits the review', async kind => {
    const { scope } = await activateMigrationHome(`flow-${kind}`);
    const machines = ['first', 'second'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
    storage.setState({ profileScope: scope, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    const [{ LegacyProfileMigrationFlow }, { LegacyProfileMigrationConflictFlow }, { LegacyProfileMigrationReview },
        { LegacyProfileMigrationConflictReview }, { SessionMachineField }] = await Promise.all([
        import('./LegacyProfileMigrationFlow'), import('./LegacyProfileMigrationConflictFlow'), import('./LegacyProfileMigrationReview'),
        import('./LegacyProfileMigrationConflictReview'), import('@/components/sessions/new/placement/SessionPlacementChips'),
    ]);
    const profile = AIBackendProfileSchema.parse({ id: 'legacy', name: 'Legacy profile' });
    const conflict = ProviderSettingsMigrationPendingConflictV1Schema.parse({ v: 1,
        sourceProfileId: profile.id, contributionKey: 'acme.provider/provider', existingConnectionId: 'pc_existing',
        kinds: ['credential_binding'], modelChoices: [], detectedAt: 1,
        candidateFingerprint: `legacy-profile-migration-conflict:v1:${'a'.repeat(43)}` });
    const onClose = () => {};
    const screen = await renderScreen(kind === 'migration'
        ? <LegacyProfileMigrationFlow profile={profile} secretBindings={{}} onClose={onClose} />
        : <LegacyProfileMigrationConflictFlow profileName={profile.name} conflict={conflict} onClose={onClose} />);
    const review = kind === 'migration' ? LegacyProfileMigrationReview : LegacyProfileMigrationConflictReview;
    await act(async () => { await vi.waitFor(() => {
        expect(screen.findAllByType(SessionMachineField)).toHaveLength(1);
        expect(screen.findByType(SessionMachineField).props.machineId).toBeNull();
        expect(screen.findAllByType(review)).toHaveLength(0);
    }); });
    await act(async () => screen.findByType(SessionMachineField).props.onSelectMachine(machines[1]!));
    expect(screen.findByType(review).props.machineId).toBe('second');
    await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'second' }));
    expect(screen.findByType(review).props.machineId).toBe('first');
    expect(network.requests).toEqual([]);
});

it.each(['home', 'account'] as const)('does not carry an explicit preference across a %s change with matching machine ids', async kind => {
    const first = await activateMigrationHome(`preference-${kind}`);
    const machines = ['first', 'second'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
    storage.setState({ profileScope: first.scope, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [first.scope.serverId]: machines }, machineListStatusByServerId: { [first.scope.serverId]: 'idle' } });
    const hook = await renderHook(() => ({ target: useLegacyProfileMigrationTarget(), snapshots: useAllProfileMachineInventorySnapshots() }));
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().target.targetMachines).toHaveLength(2)); });
    await act(async () => hook.getCurrent().target.setPreferredMachineId('second'));
    expect(hook.getCurrent().target.machineId).toBe('second');
    let next = first;
    await act(async () => {
        next = await activateMigrationHome(kind === 'home' ? 'preference-next-home' : `preference-${kind}`, 'next-account');
        storage.setState({ profileScope: next.scope, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [next.scope.serverId]: machines }, machineListStatusByServerId: { [next.scope.serverId]: 'idle' } });
    });
    await act(async () => { await vi.waitFor(() => {
        expect(hook.getCurrent().snapshots.find(snapshot => snapshot.kind === 'resolved'
            && snapshot.serverIdentityId === next.scope.serverId)).toMatchObject({ accountId: next.scope.accountId });
        expect(hook.getCurrent().target.targetMachines).toHaveLength(2);
    }); });
    expect(hook.getCurrent().target.machineId).toBeNull();
});
