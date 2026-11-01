import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineAdministrationTargetsV1Schema } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { normalizePluginUiProjection } from '../../../../ui/sources/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin, readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates, unionPluginUiProjections } from '../../../../ui/sources/sync/domains/plugins/ui/projectionUnion';
import { setPluginMachineExecutionOriginPreference, readPluginMachineExecutionTargetPreference } from '../../../../ui/sources/sync/domains/machines/administration/selectionPreferences';
import { resolvePluginMachineExecutionOriginState } from '../../../../ui/sources/sync/domains/machines/administration/pluginExecutionOrigin';
import { invalidateDaemonContributionRegistryProjectionCache, registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

await vi.hoisted(async () => {
    const path = new URL('../../../../ui/sources/dev/vitestRnShim.ts', import.meta.url).href;
    const { installVitestRnShim } = await import(path);
    installVitestRnShim();
});

// Native theme is an external platform boundary in this cross-package source
// composition; the real Administration, schemas and projection logic stay real.
vi.mock('react-native-unistyles', async () => {
    const path = new URL('../../../../ui/sources/dev/testkit/mocks/unistyles.ts', import.meta.url).href;
    const { createUnistylesMock } = await import(path);
    return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
    const path = new URL('../../../../ui/sources/dev/testkit/mocks/expoUpdates.ts', import.meta.url).href;
    const { createExpoUpdatesMock } = await import(path);
    return createExpoUpdatesMock();
});
vi.mock('@shopify/react-native-skia', async () => {
    const path = new URL('../../../../ui/sources/dev/testkit/mocks/reactNativeSkia.ts', import.meta.url).href;
    const { createReactNativeSkiaMock } = await import(path);
    return createReactNativeSkiaMock();
});
// Expo's native image view manager is absent in Node, matching the UI testkit.
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-file-system', async () => {
    const path = new URL('../../../../ui/sources/dev/testkit/mocks/expoFileSystem.ts', import.meta.url).href;
    const { createExpoFileSystemFileMock } = await import(path);
    return createExpoFileSystemFileMock().module;
});

describe('execution origin identity from daemon publication to Administration and surface binding', () => {
    it('binds the saved real source choice to its real supply and refuses a materialization mis-binding', async () => {
        const pluginId = 'happier.inspector';
        const machineId = 'machine-origin-identity';
        const serverIdentityId = 'srv_origin_identity';
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            pluginIds: [pluginId, 'happier.scm.forge.github'], resolveCurrentMachineId: () => machineId,
        } });
        try {
            expect(await fixture.registry.activatePluginsForValidation?.([pluginId, 'happier.scm.forge.github'])).toEqual([
                { pluginId, diagnostics: [] },
                { pluginId: 'happier.scm.forge.github', diagnostics: [] },
            ]);
            const custody = fixture.registry.readPluginSourceCustody?.(pluginId);
            expect(custody).toBeTruthy();
            const exactOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
                sourceRef: { pluginId, machineId, sourceCustody: custody } });
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
            registerDaemonContributionRegistryProjectionHandler(registrar, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId, machineId }),
            });
            const describeProjection = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            if (!describeProjection) throw new Error('Missing real projection registration');
            const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await describeProjection({ machineId }));
            const projection = normalizePluginUiProjection(response.projection);
            if (!projection) throw new Error('Real daemon projection must normalize');
            const member = { machineId, serverId: 'home-origin-identity', serverIdentityId, projection,
                phase: 'current' as const, interactionEnabled: true };
            const initial = unionPluginUiProjections([member]);
            const candidates = readPluginUiExecutionOriginCandidates({ projection: initial.pluginUiProjection,
                pluginId, members: [member] }).sourceCandidates;
            expect(candidates.map(candidate => candidate.source.origin)).toContainEqual(exactOrigin);
            const preferences = setPluginMachineExecutionOriginPreference(MachineAdministrationTargetsV1Schema.parse({}), pluginId, exactOrigin);
            const selected = resolvePluginMachineExecutionOriginState({ pluginId,
                storedOrigin: null, storedTarget: readPluginMachineExecutionTargetPreference(preferences, pluginId), candidates });
            expect(selected.kind).toBe('selected');
            if (selected.kind !== 'selected') throw new Error('The real source choice must be admitted');
            const githubId = 'happier.scm.forge.github';
            const githubOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
                sourceRef: { pluginId: githubId, machineId,
                    sourceCustody: fixture.registry.readPluginSourceCustody?.(githubId) } });
            const githubCandidates = readPluginUiExecutionOriginCandidates({ projection: initial.pluginUiProjection,
                pluginId: githubId, members: [member] }).sourceCandidates;
            const githubPreferences = setPluginMachineExecutionOriginPreference(preferences, githubId, githubOrigin);
            expect(resolvePluginMachineExecutionOriginState({ pluginId: githubId,
                storedOrigin: null, storedTarget: readPluginMachineExecutionTargetPreference(githubPreferences, githubId),
                candidates: githubCandidates }).kind).toBe('selected');
            const selectedUnion = unionPluginUiProjections([member], new Map([[pluginId, selected.origin]]));
            const pageId = `surfacePlacement:${pluginId}:inspector-page`;
            const page = selectedUnion.pluginUiProjection?.surfacePlacementsById[pageId];
            expect(readPluginUiContributionOrigin(page)?.executionOrigin).toEqual(exactOrigin);
            expect(readPluginUiContributionSupplies(page)).toEqual(expect.arrayContaining([
                expect.objectContaining({ executionOrigin: exactOrigin, interactionEnabled: true }),
            ]));

            // Mis-bind the real page to the other strict identity arm: the saved
            // source must remain exact and the surface must lose its binding.
            const materialization = fixture.registry.readReleaseLessMaterializations?.().find(entry => entry.pluginId === pluginId);
            if (!materialization) throw new Error('Missing real Availability observation');
            const wrongOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId, materializationRef: {
                pluginId, machineId, materializationId: materialization.materializationId,
            } });
            const misboundMember = { ...member, projection: { ...projection, surfacePlacementsById: {
                ...projection.surfacePlacementsById,
                [pageId]: { ...projection.surfacePlacementsById[pageId]!, executionOrigin: wrongOrigin },
            } } };
            const misbound = unionPluginUiProjections([misboundMember], new Map([[pluginId, selected.origin]]));
            expect(readPluginUiContributionOrigin(misbound.pluginUiProjection?.surfacePlacementsById[pageId])).toBeNull();
            expect(resolvePluginMachineExecutionOriginState({ pluginId, storedOrigin: wrongOrigin, candidates }).kind).toBe('unavailable');
        } finally {
            invalidateDaemonContributionRegistryProjectionCache();
            await fixture.dispose();
        }
    }, 120_000);
});
