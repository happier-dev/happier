import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import type { PluginUiInlineSurfaceMountV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiInlineSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import {
    resolveWidgetInlineMount,
    selectWidgetPlacementsBySurface,
    type WidgetPresentation,
    type WidgetTargetKind,
} from '@/sync/domains/plugins/ui/widgetContract';
import type { PluginSurfacePresentationState } from '@/sync/domains/surfaces/copy/resolveReasonCopy';

/**
 * The installed arm passed by the configured-instance adapter: a stable
 * qualified surface identity and nothing else — no plugin version, immutable
 * generation, renderer, machine, Artifact or placement. A Board item stores it
 * inside its canonical instance definition; this mount-only wrapper is not a persisted shape.
 */
export type InstalledWidgetSource = Readonly<{
    kind: 'installedSurface';
    surface: PluginContributionIdentityV1;
}>;

/**
 * The correlation result the widget host consumes.
 *
 * This resolver answers exactly one question: does the stored stable reference
 * name one currently projected widget placement for THIS target? It
 * deliberately makes no availability, currentness, generation, renderer,
 * Artifact, policy or crash decision — those stay with the incumbent
 * `PluginSurfaceHost`/`boundPluginSurfaceController` path once a placement is
 * handed to it.
 *
 * When no exact placement resolves, it returns the canonical presentation
 * owner's own input vocabulary (`state` + `reasonCode`) rather than a widget
 * availability enum: the caller passes it straight to
 * `resolvePluginSurfaceStatePresentation` and renders `SurfaceStateCard` inside
 * the retained widget shell.
 */
export type InstalledWidgetMount = Readonly<{
    /** Present only when exactly one admitted placement matched. */
    placement: PluginUiInlineSurfacePlacementProjection | null;
    /** The Registry-admitted role/presentation pair for this physical host. */
    inlineMount: PluginUiInlineSurfaceMountV1 | null;
    /** Canonical state-presentation input; `null` once a placement resolved. */
    unresolved: Readonly<{
        state: PluginSurfacePresentationState;
        /** Diagnostic-only; unmapped codes localize to the generic line. */
        reasonCode: string;
    }> | null;
}>;

function unresolved(
    state: PluginSurfacePresentationState,
    reasonCode: string,
): InstalledWidgetMount {
    return Object.freeze({
        placement: null,
        inlineMount: null,
        unresolved: Object.freeze({ state, reasonCode }),
    });
}

/**
 * Resolve one stored installed-widget reference against the exact current
 * plugin projection of its host (a Session's, or the app's).
 *
 * Fails closed on a missing OR duplicate qualified identity: projection order
 * must never appoint an owner for an executable surface. A destination, another
 * inline role, or a widget for the other target that happens to share the
 * local id is not this widget.
 */
export function resolveInstalledWidgetMount(input: Readonly<{
    source: InstalledWidgetSource;
    target: WidgetTargetKind;
    /** The public embedded presentation this physical host maps onto. */
    presentation: WidgetPresentation;
    runtime: Pick<PluginUiProjectionCurrentness, 'phase' | 'pluginUiProjection'>;
}>): InstalledWidgetMount {
    const inlineMount = resolveWidgetInlineMount(input.presentation, input.target);
    if (!inlineMount) {
        return unresolved('unavailable', 'widget_presentation_unadmitted');
    }
    const projection = input.runtime.pluginUiProjection;
    if (!projection) {
        // An establishing projection is loading, not absent: an unfinished
        // fetch must not present a stored widget as a removed surface.
        return input.runtime.phase === 'establishing'
            ? unresolved('loading', 'widget_projection_establishing')
            : unresolved('unavailable', 'widget_projection_unavailable');
    }
    const placements = selectWidgetPlacementsBySurface(projection, input.source.surface, input.target);
    if (placements.length !== 1) {
        return unresolved(
            'unavailable',
            placements.length === 0 ? 'widget_surface_absent' : 'widget_surface_ambiguous',
        );
    }
    // The projection normalizer already parsed this binding through
    // `PluginUiSurfaceBindingV1Schema`, whose inline arm enforces the Registry
    // role/target/placement correspondence, and the selector matched the exact
    // qualified identity, role and target. Re-checking those here would be a
    // second admission owner, not defence in depth.
    return Object.freeze({
        placement: placements[0]!,
        inlineMount,
        unresolved: null,
    });
}

// Source-identity immutability is NOT decided here. `isSessionSurfaceItemSourceCompatible`
// in `@happier-dev/protocol/sessions/board` is the one owner of that rule, and the
// UI, CLI and server Board mutation paths all consume it to return
// `session_board_source_conflict`. A second UI-local copy of the same comparison
// would be a competing decision-maker for one concept, and the Add picker never
// substitutes a source in place: it creates a new item.
