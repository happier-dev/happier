import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

/** A real history under the router boundary: push adds an entry, back pops it, setParams edits the current one. */
const nav = vi.hoisted(() => {
  type Entry = { pathname: string; params: Record<string, string> };
  const stack: Entry[] = [{ pathname: '/plugins', params: {} }];
  const listeners = new Set<() => void>();
  let version = 0;
  const resetOverrides = { current: () => {} };
  const notify = () => {
    version += 1;
    // The router mock layers setParams over the route; the history is the one source, so drop the layer and re-read it.
    resetOverrides.current();
    for (const listener of listeners) listener();
  };
  const parse = (href: unknown): Entry => {
    if (typeof href === 'string') {
      const [pathname = '', query = ''] = href.split('?');
      return {
        pathname,
        params: Object.fromEntries(new URLSearchParams(query)),
      };
    }
    const { pathname, params } = href as {
      pathname: string;
      params?: Record<string, string>;
    };
    return { pathname, params: { ...params } };
  };
  return {
    stack,
    /** What the page publishes to its native bar, newest last. */
    stackOptions: [] as unknown[],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    top: () => stack[stack.length - 1]!,
    reset: () => {
      stack.splice(0, stack.length, { pathname: '/plugins', params: {} });
      notify();
    },
    push: (href: unknown) => {
      stack.push(parse(href));
      notify();
    },
    back: () => {
      if (stack.length > 1) stack.pop();
      notify();
    },
    setParams: (value: Record<string, string | undefined>) => {
      const top = stack[stack.length - 1]!;
      for (const [key, next] of Object.entries(value)) {
        if (next === undefined) delete top.params[key];
        else top.params[key] = next;
      }
      notify();
    },
    setDirectoryParams: (value: Record<string, unknown>) => {
      for (const [key, next] of Object.entries(value)) {
        if (next === undefined) delete stack[0]!.params[key];
        else stack[0]!.params[key] = String(next);
      }
      notify();
    },
    resetOverrides,
  };
});

installPromptRegistriesCommonModuleMocks({
  storage: (original) => original(),
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({
      pathname: () => nav.top().pathname,
      params: () => nav.top().params,
      router: {
        push: nav.push,
        back: nav.back,
        setParams: nav.setParams,
        canGoBack: () => nav.stack.length > 1,
      },
      stackOptionsCapture: {
        record: (options) => { nav.stackOptions.push(typeof options === 'function' ? options() : options); },
        reset: () => { nav.stackOptions.length = 0; },
        getRaw: () => (nav.stackOptions.at(-1) ?? null) as never,
        getResolved: () => (nav.stackOptions.at(-1) ?? null) as never,
      },
    });
    nav.resetOverrides.current = mock.resetParams;
    return mock.module;
  },
});
vi.mock('@react-navigation/native', async () =>
  (
    await import('@/dev/testkit/mocks/reactNavigation')
  ).createReactNavigationNativeMock(),
);
const detailsPane = vi.hoisted(() => ({ available: true }));
vi.mock('@/components/appShell/panes/details/detailsPaneAvailability', () => ({
  useDetailsPaneAvailable: () => detailsPane.available,
}));

const { MarketplaceIndexSourceSnapshotV1Schema, DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, deriveMarketplaceSourceId } = await import('@happier-dev/protocol/marketplace');
const { HAPPIER_PICKS_SOURCE_ID } = await import('@happier-dev/protocol/registries');
const { useRegistrySources } = await import('@/registries/useRegistrySources');
const { createPlainPromptLibraryCatalogHomeFixture } =
  await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } =
  await import('@/dev/testkit/harness/homeGovernanceHarness');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { NavigationContext } = await import('@react-navigation/native');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { StoreScreen } = await import('../StoreScreen');
const { StoreListingRoute, useStoreListingSelection } = await import('../StoreListing');
const { StoreDiscoverPage } = await import('./StoreDiscoverPages');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');

