import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

// Native layout boundary: react-test-renderer has no host layout, so the page measures its content at the top; the page
// scroll view reports a 900px viewport (see `renderWindowedScreen`), and the windowed Directory then mounts what that
// viewport reaches, as a user sees it.
vi.mock('@/components/ui/popover/measure', () => ({
    measureInWindow: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
}));
installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
const { StoreSearchPage } = await import('./StoreSearchPage');
const { StoreKindPage, StoreKindFrame, Directory } = await import('./StoreKindPage');
const { StoreDirectory: StoreQueryDirectory } = await import('./StoreSearch');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');

it.each(['populated', 'empty', 'failed', 'partial'] as const)('holds the initial Apps layout until curation settles %s', async outcome => {
    const { BUILT_IN_REGISTRY_SOURCES_V1 } = await import('@happier-dev/protocol/registries');
    const { MarketplaceIndexSourceSnapshotV1Schema, deriveMarketplaceSourceId } = await import('@happier-dev/protocol/marketplace');
    const serverUrl = `https://store-apps-layout-${outcome}.test`;
    const sourceUrl = `https://store-apps-curation-${outcome}.test/catalog.json`;
    const sourceId = deriveMarketplaceSourceId(sourceUrl);
    const failedUrls = ['https://unavailable-one.test/catalog.json', 'https://unavailable-two.test/catalog.json'];
    const failedSourceIds = failedUrls.map(deriveMarketplaceSourceId);
    const appSourceId = 'builtin:compose-catalog';
    let releaseCuration!: () => void;
    let pending = new Promise<void>(resolve => { releaseCuration = resolve; });
    let failCuration = outcome === 'failed';
    let appReads = 0;
    let curationReads = 0;
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
        source: { id: sourceId, title: 'Curated apps', kind: 'user', sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
        discovery: { items: outcome !== 'empty' ? [{ id: 'uptime', title: 'Uptime Kuma', reference: {
            type: 'registryItem', kind: 'app', sourceId: appSourceId, itemId: 'uptime-kuma',
        } }] : [], categories: outcome !== 'empty' ? [{ id: 'monitoring', title: 'Monitoring', items: ['uptime'] }] : [], jobs: [] },
    });
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2,
            disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.filter(source => source.id !== appSourceId).map(source => source.id),
            sources: [{ id: sourceId, title: 'Curated apps', url: sourceUrl, format: 'happier-catalog',
                kinds: ['plugin'], enabled: true, addedAt: 1 }, ...(outcome === 'partial' ? failedUrls.map((url, index) => ({
                    id: failedSourceIds[index]!, title: `Unavailable ${index}`, url, format: 'happier-catalog' as const,
                    kinds: ['plugin' as const], enabled: true, addedAt: 1 })) : [])],
        },
    }, 'updated', { handleExternalRequest: async url => {
        if (url === sourceUrl) {
            curationReads += 1;
            await pending;
            return failCuration ? new Response(null, { status: 503 }) : Response.json(catalog);
        }
        if (url.startsWith('https://api.github.com/repos/coollabsio/coolify/commits/')) return Response.json({ sha: 'a'.repeat(40) });
        if (url.includes('/templates/service-templates.json')) {
            appReads += 1;
            return Response.json({ 'uptime-kuma': { name: 'Uptime Kuma', slogan: 'Monitor your services' },
                wordpress: { name: 'WordPress', slogan: 'Publish your blog' } });
        }
        return new Response(null, { status: 503 });
    } });
    onTestFinished(async () => { releaseCuration(); await standardCleanup(); await fixture.dispose(); });
    function Page() {
        const [params, setParams] = React.useState<Record<string, string>>({ view: 'kind', kind: 'app' });
        const navigation = React.useMemo(() => ({ push: () => {}, replace: () => {}, back: () => {},
            setParams: (values: Record<string, string | undefined>) => setParams(previous => {
                const next = { ...previous };
                for (const [key, value] of Object.entries(values)) {
                    if (value === undefined) delete next[key]; else next[key] = value;
                }
                return next;
            }) }), []);
        return <DestinationInstanceHost tabId="apps-layout" ref={{ kind: 'plugins', params }} pathname="/plugins" focused visible
            navigation={navigation}><AppPaneProvider><StoreKindPage kind="app" presented /></AppPaneProvider></DestinationInstanceHost>;
    }
    const screen = await renderScreen(<Page />);
    // Both real reads run concurrently; a fast catalog must not become a temporary first section.
    await waitForHomeGovernance(() => expect(appReads).toBeGreaterThan(0));
    await waitForHomeGovernance(() => expect(curationReads).toBeGreaterThan(0));
    const { useRegistryItems } = await import('@/registries/useRegistryItems');
    // The section must stay held after the actual catalog has settled, not merely before its request starts.
    const { renderHook } = await import('@/dev/testkit');
    const loaded = await renderHook(() => useRegistryItems({ kind: 'app', query: '' }));
    await waitForHomeGovernance(() => expect(loaded.getCurrent().items).toHaveLength(2));
    expect(appReads).toBe(1);
    expect(screen.findAllByType(Directory)).toHaveLength(0);
    expect(screen.findAllByTestId('store.kind.app.loading').length).toBeGreaterThan(0);
    if (outcome === 'populated') {
        // Explicit search does not render the unknown browsing layout and must remain usable while it loads.
        const changeQuery = (text: string) => screen.findAllByTestId('store.kind.app.search')
            .find(node => typeof node.props.onChangeText === 'function')!.props.onChangeText(text);
        await act(async () => { changeQuery('WordPress'); });
        expect(screen.root.findByType(StoreKindFrame).props.query).toBe('WordPress');
        await waitForHomeGovernance(() => expect(screen.findAllByType(Directory).flatMap(node => node.props.rows)
            .map((row: { title: string }) => row.title)).toEqual(['WordPress']));
        await act(async () => { changeQuery(''); });
        await waitForHomeGovernance(() => expect(screen.findAllByType(Directory)).toHaveLength(0));
    }
    const readsBeforeCuration = appReads;
    await act(async () => { releaseCuration(); });
    let retryCuration: (() => Promise<void>) | undefined;
    if (outcome === 'failed') {
        await waitForHomeGovernance(() => expect(screen.root.findAllByType(SurfaceStateCard)
            .some(node => node.props.testID === 'store.kind.app.failure')).toBe(true));
        // A failed cold curation hides nothing (J03): the catalog's own rows list under the curated source's line.
        await waitForHomeGovernance(() => expect(screen.findAllByType(Directory).flatMap(node => node.props.rows)).toHaveLength(2));
        const failure = screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'store.kind.app.failure');
        expect(failure).toBeDefined();
        const { RegistrySourcesUnavailable } = await import('@/components/capabilities/add/RegistrySourcesUnavailable');
        retryCuration = screen.root.findAllByType(RegistrySourcesUnavailable)[0]!.props.failures
            .find((entry: { key: string }) => entry.key === sourceId)!.onRetry;
        failCuration = false;
        pending = new Promise<void>(resolve => { releaseCuration = resolve; });
        const beforeRetry = curationReads;
        await act(async () => { void failure!.props.action.onPress(); });
        await waitForHomeGovernance(() => expect(curationReads).toBeGreaterThan(beforeRetry));
        expect(screen.findAllByType(Directory).flatMap(node => node.props.rows)).toHaveLength(2);
        await act(async () => { releaseCuration(); });
    }
    await waitForHomeGovernance(() => expect(screen.findAllByType(Directory).flatMap(node => node.props.rows)).toHaveLength(2));
    const directory = screen.findAllByType(Directory)[0]!;
    expect(directory.props.rows).toHaveLength(2);
    if (outcome === 'partial') expect(directory.props.list.sourceFailures.map((failure: { sourceId: string }) => failure.sourceId))
        .toEqual(failedSourceIds);
    expect(directory.props.groups.map((group: { key: string }) => group.key)).toEqual(outcome !== 'empty'
        ? [`category:${JSON.stringify([sourceId, 'monitoring'])}`, `source:${appSourceId}`]
        : [`source:${appSourceId}`]);
    // Curation arrival itself never repeats the Apps read, including after an explicit search.
    expect(appReads).toBe(readsBeforeCuration);
    if (retryCuration) {
        // Once admitted, the exact same curation read may fail again without withdrawing or regrouping healthy rows.
        const heldGroups = directory.props.groups;
        const heldRows = directory.props.rows;
        failCuration = true;
        pending = new Promise<void>(resolve => { releaseCuration = resolve; });
        let refresh!: Promise<void>;
        const beforeRefresh = curationReads;
        await act(async () => { refresh = retryCuration!(); });
        await waitForHomeGovernance(() => expect(curationReads).toBeGreaterThan(beforeRefresh));
        expect(screen.findAllByType(Directory)[0]!.props.rows).toBe(heldRows);
        expect(screen.findAllByType(Directory)[0]!.props.groups).toBe(heldGroups);
        await act(async () => { releaseCuration(); await refresh; });
        expect(screen.findAllByType(Directory)[0]!.props.rows).toBe(heldRows);
        expect(screen.findAllByType(Directory)[0]!.props.groups).toBe(heldGroups);
        expect(screen.root.findByType(StoreQueryDirectory).props.curationComplete).toBe(false);
        expect(appReads).toBe(1);
    }
});

