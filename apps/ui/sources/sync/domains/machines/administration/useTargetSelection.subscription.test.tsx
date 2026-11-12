import { act } from 'react-test-renderer';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionFixture, createRenderCommitCounter, renderHook, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary, type SessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import {
    removeServerProfile,
    setActiveServerId,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import * as machineDisplayNames from '@/utils/sessions/machineDisplayNames';

import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from './selectionPreferences';
import { useMachineAdministrationExecutionTargetBinding } from './useExecutionTargetBinding';
import { useMachineAdministrationTargetSelection } from './useTargetSelection';
import { useManagedControllerScope } from '@/components/settings/machines/managed/useManagedControllerScope';
import { createManagedControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';

// The transport is the boundary; credential, inventory and target admission stay real.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

// Direct store seeding bypasses applyMachines, which normally publishes the Home's presence answer.
function createPublishedMachineFixture(overrides: Parameters<typeof createMachineFixture>[0] = {}) {
    const machine = createMachineFixture(overrides);
    publishMachineActivity(machine, { active: machine.active, activeAt: machine.activeAt }, []);
    return machine;
}

let network: SessionOpsNetworkBoundary;
beforeEach(async () => { network = await installSessionOpsNetworkBoundary(); });
afterEach(async () => {
    standardCleanup();
    await network.dispose();
    publishAppliedActiveServerRuntimeAvailability(false);
});

describe('machine administration target demand', () => {
    it('resolves the initial controller once across availability waves and never replaces a person\'s choice', async () => {
        const previous = storage.getState();
        const home = await network.addHome('https://administration-arrival-waves.example.test', 'arrival-owner', {
            serverIdentityId: 'srv_arrival_waves',
        });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: 'srv_arrival_waves', accountId: home.accountId };
        const machines = ['first', 'second', 'third'].map(id => createManagedControllerMachineFixture({
            id, installationId: `${id}-installation`, active: false, activeAt: 0,
        }));
        let inventoryReads = 0;
        network.setHttpResponder(async input => {
            if (new URL(String(input)).pathname !== '/v1/machines/managed/actions/list') return null;
            inventoryReads += 1;
            return Response.json({ machines: [] });
        });
        try {
            storage.setState(state => ({ profileScope: scope, settingsScope: scope,
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: {} },
                machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' } }));
            const publishWave = async (onlineIds: readonly string[]) => act(async () => {
                for (const machine of machines) publishMachineActivity(machine, {
                    active: onlineIds.includes(machine.id), activeAt: onlineIds.includes(machine.id) ? Date.now() : 0,
                }, []);
            });
            await publishWave([]);
            const selections: (string | undefined)[] = [];
            const hook = await renderHook(() => {
                const current = useManagedControllerScope({ serverId: home.id, testIDPrefix: 'arrival.scope' });
                if (selections.at(-1) !== current.controller?.machineId) selections.push(current.controller?.machineId);
                return current;
            });
            try {
                expect(hook.getCurrent().controller).toBeUndefined();
                await publishWave(['first']);
                expect(hook.getCurrent().controller?.machineId).toBe('first');
                await publishWave(['second']);
                expect(hook.getCurrent().controller?.machineId).toBe('first');
                expect(hook.getCurrent().selection?.state.kind).toBe('offline');
                await publishWave(['first', 'second', 'third']);
                expect(selections).toEqual(['first']);
                const target = { serverIdentityId: scope.serverId, machineId: 'second' };
                await act(async () => hook.getCurrent().selection?.selectTarget(target));
                expect(hook.getCurrent().controller?.machineId).toBe('second');
                await publishWave(['first', 'third']);
                expect(hook.getCurrent().controller?.machineId).toBe('second');
                expect(hook.getCurrent().selection?.state.kind).toBe('offline');
                await publishWave(['second', 'third']);
                expect(selections).toEqual(['first', 'second']);
                expect(inventoryReads).toBe(0);
                expect(storage.getState().settings.machineAdministrationTargetsLocalV1).toEqual({});
            } finally { await hook.unmount(); }
        } finally { storage.setState(previous); await removeServerProfile(home.id); }
    });

    it('drops a confirmed-absent managed enrollment from choices while retaining its saved missing selection', async () => {
        const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const { createDeferred, flushHookEffects } = await import('@/dev/testkit');
        const { useManagedMachineInventory } = await import('@/components/settings/machines/managed/useManagedMachineInventory');
        const { useMachineAdministrationTargetPickerRows } = await import('./useTargetSelection');
        const previous = storage.getState();
        const home = await network.addHome('https://administration-absent.example.test', 'absence-owner', {
            serverIdentityId: 'srv_picker_absent',
        });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const target = { serverIdentityId: 'srv_picker_absent', machineId: 'managed-enrollment' };
        const machines = [target.machineId, 'ordinary-offline'].map(id => createMachineFixture({ id, active: false }));
        const resource = ManagedMachineV1Schema.parse({
            id: 'managed-resource', homeId: target.serverIdentityId, custodianAccountId: home.accountId,
            enrolledMachineId: target.machineId,
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' },
            allocation: 'confirmed-absent', creationState: 'active', desired: 'delete', desiredWhen: 'now',
            intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 1, availability: 'absent' },
        });
        const census = createDeferred<Response>();
        let reads = 0;
        network.setHttpResponder(async input => {
            if (new URL(String(input)).pathname !== '/v1/machines/managed/actions/list') return null;
            reads += 1;
            return census.promise;
        });
        try {
            const scope = { serverId: home.id, accountId: home.accountId };
            storage.setState(state => ({ profileScope: scope, settingsScope: scope,
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: { providers: target } } }));
            storage.getState().applyMachines(machines, true, { sourceServerId: home.id });
            storage.getState().markMachineListSettled(home.id);
            const hook = await renderHook(() => ({
                managed: useManagedMachineInventory([home.id]),
                selection: useMachineAdministrationTargetSelection('providers'),
                choices: useMachineAdministrationTargetPickerRows(),
            }));
            try {
                expect(hook.getCurrent().selection.pickerRows.map(row => row.machine.id)).toContain(target.machineId);
                census.resolve(Response.json({ machines: [resource] }));
                await flushHookEffects({ cycles: 30 });
                expect(hook.getCurrent().managed.entries[target.serverIdentityId]?.status).toBe('ready');
                for (const rows of [hook.getCurrent().selection.pickerRows, hook.getCurrent().choices]) {
                    expect(rows.map(row => row.machine.id)).toEqual(['ordinary-offline']);
                }
                expect(hook.getCurrent().selection.state).toMatchObject({ kind: 'missing', target,
                    snapshot: { availability: 'missing' } });
                // Fresh enrollment presence cannot override the resource owner's absence receipt.
                await act(async () => storage.getState().applyMachines([
                    { ...machines[0]!, active: true, activeAt: Date.now(), updatedAt: Date.now() },
                ], false, { sourceServerId: home.id }));
                expect(hook.getCurrent().selection.state).toMatchObject({ kind: 'missing', target });
                expect(hook.getCurrent().selection.pickerRows.map(row => row.machine.id)).toEqual(['ordinary-offline']);
                expect(storage.getState().settings.machineAdministrationTargetsLocalV1.providers).toEqual(target);
                expect(reads).toBe(1);
            } finally { census.resolve(Response.json({ machines: [resource] })); await hook.unmount(); }
        } finally { storage.setState(previous); await removeServerProfile(home.id); }
    });

    it('offers 137-Machine census choices online first by name, retains a removed selection and does no sorting on offline heartbeats', async () => {
        const { createElement } = await import('react');
        const { t } = await import('@/text');
        const machineOrder = await import('@/sync/domains/machines/machineListOrder');
        const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');
        const previous = storage.getState();
        const home = await network.addHome('https://administration-picker-order.example.test', 'picker-owner', {
            serverIdentityId: 'srv_picker_order',
        });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const now = Date.now();
        const machines = Array.from({ length: 137 }, (_, index) => createMachineFixture({
            id: `picker-${String(index).padStart(3, '0')}`, active: index % 10 === 0, activeAt: now,
            presenceProtocolVersion: 1,
            revokedAt: index === 1 ? now : null,
            replacedByMachineId: index === 2 ? 'picker-000' : null,
            metadata: { ...createMachineFixture().metadata!, displayName: `Computer ${String(137 - index).padStart(3, '0')}` },
        }));
        const target = { serverIdentityId: 'srv_picker_order', machineId: machines[1]!.id };
        try {
            const scope = { serverId: home.id, accountId: home.accountId };
            storage.setState(state => ({ profileScope: scope, settingsScope: scope,
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: { providers: target } } }));
            storage.getState().applyMachines(machines, true, { sourceServerId: home.id });
            storage.getState().markMachineListSettled(home.id);
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('providers'));
            try {
                const initial = hook.getCurrent();
                expect(initial.pickerRows).toHaveLength(135);
                const online = initial.pickerRows.filter(row => row.candidate.availability === 'online');
                expect(online).toHaveLength(14);
                expect(initial.pickerRows.slice(0, 14)).toEqual(online);
                for (const rows of [online, initial.pickerRows.slice(14)]) {
                    const names = rows.map(row => row.candidate.displayName);
                    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
                }
                expect(initial.state).toMatchObject({ kind: 'revoked', target });
                const screen = await renderScreen(createElement(MachineAdministrationTargetSelector, {
                    selection: initial, testIDPrefix: 'census.target',
                }));
                try {
                    expect(screen.findHostByTestId('census.target.current')?.props.accessibilityLabel).toContain(t('settingsPlugins.targetSelection.revoked'));
                    await screen.pressByTestIdAsync('census.target.current');
                    expect(screen.findHostByTestId(`census.target.picker-option:${machines[1]!.id}`)).toBeNull();
                    expect(screen.findHostByTestId(`census.target.picker-option:${machines[2]!.id}`)).toBeNull();
                    expect(screen.findHostByTestId('census.target.picker-option:picker-130')).not.toBeNull();
                } finally { await screen.unmount(); }
                // Count the real Machine ordering work, excluding unrelated profile/transport sorts.
                const sorts = vi.spyOn(machineOrder, 'compareMachineListOrder');
                try {
                    for (let tick = 1; tick <= 10; tick += 1) {
                        await act(async () => storage.getState().applyMachineActivityUpdates([{ id: machines[3]!.id,
                            active: false, activeAt: now + tick }], { sourceServerId: home.id }));
                    }
                    expect(sorts).toHaveBeenCalledTimes(0);
                    expect(hook.getCurrent().pickerRows).toBe(initial.pickerRows);
                    await act(async () => storage.getState().applyMachineActivityUpdates([{ id: machines[3]!.id,
                        active: true, activeAt: Date.now() }], { sourceServerId: home.id }));
                    expect(sorts).toHaveBeenCalled();
                    const next = hook.getCurrent().pickerRows;
                    expect(next.slice(0, 15).every(row => row.candidate.availability === 'online')).toBe(true);
                    expect(next.slice(0, 15).some(row => row.machine.id === machines[3]!.id)).toBe(true);
                    expect(next.find(row => row.machine.id === machines[4]!.id)).toBe(initial.pickerRows.find(row => row.machine.id === machines[4]!.id));
                } finally { sorts.mockRestore(); }
                const locked = { ...machines[4]!, availability: { kind: 'locked' as const, reason: 'decryption_failed' as const } };
                await act(async () => storage.getState().applyMachines([locked], false, { sourceServerId: home.id }));
                expect(hook.getCurrent().pickerRows.some(row => row.machine.id === locked.id)).toBe(true);
                await act(async () => storage.getState().applyMachines([{ ...locked, revokedAt: now }], false, { sourceServerId: home.id }));
                expect(hook.getCurrent().pickerRows.some(row => row.machine.id === locked.id)).toBe(false);
                await act(async () => storage.getState().applyMachines(machines.filter(row => row.id !== target.machineId), true, { sourceServerId: home.id }));
                expect(hook.getCurrent().state).toMatchObject({ kind: 'missing', target });
            } finally { await hook.unmount(); }
        } finally { storage.setState(previous); await removeServerProfile(home.id); }
    });
    it('keeps Providers quiet for unrelated Machine metadata and Session arrivals while labels and eligibility stay live', async () => {
        const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');
        const previous = storage.getState();
        const home = await network.addHome('https://providers-target-facts.example.test', 'providers-target-owner', {
            serverIdentityId: 'srv_providers_target_facts',
        });
        const scope = { serverId: home.id, accountId: home.accountId };
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        let machine = createMachineFixture({ id: 'provider-target', activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, displayName: 'Provider target' } });
        const target = { serverIdentityId: 'srv_providers_target_facts', machineId: machine.id };
        try {
            storage.setState(state => ({ profileScope: scope, settingsScope: scope,
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: { providers: target } } }));
            storage.getState().applyMachines([machine], true, { sourceServerId: home.id });
            storage.getState().markMachineListSettled(home.id);
            const counter = createRenderCommitCounter();
            const hook = await renderHook(() => {
                useRenderCommitCounter(counter);
                return useProviderSettingsTarget();
            });
            try {
                await vi.waitFor(() => expect(hook.getCurrent().machineId).toBe(machine.id));
                const baseline = hook.getCurrent();
                counter.reset();
                for (let index = 1; index <= 10; index += 1) {
                    machine = { ...machine, metadataVersion: machine.metadataVersion + 1,
                        updatedAt: machine.updatedAt + 1,
                        metadata: { ...machine.metadata!, happyCliVersion: `unrelated-${index}` } };
                    await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: home.id }));
                }
                const machineCounts = counter.read();
                counter.reset();
                for (let index = 1; index <= 10; index += 1) {
                    await act(async () => storage.getState().applySessions([createSessionFixture({
                        id: 'providers-unrelated-session', seq: index, updatedAt: index,
                    })]));
                }
                expect({ machine: machineCounts, session: counter.read() }).toEqual({
                    machine: { renders: 0, commits: 0 }, session: { renders: 0, commits: 0 },
                });
                expect(hook.getCurrent()).toBe(baseline);
                machine = { ...machine, metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, displayName: 'Renamed provider target' } };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: home.id }));
                expect(counter.read().renders).toBe(1);
                expect(hook.getCurrent().machineRows[0]?.displayName).toBe('Renamed provider target');
                expect(hook.getCurrent().resolveCurrentTarget()).toEqual({ machineId: machine.id, serverId: home.id });
                counter.reset();
                machine = { ...machine, revokedAt: Date.now() };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: home.id }));
                expect(counter.read().renders).toBe(1);
                expect(hook.getCurrent().machineRows).toEqual([]);
                expect(hook.getCurrent().resolveCurrentTarget()).toBeNull();
            } finally { await hook.unmount(); }
        } finally { storage.setState(previous); await removeServerProfile(home.id); }
    });
    it('keeps an exact source Account selection inside its Home and retires it on Account replacement', async () => {
        const syncRuntime = await import('@/sync/syncEngine');
        const requiredSync: typeof import('@/sync/sync') = createRequire(import.meta.url)('../../../sync.ts');
        requiredSync.registerSyncRuntime(syncRuntime);
        const previous = storage.getState();
        const sourceUrl = 'https://administration-source-account.example.test';
        const source = await network.addHome(sourceUrl, 'source-owner', { serverIdentityId: 'srv_source_account' });
        const other = await network.addHome('https://administration-foreign-account.example.test', 'foreign-owner', {
            serverIdentityId: 'srv_foreign_account',
        });
        const accountScope = { serverId: source.id, accountId: source.accountId };
        const sourceTarget = { serverIdentityId: 'srv_source_account', machineId: 'source-machine' };
        const foreignTarget = { serverIdentityId: 'srv_foreign_account', machineId: 'foreign-machine' };
        const sourceMachine = createPublishedMachineFixture({ id: sourceTarget.machineId, activeAt: Date.now() });
        const foreignMachine = createPublishedMachineFixture({ id: foreignTarget.machineId, activeAt: Date.now() });
        await setActiveServerId(other.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        try {
            storage.setState(state => ({ profileScope: { serverId: other.id, accountId: other.accountId },
                settingsScope: { serverId: other.id, accountId: other.accountId }, machines: { [foreignMachine.id]: foreignMachine },
                machineListByServerId: { [source.id]: [sourceMachine], [other.id]: [foreignMachine] },
                machineListStatusByServerId: { [source.id]: 'idle', [other.id]: 'idle' },
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: { plugins: foreignTarget } } }));
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('plugins', { accountScope }));
            try {
                await vi.waitFor(() => expect(hook.getCurrent().pickerRows.map(row => row.candidate.target)).toEqual([sourceTarget]));
                expect(hook.getCurrent().selectedTarget).toEqual(foreignTarget);
                expect(hook.getCurrent().canExecute).toBe(false);
                expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
                await act(async () => storage.setState(state => ({ settings: { ...state.settings,
                    machineAdministrationTargetsLocalV1: {} } })));
                await vi.waitFor(() => expect(hook.getCurrent().selectedTarget).toEqual(sourceTarget));
                expect(hook.getCurrent().resolveExecutionTarget()?.target).toEqual(sourceTarget);
                await act(async () => network.setAccount(sourceUrl, 'replacement-owner'));
                // A live machine in the same Home cannot lend a replacement Account authority
                // over a template captured from the original Account.
                await act(async () => storage.setState({ machineListByServerId: {
                    [source.id]: [sourceMachine], [other.id]: [foreignMachine],
                }, machineListStatusByServerId: { [source.id]: 'idle', [other.id]: 'idle' } }));
                await vi.waitFor(() => expect(hook.getCurrent().pickerRows).toEqual([]));
                expect(hook.getCurrent().canExecute).toBe(false);
                expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
            } finally { await hook.unmount(); }
        } finally {
            storage.setState(previous);
            await removeServerProfile(source.id);
            await removeServerProfile(other.id);
        }
    });

    it('keeps the real Plugins target consumer settled across 196 Machine arrivals', async () => {
        const syncRuntime = await import('@/sync/syncEngine');
        const requiredSync: typeof import('@/sync/sync') = createRequire(import.meta.url)('../../../sync.ts');
        requiredSync.registerSyncRuntime(syncRuntime);
        const { usePluginsAdministrationTarget } = await import('@/components/settings/plugins/model/usePluginsAdministrationTarget');
        const previous = storage.getState();
        const url = 'https://plugins-hydration-consumer.example.test';
        await upsertServerProfile({ serverUrl: url, name: 'Hydration consumer' });
        const profile = await setServerProfileIdentityForUrl(url, 'srv_hydration_consumer');
        if (!profile) throw new Error('Expected Home');
        const scope = { serverId: profile.id, accountId: 'hydration-consumer-account' };
        await network.addHome(url, scope.accountId);
        await setActiveServerId(profile.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const target = { serverIdentityId: profile.serverIdentityId!, machineId: 'hydration-0' };
        const rows = Array.from({ length: 196 }, (_, index) => createMachineFixture({ id: `hydration-${index}`,
            activeAt: Date.now(), metadata: null, availability: undefined }));
        try {
            storage.setState(state => ({ profileScope: scope, settingsScope: scope,
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: {
                    [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins]: target,
                } } }));
            storage.getState().applyMachines(rows, true, { sourceServerId: profile.id });
            storage.getState().markMachineListSettled(profile.id);
            const renders = createRenderCommitCounter();
            const hook = await renderHook(() => {
                useRenderCommitCounter(renders);
                return usePluginsAdministrationTarget({ enabled: false });
            });
            try {
                expect(hook.getCurrent().administration.selection.selectedTarget).toEqual(target);
                await vi.waitFor(() => expect(hook.getCurrent().capabilitiesAccountId).toBe(scope.accountId));
                renders.reset();
                for (const row of rows) {
                    await act(async () => storage.getState().applyMachines([{ ...row,
                        metadata: createMachineFixture().metadata, availability: { kind: 'available' },
                    }], false, { sourceServerId: profile.id }));
                }
                expect(hook.getCurrent().administration.selection.selectedTarget).toEqual(target);
                expect(hook.getCurrent().administration.selection.pickerRows).toHaveLength(rows.length);
                expect(hook.getCurrent().daemonTransportOnline).toBe(true);
                expect(renders.read().renders).toBe(renders.read().commits);
            } finally { await hook.unmount(); }
        } finally { storage.setState(previous); await removeServerProfile(profile.id); }
    });

    it('remembers a sole automatic target as navigation state without notifying Settings consumers', async () => {
        const syncRuntime = await import('@/sync/syncEngine');
        const requiredSync: typeof import('@/sync/sync') = createRequire(import.meta.url)('../../../sync.ts');
        requiredSync.registerSyncRuntime(syncRuntime);
        const previous = storage.getState();
        const url = 'https://administration-automatic-memory.example.test';
        await upsertServerProfile({ serverUrl: url, name: 'Automatic target' });
        const profile = await setServerProfileIdentityForUrl(url, 'srv_automatic_memory');
        if (!profile) throw new Error('Expected Home');
        const scope = { serverId: profile.id, accountId: 'automatic-target-account' };
        const machine = createMachineFixture({ id: 'sole-machine', activeAt: Date.now(), presenceProtocolVersion: 1 });
        await network.addHome(url, scope.accountId);
        await setActiveServerId(profile.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        try {
            storage.setState(state => ({ profileScope: scope, settingsScope: scope,
                machineListByServerId: { [profile.id]: [machine] },
                machineListStatusByServerId: { [profile.id]: 'idle' },
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: {} } }));
            const settings = storage.getState().settings;
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('agents'));
            const target = { serverIdentityId: 'srv_automatic_memory', machineId: 'sole-machine' };
            // A retained active bit is not an answer; the same row becomes selectable on live publication.
            expect(hook.getCurrent().state.kind).toBe('unselected');
            expect(hook.getCurrent().candidates).toMatchObject([{ availability: 'unknown' }]);
            expect(hook.getCurrent().selectedTarget).toBeNull();
            expect(hook.getCurrent().canExecute).toBe(false);
            expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
            await act(async () => publishMachineActivity(machine, { active: true, activeAt: machine.activeAt }, []));
            expect(hook.getCurrent().selectedTarget).toEqual(target);
            expect(hook.getCurrent().resolveExecutionTarget()?.target).toEqual(target);
            expect(storage.getState().settings).toBe(settings);
            await hook.unmount();
            const restored = await renderHook(() => useMachineAdministrationTargetSelection('agents', { allowSoleCandidate: false }));
            expect(restored.getCurrent().selectedTarget).toEqual(target);
            await restored.unmount();
        } finally { storage.setState(previous); await removeServerProfile(profile.id); }
    });
    it.each(['select', 'clear'] as const)('admits explicit %s through Settings Actions before changing an unavailable route', async (intent) => {
        const previous = storage.getState();
        const saved = { serverIdentityId: 'srv_route_recovery', machineId: 'chosen-machine' };
        const requested = { serverIdentityId: 'srv_route_recovery', machineId: 'missing-machine' };
        const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
        const account = await createSecretSettingsTestHarness({ accountId: 'route-recovery-account', serverIdentityId: saved.serverIdentityId,
            settings: settingsParse({ machineAdministrationTargetsLocalV1: { agents: saved },
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) });
        const scope = account.scope;
        try {
            storage.setState({
                settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: { agents: saved } },
                machineListByServerId: { [scope.serverId]: [createPublishedMachineFixture({ id: saved.machineId, activeAt: Date.now() }),
                    createPublishedMachineFixture({ id: 'other-machine', activeAt: Date.now() })] },
                machineListStatusByServerId: { [scope.serverId]: 'idle' },
            });
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('agents', { initialTarget: requested }));
            expect(hook.getCurrent().selectedTarget).toEqual(requested);
            expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
            await act(async () => hook.getCurrent().selectTarget({ ...saved, serverIdentityId: 'srv_wrong_home' }));
            expect(hook.getCurrent().selectedTarget).toEqual(requested);
            await act(async () => intent === 'select' ? hook.getCurrent().selectTarget(saved) : hook.getCurrent().clearTarget());
            expect(hook.getCurrent().selectedTarget).toEqual(requested);
            expect(storage.getState().settings.machineAdministrationTargetsLocalV1.agents).toEqual(saved);
            await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1 } })));
            await act(async () => intent === 'select' ? hook.getCurrent().selectTarget(saved) : hook.getCurrent().clearTarget());
            await vi.waitFor(() => expect(hook.getCurrent().selectedTarget).toEqual(intent === 'select' ? saved : null));
            if (intent === 'select') {
                await vi.waitFor(() => expect(hook.getCurrent().resolveExecutionTarget()?.target).toEqual(saved));
            } else {
                expect(hook.getCurrent().state.kind).toBe('unselected');
                expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
            }
            if (intent === 'select') {
                const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
                const execute = createFrontDoorActionExecute();
                for (const surface of ['agent', 'cli'] as const) {
                    const input = { anchor: 'machines.administrationTarget', key: `parity.${surface}`, value: saved };
                    const context = { surface, authority: 'account_automation', serverId: scope.serverId, expectedAccountId: scope.accountId } as const;
                    await act(async () => {
                        expect(await execute('settings.set', input, context)).toMatchObject({ ok: true });
                    });
                    expect(storage.getState().settings.machineAdministrationTargetsLocalV1[input.key]).toEqual(saved);
                    expect(storage.getState().settings.machineAdministrationTargetsLocalV1.agents).toEqual(saved);
                    expect(await execute('settings.get', { anchor: input.anchor, key: input.key }, context))
                        .toMatchObject({ ok: true, result: { value: saved } });
                    expect(await execute('settings.get', { anchor: input.anchor, key: input.key, includeVersion: true }, context))
                        .toMatchObject({ ok: false, errorCode: 'setting_conditional_mutation_unsupported' });
                    await act(async () => {
                        expect(await execute('settings.set', { ...input, value: null }, context)).toMatchObject({ ok: true });
                    });
                    expect(storage.getState().settings.machineAdministrationTargetsLocalV1[input.key]).toBeUndefined();
                }
            }
            await hook.unmount();
        } finally { standardCleanup(); await account.dispose(); storage.setState(previous); }
    });
    it('uses an available route target transiently and persists only an explicit selection', async () => {
        const previous = storage.getState();
        const saved = { serverIdentityId: 'srv_route_transient', machineId: 'chosen-machine' };
        const requested = { ...saved, machineId: 'route-machine' };
        const chosen = { ...saved, machineId: 'next-machine' };
        const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
        const account = await createSecretSettingsTestHarness({ accountId: 'route-transient-account', serverIdentityId: saved.serverIdentityId,
            settings: settingsParse({ machineAdministrationTargetsLocalV1: { agents: saved } }) });
        try {
            storage.setState({
                settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: { agents: saved } },
                machineListByServerId: { [account.scope.serverId]: [saved, requested, chosen].map(target =>
                    createPublishedMachineFixture({ id: target.machineId, activeAt: Date.now() })) },
                machineListStatusByServerId: { [account.scope.serverId]: 'idle' },
            });
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('agents', { initialTarget: requested }));
            try {
                expect(hook.getCurrent().selectedTarget).toEqual(requested);
                expect(hook.getCurrent().resolveExecutionTarget()?.target).toEqual(requested);
                expect(storage.getState().settings.machineAdministrationTargetsLocalV1.agents).toEqual(saved);
                await act(async () => hook.getCurrent().selectTarget(chosen));
                expect(hook.getCurrent().selectedTarget).toEqual(chosen);
                expect(storage.getState().settings.machineAdministrationTargetsLocalV1.agents).toEqual(chosen);
            } finally { await hook.unmount(); }
            const reopened = await renderHook(() => useMachineAdministrationTargetSelection('agents'));
            try { expect(reopened.getCurrent().selectedTarget).toEqual(chosen); }
            finally { await reopened.unmount(); }
        } finally { standardCleanup(); await account.dispose(); storage.setState(previous); }
    });
    it('keeps an unavailable explicit route target instead of borrowing the saved Machine on another Home', async () => {
        const previous = storage.getState();
        const saved = { serverIdentityId: 'srv_saved', machineId: 'same-machine' };
        const requested = { serverIdentityId: 'srv_requested', machineId: 'same-machine' };
        try {
            storage.setState(state => ({ settings: { ...state.settings,
                machineAdministrationTargetsLocalV1: { agents: saved } } }));
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('agents', {
                enabled: false, initialTarget: requested,
            }));
            expect(hook.getCurrent().selectedTarget).toEqual(requested);
            expect(hook.getCurrent().state).toMatchObject({ kind: 'missing', target: requested });
            expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
            expect(storage.getState().settings.machineAdministrationTargetsLocalV1.agents).toEqual(saved);
        } finally { storage.setState(previous); }
    });
    it('leaves Plugin administration unresolved when more than one Account machine is eligible', async () => {
        // Vitest's ESM graph and the lazy Node require boundary have separate
        // module instances. Register the real engine in the latter, as app entry does.
        const syncRuntime = await import('@/sync/syncEngine');
        const requiredSync: typeof import('@/sync/sync') = createRequire(import.meta.url)('../../../sync.ts');
        requiredSync.registerSyncRuntime(syncRuntime);
        const previous = storage.getState();
        const serverUrl = 'https://plugin-initial-target.example.test';
        await upsertServerProfile({ serverUrl, name: 'Plugin initial target' });
        const profile = await setServerProfileIdentityForUrl(serverUrl, 'srv_plugin_initial_target');
        if (!profile) throw new Error('Test profile was not created');
        const scope = { serverId: profile.id, accountId: 'plugin-initial-account' };
        await network.addHome(serverUrl, scope.accountId);
        await setActiveServerId(profile.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const machine = createPublishedMachineFixture({ id: 'online-plugin-machine', activeAt: Date.now() });
        const other = createPublishedMachineFixture({ id: 'other-plugin-machine', activeAt: Date.now() });
        const selectionKey = MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins;
        try {
            storage.setState((state) => ({
                profile: { ...state.profile, id: scope.accountId },
                profileScope: scope,
                settingsScope: scope,
                machineListByServerId: { [profile.id]: [other, machine] },
                machineListStatusByServerId: { [profile.id]: 'idle' },
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: {} },
            }));
            // Observe actual projection work; the spy delegates to the real name owner.
            const names = vi.spyOn(machineDisplayNames, 'resolveMachineDisplayNameParts');
            let maxNameProjectionsPerRender = 0;
            const hook = await renderHook(() => {
                const before = names.mock.calls.length;
                const selection = useMachineAdministrationTargetSelection(selectionKey);
                maxNameProjectionsPerRender = Math.max(maxNameProjectionsPerRender, names.mock.calls.length - before);
                return selection;
            });
            try {
                expect(hook.getCurrent().pickerRows).toHaveLength(2);
                expect(hook.getCurrent().candidates.map(candidate => candidate.availability)).toEqual(['online', 'online']);
                expect(maxNameProjectionsPerRender).toBe(1);
                expect(hook.getCurrent().pickerRows.every(row => hook.getCurrent().candidates.includes(row.candidate))).toBe(true);
                expect(hook.getCurrent().selectedTarget).toBeNull();
                expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
                expect(storage.getState().settings.machineAdministrationTargetsLocalV1[selectionKey]).toBeUndefined();
                await act(async () => storage.setState({ machineListByServerId: { [profile.id]: [other,
                    createPublishedMachineFixture({ ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed machine' } }),
                ] } }));
                const updated = hook.getCurrent();
                expect(updated.candidates.find(candidate => candidate.target.machineId === machine.id)?.displayName).toBe('Renamed machine');
                expect(updated.pickerRows.every(row => updated.candidates.includes(row.candidate))).toBe(true);
            } finally {
                await hook.unmount();
                names.mockRestore();
            }
        } finally {
            storage.setState(previous);
            await removeServerProfile(profile.id);
        }
    });

    it('uses this device target independently of the Account policy document', async () => {
        const previous = storage.getState();
        const local = { serverIdentityId: 'srv_one', machineId: 'local-machine' };
        try {
            storage.setState((state) => ({ settings: {
                ...state.settings,
                machineAdministrationTargetsLocalV1: { agents: local },
                machineAdministrationSelectionsV1: {
                    v: 1, pluginExecutionOriginsByPluginId: {},
                },
            } }));
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('agents', {
                enabled: false, allowSoleCandidate: false,
            }));
            expect(hook.getCurrent().selectedTarget).toEqual(local);
            await act(async () => storage.setState((state) => ({ settings: {
                ...state.settings, machineAdministrationTargetsLocalV1: {},
            } })));
            expect(hook.getCurrent().selectedTarget).toBeNull();
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('rejects captured work after exact selection, daemon lifetime, or live inventory changes', async () => {
        const previousState = storage.getState();
        const serverUrl = 'https://administration-currentness.example.test';
        await upsertServerProfile({ serverUrl, name: 'Administration currentness' });
        const profile = await setServerProfileIdentityForUrl(serverUrl, 'srv_administration_currentness');
        if (!profile) throw new Error('Test profile was not created');
        const selectionKey = MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.providers;
        const targetA = { serverIdentityId: profile.serverIdentityId!, machineId: 'machine-a' };
        const targetB = { serverIdentityId: profile.serverIdentityId!, machineId: 'machine-b' };
        const machineA = createPublishedMachineFixture({ id: targetA.machineId, activeAt: Date.now(), daemonStateVersion: 1 });
        const machineB = createPublishedMachineFixture({ id: targetB.machineId, activeAt: Date.now(), daemonStateVersion: 1 });
        const scope = { serverId: profile.id, accountId: 'administration-currentness-account' };
        await network.addHome(serverUrl, scope.accountId);
        await setActiveServerId(profile.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());

        try {
            storage.setState((state) => ({
                isDataReady: true,
                profileScope: scope,
                settingsScope: scope,
                machineListByServerId: { [profile.id]: [machineA, machineB] },
                machineListStatusByServerId: { [profile.id]: 'idle' },
                settings: {
                    ...state.settings,
                    machineAdministrationTargetsLocalV1: { [selectionKey]: targetA },
                },
            }));
            const hook = await renderHook(
                ({ enabled }: { enabled: boolean }) => {
                    const selection = useMachineAdministrationTargetSelection(
                        selectionKey, { enabled, allowSoleCandidate: false },
                    );
                    return useMachineAdministrationExecutionTargetBinding(selection);
                },
                { initialProps: { enabled: true } },
            );
            const initialBinding = hook.getCurrent();
            const requestedSelection = initialBinding.selectionKey;
            const capturedA = initialBinding.resolveExactExecutionTarget(targetA);
            if (!capturedA) throw new Error('Initial target did not resolve');
            expect(capturedA.target).toEqual(targetA);
            expect(initialBinding.resolveExactExecutionTarget(targetB)).toBeNull();
            expect(initialBinding.resolveExactExecutionTarget({ ...targetA, serverIdentityId: 'another-server' })).toBeNull();
            expect(initialBinding.resolveExactExecutionTarget(null)).toBeNull();
            expect(initialBinding.isExecutionTargetCurrent(requestedSelection, capturedA)).toBe(true);

            for (const target of [targetB, targetA]) {
                await act(async () => {
                    storage.setState((state) => ({
                        settings: {
                            ...state.settings,
                            machineAdministrationTargetsLocalV1: { [selectionKey]: target },
                        },
                    }));
                });
                expect(initialBinding.resolveExactExecutionTarget(target)?.target).toEqual(target);
                expect(initialBinding.isSelectionCurrent(requestedSelection)).toBe(target === targetA);
                expect(initialBinding.isExecutionTargetCurrent(requestedSelection, capturedA)).toBe(false);
                expect(hook.getCurrent().resolveExactExecutionTarget).toBe(initialBinding.resolveExactExecutionTarget);
                expect(hook.getCurrent().isExecutionTargetCurrent).toBe(initialBinding.isExecutionTargetCurrent);
            }

            const returnedA = initialBinding.resolveExactExecutionTarget(targetA);
            if (!returnedA) throw new Error('Returned target did not resolve');
            expect(returnedA.selectionRevision).toBeGreaterThan(capturedA.selectionRevision ?? -1);
            await act(async () => {
                storage.setState({
                    machineListByServerId: {
                        [profile.id]: [createPublishedMachineFixture({ ...machineA, daemonStateVersion: 2 }), machineB],
                    },
                });
            });
            expect(initialBinding.isExecutionTargetCurrent(requestedSelection, returnedA)).toBe(false);

            await act(async () => {
                storage.setState({ machineListStatusByServerId: { [profile.id]: 'loading' } });
            });
            expect(initialBinding.resolveExactExecutionTarget(targetA)?.machine.daemonStateVersion).toBe(2);
            await act(async () => {
                storage.setState({ machineListByServerId: { [profile.id]: [createPublishedMachineFixture({
                    ...machineA, daemonStateVersion: 2,
                    keyBasis: { metadataVersion: machineA.metadataVersion + 1, daemonStateVersion: 2, dataEncryptionKey: machineA.dataEncryptionKey ?? null },
                }), machineB] } });
            });
            expect(initialBinding.resolveExactExecutionTarget(targetA)).toBeNull();
            await act(async () => {
                storage.setState({
                    machineListStatusByServerId: { [profile.id]: 'idle' },
                    machineListByServerId: { [profile.id]: [createPublishedMachineFixture({
                        ...machineA, metadataVersion: machineA.metadataVersion + 1, daemonStateVersion: 2,
                        keyBasis: { metadataVersion: machineA.metadataVersion + 1, daemonStateVersion: 2, dataEncryptionKey: machineA.dataEncryptionKey ?? null },
                    }), machineB] },
                });
            });
            expect(initialBinding.resolveExactExecutionTarget(targetA)?.machine.daemonStateVersion).toBe(2);
            await hook.rerender({ enabled: false });
            expect(initialBinding.resolveExactExecutionTarget(targetA)).toBeNull();
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            await removeServerProfile(profile.id);
        }
    });

    it('suspends detailed inventory while idle and resumes with the current exact target', async () => {
        const previousState = storage.getState();
        const serverUrl = 'https://memory-demand.example.test';
        await upsertServerProfile({ serverUrl, name: 'Memory demand' });
        const profile = await setServerProfileIdentityForUrl(serverUrl, 'srv_memory_demand');
        if (!profile) throw new Error('Test profile was not created');
        const target = { serverIdentityId: 'srv_memory_demand', machineId: 'memory-machine' };
        const machine = createPublishedMachineFixture({ id: target.machineId, activeAt: Date.now() });
        const selectionKey = MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory;
        const scope = { serverId: profile.id, accountId: 'memory-demand-account' };
        await network.addHome(serverUrl, scope.accountId);
        await setActiveServerId(profile.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());

        try {
            storage.setState((state) => ({
                isDataReady: true,
                profileScope: scope,
                settingsScope: scope,
                machineListByServerId: { [profile.id]: [machine] },
                machineListStatusByServerId: { [profile.id]: 'idle' },
                settings: {
                    ...state.settings,
                    machineAdministrationTargetsLocalV1: { [selectionKey]: target },
                },
            }));
            let renders = 0;
            const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
                renders += 1;
                return useMachineAdministrationTargetSelection(selectionKey, { enabled, allowSoleCandidate: false });
            }, { initialProps: { enabled: true }, flushOptions: { cycles: 1, turns: 4 } });
            expect(hook.getCurrent().canExecute).toBe(true);
            expect(hook.getCurrent().resolveExecutionTarget()?.machine.id).toBe(machine.id);

            await hook.rerender({ enabled: false });
            const settledRenders = renders;
            const latest = createPublishedMachineFixture({ ...machine, updatedAt: 2, activeAt: Date.now() + 1 });
            await act(async () => {
                storage.setState({
                    machineListByServerId: { [profile.id]: [latest] },
                    machineListStatusByServerId: { [profile.id]: 'loading' },
                });
            });
            expect(renders).toBe(settledRenders);
            expect(hook.getCurrent().pickerRows).toEqual([]);
            expect(hook.getCurrent().canExecute).toBe(false);
            expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();

            await act(async () => {
                storage.setState({ machineListStatusByServerId: { [profile.id]: 'idle' } });
            });
            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().selectedTarget).toEqual(target);
            expect(hook.getCurrent().canExecute).toBe(true);
            expect(hook.getCurrent().resolveExecutionTarget()?.machine).toBe(latest);
            expect(hook.getCurrent().pickerRows[0]?.machine.updatedAt).toBe(2);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            await removeServerProfile(profile.id);
        }
    });
});
