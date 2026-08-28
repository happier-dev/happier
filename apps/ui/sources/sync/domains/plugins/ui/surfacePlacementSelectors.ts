import type {
    PluginUiDestinationContainerV1,
    PluginUiDestinationReferenceV1,
    PluginUiInlineSurfaceRoleV1,
    PluginUiTargetKindV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginUiDestinationReferenceV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

import type {
    PluginUiProjectionModel,
    PluginUiInlineSurfacePlacementProjection,
    PluginUiSurfacePlacementProjection,
} from './projection';
import { isPluginUiDestinationSurfacePlacementProjection } from './projection';
import { canRenderPluginUiProjectionEntry, type PluginUiPolicyEvaluationContext } from './policy';

/**
 * A host insertion slot, read directly from the registry-normalized binding.
 * This is deliberately not a string-derived placement or target normalizer.
 */
export type PluginUiDestinationBindingSlot = Readonly<{
    container: PluginUiDestinationContainerV1;
    targetKind: PluginUiTargetKindV1;
}>;

export type PluginSurfaceTargetKind = PluginUiTargetKindV1;

function sortedPlacements<TPlacement extends Readonly<{ id: string }>>(
    placements: readonly TPlacement[],
): readonly TPlacement[] {
    // V2 projections have no contributor-controlled placement rank. Keep the
    // host-owned registry selection stable by its generated qualified id rather
    // than reviving a raw `order` field from a stale projection row.
    return Object.freeze([...placements].sort((left, right) => left.id.localeCompare(right.id)));
}

/** The destination-only view of the one physical placement projection. */
export function selectPluginDestinationSurfacePlacements(
    model: PluginUiProjectionModel,
): readonly PluginUiSurfacePlacementProjection[] {
    return sortedPlacements(Object.values(model.surfacePlacementsById).filter(
        isPluginUiDestinationSurfacePlacementProjection,
    ));
}

/**
 * Select all V2 destinations admitted for one host-owned container/target
 * slot. `binding` is a CLI-produced protocol value: this selector reads it
 * directly and never rebuilds one from a legacy placement string.
 */
export function selectPluginSurfacePlacementsForBinding(
    model: PluginUiProjectionModel,
    slot: PluginUiDestinationBindingSlot,
): readonly PluginUiSurfacePlacementProjection[] {
    return sortedPlacements(selectPluginDestinationSurfacePlacements(model).filter((entry) => (
        entry.binding.container === slot.container
        && entry.binding.targetKind === slot.targetKind
    )));
}

export function selectRenderablePluginSurfacePlacementsForBinding(
    model: PluginUiProjectionModel,
    slot: PluginUiDestinationBindingSlot,
    policyContext?: PluginUiPolicyEvaluationContext,
): readonly PluginUiSurfacePlacementProjection[] {
    return Object.freeze(selectPluginSurfacePlacementsForBinding(model, slot).filter((entry) => (
        entry.availability.state === 'available'
        && canRenderPluginUiProjectionEntry(entry, policyContext)
    )));
}

export function doesPluginSurfacePlacementTargetKindMatch(
    entry: PluginUiSurfacePlacementProjection,
    targetKind: PluginSurfaceTargetKind,
): boolean {
    return entry.binding.targetKind === targetKind;
}

export type PluginRightSidebarPlacementScope = Extract<PluginUiTargetKindV1, 'session' | 'project' | 'app'>;

export function selectPluginRightSidebarTabPlacements(
    model: PluginUiProjectionModel,
    scope: PluginRightSidebarPlacementScope,
): readonly PluginUiSurfacePlacementProjection[] {
    return selectPluginSurfacePlacementsForBinding(model, {
        container: 'rightSidebarTab',
        targetKind: scope,
    });
}

export function selectRenderablePluginRightSidebarTabPlacements(
    model: PluginUiProjectionModel,
    scope: PluginRightSidebarPlacementScope,
    policyContext?: PluginUiPolicyEvaluationContext,
): readonly PluginUiSurfacePlacementProjection[] {
    return selectRenderablePluginSurfacePlacementsForBinding(model, {
        container: 'rightSidebarTab',
        targetKind: scope,
    }, policyContext);
}

/**
 * List every projected record for one exact qualified destination without
 * re-qualifying caller text or inferring a host slot. A consumer with a known
 * slot must still select that exact binding and reject a duplicate rather than
 * allowing projection order to appoint an owner.
 */
export function selectPluginSurfacePlacementsByDestination(
    model: PluginUiProjectionModel,
    destination: PluginUiDestinationReferenceV1,
): readonly PluginUiSurfacePlacementProjection[] {
    return sortedPlacements(selectPluginDestinationSurfacePlacements(model).filter((entry) => (
        entry.binding.destination.pluginId === destination.pluginId
        && entry.binding.destination.localId === destination.localId
    )));
}

/**
 * Exact inline mount lookup. This is intentionally separate from destination
 * lookup: an Agent slot may mount its declared surface, but cannot open or
 * collide with a destination.
 */
export function selectPluginInlineSurfacePlacementsBySurface(
    model: PluginUiProjectionModel,
    surface: PluginContributionIdentityV1,
    role: PluginUiInlineSurfaceRoleV1,
): readonly PluginUiInlineSurfacePlacementProjection[] {
    return sortedPlacements(Object.values(model.surfacePlacementsById).filter((entry): entry is PluginUiInlineSurfacePlacementProjection => (
        !isPluginUiDestinationSurfacePlacementProjection(entry)
            && entry.binding.surface.pluginId === surface.pluginId
            && entry.binding.surface.localId === surface.localId
            && entry.binding.role === role
    )));
}

/**
 * Narrow adapter for the existing Session details-resource owner. A details
 * resource names the same qualified destination reference used everywhere
 * else; bare descriptor ids cannot cross a plugin boundary.
 */
export function selectPluginSessionDetailsTabPlacement(
    model: PluginUiProjectionModel,
    destination: unknown,
): PluginUiSurfacePlacementProjection | null {
    const parsedDestination = PluginUiDestinationReferenceV1Schema.safeParse(destination);
    if (!parsedDestination.success) return null;

    const matches = selectPluginSurfacePlacementsByDestination(model, parsedDestination.data).filter((entry) => (
        entry.binding.container === 'detailsTab'
        && entry.binding.targetKind === 'session'
    ));
    // A duplicate qualified identity is a projection violation, not a
    // declaration-order tie-breaker for the details renderer.
    return matches.length === 1 ? matches[0]! : null;
}