it('keeps a cold failed Skills read distinct from empty and retries the existing owner', async () => {
    await setup('skill-failed-state');
    const retry = vi.fn();
    const raw = 'Scoped RPC socket disconnected during Machine preparation';
    const screen = await renderScreen(<Directory kind="skill" rows={[]} groups={[]} query="" sourceTitle={() => 'skills.sh'}
        list={{ loading: false, hasNextPage: false, error: raw, status: { state: 'needs_machine' }, refresh: retry }} />);
    expect(screen.findAllByTestId('store.kind.skill.empty')).toHaveLength(0);
    const notice = screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'store.kind.skill.failure');
    expect(notice).toBeDefined();
    expect(screen.getTextContent()).not.toContain(raw);
    await act(async () => { notice!.props.action.onPress(); });
    expect(retry).toHaveBeenCalledTimes(1);
});

/**
 * Render with a measured scroll host: the page ScrollView exposes its content node (the span measurement above reads it)
 * and reports a 900px viewport through its own onLayout, so the windowed Directory mounts what that viewport reaches.
 */
async function renderWindowedScreen(element: React.ReactElement) {
    const content = {};
    const screen = await renderScreen(element, {
        createNodeMock: node => (node.type === 'ScrollView' ? { getInnerViewRef: () => content, scrollTo: () => {} } : node.type === 'View' ? {} : null),
    });
    await giveViewport(screen);
    return screen;
}