function Harness(props: Readonly<{ nativeListing?: boolean; nativeListingReady?: boolean; retainedDirectory?: boolean }> = {}): React.ReactElement {
  React.useSyncExternalStore(nav.subscribe, nav.version, nav.version);
  const selection = useStoreListingSelection();
  return (
    <>
      {props.retainedDirectory ? <DestinationInstanceHost tabId="store-directory"
        ref={{ kind: 'plugins', params: nav.stack[0]!.params }} pathname="/plugins"
        focused={nav.stack.length === 1} visible={nav.stack.length === 1}
        navigation={{ push: nav.push, pushRetainingCurrent: nav.push, replace: nav.push, back: nav.back, setParams: nav.setDirectoryParams }}>
        <StoreScreen />
      </DestinationInstanceHost> : null}
      {/* The Store's listing route is its own screen; the body behind it is covered by the listing tests. */}
      {nav.top().pathname.endsWith('/plugins/listing') ? (
        props.nativeListing && props.nativeListingReady !== false ? <StoreListingRoute /> : <React.Fragment key="listing">
          {React.createElement('View', { testID: 'route.listing' })}
        </React.Fragment>
      ) : (
        props.retainedDirectory ? null : <StoreScreen />
      )}
      {React.createElement('View', {
        testID: 'route.selection',
        accessibilityLabel: selection ? JSON.stringify(selection) : '',
      })}
    </>
  );
}

/** The job cards lay out from a measured width; a test renderer has no layout pass, so it reports one. */
const measureCards = async (screen: Awaited<ReturnType<typeof renderScreen>>, stageTestID: string) => {
  await waitForHomeGovernance(() => expect(screen.findAllHostsByTestId(stageTestID).length).toBeGreaterThan(0));
  await act(async () => {
    screen.findHostByTestId(stageTestID)!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 600 } } });
  });
};
const press = async (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => {
    try {
        await waitForHomeGovernance(() => expect(screen.findAllByTestId(testID).length).toBeGreaterThan(0));
    } catch (error) {
        const ids = [...new Set(screen.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.startsWith('store.')).map(node => String(node.props.testID)))];
        throw new Error(`no ${testID}; saw ${ids.join(', ')}; text=${screen.getTextContent().slice(0, 400)}`, { cause: error });
    }
    await act(async () => { screen.pressByTestId(testID); });
};

let fixtureSequence = 0;
async function renderDiscoverWithOneJob(options?: { view: string; focused: boolean; visible: boolean; distinctJobChoices?: boolean; curatedUnavailable?: boolean; unusedApp?: boolean }, withFailures = false, allHealthy = false) {
  // A skill choice from another admitted Registry: the curated catalog only points at it.
  const reference = {
    type: 'registryItem' as const,
    kind: 'skill' as const,
    sourceId: 'builtin:skills-sh',
    itemId: 'fixture/skills/review',
  };
  const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
    source: { id: HAPPIER_PICKS_SOURCE_ID, title: 'Picks', kind: 'curated', sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL },
    freshness: { state: 'fresh', fetchedAtMs: 1 },
    entries: [],
    diagnostics: [],
    discovery: {
      items: [{ id: 'review-skill', title: 'Review skill', reference },
        ...(options?.unusedApp ? [{ id: 'unused-app', title: 'Unused app', reference: {
          type: 'registryItem' as const, kind: 'app' as const, sourceId: 'builtin:compose-catalog', itemId: 'unused-app',
        } }] : [])],
      categories: [{ id: 'reviews', title: 'Reviews', items: ['review-skill'] }],
      jobs: [
        {
          id: 'review',
          title: 'Review code',
          description: 'Get a second pair of eyes on a change',
          glyph: 'fcGlobe',
          groups: [{ title: 'Choices', items: ['review-skill'] }],
        },
      ],
    },
  });
  const catalogReads: string[] = [];
  const itemReads: string[] = [];
  const failureProbe = { failing: !allHealthy };
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    `https://store-discover-navigation-${++fixtureSequence}.test`,
    { key: 'registry-sources', value: { v: 2, sources: withFailures ? [
      { id: deriveMarketplaceSourceId('https://healthy-catalog.test/catalog.json'), title: 'Healthy catalog', format: 'happier-catalog', kinds: ['plugin', 'agent'],
        url: 'https://healthy-catalog.test/catalog.json', enabled: true, addedAt: 1 },
      { id: deriveMarketplaceSourceId('https://failure-catalog.test/catalog.json'), title: 'Failure probe', format: 'happier-catalog', kinds: ['plugin', 'agent'],
        url: 'https://failure-catalog.test/catalog.json', enabled: true, addedAt: 1 },
    ] : [], disabledSourceIds: [] } },
    'updated',
    {
      handleExternalRequest: async (url) => {
        if (url !== DEFAULT_CURATED_MARKETPLACE_SOURCE_URL && !withFailures) {
          // Mark resolution now follows the reference into its native Registry. This fixture keeps that item unavailable.
          itemReads.push(url);
          return new Response(null, { status: 503 });
        }
        catalogReads.push(url);
        if (withFailures) {
          const snapshot = () => MarketplaceIndexSourceSnapshotV1Schema.parse({ ...catalog,
            ...(options?.distinctJobChoices ? { discovery: { ...catalog.discovery,
              items: catalog.discovery!.items.map(item => ({ ...item,
                reference: { ...item.reference, itemId: `${new URL(url).hostname}/skills/review` },
              })),
            } } : {}),
            source: { id: deriveMarketplaceSourceId(url), title: new URL(url).hostname, kind: 'user', sourceUrl: url } });
          if (new URL(url).hostname === 'healthy-catalog.test') return Response.json(snapshot());
          if (new URL(url).hostname === 'failure-catalog.test') return failureProbe.failing
            ? new Response(null, { status: 503 }) : Response.json(snapshot());
          return new Response(null, { status: 503 });
        }
        if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return options?.curatedUnavailable ? new Response(null, { status: 503 }) : Response.json(catalog);
        throw new Error(`Discover must read only the admitted curated catalog: ${url}`);
      },
    },
  );
  onTestFinished(async () => {
    await standardCleanup();
    await fixture.dispose();
    nav.reset();
  });
  await fixture.hydrateAccountSettings();
  nav.reset();
  if (options) nav.setParams({ view: options.view, job: 'review', category: 'reviews' });
  // A retained page may already have admitted source descriptors. Await that
  // real owner so a hidden-read assertion cannot pass just before cold setup settles.
  let sourcesReady = false;
  function SourceReadiness() { sourcesReady = useRegistrySources(undefined).hasValue; return null; }
  const tree = (focused = true, visible = true) => <NavigationContext.Provider value={createNavigationPropMock({ isFocused: () => focused })}>
    {options ? <SourceReadiness /> : null}
    <PluginSurfaceFocusEligibilityProvider active={focused} presentationActive={visible}>
      <AppPaneProvider><Harness /></AppPaneProvider>
    </PluginSurfaceFocusEligibilityProvider>
  </NavigationContext.Provider>;
  const screen = await renderScreen(tree(options?.focused, options?.visible));
  if (options) await waitForHomeGovernance(() => expect(sourcesReady).toBe(true));
  return { screen, reference, tree, catalogReads, itemReads, failureProbe };
}

