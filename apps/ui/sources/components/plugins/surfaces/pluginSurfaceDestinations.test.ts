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
        occurrenceId: 'review-dashboard-occurrence-a',
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
            placement: { kind: 'column', column: 'sessions' },
            rankHint: -25,
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    };
}

describe('resolvePluginSurfaceDestinations', () => {
    it('carries ordered localized Project count labels and refreshes them when locale changes', () => {
        const base = createPlacement();
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: base.pluginId, destinationId: 'dashboard',
            rendererId: 'dashboard-renderer', container: 'appPage', target: { kind: 'project' } })!;
        const placement = { ...base, binding, display: { title: 'Builds', counts: { resourceId: 'branch-counts',
            items: [{ field: 'running', label: { key: 'running', fallback: 'Running' } }, { field: 'failed', label: 'Failed' }] } } };
        const select = (entry: PluginUiSurfacePlacementProjection) => ({ slug: entry.binding.destination.localId });
        const baseline = resolvePluginSurfaceDestinations({ placements: [placement], select });
        expect(baseline[0]?.counts).toEqual({ resourceId: 'branch-counts', items: [
            { field: 'running', label: 'Running' }, { field: 'failed', label: 'Failed' },
        ] });
        expect(resolvePluginSurfaceDestinations({ placements: [structuredClone(placement)], select, baseline })).toBe(baseline);
        const localize: PluginLocalizedTextResolver = (_pluginId, value) => typeof value === 'string' ? value : 'En cours';
        const translated = resolvePluginSurfaceDestinations({ placements: [placement], select, baseline, localize });
        expect(translated[0]?.counts?.items).toEqual([{ field: 'running', label: 'En cours' }, { field: 'failed', label: 'Failed' }]);
        expect(translated[0]?.placement).toBe(baseline[0]?.placement);
    });
    it('shows the declaration-owned localized reason when a visible destination is disabled', () => {
        const base = createPlacement();
        const placement = { ...base, availability: { ...base.availability,
            disabledWhen: { fact: 'project.exists', operator: 'equals', value: true } as const,
            disabledReason: { key: 'project.setup', fallback: 'Connect this project.' },
        } };
        const localize: PluginLocalizedTextResolver = (_pluginId, value) => typeof value === 'object'
            && value !== null && 'key' in value && value.key === 'project.setup' ? 'Connectez ce projet.' : String(value);
        expect(resolvePluginSurfaceDestinations({ placements: [placement], localize,
            policyContext: { data: { project: { exists: true } } },
            select: entry => ({ slug: entry.binding.destination.localId }),
        })[0]?.disabledReason).toBe('Connectez ce projet.');
    });
    it('disables a visible destination when its declared disabled policy matches or is unknown', () => {
        const placement = createPlacement();
        const disabled = { ...placement, availability: { ...placement.availability,
            disabledWhen: { fact: 'project.exists', operator: 'equals', value: true } as const } };
        for (const policyContext of [{ data: { project: { exists: true } } }, {}]) {
            const [destination] = resolvePluginSurfaceDestinations({ placements: [disabled], policyContext,
                select: entry => ({ slug: entry.binding.destination.localId }) });
            expect(destination?.disabledReason).toBe('policy_disabled');
        }
    });

    it('retains equal admitted destinations and nested placement facts across a relevant refresh', () => {
        const placement = createPlacement();
        const select = (entry: PluginUiSurfacePlacementProjection) => ({ slug: entry.binding.destination.localId });
        const baseline = resolvePluginSurfaceDestinations({ placements: [placement], select });
        const refreshed = structuredClone(placement);
        const next = resolvePluginSurfaceDestinations({ placements: [refreshed], select, baseline });
        expect(next).toBe(baseline);
        expect(next[0]?.placement).toBe(baseline[0]?.placement);
        const changed = resolvePluginSurfaceDestinations({ placements: [{ ...refreshed,
            display: { ...refreshed.display, title: 'Changed', titleKey: undefined } }], select, baseline });
        expect(changed[0]).not.toBe(baseline[0]);
        expect(changed[0]?.placement.binding).toBe(baseline[0]?.placement.binding);
        expect(changed[0]?.placement.availability).toBe(baseline[0]?.placement.availability);
    });

    it('carries daemon-normalized presentation hints without granting them catalog order authority', () => {
        const [destination] = resolvePluginSurfaceDestinations({
            placements: [createPlacement()],
            select: (placement) => ({ slug: placement.binding.destination.localId }),
        });

        expect(destination).toMatchObject({
            id: 'plugin:acme.review:dashboard',
            icon: 'gear',
            badge: { label: 'Preview', tone: 'accent' },
            requestedPlacement: { kind: 'column', column: 'sessions' },
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
            const candidate = value && typeof value === 'object' && !Array.isArray(value)
                ? value as Readonly<Record<string, unknown>>
                : null;
            const key = typeof candidate?.key === 'string' ? candidate.key : '';
            if (key === 'review.dashboard.title') return locale === 'fr' ? 'Tableau de revue' : 'Review dashboard';
            if (key === 'review.dashboard.badge') return locale === 'fr' ? 'Aperçu' : 'Preview';
            return typeof candidate?.fallback === 'string' ? candidate.fallback : '';
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
