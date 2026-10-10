import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginSurfaceLaunchAuthority } from './pluginSurfaceLaunchAuthority';

const pluginId = 'acme.scoped-account';
const machineId = 'scope-machine';
const serverId = 'scope-home';
const binding = normalizePluginUiDestinationBindingV1({
    pluginId,
    destinationId: 'notes',
    rendererId: 'notes-renderer',
    container: 'rightPane',
    target: { kind: 'session' },
});
if (!binding) throw new Error('The canonical destination schema refused the authority fixture');
const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({
    serverIdentityId: 'srv_scoped_home',
    materializationRef: { pluginId, machineId, materializationId: 'scope-install' },
});
const directPlacement = {
    id: 'surfacePlacement:acme.scoped-account:notes',
    pluginId,
    occurrenceId: 'scope-occurrence',
    contributionKind: 'surfacePlacement',
    descriptorId: 'notes',
    binding,
    target: binding.target,
    renderer: { kind: 'hostedWeb', contributionId: 'notes-renderer' },
    display: { developerFallback: 'Notes' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
    ...executionOrigin,
} satisfies PluginUiSurfacePlacementProjection;
const selectedPlacement = {
    ...directPlacement,
    hostOrigin: {
        machineId,
        serverId,
        generation: 1,
        phase: 'current',
        interactionEnabled: true,
        executionOrigin,
    },
} satisfies PluginUiSurfacePlacementProjection;

describe('plugin surface exact scoped Account authority', () => {
    it.each([
        ['direct projection', directPlacement],
        ['selected-origin projection', selectedPlacement],
    ] as const)('refuses %s launch input when its exact Home has no credential lifetime', (_, placement) => {
        expect(resolvePluginSurfaceLaunchAuthority({
            placement,
            accountLifetime: null,
            scoped: { machineId, serverId, interactionEnabled: true },
        })).toBeNull();
    });

    it('preserves selected-origin authority without an exact Session or Project scope', () => {
        expect(resolvePluginSurfaceLaunchAuthority({
            placement: selectedPlacement,
            accountLifetime: null,
        })).toMatchObject({ machineId, serverId, executionOrigin });
    });
});
