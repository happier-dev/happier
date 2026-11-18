import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { ThemeReferenceSchema } from '@happier-dev/protocol/account/settings/themeProfiles';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { RegistryThemeListingV1 } from '@happier-dev/protocol/registries/registryThemeV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { StoreThemeListingViewProps } from './storeThemeViewTypes';

const externalUrlBoundary = vi.hoisted(() => vi.fn(async (_url: string) => true));
// The platform URL effect is external; keep link admission and listing logic real.
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: externalUrlBoundary }));

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
const { applyPromptLibraryCatalogAcknowledgedRecord, getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useStoreThemeCardAnatomy } = await import('./storeThemeCardAnatomy');
const { projectStoreThemeCard } = await import('./catalog/storeThemes');
const { ThemeMiniaturePreview } = await import('@/components/settings/appearance/ThemeModePreview');
const { Item } = await import('@/components/ui/lists/Item');
const { preloadTranslations, setPreferredLanguageFromSettings, t } = await import('@/text/i18n');
await initializeArtifactInventoryDemandHarness();

async function createRegistryThemeListingFixture(options: Readonly<{ failAcquisition?: boolean;
    licence?: Pick<RegistryThemeListingV1, 'license' | 'licenseKind' | 'licenseUrl'> }> = {}) {
    const indexUrl = 'https://theme-listing.example.test/index.json';
    const contentUrl = 'https://theme-listing.example.test/palette.json';
    const sourceId = deriveMarketplaceSourceId(indexUrl);
    const includes = (['dark', 'light'] as const).map(mode => ({ key: mode, label: mode, mode }));
    const preview = includes.map(({ mode }) => ({ mode, canvas: mode === 'dark' ? '#112233' : '#eefaff',
        raised: '#334455', text: '#ffffff', mutedText: '#aabbcc', accent: '#9988ff', border: '#556677', radius: 'soft' as const }));
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
        disabledSourceIds: [], sources: [{ id: sourceId, title: 'Themes catalog', url: indexUrl,
            format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 1 }] } }] });
    const state = { acquisitions: 0, sourceReads: 0, catalogReads: 0, failLight: true,
        failAcquisition: options.failAcquisition ?? false, catalogVersion: '1.0.0' };
    const fixture = await createArtifactInventoryDemandHarness({ handleRequest: async (url, init) => {
        if (url.pathname.startsWith('/v1/account/entity-rows/prompt-library') && (init?.method ?? 'GET') === 'GET') state.sourceReads++;
        const config = await catalog.handle(`${url.pathname}${url.search}`, init);
        if (config) return config;
        if (url.href === indexUrl) { state.catalogReads++;
            return Response.json({ source: { id: sourceId, title: 'Themes catalog', sourceUrl: indexUrl, kind: 'user' },
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], picks: [], diagnostics: [], themes: [{ itemId: 'palette',
                title: 'Palette', version: state.catalogVersion, listing: { includes, preview, license: 'Custom', ...options.licence }, contentUrl }] }); }
        if (url.href === contentUrl) {
            state.acquisitions += 1;
            if (state.failAcquisition) return Response.json({ error: 'unavailable' }, { status: 503 });
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
                if (header.themeSource.kind === 'store' && header.themeSource.contributionId === 'light' && state.failLight) {
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
    return { sourceId, preview, artifacts, state };
}

it('browses an admitted plugin theme and keeps its reference from the shared Store listing', async () => {
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { createThemeProfileDraft } = await import('@/theme/profiles/createThemeProfileDraft');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const externalReads: string[] = [];
    const catalog = createPromptLibraryCatalogBoundary();
    const fixture = await createArtifactInventoryDemandHarness({ handleRequest: async (url, init) => {
        if (url.hostname !== 'artifact-demand.example.test') externalReads.push(url.href);
        return catalog.handle(`${url.pathname}${url.search}`, init);
    } });
    fixture.inventory = [];
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => fixture.accountId, encryptionMode: 'plain' });
    fixture.artifactStore = artifacts;
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const reference = { kind: 'plugin', pluginId: 'sample.palette', contributionId: 'night' } as const;
    const selection = { type: 'pluginTheme', reference } as const;
    routeParams = { selection: JSON.stringify(selection) };
    const route = readStoreListingRoute(routeParams);
    expect(route).toEqual({ kind: 'store', reference: selection });
    if (route?.kind !== 'store') throw new Error('Expected admitted Store theme route');
    const projected = { ...EMPTY_PLUGIN_UI_PROJECTION, themesById: { 'sample.palette/night': {
        id: 'sample.palette/night', pluginId: reference.pluginId, pluginVersion: '1.2.3', pluginName: 'Palette studio',
        definition: { id: reference.contributionId, theme: { ...createThemeProfileDraft({ id: 'night', name: 'Night sky', now: '2026-11-16' }), assetAppearance: 'dark' as const } },
    } } };
    const value = { pluginUiProjection: projected, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
        connectedAccountProjectionRevision: 0, reloadConnectedAccountProjection: () => {},
        clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {} };
    let admitted: typeof EMPTY_PLUGIN_UI_PROJECTION = projected;
    const wrap = (body: React.ReactNode) => <AppShellPluginUiProjectionValueProvider value={{ ...value, pluginUiProjection: admitted }}>
        <PluginSurfaceFocusEligibilityProvider active>{body}</PluginSurfaceFocusEligibilityProvider>
    </AppShellPluginUiProjectionValueProvider>;
    const browseInput: { query: string; sourceIds?: readonly string[] } = { query: '', sourceIds: [reference.pluginId] };
    const browse = await renderHook((input: typeof browseInput) => storeKinds.theme.useList(input, { presented: true }),
        { initialProps: browseInput, wrapper: ({ children }) => wrap(children) });
    await vi.waitFor(() => expect(browse.getCurrent().items).toHaveLength(1));
    expect(storeKinds.theme.summary(browse.getCurrent().items[0]!).title).toBe('Night sky');
    await fixture.settleInventory();
    expect(fixture.pages).toEqual([]);
    const item = browse.getCurrent().items[0]!;
    const { themeSummaryMatchesMode } = await import('./catalog/storeThemes');
    const { storeRowFacts } = await import('./catalog/storeColumnAdapter');
    expect(themeSummaryMatchesMode(item, 'dark')).toBe(true);
    expect(themeSummaryMatchesMode(item, 'light')).toBe(false);
    expect(storeRowFacts([{ key: 'night', kind: 'theme', summary: storeKinds.theme.summary(item) }], [], true)[0]?.fields.source).toEqual([reference.pluginId]);
    const { StoreSearch, useStoreDirectorySources } = await import('./StoreSearch');
    const { useStoreFilterFields } = await import('./catalog/useStoreFilterFields');
    const filters = { source: { include: [reference.pluginId], exclude: [] } };
    const curation = [] as const;
    const catalogs = await renderHook(() => ({
        ids: useStoreDirectorySources(filters, true).sourceIds,
        fields: useStoreFilterFields(curation, true),
    }), { wrapper: ({ children }) => wrap(children) });
    await vi.waitFor(() => expect(catalogs.getCurrent().ids).toEqual([reference.pluginId]));
    expect(catalogs.getCurrent().fields.source.valueLabel(reference.pluginId)).toBe('Palette studio');
    const originalCatalogs = catalogs.getCurrent();
    const contribution = projected.themesById['sample.palette/night'];
    admitted = { ...projected, themesById: { [contribution.id]: { ...contribution,
        definition: { ...contribution.definition, theme: { ...contribution.definition.theme, name: 'Night lights' } },
    } } };
    await catalogs.rerender();
    expect(catalogs.getCurrent().ids).toBe(originalCatalogs.ids);
    expect(catalogs.getCurrent().fields.source).toBe(originalCatalogs.fields.source);
    admitted = projected;
    await catalogs.rerender();

    let searchRows: readonly unknown[] = [];
    function SearchHarness() {
        const fields = useStoreFilterFields([], true);
        return <StoreSearch kind="theme" demand={{ presented: true }} fields={fields}
            initialFilters={{ source: { include: [reference.pluginId], exclude: [] } }}>
            {state => { searchRows = state.rows; return null; }}
        </StoreSearch>;
    }
    const search = await renderScreen(wrap(<SearchHarness />));
    await vi.waitFor(() => expect(searchRows).toHaveLength(1));
    await browse.rerender({ ...browseInput, query: 'missing' });
    expect(browse.getCurrent().items).toHaveLength(0);
    await browse.rerender({ ...browseInput, query: 'palette' });
    expect(browse.getCurrent().items).toHaveLength(1);
    await browse.rerender({ ...browseInput, sourceIds: ['another.plugin'] });
    expect(browse.getCurrent().items).toHaveLength(0);
    await browse.rerender(browseInput);
    expect(fixture.bodyReads).toEqual([]);
    const screen = await renderScreen(wrap(<><StoreListingBody reference={route.reference} presentation="page" onClose={() => {}} /><ThemeTryBarHost /></>));
    await vi.waitFor(() => expect(screen.findAllByType(StoreThemeListing)[0]?.props.facesState).toBe('ready'));
    const view = () => screen.findAllByType<typeof StoreThemeListing>(StoreThemeListing)[0]!.props;
    expect(view().meta).toContain('Palette studio');
    expect(view().meta).toContain('1.2.3');
    expect(view().faces?.map((face: NonNullable<StoreThemeListingViewProps['faces']>[number]) => face.name)).toEqual(['Night sky']);
    await act(async () => { await view().onTryFace('night'); });
    await vi.waitFor(() => expect(getThemeTryOnOwner().read()?.selection).toEqual(reference));
    expect(getThemeTryOnOwner().read()?.origin).toEqual({ kind: 'store', reference });
    expect(storage.getState().localSettings.themeProfileSelection).not.toMatchObject({ dark: reference });
    await screen.update(wrap(<ThemeTryBarHost />));
    const bar = screen.findAllByType(ThemeTryBar)[0]!;
    expect(bar.props.visible).toBe(true);
    expect(bar.props.installLabel).toBe(t('common.apply'));
    await act(async () => { await bar.props.onInstall(); });
    await vi.waitFor(() => expect(storage.getState().localSettings.themeProfileSelection).toMatchObject({ dark: reference }));
    expect(fixture.bodyReads).toEqual([]);
    expect(fixture.artifactWrites).toEqual([]);
    expect(artifacts.list()).toEqual([]);
    expect(getThemeTryOnOwner().read()).toBeNull();
    admitted = { ...projected, themesById: {} };
    await browse.rerender(browseInput);
    await vi.waitFor(() => expect(browse.getCurrent().items).toHaveLength(0));
    await screen.update(wrap(<StoreListingBody reference={selection} presentation="page" onClose={() => {}} />));
    await vi.waitFor(() => expect(view().facesState).toBe('error'));
    await search.update(wrap(<SearchHarness />));
    await vi.waitFor(() => expect(searchRows).toHaveLength(0));
    expect(externalReads).toEqual([]);
});

it('keeps Installed themes stable across plugin theme arrivals', async () => {
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { createThemeProfileDraft } = await import('@/theme/profiles/createThemeProfileDraft');
    const fixture = await createArtifactInventoryDemandHarness();
    fixture.inventory = [];
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });

    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected an active Account');
    const input = { scope, machine: null, projectKey: null };
    const admission = { scope, failure: null, coverage: 'available', binding: null } as const;
    let projection = EMPTY_PLUGIN_UI_PROJECTION;
    const installed = await renderHook(() => storeKinds.theme.useInstalled(input, { presented: true }, admission), {
        wrapper: ({ children }) => <AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
            interactionEnabled: true, machineId: null, serverId: null, platform: 'web', accountLifetime: null,
            connectedAccountProjectionRevision: 0, reloadConnectedAccountProjection() {},
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {},
        }}>{children}</AppShellPluginUiProjectionValueProvider>,
    });
    await vi.waitFor(() => expect(installed.getCurrent().coverage).toBe('available'));
    const originalRows = installed.getCurrent().rows;
    projection = { ...EMPTY_PLUGIN_UI_PROJECTION, themesById: { 'sample.palette/paper': {
        id: 'sample.palette/paper', pluginId: 'sample.palette', pluginVersion: '1.0.0',
        definition: { id: 'paper', theme: createThemeProfileDraft({ id: 'paper', name: 'Paper', now: '2026-11-16' }) },
    } } };
    await installed.rerender();
    expect(installed.getCurrent().rows).toBe(originalRows);
});