it.each(['jobs', 'job', 'category'])('acquires only the displayed choices on the %s page', async view => {
  const { screen, itemReads } = await renderDiscoverWithOneJob({ view, focused: true, visible: true, unusedApp: true });
  await waitForHomeGovernance(() => expect(screen.findAllByTestId(view === 'jobs' ? 'store.jobs.list' : view === 'job'
    ? 'store.job.groups' : 'store.category.items').length).toBeGreaterThan(0));
  await flushHookEffects();
  expect(itemReads.filter(url => url.includes('coollabsio') || url.includes('coolify'))).toEqual([]);
  if (view === 'jobs') expect(itemReads).toEqual([]);
});

it.each(['discover', 'jobs', 'job', 'category'])('withdraws %s acquisition for retained hidden and blurred pages', async view => {
  const { screen, tree, catalogReads, itemReads } = await renderDiscoverWithOneJob({ view, focused: true, visible: false });
  expect(catalogReads).toHaveLength(0);
  expect(itemReads).toHaveLength(0);
  await screen.update(tree(false, true));
  expect(catalogReads).toHaveLength(0);
  expect(itemReads).toHaveLength(0);
  await screen.update(tree(true, true));
  await waitForHomeGovernance(() => expect(catalogReads).toHaveLength(1));
  const activeItemReads = itemReads.length;
  await screen.update(tree(false, false));
  expect(catalogReads).toHaveLength(1);
  expect(itemReads).toHaveLength(activeItemReads);
});

it('keeps Software in the phone Browse by kind entry alongside the other supported kinds', async () => {
  const { screen } = await renderDiscoverWithOneJob();
  await waitForHomeGovernance(() => expect(screen.findAllHostsByTestId('store.discover.pinned.kinds.row').length).toBeGreaterThan(0));
  // One row under the search opens every kind in place, so a phone never scrolls past the page to reach them.
  await act(async () => { screen.findAllHostsByTestId('store.discover.pinned.kinds.row')[0]!.props.onPress?.(); });
  await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('capabilities.store.kinds.software.title'));
});

