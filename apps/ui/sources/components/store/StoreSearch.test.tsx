import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import type { StoreSearchState } from './StoreSearch';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { CompactSearchField } = await import('@/components/ui/forms/CompactSearchField');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { View } = await import('react-native');
const { StoreSearch } = await import('./StoreSearch');
const { storeEditorialGroupKey } = await import('./catalog/storeColumnAdapter');

it('binds native Software job and category membership by exact choice rather than title', async () => {
    const { MarketplaceCatalogDiscoveryV1Schema } = await import('@happier-dev/protocol/marketplace');
    const { storeRowFacts } = await import('./catalog/storeColumnAdapter');
    const { softwareSummary } = await import('./catalog/storeSoftware');
    const value = { kind: 'toolchain', adapterId: 'mise', tool: 'python' } as const;
    const discovery = MarketplaceCatalogDiscoveryV1Schema.parse({
        items: [{ id: 'python', title: 'Python', reference: { type: 'software', value } }],
        categories: [{ id: 'development', title: 'Development', items: ['python'] }],
        jobs: [{ id: 'develop', title: 'Develop', description: 'Development tools', glyph: 'fcCode',
            groups: [{ title: 'Runtime', items: ['python'] }] }],
    });
    const rows = [value, { ...value, tool: 'node' as const }].map(choice => ({
        kind: 'software' as const, key: choice.tool, summary: softwareSummary({ value: choice, label: 'Same title' }),
    }));
    const facts = storeRowFacts(rows, [{ sourceId: 'curated', discovery }], true);
    expect(facts[0]?.fields).toMatchObject({ category: [storeEditorialGroupKey('curated', 'development')],
        job: [storeEditorialGroupKey('curated', 'develop')] });
    expect(facts[1]?.fields).toMatchObject({ category: [], job: [] });
});

const fields = Object.fromEntries(['kind', 'source', 'category', 'job'].map(id =>
    [id, { label: id, valueLabel: (value: string) => value }])) as Record<
        'kind' | 'source' | 'category' | 'job', { label: string; valueLabel: (value: string) => string }>;

it('filters Apps by declared database category without matching database words in unrelated apps', async () => {
    const serverUrl = 'https://store-database-category.test';
    const sourceId = 'database-catalog';
    const requests: string[] = [];
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{
            id: sourceId, title: 'Service templates', url: `${serverUrl}/service-templates.json`,
            kinds: ['app'], format: 'coolify-templates', enabled: true, addedAt: 1,
        }] },
    }, 'updated', { handleRequest: async path => {
        requests.push(path);
        return path === '/service-templates.json' ? Response.json({
            autobase: { slogan: 'PostgreSQL management', category: 'database' },
            'redis-insight': { slogan: 'Redis tools', category: 'database,observability,developer-tools' },
            wordpress: { slogan: 'A website with a database', category: 'cms', tags: ['database'] },
        }) : null;
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    let current!: StoreSearchState;
    const screen = await renderScreen(<StoreSearch kind="app" demand={{ presented: true }} sourceIds={[sourceId]}
        fields={fields} curationComplete initialFilters={{ category: { include: ['database'], exclude: [] } }}>
        {state => { current = state; return null; }}
    </StoreSearch>);
    await waitForHomeGovernance(() => expect(current.lists.app?.items).toHaveLength(3));
    expect(current.rows.map(row => 'itemId' in row ? row.itemId : null)).toEqual(['autobase', 'redis-insight']);
    expect(current.query).toBe('');
    await act(async () => current.filter.setFilters({}));
    expect(current.rows).toHaveLength(3);
    // Category filtering uses metadata already read for the directory, never template bodies.
    expect(requests.some(path => /\.ya?ml$/.test(path))).toBe(false);
    await screen.unmount();
});

