import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

let routeParams: Record<string, string | undefined> = {};
installPromptRegistriesCommonModuleMocks({ storage: original => original(), text: () => vi.importActual('@/text'),
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => routeParams }).module });
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { StoreListingBody } = await import('./StoreListing');
const { StoreThemeListing } = await import('./StoreThemeListing');
const { ThemeTryBarHost } = await import('@/theme/ThemeTryBarHost');
const { ThemeTryBar } = await import('@/components/settings/appearance/themeProfiles/ThemeTryBar');
const { getThemeTryOnOwner, getThemeRegistryLifecycle } = await import('@/theme/profiles/themeTryOnRuntime');
const { storage } = await import('@/sync/domains/state/storage');
const { useRegistryItems } = await import('@/registries/useRegistryItems');
const { storeKinds } = await import('./catalog/storeKinds');
const { readThemeLibrarySnapshot, readSelectedThemeProfiles } = await import('@/sync/store/useThemeProfiles');
const { projectInstalledStoreThemeRows } = await import('./catalog/storeThemes');
const { presentInventoryRow } = await import('./inventory/inventoryRows');
const { readStoreListingRoute } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { useStoreThemeCardAnatomy } = await import('./storeThemeCardAnatomy');
const { projectStoreThemeCard } = await import('./catalog/storeThemes');
const { ThemeMiniaturePreview } = await import('@/components/settings/appearance/ThemeModePreview');
await initializeArtifactInventoryDemandHarness();