it('offers the kinds once when the curated catalog cannot be reached: the Browse entry, never a second copy in the page', async () => {
  const { screen, catalogReads } = await renderDiscoverWithOneJob({ view: 'discover', focused: true, visible: true, curatedUnavailable: true });
  await waitForHomeGovernance(() => expect(catalogReads.length).toBeGreaterThan(0));
  await waitForHomeGovernance(() => expect(screen.findAllByTestId('store.discover.unavailable').length).toBeGreaterThan(0));
  expect(screen.findAllHostsByTestId('store.discover.pinned.kinds.row').length).toBeGreaterThan(0);
  expect(screen.findAllByTestId('store.discover.kinds')).toHaveLength(0);
});

it('keeps the retained Discover choices mounted while presentation withdraws native demand', async () => {
  const { screen, tree, catalogReads } = await renderDiscoverWithOneJob({ view: 'discover', focused: true, visible: true });
  await waitForHomeGovernance(() => expect(screen.findAllHostsByTestId('store.discover.directory.review-skill').length).toBeGreaterThan(0));
  const choice = screen.findAllHostsByTestId('store.discover.directory.review-skill')[0];
  await screen.update(tree(false, false));
  expect(screen.findAllHostsByTestId('store.discover.directory.review-skill')[0] === choice).toBe(true);
  expect(catalogReads).toHaveLength(1);
  await screen.update(tree(true, true));
  expect(screen.findAllHostsByTestId('store.discover.directory.review-skill')[0] === choice).toBe(true);
});

it('gives same-local-id jobs from two sources distinct mounted focus-return targets', async () => {
  // Exact copies are intentionally deduped; these jobs share an editorial id but offer different native choices.
  const { screen } = await renderDiscoverWithOneJob({ view: 'jobs', focused: true, visible: true, distinctJobChoices: true }, true, true);
  await measureCards(screen, 'store.jobs.list:stage');
  await waitForHomeGovernance(() => expect(screen.getTextContent().split('Review code').length).toBeGreaterThan(2));
  const cards = screen.findAll(node => typeof node.type === 'string'
    && String(node.props.testID ?? node.props['data-testid'] ?? '').startsWith('store.jobs.list.')
    && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function')
    && (node.type === 'button' || node.props.accessibilityRole === 'button' || node.props.role === 'button'));
  expect(cards).toHaveLength(2);
  expect(new Set(cards.map(card => card.props.testID ?? card.props['data-testid'])).size).toBe(cards.length);
});

it('opens the qualified category All link with a non-empty accessible directory name', async () => {
  const { screen } = await renderDiscoverWithOneJob();
  await waitForHomeGovernance(() => expect(screen.findAllByTestId('store.discover.directory').length).toBeGreaterThan(0));
  // Drive the shared Collection group action, whose link is the real category ingress.
  const action = screen.findAll(node => typeof node.props.testID === 'string'
    && node.props.testID.startsWith('store.discover.directory:group:') && node.props.testID.endsWith(':action'))[0];
  expect(action).toBeDefined();
  await press(screen, action!.props.testID);
  expect(nav.top().params).toMatchObject({ view: 'category', category: 'reviews', catalogSource: HAPPIER_PICKS_SOURCE_ID });
  await waitForHomeGovernance(() => expect(screen.findAllByTestId('store.category.items').length).toBeGreaterThan(0));
  const category = screen.findAll(node => node.props.testID === 'store.category.items'
    && typeof node.props.accessibilityLabel === 'string')[0];
  expect(category?.props.accessibilityLabel.trim()).toBe('Reviews');
});

it('says failing curated sources on one line, names them on demand, and drops a recovered one', async () => {
  const { screen, failureProbe } = await renderDiscoverWithOneJob(undefined, true);
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  const lines = () => screen.root.findAllByType(SurfaceStateCard).filter(node =>
    node.props.testID === 'store.discover.unavailable');
  await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Review skill'));
  // Two failing sources share one line; their names wait behind Details.
  await waitForHomeGovernance(() => expect(lines()).toHaveLength(1));
  expect(screen.getTextContent()).not.toContain('Failure probe');
  await screen.pressByTestIdAsync('store.discover.unavailable.details');
  expect(screen.findAllByTestId('store.discover.unavailable.sources').length).toBeGreaterThan(0);
  const { RegistrySourcesUnavailable } = await import('@/components/capabilities/add/RegistrySourcesUnavailable');
  // This harness's text owner renders the key alone, so the named lines are counted, not read.
  expect(screen.root.findAllByType(RegistrySourcesUnavailable)[0]!.props.failures).toHaveLength(2);
  failureProbe.failing = false;
  await screen.pressByTestIdAsync('store.discover.unavailable.retry');
  // One source still fails: the line names it, and the recovered one is gone.
  await waitForHomeGovernance(() => expect(lines()[0]?.props.title.includes('Failure probe')).toBe(false));
  expect(lines()).toHaveLength(1);
  expect(screen.getTextContent()).toContain('Review skill');
});

