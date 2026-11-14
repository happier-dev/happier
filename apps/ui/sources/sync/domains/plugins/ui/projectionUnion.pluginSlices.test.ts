import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { normalizePluginUiProjection } from './projection';
import { readPluginUiContributionSupplies, unionPluginUiProjections, type PluginUiProjectionUnionMember } from './projectionUnion';

// A Machine whose whole catalogue is still establishing, but whose held answer carries one
// plugin's UI slices (a mounted surface's demand). That plugin is presented; others are not loaded.
function placement(pluginId: string) {
    const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'pane', rendererId: 'pane',
        container: 'rightSidebarTab', target: { kind: 'app' } })!;
    return { id: `surfacePlacement:${pluginId}:pane`, pluginId, occurrenceId: `${pluginId}:occurrence`,
        contributionKind: 'surfacePlacement', descriptorId: 'pane', binding, target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'pane' }, display: { developerFallback: 'pane' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        executionOrigin: { serverIdentityId: 'srv_test', materializationRef: { machineId: 'machine-a',
            materializationId: `machine-a:${pluginId}`, pluginId } } };
}

function slicedMember(currentPluginIds?: ReadonlySet<string>): PluginUiProjectionUnionMember {
    const entries = [placement('acme.mounted'), placement('acme.other')];
    return {
        machineId: 'machine-a', serverId: 'server-1', serverIdentityId: 'srv_test',
        phase: 'establishing', interactionEnabled: false,
        projection: normalizePluginUiProjection({ v: 2, generation: 3, installedPackagesById: {}, agentsById: {},
            actionsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(entries.map(entry => [entry.id, entry])) } },
        } as never),
        materializationsByPluginId: Object.fromEntries(['acme.mounted', 'acme.other'].map(pluginId => [pluginId, {
            serverIdentityId: 'srv_test', machineId: 'machine-a', materializationId: `machine-a:${pluginId}`, pluginId,
            version: '1.0.0', sourceClass: 'registryPackage' as const, portableRelease: false, enabled: true,
            trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [] }])),
        ...(currentPluginIds ? { currentPluginIds } : {}),
    };
}

describe('plugin UI slices in the union', () => {
    it('presents a plugin current from its read slices while the Machine catalogue stays establishing', () => {
        const union = unionPluginUiProjections([slicedMember(new Set(['acme.mounted']))]);
        const supply = (pluginId: string) => readPluginUiContributionSupplies(
            union.pluginUiProjection?.surfacePlacementsById[`surfacePlacement:${pluginId}:pane`])
            .map(({ phase, interactionEnabled }) => ({ phase, interactionEnabled }));
        // The catalogue itself is not complete: no aggregate interaction is granted.
        expect({ phase: union.phase, interactionEnabled: union.interactionEnabled }).toEqual({ phase: 'establishing', interactionEnabled: false });
        expect(supply('acme.mounted')).toEqual([{ phase: 'current', interactionEnabled: true }]);
        // A plugin outside the slices is not loaded: still establishing, never current or retired.
        expect(supply('acme.other')).toEqual([{ phase: 'establishing', interactionEnabled: false }]);
        expect(Object.keys(union.establishingExecutionTargetsByPluginId ?? {})).toEqual(['acme.other']);
    });

    it('keeps every plugin establishing when no slice was read', () => {
        const union = unionPluginUiProjections([slicedMember()]);
        expect(readPluginUiContributionSupplies(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.mounted:pane'])
            .map(({ phase }) => phase)).toEqual(['establishing']);
        expect(Object.keys(union.establishingExecutionTargetsByPluginId ?? {}).sort()).toEqual(['acme.mounted', 'acme.other']);
    });
});
