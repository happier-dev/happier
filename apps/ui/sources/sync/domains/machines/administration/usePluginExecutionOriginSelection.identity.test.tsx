import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { getPluginMachineExecutionOriginRef, type PluginMachineMaterializationV1 } from '@happier-dev/protocol';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';

import { usePluginMachineExecutionOriginSelection } from './usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin } from './pluginExecutionOrigin';

describe('execution-origin plugin identity with real Account and machine owners', () => {
    afterEach(async () => {
        await standardCleanup();
        clearPluginAccountAvailabilityProjection();
    });

    it('resolves a sole source afresh and withdraws execution on source retirement or Account change', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-source-target' };
        const serverIdentityId = 'srv_source_execution';
        const url = 'https://source-execution.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        const machine = createMachineFixture({ id: 'machine-source', active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId: 'acme.source',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } } };
        const source = { origin, version: '1.0.0', occurrenceId: 'source-occurrence', generation: 1, serverId: home.id };
        const candidates = [{ source, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        let currentSources: typeof candidates = candidates;
        let currentDefaults = [origin];
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.source',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            readSourceCandidates: () => currentSources, declaredDefaultOrigins: [origin],
            readDeclaredDefaultOrigins: () => currentDefaults }));
        expect(hook.getCurrent().selectedOrigin).toEqual(origin);
        expect(hook.getCurrent().machineCandidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { serverIdentityId, machineId: machine.id }, serverLabel: home.name }),
        ]));
        expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        const alternate = { ...candidates[0]!, source: { ...source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development' as const, registeredRootId: 'alternate-source-root' } } } } };
        currentSources = [...candidates, alternate];
        currentDefaults = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        currentSources = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        currentSources = candidates;
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: {
                v: 1, pluginExecutionOriginsByPluginId: { 'acme.source': origin },
            } } });
        });
        const machineFree = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.source',
            enabled: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates }));
        expect(machineFree.getCurrent()).toMatchObject({ candidates: [], machineCandidates: [], selectedOrigin: null,
            canExecute: false, state: { kind: 'selectionRequired', candidates: [] } });
        expect(machineFree.getCurrent().resolveExecutionOrigin()).toBeNull();
        await expect(machineFree.getCurrent().selectOrigin(origin)).resolves.toEqual({ status: 'unavailable' });
        await expect(machineFree.getCurrent().clearOrigin()).resolves.toEqual({ status: 'unavailable' });
        await machineFree.unmount();
        const incumbentResolve = hook.getCurrent().resolveExecutionOrigin;
        currentSources = [];
        await act(async () => { storage.setState({ settingsScope: { ...scope, accountId: 'account-switched' } }); });
        expect(incumbentResolve()).toBeNull();
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        await hook.unmount();
    });

    it('recomputes candidates and reasons on A-to-B-to-A without refreshing stable inputs', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-origin-identity' };
        storage.setState({ profileScope: scope });
        const materializationA: PluginMachineMaterializationV1 = {
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            pluginId: 'acme.plugin-a',
            version: '1.0.0',
            sourceClass: 'registryPackage',
            portableRelease: true,
            uiArtifacts: [],
            enabled: false,
            trustState: 'trusted',
            observedAt: 100,
        };
        const materializationB: PluginMachineMaterializationV1 = {
            ...materializationA,
            pluginId: 'acme.plugin-b',
            materializationId: 'mat-b',
            enabled: true,
            trustState: 'revoked',
        };
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: {
                availabilityCursor: 1,
                intentReads: [],
                materializations: [materializationA, materializationB],
                snapshots: [],
            },
        });

        // No internal mocks: native persistence adapters come from the standard
        // Vitest harness; the projection, classifier, inventory and selection run real.
        const hook = await renderHook(({ pluginId }: { pluginId: string }) => {
            const reader = useActivePluginAccountAvailabilityReader();
            const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
            const machineSnapshots = useAllProfileMachineInventorySnapshots();
            return {
                reader,
                classifyRelease,
                machineSnapshots,
                selection: usePluginMachineExecutionOriginSelection({ pluginId, classifyRelease }),
            };
        }, { initialProps: { pluginId: materializationA.pluginId } });

        const initial = hook.getCurrent();
        expect(initial.reader).not.toBeNull();
        expect(initial.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationA.pluginId]);
        expect(initial.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['disabled'] });

        const next = await hook.rerender({ pluginId: materializationB.pluginId });
        expect(next.reader).toBe(initial.reader);
        expect(next.classifyRelease).toBe(initial.classifyRelease);
        expect(next.machineSnapshots).toBe(initial.machineSnapshots);
        expect(next.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationB.pluginId]);
        expect(next.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['revoked'] });

        const returned = await hook.rerender({ pluginId: materializationA.pluginId });
        expect(returned.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationA.pluginId]);
        expect(returned.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['disabled'] });
        await hook.unmount();
    });
});
