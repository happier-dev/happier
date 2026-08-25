import { describe, expect, it } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

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

    it('projects logical destination icons through the current app direction', () => {
        const base = createPlacement();
        const placement = {
            ...base,
            display: { ...base.display, iconToken: 'back' },
        };
        const [destination] = resolvePluginSurfaceDestinations({
            placements: [placement],
            direction: 'rtl',
            select: (candidate) => ({ slug: candidate.binding.destination.localId }),
        });

        expect(destination?.icon).toBe('arrow-right');
    });

    it('resolves keyed destination labels and badges through the plugin projection before their fallbacks', () => {
        let locale: 'en' | 'fr' = 'fr';
        const localize: PluginLocalizedTextResolver = (_pluginId, value) => {
            if (typeof value === 'string') return value;
            const key = value.key;
            if (key === 'review.dashboard.title') return locale === 'fr' ? 'Tableau de revue' : 'Review dashboard';
            if (key === 'review.dashboard.badge') return locale === 'fr' ? 'Aperçu' : 'Preview';
            return value.fallback ?? '';
        };
        const input = {
            placements: [createPlacement()],
            select: (placement: PluginUiSurfacePlacementProjection) => ({ slug: placement.binding.destination.localId }),
            localize,
        } satisfies Parameters<typeof resolvePluginSurfaceDestinations>[0];

        expect(resolvePluginSurfaceDestinations(input)[0]).toMatchObject({
            label: 'Tableau de revue',
            badge: { label: 'Aperçu', tone: 'accent' },
        });

        locale = 'en';
        expect(resolvePluginSurfaceDestinations(input)[0]).toMatchObject({
            label: 'Review dashboard',
            badge: { label: 'Preview', tone: 'accent' },
        });
    });
});
