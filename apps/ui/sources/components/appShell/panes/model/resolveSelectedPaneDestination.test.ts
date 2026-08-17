import { describe, expect, it } from 'vitest';

import {
    normalizePluginUiDestinationBindingV1,
    type PluginUiTargetKindV1,
} from '@happier-dev/protocol/plugins/ui';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { resolveSelectedPaneDestination } from './resolveSelectedPaneDestination';

function createProjection(
    container: 'rightPane' | 'bottomPane' | 'detailsPane',
    targetKind: Extract<PluginUiTargetKindV1, 'session' | 'project'> = 'session',
    instancePolicy: 'singleton' | 'multiple' = 'singleton',
): PluginUiProjectionModel {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.review',
        destinationId: 'review',
        rendererId: 'review-renderer',
        container,
        instancePolicy,
        target: targetKind === 'session'
            ? { kind: 'session', sessionIdPath: '/session/id' }
            : { kind: 'project', projectIdPath: '/project/id' },
    });
    if (!binding) throw new Error('test binding is required');
    const placement = {
        id: `surfacePlacement:acme.review:${container}`,
        pluginId: 'acme.review',
        contributionKind: 'surfacePlacement' as const,
        descriptorId: 'review',
        binding,
        target: binding.target,
        renderer: { kind: 'hostedWeb', contributionId: 'review-renderer' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
        headerActions: [],
    };
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        surfacePlacementsById: { [placement.id]: placement },
    };
}

describe('resolveSelectedPaneDestination', () => {
    it('uses the supplied scope target rather than recasting every pane as app', () => {
        const projection = createProjection('rightPane', 'session');

        expect(resolveSelectedPaneDestination({
            container: 'rightPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toMatchObject({
            kind: 'available',
            placement: projection.surfacePlacementsById['surfacePlacement:acme.review:rightPane'],
        });
    });

    it('keeps a desktop/tablet pane selection as a phone tombstone while admitting the same binding on tablet', () => {
        const projection = createProjection('rightPane', 'session');
        const selectedDestination = {
            kind: 'plugin' as const,
            destination: { pluginId: 'acme.review', localId: 'review' },
        };

        expect(resolveSelectedPaneDestination({
            container: 'rightPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination,
            runtimeAdmission: { platform: 'ios', formFactor: 'phone' },
        })).toEqual({
            kind: 'unavailable',
            reason: 'pane_destination_platform_unavailable',
        });

        expect(resolveSelectedPaneDestination({
            container: 'rightPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination,
            runtimeAdmission: { platform: 'ios', formFactor: 'tablet' },
        })).toMatchObject({
            kind: 'available',
            placement: projection.surfacePlacementsById['surfacePlacement:acme.review:rightPane'],
        });
    });

    it('resolves the exact selected binding and retains its bounded multiple-instance key', () => {
        const projection = createProjection('rightPane', 'session', 'multiple');

        expect(resolveSelectedPaneDestination({
            container: 'rightPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
                instanceKey: 'compare:before',
            },
        })).toMatchObject({
            kind: 'available',
            placement: projection.surfacePlacementsById['surfacePlacement:acme.review:rightPane'],
            instanceKey: 'compare:before',
        });
    });

    it('resolves a details overlay only through its exact detailsPane binding and refuses an invalid instance shape', () => {
        const projection = createProjection('detailsPane', 'session', 'multiple');

        expect(resolveSelectedPaneDestination({
            container: 'detailsPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toEqual({
            kind: 'unavailable',
            reason: 'pane_destination_instance_unavailable',
        });

        expect(resolveSelectedPaneDestination({
            container: 'detailsPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
                instanceKey: 'activity:run-1',
            },
        })).toMatchObject({
            kind: 'available',
            placement: projection.surfacePlacementsById['surfacePlacement:acme.review:detailsPane'],
            instanceKey: 'activity:run-1',
        });
    });

    it('does not substitute built-in content when the selected destination belongs to another pane container', () => {
        expect(resolveSelectedPaneDestination({
            container: 'rightPane',
            targetKind: 'session',
            projection: createProjection('bottomPane'),
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toEqual({
            kind: 'unavailable',
            reason: 'pane_destination_container_unavailable',
        });
    });

    it('resolves a shared qualified destination from the current pane slot, not projection record order', () => {
        const bottomProjection = createProjection('bottomPane');
        const rightProjection = createProjection('rightPane');
        const projection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            // Deliberately insert the other pane first: record order is not
            // destination authority.
            surfacePlacementsById: {
                ...bottomProjection.surfacePlacementsById,
                ...rightProjection.surfacePlacementsById,
            },
        };

        expect(resolveSelectedPaneDestination({
            container: 'rightPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toMatchObject({
            kind: 'available',
            placement: rightProjection.surfacePlacementsById['surfacePlacement:acme.review:rightPane'],
        });
    });

    it('fails closed when duplicate records claim the selected destination in one pane slot', () => {
        const rightProjection = createProjection('rightPane');
        const primary = rightProjection.surfacePlacementsById['surfacePlacement:acme.review:rightPane'];
        const projection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            surfacePlacementsById: {
                [primary.id]: primary,
                'surfacePlacement:acme.review:rightPane-duplicate': {
                    ...primary,
                    id: 'surfacePlacement:acme.review:rightPane-duplicate',
                    descriptorId: 'review-duplicate',
                },
            },
        };

        expect(resolveSelectedPaneDestination({
            container: 'rightPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toEqual({
            kind: 'unavailable',
            reason: 'pane_destination_unavailable',
        });
    });

    it('keeps a selected plugin unresolved while its projection has not arrived', () => {
        expect(resolveSelectedPaneDestination({
            container: 'bottomPane',
            targetKind: 'session',
            projection: null,
            projectionPhase: 'establishing',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toEqual({ kind: 'unresolved' });
    });

    it('keeps a restored selected destination pending while its first projection is establishing', () => {
        expect(resolveSelectedPaneDestination({
            container: 'bottomPane',
            targetKind: 'session',
            projection: EMPTY_PLUGIN_UI_PROJECTION,
            projectionPhase: 'establishing',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toEqual({ kind: 'unresolved' });
    });

    it('retains an admitted selected destination while its projection is offline', () => {
        const projection = createProjection('bottomPane');

        expect(resolveSelectedPaneDestination({
            container: 'bottomPane',
            targetKind: 'session',
            projection,
            projectionPhase: 'retainedOffline',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toMatchObject({
            kind: 'available',
            placement: projection.surfacePlacementsById['surfacePlacement:acme.review:bottomPane'],
        });
    });

    it('marks a current scope with no matching projection as unavailable, never pending', () => {
        expect(resolveSelectedPaneDestination({
            container: 'bottomPane',
            targetKind: 'session',
            projection: null,
            projectionPhase: 'current',
            selectedDestination: {
                kind: 'plugin',
                destination: { pluginId: 'acme.review', localId: 'review' },
            },
        })).toEqual({
            kind: 'unavailable',
            reason: 'pane_destination_projection_unavailable',
        });
    });
});
