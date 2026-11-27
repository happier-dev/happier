import { expect, it } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginStoreKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/storeKinds';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { projectPluginSkillDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/skills';

import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

await loadSyncSingletonForTests();
const { createAppShellPluginUiProjectionPublication } = await import('./appShellPluginUiProjectionPublication');

it('retains admitted Machine Store kinds when the installed census contains only UI declarations', async () => {
    // JQ-R15: the development installation has an admitted Machine candidate,
    // but its complete pluginUi census does not contain its separate Store family.
    const pluginId = 'qa.jq-r15-store';
    const scope = { serverId: 'home', accountId: 'account' };
    const sourceCustody = { kind: 'development' as const, registeredRootId: '/plugins/store' };
    const executionOrigin = { serverIdentityId: 'srv_test', sourceRef: { machineId: 'machine', pluginId, sourceCustody } };
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: executionOrigin.serverIdentityId, machineId: 'machine', materializationId: 'installation',
        pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
        enabled: true, trustState: 'trusted', observedAt: 1, declaredUiEntries: {}, uiArtifacts: [],
    });
    const stamp = { occurrenceId: `${pluginId}:85`, executionOrigin };
    const storeKind = { ...projectPluginStoreKindDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
        id: 'theme', title: 'Themes', viewId: 'store', operations: {
            list: 'list', read: 'read', installed: 'installed', prepare: 'prepare', acquire: 'acquire', manage: 'manage',
        },
    } }), ...stamp };
    const registrySource = { ...projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0',
        definition: { id: 'skills', title: 'Skills', format: 'git', kinds: ['skill'], url: 'https://example.com/skills' } }), ...stamp };
    const skill = { ...projectPluginSkillDeclarationV1({ pluginId, pluginVersion: '1.0.0',
        definition: { id: 'check', directory: './skills/check' } }), ...stamp };
    const actionKey = `${pluginId}/refresh`;
    const inputType = { id: `${pluginId}/repository`, pluginId, pluginVersion: '1.0.0', ...stamp,
        definition: { id: 'repository', title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' as const } } };
    const resourceKey = `${pluginId}/status`;
    const runtime = (includeDeclarations: boolean) => normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation: includeDeclarations ? 1 : 2,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Theme Store', version: '1.0.0', enabled: true,
            source: { kind: 'localPath', locator: '/plugins/store' }, sourceCustody, ...stamp } },
        agentsById: {},
        actionsById: includeDeclarations ? { [actionKey]: {
            id: 'refresh', pluginId, ...stamp, title: 'Refresh preview', scopes: ['global'], surfaces: ['ui'],
            placementBindings: ['commandPalette'], dangerLevel: 'safe', execution: { target: 'daemon' },
        } } : {},
        resourcesById: includeDeclarations ? { [resourceKey]: {
            id: 'status', pluginId, ...stamp, resourceKind: 'config', scope: 'global', contentType: 'application/json',
        } } : {},
        settingsById: {}, diagnostics: [],
        familiesById: {
            inputTypes: { family: 'inputTypes', entriesById: includeDeclarations ? { [inputType.id]: inputType } : {} },
            storeKinds: { family: 'storeKinds', entriesById: includeDeclarations ? { [storeKind.id]: storeKind } : {} },
            registrySources: { family: 'registrySources', entriesById: includeDeclarations ? { [registrySource.id]: registrySource } : {} },
            skills: { family: 'skills', entriesById: includeDeclarations ? { [skill.id]: skill } : {} },
        },
    }));
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [materialization], snapshots: [],
    } });
    expect(reader.readInstalledPlugins()).toMatchObject({ plugins: [{ installations: [{
        declarationState: 'unavailable', uiDeclarationState: 'known',
    }] }] });
    const owner = createAppShellPluginUiProjectionPublication();
    const sources = { accountLifetime: null, availabilityInputs: reader.readUiProjectionInputs(), hostBundledUiEnabled: false,
        activeServerId: scope.serverId, serverProfilesGeneration: 0, activeInventoryLoaded: true,
        onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] };
    const publishRuntime = (projection: ReturnType<typeof runtime>) => owner.publishMachineCurrentness('machine', null, {
        pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
        machineId: 'machine', serverId: scope.serverId, platform: 'web', accountLifetime: null,
    });
    try {
        owner.publishSources(sources);
        owner.publishExecutionOrigin(pluginId, null, executionOrigin, [executionOrigin]);
        const scoped = { pluginUiProjection: null, installedPackagesProjection: runtime(true),
            currentPresentationSections: ['familiesById.storeKinds'] as const,
            pluginBrowserProjection: null, phase: 'establishing' as const, interactionEnabled: false,
            machineId: 'machine', serverId: scope.serverId, platform: 'web' as const, accountLifetime: null,
        };
        owner.publishMachineCurrentness('machine', null, { ...scoped, currentPresentationSections: undefined });
        await Promise.resolve();
        expect(owner.getSnapshot().pluginUiProjection?.storeKindsById[storeKind.id]).toBeUndefined();
        let publications = 0;
        const stopFirst = owner.subscribe(() => { publications++; }, 'committed');
        try {
            owner.publishMachineCurrentness('machine', null, scoped);
            await Promise.resolve();
            expect(publications).toBe(1);
        } finally { stopFirst(); }
        const scopedSnapshot = owner.getSnapshot();
        expect(scopedSnapshot.projectionUnion.hasEstablishingMembers).toBe(true);
        expect(scopedSnapshot.pluginUiProjection?.storeKindsById[storeKind.id]).toMatchObject({
            definition: storeKind.definition,
            hostOrigin: { phase: 'current', interactionEnabled: true, executionOrigin },
        });
        expect(scopedSnapshot.pluginUiProjection?.skillsById[skill.id]).toBeUndefined();
        const scopedNotifications: unknown[] = [];
        const stopScoped = owner.subscribe(() => scopedNotifications.push(owner.getSnapshot()), 'committed');
        try {
            for (let arrival = 0; arrival < 12; arrival++) owner.publishMachineCurrentness('machine', null, { ...scoped });
            await Promise.resolve();
            expect(scopedNotifications).toHaveLength(0);
            owner.publishMachineCurrentness('machine', null, { ...scoped, currentPresentationSections: [
                'familiesById.storeKinds', 'actionsById', 'familiesById.pluginUi', 'familiesById.inputTypes', 'resourcesById',
            ] });
            await Promise.resolve();
            expect(scopedNotifications).toHaveLength(1);
            const palette = owner.getSnapshot();
            const origin = { phase: 'current', interactionEnabled: true, executionOrigin };
            expect(palette.pluginUiProjection?.actionsById[actionKey]).toMatchObject({ hostOrigin: origin });
            expect(palette.pluginUiProjection?.inputTypesById[inputType.id]).toMatchObject({ hostOrigin: origin });
            expect(palette.pluginUiProjection?.resourcesById[resourceKey]).toMatchObject({ hostOrigin: origin });
            expect(palette.pluginUiProjection?.skillsById[skill.id]).toBeUndefined();
            expect(palette.projectionUnion.hasEstablishingMembers).toBe(true);
            publishRuntime(runtime(true));
            await Promise.resolve();
            expect(scopedNotifications).toHaveLength(2);
        } finally { stopScoped(); }
        const admitted = owner.getSnapshot();
        expect(owner.readExecutionOriginCandidates(pluginId)).toMatchObject({
            sourceCandidates: [{ validation: { kind: 'admitted' }, releaseContent: 'matched' }],
        });
        expect.soft(admitted.pluginUiProjection?.storeKindsById[storeKind.id]?.definition).toEqual(storeKind.definition);
        expect.soft(admitted.pluginUiProjection?.registrySourcesById[registrySource.id]?.definition).toEqual(registrySource.definition);
        expect.soft(admitted.pluginUiProjection?.skillsById[skill.id]?.definition).toEqual(skill.definition);

        await Promise.resolve();
        const notifications: unknown[] = [];
        const stop = owner.subscribe(() => notifications.push(owner.getSnapshot()), 'committed');
        try {
            for (let arrival = 0; arrival < 12; arrival++) owner.publishSources({ ...sources });
            expect(notifications).toHaveLength(0);
            expect(owner.getSnapshot().pluginUiProjection).toBe(admitted.pluginUiProjection);
            publishRuntime(runtime(false));
            expect(owner.getSnapshot().pluginUiProjection?.storeKindsById ?? {}).toEqual({});
            expect(owner.getSnapshot().pluginUiProjection?.registrySourcesById ?? {}).toEqual({});
            expect(owner.getSnapshot().pluginUiProjection?.skillsById ?? {}).toEqual({});
            await Promise.resolve();
            expect(notifications).toHaveLength(1);
        } finally { stop(); }
    } finally { owner.dispose(); }
});
