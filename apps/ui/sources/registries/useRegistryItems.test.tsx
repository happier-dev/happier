import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { MarketplaceIndexSourceSnapshotV1Schema, deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { HAPPIER_PICKS_SOURCE_ID, registryMarketplaceSourceV1, createRegistryHostV1,
    REGISTRY_ACTION_INPUT_SCHEMAS_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, projectPluginRegistrySourceDeclarationV1, type RegistrySourceV1 } from '@happier-dev/protocol/registries';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';
import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createRegistryNpmPackageFixture, createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } from '@happier-dev/protocol/marketplace';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createUiRegistryHttpV1 } from './registryHttpV1';

const platform = vi.hoisted(() => ({ value: 'web', width: 1440 }));
const confirmation = vi.hoisted(() => ({ accepted: true }));
installPromptRegistriesCommonModuleMocks({ storage: original => original(), reactNative: async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { get OS() { return platform.value; } },
        useWindowDimensions: () => ({ width: platform.width, height: 900, scale: 1, fontScale: 1 }) }), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { confirm: vi.fn(async () => confirmation.accepted) },
    }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
// Load the fixture's runtime graph at collection, without admitting a Home or
// writing credentials before Vitest installs its per-case storage boundary.
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const [{ useRegistryItems }, { useRegistrySourceMutations }, { useRegistrySuggestions, useRegistryCuration }, { useRegistryItem }] = await Promise.all([
    import('./useRegistryItems'), import('./useRegistrySourceMutations'), import('./useRegistrySuggestions'),
    import('./useRegistryItem'),
]);
const [{ usePluginCatalog }, { usePromptLibraryCatalogValue }] = await Promise.all([
    import('@/components/settings/plugins/model/usePluginCatalog'), import('@/sync/store/usePromptLibraryCatalog'),
]);
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useRegistrySourceRevision, useRegistrySourceDescriptor } = await import('./useRegistrySourceRevision');
const { projectPluginRegistrySources } = await import('./pluginRegistrySources');
const { useRegistrySources } = await import('./useRegistrySources');
const { useSourceTitle } = await import('@/components/store/StoreKindPage');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const actionFrontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
type ShellValue = import('@/components/appShell/plugins/AppShellPluginUiProjection').AppShellPluginUiProjectionValue;
const { storage } = await import('@/sync/domains/state/storageStore');
const { SkillsHomepage } = await import('@/components/settings/skills/SkillsHomepage');
const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
const { McpServersHome, McpServersEmpty } = await import('@/components/settings/mcpServers/home/McpServersHome');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { getPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue, beginPromptLibraryCatalogRowsLoad,
    applyPromptLibraryCatalogRowsSnapshot, applyPromptLibraryCatalogAcknowledgedRecord, beginPromptLibraryCatalogLoad,
    applyPromptLibraryCatalogSnapshot } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

async function setupHome(suffix: string, entries?: Parameters<typeof createRegistryPluginCatalogFixture>[0]['entries']) {
    const serverUrl = `https://registry-refresh-${suffix}.test`;
    const sourceUrl = `${serverUrl}/catalog.json`;
    const sourceId = deriveMarketplaceSourceId(sourceUrl);
    const catalog = createRegistryPluginCatalogFixture({ sourceUrl, entries });
    let unavailable = false;
    let rateLimited = false;
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Private catalog',
            format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
    }, 'updated', { handleRequest: async path => path === '/catalog.json'
        ? rateLimited ? new Response(null, { status: 429 })
            : unavailable ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(catalog) : null });
    onTestFailed(() => { console.error('Registry read Home requests:', JSON.stringify(fixture.requests)); });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    return { fixture, sourceId, catalog, setUnavailable: () => { unavailable = true; }, setRateLimited: (next: boolean) => { rateLimited = next; } };
}

async function setup(suffix: string, refresh = true) {
    const { fixture, sourceId, setUnavailable } = await setupHome(suffix);
    const hook = await renderHook(({ query }: { query: string }) => {
        const mutations = useRegistrySourceMutations();
        return { ...useRegistryItems({ kind: 'plugin', sourceIds: [sourceId], query }), available: mutations.ready, mutations };
    }, { initialProps: { query: 'Sample' } });
    await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
    expect(hook.getCurrent().error).toBeNull();
    expect(hook.getCurrent().pages).toEqual([expect.objectContaining({ sourceId, status: expect.objectContaining({ state: 'ok' }) })]);
    expect(hook.getCurrent().items).toContainEqual(expect.objectContaining({ sourceId, itemId: 'sample.plugin', version: '1.2.3' }));
    const lastKnown = hook.getCurrent().items;
    setUnavailable();
    if (refresh) await act(async () => { await hook.getCurrent().refresh(); });
    return { fixture, hook, sourceId, lastKnown };
}

