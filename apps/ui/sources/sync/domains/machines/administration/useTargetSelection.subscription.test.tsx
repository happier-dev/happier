import { act } from 'react-test-renderer';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
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

// The transport is the boundary; credential, inventory and target admission stay real.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

let network: SessionOpsNetworkBoundary;
beforeEach(async () => { network = await installSessionOpsNetworkBoundary(); });
afterEach(async () => {
    standardCleanup();
    await network.dispose();
    publishAppliedActiveServerRuntimeAvailability(false);
});

describe('machine administration target demand', () => {
    it.each(['select', 'clear'] as const)('remembers %s navigation past an unavailable route with Settings writes Off', async (intent) => {
        const syncRuntime = await import('@/sync/syncEngine');
        const requiredSync: typeof import('@/sync/sync') = createRequire(import.meta.url)('../../../sync.ts');
        requiredSync.registerSyncRuntime(syncRuntime);
        const previous = storage.getState();
        const serverUrl = 'https://administration-route-recovery.example.test';
        await upsertServerProfile({ serverUrl, name: 'Route recovery' });
        const profile = await setServerProfileIdentityForUrl(serverUrl, 'srv_route_recovery');
        if (!profile) throw new Error('Test profile was not created');
        const scope = { serverId: profile.id, accountId: 'route-recovery-account' };
        await network.addHome(serverUrl, scope.accountId);
        await setActiveServerId(profile.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const saved = { serverIdentityId: 'srv_route_recovery', machineId: 'chosen-machine' };
        const requested = { serverIdentityId: 'srv_route_recovery', machineId: 'missing-machine' };
        try {
            storage.setState(state => ({ profile: { ...state.profile, id: scope.accountId }, profileScope: scope, settingsScope: scope,
                machineListByServerId: { [profile.id]: [createMachineFixture({ id: saved.machineId, activeAt: Date.now() }),
                    createMachineFixture({ id: 'other-machine', activeAt: Date.now() })] },
                machineListStatusByServerId: { [profile.id]: 'idle' },
                settings: settingsParse({ ...state.settings, machineAdministrationTargetsLocalV1: { agents: saved },
                    actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) }));
            const hook = await renderHook(() => useMachineAdministrationTargetSelection('agents', { initialTarget: requested }));
            expect(hook.getCurrent().selectedTarget).toEqual(requested);
            expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
            await act(async () => hook.getCurrent().selectTarget({ ...saved, serverIdentityId: 'srv_wrong_home' }));
            expect(hook.getCurrent().selectedTarget).toEqual(requested);
            await act(async () => intent === 'select' ? hook.getCurrent().selectTarget(saved) : hook.getCurrent().clearTarget());
            await vi.waitFor(() => expect(hook.getCurrent().selectedTarget).toEqual(intent === 'select' ? saved : null));
            if (intent === 'select') {
                await vi.waitFor(() => expect(hook.getCurrent().resolveExecutionTarget()?.target).toEqual(saved));
            } else {
                expect(hook.getCurrent().state.kind).toBe('unselected');
                expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
            }
            await hook.unmount();
        } finally { storage.setState(previous); await removeServerProfile(profile.id); }
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
                    createMachineFixture({ id: target.machineId, activeAt: Date.now() })) },
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
        const machine = createMachineFixture({ id: 'online-plugin-machine', activeAt: Date.now() });
        const other = createMachineFixture({ id: 'other-plugin-machine', activeAt: Date.now() });
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
                expect(maxNameProjectionsPerRender).toBe(1);
                expect(hook.getCurrent().candidates.every((candidate, index) => candidate === hook.getCurrent().pickerRows[index]?.candidate)).toBe(true);
                expect(hook.getCurrent().selectedTarget).toBeNull();
                expect(hook.getCurrent().resolveExecutionTarget()).toBeNull();
                expect(storage.getState().settings.machineAdministrationTargetsLocalV1[selectionKey]).toBeUndefined();
                await act(async () => storage.setState({ machineListByServerId: { [profile.id]: [other,
                    createMachineFixture({ ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed machine' } }),
                ] } }));
                const updated = hook.getCurrent();
                expect(updated.candidates.find(candidate => candidate.target.machineId === machine.id)?.displayName).toBe('Renamed machine');
                expect(updated.candidates.every((candidate, index) => candidate === updated.pickerRows[index]?.candidate)).toBe(true);
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
        const machineA = createMachineFixture({ id: targetA.machineId, activeAt: Date.now(), daemonStateVersion: 1 });
        const machineB = createMachineFixture({ id: targetB.machineId, activeAt: Date.now(), daemonStateVersion: 1 });
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
                        [profile.id]: [{ ...machineA, daemonStateVersion: 2 }, machineB],
                    },
                });
            });
            expect(initialBinding.isExecutionTargetCurrent(requestedSelection, returnedA)).toBe(false);

            await act(async () => {
                storage.setState({ machineListStatusByServerId: { [profile.id]: 'loading' } });
            });
            expect(initialBinding.resolveExactExecutionTarget(targetA)?.machine.daemonStateVersion).toBe(2);
            await act(async () => {
                storage.setState({ machineListByServerId: { [profile.id]: [{
                    ...machineA, daemonStateVersion: 2,
                    keyBasis: { metadataVersion: machineA.metadataVersion + 1, daemonStateVersion: 2, dataEncryptionKey: machineA.dataEncryptionKey ?? null },
                }, machineB] } });
            });
            expect(initialBinding.resolveExactExecutionTarget(targetA)).toBeNull();
            await act(async () => {
                storage.setState({
                    machineListStatusByServerId: { [profile.id]: 'idle' },
                    machineListByServerId: { [profile.id]: [{
                        ...machineA, metadataVersion: machineA.metadataVersion + 1, daemonStateVersion: 2,
                        keyBasis: { metadataVersion: machineA.metadataVersion + 1, daemonStateVersion: 2, dataEncryptionKey: machineA.dataEncryptionKey ?? null },
                    }, machineB] },
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
        const machine = createMachineFixture({ id: target.machineId, activeAt: Date.now() });
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
            const latest = { ...machine, updatedAt: 2, activeAt: Date.now() + 1 };
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
