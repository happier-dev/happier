import { expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks, promptRegistriesRouterPushSpy } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
// Screen size is the environment boundary that decides pane or push.
const device = vi.hoisted(() => ({ type: 'tablet' as 'phone' | 'tablet' }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useDeviceType: () => device.type,
}));
const { getResolvedAgentCatalogEntries } = await import('@/agents/backendCatalog/agentCatalogProjection');
const { createAgentSettingsRoute } = await import('@/agents/catalog/agentSettingsRoutes');
const { useStoreOpenReference } = await import('./useStoreOpenReference');
const { useBuiltInAgentRows } = await import('../StoreKindPage');
const { Modal } = await import('@/modal');

it('opens a curated Software choice through the native listing without a fabricated Machine or package', async () => {
    const { useStoreListingSelection } = await import('../StoreListing');
    const { usePluginsOpenItem } = await import('@/components/settings/plugins/model/usePluginsOpenItem');
    const hook = await renderHook(() => ({ open: useStoreOpenReference(), selected: useStoreListingSelection(),
        close: usePluginsOpenItem().closeStore }));
    const reference = { type: 'software', value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' } } as const;
    try {
        await act(async () => { hook.getCurrent().open(reference); });
        expect(hook.getCurrent().selected).toEqual(reference);
    } finally {
        await act(async () => { hook.getCurrent().close(); });
        await hook.unmount(); standardCleanup();
    }
});

it.each(['skill', 'agent'] as const)('opens an unpinned %s at its exact source/item, without a title search', async kind => {
    const hook = await renderHook(useStoreOpenReference);
    try {
        vi.mocked(Modal.show).mockClear();
        await act(async () => { hook.getCurrent()({ type: 'registryItem', kind, sourceId: 'source:one', itemId: 'exact/id' }); });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            params: expect.objectContaining({ initialSelection: { sourceId: 'source:one', itemId: 'exact/id' } }),
        }) }));
    } finally { await hook.unmount(); standardCleanup(); }
});

it('keeps every currently admitted built-in declaration browsable', async () => {
    const entries = getResolvedAgentCatalogEntries({ enabledAgentIds: [] });
    expect(entries.length).toBeGreaterThan(0);
    const hook = await renderHook(() => useBuiltInAgentRows(entries));
    try {
        expect(hook.getCurrent().map(row => row.key)).toEqual(entries.map(entry => `agent|${entry.qualifiedId}`));
        const entry = entries[0]!;
        const row = hook.getCurrent().find(candidate => candidate.key === `agent|${entry.qualifiedId}`)!;
        promptRegistriesRouterPushSpy.mockClear();
        await act(async () => { row.open(); });
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(createAgentSettingsRoute(entry));
    } finally { await hook.unmount(); standardCleanup(); }
});

it('opens an agentContribution at its exact catalog-owned Settings route and keeps unknown targets unavailable', async () => {
    const entry = getResolvedAgentCatalogEntries({ enabledAgentIds: [] }).find(candidate => candidate.backendTargetKey !== null)!;
    const hook = await renderHook(useStoreOpenReference);
    try {
        promptRegistriesRouterPushSpy.mockClear();
        await act(async () => { hook.getCurrent()({ type: 'agentContribution', targetKey: entry.backendTargetKey! }); });
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledExactlyOnceWith(createAgentSettingsRoute(entry));
        promptRegistriesRouterPushSpy.mockClear();
        await act(async () => { hook.getCurrent()({ type: 'agentContribution', targetKey: 'agent:unknown.plugin/unknown' }); });
        expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
    } finally { await hook.unmount(); standardCleanup(); }
});

it('opens a directory row as its exact listing beside the page and keeps the + on the kind\'s own Add owner (S40 §4.5)', async () => {
    const { useOpenRegistryItem, useAddRegistryItem } = await import('../StoreKindPage');
    const { useStoreListingSelection } = await import('../StoreListing');
    const { usePluginsOpenItem } = await import('@/components/settings/plugins/model/usePluginsOpenItem');
    const hook = await renderHook(() => ({ open: useOpenRegistryItem(), add: useAddRegistryItem(), selected: useStoreListingSelection(),
        closeStore: usePluginsOpenItem().closeStore }));
    const item = { kind: 'mcpServer', sourceId: 'source:one', itemId: 'exact/id', version: '1.0.0', title: 'Duplicate title' } as never;
    try {
        vi.mocked(Modal.show).mockClear();
        promptRegistriesRouterPushSpy.mockClear();
        await act(async () => { hook.getCurrent().open(item); });
        // A pane fits beside the page here: the route's selection names the exact item; nothing is pushed or added.
        expect(hook.getCurrent().selected).toEqual({ type: 'registryItem', kind: 'mcpServer', sourceId: 'source:one',
            itemId: 'exact/id', version: '1.0.0' });
        expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
        expect(Modal.show).not.toHaveBeenCalled();
        await act(async () => { hook.getCurrent().add(item); });
        expect(Modal.show).toHaveBeenCalledTimes(1);
    } finally {
        // The route's selection outlives the hook; later cases start from a page with nothing selected.
        await act(async () => { hook.getCurrent().closeStore(); });
        await hook.unmount(); standardCleanup();
    }
});

