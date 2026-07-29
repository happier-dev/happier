import type { MarketplaceIndexQueryResultV1 } from '@happier-dev/protocol';

export type PluginMarketplaceCatalogEntry = Readonly<{
    id: string;
    sourceId: string;
    sourceKind: 'curated' | 'community-npm';
    reviewStatus: 'approved' | 'withdrawn' | 'blocked' | 'unreviewed';
    title: string;
    description: string | null;
    version: string | null;
    installable: boolean;
    updateable: boolean;
    warning?: 'withdrawn';
}>;

export type PluginMarketplaceCatalog = Readonly<{
    sourceUrl: string;
    title: string;
    description: string | null;
    entries: readonly PluginMarketplaceCatalogEntry[];
}>;

export function projectDaemonMarketplaceIndex(result: MarketplaceIndexQueryResultV1): PluginMarketplaceCatalog {
    return {
        sourceUrl: 'daemon:marketplace-index',
        title: result.sources[0]?.source.title ?? '',
        description: null,
        entries: result.items.flatMap((entry) => {
            if (entry.source.kind !== 'curated' && entry.source.kind !== 'community-npm') {
                return [];
            }

            const curatedInstallable = entry.source.kind === 'curated'
                && entry.review.status === 'approved'
                && entry.review.reviewedAt !== null
                && entry.admission.curatedInstall === 'allowed';
            const communityInstallable = entry.source.kind === 'community-npm'
                && entry.review.status === 'unreviewed'
                && entry.admission.curatedInstall === 'full-review';
            const installable = (curatedInstallable || communityInstallable)
                && entry.freshness.state === 'fresh'
                && (entry.artifactAccess.state === 'public' || entry.artifactAccess.state === 'available');
            const updateable = (
                (
                    entry.source.kind === 'curated'
                    && entry.review.status === 'approved'
                    && entry.review.reviewedAt !== null
                    && entry.admission.curatedUpdate === 'allowed'
                )
                || communityInstallable
            )
                && entry.freshness.state === 'fresh'
                && (entry.artifactAccess.state === 'public' || entry.artifactAccess.state === 'available');
            const withdrawn = entry.source.kind === 'curated'
                && entry.review.status === 'withdrawn'
                && entry.admission.curatedInstall === 'refused'
                && entry.admission.curatedUpdate === 'refused'
                && entry.admission.warning
                && !entry.admission.disablesInstalledCode;

            if (!installable && !withdrawn) return [];

            return [{
                id: entry.pluginId,
                sourceId: entry.source.id,
                sourceKind: entry.source.kind,
                reviewStatus: entry.review.status,
                title: entry.display.title,
                description: entry.display.description,
                version: entry.distribution.version,
                installable,
                updateable,
                ...(withdrawn ? { warning: 'withdrawn' as const } : {}),
            }];
        }),
    };
}
