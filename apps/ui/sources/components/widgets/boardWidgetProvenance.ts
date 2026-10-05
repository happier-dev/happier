import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { resolvePluginSurfaceDestinationLabel } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectWidgetPlacementsBySurface } from '@/sync/domains/plugins/ui/widgetContract';
import { t } from '@/text';
import { resolveSessionScmReviewComparisonLabel } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

/**
 * Who a Session widget says it comes from.
 *
 * A durable Board item outlives the plugin generation that renders it, so the
 * name people read must stay truthful in every state — mounted, loading,
 * updating and unavailable. Collapsing every installed source to “From a plugin”
 * is the failure this owner exists to prevent: with two review widgets on one
 * Board, that label makes the disabled one indistinguishable from the working
 * one and makes "Manage plugin" a guess.
 *
 * Provenance is presentation only. It never becomes an authority, currentness or
 * availability input, and it never replaces the item's own user-owned title.
 */

export type BoardWidgetProvenance = Readonly<{
    /** The quiet secondary line under the widget title. */
    label: string;
    /**
     * The accessible label, which always retains the exact qualified identity
     * when two installed plugins present the same display name.
     */
    accessibilityLabel: string;
}>;

function provenance(label: string, accessibilityLabel?: string): BoardWidgetProvenance {
    return Object.freeze({ label, accessibilityLabel: accessibilityLabel ?? label });
}

/**
 * Resolve one item's provenance line from the exact current Session projection.
 *
 * `projection` is `null` whenever the host has no plugin runtime yet. An
 * installed widget then keeps a truthful generic line rather than inventing a
 * plugin name from its stored identity.
 */
export function resolveBoardWidgetProvenance(
    source: SessionSurfaceItemV1['source'],
    projection: PluginUiProjectionModel | null | undefined,
): BoardWidgetProvenance {
    if (source.kind === 'declarative') return provenance(t('sessionBoard.item.provenance.note'));
    if (source.kind === 'walkthrough') return provenance(resolveSessionScmReviewComparisonLabel({ kind: source.comparison }));
    if (source.kind !== 'widget' || source.instance.definition.kind !== 'installed') {
        return provenance(t('sessionBoard.item.provenance.interactiveView'));
    }

    const surface = source.instance.definition.surface;
    const installed = projection?.installedPackagesById[surface.pluginId] ?? null;
    const pluginName = installed?.displayName.trim();
    if (!pluginName) {
        // The plugin is not installed on this device (or not yet projected).
        // Naming its id is more useful than "a plugin", and it is exactly what
        // the person needs to find it in Manage plugins.
        return provenance(t('sessionBoard.item.provenance.pluginMissing', {
            pluginId: surface.pluginId,
        }));
    }

    const placements = projection
        ? selectWidgetPlacementsBySurface(projection, surface)
        : [];
    const localize = createPluginLocalizedTextResolver({ projection });
    // Exactly one admitted placement is the same rule the mount resolver uses;
    // an ambiguous or absent surface contributes no contribution title.
    const contributionTitle = placements.length === 1
        ? resolvePluginSurfaceDestinationLabel(placements[0]!, localize)
        : null;

    const label = contributionTitle
        ? t('sessionBoard.item.provenance.pluginSurface', { plugin: pluginName, surface: contributionTitle })
        : pluginName;
    // Two installed plugins may legitimately share a display name. Assistive
    // technology keeps the qualified plugin id so they stay distinguishable.
    const duplicateDisplayName = Object.entries(projection?.installedPackagesById ?? {}).some((
        [pluginId, entry],
    ) => pluginId !== surface.pluginId && entry.displayName.trim() === pluginName);
    return provenance(
        label,
        duplicateDisplayName
            ? t('sessionBoard.item.provenance.pluginQualified', { label, pluginId: surface.pluginId })
            : label,
    );
}
