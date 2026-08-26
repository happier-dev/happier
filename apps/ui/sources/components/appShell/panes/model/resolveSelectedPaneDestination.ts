import {
    isPluginUiDestinationBindingAdmittedAtRuntimeV1,
    type PluginUiDestinationRuntimeFormFactorV1,
    type PluginUiDestinationContainerV1,
    type PluginUiPlatformV1,
    type PluginUiTargetKindV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { selectPluginSurfacePlacementsByDestination } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

import type { SelectedPaneDestinationV1 } from './selectedPaneDestination';

/**
 * The one AppPane-owned decision between an incumbent built-in adapter and an
 * explicitly selected plugin destination. It intentionally does not inspect
 * `scopeId`, synthesize target facts, or fall through to a built-in node after
 * a plugin selection fails: a selected destination is durable user intent.
 */
export type SelectedPaneDestinationResolution =
    | Readonly<{ kind: 'builtin' }>
    | Readonly<{ kind: 'unresolved' }>
    | Readonly<{
        kind: 'available';
        placement: PluginUiSurfacePlacementProjection;
        instanceKey?: string;
    }>
    | Readonly<{ kind: 'unavailable'; reason: string }>;

/**
 * AppPane only owns the public app/session/project scope adapters. The caller
 * supplies this fact from that adapter; it is never derived from the opaque
 * persisted `scopeId`.
 */
export type AppPaneDestinationTargetKind = Extract<
    PluginUiTargetKindV1,
    'app' | 'session' | 'project'
>;

export type PaneDestinationRuntimeAdmission = Readonly<{
    platform: PluginUiPlatformV1;
    formFactor: PluginUiDestinationRuntimeFormFactorV1;
}>;

export function resolveSelectedPaneDestination(input: Readonly<{
    container: Extract<PluginUiDestinationContainerV1, 'rightPane' | 'rightSidebarTab' | 'detailsPane' | 'bottomPane'>;
    targetKind: AppPaneDestinationTargetKind;
    projection: PluginUiProjectionModel | null | undefined;
    /**
     * Canonical currentness owned by the scope projection hook. An empty model
     * cannot stand in for this fact: the first describe is pending, while a
     * current empty describe is a truthful unavailable selection.
     */
    projectionPhase: PluginUiProjectionPhase;
    selectedDestination: SelectedPaneDestinationV1 | null | undefined;
    /** Runtime host facts; selected intent remains a tombstone if this rejects. */
    runtimeAdmission?: PaneDestinationRuntimeAdmission;
}>): SelectedPaneDestinationResolution {
    const selected = input.selectedDestination ?? null;
    if (!selected || selected.kind === 'builtin') {
        return { kind: 'builtin' };
    }
    if (input.projectionPhase === 'establishing') {
        return { kind: 'unresolved' };
    }
    if (input.projectionPhase === 'unavailable') {
        return {
            kind: 'unavailable',
            reason: 'pane_destination_projection_unavailable',
        };
    }
    if (input.projectionPhase !== 'current' && input.projectionPhase !== 'retainedOffline') {
        return {
            kind: 'unavailable',
            reason: 'pane_destination_projection_unavailable',
        };
    }
    if (!input.projection) {
        // A retained-offline phase with no retained snapshot is internally
        // inconsistent; do not silently recast it as a pending describe.
        return {
            kind: 'unavailable',
            reason: 'pane_destination_projection_unavailable',
        };
    }
    const destinationPlacements = selectPluginSurfacePlacementsByDestination(
        input.projection,
        selected.destination,
    );
    const slotPlacements = destinationPlacements.filter((placement) => (
        placement.binding.container === input.container
        && placement.binding.targetKind === input.targetKind
    ));
    // A selected destination is an exact binding in this AppPane slot. A
    // declaration elsewhere is a truthful tombstone; duplicate records in the
    // exact slot are equally unavailable rather than a first-record winner.
    if (slotPlacements.length !== 1) {
        return {
            kind: 'unavailable',
            reason: slotPlacements.length === 0 && destinationPlacements.length > 0
                ? 'pane_destination_container_unavailable'
                : 'pane_destination_unavailable',
        };
    }
    const placement = slotPlacements[0];
    if (
        input.runtimeAdmission
        && !isPluginUiDestinationBindingAdmittedAtRuntimeV1({
            binding: placement.binding,
            ...input.runtimeAdmission,
        })
    ) {
        return {
            kind: 'unavailable',
            reason: 'pane_destination_platform_unavailable',
        };
    }
    if (placement.availability.state !== 'available') {
        return {
            kind: 'unavailable',
            reason: placement.availability.reason,
        };
    }
    // Instance identity is part of the admitted binding, not an arbitrary
    // persisted launch discriminator. A restored multiple-instance overlay
    // without its bounded key (or a singleton with one) stays a tombstone.
    const hasValidInstanceShape = placement.binding.instancePolicy === 'multiple'
        ? selected.instanceKey !== undefined
        : selected.instanceKey === undefined;
    if (!hasValidInstanceShape) {
        return {
            kind: 'unavailable',
            reason: 'pane_destination_instance_unavailable',
        };
    }
    return {
        kind: 'available',
        placement,
        ...(selected.instanceKey === undefined ? {} : { instanceKey: selected.instanceKey }),
    };
}
