import { describe, expect, it } from 'vitest';
import { MarketplaceIndexEntryV1Schema, DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, type MarketplaceIndexEntryV1 } from '@happier-dev/protocol/marketplace';
import { RegistryItemV1Schema, RegistryListPageV1Schema, RegistrySourceDescriptorV1Schema,
    registryPluginSummaryV1, type RegistryItemV1, type RegistryListPageV1 } from '@happier-dev/protocol/registries';
import { projectRegistryMarketplacePage } from './readPluginMarketplaceCatalog';
import { buildPluginCatalogInstallInput } from './model/buildPluginCatalogInstallInput';

type Source = Extract<RegistryItemV1['payload'], { listing: MarketplaceIndexEntryV1 }>['source'];
const curated: Source = { id: 'marketplace:curated', title: 'Happier curated', kind: 'curated',
    sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL };
const community: Source = { id: 'marketplace:community-npm', title: 'Community npm', kind: 'community-npm',
    sourceUrl: 'https://registry.npmjs.org' };
const internal: Source = { id: 'marketplace:internal', title: 'Internal index', kind: 'user',
    sourceUrl: 'https://internal.example.test/index.json' };

function sourceDescriptor(source: Source) {
    const descriptor = RegistrySourceDescriptorV1Schema.parse({ id: source.id, title: source.title, url: source.sourceUrl,
        format: source.kind === 'community-npm' ? 'happier-npm' : 'happier-catalog', kinds: ['plugin'],
        enabled: true, addedAt: 1, origin: { kind: source.kind === 'user' ? 'user' : 'built_in' }, removable: source.kind === 'user' });
    if ('packageContent' in descriptor) throw new Error('Expected remote marketplace fixture');
    return descriptor;
}
function registryItem(overrides: Partial<MarketplaceIndexEntryV1> = {}, source: Source = curated) {
    const listing = MarketplaceIndexEntryV1Schema.parse({
        pluginId: 'sample.plugin', publisher: { id: 'sample', displayName: 'Sample' },
        display: { title: 'Sample Plugin', description: 'Marketplace listing' },
        distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: 'sample-plugin', version: '1.2.3',
            integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
        manifestDigest: 'sha256:' + 'a'.repeat(64), compatibility: { happier: '>=1', platforms: ['web'] },
        summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
        review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' }, categories: ['agents'], media: [], updatePolicy: 'allowed', links: {},
        ...overrides,
    });
    return RegistryItemV1Schema.parse({ summary: { sourceId: source.id, kind: 'plugin', itemId: source.kind === 'community-npm' ? listing.distribution.packageName : listing.pluginId,
        title: listing.display.title, version: listing.distribution.version }, payload: { kind: 'plugin', listing, source }, fetchedAt: 1 });
}
function page(items: readonly RegistryItemV1[], pages?: readonly RegistryListPageV1[], sources: readonly Source[] = [curated]) {
    return projectRegistryMarketplacePage({ items: items.map(item => {
        if (item.payload.kind !== 'plugin' || !('listing' in item.payload)) throw new Error('Expected npm plugin fixture');
        return registryPluginSummaryV1(sourceDescriptor(item.payload.source), item.payload.listing);
    }), sources: sources.map(sourceDescriptor),
        pages: pages ?? sources.map(source => RegistryListPageV1Schema.parse({ sourceId: source.id,
            status: { state: 'ok', fetchedAt: 1 }, items: items.filter(item => item.summary.sourceId === source.id).map(item => item.summary), nextCursor: null })) });
}

