import {
    isPluginUiDestinationBindingAdmittedAtRuntimeV1,
    type PluginUiDestinationRuntimeFormFactorV1,
    type PluginUiPlatformV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    readPluginSurfaceRecord,
    resolvePluginSurfaceDestinations,
} from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type {
    RightSidebarPluginTabDefinition,
    RightSidebarScope,
} from './rightSidebarBuiltinTabs';

export type RightSidebarPluginTabRuntimeAdmission = Readonly<{
    platform: PluginUiPlatformV1;
    formFactor: PluginUiDestinationRuntimeFormFactorV1;
}>;

export type ResolveRightSidebarPluginTabsInput = Readonly<{
    scope: RightSidebarScope;
    placements?: readonly PluginUiSurfacePlacementProjection[];
    projectionGeneration?: number | null;
    policyContext?: PluginUiPolicyEvaluationContext;
    /** Current mounted host facts for catalog admission. */
    runtimeAdmission?: RightSidebarPluginTabRuntimeAdmission;
}>;

function readRightSidebarMetadata(
    placement: PluginUiSurfacePlacementProjection,
): Readonly<Record<string, unknown>> | null {
    return readPluginSurfaceRecord(placement.rightSidebar);
}

function resolveRightSidebarPluginDestinations(input: Readonly<{
    scope: RightSidebarScope;
    placements?: readonly PluginUiSurfacePlacementProjection[];
    policyContext?: PluginUiPolicyEvaluationContext;
}>) {
    return resolvePluginSurfaceDestinations({
        ...(input.placements ? { placements: input.placements } : {}),
        ...(input.policyContext ? { policyContext: input.policyContext } : {}),
        select: (placement) => {
            if (
                placement.binding.container !== 'rightSidebarTab'
                || placement.binding.targetKind !== input.scope
            ) {
                return null;
            }
            return {
                // The normalized binding owns the public destination identity;
                // right-sidebar metadata cannot introduce a second tab-id alias.
                slug: placement.binding.destination.localId,
                // Final catalog order is host-owned. V2 projections publish no
                // contributor rank, so legacy metadata and placement-order
                // fields must not still move a plugin destination ahead of a
                // built-in or another host-owned entry.
                order: Number.MAX_SAFE_INTEGER,
            };
        },
        // Preserve the contributor's declared hide/disable policy. A missing
        // metadata record takes the schema default (`hide`) instead of making a
        // previously hidden destination interactable during migration.
        hideWhenDisabled: (placement) => (
            readRightSidebarMetadata(placement)?.disabledPolicy !== 'disable'
        ),
    });
}

function isMobilePluginTab(
    placement: PluginUiSurfacePlacementProjection,
    scope: RightSidebarScope,
): boolean {
    // Platform admission is a registry-owned binding fact. Do not retain a
    // side-channel `rightSidebar.mobile` flag: V2 never produces one, and a
    // project binding is intentionally not admitted on iOS/Android.
    return scope === 'session'
        && placement.binding.targetKind === 'session'
        && (isPluginUiDestinationBindingAdmittedAtRuntimeV1({
            binding: placement.binding,
            platform: 'ios',
            formFactor: 'phone',
        }) || isPluginUiDestinationBindingAdmittedAtRuntimeV1({
            binding: placement.binding,
            platform: 'android',
            formFactor: 'phone',
        }));
}

export function resolveRightSidebarPluginTabs(
    input: ResolveRightSidebarPluginTabsInput,
): readonly RightSidebarPluginTabDefinition[] {
    const generation = input.projectionGeneration ?? null;

    const destinations = resolveRightSidebarPluginDestinations(input).filter((destination) => (
        !input.runtimeAdmission
        || isPluginUiDestinationBindingAdmittedAtRuntimeV1({
            binding: destination.placement.binding,
            ...input.runtimeAdmission,
        })
    ));

    return Object.freeze(destinations.map((destination) => {
        return Object.freeze({
            id: destination.id,
            owner: 'plugin',
            label: destination.label,
            icon: destination.icon,
            ...(destination.badge === undefined ? {} : { badge: destination.badge }),
            ...(destination.groupHint === undefined ? {} : { groupHint: destination.groupHint }),
            ...(destination.rankHint === undefined ? {} : { rankHint: destination.rankHint }),
            order: destination.order,
            scopes: Object.freeze([input.scope]),
            ...(isMobilePluginTab(destination.placement, input.scope) ? {
                mobileSurfaces: Object.freeze({ session: 'plugin' }),
            } : {}),
            ...(destination.disabledReason ? { disabledReason: destination.disabledReason } : {}),
            placement: destination.placement,
            plugin: Object.freeze({
                pluginId: destination.placement.binding.destination.pluginId,
                descriptorId: destination.placement.binding.destination.localId,
                generation,
            }),
            retentionKey: `${destination.id}:${generation ?? 'unknown'}`,
        }) as RightSidebarPluginTabDefinition;
    }));
}
