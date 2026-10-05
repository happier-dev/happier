import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import type { PluginUiInlineSurfaceMountV1, PluginUiWidgetHomeV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginUiWidgetHomeV1Schema, resolvePluginUiInlineSurfaceSlotV1, selectPluginUiWidgetEntriesV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiInlineSurfacePlacementProjection, PluginUiProjectionModel } from './projection';
import { canRenderPluginUiProjectionEntry } from './policy';
import type { PluginUiPolicyEvaluationContext } from './policy';

/**
 * The plugin `widget` contribution as the app host reads it.
 *
 * One widget role, executed against a Session or the App independent of its
 * physical Home, Board or Companion host. The
 * Protocol Surface Registry owns the role and its per-target rows; every host
 * question about a widget's role, target or Home default is answered here, over
 * those exports, and no consumer spells the role or reads a target itself.
 */
export const WIDGET_ROLE = 'widget' as const;

export type WidgetTargetKind = 'session' | 'app';

/**
 * Where a widget stands on Home before the person has said anything:
 * `shown` joins Home after the built-in sections while its plugin is enabled;
 * `available` waits in Customize → Add widgets. An omitted value is `available`.
 */
export type WidgetHomeDefault = PluginUiWidgetHomeV1['default'];

/** The embedded presentations a widget host may map onto. */
export type WidgetPresentation = 'content' | 'fill';

export function readWidgetTargetKind(placement: PluginUiInlineSurfacePlacementProjection): WidgetTargetKind {
    return placement.binding.targetKind;
}

/**
 * The manifest's `home.default`, which the daemon projects onto every widget
 * row (explicit `available` when the author omitted it). A row without a valid
 * value is `available`: Home never shows a widget nobody asked for.
 */
export function readWidgetHomeDefault(placement: PluginUiInlineSurfacePlacementProjection): WidgetHomeDefault {
    const home = PluginUiWidgetHomeV1Schema.safeParse(placement.home);
    return home.success ? home.data.default : 'available';
}

/** Every admitted widget, independent of the physical surface hosting its instance. */
export function selectRenderableWidgetPlacements(
    projection: PluginUiProjectionModel,
    policyContext?: PluginUiPolicyEvaluationContext,
): readonly PluginUiInlineSurfacePlacementProjection[] {
    return Object.freeze(selectPluginUiWidgetEntriesV1(Object.values(projection.surfacePlacementsById))
        .filter((entry) => entry.availability.state === 'available' && canRenderPluginUiProjectionEntry(entry, policyContext)));
}

/**
 * Every projected widget placement for one exact qualified identity and
 * target. Callers still require exactly one: a duplicate identity is a
 * projection violation, never an ordering tie-break.
 */
export function selectWidgetPlacementsBySurface(
    projection: PluginUiProjectionModel,
    surface: PluginContributionIdentityV1,
    target?: WidgetTargetKind,
): readonly PluginUiInlineSurfacePlacementProjection[] {
    return selectPluginUiWidgetEntriesV1(Object.values(projection.surfacePlacementsById), { surface, targetKind: target });
}

/**
 * The Registry-admitted inline mount for one widget presentation on one
 * target, or `null` when the Registry does not admit that pair. The mount is
 * role + presentation; the target travels on the placement's binding.
 */
export function resolveWidgetInlineMount(
    presentation: WidgetPresentation,
    target: WidgetTargetKind,
): PluginUiInlineSurfaceMountV1 | null {
    const slot = resolvePluginUiInlineSurfaceSlotV1(WIDGET_ROLE, presentation, target);
    if (!slot) return null;
    return Object.freeze({ role: WIDGET_ROLE, presentation: slot.presentation });
}
