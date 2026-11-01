import { describe, expect, it, vi } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginMachineMaterializationV1Schema, PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createPluginAccountAvailabilityReader, createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';
import { createAppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';
import {
    publishCommittedAppShellPluginUiProjection,
    readCurrentAppShellPluginUiExecutionOriginCandidates,
    readCurrentAppShellPluginUiProjection,
    subscribeCommittedAppShellPluginUiProjection,
} from './committedPluginUiProjection';

function translationProjection(generation: number, title: string): PluginUiProjectionModel {
    return Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation,
        installedPackagesById: Object.freeze({ 'acme.publication': { id: 'acme.publication', displayName: 'Publication',
            version: '1.0.0', enabled: true, source: { kind: 'registryPackage' as const, locator: 'acme.publication' } } }),
        translationsByPluginId: Object.freeze({ 'acme.publication': Object.freeze({ id: 'translations:acme.publication',
            pluginId: 'acme.publication', contributionKind: 'translations' as const, locales: ['en'], bundles: { en: { title } } }) }),
    });
}

function currentness(projection: PluginUiProjectionModel): PluginUiProjectionCurrentness {
    return Object.freeze({ pluginUiProjection: projection, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: true, machineId: 'machine', serverId: null,
        platform: 'web', accountLifetime: null });
}