it('lets human and agent compose the same Store narrowing, refuses hidden/ambiguous/retired owners and preserves qualified matches', async () => {
    const serverUrl = 'https://store-mounted-search.test';
    const catalogs = ['one', 'two'].map(id => createRegistryPluginCatalogFixture({
        sourceUrl: `${serverUrl}/${id}.json`, entries: [{ pluginId: 'sample.shared', title: 'Shared tool' }],
    }));
    const requests: string[] = [];
    let failSecond = false;
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: catalogs.map(catalog => ({
            id: catalog.source.id, title: catalog.source.title, url: catalog.source.sourceUrl,
            kinds: ['plugin'], format: 'happier-catalog', enabled: true, addedAt: 1,
        })) },
    }, 'updated', { handleRequest: async path => {
        const catalog = catalogs.find(candidate => new URL(candidate.source.sourceUrl).pathname === path);
        if (!catalog) return null;
        requests.push(path);
        if (failSecond && path === '/two.json') return new Response(null, { status: 503 });
        return Response.json(catalog);
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const machines = Array.from({ length: 128 }, (_, index) => createMachineFixture({ id: `held-${index}` }));
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [fixture.home.id]: machines } });
    const sourceId = catalogs[0]!.source.id;
    const category = storeEditorialGroupKey(sourceId, 'browser');
    const job = storeEditorialGroupKey(sourceId, 'browse');
    const curation = [{ sourceId, discovery: { items: [{ id: 'shared', title: 'Shared tool', reference: {
        type: 'registryItem' as const, kind: 'plugin' as const, sourceId, itemId: 'sample.shared', version: '1.2.3',
    } }], categories: [{ id: 'browser', title: 'Browser', items: ['shared'] }],
    jobs: [{ id: 'browse', title: 'Browse', description: 'Use a browser', glyph: 'globe',
        groups: [{ title: 'Choices', items: ['shared'] }] }] } }];
    let current!: StoreSearchState;
    const render = (state: StoreSearchState) => {
        current = state;
        return <><CompactSearchField testID="store.query" value={state.query} onChangeText={state.setQuery} placeholder="Search" />
            {state.rows.map(native => {
                const row = state.projections.get(native)!;
                return <View key={row.key} testID={`store.result.${row.key}`} accessibilityLabel={row.summary.title} />;
            })}</>;
    };
    const tree = (presented: boolean, statedFields?: readonly ('kind' | 'source' | 'category' | 'job')[]) =>
        <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
        <StoreSearch kind="plugin" demand={{ presented }} sourceIds={catalogs.map(catalog => catalog.source.id)}
            fields={fields} curation={curation} curationComplete {...(statedFields ? { statedFields } : {})}>{render}</StoreSearch>
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(tree(true));
    const executor = createDefaultActionExecutor();
    const scope = storage.getState().settingsScope!;
    const target = { column: 'store' as const, ...scope };
    const context = { surface: 'agent' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId };
    const set = (filters: StoreSearchState['filter']['filters'], searchQuery?: string) => executor.execute(
        'settings.column.filter.set', { ...target, filters, ...(searchQuery === undefined ? {} : { searchQuery }) }, context);
    const condition = (value: string) => ({ include: [value], exclude: [] });
    const keys = () => current.rows.map(row => current.projections.get(row)!.key);
    await waitForHomeGovernance(() => expect(current.rows).toHaveLength(2));
    expect(new Set(keys()).size).toBe(2);
    const selected = { category: condition(category), job: condition(job), kind: condition('plugin'), source: condition(sourceId) };
    const beforeNarrow = requests.length;
    await act(async () => { current.filter.setFilters(selected); });
    await act(async () => screen.findHostByTestId('store.query')!.props.onChangeText('Shared'));
    await waitForHomeGovernance(() => expect(current.rows).toHaveLength(1));
    // A page control that already states the kind (the search page's kind segment) leaves it out of the tokens,
    // while the condition still narrows: one indicator per condition.
    expect(current.filter.conditionWords.split(', ')).toContain('plugin');
    await screen.update(tree(true, ['kind']));
    expect(current.filter.conditionWords.split(', ')).not.toContain('plugin');
    expect(current.filter.conditionWords.split(', ')).toContain(sourceId);
    expect(current.rows).toHaveLength(1);
    await screen.update(tree(true));
    await waitForHomeGovernance(() => expect(current.lists.plugin?.loading).toBe(false));
    expect(requests.slice(beforeNarrow)).toContain('/one.json');
    expect(requests.slice(beforeNarrow)).not.toContain('/two.json');
    const expected = keys();
    expect(current.rows[0]).toMatchObject({ sourceId, itemId: 'sample.shared', version: '1.2.3' });
    expect(screen.findHostByTestId(`store.result.${expected[0]}`)).not.toBeNull();
    await act(async () => { expect(await set({}, '')).toMatchObject({ ok: true }); });
    await act(async () => { expect(await set({ source: selected.source, kind: selected.kind }, 'Shared')).toMatchObject({ ok: true }); });
    await act(async () => { expect(await set(selected)).toMatchObject({ ok: true }); });
    await waitForHomeGovernance(() => expect(keys()).toEqual(expected));
    expect(screen.findHostByTestId('store.query')!.props.value).toBe('Shared');
    await act(async () => { expect(await set({ ...selected, category: undefined })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' }); });
    const { category: _category, ...withoutCategory } = selected;
    await act(async () => { expect(await set(withoutCategory)).toMatchObject({ ok: true }); });
    expect(current.filter.filters).toEqual(withoutCategory);
    expect(current.query).toBe('Shared');
    await act(async () => { await executor.execute('settings.column.filter.clear', target, context); });
    await waitForHomeGovernance(() => expect(current.rows).toHaveLength(2));
    expect(current.query).toBe('Shared');
    expect((await executor.execute('settings.column.filter.get', target, context))).toMatchObject({ ok: true,
        result: { searchQuery: 'Shared', filters: {}, matchedCount: 2 } });
    const beforeRefresh = current.rows;
    let beforeRequests = requests.length;
    await act(async () => { current.lists.plugin!.refresh(); });
    await waitForHomeGovernance(() => expect(requests.length).toBeGreaterThan(beforeRequests));
    await waitForHomeGovernance(() => expect(current.lists.plugin?.loading).toBe(false));
    expect(current.rows.filter((row, index) => row !== beforeRefresh[index])).toHaveLength(0);
    catalogs[0]!.entries[0]!.display.title = 'Shared changed';
    beforeRequests = requests.length;
    await act(async () => { current.lists.plugin!.refresh(); });
    await waitForHomeGovernance(() => expect(requests.length).toBeGreaterThan(beforeRequests));
    await waitForHomeGovernance(() => expect(current.lists.plugin?.items[0]?.title).toBe('Shared changed'));
    expect(current.rows.filter((row, index) => row !== beforeRefresh[index])).toHaveLength(1);
    failSecond = true;
    await act(async () => { current.lists.plugin!.refresh(); });
    await waitForHomeGovernance(() => expect(current.filter.result.coverage).toBe('partial'));
    await waitForHomeGovernance(() => expect(current.lists.plugin?.loading).toBe(false));
    expect(current.rows).toHaveLength(2);
    expect(await executor.execute('settings.column.filter.get', target, context)).toMatchObject({ ok: true,
        result: { matchedCount: 2, coverage: 'partial' } });
    // A new failed query cannot borrow retained rows from the previous query;
    // identical zero rows mean incomplete coverage until that source recovers.
    await act(async () => { current.setQuery('no matching documentation'); });
    await waitForHomeGovernance(() => expect(current.lists.plugin?.loading).toBe(false));
    await waitForHomeGovernance(() => expect(current.rows).toHaveLength(0));
    expect(current.filter.result.coverage).toBe('partial');
    expect(current.lists.plugin?.sourceStatuses.find(source => source.id === catalogs[1]!.source.id)?.freshness).not.toBe('fresh');
    failSecond = false;
    await act(async () => { current.lists.plugin!.refresh(); });
    await waitForHomeGovernance(() => expect(current.filter.result.coverage).toBe('complete'));
    expect(current.rows).toHaveLength(0);
    await act(async () => { current.setQuery('Shared'); });
    await waitForHomeGovernance(() => expect(current.rows).toHaveLength(2));
    const beforeHide = requests.length;
    await screen.update(tree(false));
    expect(await set(selected)).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    expect(requests).toHaveLength(beforeHide);
    await screen.update(<>{tree(true)}{tree(true)}</>);
    expect(await set(selected)).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    await screen.update(tree(true));
    expect(await executor.execute('settings.column.filter.get', { ...target, accountId: 'retired' }, context))
        .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    await screen.unmount();
    expect(await set(selected)).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
});