it.each([
    { name: 'custom licence with its advertised link', licence: { license: 'Custom licence', licenseKind: 'custom' as const,
        licenseUrl: 'https://open-vsx.org/api/monokai/theme-monokai-pro-vscode/2.0.17/file/LICENSE.txt' }, expected: 'Licence personnalisée' },
    { name: 'custom licence without a link', licence: { license: 'Custom licence', licenseKind: 'custom' as const }, expected: 'Licence personnalisée' },
    { name: 'ordinary SPDX licence', licence: { license: 'MIT' }, expected: 'MIT' },
])('presents the $name through the shared listing', async ({ licence, expected }) => {
    externalUrlBoundary.mockClear();
    const { sourceId, state } = await createRegistryThemeListingFixture({ licence });
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    onTestFinished(() => setPreferredLanguageFromSettings(null));
    const screen = await renderScreen(<StoreListingBody reference={{ type: 'registryItem', kind: 'theme', sourceId, itemId: 'palette' }}
        presentation="page" onClose={() => {}} />);
    const row = () => screen.findAllByType<typeof Item>(Item).find(item => item.props.title === t('themeStore.factLicence'));
    await vi.waitFor(() => expect(row()?.props.detail).toBe(expected));
    if ('licenseUrl' in licence) {
        expect(row()?.props.accessibilityRole).toBe('link');
        await act(async () => { await row()!.props.onPress!(); });
        await vi.waitFor(() => expect(externalUrlBoundary).toHaveBeenCalledWith(licence.licenseUrl));
    } else {
        expect(row()?.props.onPress).toBeUndefined();
        expect(row()?.props.accessibilityRole).not.toBe('link');
        expect(externalUrlBoundary).not.toHaveBeenCalled();
    }
    expect(state.acquisitions).toBe(1);
});

