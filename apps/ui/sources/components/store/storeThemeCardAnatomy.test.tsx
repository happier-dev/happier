import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { PluginUiScrollActivityProvider } from '@happier-dev/plugin-ui/advanced';
import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';
import type { StoreThemeCardView } from './storeThemeViewTypes';

installPromptRegistriesCommonModuleMocks({ storage: original => original(), text: () => vi.importActual('@/text') });
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { useStoreThemeCardAnatomy } = await import('./storeThemeCardAnatomy');
const { StoreThemeListingController } = await import('./StoreThemeListingController');
const { StoreThemeListing } = await import('./StoreThemeListing');
const { ThemeMiniaturePreview } = await import('@/components/settings/appearance/ThemeModePreview');
const { HappierBrandMark } = await import('@/components/ui/media/HappierBrandMark');
const { storage } = await import('@/sync/domains/state/storage');
await initializeArtifactInventoryDemandHarness();

it('acquires only measured near-viewport packages and reuses them across scroll-back and remount', async () => {
    const indexUrl = 'https://theme-card-counts.example.test/index.json';
    const sourceId = deriveMarketplaceSourceId(indexUrl);
    const reads: string[] = [];
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
        disabledSourceIds: [], sources: [{ id: sourceId, title: 'Themes', url: indexUrl,
            format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 1 }] } }] });
    const ids = ['near-a', 'near-b', 'far', 'failed'];
    let releaseNearB: () => void = () => {};
    const nearBPending = new Promise<void>(resolve => { releaseNearB = resolve; });
    const fixture = await createArtifactInventoryDemandHarness({ handleRequest: async (url, init) => {
        const config = await catalog.handle(`${url.pathname}${url.search}`, init);
        if (config) return config;
        if (url.href === indexUrl) return Response.json({ source: { id: sourceId, title: 'Themes', sourceUrl: indexUrl, kind: 'user' },
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], picks: [], diagnostics: [], themes: ids.map(itemId => ({
                itemId, title: itemId, version: '1.0.0', listing: { includes: [{ key: 'dark', label: 'Dark', mode: 'dark' }] },
                contentUrl: `https://theme-card-counts.example.test/${itemId}.json`,
            })) });
        const id = ids.find(itemId => url.href === `https://theme-card-counts.example.test/${itemId}.json`);
        if (id) {
            reads.push(id);
            if (id === 'near-b') await nearBPending;
            if (id === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
            return Response.json({ themes: [{ key: 'dark', label: 'Dark', mode: 'dark', document: { schemaVersion: 1,
                id, name: id, createdAt: '2026-11-17', updatedAt: '2026-11-17', base: { light: 'light', dark: 'dark' },
                overrides: { light: {}, dark: {} }, assetAppearance: 'dark' } }] });
        }
        return null;
    } });
    fixture.inventory = [];
    onTestFinished(async () => { releaseNearB(); await standardCleanup(); await fixture.dispose(); });
    const anatomy = await renderHook(() => useStoreThemeCardAnatomy());
    let offset = 0;
    const content = { getBoundingClientRect: () => ({ left: 0, top: -offset, width: 300, height: 2000 }) };
    const tracker = createScrollViewNearViewportTracker({ current: { getInnerViewRef: () => content } }, false, { initialViewportHeight: 200 });
    await act(async () => { tracker.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 200 } } }); });
    const cards = ids.map((id): StoreThemeCardView & { listing: { sourceId: string; itemId: string; version: string } } => ({
        key: id, name: id, byline: 'Themes', summary: '', faces: [], mark: { displayName: 'Themes' }, listing: { sourceId, itemId: id, version: '1.0.0' },
    }));
    let commits = 0;
    const surfaces = [];
    for (const [index, card] of cards.entries()) {
        const top = [0, 240, 1200, 1600][index]!;
        const node = { getBoundingClientRect: () => ({ left: 0, top: top - offset, width: 300, height: 120 }) };
        const tree = () => <PluginUiScrollActivityProvider tracker={tracker}>
            <React.Profiler id={card.key} onRender={() => { commits++; }}>{anatomy.getCurrent().preview?.(card)}</React.Profiler>
        </PluginUiScrollActivityProvider>;
        const screen = await renderScreen(tree(), { createNodeMock: () => node });
        surfaces.push({ screen, tree, node });
    }
    await vi.waitFor(() => expect(reads.sort()).toEqual(['near-a', 'near-b']));
    await vi.waitFor(() => expect(surfaces[0]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    const pendingShell = surfaces[1]!.screen.findAll(node => node.type === 'View')[0]!;
    expect(surfaces[1]!.screen.findAllByType(HappierBrandMark)).toHaveLength(1);
    await act(async () => { releaseNearB(); });
    await vi.waitFor(() => expect(surfaces[1]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    expect(surfaces[1]!.screen.findAll(node => node.type === 'View')[0]).toBe(pendingShell);
    const listing = await renderScreen(<StoreThemeListingController listing={cards[0]!.listing}>
        {view => <StoreThemeListing {...view} />}
    </StoreThemeListingController>);
    await vi.waitFor(() => expect(listing.findAllByType(StoreThemeListing)[0]?.props.facesState).toBe('ready'));
    expect(listing.findAllByType(StoreThemeListing)[0]?.props.faces).toHaveLength(1);
    expect(reads.sort(), 'opening the versioned listing through its Action reuses the card acquisition').toEqual(['near-a', 'near-b']);
    await listing.unmount();
    expect(surfaces[2]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(0);
    expect(surfaces[2]!.screen.findAllByType(HappierBrandMark)).toHaveLength(1);
    commits = 0;
    for (let index = 0; index < 10; index++) await act(async () => { storage.setState({ endpointStatus: index % 2 ? 'online' : 'offline' }); });
    expect(commits, 'unrelated Store publications do not redraw card previews').toBe(0);
    const scroll = async (next: number) => act(async () => {
        offset = next;
        tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: next } } });
    });
    const failedShell = surfaces[3]!.screen.findAll(node => node.type === 'View')[0]!;
    await scroll(1400);
    await vi.waitFor(() => expect(reads.sort()).toEqual(['failed', 'far', 'near-a', 'near-b']));
    await vi.waitFor(() => expect(surfaces[2]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    expect(surfaces[3]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(0);
    expect(surfaces[3]!.screen.findAllByType(HappierBrandMark)).toHaveLength(1);
    expect(surfaces[3]!.screen.findAll(node => node.type === 'View')[0]).toBe(failedShell);
    await scroll(0);
    await surfaces[0]!.screen.unmount();
    surfaces[0]!.screen = await renderScreen(surfaces[0]!.tree(), { createNodeMock: () => surfaces[0]!.node });
    await vi.waitFor(() => expect(surfaces[0]!.screen.findAllByType(ThemeMiniaturePreview)).toHaveLength(1));
    expect(reads.sort(), 'scroll-back and a recycled card reuse the versioned package').toEqual(['failed', 'far', 'near-a', 'near-b']);
    await scroll(1400);
    await flushHookEffects();
    expect(reads.sort(), 'revisiting an unavailable package does not retry its failed gallery read').toEqual(['failed', 'far', 'near-a', 'near-b']);
});

it('keeps three Store theme cards across the wide column and two beside the open listing (lab C1/C2)', async () => {
    const { STORE_THEME_CARD_MIN_WIDTH } = await import('./storeThemeCardAnatomy');
    const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
    // The Collection grid's column rule: as many minimum-width cards as fit its stage between the sheet gutters.
    const columns = (stage: number) => Math.max(1, Math.floor((stage - 2 * HAPPIER_PAGE_METRICS.sheetInsetPx + HAPPIER_PAGE_METRICS.cardGapPx)
        / (STORE_THEME_CARD_MIN_WIDTH + HAPPIER_PAGE_METRICS.cardGapPx)));
    expect(columns(HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide)).toBe(3);
    // Beside the open listing: 1440 with the default pane leaves 504 (observed live), a 1512 laptop about 576.
    expect(columns(504)).toBe(2);
    expect(columns(576)).toBe(2);
});