describe('projectRegistryMarketplacePage', () => {
    it('selects a Git catalog pointer without treating the preview URL as installation authority', () => {
        const source = RegistrySourceDescriptorV1Schema.parse({ id: 'vendor', title: 'Vendor', format: 'claude-marketplace',
            kinds: ['plugin'], url: 'https://example.com/marketplace.json', enabled: true, addedAt: 0,
            origin: { kind: 'user' }, removable: true });
        const vendorPlugin = { categories: ['Developer Tools'], contentCounts: { skills: 2 }, notImported: { hooks: 1 } };
        const page = projectRegistryMarketplacePage({ sources: [source], pages: [], items: [{ sourceId: source.id,
            itemId: 'kit', title: 'Kit', kind: 'plugin', pluginGit: { locator: 'https://github.com/vendor/kit' },
            publisher: { name: 'Example Labs' }, vendorPlugin }] });
        const entry = page.entries[0]!;
        expect(entry).toMatchObject({ title: 'Kit', version: null, installable: true, categories: ['Developer Tools'],
            publisher: { displayName: 'Example Labs' }, vendorPlugin });
        expect(buildPluginCatalogInstallInput(entry, 'home')).toEqual({ machineId: 'home',
            source: { kind: 'gitCatalog', sourceId: 'vendor', itemId: 'kit' } });
    });
    it('ignores packaged app sources while retaining the healthy Plugin listing across source refresh', () => {
        const descriptor = sourceDescriptor(curated);
        const item = registryItem();
        if (item.payload.kind !== 'plugin' || !('listing' in item.payload)) throw new Error('Expected npm plugin fixture');
        const packaged = RegistrySourceDescriptorV1Schema.parse({ id: 'com.example.apps/apps', title: 'Packaged apps',
            format: 'happier-catalog', kinds: ['app'], packageContent: { pluginId: 'com.example.apps', pluginVersion: '1.0.0',
                occurrenceId: 'apps:current', path: 'resources/apps.json' }, enabled: true, addedAt: 0, removable: false,
            origin: { kind: 'plugin', pluginId: 'com.example.apps', localId: 'apps', suppliers: ['machine-a'] } });
        const input = { items: [registryPluginSummaryV1(descriptor, item.payload.listing)], pages: [], sources: [packaged, descriptor] };
        const projected = projectRegistryMarketplacePage(input);
        expect(projected.entries).toMatchObject([{ id: 'sample.plugin', sourceId: curated.id, installable: true }]);
        expect(projectRegistryMarketplacePage({ ...input, sources: [descriptor] }, { input, page: projected }).entries)
            .toBe(projected.entries);
    });
    it('carries native item identity across reorder without hiding source rename, withdrawal or review changes', () => {
        const descriptors = [sourceDescriptor(curated), sourceDescriptor(internal)];
        const listings = [registryItem(), registryItem({ review: { status: 'unreviewed', reviewedAt: null } }, internal)];
        const items = listings.map((item, index) => {
            if (item.payload.kind !== 'plugin' || !('listing' in item.payload)) throw new Error('Expected npm plugin fixture');
            return registryPluginSummaryV1(descriptors[index]!, item.payload.listing);
        });
        const input = { items, sources: descriptors, pages: [] };
        const projected = projectRegistryMarketplacePage(input);
        const previous = { input, page: projected };
        expect(projectRegistryMarketplacePage(input, previous).entries).toBe(projected.entries);
        expect(projectRegistryMarketplacePage({ ...input, items: [items[1]!, items[0]!] }, previous).entries)
            .toEqual([projected.entries[1], projected.entries[0]]);
        expect(projectRegistryMarketplacePage({ ...input, items: [items[1]!, items[0]!] }, previous).entries[0])
            .toBe(projected.entries[1]);
        const renamed = projectRegistryMarketplacePage({ ...input,
            sources: [{ ...descriptors[0]!, title: 'Renamed catalog' }, descriptors[1]!] }, previous);
        expect(renamed.entries[0]).toMatchObject({ sourceTitle: 'Renamed catalog' });
        expect(renamed.entries[0]).not.toBe(projected.entries[0]);
        expect(renamed.entries[1]).toBe(projected.entries[1]);
        expect(projectRegistryMarketplacePage({ ...input, sources: [descriptors[1]!] }, previous).entries)
            .toEqual([projected.entries[1]]);
        const changed = { ...items[0]!, pluginListing: { ...items[0]!.pluginListing!, review: { status: 'blocked' as const, reviewedAt: null } } };
        expect(projectRegistryMarketplacePage({ ...input, items: [changed, items[1]!] }, previous).entries)
            .toEqual([projected.entries[1]]);
    });
    it('keeps old summary rows useful without fabricating published review or installation facts', () => {
        const projected = projectRegistryMarketplacePage({ items: [{ sourceId: community.id, kind: 'plugin', itemId: '@sample/plugin',
            title: 'Old summary', description: 'Published description', version: '1.2.3' }], pages: [], sources: [sourceDescriptor(community)] });
        expect(projected.entries).toEqual([expect.objectContaining({ title: 'Old summary', description: 'Published description',
            version: '1.2.3', itemId: '@sample/plugin', reviewStatus: null, updatePolicy: null, installable: false })]);
    });
    it('projects the pinned listing and its published install coordinate without machine admission facts', () => {
        const projected = page([registryItem({ links: { homepage: 'https://example.test/plugin', repository: 'https://example.test/source', support: null },
            summary: { contributions: ['agents', 'tools'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] } })]);
        expect(projected.entries).toEqual([expect.objectContaining({ id: 'sample.plugin', sourceId: curated.id, sourceKind: 'curated',
            title: 'Sample Plugin', version: '1.2.3', packageName: 'sample-plugin', installable: true, registrySelectionOrigin: null,
            contributions: ['agents', 'tools'], links: { homepage: 'https://example.test/plugin', repository: 'https://example.test/source', support: null } })]);
        expect(projected.nonInstallable).toEqual([]);
    });
    it('keeps a pinned curated listing installable without advertising an update', () => {
        expect(page([registryItem({ updatePolicy: 'pinned' })]).entries[0]).toMatchObject({ updatePolicy: 'pinned', installable: true });
    });
    it.each([community, internal])('offers unreviewed code from $title to the daemon install review', source => {
        const item = registryItem({ review: { status: 'unreviewed', reviewedAt: null } }, source);
        const projected = page([item], undefined, [source]);
        expect(projected.entries[0]).toMatchObject({ sourceId: source.id, installable: true, warning: 'unreviewed', registrySelectionOrigin: null });
        expect(projected.nonInstallable).toEqual([]);
    });
    it('keeps a withdrawn curated listing visible as a warning without granting install authority', () => {
        const projected = page([registryItem({ review: { status: 'withdrawn', reviewedAt: null } })]);
        expect(projected.entries[0]).toMatchObject({ id: 'sample.plugin', warning: 'withdrawn', installable: false });
        expect(projected.nonInstallable).toEqual([]);
    });
    it('refuses a blocked curated listing through the canonical review decision', () => {
        const projected = page([registryItem({ review: { status: 'blocked', reviewedAt: null } })]);
        expect(projected.entries).toEqual([]);
        expect(projected.nonInstallable).toEqual([expect.objectContaining({ pluginId: 'sample.plugin', sourceId: curated.id, reason: 'notApproved' })]);
    });
    it('keeps a healthy source visible while a second source fails and preserves paging demand', () => {
        const item = registryItem();
        const pages = [RegistryListPageV1Schema.parse({ sourceId: curated.id, status: { state: 'ok', fetchedAt: 1 },
            items: [item.summary], nextCursor: 'curated-next' }), RegistryListPageV1Schema.parse({ sourceId: internal.id,
            status: { state: 'auth_failed' }, items: [], nextCursor: null })];
        const projected = page([item], pages, [curated, internal]);
        expect(projected.entries).toHaveLength(1);
        expect(projected.nextCursor).not.toBeNull();
        expect(projected.sources.find(source => source.id === internal.id)).toMatchObject({ title: internal.title });
        expect(projected.sources.find(source => source.id === internal.id)?.diagnostics).not.toEqual([]);
    });
});