it('opens one theme acquisition through the shared listing body and retries Keep without losing the tried face', async () => {
    const { sourceId, preview, artifacts, state } = await createRegistryThemeListingFixture();
    const browse = await renderHook(() => useRegistryItems({ kind: 'theme', sourceIds: [sourceId] }));
    await vi.waitFor(() => expect(browse.getCurrent().items).toHaveLength(1));
    expect(state.acquisitions).toBe(0);
    const anatomy = await renderHook(() => useStoreThemeCardAnatomy());
    const card = projectStoreThemeCard(browse.getCurrent().items[0]!, 'Themes catalog');
    const gallery = await renderScreen(<>{anatomy.getCurrent().preview?.(card)}</>);
    expect(gallery.findAllByType(ThemeMiniaturePreview).map(node => node.props.miniature)).toEqual(preview);
    await gallery.update(<>{anatomy.getCurrent().preview?.(card)}</>);
    expect(state.acquisitions, 'drawing and redrawing summary miniatures never acquires content').toBe(0);
    expect(state.catalogReads, 'drawing summary miniatures reuses the one browse response').toBe(1);
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
    type ThemeListingReference = Extract<React.ComponentProps<typeof StoreListingBody>['reference'], { type: 'registryItem'; kind: 'theme' }>;
    const listingSurface = (presented: boolean, presentation: 'pane' | 'page' = 'pane', currentReference: ThemeListingReference = reference) => <>
        <PluginSurfaceFocusEligibilityProvider active={presented}>
            <React.Profiler id="theme-listing" onRender={countListing}>
                <StoreListingBody reference={currentReference} presentation={presentation} onClose={closeListing} />
            </React.Profiler>
        </PluginSurfaceFocusEligibilityProvider>
        <React.Profiler id="theme-try-bar" onRender={countBar}><ThemeTryBarHost /></React.Profiler>
    </>;
    const screen = await renderScreen(listingSurface(true));
    const view = () => screen.findAllByType<typeof StoreThemeListing>(StoreThemeListing)[0]?.props;
    await vi.waitFor(() => expect(view()?.facesState, view()?.facesError ?? undefined).toBe('ready'));
    expect(state.acquisitions).toBe(1);
    await vi.waitFor(() => expect(view()?.meta).toContain('Themes catalog'));
    const sourceScope = storage.getState().settingsScope!;
    const sourceSnapshot = getPromptLibraryCatalogValue(sourceScope, 'registry-sources');
    if (!sourceSnapshot.value || typeof sourceSnapshot.revision !== 'number') throw new Error('Expected admitted registry source configuration');
    const sourceValue = sourceSnapshot.value;
    const sourceRevision = sourceSnapshot.revision;
    const unrelatedUrl = 'https://unrelated-theme-source.example.test/index.json';
    state.sourceReads = 0;
    listingCommits = 0;
    for (let index = 1; index <= 10; index++) {
        await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(sourceScope, { key: 'registry-sources', value: {
            ...sourceValue, sources: [...sourceValue.sources, { id: deriveMarketplaceSourceId(unrelatedUrl),
                title: `Unrelated ${index}`, url: unrelatedUrl, format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 2 }],
        } }, sourceRevision + index, true));
    }
    expect(state.sourceReads, 'unrelated source publications do not read registry configuration again').toBe(0);
    expect(state.acquisitions).toBe(1);
    expect(listingCommits, 'the listing observes only its own registry source').toBe(0);
    await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(sourceScope, { key: 'registry-sources', value: {
        ...sourceValue, sources: sourceValue.sources.map(source => source.id === sourceId ? { ...source, title: 'Renamed theme catalog' } : source),
    } }, sourceRevision + 11, true));
    await vi.waitFor(() => expect(view()?.meta).toContain('Renamed theme catalog'));
    await screen.update(listingSurface(false));
    listingCommits = 0;
    await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(sourceScope, { key: 'registry-sources', value: {
        ...sourceValue, sources: sourceValue.sources.map(source => source.id === sourceId ? { ...source, title: 'Renamed while hidden' } : source),
    } }, sourceRevision + 12, true));
    expect(listingCommits, 'a hidden listing releases its source subscription').toBe(0);
    await screen.update(listingSurface(true));
    await vi.waitFor(() => expect(view()?.meta).toContain('Renamed while hidden'));
    expect(state.acquisitions).toBe(1);
    expect(view()?.facts?.map((fact: NonNullable<StoreThemeListingViewProps['facts']>[number]) => fact.key)).toEqual(['includes', 'changes', 'worksOn', 'licence']);
    const faces = (await getThemeRegistryLifecycle().prepareStorePreview({ sourceId, itemId: 'palette' },
        { expectedScope: storage.getState().settingsScope })).item.payload.themes;
    await act(async () => { getThemeTryOnOwner().begin({ document: faces[0]!.document, mode: faces[0]!.mode,
        origin: { kind: 'store', listing: { sourceId, itemId: 'palette' } } }); });
    await vi.waitFor(() => expect(screen.findAllByType(ThemeTryBar)[0]?.props).toMatchObject({ visible: false, disabled: false }));
    barCommits = 0;
    for (let index = 1; index <= 10; index++) {
        const face = faces[index % faces.length]!;
        await act(async () => { getThemeTryOnOwner().begin({ document: face.document, mode: face.mode,
            origin: { kind: 'store', listing: { sourceId, itemId: 'palette' } } }); });
    }
    expect(barCommits, 'the hidden shell bar ignores the focused listing preview').toBe(0);
    await screen.update(listingSurface(false));
    expect(screen.findAllByType(ThemeTryBar)[0]?.props).toMatchObject({ visible: true, faceName: faces[10 % faces.length]!.document.profile.name });
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
    expect(state.acquisitions).toBe(1);
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
    state.failLight = false;
    await act(async () => { await view()!.onRetryFaces(); });
    await vi.waitFor(() => expect(view()?.installed).toBe(true));
    expect(view()?.tryingFaceId).toBeNull();
    expect(state.acquisitions).toBe(1);
    const installed = artifacts.list();
    expect(installed).toHaveLength(2);
    expect(installed.map(row => row.headerVersion)).toEqual([1, 1]);
    const installedHeader = Object.values(storage.getState().artifacts).find((artifact): artifact is Extract<DecryptedArtifact, { isDecrypted: true }> =>
        artifact.isDecrypted && ThemeProfileArtifactHeaderSchema.safeParse(artifact.rawHeader).success);
    if (!installedHeader) throw new Error('Expected an admitted installed theme header');
    const installedScope = storage.getState().settingsScope!;
    const installedThemes = await renderHook(() => storeKinds.theme.useInstalled({ scope: installedScope, machine: null, projectKey: null },
        { presented: true }, { scope: installedScope, failure: null, coverage: 'available', binding: null }));
    await vi.waitFor(() => expect(installedThemes.getCurrent().rows).toHaveLength(1));
    const originalInstalledRows = installedThemes.getCurrent().rows;
    listingCommits = 0;
    for (let index = 1; index <= 10; index++) {
        await act(async () => { storage.getState().applyArtifacts([{ ...installedHeader, id: `unrelated-theme-${index}`,
            title: `Unrelated ${index}`, rawHeader: { ...ThemeProfileArtifactHeaderSchema.parse(installedHeader.rawHeader),
                title: `Unrelated ${index}`, themeSource: { kind: 'yours' } } }]); });
    }
    expect(listingCommits, 'the listing ignores unrelated theme library headers').toBe(0);
    expect(installedThemes.getCurrent().rows, 'Installed ignores unrelated saved themes').toBe(originalInstalledRows);
    expect(view()?.installed).toBe(true);
    const selected = ThemeReferenceSchema.parse(storage.getState().localSettings.themeProfileSelection?.light);
    if (selected.kind !== 'artifact') throw new Error('Expected the selected installed artifact');
    const selectedRow = artifacts.read(selected.id);
    if (!selectedRow || typeof selectedRow.header !== 'string') {
        throw new Error('Expected the selected artifact header');
    }
    expect(ThemeProfileArtifactHeaderSchema.parse(decodePlainArtifactStoredContent(selectedRow.header)).themeSource)
        .toMatchObject({ kind: 'store', contributionId: 'light' });
    const scope = storage.getState().settingsScope!;
    const row = projectInstalledStoreThemeRows(readThemeLibrarySnapshot(scope)!.entries, scope)[0]!;
    const destination = presentInventoryRow(row, { scope, machine: null, projectKey: null }).home.href;
    if (typeof destination === 'string' || !destination) throw new Error('Expected the Installed listing destination');
    const selectedListing = readStoreListingRoute(destination.params);
    if (selectedListing?.kind !== 'store') throw new Error('Expected the same Store listing route');
    if (selectedListing.reference.type !== 'registryItem' || selectedListing.reference.kind !== 'theme') {
        throw new Error('Expected a registry theme listing route');
    }
    const installedReference = selectedListing.reference;
    expect(installedReference).toEqual(reference);
    await screen.update(listingSurface(true, 'page', installedReference));
    await vi.waitFor(() => expect(view()?.installed).toBe(true));
    expect(view()?.name).toBe('Palette');
    expect(state.acquisitions).toBe(1);
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
    expect(storage.getState().localSettings.themeProfileSelection?.light).toEqual(selected);
    expect(readSelectedThemeProfiles(scope).activeProfileIds.light).toBeNull();
});

