import { expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginStoreKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/storeKinds';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { projectPluginSkillDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/skills';

import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { createAppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';

it('retains admitted Machine Store kinds when the installed census contains only UI declarations', () => {
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
    const runtime = (includeDeclarations: boolean) => normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation: includeDeclarations ? 1 : 2,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Theme Store', version: '1.0.0', enabled: true,
            source: { kind: 'localPath', locator: '/plugins/store' }, sourceCustody, ...stamp } },
        agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: {
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
        publishRuntime(runtime(true));
        owner.publishExecutionOrigin(pluginId, null, executionOrigin, [executionOrigin]);
        const admitted = owner.getSnapshot();
        expect(admitted.candidateFactsByPluginId.get(pluginId)).toMatchObject({
            sourceCandidates: [{ validation: { kind: 'admitted' }, releaseContent: 'matched' }],
        });
        expect.soft(admitted.pluginUiProjection?.storeKindsById[storeKind.id]?.definition).toEqual(storeKind.definition);
        expect.soft(admitted.pluginUiProjection?.registrySourcesById[registrySource.id]?.definition).toEqual(registrySource.definition);
        expect.soft(admitted.pluginUiProjection?.skillsById[skill.id]?.definition).toEqual(skill.definition);

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
            expect(notifications).toHaveLength(1);
        } finally { stop(); }
    } finally { owner.dispose(); }
});
