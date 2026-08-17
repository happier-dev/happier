import { describe, expect, it } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from './projection';
import { readSelectedPluginUiResourceCapability } from './resourceCapability';

function selectedSurface(
    runtime: PluginUiSurfacePlacementProjection['runtime'],
): PluginUiSurfacePlacementProjection {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.preview',
        destinationId: 'summary',
        rendererId: 'descriptor-panel',
        container: 'rightPane',
        target: { kind: 'session' },
    });
    if (!binding) throw new Error('test fixture must use an admitted V2 destination binding');
    return {
        id: 'surfacePlacement:acme.preview:summary',
        pluginId: 'acme.preview',
        contributionKind: 'surfacePlacement',
        descriptorId: 'summary',
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'descriptor-panel' },
        display: { titleKey: 'summary' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        runtime,
    };
}

describe('selected plugin UI Resource capability', () => {
    it('reads only the strict bounded fact from the already-selected surface member', () => {
        const selected = selectedSurface({
            resourceCapability: { readable: true, dynamic: false },
        });
        const differentReplica = selectedSurface({
            resourceCapability: { readable: true, dynamic: true },
        });

        expect(readSelectedPluginUiResourceCapability(selected)).toEqual({
            readable: true,
            dynamic: false,
        });
        // A sibling replica is deliberately not an input to this selector: it
        // cannot raise the selected member's dynamic capability.
        expect(readSelectedPluginUiResourceCapability(selected)).not.toEqual(
            readSelectedPluginUiResourceCapability(differentReplica),
        );
    });

    it('fails closed when the selected member carries no strict capability fact', () => {
        expect(readSelectedPluginUiResourceCapability(selectedSurface({
            resourceCapability: { readable: true, dynamic: true, resourceIds: ['leak'] },
        }))).toEqual({ readable: false, dynamic: false });
        expect(readSelectedPluginUiResourceCapability(null)).toEqual({ readable: false, dynamic: false });
    });
});
