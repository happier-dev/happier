import type { PluginStoreKindContributionV1 } from '@happier-dev/protocol';
import type { ComponentType } from 'react';
import type { StoreKindSurfaceInput } from '../StoreKindSurface';
import type { PluginUiPhysicalSurfacePlacementProjection, PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectPluginSurfacePlacementsForBinding } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

/** Metadata only. Neither resolving a kind nor listing destinations imports its code. */
export const APP_STORE_KIND = Object.freeze({ key: 'app' as const, native: 'app' as const,
    load: () => import('../StoreAppKindSurface'),
});
export const BOT_STORE_KIND = Object.freeze({ key: 'bot' as const, native: 'bot' as const,
    load: () => import('../StoreBotsKindSurface'),
});

const loadPluginStoreKind = () => import('../StorePluginKindSurface');

/** Native Apps and contributed kinds use the same demand-loaded adapter mount. */
export function storeKindSurfaceLoader(key: string): () => Promise<{
    default: ComponentType<Readonly<{ kind: string; input: StoreKindSurfaceInput }>>;
}> {
    return key === APP_STORE_KIND.key ? APP_STORE_KIND.load : key === BOT_STORE_KIND.key ? BOT_STORE_KIND.load : loadPluginStoreKind;
}

export type ContributedStoreKind = Readonly<{
    key: string;
    pluginId: string;
    definition: PluginStoreKindContributionV1;
}>;
export type StoreKindContribution = typeof APP_STORE_KIND | typeof BOT_STORE_KIND | ContributedStoreKind;

export function listStoreKindContributions(
    projection: Pick<PluginUiProjectionModel, 'storeKindsById'> | null,
): readonly StoreKindContribution[] {
    return [APP_STORE_KIND, BOT_STORE_KIND, ...Object.values(projection?.storeKindsById ?? {}).map(entry => ({
        key: entry.id, pluginId: entry.pluginId, definition: entry.definition,
    }))];
}

export function resolveStoreKindContribution(key: string, projection: PluginUiProjectionModel | null):
    | typeof APP_STORE_KIND
    | typeof BOT_STORE_KIND
    | (ContributedStoreKind & Readonly<{ placement: PluginUiPhysicalSurfacePlacementProjection | null }>)
    | null {
    if (key === APP_STORE_KIND.key) return APP_STORE_KIND;
    if (key === BOT_STORE_KIND.key) return BOT_STORE_KIND;
    if (!projection) return null;
    const entry = projection.storeKindsById[key];
    if (!entry) return null;
    // The contribution catalog has admitted this same-plugin app-page reference.
    // Surface hosting remains the sole renderer availability/execution owner.
    const placement = selectPluginSurfacePlacementsForBinding(projection, { container: 'appPage', targetKind: 'app' }).find(candidate =>
        candidate.pluginId === entry.pluginId && candidate.binding.destination.localId === entry.definition.viewId,
    ) ?? null;
    return { key: entry.id, pluginId: entry.pluginId, definition: entry.definition, placement };
}