it('hands native MCP Text edits through a lazy pane-to-page transition without URL disclosure', async () => {
  const reference = { type: 'registryItem', kind: 'mcpServer', sourceId: 'builtin:mcp-registry', itemId: 'example/region', version: '1.0.0' } as const;
  const server = { name: reference.itemId, title: 'Regional tool', description: 'Choose a region', version: reference.version,
    packages: [{ registryType: 'npm', identifier: '@example/region', version: reference.version, runtimeHint: 'npx', transport: { type: 'stdio' },
      environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }] }] };
  const registryReads: string[] = [];
  const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://store-native-handoff.test',
    { key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] } }, 'updated', {
      handleExternalRequest: async href => {
        const url = new URL(href);
        if (url.hostname !== 'registry.modelcontextprotocol.io') return new Response(null, { status: 503 });
        registryReads.push(url.pathname);
        return Response.json(url.pathname.endsWith('/v0.1/servers')
          ? { servers: [{ server }], metadata: { count: 1 } }
          : { server: { ...server, name: decodeURIComponent(url.pathname.split('/servers/')[1]!.split('/versions/')[0]!) } });
      },
    });
  onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); nav.reset(); });
  nav.reset();
  nav.setParams({ view: 'kind', kind: 'mcpServer', selection: JSON.stringify(reference) });
  detailsPane.available = true;
  let sourcesReady = false;
  function SourceReadiness() { sourcesReady = useRegistrySources(undefined).hasValue; return null; }
  // Route-module loading is asynchronous in the real workspace. The old pane must leave before the new body mounts.
  const tree = (visible: boolean, listingReady = false) => <><SourceReadiness /><PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}>
    <AppPaneProvider><Harness nativeListing nativeListingReady={listingReady} retainedDirectory /></AppPaneProvider>
  </PluginSurfaceFocusEligibilityProvider></>;
  const screen = await renderScreen(tree(false));
  const measureEnv = async () => act(async () => {
    let node = screen.findByTestId('mcp.add.env.row.0');
    while (node && typeof node.props.onLayout !== 'function') node = node.parent;
    expect(node).not.toBeNull();
    node!.props.onLayout({ nativeEvent: { layout: { width: 900, height: 100 } } });
  });
  await waitForHomeGovernance(() => expect(sourcesReady).toBe(true));
  await flushHookEffects();
  expect(registryReads).toHaveLength(0);
  await screen.update(tree(true));
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  // The pane names the kind; the listing's own header names the item (ede9ea79cf8).
  expect(screen.findByTestId('store.kind.mcpServer.detailPane.header.title')?.props.children).toBe('capabilities.store.kindWord.mcpServer');
  expect(screen.getTextContent()).toContain('Regional tool');
  await measureEnv();
  await act(async () => { screen.findAll(node => node.props?.testID === 'mcp.add.env.row.0.type' && typeof node.props.onSelect === 'function')[0]!.props.onSelect('literal'); });
  const field = 'mcp.add.env.row.0.value';
  await waitForHomeGovernance(() => expect(screen.findHostByTestId(field)).not.toBeNull());
  await act(async () => { screen.findHostByTestId(field)!.props.onChangeText('europe-west'); });
  expect(screen.findHostByTestId(field)!.props.value).toBe('europe-west');
  await press(screen, 'store.kind.mcpServer.detailPane.openAsPage');
  expect(nav.top().pathname).toBe('/(app)/plugins/listing');
  expect(typeof nav.top().params.continuation).toBe('string');
  expect(JSON.stringify(nav.top().params)).not.toContain('europe-west');
  await flushHookEffects();
  expect(screen.findHostByTestId(field)).toBeNull();
  await screen.update(tree(true, true));
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  await measureEnv();
  await waitForHomeGovernance(() => expect(screen.findHostByTestId(field)?.props.value).toBe('europe-west'));
  // Back keeps the originating review alive; another native selection and explicit Cancel start fresh reviews.
  await act(async () => { nav.back(); });
  await act(async () => { nav.setParams({ selection: JSON.stringify(reference) }); });
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  await measureEnv();
  expect(screen.findHostByTestId(field)?.props.value).toBe('europe-west');
  await act(async () => { nav.setParams({ selection: JSON.stringify({ ...reference, itemId: 'example/other' }) }); });
  // The web identifier's middle-ellipsis spans are separate text nodes in this renderer.
  await waitForHomeGovernance(() => expect(screen.getTextContent()).toMatch(/example\s*\/other/));
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  await measureEnv();
  expect(screen.findHostByTestId(field)?.props.value).toBeUndefined();
  await act(async () => { nav.setParams({ selection: JSON.stringify(reference) }); });
  await waitForHomeGovernance(() => expect(screen.getTextContent()).toMatch(/example\s*\/region/));
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  await measureEnv();
  expect(screen.findHostByTestId(field)?.props.value).toBeUndefined();
  await act(async () => { screen.findAll(node => node.props?.testID === 'mcp.add.env.row.0.type' && typeof node.props.onSelect === 'function')[0]!.props.onSelect('literal'); });
  await act(async () => { screen.findHostByTestId(field)!.props.onChangeText('non-native-private'); });
  await act(async () => { nav.setParams({ selection: JSON.stringify({ ...reference, kind: 'skill', itemId: 'example/skill' }) }); });
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).toBeNull());
  await act(async () => { nav.setParams({ selection: JSON.stringify(reference) }); });
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  await measureEnv();
  expect(screen.findHostByTestId(field)?.props.value).toBeUndefined();
  await act(async () => { screen.findAll(node => node.props?.testID === 'mcp.add.env.row.0.type' && typeof node.props.onSelect === 'function')[0]!.props.onSelect('literal'); });
  await act(async () => { screen.findHostByTestId(field)!.props.onChangeText('discarded-review'); });
  await press(screen, 'store.kind.mcpServer.detailPane.header.close');
  await act(async () => { nav.setParams({ selection: JSON.stringify(reference) }); });
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  await measureEnv();
  expect(screen.findHostByTestId(field)?.props.value).toBeUndefined();
  // The active Account retires while neither native pane nor lazy page body is mounted.
  await act(async () => { screen.findAll(node => node.props?.testID === 'mcp.add.env.row.0.type' && typeof node.props.onSelect === 'function')[0]!.props.onSelect('literal'); });
  await act(async () => { screen.findHostByTestId(field)!.props.onChangeText('scope-private'); });
  await screen.update(tree(true, false));
  await press(screen, 'store.kind.mcpServer.detailPane.openAsPage');
  await flushHookEffects();
  expect(screen.findHostByTestId(field)).toBeNull();
  const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
  await act(async () => { retireActiveServerAccountScopeLifetime(); });
  await screen.update(tree(true, true));
  await waitForHomeGovernance(() => expect(screen.findByTestId('mcp.add.env.row.0')).not.toBeNull());
  await measureEnv();
  expect(screen.findHostByTestId(field)?.props.value).toBeUndefined();
});