let contentRevision = 0;

/** Report a measured viewport through the page scroll view's real layout handler (the zero-height renderer reports none). */
async function giveViewport(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => {
        const hosts = screen.root.findAll(candidate => typeof candidate.props.onScroll === 'function' && typeof candidate.props.onLayout === 'function');
        for (const node of hosts) {
            node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 900 } } });
            // A content size report makes the page tracker re-measure the Directory against the new content.
            node.props.onContentSizeChange?.(800, 4000 + (contentRevision += 1));
        }
    });
}

async function setup(qualifier = 'cursors', withFailure = false) {
    const serverUrl = `https://store-page-${qualifier}.test`;
    const sourceId = 'user:paged-mcp';
    const failedSourceId = 'user:failed-mcp';
    const cursors: (string | null)[] = [];
    let pendingRead: Promise<void> | null = null;
    let releaseRead: (() => void) | undefined;
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Paged MCP',
            format: 'mcp-registry', kinds: ['mcpServer'], url: 'https://paged-mcp.test', enabled: true, addedAt: 1 },
            ...(withFailure ? [{ id: failedSourceId, title: 'Unavailable MCP', format: 'mcp-registry', kinds: ['mcpServer'],
                url: 'https://failed-mcp.test', enabled: true, addedAt: 1 }] : [])] },
    }, 'updated', { handleExternalRequest: async href => {
        const url = new URL(href);
        if (url.hostname !== 'paged-mcp.test') return new Response(null, { status: 503 });
        const cursor = url.searchParams.get('cursor');
        cursors.push(cursor);
        await pendingRead;
        const index = cursor === 'two' ? 2 : cursor === 'three' ? 3 : 1;
        if (qualifier === 'preview') return Response.json({ servers: [1, 2, 3, 4, 5, 6].map(n => ({ server: { name: `example/tool-${n}`,
            title: `Tool ${n}`, description: 'A tool', version: '1.0.0', remotes: [{ type: 'streamable-http', url: `https://tools.test/t${n}` }] } })),
            metadata: { count: 6 } });
        return Response.json({ servers: [{ server: { name: `example/page-${index}`, title: `Page ${index}`, description: 'Paged tool',
            version: '1.0.0', remotes: [{ type: 'streamable-http', url: `https://tools.test/${index}` }] } }],
            metadata: { count: 1, ...(index < 3 ? { nextCursor: index === 1 ? 'two' : 'three' } : {}) } });
    } });
    onTestFinished(async () => { releaseRead?.(); await standardCleanup(); await fixture.dispose(); });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const target = resolveDestinationRefFromHref(catalog, '/plugins?view=search')!;
    const initial = { kind: { include: ['mcpServer'], exclude: [] }, source: { include: [sourceId, ...(withFailure ? [failedSourceId] : [])], exclude: [] } };
    function Page(props: Readonly<{ kind?: 'mcpServer'; filters?: string; presented?: boolean; focused?: boolean }>) {
        const presented = props.presented ?? true;
        const [params, setParams] = React.useState<Record<string, string>>({ ...target.params,
            filters: props.filters ?? JSON.stringify(initial) });
        // The workspace owner keeps one navigation object per tab.
        const navigation = React.useMemo(() => ({ push: () => {}, replace: () => {}, back: () => {},
            setParams: (values: Record<string, string | undefined>) => setParams(previous => {
                const next = { ...previous };
                for (const [key, value] of Object.entries(values)) {
                    if (value === undefined) delete next[key]; else next[key] = value;
                }
                return next;
            }) }), []);
        return <DestinationInstanceHost tabId="store-page" ref={{ ...target, params }} pathname="/plugins" focused={props.focused ?? presented} visible={presented}
            navigation={navigation}>
            <AppPaneProvider>{props.kind ? <StoreKindPage kind={props.kind} presented={presented} /> : <StoreSearchPage presented={presented} />}</AppPaneProvider>
        </DestinationInstanceHost>;
    }
    return { Page, cursors, sourceId, pauseReads: () => {
        pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
        return () => { releaseRead?.(); pendingRead = null; };
    } };
}

