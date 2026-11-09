import { describe, expect, it } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../fullProjection';
import { buildPluginMountedActionsProjectionV2 } from './v2';

describe('mounted caller Action projection', () => {
    it('includes cold caller daemon/client Actions and only explicit cross-plugin callees', () => {
        const callerId = 'acme.triage';
        const calleeId = 'acme.source';
        const pluginIds = [callerId, calleeId, ...Array.from({ length: 65 }, (_, index) => `acme.unrelated${index}`)];
        const artifact = {
            artifactId: 'view', tier: 'reactNative' as const,
            entry: 'react-native/view/entry.cjs.bundle',
            files: [{ relativePath: 'react-native/view/entry.cjs.bundle', digest: `sha256:${'5'.repeat(64)}`, byteSize: 1 }],
            digest: `sha256:${'6'.repeat(64)}`,
            builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
            executable: { exports: ['activate', 'renderSurface'] }, hostUiApiRange: '^1.0.0',
        };
        const pluginExecutionOriginsByPluginId = Object.fromEntries(pluginIds.map(pluginId => [pluginId, {
            serverIdentityId: 'srv_mounted_actions',
            materializationRef: { machineId: 'machine_mounted_actions', materializationId: `materialization-${pluginId}`, pluginId },
        } satisfies PluginMachineExecutionOriginV1]));
        const loadedPlugins: LoadedPlugin[] = pluginIds.map(pluginId => ({
            pluginId, pluginRootPath: `/plugins/${pluginId}`, manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
            daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
            generatedUiArtifactsManifest: { version: 2, entries: [artifact] },
            manifest: normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { actions: [
                    { id: 'inspect', title: 'Inspect', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                        dangerLevel: 'safe', execution: { target: 'daemon' } },
                    { id: 'select-view', title: 'Select view', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                        dangerLevel: 'safe', execution: { target: 'client', platforms: ['web'],
                            client: { artifactId: 'view', exportName: 'activate' } } },
                ], ui: { renderers: [{ id: 'unrelated-renderer', kind: 'reactNative', artifact: 'view' }] } } }),
        }));
        const resolved = projectLoadedPluginContributes({ provenance: 'external', loadResult: { loadedPlugins, diagnosticsByPluginId: {} } });
        const registry = createResolvedContributionRegistry({ ...resolved,
            occurrenceIdsByPluginId: Object.fromEntries(pluginIds.map(id => [id, createPluginRuntimeOccurrenceId(id)])),
        });
        const read = (actions: readonly { pluginId: string; localId: string }[], callerPluginIds = [callerId]) =>
            DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                projection: buildPluginMountedActionsProjectionV2({ registry, generation: 73, actions, callerPluginIds,
                    pluginExecutionOriginsByPluginId,
                    pluginUiHostRuntime: { reactNativeBundles: { hostRuntime: { hostUiApiVersion: '1.0.0', platform: 'web' } } },
                }),
            }).projection;

        // Cold UI discovery does not carry an ambient Actions dictionary.
        const cold = read([]);
        expect(Object.keys(cold.actionsById)).toEqual([`${callerId}/inspect`, `${callerId}/select-view`]);
        expect(cold.actionsById[`${callerId}/inspect`]).toMatchObject({ execution: { target: 'daemon' }, available: true });
        expect(cold.actionsById[`${callerId}/select-view`]).toMatchObject({ execution: { target: 'client' }, available: true });
        // The strict wire consumer receives the same executable and authority
        // that accompanies this Action in the full projection.
        const callerBundle = cold.familiesById.pluginUi?.entriesById[`reactNativeBundle:${callerId}:select-view`];
        expect(callerBundle).toMatchObject({
            generatedOwnerKind: 'clientContribution', contributionId: 'select-view', artifactGraph: artifact,
            runtime: { state: 'loadable', cacheIdentity: { artifactDigest: artifact.digest } },
            occurrenceId: cold.actionsById[`${callerId}/select-view`]?.occurrenceId,
            executionOrigin: cold.actionsById[`${callerId}/select-view`]?.executionOrigin,
        });
        expect(Object.keys(cold.familiesById.pluginUi?.entriesById ?? {})).toEqual([`reactNativeBundle:${callerId}:select-view`]);

        const selected = read([{ pluginId: callerId, localId: 'inspect' }, { pluginId: calleeId, localId: 'inspect' }]);
        expect(Object.keys(selected.actionsById).sort()).toEqual([
            `${calleeId}/inspect`, `${callerId}/inspect`, `${callerId}/select-view`,
        ]);
        expect(Object.keys(selected.actionsById).filter(key => key.startsWith('acme.unrelated'))).toEqual([]);
        expect(Object.keys(selected.familiesById.pluginUi?.entriesById ?? {})).toEqual([`reactNativeBundle:${callerId}:select-view`]);
        const crossPlugin = read([{ pluginId: calleeId, localId: 'select-view' }], []);
        expect(Object.keys(crossPlugin.actionsById)).toEqual([`${calleeId}/select-view`]);
        expect(Object.keys(crossPlugin.familiesById.pluginUi?.entriesById ?? {})).toEqual([`reactNativeBundle:${calleeId}:select-view`]);
        expect(crossPlugin.familiesById.pluginUi?.entriesById[`reactNativeBundle:${calleeId}:select-view`]).toMatchObject({
            artifactGraph: artifact, executionOrigin: crossPlugin.actionsById[`${calleeId}/select-view`]?.executionOrigin,
            occurrenceId: crossPlugin.actionsById[`${calleeId}/select-view`]?.occurrenceId,
        });
        expect(read([], []).actionsById).toEqual({});
        expect(read([], []).familiesById).toEqual({});
        expect(read([], ['acme.absent']).actionsById).toEqual({});
    });
});