const selected = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
  const label = screen.findHostByTestId('route.selection')!.props
    .accessibilityLabel as string;
  return label ? JSON.parse(label) : null;
};

it('opens a Discover item as its listing beside the page on a wide window, and Back returns to the job it came from', async () => {
  detailsPane.available = true;
  const { screen, reference } = await renderDiscoverWithOneJob();
  // Store → Discover (the default page) → Browse by job → the job.
  // A lone job uses the shared shelf's catalog row (RegistryShelf, 8e153aa1c91), not a measured card grid.
  await press(screen, `store.discover.jobs.${JSON.stringify([HAPPIER_PICKS_SOURCE_ID, 'review'])}.row`);
  expect(nav.top().params).toMatchObject({ view: 'job', job: 'review' });
  // The job's choice opens its exact listing in the pane: the page stays, the route names the selection.
  await press(screen, 'store.job.groups.review-skill');
  await waitForHomeGovernance(() =>
    expect(selected(screen)).toEqual(reference),
  );
  expect(nav.top().params).toMatchObject({ view: 'job', job: 'review' });
  expect(nav.top().pathname).toBe('/plugins');
  expect(
    screen.findAllHostsByTestId('store.job.detailPane').length,
  ).toBeGreaterThan(0);
  // Closing the pane keeps the job page where it was; Back from the job returns to Discover.
  await act(async () => {
    nav.setParams({ selection: undefined });
  });
  expect(selected(screen)).toBeNull();
  expect(
    screen.findAllHostsByTestId('store.job.groups').length,
  ).toBeGreaterThan(0);
  await act(async () => {
    nav.back();
  });
  expect(nav.top().params).toEqual({});
  await waitForHomeGovernance(() =>
    expect(
      screen.findAllHostsByTestId(`store.discover.jobs.${JSON.stringify([HAPPIER_PICKS_SOURCE_ID, 'review'])}.row`).length,
    ).toBeGreaterThan(0),
  );
});