it('keeps loaded Search coverage in place through a warm native loading phase', async () => {
    const { Page, pauseReads } = await setup('continuity', true);
    const screen = await renderWindowedScreen(<Page />);
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('store.kind.search.moreNote').length).toBeGreaterThan(0));
    const note = screen.findAllByTestId('store.kind.search.moreNote')[0];
    // The real Retry forces the same warm loading publication as the live Back trace;
    // hold only the upstream HTTP response, not native read logic or its result.
    const resume = pauseReads();
    try {
        await screen.update(<Page presented={false} />);
        await screen.update(<Page />);
        const failure = screen.root.findAllByType(SurfaceStateCard).find(node =>
            node.props.testID === 'store.kind.search.failure');
        expect(failure).toBeDefined();
        await act(async () => { void failure!.props.action.onPress(); });
        await waitForHomeGovernance(() => expect(screen.root.findByType(Directory).props.list.loading).toBe(true));
        // Live Chrome restores7736 first, then losing this54px block clamps it to7682.
        expect(screen.getTextContent()).toContain('Page 1');
        expect(screen.findAllByTestId('store.kind.search.moreNote')[0] === note).toBe(true);
    } finally { resume(); }
    await waitForHomeGovernance(() => expect(screen.root.findByType(Directory).props.list.loading).toBe(false));
    expect(screen.findAllByTestId('store.kind.search.moreNote')[0] === note).toBe(true);
});

it('uses the current native cursor after each actual Search page load', async () => {
    const { Page, cursors } = await setup();
    const screen = await renderWindowedScreen(<Page />);
    await waitForHomeGovernance(() => expect(cursors).toEqual([null]));
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('store.kind.search.loadMore').length).toBeGreaterThan(0));
    await act(async () => { screen.pressByTestId('store.kind.search.loadMore'); });
    await waitForHomeGovernance(() => expect(cursors).toEqual([null, 'two']));
    await act(async () => { screen.pressByTestId('store.kind.search.loadMore'); });
    await waitForHomeGovernance(() => expect(cursors).toEqual([null, 'two', 'three']));
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Page 3'));
    expect(screen.findAllByTestId('store.kind.search.loadMore')).toHaveLength(0);
});