it('pushes a curated choice\'s Store listing as its own page on a phone, never a pane selection (TASTE-S4060 D15)', async () => {
    const { buildStoreListingRoute } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
    const { useStoreListingSelection } = await import('../StoreListing');
    device.type = 'phone';
    const hook = await renderHook(() => ({ open: useStoreOpenReference(), selected: useStoreListingSelection() }));
    const reference = { type: 'registryItem', kind: 'plugin', sourceId: 'source:one', itemId: 'exact/id' } as const;
    try {
        promptRegistriesRouterPushSpy.mockClear();
        await act(async () => { hook.getCurrent().open(reference); });
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledExactlyOnceWith(buildStoreListingRoute(reference, null));
        expect(hook.getCurrent().selected).toBeNull();
    } finally { device.type = 'tablet'; await hook.unmount(); standardCleanup(); }
});

it('presents a selection that arrives on a phone as the pushed listing page, and clears it from the page (TASTE-S4060 D15)', async () => {
    const React = await import('react');
    const { renderScreen } = await import('@/dev/testkit');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { buildStoreListingRoute } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
    const { usePluginsOpenItem } = await import('@/components/settings/plugins/model/usePluginsOpenItem');
    const { StoreListingPaneHost } = await import('../StoreListing');
    const reference = { type: 'registryItem', kind: 'plugin', sourceId: 'source:one', itemId: 'exact/id' } as const;
    const seen: unknown[] = [];
    function Probe() { const { storeOpenItem, openStore } = usePluginsOpenItem(); seen.push(storeOpenItem);
        React.useEffect(() => { openStore(reference); }, []); return null; }
    device.type = 'phone';
    promptRegistriesRouterPushSpy.mockClear();
    try {
        const screen = await renderScreen(<AppPaneProvider><StoreListingPaneHost title="Discover" testID="t"><Probe /></StoreListingPaneHost></AppPaneProvider>);
        await act(async () => {});
        const route = buildStoreListingRoute(reference, null);
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.objectContaining({ pathname: route.pathname,
            params: expect.objectContaining({ selection: route.params.selection }) }));
        expect(seen.at(-1)).toBeNull();
        expect(screen.findAllByTestId('t.detailPane.openAsPage')).toHaveLength(0);
    } finally { device.type = 'tablet'; standardCleanup(); }
});

it('folds a registry row that names a built-in Agent into that built-in, keeping its outcome line', async () => {
    const { linkBuiltInAgentRegistryRows } = await import('./storeKinds');
    const entries = getResolvedAgentCatalogEntries({ enabledAgentIds: [] });
    const linked = entries.find(entry => (entry.acpRegistryIds?.length ?? 0) > 0)!;
    const duplicate = { sourceId: 'acp', kind: 'agent', itemId: linked.acpRegistryIds![0]!, title: `${linked.title} CLI`,
        description: 'Writes and reviews code in your terminal.' } as const;
    const other = { sourceId: 'acp', kind: 'agent', itemId: 'not-built-in', title: 'Amp', description: 'A coding agent.' } as const;
    const items = linkBuiltInAgentRegistryRows(entries, [duplicate, other]);
    expect(items.filter(item => 'itemId' in item)).toEqual([other]);
    const hook = await renderHook(() => useBuiltInAgentRows(items));
    try {
        const row = hook.getCurrent().find(candidate => candidate.key === `agent|${linked.qualifiedId}`)!;
        expect(row.description).toBe('Writes and reviews code in your terminal.');
    } finally { await hook.unmount(); standardCleanup(); }
});

it('never restates a built-in Agent name or channel as its description', async () => {
    const entries = getResolvedAgentCatalogEntries({ enabledAgentIds: [] });
    const hook = await renderHook(() => useBuiltInAgentRows(entries));
    try {
        for (const entry of entries) {
            const row = hook.getCurrent().find(candidate => candidate.key === `agent|${entry.qualifiedId}`)!;
            if (entry.subtitle) expect(row.description).not.toBe(entry.subtitle);
        }
        const codex = entries.find(entry => entry.identity?.pluginId === 'happier.agent.codex');
        if (codex) expect(hook.getCurrent().find(row => row.key === `agent|${codex.qualifiedId}`)!.description)
            .toBe('OpenAI Codex coding agent.');
    } finally { await hook.unmount(); standardCleanup(); }
});