it('pushes a Discover item as its own listing page where no pane fits, and Back returns to the same job', async () => {
  detailsPane.available = false;
  const { screen, reference } = await renderDiscoverWithOneJob();
  // A lone job uses the shared shelf's catalog row (RegistryShelf, 8e153aa1c91), not a measured card grid.
  await press(screen, `store.discover.jobs.${JSON.stringify([HAPPIER_PICKS_SOURCE_ID, 'review'])}.row`);
  await press(screen, 'store.job.groups.review-skill');
  expect(nav.top().pathname).toBe('/(app)/plugins/listing');
  expect(JSON.parse(nav.top().params.selection!)).toEqual(reference);
  await waitForHomeGovernance(() =>
    expect(screen.findAllHostsByTestId('route.listing').length).toBeGreaterThan(
      0,
    ),
  );
  await act(async () => {
    nav.back();
  });
  expect(nav.top().params).toMatchObject({ view: 'job', job: 'review' });
  await waitForHomeGovernance(() =>
    expect(
      screen.findAllHostsByTestId('store.job.groups.review-skill').length,
    ).toBeGreaterThan(0),
  );
});

it('opens the Store as a main screen: no Back or bar title, its own title row whose search icon opens the field', async () => {
  const { screen } = await renderDiscoverWithOneJob();
  await waitForHomeGovernance(() => expect(screen.findAllHostsByTestId('store.discover.searchToggle').length).toBeGreaterThan(0));
  // The tab bar is a main screen's way around (owner 11-10): no bar, no Back; the page's title row names the Store.
  expect(nav.stackOptions.at(-1)).toMatchObject({ headerShown: false });
  expect(screen.findAllByProps({ testID: 'store.discover.header' })[0]?.props.title).toBe('settingsPlugins.surfaces.storeTitle');
  expect(screen.findAllHostsByTestId('store.discover.search')).toHaveLength(0);
  await act(async () => { screen.findAllHostsByTestId('store.discover.searchToggle')[0]!.props.onPress?.(); });
  expect(screen.findAllHostsByTestId('store.discover.search').length).toBeGreaterThan(0);
});

it('hands a submitted query to Search and leaves the retained Discover field empty', async () => {
  const { screen } = await renderDiscoverWithOneJob();
  // `pushRetainingCurrent` keeps this Discover instance mounted under Search; render it alone so it stays mounted too.
  await screen.update(<NavigationContext.Provider value={createNavigationPropMock({ isFocused: () => true })}>
    <PluginSurfaceFocusEligibilityProvider active presentationActive>
      <AppPaneProvider><StoreDiscoverPage project={null} /></AppPaneProvider>
    </PluginSurfaceFocusEligibilityProvider>
  </NavigationContext.Provider>);
  const field = () => screen.findAllHostsByTestId('store.discover.search').find(node => typeof node.props.onChangeText === 'function')!;
  await waitForHomeGovernance(() => expect(screen.findAllHostsByTestId('store.discover.searchToggle').length).toBeGreaterThan(0));
  await act(async () => { screen.findAllHostsByTestId('store.discover.searchToggle')[0]!.props.onPress?.(); });
  await waitForHomeGovernance(() => expect(field()).toBeDefined());
  await act(async () => { field().props.onChangeText('goose'); });
  expect(field().props.value).toBe('goose');
  await act(async () => { field().props.onSubmitEditing?.({ nativeEvent: { text: 'goose' } }); });
  expect(nav.top().params).toMatchObject({ view: 'search', q: 'goose' });
  expect(field().props.value).toBe('');
});