describe('registry item last-known reads through the Account and HTTP owners', () => {
    it('retries only the failed source and retains the healthy source page', async () => {
        const serverUrl = 'https://registry-source-only-retry.test';
        const healthyUrl = `${serverUrl}/healthy.json`;
        const failedUrl = `${serverUrl}/failed.json`;
        const healthyId = deriveMarketplaceSourceId(healthyUrl);
        const failedId = deriveMarketplaceSourceId(failedUrl);
        const healthy = createRegistryPluginCatalogFixture({ sourceUrl: healthyUrl });
        const recovered = createRegistryPluginCatalogFixture({ sourceUrl: failedUrl });
        const requests: string[] = [];
        let failed = true;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [
                { id: healthyId, title: 'Healthy', format: 'happier-catalog', kinds: ['plugin'], url: healthyUrl, enabled: true, addedAt: 1 },
                { id: failedId, title: 'Recovering', format: 'happier-catalog', kinds: ['plugin'], url: failedUrl, enabled: true, addedAt: 1 },
            ] },
        }, 'updated', { handleRequest: async path => {
            if (path !== '/healthy.json' && path !== '/failed.json') return null;
            requests.push(path);
            return path === '/healthy.json' ? Response.json(healthy)
                : failed ? new Response(null, { status: 503 }) : Response.json(recovered);
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [healthyId, failedId] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        const held = hook.getCurrent().pages.find(page => page.sourceId === healthyId);
        expect(hook.getCurrent().sourceFailures).toHaveLength(1);
        expect(requests).toEqual(['/healthy.json', '/failed.json']);
        failed = false;
        await act(async () => { await hook.getCurrent().sourceFailures[0]!.onRetry(); });
        expect(hook.getCurrent().sourceFailures).toEqual([]);
        expect(hook.getCurrent().pages.find(page => page.sourceId === healthyId)).toBe(held);
        expect(hook.getCurrent().items.filter(item => item.sourceId === failedId)).toHaveLength(recovered.entries.length);
        expect(requests).toEqual(['/healthy.json', '/failed.json', '/failed.json']);
    });
    it('keeps starter selection resolving until plugin sources answer', async () => {
        await setupHome('plugin-sources-pending');
        let shell: ShellValue = { pluginUiProjection: null, pluginBrowserProjection: null,
            phase: 'establishing', interactionEnabled: false, machineId: null, serverId: null, platform: 'web', accountLifetime: null,
            reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(AppShellPluginUiProjectionValueProvider, { value: shell, children });
        const hook = await renderHook(() => useRegistryItems({ kind: 'starter' }), { wrapper });
        await waitForHomeGovernance(() => expect(getPromptLibraryCatalogValue(storage.getState().settingsScope!, 'registry-sources').status).toBe('ready'));
        await flushHookEffects();
        expect(hook.getCurrent().loading).toBe(true);
        expect(hook.getCurrent().hasValue).toBe(false);
        shell = { ...shell, phase: 'current', interactionEnabled: true, pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION };
        await hook.rerender();
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().hasValue).toBe(true);
        expect(hook.getCurrent().items).toEqual([]);
        const held = hook.getCurrent().items;
        shell = { ...shell, phase: 'establishing', pluginUiProjection: null };
        await hook.rerender();
        expect(hook.getCurrent().loading).toBe(true);
        expect(hook.getCurrent().hasValue).toBe(true);
        expect(hook.getCurrent().items).toBe(held);
        shell = { ...shell, phase: 'current', pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION };
        await hook.rerender();
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items).toBe(held);
    });
    it('never certifies an empty starter list while a plugin member that may carry it is still establishing (Deploy an app)', async () => {
        await setupHome('plugin-member-establishing');
        let shell: ShellValue = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', hasEstablishingMembers: true, interactionEnabled: true, machineId: null, serverId: null, platform: 'web',
            accountLifetime: null, reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(AppShellPluginUiProjectionValueProvider, { value: shell, children });
        const hook = await renderHook(() => useRegistryItems({ kind: 'starter' }), { wrapper });
        await waitForHomeGovernance(() => expect(getPromptLibraryCatalogValue(storage.getState().settingsScope!, 'registry-sources').status).toBe('ready'));
        await flushHookEffects();
        // One Machine has published; the one that may carry the starter source has not. Still loading, never empty.
        expect(hook.getCurrent().loading).toBe(true);
        expect(hook.getCurrent().hasValue).toBe(false);
        shell = { ...shell, hasEstablishingMembers: false };
        await hook.rerender();
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().hasValue).toBe(true);
        expect(hook.getCurrent().items).toEqual([]);
    });
    it.each(['current', 'establishing'] as const)('reads a known catalog while other plugin members are still establishing (J51, %s)', async phase => {
        const serverUrl = `https://registry-partial-plugin-members-${phase}.test`;
        const sourceUrl = serverUrl + '/catalog.json';
        const sourceId = deriveMarketplaceSourceId(sourceUrl);
        const unavailableUrl = serverUrl + '/unavailable.json';
        const unavailableId = deriveMarketplaceSourceId(unavailableUrl);
        const catalog = createRegistryPluginCatalogFixture({ sourceUrl });
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [
                { id: sourceId, title: 'Ready catalog', format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 },
                { id: unavailableId, title: 'Unavailable catalog', format: 'happier-catalog', kinds: ['plugin'], url: unavailableUrl, enabled: true, addedAt: 1 },
            ] },
        }, 'updated', { handleRequest: async path => path === '/catalog.json' ? Response.json(catalog)
            : path === '/unavailable.json' ? new Response(null, { status: 503 }) : null });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const shell: ShellValue = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase, hasEstablishingMembers: true, interactionEnabled: phase === 'current',
            machineId: null, serverId: null, platform: 'web', accountLifetime: null,
            reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(AppShellPluginUiProjectionValueProvider, { value: shell, children });
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId, unavailableId] }), { wrapper });
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().pages).toContainEqual(expect.objectContaining({ sourceId, status: expect.objectContaining({ state: 'ok' }) }));
        expect(hook.getCurrent().items).toContainEqual(expect.objectContaining({ itemId: 'sample.plugin', version: '1.2.3' }));
        expect(hook.getCurrent().sourceFailures).toEqual([expect.objectContaining({ sourceId: unavailableId,
            status: expect.objectContaining({ state: 'unreachable' }), message: expect.any(String) })]);
    });

    it('never reads as settled before a demanded read has answered', async () => {
        const { sourceId } = await setupHome('not-started');
        // A held page reads the render where demand turns on: settled-looking there is a false empty state.
        const seen: Array<Readonly<{ enabled: boolean; loading: boolean; hasValue: boolean; error: string | null }>> = [];
        const hook = await renderHook((enabled: boolean) => {
            const read = useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }, enabled);
            seen.push({ enabled, loading: read.loading, hasValue: read.hasValue, error: read.error });
            return read;
        }, { initialProps: false });
        await hook.rerender(true);
        await waitForHomeGovernance(() => expect(hook.getCurrent().hasValue).toBe(true));
        expect(seen.filter(render => render.enabled && !render.loading && !render.hasValue && render.error === null)).toEqual([]);
    });

    it('names a failing source from every held catalog, and never prints a raw id', async () => {
        const { sourceId } = await setupHome('source-title');
        // The fixture's catalog serves plugins; the Apps page still has to name it when it fails.
        const hook = await renderHook(() => useSourceTitle());
        await waitForHomeGovernance(() => expect(hook.getCurrent()(sourceId)).toBe('Private catalog'));
        expect(hook.getCurrent()('marketplace:not-held')).not.toContain('marketplace:');
    });

    it('validates listing boundaries once and projects the admitted page without reparsing it', async () => {
        const { sourceId } = await setupHome('schema-boundaries');
        // Passthrough instrumentation: the real schemas, Account, HTTP and hook all run.
        const inputParses = vi.spyOn(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.items.list'], 'parse');
        const outputParses = vi.spyOn(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'], 'parse');
        onTestFinished(() => { inputParses.mockRestore(); outputParses.mockRestore(); });
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().items).toContainEqual(expect.objectContaining({ itemId: 'sample.plugin', version: '1.2.3' }));
        // One UI memo admission and the public protocol's existing two input validations.
        expect.soft(inputParses).toHaveBeenCalledTimes(3);
        // The public protocol owner validates output; same-process consumers project it.
        expect.soft(outputParses).toHaveBeenCalledTimes(1);

        const protocol = createRegistryHostV1({ host: 'web', http: createUiRegistryHttpV1(fetch), readSources: async () => [] });
        await expect(protocol.execute('registries.items.list', { kind: 'unsupported' })).rejects.toMatchObject({ issues: expect.any(Array) });
        await expect(protocol.execute('registries.items.list', { kind: 'plugin' })).resolves.toEqual({ pages: [] });
    });

    it.each(['', 'wordpress'])('spends one compose listing fetch across views and local queries (initial query: %s), and nothing on idle', async initialQuery => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        onTestFinished(() => { vi.useRealTimers(); });
        const requests: string[] = [];
        const commit = 'a'.repeat(40);
        let refreshed = false;
        let rateLimited = false;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://store-compose-budget-${initialQuery || 'browse'}.test`, {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            requests.push(url);
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
            if (url.startsWith('https://api.github.com/repos/coollabsio/coolify/commits/')) return Response.json({ sha: commit });
            if (url.includes('/templates/service-templates.json')) return rateLimited ? new Response(null, { status: 429 }) : Response.json({
                ...(!refreshed ? { redis: { name: 'Redis', slogan: 'A cache', category: 'Databases', logo: 'https://example.test/redis.svg' } } : {}),
                wordpress: { name: 'WordPress', slogan: 'A website', tags: ['Publishing'] },
                ...(refreshed ? { ghost: { name: 'Ghost', slogan: 'Another website' } } : {}),
            });
            return null;
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const open = (sourceIds: string[], query = '') => renderHook((text: string) => useRegistryItems({ kind: 'app', sourceIds, query: text }),
            { initialProps: query });
        const first = await open([HAPPIER_PICKS_SOURCE_ID, 'builtin:compose-catalog'], initialQuery);
        await waitForHomeGovernance(() => expect(first.getCurrent().loading).toBe(false));
        expect(first.getCurrent().items.map(item => item.title)).toEqual(initialQuery ? ['WordPress'] : ['Redis', 'WordPress']);
        const listingFetches = () => requests.filter(url => url.includes('/templates/service-templates.json')).length;
        const commitLookups = () => requests.filter(url => url.startsWith('https://api.github.com/repos/coollabsio/coolify/commits/')).length;
        const expectReads = (count: number) => {
            expect(listingFetches()).toBe(count);
            expect(commitLookups()).toBe(count);
        };
        expectReads(1);
        await first.unmount();
        const second = await open(['builtin:compose-catalog']);
        await waitForHomeGovernance(() => expect(second.getCurrent().loading).toBe(false));
        expect(second.getCurrent().items.map(item => item.title)).toEqual(['Redis', 'WordPress']);
        expectReads(1);
        for (const [query, titles] of [
            ['  WORDPRESS  ', ['WordPress']], ['Databases', ['Redis']], ['Publishing', ['WordPress']], ['missing', []],
        ] as const) {
            await second.rerender(query);
            await waitForHomeGovernance(() => expect(second.getCurrent().loading).toBe(false));
            expect(second.getCurrent().items.map(item => item.title)).toEqual(titles);
            expect(second.getCurrent().pages[0]?.total).toBe(titles.length);
            expectReads(1);
        }
        const settled = requests.length;
        await flushHookEffects();
        await second.rerender();
        await flushHookEffects();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(requests).toHaveLength(settled);
        // An explicit person-initiated refresh remains a real freshness boundary.
        refreshed = true;
        await act(async () => { await second.getCurrent().refresh(); });
        expect(second.getCurrent().items).toEqual([]);
        expectReads(2);
        await second.rerender('');
        await waitForHomeGovernance(() => expect(second.getCurrent().loading).toBe(false));
        expect(second.getCurrent().items.map(item => item.title)).toEqual(['WordPress', 'Ghost']);
        expectReads(2);
        await second.rerender('Ghost');
        await waitForHomeGovernance(() => expect(second.getCurrent().loading).toBe(false));
        rateLimited = true;
        await act(async () => { await second.getCurrent().refresh(); });
        expect(second.getCurrent().items.map(item => item.title)).toEqual(['Ghost']);
        expect(second.getCurrent().sourceFailures[0]?.status.state).toBe('rate_limited');
        expectReads(3);
        await second.rerender('WordPress');
        await waitForHomeGovernance(() => expect(second.getCurrent().loading).toBe(false));
        expect(second.getCurrent().items.map(item => item.title)).toEqual(['WordPress']);
        expect(second.getCurrent().sourceFailures[0]?.status.state).toBe('rate_limited');
        expectReads(3);
    });
    it('keeps remote search pages and cursors at their upstream query owner', async () => {
        const searches: Array<{ query: string | null; cursor: string | null }> = [];
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://store-remote-search-budget.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            const parsed = new URL(url);
            if (parsed.pathname !== '/v0.1/servers') return null;
            const query = parsed.searchParams.get('search');
            const cursor = parsed.searchParams.get('cursor');
            searches.push({ query, cursor });
            return Response.json({ servers: [{ server: { name: query ? `search/${cursor || 'first'}` : 'browse/first',
                description: 'Remote server', version: '1.0.0' } }],
                metadata: { count: 1, ...(query && !cursor ? { nextCursor: 'second' } : {}) } });
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook((query: string) => useRegistryItems({ kind: 'mcpServer', sourceIds: ['builtin:mcp-registry'], query }),
            { initialProps: '' });
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['browse/first']);
        await hook.rerender('WordPress');
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['search/first']);
        await act(async () => { await hook.getCurrent().nextPage(); });
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['search/first', 'search/second']);
        expect(searches).toEqual([{ query: null, cursor: null }, { query: 'WordPress', cursor: null }, { query: 'WordPress', cursor: 'second' }]);
    });
    it.each([
        ['mcpServer', false], ['mcpServer', true], ['plugin', false], ['plugin', true],
    ] as const)('retains loaded %s pages and their cursor on reopen (curated unavailable: %s)', async (kind, unavailable) => {
        const sourceId = kind === 'mcpServer' ? 'builtin:mcp-registry' : COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1;
        const requests: string[] = [];
        const curated = createRegistryPluginCatalogFixture({ sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, kind: 'curated', entries: [] });
        const packages = ['first', 'second', 'third'].map(name => createRegistryNpmPackageFixture({
            packageName: `@retained/${name}`, pluginId: `retained.${name}`, title: name, version: '1.0.0',
        }));
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://retained-${kind}-${unavailable}.test`, {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            requests.push(url);
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return unavailable
                ? new Response(null, { status: 503 }) : Response.json(curated);
            const parsed = new URL(url);
            if (kind === 'mcpServer' && parsed.pathname === '/v0.1/servers') {
                const index = Number(parsed.searchParams.get('cursor') ?? '0');
                // Official v0.1 HTTP shape consumed by the real MCP format adapter.
                return Response.json({ servers: [{ server: { name: `retained/server${index}`, description: 'Retained server', version: '1.0.0' } }],
                    metadata: { count: 1, ...(index < 2 ? { nextCursor: String(index + 1) } : {}) } });
            }
            if (kind === 'plugin' && parsed.pathname === '/-/v1/search') {
                const item = packages[Number(parsed.searchParams.get('from') ?? '0')]!;
                return Response.json({ total: packages.length, objects: [{ package: {
                    name: item.name, version: item.version, publisher: { username: 'retained' },
                } }] });
            }
            const item = packages.find(item => decodeURIComponent(parsed.pathname.slice(1)) === item.name);
            return item ? Response.json({ name: item.name, versions: { [item.version]: item }, 'dist-tags': { latest: item.version } }) : null;
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook((enabled: boolean) => {
            // The directory's catalog selector consumes this alongside its items.
            useRegistrySources(kind, enabled);
            return useRegistryItems({ kind, sourceIds: [HAPPIER_PICKS_SOURCE_ID, sourceId] }, enabled);
        },
            { initialProps: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        const ids = kind === 'mcpServer' ? ['retained/server0', 'retained/server1', 'retained/server2'] : packages.map(item => item.name);
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(ids.slice(0, 1));
        await act(async () => { await hook.getCurrent().nextPage(); });
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(ids.slice(0, 2));
        const beforeHide = requests.length;
        await hook.rerender(false);
        await flushHookEffects();
        expect(requests).toHaveLength(beforeHide);
        await hook.rerender(true);
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(ids.slice(0, 2));
        expect(hook.getCurrent().pages.find(page => page.sourceId === sourceId)?.nextCursor).toBe('2');
        expect(hook.getCurrent().sourceFailures.map(page => page.sourceId)).toEqual(unavailable ? [HAPPIER_PICKS_SOURCE_ID] : []);
        // APPS-WARM-PERF-1110: reopening consumes the admitted failure too;
        // only explicit Retry should reacquire a known-unreachable source.
        expect(requests).toHaveLength(beforeHide);
        expect(requests.filter(url => url !== DEFAULT_CURATED_MARKETPLACE_SOURCE_URL)).toHaveLength(
            requests.slice(0, beforeHide).filter(url => url !== DEFAULT_CURATED_MARKETPLACE_SOURCE_URL).length);
        // Explicit revalidation also preserves healthy continuation, even when the first read gets a new fetchedAt.
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(ids.slice(0, 2));
        expect(hook.getCurrent().pages.find(page => page.sourceId === sourceId)?.nextCursor).toBe('2');
        const beforeNext = requests.length;
        await act(async () => { await hook.getCurrent().nextPage(); });
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(ids);
        expect(hook.getCurrent().hasNextPage).toBe(false);
        const listRequests = requests.slice(beforeNext).filter(url => new URL(url).pathname ===
            (kind === 'mcpServer' ? '/v0.1/servers' : '/-/v1/search'));
        expect(listRequests).toHaveLength(1);
        expect(new URL(listRequests[0]!).searchParams.get(kind === 'mcpServer' ? 'cursor' : 'from')).toBe('2');
    });
    it('selects Bot-template packages before paging and leaves selected package bodies cold', async () => {
        const { fixture, sourceId } = await setupHome('bot-template-selector', [
            { pluginId: 'garden.bot', title: 'Garden', botTemplates: [{ id: 'gardener', path: './templates/garden.json' }] },
            { pluginId: 'ordinary.plugin', title: 'Ordinary' },
        ]);
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId], contributionFamily: 'botTemplates' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['garden.bot']);
        expect(fixture.requests.some(request => request.path.includes('.tgz'))).toBe(false);
        await hook.unmount();
    });
    it.each(['skills', 'mcpHome', 'mcpEmpty'] as const)('keeps %s hook order stable through empty-Account readiness, hidden layout and phone resize', async home => {
        await setupHome(`empty-hook-order-${home}`);
        const errors = vi.spyOn(console, 'error');
        onTestFinished(() => { platform.width = 1440; errors.mockRestore(); });
        function SkillsHome() { return <SkillsHomepage library={useSkillsLibrary()} />; }
        const tree = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
            {home === 'skills' ? <SkillsHome /> : home === 'mcpHome' ? <McpServersHome /> : <McpServersEmpty />}
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(tree(false));
        await flushHookEffects();
        await screen.update(tree(true));
        await waitForHomeGovernance(() => expect(screen.getTextContent().length).toBeGreaterThan(0));
        await flushHookEffects();
        platform.width = 390;
        await screen.update(tree(true));
        await screen.update(tree(false));
        await screen.update(tree(true));
        await flushHookEffects();
        expect(errors.mock.calls.filter(args => /change in the order of Hooks|Rendered (?:more|fewer) hooks/i.test(String(args[0])))).toEqual([]);
    });

    it('keeps source-revision acquisition cold while every registry consumer is disabled', async () => {
        const { fixture, sourceId } = await setupHome('disabled-revision-demand');
        const before = fixture.requests.length;
        let enabled = false;
        const hook = await renderHook(() => ({
            sources: useRegistrySources('plugin', enabled),
            list: useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }, enabled),
            selected: useRegistryItem({ kind: 'plugin', sourceId, itemId: 'sample.plugin' }, enabled),
        }));
        const catalogReads = () => fixture.requests.slice(before).filter(request =>
            request.method === 'GET' && request.path.split('?')[0] === PROMPT_LIBRARY_ROWS_ROUTE_V1).length;
        await flushHookEffects();
        expect(catalogReads()).toBe(0);
        enabled = true;
        await hook.rerender();
        await waitForHomeGovernance(() => expect(hook.getCurrent().list.items).toHaveLength(1));
        expect(catalogReads()).toBe(1);
        await hook.unmount();
    });

    it('opens the scoped Store through the Project menu Action and changes, clears and withdraws scope through the real route', async () => {
        const { fixture } = await setupHome('project-store-scope');
        const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { WorkspaceRefV1WriteSchema } = await import('@happier-dev/protocol/workspaces/workspaceRefV1');
        const { projectWorkspaceRefV1 } = await import('@happier-dev/protocol/workspaces/workspaceRefResolutionV1');
        const { buildProjectAccountRowPhysicalKeyV1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        const { renderScreen } = await import('@/dev/testkit');
        const { View } = await import('react-native');
        const { ProjectsListItemMenu } = await import('@/components/projects/ProjectsListItemMenu');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { StoreProjectScopeChip } = await import('@/components/store/StoreProjectScopeChip');
        const { SelectionList, SelectionListFilterChip } = await import('@/components/ui/selectionList');
        const { useStoreProjectScope } = await import('@/components/settings/plugins/model/useStoreProjectScope');
        const { buildPluginsHomeRoute, readStoreProjectRoute, storeProjectRouteParams } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { resolveCompactAppDestinations, hrefForDestinationRef } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
        const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        const { resolveHref } = await import('expo-router/build/link/href');
        const scope = storage.getState().profileScope!;
        const workspace = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', serverId: scope.serverId, projectKey: 'client/web & api',
            machineId: 'machine', rootPath: '/projects/web', label: 'Web', createdAtMs: 1 });
        const second = { ...workspace, id: 'second', projectKey: 'api', label: 'API', rootPath: '/api' };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspace, second] });
        const project = projectWorkspaceRefV1(workspace);
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        let state = createWorkspaceState({ id: 'projects', target: { kind: 'projects', params: {} }, pinned: false, preview: false });
        let nextId = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            getScope: () => scope, dispatch: action => { state = reduceWorkspaceState(state, action); },
            transport: { commit: () => {} }, createId: () => `tab:${++nextId}`, onChange: () => {} });
        navigation.initialize('/projects');
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `tab:${++nextId}` });
        const unregister = registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
        onTestFinished(unregister);
        let selected: ReturnType<typeof useStoreProjectScope> | undefined;
        function Scope() {
            selected = useStoreProjectScope();
            return <View testID="scope.result" accessibilityLabel={selected.project?.projectKey ?? 'none'}><StoreProjectScopeChip /></View>;
        }
        const current = () => state.tabs[state.groups[state.focusedGroupId].activeTabId]!;
        const tree = (children: React.ReactNode) => <DestinationInstanceHost tabId={current().id} ref={current().target}
            pathname={hrefForDestinationRef(catalog, current().target)?.split('?')[0] ?? ''} focused visible
            navigation={{ push: href => { navigation.openHref(resolveHref(href)); },
                replace: href => { navigation.openHref(resolveHref(href), { tabId: current().id, replace: true }); },
                pushRetainingCurrent: href => { navigation.openHref(resolveHref(href)); }, back: () => navigation.step(-1),
                setParams: params => navigation.setParams(current().id, params) }}>{children}</DestinationInstanceHost>;
        // A Project group needs no arbitrary checkout selection to offer Browse Store.
        const screen = await renderScreen(tree(<ProjectsListItemMenu testID="project-store-menu" workspaceRef={null} project={project}
            onTogglePinned={() => {}} onRename={() => {}} onReset={() => {}} onRemove={() => {}} />));
        await screen.pressByTestIdAsync('project-store-menu');
        const menu = screen.root.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toContain('browse-store');
        await act(async () => { menu.props.onSelect('browse-store'); });
        await waitForHomeGovernance(() => expect(current().target.kind).toBe('plugins'));
        expect(readStoreProjectRoute(current().target.params)).toEqual(project);
        await screen.update(tree(<Scope />));
        expect(screen.findByTestId('scope.result')!.props.accessibilityLabel).toBe(project.projectKey);
        const requests = fixture.requests.length;
        // Opening the existing shared picker, then selecting its actual option, updates only route state.
        async function pickScope(id: string) {
            const chipProps: React.ComponentProps<typeof SelectionListFilterChip> = screen.findByType<typeof SelectionListFilterChip>(SelectionListFilterChip).props;
            const renderPicker = chipProps.filter.renderPopoverContent;
            if (!renderPicker) throw new Error('Project chip must use the shared picker');
            await screen.update(tree(<><Scope />{renderPicker({ close: () => {}, maxHeight: 600 })}</>));
            const pickerProps: React.ComponentProps<typeof SelectionList> = screen.findByType<typeof SelectionList>(SelectionList).props;
            const option = pickerProps.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
                .find(option => option.id === id);
            if (!option) throw new Error('Expected an admitted Project picker option');
            await act(async () => { pickerProps.onSelect(option.id, option); });
            await screen.update(tree(<Scope />));
        }
        await pickScope(storeProjectRouteParams(projectWorkspaceRefV1(second)).project!);
        expect(selected!.project?.projectKey).toBe(second.projectKey);
        await pickScope('all');
        expect(current().target.params).not.toHaveProperty('project');
        expect(selected!.project).toBeNull();
        expect(execute('workspace.tabs.open', { href: buildPluginsHomeRoute('app', { view: 'installed', project }), tabId: current().id })).toEqual({ ok: true });
        await screen.update(tree(<Scope />));
        expect(selected!.project).toEqual(project);
        const retiredKey = buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: workspace.serverId, id: workspace.id });
        // The census retires a known row with its revisioned tombstone, not an omitted page entry.
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [second], revisionsByPhysicalKey: { [retiredKey]: 1 } }); });
        expect(selected!.project).toBeNull();
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspace, second], revisionsByPhysicalKey: { [retiredKey]: 2 } }); });
        expect(selected!.project).toEqual(project);
        await act(async () => { applyProjectAccountRowsFixture(storage, { status: 'refused', coverage: 'unknown', workspaceRefs: [workspace] }); });
        expect(selected!.project).toBeNull();
        expect(fixture.requests).toHaveLength(requests);
    });
    it('cancels a hidden finite read and reopens it through a fresh demand lifetime', async () => {
        const { createDeferred } = await import('@/dev/testkit');
        const sourceUrl = 'https://registry-demand-cancel.test/catalog.json';
        const sourceId = deriveMarketplaceSourceId(sourceUrl);
        const catalog = createRegistryPluginCatalogFixture({ sourceUrl });
        const held = createDeferred<Response>();
        let released = false;
        const signals: Array<AbortSignal | null | undefined> = [];
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-demand-home.test', {
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Selected catalog',
                format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
        }, 'updated', { handleExternalRequest: async (url, init) => {
            if (url !== sourceUrl) return null;
            signals.push(init?.signal);
            return released ? Response.json(catalog) : held.promise;
        } });
        onTestFinished(async () => { held.resolve(Response.json(catalog)); await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(({ presented }: { presented: boolean }) =>
            useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }, presented), { initialProps: { presented: true } });
        await waitForHomeGovernance(() => expect(signals.length).toBeGreaterThan(0));
        expect(signals.at(-1)?.aborted).toBe(false);
        const firstSignals = [...signals];
        const remaining = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }));
        await waitForHomeGovernance(() => expect(signals.length).toBeGreaterThan(firstSignals.length));
        const remainingSignal = signals.at(-1);
        await hook.rerender({ presented: false });
        expect(firstSignals.every(signal => signal?.aborted)).toBe(true);
        expect(remainingSignal?.aborted).toBe(false);
        released = true;
        held.resolve(Response.json(catalog));
        await waitForHomeGovernance(() => expect(remaining.getCurrent().items).toHaveLength(1));
        const settledReads = signals.length;
        await hook.rerender({ presented: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().items).toHaveLength(1));
        expect(signals).toHaveLength(settledReads);
        expect(remainingSignal?.aborted).toBe(false);
    });
    it('binds Discover suggestions to held authorized Project facts with no additional reads and no empty placeholder', async () => {
        const { StoreDiscover } = await import('@/components/store/StoreDiscover');
        const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { WorkspaceRefV1WriteSchema } = await import('@happier-dev/protocol/workspaces/workspaceRefV1');
        const { buildProjectAccountRowPhysicalKeyV1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        const { renderScreen } = await import('@/dev/testkit');
        const { View } = await import('react-native');
        let acquisitions = 0;
        const unexpected: string[] = [];
        const discovery = { items: [{ id: 'review', title: 'Review', reference: { type: 'registryItem', kind: 'skill',
            sourceId: 'builtin:skills-sh', itemId: 'fixture/skills/review' } }], categories: [], jobs: [],
            suggestions: [{ item: 'review', because: { kind: 'repository', hostingKind: 'github' } }] };
        const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: { id: HAPPIER_PICKS_SOURCE_ID,
            title: 'Picks', kind: 'curated', sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL },
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], discovery });
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://project-suggestions.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) { acquisitions++; return Response.json(catalog); }
            unexpected.push(url);
            throw new Error('Suggestions must use only the held Project fact and admitted curation');
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const scope = storage.getState().profileScope!;
        const project = { serverId: scope.serverId, projectKey: 'project' };
        const workspace = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', ...project, machineId: 'machine',
            rootPath: '/projects/web', label: 'Web', createdAtMs: 1,
            repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'fixture/web' } });
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspace] });
        let refresh: (() => Promise<void>) | undefined;
        const screen = await renderScreen(<StoreDiscover demand={{ presented: true }} project={project}>
            {({ suggestions, curation }) => {
                refresh = curation.refresh;
                return suggestions.length ? <View testID="project.suggestions"
                    accessibilityLabel={suggestions[0]!.because.repository.repository} /> : null;
            }}
        </StoreDiscover>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('project.suggestions')).not.toBeNull());
        expect(screen.findByTestId('project.suggestions')!.props.accessibilityLabel).toBe('fixture/web');
        expect(acquisitions).toBe(1);
        const before = fixture.requests.length;
        const foreignProject = { ...project, serverId: 'withdrawn-home' };
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...workspace, ...foreignProject }] }); });
        await screen.update(<StoreDiscover demand={{ presented: true }} project={foreignProject}>
            {({ suggestions }) => suggestions.length ? <View testID="project.suggestions" /> : null}
        </StoreDiscover>);
        // A retained foreign-Home row is not a Project admitted by this Account.
        expect(screen.findByTestId('project.suggestions')).toBeNull();
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspace] }); });
        await screen.update(<StoreDiscover demand={{ presented: true }} project={project}>
            {({ suggestions, curation }) => {
                refresh = curation.refresh;
                return suggestions.length ? <View testID="project.suggestions" /> : null;
            }}
        </StoreDiscover>);
        const key = buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: workspace.serverId, id: workspace.id });
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [], revisionsByPhysicalKey: { [key]: 1 } }); });
        expect(screen.findByTestId('project.suggestions')).toBeNull();
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspace], revisionsByPhysicalKey: { [key]: 2 } }); });
        expect(screen.findByTestId('project.suggestions')).not.toBeNull();
        await act(async () => { applyProjectAccountRowsFixture(storage, { status: 'refused', coverage: 'unknown', workspaceRefs: [workspace] }); });
        expect(screen.findByTestId('project.suggestions')).toBeNull();
        expect(fixture.requests).toHaveLength(before);
        expect(acquisitions).toBe(1);
        expect(unexpected).toEqual([]);
        // Only this explicit catalog refresh reads again; empty authored mappings
        // retain the real fact but render no suggestion or placeholder.
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspace], revisionsByPhysicalKey: { [key]: 2 } }); });
        catalog.discovery!.suggestions = [];
        await act(async () => { await refresh!(); });
        expect(screen.findByTestId('project.suggestions')).toBeNull();
        expect(acquisitions).toBe(2);
        expect(unexpected).toEqual([]);
    });
    it('shares every enabled admitted curation source across Discover and kind shelves without opening their targets', async () => {
        const { projectStoreDiscover } = await import('@/components/store/discover/storeDiscoverModel');
        const devUrl = 'https://dev-curation.test/catalog.json';
        const disabledUrl = 'https://disabled-curation.test/catalog.json';
        const devId = deriveMarketplaceSourceId(devUrl);
        const disabledId = deriveMarketplaceSourceId(disabledUrl);
        const acquisitions = new Map<string, number>();
        const targetReads: string[] = [];
        const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: { id: HAPPIER_PICKS_SOURCE_ID,
            title: 'Picks', kind: 'curated', sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL },
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: Array.from({ length: 100 }, (_, index) => index % 2
                ? { kind: 'skill', format: 'git', sourceUrl: `https://github.com/owner${index}/skills`, itemId: '', display: { title: `Skill ${index}` } }
                : { kind: 'mcpServer', format: 'mcp-registry', sourceUrl: 'https://registry.modelcontextprotocol.io', itemId: `server${index}`, display: { title: `Server ${index}` } }) });
        const devSource = { id: devId, title: 'Dev picks', format: 'happier-catalog', kinds: ['plugin'], url: devUrl,
            enabled: true, addedAt: 1 } satisfies RegistrySourceV1;
        const devCatalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: registryMarketplaceSourceV1(devSource),
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], discovery: { items: [
                { id: 'repeat', title: 'Repeated server', reference: { type: 'registryItem', kind: 'mcpServer',
                    sourceId: HAPPIER_PICKS_SOURCE_ID, itemId: 'server0' } },
                { id: 'dev-skill', title: 'Dev skill', reference: { type: 'registryItem', kind: 'skill',
                    sourceId: 'builtin:skills-sh', itemId: 'dev/skills/dev-skill' } },
            ], categories: [], jobs: [] } });
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://shared-curation.test', {
            key: 'registry-sources', value: { v: 2, sources: [
                devSource,
                { id: disabledId, title: 'Disabled picks', format: 'happier-catalog', kinds: ['plugin'], url: disabledUrl, enabled: false, addedAt: 1 },
            ], disabledSourceIds: ['builtin:mcp-registry'] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL || url === devUrl || url === disabledUrl) {
                acquisitions.set(url, (acquisitions.get(url) ?? 0) + 1);
                return Response.json(url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL ? catalog : devCatalog);
            }
            targetReads.push(url);
            throw new Error('Curation must not open target content');
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const initialProps: { presented: boolean; sourceIds?: readonly string[] } = { presented: false };
        const hook = await renderHook(({ presented, sourceIds }: typeof initialProps) => {
            const curation = useRegistryCuration({ sourceIds }, presented);
            return { curation, skill: useRegistrySuggestions('skill', { curation, enabled: presented }),
                mcp: useRegistrySuggestions('mcpServer', { curation, enabled: presented }),
                discover: projectStoreDiscover(curation.curation, []) };
        }, { initialProps });
        expect(acquisitions.size).toBe(0);
        await hook.rerender({ presented: true });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().skill.loading).toBe(false);
            expect(hook.getCurrent().mcp.loading).toBe(false);
        });
        expect(hook.getCurrent().skill.items).toHaveLength(51);
        expect(hook.getCurrent().mcp.items).toHaveLength(50);
        expect(hook.getCurrent().curation.curation.map(page => page.sourceId)).toEqual([HAPPIER_PICKS_SOURCE_ID, devId]);
        const choices = hook.getCurrent().discover.sections.flatMap(section => section.items);
        expect(choices).toHaveLength(101);
        expect(choices[0]?.title).toBe('Server 0');
        expect(choices.at(-1)?.title).toBe('Dev skill');
        expect(hook.getCurrent().mcp.items[0]?.title).toBe('Server 0');
        expect(Object.fromEntries(acquisitions)).toEqual({ [DEFAULT_CURATED_MARKETPLACE_SOURCE_URL]: 1, [devUrl]: 1 });
        expect(targetReads).toEqual([]);
        const heldCuration = hook.getCurrent().curation.curation;
        const heldChoices = hook.getCurrent().discover.sections.flatMap(section => section.items);
        await hook.rerender({ presented: false });
        expect(hook.getCurrent().curation.curation).toBe(heldCuration);
        expect(hook.getCurrent().discover.sections.flatMap(section => section.items)).toEqual(heldChoices);
        expect(Object.fromEntries(acquisitions)).toEqual({ [DEFAULT_CURATED_MARKETPLACE_SOURCE_URL]: 1, [devUrl]: 1 });
        await hook.rerender({ presented: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().curation.loading).toBe(false));
        expect(hook.getCurrent().curation.curation).toBe(heldCuration);
        catalog.picks = [];
        devCatalog.discovery!.items = [];
        await act(async () => { await hook.getCurrent().curation.refresh(); });
        expect(hook.getCurrent().skill.items).toEqual([]);
        expect(hook.getCurrent().mcp.items).toEqual([]);
        await hook.rerender({ presented: false });
        const afterHide = [...acquisitions];
        await hook.rerender({ presented: false });
        expect([...acquisitions]).toEqual(afterHide);
        expect(targetReads).toEqual([]);
        // An explicit source selection remains narrower than the default all-enabled scope.
        await hook.rerender({ presented: true, sourceIds: [devId, disabledId] });
        await waitForHomeGovernance(() => expect(hook.getCurrent().curation.loading).toBe(false));
        expect(hook.getCurrent().curation.pages.map(page => page.sourceId)).toEqual([devId]);
        expect(acquisitions.has(disabledUrl)).toBe(false);
        expect(targetReads).toEqual([]);
    });
    it.each([false, true])('settles curation after a cold source failure without losing healthy editorial order (all failed: %s)', async allFailed => {
        const { projectStoreDiscover } = await import('@/components/store/discover/storeDiscoverModel');
        const sourceUrl = `https://curation-settled-${allFailed}.test/catalog.json`;
        const sourceId = deriveMarketplaceSourceId(sourceUrl);
        const source = { id: sourceId, title: 'Editorial catalog', format: 'happier-catalog', kinds: ['plugin'],
            url: sourceUrl, enabled: true, addedAt: 1 } satisfies RegistrySourceV1;
        const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: registryMarketplaceSourceV1(source),
            freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], discovery: {
                items: ['monitoring', 'publishing'].map(id => ({ id, title: id, reference: {
                    type: 'registryItem', kind: 'app', sourceId, itemId: id } })),
                categories: ['monitoring', 'publishing'].map(id => ({ id, title: id, items: [id] })), jobs: [],
            } });
        // App-only catalogs cannot answer the plugin read that supplies editorial discovery.
        // Their late arrival must not become an eternally pending editorial source.
        const appOnlySource = { ...source, id: 'app-only-catalog', title: 'App-only catalog',
            url: 'https://app-only-curation.test/catalog.json', kinds: ['app'] } satisfies RegistrySourceV1;
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let healthyReads = 0;
        let unavailable = allFailed;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://curation-layout-${allFailed}.test`, {
            key: 'registry-sources', value: { v: 2, sources: [source, appOnlySource], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) {
                await pending;
                return new Response(null, { status: 503 });
            }
            if (url === sourceUrl) {
                healthyReads++;
                return unavailable ? new Response(null, { status: 503 }) : Response.json(catalog);
            }
            throw new Error('Curation must not read target content');
        } });
        onTestFinished(async () => { release(); await standardCleanup(); await fixture.dispose(); });
        const sourceIds = [HAPPIER_PICKS_SOURCE_ID, sourceId];
        const requested = [...sourceIds, appOnlySource.id];
        const hook = await renderHook(() => useRegistryCuration({ sourceIds: requested }));
        await waitForHomeGovernance(() => expect(healthyReads).toBe(1));
        // A healthy sibling cannot expose sections before pending editorial positions are known.
        expect(hook.getCurrent().layout.hasValue).toBe(false);
        expect(hook.getCurrent().layout.loading).toBe(true);
        await act(async () => { release(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().layout.loading).toBe(false));
        expect(hook.getCurrent().layout.hasValue).toBe(!allFailed);
        expect(hook.getCurrent().layout.sourceFailures.map(failure => failure.sourceId)).toEqual(
            allFailed ? sourceIds : [HAPPIER_PICKS_SOURCE_ID]);
        if (allFailed) {
            expect(hook.getCurrent().curation).toEqual([]);
            return;
        }
        expect(projectStoreDiscover(hook.getCurrent().curation, []).sections.map(section => section.categoryId))
            .toEqual(['monitoring', 'publishing']);
        const retained = hook.getCurrent().curation;
        unavailable = true;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().layout.hasValue).toBe(true);
        expect(hook.getCurrent().curation).toBe(retained);
        expect(hook.getCurrent().layout.sourceFailures.map(failure => failure.sourceId)).toEqual(sourceIds);
    });
    it('keeps healthy catalog rows mounted while an added source is still pending', async () => {
        const { BUILT_IN_REGISTRY_SOURCES_V1 } = await import('@happier-dev/protocol/registries');
        const firstUrl = 'https://source-arrival.test/first/catalog.json';
        const nextUrl = 'https://source-arrival.test/next/catalog.json';
        const firstId = deriveMarketplaceSourceId(firstUrl);
        const nextId = deriveMarketplaceSourceId(nextUrl);
        const source = { id: firstId, title: 'First catalog', format: 'happier-catalog', kinds: ['plugin'],
            url: firstUrl, enabled: true, addedAt: 1 } satisfies RegistrySourceV1;
        const added = { ...source, id: nextId, title: 'Added catalog', url: nextUrl };
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let nextRequested = false;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://source-arrival-home.test', {
            key: 'registry-sources', value: { v: 2, sources: [source],
                disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(source => source.id) },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === firstUrl) return Response.json(createRegistryPluginCatalogFixture({ sourceUrl: firstUrl }));
            if (url === nextUrl) { nextRequested = true; await pending;
                return Response.json(createRegistryPluginCatalogFixture({ sourceUrl: nextUrl })); }
            throw new Error('Unexpected catalog request');
        } });
        onTestFinished(async () => { release(); await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().items).toHaveLength(1));
        const held = hook.getCurrent().items;
        const scope = storage.getState().settingsScope!;
        const row = fixture.read();
        const record = row.record;
        if (record.key !== 'registry-sources') throw new Error('Expected registry source fixture');
        await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(scope, { key: 'registry-sources',
            value: { ...record.value, sources: [source, added] } }, row.revision + 1, true));
        await waitForHomeGovernance(() => expect(nextRequested).toBe(true));
        expect(hook.getCurrent().loading).toBe(true);
        expect(hook.getCurrent().items).toBe(held);
        await act(async () => { release(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items.map(item => item.sourceId)).toEqual([firstId, nextId]);
    });
    it('reconciles refresh by content: zero changed row identities for equal content and only one for one changed listing', async () => {
        const { sourceId, catalog } = await setupHome('row-identity', Array.from({ length: 100 }, (_, index) => ({
            pluginId: `sample.plugin${index}`, title: `Plugin ${index}`,
        })));
        const base = catalog.entries[0]!;
        catalog.discovery = { items: catalog.entries.map((entry, index) => ({ id: `choice-${index}`, title: entry.display.title,
            reference: { type: 'registryItem', kind: 'plugin', sourceId, itemId: entry.pluginId, version: entry.distribution.version } })),
            categories: [], jobs: [] };
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().items).toHaveLength(100));
        const before = hook.getCurrent().items;
        const presentation = await renderHook(() => usePluginCatalog({ enabled: true, browse: true,
            query: { text: '', sourceId } }));
        await waitForHomeGovernance(() => expect(presentation.getCurrent().discoverEntries).toHaveLength(100));
        const entriesBefore = presentation.getCurrent().discoverEntries;
        const discoveryBefore = hook.getCurrent().pages[0]!.discovery!.items;
        const observed = hook.getCurrent().pages[0]!.status;
        if (observed.state !== 'ok') throw new Error('Expected admitted catalog observation');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(observed.fetchedAt + 1);
        onTestFinished(() => clock.mockRestore());
        const marks = before.map(item => Reflect.get(item, 'brandMark'));
        expect(marks.filter(Boolean)).toHaveLength(100);
        await act(async () => { await hook.getCurrent().refresh(); });
        await act(async () => { presentation.getCurrent().refreshDiscover(); });
        await waitForHomeGovernance(() => expect(presentation.getCurrent().loadingDiscover).toBe(false));
        expect.soft(presentation.getCurrent().discoverEntries.filter((item, index) => item !== entriesBefore[index])).toHaveLength(0);
        expect(hook.getCurrent().pages[0]!.status).toEqual({ state: 'ok', fetchedAt: observed.fetchedAt + 1 });
        expect(hook.getCurrent().items.filter((item, index) => item !== before[index])).toHaveLength(0);
        expect(hook.getCurrent().pages[0]!.discovery!.items.filter((item, index) => item !== discoveryBefore[index])).toHaveLength(0);
        expect(hook.getCurrent().items.filter((item, index) => Reflect.get(item, 'brandMark') !== marks[index])).toHaveLength(0);
        catalog.entries[42] = { ...catalog.entries[42]!, display: { ...base.display, title: 'Changed Plugin' } };
        catalog.discovery.items[42] = { ...catalog.discovery.items[42]!, title: 'Changed Plugin' };
        clock.mockReturnValue(observed.fetchedAt + 2);
        await act(async () => { await hook.getCurrent().refresh(); });
        await act(async () => { presentation.getCurrent().refreshDiscover(); });
        await waitForHomeGovernance(() => expect(presentation.getCurrent().discoverEntries[42]?.title).toBe('Changed Plugin'));
        expect.soft(presentation.getCurrent().discoverEntries.filter((item, index) => item !== entriesBefore[index])).toHaveLength(1);
        expect(hook.getCurrent().items[42]?.title).toBe('Changed Plugin');
        expect(hook.getCurrent().items.filter((item, index) => item !== before[index])).toHaveLength(1);
        expect(hook.getCurrent().pages[0]!.discovery!.items.filter((item, index) => item !== discoveryBefore[index])).toHaveLength(1);
        expect(hook.getCurrent().items.filter((item, index) => Reflect.get(item, 'brandMark') !== marks[index])).toHaveLength(1);
    });
    it('does not reload source lists for execution or unrelated declaration currentness, but refreshes changed sources', async () => {
        const { fixture, sourceId } = await setupHome('source-input-cost');
        let loads = 0;
        const createExecute = actionFrontDoor.createFrontDoorActionExecute;
        // Count canonical dispatches without replacing Action logic or its prepare port.
        const observation = vi.spyOn(actionFrontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
            const execute = createExecute(...args);
            return Object.assign((...invocation: Parameters<typeof execute>) => {
                if (invocation[0] === 'registries.sources.list') loads++;
                return execute(...invocation);
            }, { prepare: execute.prepare, confirmed: execute.confirmed });
        });
        onTestFinished(() => observation.mockRestore());
        let shell: ShellValue = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web', accountLifetime: null,
            reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(AppShellPluginUiProjectionValueProvider, { value: shell, children });
        const hook = await renderHook(() => useRegistrySources('plugin'), { wrapper });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const baseline = loads;
        for (let generation = 1; generation <= 5; generation++) {
            shell = { ...shell, connectedAccountProjectionRevision: generation,
                clientExecutableActivation: { status: generation % 2 ? 'establishing' : 'ready' },
                pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation } };
            await hook.rerender();
        }
        expect(loads - baseline).toBe(0);
        const scope = storage.getState().settingsScope!;
        const received = getPromptLibraryCatalogSnapshot(scope)!;
        for (let wake = 0; wake < 5; wake++) {
            await act(async () => beginPromptLibraryCatalogLoad(scope));
            await act(async () => applyPromptLibraryCatalogRowsSnapshot(scope, ['skill-rules'], {
                rawSettings: {}, sourceSettingsVersion: 0, catalog: { status: 'ready', rows: [{ revision: 1,
                    record: { key: 'skill-rules', value: { v: 1, rules: [] } } }], tombstones: [], diagnostics: [] },
            }, true));
            expect(loads - baseline).toBe(0);
            await act(async () => applyPromptLibraryCatalogSnapshot(scope, { ...received,
                catalog: { status: 'unavailable', reason: 'unreachable' } }, true));
            await act(async () => applyPromptLibraryCatalogSnapshot(scope, received, true));
        }
        expect(loads - baseline).toBe(0);
        const row = received.catalog.status === 'ready' || received.catalog.status === 'partial'
            ? received.catalog.rows.find(row => row.record.key === 'registry-sources') : null;
        const sourceValue = getPromptLibraryCatalogValue(scope, 'registry-sources').value;
        if (!row || row.record.key !== 'registry-sources' || !sourceValue) throw new Error('Expected source record');
        const { writePromptLibraryRecord } = await import('@/sync/api/account/apiPromptLibraryCatalog');
        await act(async () => {
            const result = await writePromptLibraryRecord(scope, { record: { key: 'registry-sources',
                value: { ...sourceValue, sources: sourceValue.sources.map(source => source.id === sourceId
                    ? { ...source, title: 'Changed source' } : source) } }, expectedRevision: row.revision });
            expect(result).toMatchObject({ status: 'updated', revision: row.revision + 1 });
        });
        expect(fixture.read().revision).toBe(row.revision + 1);
        await waitForHomeGovernance(() => expect(hook.getCurrent().sources).toContainEqual(expect.objectContaining({ id: sourceId, title: 'Changed source' })));
        expect(loads - baseline).toBe(1);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const beforeRenewal = loads;
        const credentials = await TokenStorage.getCredentialsForServerUrl(fixture.home.serverUrl, { serverId: fixture.home.id });
        if (!credentials) throw new Error('Expected fixture credentials');
        let replacement!: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>;
        await act(async () => {
            replacement = await TokenStorage.setCredentialsForServerUrlWithRollback(fixture.home.serverUrl,
                { serverId: fixture.home.id }, { ...credentials, token: `${credentials.token}-renewed` });
        });
        if (!replacement) throw new Error('Expected replacement fixture lifetime');
        try {
            await waitForHomeGovernance(() => {
                expect(loads).toBeGreaterThan(beforeRenewal);
                expect(hook.getCurrent().status).toBe('ready');
                expect(hook.getCurrent().sources).toContainEqual(expect.objectContaining({ id: sourceId }));
            });
        } finally { await act(async () => { await replacement.rollback(); }); }
    });
    it('keeps a hidden registry list revision quiet for plugin source publications and reads the latest on resume', async () => {
        await setupHome('hidden-list-plugin-source-cost');
        let renders = 0;
        let revision = '';
        const Probe = React.memo(function Probe(props: { enabled: boolean }) {
            renders++;
            revision = useRegistrySourceRevision(props.enabled);
            return null;
        });
        const value: ShellValue = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web', accountLifetime: null,
            reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
        const tree = (shell: ShellValue, enabled: boolean) => <AppShellPluginUiProjectionValueProvider value={shell}>
            <PluginSurfaceFocusEligibilityProvider active={enabled} presentationActive={enabled}><Probe enabled={enabled} /></PluginSurfaceFocusEligibilityProvider>
        </AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(tree(value, false));
        const before = renders;
        let latest = value;
        for (let index = 1; index <= 10; index++) {
            const declaration = projectPluginRegistrySourceDeclarationV1({ pluginId: 'com.acme.hidden-list', pluginVersion: '1.0.0',
                definition: { id: 'extensions', title: `Latest list catalog ${index}`, format: 'happier-catalog',
                    kinds: ['browserExtension'], url: 'https://registry-plugin-hidden-list.test/catalog.json' } });
            latest = { ...value, pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, registrySourcesById: { [declaration.id]: declaration } } };
            await screen.update(tree(latest, false));
        }
        expect(renders - before).toBe(0);
        await screen.update(tree(latest, true));
        await waitForHomeGovernance(() => expect(getPromptLibraryCatalogValue(storage.getState().settingsScope!, 'registry-sources').status).toBe('ready'));
        expect(revision).toContain('Latest list catalog 10');
        const held = revision;
        await screen.update(tree({ ...latest, phase: 'establishing', hasEstablishingMembers: true }, true));
        expect(revision).toBe(held);
    });
    it.each([true, false])('keeps an addressed descriptor quiet for unrelated plugin source publications (presented: %s)', async presented => {
        const { sourceId, fixture } = await setupHome(`addressed-plugin-source-cost-${presented}`);
        let renders = 0;
        let title: string | undefined;
        const Probe = React.memo(function Probe(props: { sourceId: string }) {
            renders++;
            title = useRegistrySourceDescriptor(props.sourceId)?.title;
            return null;
        });
        const value: ShellValue = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web', accountLifetime: null,
            reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
        const tree = (shell: ShellValue, active: boolean, selectedId = sourceId) => <AppShellPluginUiProjectionValueProvider value={shell}>
            <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}><Probe sourceId={selectedId} /></PluginSurfaceFocusEligibilityProvider>
        </AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(tree(value, true));
        await waitForHomeGovernance(() => expect(title).toBe('Private catalog'));
        await screen.update(tree(value, presented));
        const before = { renders, requests: fixture.requests.length };
        for (let index = 1; index <= 10; index++) {
            const declaration = projectPluginRegistrySourceDeclarationV1({ pluginId: 'com.acme.unrelated', pluginVersion: '1.0.0',
                definition: { id: 'extensions', title: `Unrelated extensions ${index}`, format: 'happier-catalog',
                    kinds: ['browserExtension'], url: 'https://registry-plugin-unrelated.test/catalog.json' } });
            await screen.update(tree({ ...value, pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION,
                registrySourcesById: { [declaration.id]: declaration } } }, presented));
        }
        expect(renders - before.renders).toBe(0);
        expect(fixture.requests.length - before.requests).toBe(0);
        expect(title).toBe('Private catalog');
        const declaration = (name: string) => projectPluginRegistrySourceDeclarationV1({ pluginId: 'com.acme.addressed', pluginVersion: '1.0.0',
            definition: { id: 'extensions', title: name, format: 'happier-catalog', kinds: ['browserExtension'],
                url: 'https://registry-plugin-addressed.test/catalog.json' } });
        const shell = (name: string): ShellValue => {
            const source = declaration(name);
            return { ...value, pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, registrySourcesById: { [source.id]: source } } };
        };
        const pluginSource = projectPluginRegistrySources(shell('Plugin catalog').pluginUiProjection)[0];
        if (!pluginSource) throw new Error('Expected the canonical plugin source descriptor');
        // A hidden first selection still reads its addressed snapshot without acquiring a subscription.
        await screen.update(tree(shell('Plugin catalog'), false, pluginSource.id));
        expect(title).toBe('Plugin catalog');
        const pluginHiddenRenders = renders;
        await screen.update(tree(shell('Latest plugin catalog'), false, pluginSource.id));
        expect(renders - pluginHiddenRenders).toBe(0);
        await screen.update(tree(shell('Latest plugin catalog'), true, pluginSource.id));
        expect(title).toBe('Latest plugin catalog');
        await screen.update(tree(shell('Renamed plugin catalog'), true, pluginSource.id));
        expect(title).toBe('Renamed plugin catalog');
        await screen.update(tree(shell('Renamed plugin catalog'), true));
        expect(title).toBe('Private catalog');
    });
    it('keeps an addressed listing title quiet for unrelated source publications and current across selection and presentation', async () => {
        const serverUrl = 'https://registry-listing-title.test';
        const firstUrl = `${serverUrl}/first.json`;
        const secondUrl = `${serverUrl}/second.json`;
        const firstId = deriveMarketplaceSourceId(firstUrl);
        const secondId = deriveMarketplaceSourceId(secondUrl);
        const first = { id: firstId, title: 'First catalog', format: 'happier-catalog' as const,
            kinds: ['browserExtension' as const], url: firstUrl, enabled: true, addedAt: 1 };
        const second = { ...first, id: secondId, title: 'Second catalog', url: secondUrl };
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [HAPPIER_PICKS_SOURCE_ID], sources: [first, second] },
        }, 'updated');
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        let renders = 0;
        const hook = await renderHook(({ sourceId, enabled }: { sourceId: string; enabled: boolean }) => {
            renders++;
            return useRegistrySourceDescriptor(sourceId, enabled)?.title;
        }, { initialProps: { sourceId: firstId, enabled: true } });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toBe('First catalog'));
        const scope = storage.getState().settingsScope!;
        const snapshot = getPromptLibraryCatalogValue(scope, 'registry-sources');
        if (!snapshot.value || typeof snapshot.revision !== 'number') throw new Error('Expected an acknowledged source catalog');
        const value = snapshot.value;
        const revision = snapshot.revision;
        const before = { renders, requests: fixture.requests.length };
        for (let index = 1; index <= 10; index++) {
            await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(scope, { key: 'registry-sources',
                value: { ...value, sources: [first, { ...second, title: `Other catalog ${index}` }] } }, revision + index, true));
            await flushHookEffects();
        }
        expect(renders - before.renders).toBe(0);
        expect(fixture.requests.length - before.requests).toBe(0);
        await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(scope, { key: 'registry-sources',
            value: { ...value, sources: [{ ...first, title: 'Renamed first catalog' }, second] } }, revision + 11, true));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toBe('Renamed first catalog'));
        await hook.rerender({ sourceId: secondId, enabled: true });
        expect(hook.getCurrent()).toBe('Second catalog');
        await hook.rerender({ sourceId: secondId, enabled: false });
        const hiddenRenders = renders;
        await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(scope, { key: 'registry-sources',
            value: { ...value, sources: [first, { ...second, title: 'Renamed while hidden' }] } }, revision + 12, true));
        expect(renders - hiddenRenders).toBe(0);
        await hook.rerender({ sourceId: secondId, enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toBe('Renamed while hidden'));
        expect(fixture.requests.length - before.requests).toBe(0);
    });
    it('renders registry observers only for changed source facts, not read freshness', async () => {
        const { fixture } = await setupHome('source-render-cost');
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useRegistrySourceRevision(); });
        const scope = storage.getState().settingsScope!;
        await waitForHomeGovernance(() => expect(getPromptLibraryCatalogValue(scope, 'registry-sources').status).toBe('ready'));
        const received = getPromptLibraryCatalogSnapshot(scope)!;
        const before = { renders, revision: hook.getCurrent(), requests: fixture.requests.length };
        for (let i = 0; i < 5; i++) {
            await act(async () => beginPromptLibraryCatalogRowsLoad(scope, ['registry-sources']));
            await act(async () => applyPromptLibraryCatalogRowsSnapshot(scope, ['registry-sources'], received, true));
        }
        expect(renders - before.renders).toBe(0);
        expect(hook.getCurrent()).toBe(before.revision);
        expect(fixture.requests).toHaveLength(before.requests);
        const row = received.catalog.status === 'ready' || received.catalog.status === 'partial'
            ? received.catalog.rows.find(row => row.record.key === 'registry-sources') : null;
        if (!row) throw new Error('Expected received registry source row');
        await act(async () => applyPromptLibraryCatalogAcknowledgedRecord(scope, row.record, row.revision + 1, true));
        expect(renders - before.renders).toBe(1);
        expect(hook.getCurrent()).not.toBe(before.revision);
        await hook.unmount();
    });
    it('reads the first skills.sh detail through the real mounted Action before the source catalog is warm', async () => {
        const { createPromptRegistrySkillFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
        const { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/registries');
        const skill = createPromptRegistrySkillFixture({ sourceId: 'builtin:skills-sh', itemId: 'review', title: 'review',
            files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review changes\n---\nRead the diff.' }] });
        if (skill.item.payload.kind !== 'skill') throw new Error('Expected the canonical skill fixture');
        const payload = skill.item.payload.skill;
        const requests: string[] = [];
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-cold-detail.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            requests.push(url);
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
            if (url.startsWith('https://api.github.com/repos/fixture/skills/commits/')) return Response.json({ sha: payload.ref.commit });
            if (url.includes('/git/trees/')) return Response.json({ sha: payload.ref.treeSha, tree: [
                { path: 'review', type: 'tree', mode: '040000', sha: payload.ref.treeSha },
                ...payload.files.map(file => ({
                path: `review/${file.path}`, type: 'blob', mode: file.unixMode === 0o755 ? '100755' : '100644', sha: file.blobSha, size: file.size,
            }))] });
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/')) return new Response(payload.skillMarkdown);
            return null;
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistryItem({ kind: 'skill', sourceId: 'builtin:skills-sh', itemId: 'fixture/skills/review' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        const read = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse({ item: hook.getCurrent().item });
        expect(read.item.summary).toMatchObject({ itemId: 'fixture/skills/review', version: payload.ref.commit });
        expect(read.item.payload).toMatchObject({ kind: 'skill', skill: { skillMarkdown: payload.skillMarkdown } });
        expect(requests.some(url => url.startsWith('https://api.github.com/repos/fixture/skills/commits/'))).toBe(true);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('keeps a rate-limited detail read typed with its reset time and recovers through Retry', async () => {
        const { createPromptRegistrySkillFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
        const skill = createPromptRegistrySkillFixture({ sourceId: 'builtin:skills-sh', itemId: 'review', title: 'review',
            files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review changes\n---\nRead the diff.' }] });
        if (skill.item.payload.kind !== 'skill') throw new Error('Expected the canonical skill fixture');
        const payload = skill.item.payload.skill;
        let limited = true;
        const resetSeconds = Math.floor(Date.now() / 1000) + 2;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-limited-detail.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
            if (limited && url.startsWith('https://api.github.com/')) return Response.json({ message: 'API rate limit exceeded' },
                { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) } });
            if (url.startsWith('https://api.github.com/repos/fixture/skills/commits/')) return Response.json({ sha: payload.ref.commit });
            if (url.includes('/git/trees/')) return Response.json({ sha: payload.ref.treeSha, tree: [
                { path: 'review', type: 'tree', mode: '040000', sha: payload.ref.treeSha },
                ...payload.files.map(file => ({
                path: `review/${file.path}`, type: 'blob', mode: file.unixMode === 0o755 ? '100755' : '100644', sha: file.blobSha, size: file.size,
            }))] });
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/')) return new Response(payload.skillMarkdown);
            return null;
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistryItem({ kind: 'skill', sourceId: 'builtin:skills-sh', itemId: 'fixture/skills/review' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().item).toBeNull();
        expect(hook.getCurrent().status).toEqual({ state: 'rate_limited', retryAt: resetSeconds * 1000 });
        limited = false;
        // The host keeps the known reset for this origin; Retry after it reads again.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, resetSeconds * 1000 - Date.now()) + 50));
        await act(async () => { await hook.getCurrent().refresh(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().item).not.toBeNull());
        expect(hook.getCurrent().status).toBeNull();
    });
    it('browses curated skill pointers without target work, then reads only the selected skill with no Machine', async () => {
        const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: {
            id: HAPPIER_PICKS_SOURCE_ID, title: 'Happier picks', kind: 'curated', sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
        }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [{
            kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: '',
        }] });
        const commit = '1'.repeat(40);
        const targets: string[] = [];
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-picks.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return Response.json(catalog);
            targets.push(url);
            if (url.startsWith('https://api.github.com/repos/example/skills/commits/')) return Response.json({ sha: commit });
            if (url.includes('/git/trees/')) return Response.json({ sha: 'tree', tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 40 }] });
            if (url.startsWith('https://raw.githubusercontent.com/example/skills/')) return new Response('---\nname: review-changes\n---\nInstructions');
            return null;
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('skill'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items).toContainEqual(expect.objectContaining({ title: 'skills', flags: { pick: true } }));
        expect(hook.getCurrent().sourceId).toBe(HAPPIER_PICKS_SOURCE_ID);
        expect(targets).toEqual([]);
        const pointer = hook.getCurrent().items[0]!;
        expect(pointer.version).toBeUndefined();
        const selected = await renderHook(() => useRegistryItem({ kind: 'skill', sourceId: pointer.sourceId, itemId: pointer.itemId }));
        await waitForHomeGovernance(() => expect(selected.getCurrent().item?.summary.version).toBe(commit));
        expect(selected.getCurrent().item?.summary.title).toBe('review-changes');
        expect(targets.length).toBeGreaterThan(0);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('retains a typed source-acquisition error in skill suggestions when no catalog can be admitted', async () => {
        let externalReads = 0;
        const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const fixture = await createPlainArtifactHomeFixture('https://registry-invalid-suggestions.test', {
            handleRequest: async path => path.startsWith('/v1/account/entity-rows/prompt-library')
                ? Response.json({ status: 'invalid-stored-content' }) : null,
            handleExternalRequest: async () => {
                externalReads++;
                throw new Error('Invalid sources must not start a catalog acquisition');
            },
        });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('skill'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null, status: { state: 'invalid_source' } });
        expect(hook.getCurrent().error).toEqual(expect.any(String));
        expect(hook.getCurrent().error).not.toBe('');
        const settledRequests = fixture.requests.length;
        await hook.rerender();
        expect(fixture.requests).toHaveLength(settledRequests);
        expect(externalReads).toBe(0);
    });

    it('distinguishes empty web skill suggestions from typed unavailability without Machine fallback work', async () => {
        let unavailable = false;
        let reads = 0;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-empty-picks.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            expect(url).toBe(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL);
            reads++;
            return unavailable ? new Response(null, { status: 503 }) : Response.json(MarketplaceIndexSourceSnapshotV1Schema.parse({ source: {
                id: HAPPIER_PICKS_SOURCE_ID, title: 'Picks', kind: 'curated', sourceUrl: url,
            }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [] }));
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('skill'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null, error: null, sourceFailures: [] });
        unavailable = true;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null, loading: false,
            sourceFailures: [expect.objectContaining({ sourceId: HAPPIER_PICKS_SOURCE_ID,
                status: { state: 'unreachable' }, onRetry: expect.any(Function) })] });
        const settledReads = reads;
        await hook.rerender();
        expect(reads).toBe(settledReads);
        unavailable = false;
        await act(async () => { await hook.getCurrent().sourceFailures[0]!.onRetry(); });
        expect(hook.getCurrent()).toMatchObject({ items: [], error: null, sourceFailures: [], loading: false });
        expect(reads).toBe(settledReads + 1);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('falls back to the first direct built-in agent registry without browsing user or daemon sources', async () => {
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-agent-suggestions.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
            expect(url).toBe('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json');
            return Response.json({ version: '1.0.0', agents: [{ id: 'sample', name: 'Sample agent', description: 'An Agent', version: '1.0.0', distribution: { npx: { package: 'sample@1.0.0' } } }] });
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('agent'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ sourceId: 'builtin:acp-registry', items: [{ itemId: 'sample', title: 'Sample agent' }] });
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('reads the native skill fallback directly from the first built-in page', async () => {
        platform.value = 'ios';
        onTestFinished(() => { platform.value = 'web'; });
        const externalRequests: string[] = [];
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-native-suggestions.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            externalRequests.push(url);
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
            expect(url).toBe('https://skills.sh/');
            return new Response('<a href="/example/skills/review">Review</a>');
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('skill'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ sourceId: 'builtin:skills-sh', items: [{ itemId: 'example/skills/review' }] });
        expect(externalRequests).toContain('https://skills.sh/');
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it.each(['mcpServer', 'skill', 'plugin'] as const)('keeps cold %s catalog failures distinct from a successful empty read and recovers by Retry', async kind => {
        let status = 429;
        let reads = 0;
        const catalog = createRegistryPluginCatalogFixture({ sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, kind: 'curated', entries: [] });
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://registry-cold-${kind}.test`, {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url !== DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return null;
            reads++;
            return status === 200 ? Response.json(catalog) : new Response('Too many requests', { status });
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistryItems({ kind, sourceIds: [HAPPIER_PICKS_SOURCE_ID] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items).toEqual([]);
        expect(hook.getCurrent().sourceFailures).toEqual([expect.objectContaining({ sourceId: HAPPIER_PICKS_SOURCE_ID,
            message: expect.any(String), onRetry: expect.any(Function) })]);
        expect(hook.getCurrent().sourceFailures[0]!.message).not.toBe('');
        expect(hook.getCurrent().pages[0]?.status).toEqual({ state: 'rate_limited' });
        const beforeRetry = reads;
        status = 200;
        await act(async () => { await hook.getCurrent().sourceFailures[0]!.onRetry(); });
        expect(hook.getCurrent().items).toEqual([]);
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().sourceFailures).toEqual([]);
        expect(hook.getCurrent().pages.every(page => page.status.state === 'ok')).toBe(true);
        expect(reads).toBe(beforeRetry + 1);
        status = 503;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().pages[0]?.status).toEqual({ state: 'unreachable' });
        expect(hook.getCurrent().sourceFailures).toHaveLength(1);
        expect(reads).toBe(beforeRetry + 2);
    });
    it('keeps known items on a headerless rate limit and recovers through the source failure manual Retry', async () => {
        const { sourceId, setRateLimited } = await setupHome('rate-limit');
        const hook = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().items).toContainEqual(expect.objectContaining({ itemId: 'sample.plugin' }));
        const known = hook.getCurrent().items;
        setRateLimited(true);
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().pages[0]?.status).toEqual({ state: 'rate_limited' });
        expect(hook.getCurrent().items).toEqual(known);
        expect(hook.getCurrent().sourceFailures).toEqual([expect.objectContaining({ sourceId, onRetry: expect.any(Function) })]);
        await hook.unmount();
        const reopened = await renderHook(() => useRegistryItems({ kind: 'plugin', sourceIds: [sourceId] }));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().loading).toBe(false));
        expect(reopened.getCurrent().items).toEqual(known);
        expect(reopened.getCurrent().pages[0]?.status).toEqual({ state: 'rate_limited' });
        setRateLimited(false);
        await act(async () => { await reopened.getCurrent().sourceFailures[0]!.onRetry(); });
        expect(reopened.getCurrent().pages[0]?.status.state).toBe('ok');
        expect(reopened.getCurrent().sourceFailures).toEqual([]);
        expect(reopened.getCurrent().items).toEqual(known);
    });
    it('retains the same Account/query result with the failed refresh status, but never merges it into a different query', async () => {
        const { fixture, hook, sourceId, lastKnown } = await setup('query');
        expect(hook.getCurrent().items).toEqual(lastKnown);
        expect(hook.getCurrent().pages).toEqual([expect.objectContaining({ sourceId, status: { state: 'unreachable' }, nextCursor: null })]);
        expect(hook.getCurrent().sourceFailures).toEqual([expect.objectContaining({ sourceId, onRetry: expect.any(Function) })]);
        expect(hook.getCurrent().hasNextPage).toBe(false);
        await hook.rerender({ query: 'Missing entry' });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ loading: false, stale: false }));
        expect(hook.getCurrent().items).toEqual([]);
        expect(hook.getCurrent().pages[0]?.status).toEqual({ state: 'unreachable' });
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('withdraws retained items when the credential Account changes before the displayed settings scope', async () => {
        const { fixture, hook, lastKnown } = await setup('account', false);
        expect(hook.getCurrent().items).toEqual(lastKnown);
        const { storage } = await import('@/sync/domains/state/storage');
        const displayedScope = storage.getState().settingsScope;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentialWrite: { value: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> } = { value: null };
        await act(async () => {
            credentialWrite.value = await TokenStorage.setCredentialsForServerUrlWithRollback(fixture.home.serverUrl, { serverId: fixture.home.id }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`,
            });
        });
        const replacement = credentialWrite.value;
        if (!replacement) throw new Error('Replacement credential admission failed');
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().available).toBe(false));
            expect(storage.getState().settingsScope).toEqual(displayedScope);
            expect(hook.getCurrent().items).toEqual([]);
            expect(hook.getCurrent().pages).toEqual([]);
            expect(hook.getCurrent().hasNextPage).toBe(false);
        } finally { await act(async () => { await replacement.rollback(); }); }
    });
    it.each(['disable', 'remove'] as const)('withdraws old summaries when the real Account source row changes during an HTTP outage: %s', async operation => {
        const { fixture, hook, sourceId } = await setup(operation, false);
        if (operation === 'disable') await act(async () => { await hook.getCurrent().mutations.update({ sourceId, enabled: false }); });
        else await act(async () => { expect(await hook.getCurrent().mutations.delete(sourceId)).toEqual({ removed: true }); });
        expect(fixture.read().revision).toBe(5);
        if (operation === 'disable') expect(fixture.read().record.value).toMatchObject({ sources: [{ id: sourceId, enabled: false }] });
        else expect(fixture.read().record.value).toMatchObject({ sources: [] });
        await waitForHomeGovernance(() => expect(hook.getCurrent().items).toEqual([]));
        expect(hook.getCurrent().pages).toEqual([]);
        expect(hook.getCurrent().hasNextPage).toBe(false);
    });
    it('keeps the source and its shown items when the present user cancels removal', async () => {
        const { fixture, hook, sourceId, lastKnown } = await setup('cancel-remove', false);
        confirmation.accepted = false;
        onTestFinished(() => { confirmation.accepted = true; });
        await act(async () => {
            await expect(hook.getCurrent().mutations.delete(sourceId)).rejects.toMatchObject({ code: 'approval_canceled' });
        });
        expect(fixture.mutations).toEqual([]);
        expect(fixture.read()).toMatchObject({ revision: 4, record: { value: { sources: [{ id: sourceId, enabled: true }] } } });
        expect(hook.getCurrent().items).toBe(lastKnown);
    });
    it.each(['disable', 'remove'] as const)('withdraws the controller rich card in the first visible render of the changed source revision: %s', async operation => {
        const { fixture, sourceId, setUnavailable } = await setupHome(`controller-${operation}`);
        const observations: { revision: ReturnType<typeof usePromptLibraryCatalogValue>['revision']; entries: readonly string[]; canInstall: boolean }[] = [];
        const hook = await renderHook(() => {
            const state = usePluginCatalog();
            const mutations = useRegistrySourceMutations();
            const catalog = usePromptLibraryCatalogValue('registry-sources');
            React.useLayoutEffect(() => {
                observations.push({ revision: catalog.revision, entries: state.discoverEntries.map(entry => entry.id), canInstall: state.current });
            }, [catalog.revision, state.discoverEntries, state.current]);
            return { ...state, mutations };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().discoverSources.some(source => source.id === sourceId)).toBe(true));
        await act(async () => { hook.getCurrent().openDiscoverListing({ sourceId, pluginId: 'sample.plugin' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({
            id: 'sample.plugin', sourceId, title: 'Sample Plugin', version: '1.2.3', packageName: 'sample-plugin', installable: true,
        })));
        setUnavailable();
        observations.length = 0;
        if (operation === 'disable') await act(async () => { await hook.getCurrent().mutations.update({ sourceId, enabled: false }); });
        else await act(async () => { await hook.getCurrent().mutations.delete(sourceId); });
        expect(fixture.read().revision).toBe(5);
        const changedRevision = observations.filter(observation => observation.revision === 5);
        expect(changedRevision.length).toBeGreaterThan(0);
        expect(changedRevision.every(observation => observation.entries.length === 0 && !observation.canInstall)).toBe(true);
        expect(hook.getCurrent().discoverEntries).toEqual([]);
        expect(hook.getCurrent().current).toBe(false);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
});


it('retains a refused next-page Action as typed presenter input after its view retires', async () => {
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-next-page-refusal.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async url => new URL(url).pathname === '/v0.1/servers'
        ? Response.json({ servers: [{ server: { name: 'page/first', description: 'Remote server', version: '1.0.0' } }],
            metadata: { count: 1, nextCursor: 'second' } }) : null });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const hook = await renderHook(() => useRegistryItems({ kind: 'mcpServer', sourceIds: ['builtin:mcp-registry'] }));
    await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
    expect(hook.getCurrent().hasNextPage).toBe(true);
    const nextPage = hook.getCurrent().nextPage;
    await hook.unmount();
    const { RegistryActionFailure } = await import('./registryActionFailure');
    const { presentActionExecutionFailure } = await import('@/sync/ops/actions/resolveActionExecutionFailureMessage');
    const failure = await nextPage().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RegistryActionFailure);
    if (!(failure instanceof RegistryActionFailure)) throw new Error('Expected typed registry refusal');
    expect(failure.result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed', requestId: expect.any(String),
        details: { reason: 'client_account_scope_changed' } });
    expect(presentActionExecutionFailure(failure.result).technicalDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'requestId', value: failure.result.requestId }),
    ]));
});
