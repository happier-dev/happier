import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from './projection';
import { canRenderPluginUiProjectionEntry, type PluginUiPolicyEvaluationContext } from './policy';

function compareSurfacePlacements(
    left: PluginUiSurfacePlacementProjection,
    right: PluginUiSurfacePlacementProjection,
): number {
    const leftOrder = typeof left.order === 'number' ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = typeof right.order === 'number' ? right.order : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
}

export function selectPluginSurfacePlacementsForPlacement(
    model: PluginUiProjectionModel,
    placement: string,
): readonly PluginUiSurfacePlacementProjection[] {
    return Object.freeze([...(model.surfacePlacementsByPlacement[placement] ?? [])].sort(compareSurfacePlacements));
}

export function selectRenderablePluginSurfacePlacementsForPlacement(
    model: PluginUiProjectionModel,
    placement: string,
    policyContext?: PluginUiPolicyEvaluationContext,
): readonly PluginUiSurfacePlacementProjection[] {
    return Object.freeze(selectPluginSurfacePlacementsForPlacement(model, placement).filter((entry) => (
        entry.availability.state === 'available'
        && canRenderPluginUiProjectionEntry(entry, policyContext)
    )));
}

export type PluginRightSidebarPlacementScope = 'session' | 'project' | 'app';
export type PluginSurfaceTargetKind = 'session' | 'workspace' | 'project' | 'app' | 'browser' | 'services';

function readTargetKind(entry: PluginUiSurfacePlacementProjection): string | null {
    const target = entry.target;
    return target && typeof target === 'object' && !Array.isArray(target) && typeof target.kind === 'string'
        ? target.kind
        : null;
}

export function doesPluginSurfacePlacementTargetKindMatch(
    entry: PluginUiSurfacePlacementProjection,
    targetKind: PluginSurfaceTargetKind,
): boolean {
    return readTargetKind(entry) === targetKind;
}

export function selectPluginRightSidebarTabPlacements(
    model: PluginUiProjectionModel,
    scope: PluginRightSidebarPlacementScope,
    targetKind: PluginSurfaceTargetKind = scope,
): readonly PluginUiSurfacePlacementProjection[] {
    return Object.freeze(selectPluginSurfacePlacementsForPlacement(model, `${scope}.rightSidebarTab`)
        .filter((entry) => doesPluginSurfacePlacementTargetKindMatch(entry, targetKind)));
}

export function selectRenderablePluginRightSidebarTabPlacements(
    model: PluginUiProjectionModel,
    scope: PluginRightSidebarPlacementScope,
    policyContext?: PluginUiPolicyEvaluationContext,
): readonly PluginUiSurfacePlacementProjection[] {
    return Object.freeze(selectPluginRightSidebarTabPlacements(model, scope).filter((entry) => (
        entry.availability.state === 'available'
        && canRenderPluginUiProjectionEntry(entry, policyContext)
    )));
}

/**
 * The four session-pane placement kinds that replaced the legacy `sessionSurfaces`
 * family (Phase 2.1). Session panes are now canonical `surfacePlacement`
 * contributions on these kinds (see the §16 SurfaceRegistry descriptors).
 */
export const SESSION_SURFACE_PLACEMENT_KINDS: readonly string[] = Object.freeze([
    'session.details',
    'session.preview',
    'session.tool',
    'session.side',
]);

/**
 * Resolve a migrated session-pane surface placement by the surface descriptor id a
 * `pluginSessionSurface` tab resource references. Searches the session-pane
 * placement kinds (`session.details/preview/tool/side`) for an entry whose
 * descriptor id (or full projection id) matches. Returns `null` when no session
 * placement matches. This is the canonical replacement for the deleted
 * `sessionSurfacesById[surfaceId]` lookup.
 */
export function selectPluginSessionSurfacePlacementById(
    model: PluginUiProjectionModel,
    surfaceId: string,
): PluginUiSurfacePlacementProjection | null {
    const id = surfaceId.trim();
    if (id.length === 0) {
        return null;
    }
    for (const placementKind of SESSION_SURFACE_PLACEMENT_KINDS) {
        for (const entry of model.surfacePlacementsByPlacement[placementKind] ?? []) {
            if (entry.descriptorId === id || entry.id === id) {
                return entry;
            }
        }
    }
    return null;
}