describe('AppShell projection source publication', () => {
    it('settles the restored Machine descriptor answer while unrelated UI establishment is still pending', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false, activeServerId: null,
            serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] };
        const report = { ...currentness(translationProjection(1, 'Confirmed')), phase: 'establishing' as const, interactionEnabled: false };
        try {
            owner.publishSources(sources);
            owner.publishMachineCurrentness('machine', null, { ...report, phase: 'unavailable',
                connectedAccountProjection: { kind: 'error', reason: 'transport' } });
            expect(owner.getSnapshot().connectedAccountResolution.kind).toBe('error');
            owner.publishMachineCurrentness('machine', null, { ...report, connectedAccountProjection: { kind: 'loading' } });
            expect(owner.getSnapshot().connectedAccountResolution.kind).toBe('loading');
            owner.publishMachineCurrentness('machine', null, { ...report, connectedAccountProjection: { kind: 'ready', descriptors: [] } });
            expect(owner.getSnapshot().projectionUnion.phase).toBe('establishing');
            expect(owner.getSnapshot().connectedAccountResolution).toMatchObject({ kind: 'ready', descriptors: [] });
        } finally { owner.dispose(); }
    });

    it('publishes selected origins only when the origin report changes, not on unrelated Machine reports', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const pluginId = 'acme.publication';
        let originFactReads = 0;
        const origin = new Proxy(Object.freeze(PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
            machineId: 'machine', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'publication-root' },
        } })), {
            get(target, key, receiver) {
                if (key === 'sourceRef') originFactReads++;
                return Reflect.get(target, key, receiver);
            },
        });
        owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: [] });
        const model = translationProjection(1, 'Visible');
        owner.publishMachineCurrentness('machine', null, currentness(model));
        owner.publishExecutionOrigin(pluginId, null, origin, [origin], true);
        const initial = owner.getSnapshot().pluginUiProjection;
        expect(originFactReads).toBeGreaterThan(0);
        originFactReads = 0;
        let committedPublications = 0;
        const stop = owner.subscribe(() => { committedPublications++; }, 'committed');
        try {
            for (let report = 0; report < 20; report++) {
                const connectedAccountProjection = Object.freeze({ kind: 'loading' as const });
                owner.publishMachineCurrentness('machine', null, {
                    ...currentness(model), connectedAccountProjection,
                });
                expect(owner.getSnapshot().pluginUiProjection).toBe(initial);
                expect(owner.getSnapshot().currentnessForActiveAccountByMachineId.get('machine')?.connectedAccountProjection)
                    .toBe(connectedAccountProjection);
            }
            // Count reads of the real immutable source fact, not calls to an
            // internal comparator. Unrelated reports cannot change its grouping.
            expect(committedPublications).toBe(0);
            expect(originFactReads).toBe(0);
        } finally { stop(); owner.dispose(); }
    });

    it('keeps settled declarations quiet across cursor and observation-only Availability publications', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const store = createPluginAccountAvailabilityReaderStore();
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.publication',
            version: '1.0.0', displayName: 'Publication', runtime: { apiVersion: 1 }, contributes: {
                registrySources: [{ id: 'skills', title: 'Skills', format: 'git', kinds: ['skill'], url: 'https://example.com/skills' }],
            } });
        const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_test', machineId: 'machine',
            materializationId: 'installation', pluginId: manifest.id, version: manifest.version, sourceClass: 'localPath',
            portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
            declaredManifest: manifest, declaredUiEntries: {} });
        const machines = ['machine'];
        const sources = { accountLifetime: null, hostBundledUiEnabled: false, activeServerId: scope.serverId,
            serverProfilesGeneration: 0, activeInventoryLoaded: true, onlineMachineIds: machines, selectableMachineIds: machines };
        const publish = (cursor: number, row = materialization) => {
            store.replace({ scope, snapshot: { availabilityCursor: cursor, intentReads: [], materializations: [row],
                snapshots: [{ serverIdentityId: row.serverIdentityId, machineId: row.machineId, materializations: [row] }] } });
            owner.publishSources({ ...sources, availabilityInputs: store.bind(scope).readUiProjectionInputs() });
        };
        publish(1);
        const initial = owner.getSnapshot();
        let publications = 0;
        const stop = owner.subscribe(() => { publications++; });
        try {
            for (let cursor = 2; cursor <= 21; cursor++) publish(cursor, { ...materialization, observedAt: cursor });
            expect.soft(publications).toBe(0);
            expect.soft(owner.getSnapshot()).toBe(initial);
            publish(22, { ...materialization, declaredManifest: { ...manifest, contributes: {
                ...manifest.contributes, registrySources: [{ ...manifest.contributes.registrySources![0]!, url: 'https://example.com/changed' }],
            } } });
            expect(publications).toBe(1);
            expect(owner.getSnapshot().pluginUiProjection?.registrySourcesById['acme.publication/skills']?.definition.url)
                .toBe('https://example.com/changed');
            publish(23, { ...materialization, enabled: false, trustState: 'revoked' });
            expect(publications).toBe(2);
            expect(owner.getSnapshot().pluginUiProjection?.installedPackagesById[manifest.id]).toBeUndefined();
            expect(owner.getSnapshot().pluginUiProjection?.registrySourcesById['acme.publication/skills']).toBeUndefined();
        } finally { stop(); owner.dispose(); }
    });

    it('does not republish equivalent Machine currentness wrappers and still withdraws changed authority', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
        const report = currentness(translationProjection(1, 'First'));
        owner.publishMachineCurrentness('machine', null, report);
        const first = owner.getSnapshot();
        let publications = 0;
        const stop = owner.subscribe(() => { publications += 1; });
        try {
            for (let index = 0; index < 20; index += 1) {
                owner.publishMachineCurrentness('machine', null, { ...report });
            }
            expect(publications).toBe(0);
            expect(owner.getSnapshot()).toBe(first);
            owner.publishMachineCurrentness('machine', null, {
                ...report, phase: 'retainedOffline', interactionEnabled: false,
            });
            expect(publications).toBe(1);
            expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(false);
        } finally { stop(); owner.dispose(); }
    });

    it('keeps committed UI quiet across unrelated registry generations and publishes changed declarations and availability', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
        const model = translationProjection(1, 'First');
        owner.publishMachineCurrentness('machine', null, currentness(model));
        const initial = owner.getSnapshot().pluginUiProjection;
        const detach = publishCommittedAppShellPluginUiProjection(() => owner.getSnapshot().pluginUiProjection,
            id => owner.getSnapshot().candidateFactsByPluginId.get(id) ?? null, listener => owner.subscribe(listener, 'committed'));
        let publications = 0;
        let rawPublications = 0;
        const stop = subscribeCommittedAppShellPluginUiProjection(() => { publications++; });
        const stopRaw = owner.subscribe(() => { rawPublications++; });
        try {
            for (let generation = 2; generation <= 21; generation++) {
                owner.publishMachineCurrentness('machine', null, currentness({ ...model, generation }));
            }
            expect.soft(publications).toBe(0);
            expect(rawPublications).toBe(20);
            expect(owner.getSnapshot().currentnessForActiveAccountByMachineId.get('machine')?.pluginUiProjection?.generation).toBe(21);
            expect.soft(owner.getSnapshot().pluginUiProjection).toBe(initial);
            const changed = translationProjection(21, 'Changed');
            owner.publishMachineCurrentness('machine', null, currentness(changed));
            expect(publications).toBe(1);
            expect(readCurrentAppShellPluginUiProjection()?.translationsByPluginId['acme.publication']?.bundles)
                .toEqual({ en: { title: 'Changed' } });
            owner.publishMachineCurrentness('machine', null, { ...currentness(changed),
                phase: 'retainedOffline', interactionEnabled: false });
            expect(publications).toBe(2);
            expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(false);
            owner.publishMachineCurrentness('machine', null, currentness(changed));
            expect(publications).toBe(3);
            owner.publishMachineCurrentness('machine', null, { ...currentness({ ...changed, generation: null }),
                phase: 'establishing', interactionEnabled: false });
            expect(publications).toBe(4);
            expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(false);
            owner.publishMachineCurrentness('machine', null, currentness(changed));
            expect(publications).toBe(5);
            expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(true);
            owner.publishMachineCurrentness('machine', null, currentness({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 21 }));
            expect(publications).toBe(6);
            expect(readCurrentAppShellPluginUiProjection()?.translationsByPluginId['acme.publication']).toBeUndefined();
        } finally { stopRaw(); stop(); detach(); owner.dispose(); }
    });

    it('publishes the prepared Skills identity atomically and retains it across runtime generation changes', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const pluginId = 'acme.publication';
        const id = `${pluginId}/check`;
        const model = { ...translationProjection(1, 'First'), skillsById: { [id]: { id, pluginId, pluginVersion: '1.0.0',
            definition: { id: 'check', directory: './skills/check' } } } };
        const emptyIdentity = owner.getSnapshot().skillSourceIdentity;
        owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
        owner.publishMachineCurrentness('machine', null, currentness(model));
        const first = owner.getSnapshot().skillSourceIdentity;
        const firstProjection = owner.getSnapshot().pluginUiProjection;
        expect(first).not.toBe(emptyIdentity);
        const generations = { ...model, generation: 999 };
        owner.publishMachineCurrentness('machine', null, currentness(generations));
        expect(owner.getSnapshot().skillSourceIdentity).toBe(first);
        expect(owner.getSnapshot().pluginUiProjection).toBe(firstProjection);
        const notifications: Array<ReturnType<typeof owner.getSnapshot>> = [];
        const stop = owner.subscribe(() => { notifications.push(owner.getSnapshot()); });
        try {
            owner.publishMachineCurrentness('machine', null, currentness({ ...generations, skillsById: { [id]: {
                ...model.skillsById[id]!, definition: { id: 'check', directory: './skills/changed' },
            } } }));
            expect(notifications).toHaveLength(1);
            expect(notifications[0]?.skillSourceIdentity).not.toBe(first);
            expect(notifications[0]?.pluginUiProjection?.skillsById[id]?.definition.directory).toBe('./skills/changed');
        } finally { stop(); owner.dispose(); }
        expect(owner.getSnapshot().skillSourceIdentity).toBe(emptyIdentity);
    });

    it('does not withdraw current declarations until the installed UI census is known', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        const materialization = PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_test', machineId: 'machine', materializationId: 'installation',
            pluginId: 'acme.publication', version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1_700_000_000_000,
        });
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: materialization.pluginId,
            version: materialization.version, displayName: 'Publication', runtime: { apiVersion: 1 },
            contributes: { registrySources: [{ id: 'skills', title: 'Skills', format: 'git', kinds: ['skill'],
                url: 'https://github.com/acme/skills' }] } });
        const readerFor = (stage: 'unknown' | 'manifest' | 'complete') => {
            const installation = stage === 'unknown' ? materialization
                : { ...materialization, declaredManifest: manifest, ...(stage === 'complete' ? { declaredUiEntries: {} } : {}) };
            return createPluginAccountAvailabilityReader({ scope, snapshot: {
                availabilityCursor: stage === 'unknown' ? 1 : stage === 'manifest' ? 2 : 3,
                intentReads: [], materializations: [installation],
                snapshots: [{ serverIdentityId: installation.serverIdentityId, machineId: installation.machineId,
                    materializations: [installation] }],
            } });
        };
        const preparing = readerFor('unknown');
        expect(preparing.readInstalledPlugins()).toMatchObject({ plugins: [{ installations: [{ uiDeclarationState: 'preparing' }] }] });
        const sources = { accountLifetime: null, availabilityInputs: preparing.readUiProjectionInputs(), hostBundledUiEnabled: false,
            activeServerId: scope.serverId, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] };
        try {
            owner.publishSources(sources);
            owner.publishMachineCurrentness('machine', null, { ...currentness(translationProjection(1, 'Live title')),
                serverId: scope.serverId });
            expect(owner.getSnapshot().pluginUiProjection?.translationsByPluginId['acme.publication']?.bundles)
                .toEqual({ en: { title: 'Live title' } });

            // Known non-UI declarations survive while the UI census is still preparing.
            owner.publishSources({ ...sources, availabilityInputs: readerFor('manifest').readUiProjectionInputs() });
            expect(owner.getSnapshot().pluginUiProjection?.translationsByPluginId['acme.publication']?.bundles)
                .toEqual({ en: { title: 'Live title' } });
            expect(owner.getSnapshot().pluginUiProjection?.registrySourcesById['acme.publication/skills'])
                .toMatchObject({ definition: { id: 'skills' } });

            // A proven empty census really does withdraw the preceding daemon declaration.
            owner.publishSources({ ...sources, availabilityInputs: readerFor('complete').readUiProjectionInputs() });
            expect(owner.getSnapshot().pluginUiProjection?.translationsByPluginId['acme.publication']).toBeUndefined();
            expect(owner.getSnapshot().pluginUiProjection?.registrySourcesById['acme.publication/skills'])
                .toMatchObject({ definition: { id: 'skills' } });
        } finally { owner.dispose(); }
    });

    it('ignores non-declaring selectable-origin changes without hiding real unpinned conflict transitions', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const pluginId = 'acme.publication';
        const machines = ['conflict-a', 'conflict-b', 'conflict-c'];
        const origins = machines.map(machineId => PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test',
            sourceRef: { machineId, pluginId, sourceCustody: { kind: 'development', registeredRootId: `${machineId}-root` } } }));
        const unrepresented = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
            machineId: machines[0]!, pluginId, sourceCustody: { kind: 'development', registeredRootId: 'not-the-declaring-root' },
        } });
        let declarationWalks = 0;
        const models = machines.map((machineId, index) => {
            const base = translationProjection(1, `Conflicting content from ${machineId}`);
            return Object.freeze({ ...base,
                installedPackagesById: Object.freeze({ [pluginId]: Object.freeze({ ...base.installedPackagesById[pluginId]!,
                    occurrenceId: machineId, executionOrigin: origins[index]!,
                    source: { kind: 'localPath' as const, locator: machineId } }) }),
                translationsByPluginId: Object.freeze({ [pluginId]: new Proxy(Object.freeze({ ...base.translationsByPluginId[pluginId]!,
                    occurrenceId: machineId, executionOrigin: origins[index]!,
                }), { ownKeys(target) { declarationWalks++; return Reflect.ownKeys(target); } }) }),
            });
        });
        const declaration = () => owner.getSnapshot().pluginUiProjection?.translationsByPluginId[pluginId];
        try {
            owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
                activeServerId: 'server-1', serverProfilesGeneration: 0, activeInventoryLoaded: true,
                onlineMachineIds: machines, selectableMachineIds: machines });
            models.forEach((model, index) => owner.publishMachineCurrentness(machines[index]!, null,
                { ...currentness(model), machineId: machines[index]!, serverId: 'server-1' }));
            owner.publishExecutionOrigin(pluginId, null, null, [origins[0]!, unrepresented, origins[1]!]);
            expect(declaration()).toMatchObject({ hostCompatibility: 'conflict' });
            expect(declarationWalks).toBeGreaterThan(0);
            const initial = owner.getSnapshot();
            const unchangedNotifications = vi.fn();
            const stopUnchanged = owner.subscribe(unchangedNotifications);
            declarationWalks = 0;
            for (const selectable of [[unrepresented, origins[0]!, origins[1]!], [origins[0]!, origins[1]!],
                [origins[0]!, unrepresented, origins[1]!]]) {
                owner.publishExecutionOrigin(pluginId, null, null, selectable);
                expect(owner.getSnapshot().projectionUnion).toBe(initial.projectionUnion);
                expect(owner.getSnapshot().candidateFactsByPluginId).toBe(initial.candidateFactsByPluginId);
            }
            stopUnchanged();
            expect.soft(unchangedNotifications).not.toHaveBeenCalled();
            expect.soft(declarationWalks).toBe(0);
            declarationWalks = 0;
            owner.publishExecutionOrigin(pluginId, null, null, [origins[0]!, unrepresented]);
            expect(declaration()).toMatchObject({ hostCompatibility: 'compatible' });
            expect(declarationWalks).toBeGreaterThan(0);
            owner.publishExecutionOrigin(pluginId, null, null, [origins[0]!, origins[2]!]);
            expect(declaration()).toMatchObject({ hostCompatibility: 'conflict' });
            owner.publishMachineCurrentness(machines[2]!, null, { ...currentness(models[2]!), machineId: machines[2]!, serverId: 'server-1',
                phase: 'establishing', interactionEnabled: false });
            expect(declaration()).toMatchObject({ hostCompatibility: 'compatible' });
        } finally { owner.dispose(); }
    });

    it('isolates currentness reports to changed plugin slices across a many-Machine catalog', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const machines = Array.from({ length: 12 }, (_, index) => `report-machine-${index}`);
        const ids = machines.map((_, index) => `acme.report-${index}`);
        const models = machines.map((machineId, index) => {
            const pluginId = ids[index]!;
            const sourceCustody = { kind: 'development' as const, registeredRootId: `${machineId}-root` };
            const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test',
                sourceRef: { machineId, pluginId, sourceCustody } });
            return Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
                installedPackagesById: Object.freeze({ [pluginId]: Object.freeze({ id: pluginId, displayName: pluginId,
                    version: '1.0.0', enabled: true, source: { kind: 'localPath' as const, locator: `${machineId}-root` },
                    occurrenceId: `${machineId}-occurrence`, executionOrigin, sourceCustody }) }),
                translationsByPluginId: Object.freeze(index === 11 ? {} : { [pluginId]: Object.freeze({
                    id: `translations:${pluginId}`, pluginId, contributionKind: 'translations' as const,
                    locales: ['en'], bundles: { en: { title: pluginId } },
                    occurrenceId: `${machineId}-occurrence`, executionOrigin,
                }) }),
            }) satisfies PluginUiProjectionModel;
        });
        const sources = { accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: 'server-1', serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: machines, selectableMachineIds: machines };
        owner.publishSources(sources);
        models.forEach((model, index) => owner.publishMachineCurrentness(machines[index]!, null,
            { ...currentness(model), machineId: machines[index]!, serverId: 'server-1' }));
        const initial = owner.getSnapshot();
        const siblingMaps = new Set(models.slice(1, 11).flatMap(model => [model.translationsByPluginId, model.installedPackagesById]));
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        const keys = vi.spyOn(Object, 'keys');
        const siblingWalks = () => entries.mock.calls.filter(([value]) => siblingMaps.has(value)).length
            + values.mock.calls.filter(([value]) => siblingMaps.has(value)).length
            + keys.mock.calls.filter(([value]) => siblingMaps.has(value)).length;
        try {
            // A global registry counter cannot change an admitted UI
            // declaration or the exact native source occurrence.
            for (let generation = 2; generation <= 4; generation++) {
                owner.publishMachineCurrentness(machines[11]!, null,
                    { ...currentness({ ...models[11]!, generation }), machineId: machines[11]!, serverId: 'server-1' });
                owner.publishSources({ ...sources });
                expect.soft(owner.getSnapshot().projectionUnion).toBe(initial.projectionUnion);
                expect(owner.getSnapshot().candidateFactsByPluginId.get(ids[11]!)).toBe(initial.candidateFactsByPluginId.get(ids[11]!));
            }
            expect.soft(siblingWalks()).toBe(0);
            owner.publishMachineCurrentness(machines[0]!, null, { ...currentness(models[0]!), machineId: machines[0]!, serverId: 'server-1',
                phase: 'establishing', interactionEnabled: false });
            const pending = owner.getSnapshot();
            expect(readPluginUiContributionSupplies(pending.pluginUiProjection?.translationsByPluginId[ids[0]!])).toMatchObject([
                { phase: 'establishing', interactionEnabled: false },
            ]);
            for (const id of ids.slice(1, 11)) {
                expect(pending.pluginUiProjection?.translationsByPluginId[id]).toBe(initial.pluginUiProjection?.translationsByPluginId[id]);
                expect(pending.candidateFactsByPluginId.get(id)).toBe(initial.candidateFactsByPluginId.get(id));
            }
            expect(siblingWalks()).toBe(0);
            const firstId = ids[0]!;
            const edited = { ...models[0]!, translationsByPluginId: {
                [firstId]: { ...models[0]!.translationsByPluginId[firstId]!, bundles: { en: { title: 'Edited same-generation source' } } },
            } };
            owner.publishMachineCurrentness(machines[0]!, null, { ...currentness(edited), machineId: machines[0]!, serverId: 'server-1' });
            const updated = owner.getSnapshot();
            expect(updated.pluginUiProjection?.translationsByPluginId[firstId]?.bundles).toEqual({ en: { title: 'Edited same-generation source' } });
            for (const id of ids.slice(1, 11)) expect(updated.pluginUiProjection?.translationsByPluginId[id])
                .toBe(initial.pluginUiProjection?.translationsByPluginId[id]);
            expect(siblingWalks()).toBe(0);
        } finally { entries.mockRestore(); values.mockRestore(); keys.mockRestore(); owner.dispose(); }
    });

    it('keeps eleven UI provisioners stable while controller selection checks stream in', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const pluginIds = Array.from({ length: 11 }, (_, index) => `acme.provisioner-${index}`);
        const machines = ['controller-a', 'controller-b', 'controller-c'];
        const origins = new Map(machines.map(machineId => [machineId, new Map(pluginIds.map(pluginId => [pluginId,
            PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
                machineId, pluginId, sourceCustody: { kind: 'development', registeredRootId: `${machineId}-${pluginId}` },
            } }),
        ]))]));
        const models = machines.map(machineId => {
            const installedPackagesById = Object.fromEntries(pluginIds.map(pluginId => [pluginId, {
                id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
                occurrenceId: `${machineId}-${pluginId}`, executionOrigin: origins.get(machineId)!.get(pluginId)!,
                source: { kind: 'localPath', locator: `${machineId}-${pluginId}` },
            }]));
            const translationsByPluginId = Object.fromEntries(pluginIds.map(pluginId => [pluginId, {
                id: `translations:${pluginId}`, pluginId, contributionKind: 'translations' as const,
                locales: ['en'], bundles: { en: { title: pluginId } }, occurrenceId: `${machineId}-${pluginId}`,
                executionOrigin: origins.get(machineId)!.get(pluginId)!,
            }]));
            return Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
                installedPackagesById: Object.freeze(installedPackagesById),
                translationsByPluginId: Object.freeze(translationsByPluginId) }) satisfies PluginUiProjectionModel;
        });
        const values = vi.spyOn(Object, 'values');
        const entries = vi.spyOn(Object, 'entries');
        const keys = vi.spyOn(Object, 'keys');
        const sourceMaps = new Set<object>(models.flatMap(model => [model.installedPackagesById, model.translationsByPluginId]));
        const sourceWalks = () => values.mock.calls.filter(([value]) => sourceMaps.has(value)).length
            + entries.mock.calls.filter(([value]) => sourceMaps.has(value)).length
            + keys.mock.calls.filter(([value]) => sourceMaps.has(value)).length;
        try {
            owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
                activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
                onlineMachineIds: machines, selectableMachineIds: machines });
            models.forEach((model, index) => owner.publishMachineCurrentness(machines[index]!, null,
                { ...currentness(model), machineId: machines[index]! }));
            for (const pluginId of pluginIds) {
                const origin = origins.get(machines[0]!)!.get(pluginId)!;
                owner.publishExecutionOrigin(pluginId, null, origin, [origin]);
            }
            const initial = owner.getSnapshot();
            const establishedWalks = sourceWalks();
            expect(establishedWalks).toBeGreaterThan(0);
            let candidatePublications = 0;
            const unsubscribe = owner.subscribe(() => {
                if (owner.getSnapshot().candidateFactsByPluginId !== initial.candidateFactsByPluginId) candidatePublications++;
            });
            try {
                for (let controllerCount = 2; controllerCount <= machines.length; controllerCount++) {
                    for (const pluginId of pluginIds) {
                        owner.publishExecutionOrigin(pluginId, null, origins.get(machines[0]!)!.get(pluginId)!,
                            machines.slice(0, controllerCount).map(machineId => origins.get(machineId)!.get(pluginId)!));
                    }
                }
                expect(owner.getSnapshot().projectionUnion).toBe(initial.projectionUnion);
                expect(sourceWalks() - establishedWalks).toBe(0);
                expect(candidatePublications).toBe(0);
            } finally { unsubscribe(); }
        } finally { values.mockRestore(); entries.mockRestore(); keys.mockRestore(); owner.dispose(); }
    });

    it('does not rederive the UI union or feed back candidate reports for native-only origin reports', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const nativeId = 'acme.native-provisioner';
        const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test',
            sourceRef: { machineId: 'machine', pluginId: nativeId,
                sourceCustody: { kind: 'development', registeredRootId: 'native-root' } } });
        if (!('sourceRef' in origin)) throw new Error('Fixture must retain exact native source custody');
        const base = translationProjection(1, 'Visible');
        const model = Object.freeze({ ...base, installedPackagesById: Object.freeze({ ...base.installedPackagesById,
            [nativeId]: Object.freeze({ id: nativeId, displayName: 'Native provisioner', enabled: true,
                version: '1.0.0', occurrenceId: 'native-occurrence', executionOrigin: origin,
                sourceCustody: origin.sourceRef.sourceCustody, source: { kind: 'localPath' as const, locator: 'native-root' } }) }) });
        owner.publishSources({ accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: 'server-1', serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
        owner.publishMachineCurrentness('machine', null, { ...currentness(model), serverId: 'server-1' });
        const initial = owner.getSnapshot();
        const facts = initial.candidateFactsByPluginId;
        expect(facts.get(nativeId)?.sourceCandidates).toHaveLength(1);
        let feedbackReports = 0;
        const unsubscribe = owner.subscribe(() => {
            if (owner.getSnapshot().candidateFactsByPluginId !== facts) {
                feedbackReports += 1;
                // The real reporter republishes its descriptive election after
                // a candidate change. Detect a cycle without mocking selection.
                if (feedbackReports < 3) owner.publishExecutionOrigin(nativeId, null, origin, [origin]);
            }
        });
        const values = vi.spyOn(Object, 'values');
        try {
            for (let index = 0; index < 10; index += 1) {
                owner.publishExecutionOrigin(nativeId, null, index % 2 ? null : origin, [origin]);
            }
            const declarationWalks = values.mock.calls.filter(([value]) => value === model.translationsByPluginId).length;
            expect(declarationWalks).toBe(0);
            expect(owner.getSnapshot().projectionUnion).toBe(initial.projectionUnion);
            expect(owner.getSnapshot().candidateFactsByPluginId).toBe(facts);
            expect(feedbackReports).toBe(0);
        } finally { values.mockRestore(); unsubscribe(); owner.dispose(); }
    });

    it('notifies committed candidate readers for native-only changes without replacing the aggregate declaration', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: 'server-1', serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        const pluginId = 'acme.native-only';
        let sourceReads = 0;
        const publishNative = (occurrence: number) => {
            const sourceCustody = Object.freeze({ kind: 'development' as const, registeredRootId: 'native-only-root' });
            const model: PluginUiProjectionModel = Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
                installedPackagesById: Object.freeze({ [pluginId]: Object.freeze({ id: pluginId, displayName: 'Native only',
                    version: '1.0.0', enabled: true, source: { kind: 'localPath' as const, locator: 'native-only-root' }, occurrenceId: `${pluginId}:occurrence-${occurrence}`,
                    executionOrigin: { serverIdentityId: 'srv_test', sourceRef: { machineId: 'machine', pluginId, sourceCustody } },
                    sourceCustody }) }) });
            const report = { ...currentness(new Proxy(model, {
                get(target, key, receiver) { sourceReads += 1; return Reflect.get(target, key, receiver); },
            })), serverId: 'server-1' };
            owner.publishMachineCurrentness('machine', null, report);
            return report;
        };
        owner.publishSources(sources);
        const firstReport = publishNative(7);
        const first = owner.getSnapshot();
        expect(first.pluginUiProjection).toBeNull();
        expect(first.candidateFactsByPluginId.get(pluginId)?.sourceCandidates[0]?.source.occurrenceId).toBe(`${pluginId}:occurrence-7`);
        const read = () => owner.getSnapshot().pluginUiProjection;
        let sourceSubscriptions = 0;
        const bind = () => publishCommittedAppShellPluginUiProjection(read,
            id => owner.getSnapshot().candidateFactsByPluginId.get(id) ?? null,
            listener => {
                sourceSubscriptions += 1;
                const stop = owner.subscribe(listener, 'committed');
                return () => { sourceSubscriptions -= 1; stop(); };
            });
        const firstCleanup = bind();
        let notifications = 0;
        let observed = readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId);
        const unsubscribe = subscribeCommittedAppShellPluginUiProjection(() => {
            notifications += 1;
            observed = readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId);
        });
        let currentCleanup = firstCleanup;
        try {
            sourceReads = 0;
            for (let index = 0; index < 100; index += 1) {
                owner.publishSources({ ...sources });
                owner.publishMachineCurrentness('machine', null, firstReport);
                expect(readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId)).toBe(observed);
            }
            expect(sourceReads).toBe(0);
            expect(notifications).toBe(0);
            publishNative(8);
            expect(owner.getSnapshot().pluginUiProjection).toBe(first.pluginUiProjection);
            expect(owner.getSnapshot().projectionUnion.phase).toBe(first.projectionUnion.phase);
            expect(notifications).toBe(1);
            expect(observed.sourceCandidates[0]?.source.occurrenceId).toBe(`${pluginId}:occurrence-8`);
            expect(sourceReads).toBeGreaterThan(0);

            // Rebinding the same read function must detach its predecessor,
            // and an old cleanup must not clear or detach the new binding.
            currentCleanup = bind();
            expect(sourceSubscriptions).toBe(1);
            firstCleanup();
            expect(sourceSubscriptions).toBe(1);
            notifications = 0;
            publishNative(9);
            expect(notifications).toBe(1);
            expect(observed.sourceCandidates[0]?.source.occurrenceId).toBe(`${pluginId}:occurrence-9`);
            currentCleanup();
            expect(sourceSubscriptions).toBe(0);
            expect(readCurrentAppShellPluginUiProjection()).toBeNull();
            expect(readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId).sourceCandidates).toEqual([]);
            notifications = 0;
            publishNative(10);
            expect(notifications).toBe(0);
        } finally {
            unsubscribe();
            currentCleanup();
            owner.dispose();
        }
    });

    it('makes repeated reads inert and publishes a changed source without rebuilding on equivalent commits', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        owner.publishSources(sources);
        let sourceReads = 0;
        const observed = (projection: PluginUiProjectionModel) => new Proxy(projection, {
            get(target, key, receiver) { sourceReads += 1; return Reflect.get(target, key, receiver); },
        });
        const first = currentness(observed(translationProjection(1, 'First')));
        owner.publishMachineCurrentness('machine', null, first);
        const ready = owner.getSnapshot();
        expect(ready.pluginUiProjection?.translationsByPluginId['acme.publication']?.bundles).toEqual({ en: { title: 'First' } });
        let notifications = 0;
        const unsubscribe = owner.subscribe(() => { notifications += 1; });
        sourceReads = 0;
        for (let index = 0; index < 100; index += 1) {
            owner.publishSources({ ...sources });
            owner.publishMachineCurrentness('machine', null, first);
            expect(owner.getSnapshot()).toBe(ready);
        }
        expect(notifications).toBe(0);
        expect(sourceReads).toBe(0);
        owner.publishMachineCurrentness('machine', null, currentness(observed(translationProjection(2, 'Second'))));
        expect(sourceReads).toBeGreaterThan(0);
        expect(owner.getSnapshot()).not.toBe(ready);
        expect(owner.getSnapshot().pluginUiProjection?.translationsByPluginId['acme.publication']?.bundles).toEqual({ en: { title: 'Second' } });
        expect(notifications).toBe(1);
        unsubscribe();
        owner.dispose();
    });

    it('drops a departing Machine report so its return cannot re-admit the old current snapshot', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: null, serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        owner.publishSources(sources);
        owner.publishMachineCurrentness('machine', null, currentness(translationProjection(1, 'First')));
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(true);
        owner.publishSources({ ...sources, onlineMachineIds: [] });
        expect(owner.getSnapshot().projectionTargets).toHaveLength(0);
        owner.publishSources({ ...sources });
        expect(owner.getSnapshot().projectionTargets).toHaveLength(1);
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(false);
        expect(owner.getSnapshot().projectionUnion.hasEstablishingMembers).toBe(true);
        owner.dispose();
    });

    it('does not re-admit an old unscoped Home report under the same Machine id', () => {
        const owner = createAppShellPluginUiProjectionPublication();
        const sources = { accountLifetime: null, availabilityInputs: null, hostBundledUiEnabled: false,
            activeServerId: 'home-a', serverProfilesGeneration: 0, activeInventoryLoaded: true,
            onlineMachineIds: Object.freeze(['machine']), selectableMachineIds: Object.freeze(['machine']) };
        const first = { ...currentness(translationProjection(1, 'Home A')), serverId: 'home-a' };
        owner.publishSources(sources);
        owner.publishMachineCurrentness('machine', null, first);
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(true);
        owner.publishSources({ ...sources, activeServerId: 'home-b' });
        owner.publishMachineCurrentness('machine', null, first);
        expect(owner.getSnapshot().projectionUnion.interactionEnabled).toBe(false);
        expect(owner.getSnapshot().projectionUnion.hasEstablishingMembers).toBe(true);
        owner.dispose();
    });
});