it('retries acquisition, checks installed versions, updates latest through retry and duplicates into Yours', async () => {
    const { sourceId, artifacts, state } = await createRegistryThemeListingFixture({ failAcquisition: true });
    state.failLight = false;
    const reference = { type: 'registryItem' as const, kind: 'theme' as const, sourceId, itemId: 'palette' };
    const screen = await renderScreen(<StoreListingBody reference={reference} presentation="page" onClose={() => {}} />);
    const view = () => screen.findAllByType(StoreThemeListing)[0]?.props;
    await vi.waitFor(() => expect(view()?.facesState).toBe('error'));
    expect(state.acquisitions).toBe(1);
    expect(screen.findAllByType(RoundButton).some(button => button.props.onPress === view()?.onRetryAcquisition)).toBe(true);
    state.failAcquisition = false;
    await act(async () => { await view()!.onRetryAcquisition!(); });
    await vi.waitFor(() => expect(view()?.facesState, view()?.facesError ?? undefined).toBe('ready'));
    expect(state.acquisitions).toBe(2);
    await act(async () => { await view()!.onTryFace('light'); });
    await act(async () => { await view()!.onInstall(); });
    await vi.waitFor(() => expect(view()?.installed).toBe(true));
    expect(state.acquisitions).toBe(2);
    const installed = artifacts.list();
    expect(typeof view()?.onCheckUpdates).toBe('function');
    expect(typeof view()?.onDuplicate).toBe('function');
    await act(async () => { await view()!.onCheckUpdates!(); });
    expect(view()?.updateAvailable).toBe(false);
    expect(state.acquisitions, 'checking never acquires theme bodies').toBe(2);
    state.catalogVersion = '2.0.0';
    await act(async () => { await view()!.onCheckUpdates!(); });
    await vi.waitFor(() => expect(view()?.updateAvailable).toBe(true));
    expect(screen.findAllByType(RoundButton).some(button => button.props.onPress === view()?.onUpdate)).toBe(true);
    await act(async () => { await view()!.onTryFace('light'); });
    await vi.waitFor(() => expect(view()?.tryingFaceId).toBe('light'));
    state.failAcquisition = true;
    await act(async () => { await view()!.onUpdate!(); });
    expect(view()?.installFailures).toHaveLength(1);
    expect(view()?.tryingFaceId).toBe('light');
    expect(artifacts.list()).toHaveLength(2);
    state.failAcquisition = false;
    await act(async () => { await view()!.onRetryFaces(); });
    expect(state.acquisitions, 'Update and its retry acquire latest even while an inspected preview is active').toBe(4);
    expect(artifacts.list().map(record => ThemeProfileArtifactHeaderSchema.parse(decodePlainArtifactStoredContent(record.header)).themeSource))
        .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'store', provenance: expect.objectContaining({ ref: { kind: 'version', version: '2.0.0' } }) })]));
    await vi.waitFor(() => expect(view()?.updateAvailable).toBe(false));
    await act(async () => { await view()!.onDuplicate!(); });
    const editable = artifacts.list().filter(record => ThemeProfileArtifactHeaderSchema.parse(decodePlainArtifactStoredContent(record.header)).themeSource.kind === 'yours');
    expect(editable).toHaveLength(1);
    expect(editable[0]?.id).not.toBe(installed[0]?.id);
    const { router } = await import('expo-router');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/settings/appearance/themes/[profileId]', params: { profileId: JSON.stringify(['artifact', editable[0]!.id]) } });
    await act(async () => { await view()!.onUninstall!(); });
    await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
    expect(ThemeProfileArtifactHeaderSchema.parse(decodePlainArtifactStoredContent(artifacts.list()[0]!.header)).themeSource.kind).toBe('yours');
});