it('opens one theme acquisition through the shared listing body and retries Keep without losing the tried face', async () => {
    const indexUrl = 'https://theme-listing.example.test/index.json';
    const contentUrl = 'https://theme-listing.example.test/palette.json';
    const sourceId = deriveMarketplaceSourceId(indexUrl);
    const includes = (['dark', 'light'] as const).map(mode => ({ key: mode, label: mode, mode }));
    const preview = includes.map(({ mode }) => ({ mode, canvas: mode === 'dark' ? '#112233' : '#eefaff',
        raised: '#334455', text: '#ffffff', mutedText: '#aabbcc', accent: '#9988ff', border: '#556677', radius: 'soft' as const }));
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
        disabledSourceIds: [], sources: [{ id: sourceId, title: 'Themes catalog', url: indexUrl,
            format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 1 }] } }] });
    let acquisitions = 0;
    let catalogReads = 0;
    let failLight = true;
    const fixture = await createArtifactInventoryDemandHarness({ handleRequest: async (url, init) => {
        const config = await catalog.handle(`${url.pathname}${url.search}`, init);
        if (config) return config;
        if (url.href === indexUrl) { catalogReads++;
            return Response.json({ source: { id: sourceId, title: 'Themes catalog', sourceUrl: indexUrl, kind: 'user' },
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], picks: [], diagnostics: [], themes: [{ itemId: 'palette',
                title: 'Palette', version: '1.0.0', listing: { includes, preview, license: 'Custom' }, contentUrl }] }); }
        if (url.href === contentUrl) {
            acquisitions += 1;
            return Response.json({ themes: includes.map(face => ({ ...face, document: { schemaVersion: 1,
                id: `palette-${face.key}`, name: face.label, createdAt: '2026-11-16', updatedAt: '2026-11-16',
                base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, assetAppearance: face.mode,
                css: '[data-surface="sidebar"] { padding: 12px; }' } })) });
        }
        if (url.pathname === '/v1/artifacts' && init?.method === 'POST') {
            const input: unknown = JSON.parse(String(init.body));
            const encoded = input && typeof input === 'object' ? Reflect.get(input, 'header') : undefined;
            if (typeof encoded === 'string') {
                const header = ThemeProfileArtifactHeaderSchema.parse(decodePlainArtifactStoredContent(encoded));
                if (header.themeSource.kind === 'store' && header.themeSource.contributionId === 'light' && failLight) {
                    return Response.json({ error: 'artifact_access_forbidden' }, { status: 403 });
                }
            }
        }
        return null;
    } });
    fixture.inventory = [];
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => fixture.accountId, encryptionMode: 'plain' });
    fixture.artifactStore = artifacts;
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const browse = await renderHook(() => useRegistryItems({ kind: 'theme', sourceIds: [sourceId] }));
    await vi.waitFor(() => expect(browse.getCurrent().items).toHaveLength(1));
    expect(acquisitions).toBe(0);
    const anatomy = await renderHook(() => useStoreThemeCardAnatomy());
    const card = projectStoreThemeCard(browse.getCurrent().items[0]!, 'Themes catalog');
    const gallery = await renderScreen(<>{anatomy.getCurrent().preview?.(card)}</>);
    expect(gallery.findAllByType(ThemeMiniaturePreview).map(node => node.props.miniature)).toEqual(preview);
    await gallery.update(<>{anatomy.getCurrent().preview?.(card)}</>);
    expect(acquisitions, 'drawing and redrawing summary miniatures never acquires content').toBe(0);
    expect(catalogReads, 'drawing summary miniatures reuses the one browse response').toBe(1);
    const summary = storeKinds.theme.summary(browse.getCurrent().items[0]!);
    const picked = summary.ref;
    if (picked.kind !== 'theme') throw new Error('Expected the theme browse reference');
    const reference = { type: 'registryItem' as const, kind: picked.kind, sourceId: picked.sourceId, itemId: picked.itemId };
    routeParams = { selection: JSON.stringify(reference) };
    let listingCommits = 0;
    const countListing = () => { listingCommits++; };
    let barCommits = 0;
    const countBar = () => { barCommits++; };
    const closeListing = () => {};
    const listingSurface = (presented: boolean, presentation: 'pane' | 'page' = 'pane', currentReference = reference) => <>
        <PluginSurfaceFocusEligibilityProvider active={presented}>
            <React.Profiler id="theme-listing" onRender={countListing}>
                <StoreListingBody reference={currentReference} presentation={presentation} onClose={closeListing} />
            </React.Profiler>
        </PluginSurfaceFocusEligibilityProvider>
        <React.Profiler id="theme-try-bar" onRender={countBar}><ThemeTryBarHost /></React.Profiler>
    </>;
    const screen = await renderScreen(listingSurface(true));
    const view = () => screen.findAllByType(StoreThemeListing)[0]?.props;
    await vi.waitFor(() => expect(view()?.facesState, view()?.facesError ?? undefined).toBe('ready'));
    expect(acquisitions).toBe(1);
    expect(view()?.facts.map(fact => fact.key)).toEqual(['includes', 'changes', 'worksOn', 'licence']);
    const faces = (await getThemeRegistryLifecycle().prepareStorePreview({ sourceId, itemId: 'palette' },
        { expectedScope: storage.getState().settingsScope })).item.payload.themes;
    await act(async () => { getThemeTryOnOwner().begin({ document: faces[0]!.document, mode: faces[0]!.mode,
        origin: { kind: 'store', listing: { sourceId, itemId: 'palette' } } }); });
    barCommits = 0;
    for (let index = 1; index <= 10; index++) {
        const face = faces[index % faces.length]!;
        await act(async () => { getThemeTryOnOwner().begin({ document: face.document, mode: face.mode,
            origin: { kind: 'store', listing: { sourceId, itemId: 'palette' } } }); });
    }
    expect(barCommits, 'the hidden shell bar ignores the focused listing preview').toBe(0);
    routeParams = {};
    await screen.update(listingSurface(true));
    expect(screen.findAllByType(ThemeTryBar)[0]?.props).toMatchObject({ visible: true, faceName: faces[10 % faces.length]!.document.profile.name });
    routeParams = { selection: JSON.stringify(reference) };
    await screen.update(listingSurface(true));
    expect(screen.findAllByType(ThemeTryBar)[0]?.props.visible).toBe(false);
    await act(async () => { getThemeTryOnOwner().begin({ document: faces[0]!.document, mode: faces[0]!.mode,
        origin: { kind: 'store', listing: { sourceId, itemId: 'another-listing' } } }); });
    listingCommits = 0;
    for (let index = 1; index <= 10; index++) {
        const face = faces[index % faces.length]!;
        await act(async () => { getThemeTryOnOwner().begin({ document: face.document, mode: face.mode,
            origin: { kind: 'store', listing: { sourceId, itemId: 'another-listing' } } }); });
    }
    expect(listingCommits, 'the open listing ignores another listing preview').toBe(0);
    await screen.update(listingSurface(false));
    listingCommits = 0;
    for (let index = 1; index <= 10; index++) {
        const face = faces[index % faces.length]!;
        await act(async () => { getThemeTryOnOwner().begin({ document: face.document, mode: face.mode,
            origin: { kind: 'store', listing: { sourceId, itemId: 'palette' } } }); });
    }
    expect(listingCommits).toBe(0);
    await screen.update(listingSurface(true));
    expect(view()?.tryingFaceId).toBe(faces[10 % faces.length]!.key);
    expect(acquisitions).toBe(1);
    await act(async () => { await view()!.onRevert(); });
    await act(async () => { await view()!.onTryFace('dark'); });
    await vi.waitFor(() => expect(view()?.tryingFaceId).toBe('dark'));
    await act(async () => { await view()!.onRevert(); });
    await vi.waitFor(() => expect(view()?.tryingFaceId).toBeNull());
    await act(async () => { await view()!.onTryFace('light'); });
    await vi.waitFor(() => expect(view()?.tryingFaceId).toBe('light'));
    expect(screen.findAllByType(ThemeTryBar)[0]?.props.visible).toBe(false);
    await act(async () => { await view()!.onInstall(); });
    await vi.waitFor(() => expect(view()?.installFailures).toHaveLength(1));
    expect(view()?.tryingFaceId).toBe('light');
    failLight = false;
    await act(async () => { await view()!.onRetryFaces(); });
    await vi.waitFor(() => expect(view()?.installed).toBe(true));
    expect(view()?.tryingFaceId).toBeNull();
    expect(acquisitions).toBe(1);
    const installed = artifacts.list();
    expect(installed).toHaveLength(2);
    expect(installed.map(row => row.headerVersion)).toEqual([1, 1]);
    const installedHeader = Object.values(storage.getState().artifacts).find(artifact =>
        ThemeProfileArtifactHeaderSchema.safeParse(artifact.rawHeader).success);
    if (!installedHeader) throw new Error('Expected an admitted installed theme header');
    listingCommits = 0;
    for (let index = 1; index <= 10; index++) {
        await act(async () => { storage.getState().applyArtifacts([{ ...installedHeader, id: `unrelated-theme-${index}`,
            title: `Unrelated ${index}`, rawHeader: { ...ThemeProfileArtifactHeaderSchema.parse(installedHeader.rawHeader),
                title: `Unrelated ${index}`, themeSource: { kind: 'yours' } } }]); });
    }
    expect(listingCommits, 'the listing ignores unrelated theme library headers').toBe(0);
    expect(view()?.installed).toBe(true);
    const selected = storage.getState().localSettings.themeProfileSelection.light;
    expect(selected?.kind).toBe('artifact');
    const selectedRow = selected?.kind === 'artifact' ? artifacts.read(selected.id) : null;
    expect(ThemeProfileArtifactHeaderSchema.parse(decodePlainArtifactStoredContent(selectedRow!.header)).themeSource)
        .toMatchObject({ kind: 'store', contributionId: 'light' });
    const scope = storage.getState().settingsScope!;
    const row = projectInstalledStoreThemeRows(readThemeLibrarySnapshot(scope)!.entries, scope)[0]!;
    const destination = presentInventoryRow(row, { scope, machine: null, projectKey: null }).home.href;
    if (typeof destination === 'string' || !destination) throw new Error('Expected the Installed listing destination');
    const selectedListing = readStoreListingRoute(destination.params);
    if (selectedListing?.kind !== 'store') throw new Error('Expected the same Store listing route');
    expect(selectedListing.reference).toEqual(reference);
    await screen.update(listingSurface(true, 'page', selectedListing.reference));
    await vi.waitFor(() => expect(view()?.installed).toBe(true));
    expect(view()?.name).toBe('Palette');
    expect(acquisitions).toBe(1);
    expect(typeof view()?.onUninstall).toBe('function');
    expect(screen.findAllByType(RoundButton).some(button => button.props.onPress === view()?.onUninstall)).toBe(true);
    await act(async () => { view()!.onTryFace('dark'); });
    await vi.waitFor(() => expect(view()?.tryingFaceId).toBe('dark'));
    routeParams = {};
    await screen.update(<ThemeTryBarHost />);
    const bar = () => screen.findAllByType(ThemeTryBar)[0]!.props;
    expect(bar().visible).toBe(true);
    expect(bar().origin).toBe('store');
    const tried = getThemeTryOnOwner().read()!;
    expect(tried.document?.profile.name).toBe('dark');
    await act(async () => { await bar().onRevert(); });
    expect(getThemeTryOnOwner().read()).toBeNull();
    routeParams = { selection: JSON.stringify(reference) };
    await screen.update(listingSurface(true));
    await vi.waitFor(() => expect(view()?.facesState).toBe('ready'));
    let otherPreview: ReturnType<ReturnType<typeof getThemeTryOnOwner>['begin']>;
    await act(async () => { otherPreview = getThemeTryOnOwner().begin({ document: tried.document!, mode: tried.mode, origin: { kind: 'agent' } }); });
    routeParams = {};
    await screen.update(<ThemeTryBarHost />);
    expect(getThemeTryOnOwner().read()?.previewRef).toBe(otherPreview!.previewRef);
    expect(bar().origin).toBe('agent');
    await act(async () => { await bar().onRevert(); });
    routeParams = { selection: JSON.stringify(reference) };
    await screen.update(<StoreListingBody reference={reference} presentation="pane" onClose={() => {}} />);
    await vi.waitFor(() => expect(view()?.installed).toBe(true));
    await act(async () => { await view()!.onUninstall!(); });
    await vi.waitFor(() => expect(artifacts.list()).toHaveLength(0));
    expect(view()?.onUninstall).toBeUndefined();
    // The library retains the preference; a missing selected Artifact renders the mode's base.
    expect(storage.getState().localSettings.themeProfileSelection.light).toEqual(selected);
    expect(readSelectedThemeProfiles(scope).activeProfileIds.light).toBeNull();
});
