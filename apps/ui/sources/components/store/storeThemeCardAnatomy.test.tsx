import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, flushHookEffects, measureMountedCollections, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { PluginUiScrollActivityProvider } from '@happier-dev/plugin-ui/advanced';
import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';
import * as themeColors from '@/theme/profiles/deriveThemeColors';
import type { StoreThemeCardView } from './storeThemeViewTypes';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui';

installPromptRegistriesCommonModuleMocks({ storage: original => original(), text: () => vi.importActual('@/text') });
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { useStoreThemeCardAnatomy } = await import('./storeThemeCardAnatomy');
const { StoreThemeListingController } = await import('./StoreThemeListingController');
const { StoreThemeListing } = await import('./StoreThemeListing');
const { Directory, useStoreThemeRows, useOpenRegistryItem, useSourceTitle } = await import('./StoreKindPage');
const { storeKinds } = await import('./catalog/storeKinds');
const { useRegistryItems } = await import('@/registries/useRegistryItems');
const { ThemeMiniaturePreview } = await import('@/components/settings/appearance/ThemeModePreview');
const { HappierBrandMark } = await import('@/components/ui/media/HappierBrandMark');
const { storage } = await import('@/sync/domains/state/storage');
await initializeArtifactInventoryDemandHarness();

it('acquires only measured near-viewport packages and reuses them across scroll-back and remount', async () => {
    const indexUrl = 'https://theme-card-counts.example.test/index.json';
    const sourceId = deriveMarketplaceSourceId(indexUrl);
    const reads: string[] = [];
    let bodyParses = 0;
    let nearATitle = 'near-a';
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
        disabledSourceIds: [], sources: [{ id: sourceId, title: 'Themes', url: indexUrl,
            format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 1 }] } }] });
    const ids = ['near-a', 'near-b', 'far', 'failed', 'icons', ...Array.from({ length: 55 }, (_, i) => `distant-${i}`)];
    let releaseNearB: () => void = () => {};
    const nearBPending = new Promise<void>(resolve => { releaseNearB = resolve; });
    const fixture = await createArtifactInventoryDemandHarness({ handleRequest: async (url, init) => {
        const config = await catalog.handle(`${url.pathname}${url.search}`, init);
        if (config) return config;
        if (url.href === indexUrl) return Response.json({ source: { id: sourceId, title: 'Themes', sourceUrl: indexUrl, kind: 'user' },
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], picks: [], diagnostics: [], themes: ids.map(itemId => ({
                itemId, title: itemId === 'near-a' ? nearATitle : itemId, version: '1.0.0', listing: { includes: itemId === 'icons' ? [] : [{ key: 'dark', label: 'Dark', mode: 'dark' }] },
                contentUrl: `https://theme-card-counts.example.test/${itemId}.json`,
            })) });
        const id = ids.find(itemId => url.href === `https://theme-card-counts.example.test/${itemId}.json`);
        if (id) {
            reads.push(id);
            if (id === 'near-b') await nearBPending;
            if (id === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
            const response = Response.json({ themes: id === 'icons' ? [] : [{ key: 'dark', label: 'Dark', mode: 'dark', document: { schemaVersion: 1,
                id, name: id, createdAt: '2026-11-17', updatedAt: '2026-11-17', base: { light: 'light', dark: 'dark' },
                overrides: { light: {}, dark: { 'background.canvas': id === 'far' ? '#28313a' : '#172033' } },
                assetAppearance: 'dark' } }] });
            const json = response.json.bind(response);
            response.json = () => { bodyParses++; return json(); };
            return response;
        }
        return null;
    } });
    fixture.inventory = [];
    onTestFinished(async () => { releaseNearB(); await standardCleanup(); await fixture.dispose(); });
    const initialBrowse = await renderHook(() => useRegistryItems({ kind: 'theme', sourceIds: [sourceId] }));
    await vi.waitFor(() => expect(initialBrowse.getCurrent().items).toHaveLength(60));
    const anatomy = await renderHook(() => useStoreThemeCardAnatomy());
    let offset = 0;
    const content = { getBoundingClientRect: () => ({ left: 0, top: -offset, width: 300, height: 2000 }) };
    const tracker = createScrollViewNearViewportTracker({ current: { getInnerViewRef: () => content } }, false, { initialViewportHeight: 200 });
    await act(async () => { tracker.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 200 } } }); });
    const liveRows: { current: ReturnType<typeof useStoreThemeRows> | null } = { current: null };
    const refresh: { current: (() => Promise<void>) | null } = { current: null };
    const rowCommits = new Map<string, number>();
    const input = { query: '', sourceIds: [sourceId] };
    function Gallery() {
        const list = storeKinds.theme.useList(input, { presented: true });
        refresh.current = list.refresh;
        const open = useOpenRegistryItem();
        const sourceTitle = useSourceTitle();
        const rows = useStoreThemeRows(list, open, sourceTitle);
        liveRows.current = rows;
        const cardAnatomy = useStoreThemeCardAnatomy();
        type Row = typeof rows.rows[number];
        const directoryAnatomy = React.useMemo<CollectionAnatomy<Row>>(() => ({
            previewAspectRatio: cardAnatomy.previewAspectRatio,
            columnTitles: cardAnatomy.columnTitles,
            title: row => cardAnatomy.title(row.card),
            titleMeta: row => <React.Profiler id={row.key} onRender={() => {
                rowCommits.set(row.key, (rowCommits.get(row.key) ?? 0) + 1);
            }}>{null}</React.Profiler>,
            glyph: row => cardAnatomy.glyph(row.card),
            where: row => cardAnatomy.where?.(row.card),
            reason: row => cardAnatomy.reason?.(row.card),
            preview: row => cardAnatomy.preview?.(row.card),
            accessibilityLabel: row => cardAnatomy.accessibilityLabel?.(row.card) ?? row.title,
            testID: row => cardAnatomy.testID?.(row.card) ?? row.key,
        }), [cardAnatomy]);
        return <Directory kind="theme" list={list} rows={rows.rows} groups={rows.groups} query=""
            sourceTitle={sourceTitle} anatomy={directoryAnatomy} presentation="grid" />;
    }
    const gallery = await renderScreen(<PluginUiScrollActivityProvider tracker={tracker}><Gallery /></PluginUiScrollActivityProvider>,
        { createNodeMock: element => ({ scrollTo: () => {}, getBoundingClientRect: () => ({ left: 0,
            top: element.props.accessibilityElementsHidden ? 20000 : 0, width: 1200, height: 800 }) }) });
    await measureMountedCollections(gallery);
    await vi.waitFor(() => expect(liveRows.current?.rows).toHaveLength(60));
    expect(rowCommits.size, 'the count observes the real Collection card rows').toBeGreaterThan(1);
    const initialRows = new Map(liveRows.current!.rows.map(row => [row.key, row]));
    rowCommits.clear();
    const cards = ids.map((id): StoreThemeCardView & { listing: { sourceId: string; itemId: string; version: string } } => ({
        key: id, name: id, byline: 'Themes', summary: '', faces: [], mark: { displayName: 'Themes' }, listing: { sourceId, itemId: id, version: '1.0.0' },
    }));
    let commits = 0;
    const surfaces: Array<{ screen: Awaited<ReturnType<typeof renderScreen>>; tree: () => React.ReactElement; node: { getBoundingClientRect: () => { left: number; top: number; width: number; height: number } } }> = [];
    for (const [index, card] of cards.entries()) {
        const top = [0, 240, 1200, 1600, 0][index] ?? 20000 + index * 240;
        const node = { getBoundingClientRect: () => ({ left: 0, top: top - offset, width: 300, height: 120 }) };
        const tree = () => <PluginUiScrollActivityProvider tracker={tracker}>
            <React.Profiler id={card.key} onRender={() => { commits++; }}>{anatomy.getCurrent().preview?.(card)}</React.Profiler>
        </PluginUiScrollActivityProvider>;
        const screen = await renderScreen(tree(), { createNodeMock: () => node });
        surfaces.push({ screen, tree, node });
    }
    await vi.waitFor(() => expect(liveRows.current!.rows,
        'a known non-theme contributes no grid cell, including when discovered on screen').toHaveLength(59));
    expect(liveRows.current!.rows.some(row => row.card.listing?.itemId === 'icons')).toBe(false);
    expect(liveRows.current!.rows.filter(row => initialRows.get(row.key) !== row).map(row => row.key),
        'one excluded package preserves every surviving Store card row').toEqual([]);
    const membershipTitleCommits = [...rowCommits.values()].reduce((sum, count) => sum + count, 0);
    await vi.waitFor(() => expect(reads.sort()).toEqual(['icons', 'near-a', 'near-b']));
    await vi.waitFor(() => expect(surfaces[0]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    // The foot says modes · what it changes once the card's own acquisition settles, and starts no read of its own.
    const { Text } = await import('@/components/ui/text/Text');
    const foot = async (card: StoreThemeCardView) => (await renderScreen(<>{anatomy.getCurrent().reason?.(card)}</>))
        .findAllByType(Text)[0]?.props.children;
    await vi.waitFor(async () => expect(await foot(cards[0]!)).toBe('Dark · Colors only'));
    expect(await foot(cards[2]!), 'a card off screen has nothing settled to say yet').toBe('');
    expect(reads.sort()).toEqual(['icons', 'near-a', 'near-b']);
    const pendingShell = surfaces[1]!.screen.findAll(node => typeof node.type === 'string' && node.type === 'View')[0]!;
    expect(surfaces[1]!.screen.findAllByType(HappierBrandMark)).toHaveLength(1);
    const beforePositiveArrival = liveRows.current!.rows;
    const beforePositivePreviewCommits = commits;
    rowCommits.clear();
    await act(async () => { releaseNearB(); });
    await vi.waitFor(() => expect(surfaces[1]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    const positiveArrivalPreviewCommits = commits - beforePositivePreviewCommits;
    expect(positiveArrivalPreviewCommits, 'one resolved package redraws only its preview leaf').toBe(1);
    expect(liveRows.current!.rows, 'a miniature arrival keeps the directory rows').toBe(beforePositiveArrival);
    expect([...rowCommits], 'a miniature arrival updates its leaf without redrawing Collection card titles').toEqual([]);
    console.info('STORE-PERF-1117 directory census', { initialRows: initialRows.size,
        retainedRows: liveRows.current!.rows.length, membershipTitleCommits, positiveArrivalTitleCommits: 0,
        positiveArrivalPreviewCommits });
    expect(surfaces[1]!.screen.findAll(node => typeof node.type === 'string' && node.type === 'View')[0]).toBe(pendingShell);
    const browse = await renderHook(() => useRegistryItems({ kind: 'theme', sourceIds: [sourceId] }));
    await vi.waitFor(() => expect(browse.getCurrent().items).toHaveLength(60));
    const rows = await renderHook(() => useStoreThemeRows(browse.getCurrent(), () => {}, () => 'Themes'));
    expect(rows.getCurrent().rows.some(row => row.card.listing?.itemId === 'icons')).toBe(false);
    expect(rows.getCurrent().rows).toHaveLength(59);
    const listing = await renderScreen(<StoreThemeListingController listing={cards[0]!.listing}>
        {view => <StoreThemeListing {...view} />}
    </StoreThemeListingController>);
    await vi.waitFor(() => expect(listing.findAllByType(StoreThemeListing)[0]?.props.facesState).toBe('ready'));
    expect(listing.findAllByType(StoreThemeListing)[0]?.props.faces).toHaveLength(1);
    expect(reads.sort(), 'opening the versioned listing through its Action reuses the card acquisition').toEqual(['icons', 'near-a', 'near-b']);
    await listing.unmount();
    expect(surfaces[2]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(0);
    expect(surfaces[2]!.screen.findAllByType(HappierBrandMark)).toHaveLength(1);
    console.info('STORE-PERF-1117 initial census', { cards: cards.length, previewCommits: commits, bodyParses, reads: reads.length });
    expect(bodyParses).toBe(3);
    commits = 0;
    for (let index = 0; index < 10; index++) await act(async () => { storage.setState({ endpointStatus: index % 2 ? 'online' : 'offline' }); });
    expect(commits, 'unrelated Store publications do not redraw card previews').toBe(0);
    const scroll = async (next: number) => act(async () => {
        offset = next;
        tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: next } } });
    });
    const failedShell = surfaces[3]!.screen.findAll(node => typeof node.type === 'string' && node.type === 'View')[0]!;
    await scroll(1400);
    await vi.waitFor(() => expect(reads.sort()).toEqual(['failed', 'far', 'icons', 'near-a', 'near-b']));
    await vi.waitFor(() => expect(surfaces[2]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    expect(surfaces[3]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(0);
    expect(surfaces[3]!.screen.findAllByType(HappierBrandMark)).toHaveLength(1);
    expect(surfaces[3]!.screen.findAll(node => typeof node.type === 'string' && node.type === 'View')[0]).toBe(failedShell);
    await scroll(0);
    const originalMiniature = surfaces[0]!.screen.findAllByType(ThemeMiniaturePreview)[0]!.props.miniature;
    await surfaces[0]!.screen.unmount();
    const derives = vi.spyOn(themeColors, 'deriveThemeColorsWithPaint');
    onTestFinished(() => { derives.mockRestore(); });
    surfaces[0]!.screen = await renderScreen(surfaces[0]!.tree(), { createNodeMock: () => surfaces[0]!.node });
    await vi.waitFor(() => expect(surfaces[0]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    expect(surfaces[0]!.screen.findAllByType(ThemeMiniaturePreview)[0]!.props.miniature).toBe(originalMiniature);
    expect(derives).not.toHaveBeenCalled();
    derives.mockRestore();
    expect(reads.sort(), 'scroll-back and a recycled card reuse the versioned package').toEqual(['failed', 'far', 'icons', 'near-a', 'near-b']);
    await scroll(1400);
    await flushHookEffects();
    expect(bodyParses, 'scroll-back does not decode the retained response again').toBe(4);
    console.info('STORE-PERF-1117 after scroll', { bodyParses, reads: reads.length });
    expect(reads.sort(), 'revisiting an unavailable package does not retry its failed gallery read').toEqual(['failed', 'far', 'icons', 'near-a', 'near-b']);
    const beforeMetadata = new Map(liveRows.current!.rows.map(row => [row.key, row]));
    rowCommits.clear();
    nearATitle = 'Renamed near-a';
    await act(async () => { await refresh.current!(); });
    const renamedKey = `theme|${sourceId}|near-a`;
    await vi.waitFor(() => expect(liveRows.current!.rows.find(row => row.key === renamedKey)?.title).toBe(nearATitle));
    const replaced = liveRows.current!.rows.filter(row => beforeMetadata.get(row.key) !== row).map(row => row.key);
    console.info('STORE-PERF-1117 metadata arrival census', { replacedRows: replaced.length,
        titleCommits: [...rowCommits.values()].reduce((sum, count) => sum + count, 0) });
    expect(replaced, 'one changed catalog title replaces only its row').toEqual([renamedKey]);
    expect([...rowCommits], 'one changed catalog title redraws only its Collection card title').toEqual([[renamedKey, 1]]);
    await gallery.unmount();
});

it('keeps three Store theme cards across the wide column and two beside the open listing (lab C1/C2)', async () => {
    const { STORE_THEME_CARD_MIN_WIDTH } = await import('./storeThemeCardAnatomy');
    const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
    // The Collection grid's column rule: as many minimum-width cards as fit its stage between the sheet gutters.
    const columns = (stage: number) => Math.max(1, Math.floor((stage - 2 * HAPPIER_PAGE_METRICS.sheetInsetPx + HAPPIER_PAGE_METRICS.cardGapPx)
        / (STORE_THEME_CARD_MIN_WIDTH + HAPPIER_PAGE_METRICS.cardGapPx)));
    expect(columns(HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide)).toBe(3);
    // Beside the open listing: 1440 with the default pane leaves 504, the owner's laptop split 544 (both observed
    // live, two 250 px cards), a 1512 laptop about 576.
    expect(columns(504)).toBe(2);
    expect(columns(544)).toBe(2);
    expect(columns(576)).toBe(2);
});

it('names a card without a trailing separator when its modes are not known until the card has looked', async () => {
    // Live 1440 (ACCEPT-THEMES-1118): an Open VSX card read "Ayu, teabyii · Open VSX, ".
    const anatomy = await renderHook(() => useStoreThemeCardAnatomy());
    const label = anatomy.getCurrent().accessibilityLabel!;
    expect(label({ key: 'ayu', name: 'Ayu', byline: 'teabyii · Open VSX', summary: '', faces: [] })).toBe('Ayu, teabyii · Open VSX');
    expect(label({ key: 'atlas', name: 'Atlas', byline: 'mira.sato · Happier catalog', summary: 'Light and dark', faces: [] }))
        .toBe('Atlas, mira.sato · Happier catalog, Light and dark');
    await anatomy.unmount();
});
