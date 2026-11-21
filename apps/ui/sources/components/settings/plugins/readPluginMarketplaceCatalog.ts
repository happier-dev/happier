import type { MarketplaceIndexEntryV1, MarketplaceIndexSourceSnapshotV1, PluginUpdatePolicyV1 } from '@happier-dev/protocol/marketplace';
import { decideMarketplaceListingReviewV1 } from '@happier-dev/protocol/marketplace';
import { registryMarketplaceSourceV1, type RegistryItemSummaryV1, type RegistryListPageV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';

export type PluginMarketplaceCatalogSourceKind = MarketplaceIndexSourceSnapshotV1['source']['kind'];
export type PluginMarketplaceSourceFreshness = 'fresh' | 'stale' | 'stale-offline' | 'unavailable' | 'auth-unavailable' | 'corrupt';
export type PluginMarketplaceCatalogEntry = Readonly<{
    id: string; itemId?: string; sourceId: string; sourceKind: PluginMarketplaceCatalogSourceKind; sourceTitle: string;
    reviewStatus: MarketplaceIndexEntryV1['review']['status'] | null; updatePolicy: PluginUpdatePolicyV1 | null;
    publisher: MarketplaceIndexEntryV1['publisher']; categories: MarketplaceIndexEntryV1['categories'];
    contributions: MarketplaceIndexEntryV1['summary']['contributions']; links: MarketplaceIndexEntryV1['links'];
    executableRealms: MarketplaceIndexEntryV1['summary']['executableRealms'];
    platforms: MarketplaceIndexEntryV1['compatibility']['platforms'];
    title: string; description: string | null; version: string | null; packageName: string;
    gitCatalogItemId?: string;
    vendorPlugin?: RegistryItemSummaryV1['vendorPlugin'];
    /** Published review eligibility only. Chosen-machine install admission stays with the daemon. */
    installable: boolean; registrySelectionOrigin: string | null; warning?: 'withdrawn' | 'unreviewed';
}>;
export type PluginMarketplaceDiscoverDiagnostic = Readonly<{
    id: string; sourceId: string | null; sourceTitle: string | null; code: string; message: string;
}>;
export type PluginMarketplaceDiscoverSourceStatus = Readonly<{
    id: string; title: string; kind: PluginMarketplaceCatalogSourceKind; freshness: PluginMarketplaceSourceFreshness;
    diagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
}>;
export type PluginMarketplaceNonInstallableListing = Readonly<{
    pluginId: string; title: string; sourceId: string; sourceTitle: string;
    reason: 'sourceStale' | 'artifactUnavailable' | 'notApproved' | 'unsupportedSourceKind';
}>;
export type PluginMarketplaceDiscoverPage = Readonly<{
    /** Retained view-model paging demand; actual cursors remain source-owned Registry pages. */
    nextCursor: string | null; entries: readonly PluginMarketplaceCatalogEntry[];
    sources: readonly PluginMarketplaceDiscoverSourceStatus[];
    diagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
    nonInstallable: readonly PluginMarketplaceNonInstallableListing[];
}>;
type RegistryMarketplaceProjectionInput = Readonly<{
    items: readonly RegistryItemSummaryV1[]; pages: readonly RegistryListPageV1[];
    sources: readonly (RegistrySourceDescriptorV1 | MarketplaceIndexSourceSnapshotV1['source'])[];
}>;
type RegistryMarketplaceProjectionBaseline = Readonly<{
    input: RegistryMarketplaceProjectionInput;
    page: PluginMarketplaceDiscoverPage;
}>;
const itemKey = (item: Pick<RegistryItemSummaryV1, 'kind' | 'sourceId' | 'itemId'>) => JSON.stringify([item.kind, item.sourceId, item.itemId]);
const sourceProjectionEntries = (source: RegistryMarketplaceProjectionInput['sources'][number])
    : [string, MarketplaceIndexSourceSnapshotV1['source']][] => {
    if ('packageContent' in source) return [];
    return [[source.id, 'sourceUrl' in source ? source : registryMarketplaceSourceV1(source)]];
};

/** Published Registry metadata into the retained Discover presentation, with no machine facts. */
export function projectRegistryMarketplacePage(input: RegistryMarketplaceProjectionInput,
    previous?: RegistryMarketplaceProjectionBaseline): PluginMarketplaceDiscoverPage {
    const entries: PluginMarketplaceCatalogEntry[] = [], nonInstallable: PluginMarketplaceNonInstallableListing[] = [];
    const bySource = new Map(input.sources.filter(source => !('enabled' in source) || source.enabled)
        .flatMap(sourceProjectionEntries));
    const priorSources = new Map(previous?.input.sources.flatMap(sourceProjectionEntries));
    const priorItems = new Map(previous?.input.items.map(item => [itemKey(item), item]));
    const priorEntries = new Map(previous?.page.entries.flatMap(entry => entry.itemId === undefined ? []
        : [[itemKey({ kind: 'plugin', sourceId: entry.sourceId, itemId: entry.itemId }), entry] as const]));
    for (const item of input.items) {
        if (item.kind !== 'plugin') continue;
        const source = bySource.get(item.sourceId);
        if (!source) continue;
        const key = itemKey(item);
        const priorSource = priorSources.get(item.sourceId);
        const priorEntry = priorEntries.get(key);
        // The Registry owner already reconciles content. Carry that identity through this
        // producer, while a source rename/kind change still reprojects its presentation/policy.
        if (priorEntry && priorItems.get(key) === item && priorSource?.kind === source.kind
            && priorSource.title === source.title && priorSource.sourceUrl === source.sourceUrl) {
            entries.push(priorEntry);
            continue;
        }
        const listing = item.pluginListing;
        const vendorPlugin = item.vendorPlugin;
        // Older readers can omit presentation facts. Keep a useful row, without
        // inventing a review decision or an executable installation coordinate.
        if (!listing) {
            entries.push({ id: item.itemId, itemId: item.itemId, sourceId: source.id, sourceKind: source.kind, sourceTitle: source.title,
                title: item.title, description: item.description ?? null, version: item.version ?? null,
                publisher: { id: '', displayName: item.publisher?.name ?? '' },
                categories: vendorPlugin?.categories ?? [], contributions: [], links: {},
                ...(vendorPlugin ? { vendorPlugin } : {}),
                executableRealms: [], platforms: [], reviewStatus: null, updatePolicy: null, packageName: '',
                installable: item.pluginGit !== undefined, registrySelectionOrigin: null,
                ...(item.pluginGit ? { gitCatalogItemId: item.itemId, links: { repository: item.pluginGit.locator } } : {}) });
            continue;
        }
        const decision = decideMarketplaceListingReviewV1({ source, review: listing.review });
        const withdrawn = !decision.installable && decision.block === 'curated-review-withdrawn';
        if (!decision.installable && !withdrawn) {
            nonInstallable.push({ pluginId: listing.pluginId, title: item.title, sourceId: source.id,
                sourceTitle: source.title, reason: decision.block === 'unsupported-source-kind' ? 'unsupportedSourceKind' : 'notApproved' });
            continue;
        }
        entries.push({ id: listing.pluginId, itemId: item.itemId, sourceId: source.id, sourceKind: source.kind, sourceTitle: source.title,
            reviewStatus: listing.review.status, updatePolicy: listing.updatePolicy, publisher: listing.publisher,
            categories: listing.categories, contributions: listing.contributions, links: listing.links,
            executableRealms: listing.executableRealms, platforms: listing.platforms,
            title: item.title, description: item.description ?? null, version: item.version ?? null,
            packageName: listing.packageName, installable: decision.installable, registrySelectionOrigin: null,
            ...(withdrawn ? { warning: 'withdrawn' as const } : source.kind !== 'curated' && listing.review.status === 'unreviewed'
                ? { warning: 'unreviewed' as const } : {}) });
    }
    const sources = input.pages.map(page => {
        const source = input.sources.find(source => source.id === page.sourceId);
        const title = source?.title ?? page.sourceId;
        const diagnostics = page.status.state === 'ok' ? [] : [{ id: 'source:' + encodeURIComponent(page.sourceId) + ':' + page.status.state,
            sourceId: page.sourceId, sourceTitle: title, code: page.status.state, message: describeRegistrySourceStatus(page.status) }];
        const freshness: PluginMarketplaceSourceFreshness = page.status.state === 'ok' ? 'fresh'
            : page.status.state === 'auth_failed' ? 'auth-unavailable'
                : page.status.state === 'invalid_source' || page.status.state === 'newer_format' ? 'corrupt' : 'unavailable';
        return { id: page.sourceId, title, kind: bySource.get(page.sourceId)?.kind ?? 'user' as const, freshness, diagnostics };
    });
    const stableEntries = previous && entries.length === previous.page.entries.length
        && entries.every((entry, index) => entry === previous.page.entries[index]) ? previous.page.entries : entries;
    return { entries: stableEntries, sources, diagnostics: sources.flatMap(source => source.diagnostics), nonInstallable,
        nextCursor: input.pages.some(page => page.nextCursor !== null) ? 'more' : null };
}
