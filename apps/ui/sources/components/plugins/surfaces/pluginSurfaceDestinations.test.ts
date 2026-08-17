import { describe, expect, it } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

import { resolvePluginSurfaceDestinations } from './pluginSurfaceDestinations';

function createPlacement(): PluginUiSurfacePlacementProjection {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.review',
        destinationId: 'dashboard',
        rendererId: 'dashboard-renderer',
        container: 'appPage',
        target: { kind: 'app' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted app-page binding');
    }
    return {
        id: 'surfacePlacement:acme.review:dashboard',
        pluginId: 'acme.review',
        contributionKind: 'surfacePlacement',
        descriptorId: 'dashboard',
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'dashboard-renderer' },
        display: {
            titleKey: 'review.dashboard.title',
            developerFallback: 'Review dashboard',
            iconToken: 'settings',
            badge: {
                labelKey: 'review.dashboard.badge',
                developerFallback: 'Preview',
                tone: 'accent',
            },
            groupHint: 'sessions',
            rankHint: -25,
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    };
}

describe('resolvePluginSurfaceDestinations', () => {
    it('carries daemon-normalized presentation hints without granting them catalog order authority', () => {
        const [destination] = resolvePluginSurfaceDestinations({
            placements: [createPlacement()],
            select: (placement) => ({ slug: placement.binding.destination.localId }),
        });

        expect(destination).toMatchObject({
            id: 'plugin:acme.review:dashboard',
            icon: 'gear',
            badge: { label: 'Preview', tone: 'accent' },
            groupHint: 'sessions',
            rankHint: -25,
            order: Number.MAX_SAFE_INTEGER,
        });
    });
});
