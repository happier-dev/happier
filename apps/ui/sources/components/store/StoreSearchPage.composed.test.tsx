import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
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
const { StoreKindPage, Directory } = await import('./StoreKindPage');
const { StoreDirectory: StoreQueryDirectory } = await import('./StoreSearch');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');

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
    const screen = await renderScreen(<Page />);
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
    const screen = await renderScreen(<Page kind="mcpServer" />);
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

it('states native Software unavailability without selecting an ambient Machine', async () => {
    const { Page, cursors } = await setup();
    const screen = await renderScreen(<Page filters={JSON.stringify({ kind: { include: ['software'], exclude: [] } })} />);
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('store.kind.software.state').length).toBeGreaterThan(0));
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
    const screen = await renderScreen(<Page kind="mcpServer" />);
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
