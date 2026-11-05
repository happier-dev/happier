import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { MarketplaceIndexSourceSnapshotV1Schema, deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

const platform = vi.hoisted(() => ({ value: 'web' }));
const confirmation = vi.hoisted(() => ({ accepted: true }));
installPromptRegistriesCommonModuleMocks({ storage: original => original(), reactNative: async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { get OS() { return platform.value; } } }), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { confirm: vi.fn(async () => confirmation.accepted) },
    }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
// Load the fixture's runtime graph at collection, without admitting a Home or
// writing credentials before Vitest installs its per-case storage boundary.
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const [{ useRegistryItems }, { useRegistrySourceMutations }, { useRegistrySuggestions }, { useSkillsHomepageModel }, { useRegistryItem }] = await Promise.all([
    import('./useRegistryItems'), import('./useRegistrySourceMutations'), import('./useRegistrySuggestions'),
    import('@/components/settings/skills/useSkillsHomepageModel'),
    import('./useRegistryItem'),
]);
const [{ usePluginSettingsScreenState }, { usePromptLibraryCatalogValue }] = await Promise.all([
    import('@/components/settings/plugins/model/usePluginSettingsScreenState'), import('@/sync/store/usePromptLibraryCatalog'),
]);
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useRegistrySourceRevision } = await import('./useRegistrySourceRevision');
const { useRegistrySources } = await import('./useRegistrySources');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue, beginPromptLibraryCatalogRowsLoad,
    applyPromptLibraryCatalogRowsSnapshot, applyPromptLibraryCatalogAcknowledgedRecord } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

async function setupHome(suffix: string) {
    const serverUrl = `https://registry-refresh-${suffix}.test`;
    const sourceUrl = `${serverUrl}/catalog.json`;
    const sourceId = deriveMarketplaceSourceId(sourceUrl);
    const catalog = createRegistryPluginCatalogFixture({ sourceUrl });
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
    return { fixture, sourceId, setUnavailable: () => { unavailable = true; }, setRateLimited: (next: boolean) => { rateLimited = next; } };
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
    it('reads curated skill picks through the mounted Action and real target adapter with no Machine', async () => {
        const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: {
            id: HAPPIER_PICKS_SOURCE_ID, title: 'Happier picks', kind: 'curated', sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
        }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [{
            kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: '',
        }] });
        const commit = '1'.repeat(40);
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-picks.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return Response.json(catalog);
            if (url.startsWith('https://api.github.com/repos/example/skills/commits/')) return Response.json({ sha: commit });
            if (url.includes('/git/trees/')) return Response.json({ sha: 'tree', tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 40 }] });
            if (url.startsWith('https://raw.githubusercontent.com/example/skills/')) return new Response('---\nname: review-changes\n---\nInstructions');
            return null;
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const { storage } = await import('@/sync/domains/state/storage');
        const hook = await renderHook(() => useSkillsHomepageModel({ scope: storage.getState().settingsScope, status: 'ready', items: [], stale: false, errorCode: null,
            usageObservedSince: null, retry() {} }, []));
        await waitForHomeGovernance(() => expect(hook.getCurrent().registryShelf.loading).toBe(false));
        expect(hook.getCurrent().registryShelf.items).toContainEqual(expect.objectContaining({ title: 'review-changes', flags: { pick: true }, version: commit }));
        expect(hook.getCurrent().registryShelf.sourceId).toBe(HAPPIER_PICKS_SOURCE_ID);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('quietly omits the web skill shelf instead of browsing skills.sh through a Machine when picks are empty or unreachable', async () => {
        let unavailable = false;
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-empty-picks.test', {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
        }, 'updated', { handleExternalRequest: async url => {
            expect(url).toBe(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL);
            return unavailable ? new Response(null, { status: 503 }) : Response.json(MarketplaceIndexSourceSnapshotV1Schema.parse({ source: {
                id: HAPPIER_PICKS_SOURCE_ID, title: 'Picks', kind: 'curated', sourceUrl: url,
            }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [] }));
        } });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const hook = await renderHook(() => useRegistrySuggestions('skill'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null });
        unavailable = true;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null, loading: false });
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
        setRateLimited(false);
        await act(async () => { await hook.getCurrent().sourceFailures[0]!.onRetry(); });
        expect(hook.getCurrent().pages[0]?.status.state).toBe('ok');
        expect(hook.getCurrent().sourceFailures).toEqual([]);
        expect(hook.getCurrent().items).toEqual(known);
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
            const state = usePluginSettingsScreenState();
            const catalog = usePromptLibraryCatalogValue('registry-sources');
            React.useLayoutEffect(() => {
                observations.push({ revision: catalog.revision, entries: state.discoverEntries.map(entry => entry.id), canInstall: state.canRunDiscoverActions });
            }, [catalog.revision, state.discoverEntries, state.canRunDiscoverActions]);
            return state;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().marketplaceSourceRegistryAvailable).toBe(true));
        await act(async () => { hook.getCurrent().openDiscoverListing({ sourceId, pluginId: 'sample.plugin' }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({
            id: 'sample.plugin', sourceId, title: 'Sample Plugin', version: '1.2.3', packageName: 'sample-plugin', installable: true,
        })));
        setUnavailable();
        observations.length = 0;
        if (operation === 'disable') await act(async () => { await hook.getCurrent().setMarketplaceSourceEnabled(sourceId, false); });
        else await act(async () => { await hook.getCurrent().removeMarketplaceSource(sourceId); });
        expect(fixture.read().revision).toBe(5);
        const changedRevision = observations.filter(observation => observation.revision === 5);
        expect(changedRevision.length).toBeGreaterThan(0);
        expect(changedRevision.every(observation => observation.entries.length === 0 && !observation.canInstall)).toBe(true);
        expect(hook.getCurrent().discoverEntries).toEqual([]);
        expect(hook.getCurrent().canRunDiscoverActions).toBe(false);
        expect(hook.getCurrent().executionMachineId).toBeNull();
    });
});