it('mounts the shared kind controller and composes exclusions before native acquisition', async () => {
    const { Page, sourceId } = await setup();
    const screen = await renderWindowedScreen(<Page kind="mcpServer" />);
    const scope = storage.getState().settingsScope!;
    const executor = createDefaultActionExecutor();
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Page 1'));
    await act(async () => {
        expect(await executor.execute('settings.column.filter.set', { column: 'store', ...scope,
            filters: { source: { include: [], exclude: [sourceId] } }, searchQuery: 'Page' },
        { surface: 'agent', serverId: scope.serverId, runtimeAccountId: scope.accountId })).toMatchObject({ ok: true });
    });
    await waitForHomeGovernance(() => expect(screen.getTextContent()).not.toContain('Page 1'));
    expect(await executor.execute('settings.column.filter.get', { column: 'store', ...scope },
        { surface: 'agent', serverId: scope.serverId, runtimeAccountId: scope.accountId })).toMatchObject({ ok: true,
        result: { searchQuery: 'Page', filters: { source: { include: [], exclude: [sourceId] } } } });
});

it('keeps malformed kind narrowing unavailable instead of browsing all sources', async () => {
    const { Page, cursors } = await setup();
    const screen = await renderScreen(<Page kind="mcpServer" filters="{" />);
    expect(screen.findAllByTestId('store.search.invalid').length).toBeGreaterThan(0);
    expect(cursors).toHaveLength(0);
});

it('waits for Account Software declarations without selecting an ambient Machine', async () => {
    const { Page, cursors } = await setup();
    const screen = await renderScreen(<Page filters={JSON.stringify({ kind: { include: ['software'], exclude: [] } })} />);
    await flushHookEffects();
    expect(screen.findAllByTestId('store.kind.software.state')).toHaveLength(0);
    expect(screen.findAllByTestId('store.search.software.machine')).toHaveLength(0);
    expect(screen.root.findByType(Directory).props.list.loading).toBe(true);
    expect(cursors).toHaveLength(0);
});

it('previews each kind in an all-kind search and opens the rest behind that kind\'s All N (TASTE-S4060 D6)', async () => {
    const { Page } = await setup('preview');
    const screen = await renderWindowedScreen(<Page filters="{}" />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Tool 1'));
    const directory = () => screen.root.findByType(Directory);
    await waitForHomeGovernance(() => expect(new Set(directory().props.rows.map((row: { group: string }) => row.group)).size).toBeGreaterThan(1));
    // All kinds: four MCP rows, the other two behind the MCP section's own All 6.
    expect(directory().props.rows.filter((row: { group: string }) => row.group === 'mcpServer')).toHaveLength(4);
    const all = directory().props.groupAction?.('mcpServer');
    // This Home's curated marketplace and ACP registry don't answer here, so MCP's total is unknown: its All carries no
    // count rather than claiming the six loaded rows are everything (LV-JUDGE-1102 UI-FIX-D (3)).
    expect(all).toMatchObject({ label: 'capabilities.store.search.all', kind: 'link' });
    await act(async () => { all!.onPress(); });
    // The link chooses that kind: every MCP row, and no preview links.
    await waitForHomeGovernance(async () => { await giveViewport(screen); expect(screen.getTextContent()).toContain('Tool 6'); });
    expect(directory().props.rows.every((row: { group: string }) => row.group === 'mcpServer')).toBe(true);
    expect(directory().props.groupAction).toBeUndefined();
});

it('leaves a kind page\'s query and rows still when Discover re-renders without new curation facts', async () => {
    const { Page } = await setup('curation-locality');
    const screen = await renderWindowedScreen(<Page kind="mcpServer" />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Page 1'));
    const query = () => screen.root.findByType(StoreQueryDirectory).props;
    // The curated source is unreachable here: its read settles failed, and the page's catalog facts stay the same.
    await waitForHomeGovernance(() => expect(query().curationComplete).toBe(false));
    const settled = query();
    // Discover renders again (its owner re-rendered) with the same pages and completeness.
    await screen.update(<Page kind="mcpServer" />);
    expect(query().curation).toBe(settled.curation);
    expect(query()).toBe(settled);
});
