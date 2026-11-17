import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { capabilityDismissalState } from '@/sync/domains/state/persistentUiState';

installDisconnectedServerSocketBoundary();
// A native inventory scan is the Machine transport boundary, never a library prerequisite.
const nativeScan = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: nativeScan }));
const { storage } = await import('@/sync/domains/state/storage');
const { observePromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { getPromptLibraryCatalogValue, getPromptLibraryCatalogSnapshot, beginPromptLibraryCatalogRowsLoad,
    applyPromptLibraryCatalogRowsSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useSkillsLibrary, readSkillsLibraryItems, peekSkillsLibraryItems } = await import('./useSkillsLibrary');
const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiDeclarationSources } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { useSkillsFirstRun } = await import('@/components/settings/skills/firstRun/useSkillsFirstRun');
const { useReachProjection } = await import('@/sync/domains/capabilities/reach/useReachProjection');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { SkillFoundListResultV1Schema, SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');
const { groupSkillsByFolder } = await import('@/components/settings/skills/skillsCollectionModel');

afterEach(() => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
});

it('reads only demanded skill ids without warming or replacing the full library', async () => {
    const home = await createSeededSkillsHome('https://skills-selected-demand.test', {
        skills: [{ id: 'visible-skill' }, { id: 'unrelated-skill' }],
    });
    const hook = await renderHook(() => useSkillsLibrary(undefined, { skillIds: ['visible-skill'] }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().items.map(item => item.skillId)).toEqual(['visible-skill']);
        const scope = hook.getCurrent().scope;
        if (!scope) throw new Error('Expected the selected library scope');
        expect(peekSkillsLibraryItems(scope)).toBeNull();
        expect(home.requests.filter(request => request.method === 'GET' && request.path === '/v1/artifacts')).toHaveLength(0);
        expect(home.requests.filter(request => request.path === '/v1/artifacts/unrelated-skill')).toHaveLength(0);
        const requests = home.requests.length;
        const items = hook.getCurrent().items;
        await act(async () => storage.getState().addArtifact({ id: 'unrelated-skill', kindHint: 'prompt_bundle.v2', title: null,
            headerVersion: 2, seq: 2, createdAt: 1, updatedAt: 2, storageMode: 'e2ee', isDecrypted: false,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }));
        await flushHookEffects();
        expect(hook.getCurrent().items).toBe(items);
        expect(home.requests).toHaveLength(requests);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('keeps an unpresented library cold and reads current skills only when demanded', async () => {
    const home = await createSeededSkillsHome('https://skills-presented-demand.test', { skills: [{ id: 'demanded-skill' }] });
    let enabled = false;
    const before = home.requests.length;
    const hook = await renderHook(() => useSkillsLibrary(undefined, { enabled }));
    try {
        await flushHookEffects();
        expect(home.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts')
            || request.path.startsWith('/v1/account/entity-rows/prompt-library'))).toHaveLength(0);
        enabled = true;
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent().items.some(item => item.skillId === 'demanded-skill')).toBe(true));
        expect(hook.getCurrent().status).toBe('ready');
    } finally { await hook.unmount(); await home.dispose(); }
});

it('keeps selected account metadata current without rereading it for unrelated plugin declarations', async () => {
    const home = await createSeededSkillsHome('https://skills-selected-plugin.test', { skills: [{ id: 'selected' }] });
    const { projectPluginSkillDeclarationV1 } = await import('@happier-dev/protocol/plugins/contributions/skills');
    const entry = projectPluginSkillDeclarationV1({ pluginId: 'com.acme.skills', pluginVersion: '1.0.0',
        definition: { id: 'unrelated', directory: './unrelated' } });
    let library: ReturnType<typeof useSkillsLibrary> | undefined;
    const Probe = React.memo(function SelectedLibraryProbe() { library = useSkillsLibrary(undefined, { skillIds: ['selected'] }); return null; });
    const child = <Probe />;
    const value = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current' as const, interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
        connectedAccountProjectionRevision: 1, clientExecutableActivation: { status: 'ready' as const },
        reloadConnectedAccountProjection() {}, reloadClientExecutables() {} };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{child}</AppShellPluginUiProjectionValueProvider>);
    try {
        await vi.waitFor(() => expect(library).toMatchObject({ status: 'ready', stale: false }));
        const items = library!.items;
        const reads = home.requests.length;
        await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value,
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [entry.id]: entry } } }}>{child}</AppShellPluginUiProjectionValueProvider>);
        await flushHookEffects();
        expect(library).toMatchObject({ status: 'ready', stale: false });
        expect(library!.items).toBe(items);
        expect(home.requests).toHaveLength(reads);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('marks changed Skills stale before paint with exact bundle membership despite an unrelated locked row', async () => {
    const home = await createSeededSkillsHome('https://skills-scoped-membership.test', { skills: [{ id: 'changing' }] });
    const observations: Array<{ revision: string | undefined; stale: boolean }> = [];
    const hook = await renderHook(() => {
        const library = useSkillsLibrary();
        React.useLayoutEffect(() => { observations.push({ revision: library.items.find(item => item.skillId === 'changing')?.revision,
            stale: library.stale }); });
        return library;
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(home.home.id);
        try {
            await act(async () => {
                const current = await account.fetchArtifact('changing');
                if (!current?.isDecrypted) throw new Error('Expected admitted skill');
                storage.getState().applyArtifacts([current], storage.getState().artifacts, ['prompt_bundle.v2']);
                storage.getState().addArtifact({ id: 'locked-role', kindHint: 'role.v1', title: null,
                    headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'e2ee', isDecrypted: false,
                    availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
            });
        } finally { account.dispose(); }
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
        const row = home.boundary.read('changing')!;
        home.boundary.replaceStoredRow({ ...row, bodyVersion: 2 });
        observations.length = 0;
        await act(async () => storage.getState().updateArtifact({ ...storage.getState().artifacts.changing!, bodyVersion: 2 }));
        expect(observations[0]).toEqual({ revision: '1:1', stale: true });
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'changing')?.revision).toBe('1:2'));
        expect(hook.getCurrent().stale).toBe(false);
        expect(storage.getState().artifactsLoaded).toBe(false);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('marks browser-proven Skills membership removal stale before paint without claiming full inventory', async () => {
    const home = await createSeededSkillsHome('https://skills-browser-membership.test', { skills: [{ id: 'browser-skill' }] });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(home.home.id);
    try {
        const current = await account.fetchArtifact('browser-skill');
        if (!current?.isDecrypted) throw new Error('Expected admitted skill');
        storage.getState().applyArtifacts([current], storage.getState().artifacts, 'browserListed');
    } finally { account.dispose(); }
    const observations: boolean[] = [];
    const hook = await renderHook(() => {
        const library = useSkillsLibrary();
        React.useLayoutEffect(() => { observations.push(library.stale); });
        return library;
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false,
            items: expect.arrayContaining([expect.objectContaining({ skillId: 'browser-skill' })]) }));
        expect(storage.getState().artifactsLoaded).toBe(false);
        expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
        home.boundary.clear();
        observations.length = 0;
        await act(async () => storage.getState().applyArtifacts([], storage.getState().artifacts, 'browserListed'));
        expect(observations[0]).toBe(true);
        await vi.waitFor(() => expect(hook.getCurrent().items.some(item => item.skillId === 'browser-skill')).toBe(false));
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false });
    } finally { await hook.unmount(); await home.dispose(); }
});

it.each([false, true])('re-observes Skills once when a new opaque row makes known bundle membership uncertain (unreadable: %s)', async unreadable => {
    const home = await createSeededSkillsHome(`https://skills-opaque-arrival-${unreadable}.test`, { skills: [{ id: 'known-skill' }] });
    const observations: boolean[] = [];
    const hook = await renderHook(() => {
        const library = useSkillsLibrary();
        React.useLayoutEffect(() => { observations.push(library.stale); });
        return library;
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(home.home.id);
        try {
            await act(async () => {
                const current = await account.fetchArtifact('known-skill');
                if (!current?.isDecrypted) throw new Error('Expected admitted skill');
                storage.getState().applyArtifacts([current], storage.getState().artifacts, ['prompt_bundle.v2']);
            });
        } finally { account.dispose(); }
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
        const row = home.boundary.read('known-skill')!;
        home.boundary.replaceStoredRow({ ...row, id: 'new-opaque-skill',
            ...(unreadable ? { kind: null, kindHint: undefined, header: 'invalid-stored-header' } : {}) });
        const before = home.requests.length;
        observations.length = 0;
        await act(async () => storage.getState().addArtifact({ id: 'new-opaque-skill', title: null,
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'plain', isDecrypted: false,
            availability: { kind: 'locked', reason: 'invalid_stored_content' } }));
        expect(observations[0]).toBe(true);
        if (unreadable) {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', stale: true }));
            expect(hook.getCurrent().items.some(item => item.skillId === 'known-skill')).toBe(true);
        } else {
            await vi.waitFor(() => expect(hook.getCurrent().items.some(item => item.skillId === 'new-opaque-skill')).toBe(true));
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false });
        }
        await flushHookEffects();
        const lists = () => home.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts?'));
        if (!unreadable) expect(lists()).toHaveLength(1);
        const observedReads = lists().length;
        expect(observedReads).toBeGreaterThan(0);
        await flushHookEffects();
        expect(lists()).toHaveLength(observedReads);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('does no library render or read work for unrelated publications at Account scale and retains unchanged skill rows', async () => {
    const home = await createSeededSkillsHome('https://skills-arrival-cost.test', {
        skills: Array.from({ length: 139 }, (_, i) => ({ id: `cost-skill-${i}` })),
    });
    const unrelated = Array.from({ length: 1000 }, (_, i) => ({
        id: `unrelated-${i}`, title: 'Unrelated document', header: { kind: 'markdown', title: 'Unrelated document' },
        rawHeader: { kind: 'markdown', title: 'Unrelated document' }, access: 'owner' as const,
        ownerAccountId: 'artifact-account', isDecrypted: true as const, headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1,
    }));
    storage.getState().applyArtifacts(unrelated);
    let renders = 0;
    let library: ReturnType<typeof useSkillsLibrary> | undefined;
    const rowRenders = new Map<string, number>();
    const Row = React.memo(function Row({ item }: { item: NonNullable<typeof library>['items'][number] }) {
        rowRenders.set(item.skillId, (rowRenders.get(item.skillId) ?? 0) + 1);
        return null;
    });
    function ListProbe() {
        renders++;
        library = useSkillsLibrary();
        return <>{library.items.map(item => <Row key={item.skillId} item={item} />)}</>;
    }
    const screen = await renderScreen(<ListProbe />);
    try {
        await vi.waitFor(() => expect(library?.items.filter(item => item.skillId.startsWith('cost-skill-'))).toHaveLength(139));
        await vi.waitFor(() => expect(library?.status).toBe('ready'));
        await flushHookEffects();
        const settled = renders;
        const items = library?.items;
        const reads = home.requests.length;
        rowRenders.clear();
        for (let i = 0; i < 5; i++) {
            await act(async () => storage.getState().updateArtifact({ ...unrelated[i]!, headerVersion: 2, updatedAt: 2 }));
        }
        console.info('Skills unrelated arrival cost', { publications: 5, libraryRenders: renders - settled,
            rowRenders: [...rowRenders.values()].reduce((a, b) => a + b, 0), requests: home.requests.length - reads });
        expect(renders - settled).toBe(0);
        expect(library?.items).toBe(items);
        expect(rowRenders.size).toBe(0);
        expect(home.requests).toHaveLength(reads);
        await act(async () => {
            const result = await createDefaultActionExecutor().execute('skills.update', {
                skillId: 'cost-skill-0', expectedRevision: '1:1', name: 'changed',
            }, { serverId: home.home.id, surface: 'ui', authority: 'present_user' });
            expect(result).toMatchObject({ ok: true });
        });
        await vi.waitFor(() => expect(library?.items.find(item => item.skillId === 'cost-skill-0')?.name).toBe('changed'));
        expect([...rowRenders.keys()]).toEqual(['cost-skill-0']);
        expect(rowRenders.get('cost-skill-0')).toBe(1);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('does not rerender the real library for executable-only AppShell updates', async () => {
    const home = await createSeededSkillsHome('https://skills-declaration-subscription.test', { skills: [{ id: 'stable-skill' }] });
    let renders = 0;
    let library: ReturnType<typeof useSkillsLibrary> | undefined;
    const Probe = React.memo(function LibraryProbe() {
        renders += 1;
        library = useSkillsLibrary();
        return null;
    });
    const child = <Probe />;
    const value = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current' as const, interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
        connectedAccountProjectionRevision: 1, clientExecutableActivation: { status: 'ready' as const },
        reloadConnectedAccountProjection() {}, reloadClientExecutables() {},
    };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{child}</AppShellPluginUiProjectionValueProvider>);
    try {
        await vi.waitFor(() => expect(library?.status).toBe('ready'));
        await flushHookEffects();
        const settled = renders;
        const retainedItems = library?.items;
        const reads = home.requests.length;
        await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value,
            connectedAccountProjectionRevision: 2, clientExecutableActivation: { status: 'establishing' } }}>{child}</AppShellPluginUiProjectionValueProvider>);
        expect(renders).toBe(settled);
        expect(library?.items).toBe(retainedItems);
        expect(home.requests).toHaveLength(reads);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('does not render read-only Skills observers for unchanged rule and usage freshness transitions', async () => {
    const home = await createSeededSkillsHome('https://skills-rule-freshness-cost.test', { skills: [{ id: 'stable-rules' }],
        records: [{ key: 'skill-rules', value: { v: 1, rules: [{ id: 'returning-rule', skillId: 'stable-rules',
            target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] } }] });
    let libraryRenders = 0;
    let firstRunRenders = 0;
    const library = await renderHook(() => { libraryRenders++; return useSkillsLibrary(); });
    await vi.waitFor(() => expect(library.getCurrent().status).toBe('ready'));
    const items = library.getCurrent().items;
    const firstRun = await renderHook(() => { firstRunRenders++; return useSkillsFirstRun(items); });
    try {
        await flushHookEffects();
        expect(firstRun.getCurrent().firstVisit).toBeNull();
        const scope = library.getCurrent().scope!;
        const received = getPromptLibraryCatalogSnapshot(scope)!;
        const before = { library: libraryRenders, firstRun: firstRunRenders, reads: home.requests.length };
        for (let i = 0; i < 5; i++) {
            await act(async () => beginPromptLibraryCatalogRowsLoad(scope, ['skill-rules', 'skill-usage']));
            await act(async () => applyPromptLibraryCatalogRowsSnapshot(scope, ['skill-rules', 'skill-usage'], received, true));
        }
        expect(libraryRenders - before.library).toBe(0);
        expect(firstRunRenders - before.firstRun).toBe(0);
        expect(home.requests).toHaveLength(before.reads);
    } finally { await firstRun.unmount(); await library.unmount(); await home.dispose(); }
});

it('does not serialize unchanged Skills declarations when the real library observes a new declaration publication', async () => {
    const home = await createSeededSkillsHome('https://skills-source-revision.test', { skills: [{ id: 'unchanged-source' }] });
    let renders = 0;
    let library: ReturnType<typeof useSkillsLibrary> | undefined;
    const Probe = React.memo(function LibraryProbe() { renders++; library = useSkillsLibrary(); return null; });
    const child = <Probe />;
    const value = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current' as const, interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
        connectedAccountProjectionRevision: 1, clientExecutableActivation: { status: 'ready' as const },
        reloadConnectedAccountProjection() {}, reloadClientExecutables() {},
    };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{child}</AppShellPluginUiProjectionValueProvider>);
    let serializations = 0;
    const original = JSON.stringify;
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
        // Count the real revision path, not unrelated HTTP/schema serialization.
        const stack = new Error().stack;
        if (stack?.includes('uiPluginSkillSourceRevisionV1') || stack?.includes('pluginSkillSourceIdentity')) serializations++;
        return Reflect.apply(original, JSON, args);
    });
    try {
        await vi.waitFor(() => expect(library?.status).toBe('ready'));
        await flushHookEffects();
        const settled = renders;
        const items = library?.items;
        const reads = home.requests.length;
        serializations = 0;
        for (let generation = 1; generation <= 5; generation++) {
            await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value,
                pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation } }}>{child}</AppShellPluginUiProjectionValueProvider>);
        }
        expect(renders).toBeGreaterThan(settled);
        expect(library?.items).toBe(items);
        expect(home.requests).toHaveLength(reads);
        console.info('Skills unchanged declaration publications', { publications: 5, serializations });
        expect(serializations).toBe(0);
    } finally { stringify.mockRestore(); await screen.unmount(); await home.dispose(); }
});

it('marks the retained complete library stale in the first layout after Skills declaration replacement or withdrawal', async () => {
    const home = await createSeededSkillsHome('https://skills-source-layout.test', { skills: [] });
    storage.setState({ artifactsLoaded: true });
    const { projectPluginSkillDeclarationV1 } = await import('@happier-dev/protocol/plugins/contributions/skills');
    const entry = projectPluginSkillDeclarationV1({ pluginId: 'com.acme.skills', pluginVersion: '2.0.0',
        definition: { id: 'check', directory: './resources/check-v2' } });
    const changedProjection = { ...EMPTY_PLUGIN_UI_PROJECTION, skillsById: { [entry.id]: entry } };
    const observed: Array<Readonly<{ status: string; stale: boolean; source: ReturnType<typeof useAppShellPluginUiDeclarationSources> }>> = [];
    let library: ReturnType<typeof useSkillsLibrary> | undefined;
    const Probe = React.memo(function LibraryProbe() {
        const current = useSkillsLibrary();
        const source = useAppShellPluginUiDeclarationSources();
        library = current;
        React.useLayoutEffect(() => { observed.push({ status: current.status, stale: current.stale, source }); });
        return null;
    });
    const child = <Probe />;
    const value = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current' as const, interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
        connectedAccountProjectionRevision: 1, clientExecutableActivation: { status: 'ready' as const },
        reloadConnectedAccountProjection() {}, reloadClientExecutables() {},
    };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{child}</AppShellPluginUiProjectionValueProvider>);
    try {
        expect(observed[0]?.source).toMatchObject({ projection: null, accountLifetime: value.accountLifetime, ready: false });
        await vi.waitFor(() => expect(library).toMatchObject({ status: 'ready', stale: false }));
        const firstIdentity = observed.at(-1)?.source.skillSourceIdentity;
        observed.length = 0;
        await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value,
            pluginUiProjection: changedProjection }}>{child}</AppShellPluginUiProjectionValueProvider>);
        expect(observed[0]).toMatchObject({ status: 'ready', stale: true });
        expect(observed[0]?.source).toMatchObject({ projection: changedProjection, accountLifetime: value.accountLifetime, ready: true });
        expect(observed[0]?.source.skillSourceIdentity).not.toBe(firstIdentity);
        observed.length = 0;
        await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value,
            pluginUiProjection: null }}>{child}</AppShellPluginUiProjectionValueProvider>);
        expect(observed[0]).toMatchObject({ stale: true });
        expect(observed[0]?.source.projection).toBeNull();
        const lifetime = value.accountLifetime;
        if (!lifetime) throw new Error('Expected the real Account lifetime');
        await act(async () => {
            storage.getState().activateProfileScope({ ...lifetime.scope, accountId: 'replacement-account' });
            captureActiveServerAccountScopeLifetime();
        });
        expect(lifetime.isCurrent()).toBe(false);
        expect(observed.at(-1)?.source).toMatchObject({ projection: null, accountLifetime: lifetime, ready: false });
    } finally { await screen.unmount(); await home.dispose(); }
});

it.each(['local', 'remote'] as const)('updates a mounted library after a %s reach mutation without reload', async origin => {
    const home = await createSeededSkillsHome(`https://skills-reach-${origin}.test`, {
        skills: [{ id: 'reach-skill' }, { id: 'unchanged-skill' }],
        records: [{ key: 'skill-rules', value: { v: 1, rules: [{ id: 'reach-on', skillId: 'reach-skill',
            target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] } }],
    });
    const hook = await renderHook(() => useSkillsLibrary());
    const contentReads = () => home.requests.filter(request => request.path === '/v1/artifacts/read'
        || request.method === 'GET' && ['/v1/artifacts/reach-skill', '/v1/artifacts/unchanged-skill'].includes(request.path)).length;
    try {
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().items.find(item => item.skillId === 'reach-skill')?.rules[0]?.enabled).toBe(true);
        const opened = contentReads();
        const unchanged = hook.getCurrent().items.find(item => item.skillId === 'unchanged-skill');
        const codecs = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
        const decrypts = vi.spyOn(codecs, 'openPromptLibraryContentV1');
        for (const enabled of [false, true]) {
            const requestStart = home.requests.length;
            decrypts.mockClear();
            await act(async () => {
                if (origin === 'local') {
                    const result = await createDefaultActionExecutor().execute('skills.rules.set', {
                        items: [{ skillId: 'reach-skill' }],
                        change: { kind: 'write', write: { place: { t: 'allMachines' }, state: enabled ? 'on' : 'off' } },
                    }, { serverId: home.home.id, surface: 'ui', authority: 'present_user' });
                    expect(result).toMatchObject({ ok: true, result: { ok: true } });
                } else {
                    const record = home.catalog.read('skill-rules');
                    if (record.key !== 'skill-rules') throw new Error('Expected skill rules');
                    const response = await home.catalog.handle('/v1/account/entity-rows/prompt-library/skill-rules', {
                        method: 'POST', body: JSON.stringify({ expectedRevision: home.catalog.revision('skill-rules'),
                            content: { t: 'plain', v: { ...record, value: { ...record.value,
                                rules: record.value.rules.map(rule => ({ ...rule, enabled, updatedAt: rule.updatedAt + 1 })) } } } }),
                    });
                    expect(await response?.json()).toMatchObject({ status: 'updated' });
                    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
                    publishHomeAccountChange(home.home.id, undefined, { source: 'catch-up-pending' });
                }
            });
            await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'reach-skill')?.rules[0]?.enabled).toBe(enabled));
            expect(hook.getCurrent().items.filter(item => item.rules.some(rule => rule.enabled)).length).toBe(enabled ? 1 : 0);
            expect(hook.getCurrent().items.find(item => item.skillId === 'unchanged-skill')).toBe(unchanged);
            // The local writer validates its addressed skill; a rules-only remote
            // publication does not reopen content through either transport.
            if (origin === 'remote') {
                const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
                const { buildPromptLibraryPhysicalKeyV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
                const entityId = buildPromptLibraryPhysicalKeyV1('skill-rules');
                await act(async () => publishHomeAccountChange(home.home.id, [entityId], {
                    entityRevisions: { [entityId]: home.catalog.revision('skill-rules') }, changeKinds: ['account'],
                }));
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(contentReads()).toBe(opened);
                expect(home.requests.slice(requestStart).filter(r => r.path.includes('prompt-library') || r.path.includes('/artifacts')
                    || r.path.includes('/account/settings')).map(r => `${r.method} ${r.path}`))
                    .toEqual(['GET /v1/account/entity-rows/prompt-library/skill-rules']);
            }
            const requests = home.requests.slice(requestStart).map(({ method, path }) => ({ method, path }));
            console.info(JSON.stringify({ phase: origin, enabled, requests, rowDecrypts: decrypts.mock.calls.length,
                bodyReads: requests.filter(r => r.path.includes('/artifacts/') && r.method !== 'POST').length }));
        }
        decrypts.mockRestore();
    } finally { await hook.unmount(); await home.dispose(); }
});

it.each(['move', 'clear', 'delete'] as const)('retains admitted personal placement through name withdrawal/recovery after %s, without reopening content', async change => {
    const home = await createSeededSkillsHome(`https://skills-personal-folders-${change}.test`, {
        skills: [{ id: 'moving', header: { folderId: 'old' } }, { id: 'unchanged' }],
        records: [{ key: 'folders', value: { v: 1, folders: [
            { id: 'old', name: 'Old' }, { id: 'work', name: 'Work' },
        ] } }],
    });
    const hook = await renderHook(() => useSkillsLibrary());
    try {
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'moving')?.folderId).toBe('old'));
        const folderGroups = () => {
            const current = hook.getCurrent();
            const folders = getPromptLibraryCatalogValue(current.scope, 'folders');
            return groupSkillsByFolder(current.items, folders.value);
        };
        // The Action's placement ids and the observed Account catalog share the same namespace.
        expect(folderGroups()?.find(group => group.id === 'old')).toMatchObject({ title: 'Old' });
        const unchanged = hook.getCurrent().items.find(item => item.skillId === 'unchanged');
        expect(unchanged).toBeDefined();
        const contentReads = () => home.requests.filter(request => request.path === '/v1/artifacts/read' && request.projection !== 'headers'
            || request.method === 'GET' && ['/v1/artifacts/moving', '/v1/artifacts/unchanged'].includes(request.path)).length;
        const opened = contentReads();
        expect(opened).toBeGreaterThan(0);
        const folderId = change === 'move' ? 'work' : null;
        await act(async () => {
            const result = change === 'delete'
                ? await createDefaultActionExecutor().execute('artifact.folders.delete', {
                    folderId: 'old', expectedRevision: home.catalog.revision('folders'),
                }, { serverId: home.home.id, surface: 'ui', authority: 'present_user' })
                : await createDefaultActionExecutor().execute('artifact.folder.set', {
                    artifactId: 'moving', folderId, expectedRevision: home.catalog.revision('folders'),
                }, { serverId: home.home.id, surface: 'ui', authority: 'present_user' });
            expect(result).toMatchObject({ ok: true, result: { status: 'updated' } });
        });
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'moving')?.folderId).toBe(folderId));
        const scope = hook.getCurrent().scope!;
        const received = getPromptLibraryCatalogSnapshot(scope)!;
        const admitted = hook.getCurrent().items;
        const assertPlacement = (namesRead = true) => {
            expect(hook.getCurrent().items.find(item => item.skillId === 'moving')?.folderId).toBe(folderId);
            if (folderId === null) expect(folderGroups()).toBeNull();
            else if (namesRead) expect(folderGroups()?.map(group => group.id)).toEqual(['work', null]);
            else {
                // Names withdrawn: the filed row stays filed, in the one shared unnamed section above the unfiled rows.
                const groups = folderGroups()!;
                expect(groups).toHaveLength(2);
                expect(groups[0]!.id).not.toBeNull();
                expect(groups[0]!.rows.map(row => row.skillId)).toEqual(['moving']);
                expect(groups[1]!.id).toBeNull();
            }
            expect(hook.getCurrent().items.find(item => item.skillId === 'unchanged')).toBe(unchanged);
            expect(contentReads()).toBe(opened);
        };
        assertPlacement();
        await act(async () => applyPromptLibraryCatalogRowsSnapshot(scope, ['folders'], { ...received,
            catalog: { status: 'partial', rows: [], tombstones: [], diagnostics: [{ key: 'folders', revision: 'absent',
                reason: 'invalid-stored-content' }] } }, true));
        expect(getPromptLibraryCatalogValue(scope, 'folders').value).toBeNull();
        assertPlacement(false);
        expect(hook.getCurrent().items).toBe(admitted);
        expect(peekSkillsLibraryItems(scope)?.find(item => item.skillId === 'moving')?.folderId).toBe(folderId);
        if (folderId !== null) expect(folderGroups()?.find(group => group.id === folderId)?.title).not.toBe('Work');
        await act(async () => applyPromptLibraryCatalogRowsSnapshot(scope, ['folders'], received, true));
        assertPlacement();
        expect(hook.getCurrent().items).toBe(admitted);
        if (folderId !== null) expect(folderGroups()?.find(group => group.id === folderId)).toMatchObject({ title: 'Work' });
    } finally { await hook.unmount(); await home.dispose(); }
});

it('keeps a complete cold library current through unchanged partial header publication and still reads edits and removals', async () => {
    const home = await createSeededSkillsHome('https://skills-partial-publication.test', {
        skills: [{ id: 'published' }, { id: 'other' }],
    });
    const hook = await renderHook(() => useSkillsLibrary());
    const readsOf = (id: string) => home.requests.filter(request => request.path === '/v1/artifacts/read'
        || request.method === 'GET' && request.path === `/v1/artifacts/${id}`).length;
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }), { timeout: 10_000 });
        expect(storage.getState().artifactsLoaded).toBe(false);
        expect(readsOf('other')).toBe(1);
        const rows = hook.getCurrent().items;
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(home.home.id);
        try {
            // An addressed sync publication is not a new version of content the list already opened.
            await act(async () => { await account.fetchArtifact('published'); });
        } finally { account.dispose(); }
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
        expect(hook.getCurrent().items).toBe(rows);
        expect(readsOf('other')).toBe(1);

        const row = home.boundary.read('published')!;
        home.boundary.replaceStoredRow({ ...row, bodyVersion: 2 });
        const published = storage.getState().artifacts.published!;
        await act(async () => storage.getState().updateArtifact({ ...published, bodyVersion: 2 }));
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'published')?.revision).toBe('1:2'));
        expect(readsOf('other')).toBe(2);

        expect((await home.boundary.handle('/v1/artifacts/published', { method: 'DELETE' }))?.status).toBe(200);
        await act(async () => storage.getState().deleteArtifact('published'));
        await vi.waitFor(() => expect(hook.getCurrent().items.some(item => item.skillId === 'published')).toBe(false));
        expect(readsOf('other')).toBe(3);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('reissues a picker read after the first open fails without substituting an empty success', async () => {
    let unavailable = true;
    let reads = 0;
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skills-picker-recovery.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
                reads++;
                if (unavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const scope = { serverId: home.home.id, accountId: 'artifact-account' };
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    try {
        expect(await readSkillsLibraryItems(scope)).toBeNull();
        const failedReads = reads;
        expect(failedReads).toBeGreaterThan(0);
        unavailable = false;
        const recovered = await readSkillsLibraryItems(scope);
        expect(recovered?.some(item => item.provenance.kind === 'first_party')).toBe(true);
        expect(reads).toBeGreaterThan(failedReads);
    } finally { await home.dispose(); }
});

it('publishes the rail library and rules while native inventory is pending, then fills Machine facts without rereading the library', async () => {
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'skill-rules', value: { v: 1, rules: [
        { id: 'rail-on', skillId: 'rail-skill', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
    ] } }] });
    let libraryReads = 0;
    const home = await createPlainArtifactHomeFixture('https://skills-pending-native.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') libraryReads++;
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const qualifiedHome = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1, homeServerIdentityId: 'srv_skills_pending_native',
        canonicalServerUrl: 'https://skills-pending-native.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://skills-pending-native.test' }] } });
    if (!qualifiedHome.serverIdentityId) throw new Error('Expected qualified Home');
    await setActiveServerId(qualifiedHome.id);
    const scope = { serverId: qualifiedHome.serverIdentityId, accountId: 'artifact-account' };
    const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'rail-skill', bundleSchemaId: 'skills.skill_md_v1' });
    const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: rail-skill\n---\nReview the current diff.')) }] });
    expect((await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'rail-skill',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) }))?.status).toBe(200);
    const deferred = createDeferred<unknown>();
    nativeScan.mockReset(); nativeScan.mockReturnValue(deferred.promise);
    let scanSettled = false;
    const scan = createDefaultActionExecutor().execute('skills.found.list', { machineId: 'native-machine' }, {
        serverId: scope.serverId, surface: 'ui', authority: 'present_user',
    }).finally(() => { scanSettled = true; });
    storage.setState({ settingsScope: scope, profileScope: scope, isDataReady: true, artifactsLoaded: false, machines: {}, machineDisplayById: {},
        machineListByServerId: { [scope.serverId]: [] }, machineListStatusByServerId: { [scope.serverId]: 'loading' } });
    const hook = await renderHook(() => ({ library: useSkillsLibrary(), reach: useReachProjection('skill', 'rail-skill') }));
    try {
        await vi.waitFor(() => expect(nativeScan).toHaveBeenCalled());
        await vi.waitFor(() => expect(hook.getCurrent().library.status).toBe('ready'), { timeout: 10_000 });
        expect(scanSettled).toBe(false);
        expect(hook.getCurrent().library.items.find(item => item.skillId === 'rail-skill')).toMatchObject({ rules: [{ enabled: true }] });
        expect(hook.getCurrent().reach).toEqual([]);
        const rows = hook.getCurrent().library.items;
        const readsBeforeMachine = libraryReads;
        const machine = createMachineFixture({ id: 'native-machine', active: true, activeAt: Date.now() });
        machine.metadata = { ...machine.metadata!, platform: 'linux', agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } };
        await act(async () => {
            storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
            storage.getState().markMachineListSettled(scope.serverId);
        });
        await vi.waitFor(() => expect(hook.getCurrent().reach).toMatchObject([{ machineId: machine.id, agents: [{ agentId: 'codex', enabled: true }] }]));
        expect(hook.getCurrent().library.items).toBe(rows);
        expect(libraryReads).toBe(readsBeforeMachine);
        const producer = SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [] });
        deferred.resolve(producer);
        const receipt = await scan;
        expect(receipt).toMatchObject({ ok: true });
        if (receipt.ok) SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1['skills.found.list'].parse(receipt.result);
    } finally {
        deferred.resolve(SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [] }));
        await scan;
        await hook.unmount(); await home.dispose();
    }
});

it.each(['mounted', 'picker'] as const)('shares ready catalog authority and the real library read across simultaneous rail detail and picker observers (%s first)', async first => {
    let inventories = 0;
    let holdCatalogReads = false;
    const catalogRead = createDeferred<void>();
    const inventoryRead = createDeferred<void>();
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skills-observers.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path === '/v1/account/entity-rows/prompt-library' && holdCatalogReads) await catalogRead.promise;
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') { inventories++; await inventoryRead.promise; }
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return catalog.handle(path, init);
        },
    });
    // No inventory has been published: exercise the real cold Account read.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected Account scope');
    const stopCatalogObservation = observePromptLibraryCatalog(scope);
    await vi.waitFor(() => expect(getPromptLibraryCatalogValue(scope, 'skill-rules').status).toBe('ready'));
    // A list borrows the current publication. A fresh mutation-base read may
    // wait on Home, but it must not hold this already-admitted library hostage.
    holdCatalogReads = true;
    const earlierPicker = first === 'picker' ? readSkillsLibraryItems(scope) : null;
    const hook = await renderHook(() => ({ rail: useSkillsLibrary(), detail: useSkillsLibrary() }));
    const picker = earlierPicker ?? readSkillsLibraryItems(scope);
    try {
        await vi.waitFor(() => expect(inventories).toBeGreaterThan(0));
        inventoryRead.resolve();
        await picker;
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rail: { status: 'ready' }, detail: { status: 'ready' } }), { timeout: 10_000 });
        expect(hook.getCurrent().rail.items).toEqual(hook.getCurrent().detail.items);
        // Each inventory opens the Account's encrypted Artifact headers; duplicate reads are material work.
        expect(inventories).toBe(1);
        await readSkillsLibraryItems(scope);
        expect(inventories).toBe(2); // Settlement is not a retained cache: reopening reads again.
    } finally {
        inventoryRead.resolve();
        catalogRead.resolve();
        await picker;
        await hook.unmount(); stopCatalogObservation(); await home.dispose();
    }
});

it.each([false, true, 'opaque'] as const)('starts cold content before rules and preserves revision freshness (edit during read: %s)', async editDuringRead => {
    const catalogReady = createDeferred<void>();
    const bodyReady = createDeferred<void>();
    let inventories = 0;
    let bodyReads = 0;
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture(`https://skills-cold-critical-path-${editDuringRead}.test`, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path === '/v1/account/entity-rows/prompt-library') await catalogReady.promise;
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') inventories++;
            if (path === '/v1/artifacts/read' || path === '/v1/artifacts/cold-skill' && (init?.method ?? 'GET') === 'GET') {
                bodyReads++;
                const response = await home.boundary.handle(path, init);
                await bodyReady.promise;
                return response;
            }
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'cold-skill', bundleSchemaId: 'skills.skill_md_v1' });
    const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: cold-skill\ndescription: Original\n---\nInstructions.')) }] });
    await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'cold-skill',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
    storage.setState({ isDataReady: true, artifactsLoaded: false, artifacts: {}, artifactSkillRevisions: {}, artifactInventoryUnreadyCount: 0 });
    const hook = await renderHook(() => useSkillsLibrary());
    try {
        // The real Action must reach the content transport while the rules census is held.
        await vi.waitFor(() => expect(bodyReads).toBe(1));
        expect(hook.getCurrent().status).toBe('loading');
        catalogReady.resolve();
        const replaceBody = (description: string, bodyVersion: number) => {
            const row = home.boundary.read('cold-skill')!;
            const updatedBody = { ...body, entries: [{ ...body.entries[0]!,
                contentBase64: encodeBase64(new TextEncoder().encode(`---\nname: cold-skill\ndescription: ${description}\n---\nInstructions.`)) }] };
            home.boundary.replaceStoredRow({ ...row, bodyVersion, updatedAt: row.updatedAt + 1,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(updatedBody) }) });
        };
        if (editDuringRead === true) replaceBody('Concurrent', 2);
        if (editDuringRead === 'opaque') {
            home.boundary.replaceStoredRow({ ...home.boundary.read('cold-skill')!, id: 'new-opaque-skill' });
            await act(async () => storage.getState().addArtifact({ id: 'new-opaque-skill', title: null,
                headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'plain', isDecrypted: false,
                availability: { kind: 'locked', reason: 'invalid_stored_content' } }));
        } else {
            const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
            const { withUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
            await act(async () => withUiPromptLibraryArtifactStore(async (_store, account) => {
                const basis = storage.getState().artifacts;
                await fetchAndApplyArtifactsList({ credentials: account.credentials, request: account.request,
                    encryption: null, artifactDataKeys: new Map(),
                    applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? basis : undefined) });
            }, { serverId: home.home.id }));
        }
        // Partial sync can publish headers already covered by this pending
        // complete Action result; that is not a content edit or a new read.
        if (!editDuringRead) await act(async () => storage.setState({ artifactsLoaded: false }));
        bodyReady.resolve();
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }), { timeout: 10_000 });
        if (editDuringRead === 'opaque') {
            expect(hook.getCurrent().items.some(item => item.skillId === 'new-opaque-skill')).toBe(true);
            expect(bodyReads).toBe(2);
            expect(inventories).toBe(2);
            return;
        }
        expect(hook.getCurrent().items.find(item => item.skillId === 'cold-skill')).toMatchObject(editDuringRead
            ? { revision: '1:2', description: 'Concurrent' } : { revision: '1:1', description: 'Original' });
        expect(bodyReads).toBe(editDuringRead ? 2 : 1);
        expect(inventories).toBe(2); // One cold Action scan plus the shared inventory publication.
        const nextVersion = editDuringRead ? 3 : 2;
        replaceBody('Changed', nextVersion);
        const projected = storage.getState().artifacts['cold-skill']!;
        await act(async () => storage.getState().updateArtifact({ ...projected, bodyVersion: nextVersion }));
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'cold-skill'))
            .toMatchObject({ revision: `1:${nextVersion}`, description: 'Changed' }), { timeout: 10_000 });
        expect(bodyReads).toBe(editDuringRead ? 3 : 2);
    } finally {
        catalogReady.resolve(); bodyReady.resolve();
        await hook.unmount(); await home.dispose();
    }
});

it('joins the usage row, ranks/preselects Off skills and writes one real bulk reach Action before dismissing', async () => {
    let usageUnavailable = false;
    let failRules = true;
    const catalog = createPromptLibraryCatalogBoundary({ records: [
        { key: 'skill-usage', value: { v: 1, lastUsedAt: { older: 100, recent: 123, deleted: 10 } } },
    ] });
    const home = await createPlainArtifactHomeFixture('https://skills-first-run.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/account/entity-rows/prompt-library/skill-rules' && init?.method === 'POST' && failRules)
                return Response.json({ status: 'conflict', revision: catalog.revision('skill-rules') });
            const response = await catalog.handle(path, init);
            if (path !== '/v1/account/entity-rows/prompt-library' || !response || !usageUnavailable) return response;
            const wire = PromptLibraryRowsListResponseV1Schema.parse(await response.json());
            if (wire.status !== 'listed') return Response.json(wire);
            return Response.json(PromptLibraryRowsListResponseV1Schema.parse({ ...wire, rows: wire.rows.map(row => row.key === 'skill-usage'
                ? { ...row, content: { t: 'plain', v: catalog.read('coding') } } : row) }));
        },
    });
    // This case exercises bulk rule CAS; approval continuations have dedicated real-wiring coverage.
    const previousActionSettings = storage.getState().settings.actionsSettingsV1;
    storage.getState().applySettingsLocal({ actionsSettingsV1: setActionApprovalOverride({
        settings: previousActionSettings, actionId: 'skills.rules.set',
        surface: 'ui', approvalRequired: false,
    }) });
    capabilityDismissalState.remove('skillsFirstRunDecidedAt');
    for (const id of ['never', 'older', 'recent']) {
        const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: id, bundleSchemaId: 'skills.skill_md_v1' });
        const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
            contentBase64: encodeBase64(new TextEncoder().encode(`---\nname: ${id}\n---\nInstructions.`)) }] });
        expect((await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) }))?.status).toBe(200);
    }
    // The real skills.list transport is ready before the unrelated global Artifact sync finishes.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    const hook = await renderHook(() => { const library = useSkillsLibrary(); return { library, firstRun: useSkillsFirstRun(library.items) }; });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().library.status).toBe('ready'), { timeout: 10_000 });
        expect(hook.getCurrent().library.usageObservedSince).toBe(10);
        expect(hook.getCurrent().firstRun.items.map(item => item.skillId)).toEqual(['recent', 'older', 'never']);
        expect(hook.getCurrent().firstRun.selectedIds).toEqual(['recent', 'older']);
        await act(async () => hook.getCurrent().firstRun.setSelected('older', false));
        expect(hook.getCurrent().firstRun.selectedCount).toBe(1);
        const outcomes: boolean[] = [];
        await act(async () => { outcomes.push(await hook.getCurrent().firstRun.turnOn()); });
        expect(outcomes).toEqual([false]);
        expect(hook.getCurrent().firstRun.errorCode).toBe('conflict');
        expect(capabilityDismissalState.read('skillsFirstRunDecidedAt')).toBeUndefined();
        // A refused write revalidates rule authority; retry becomes eligible when that read settles.
        await vi.waitFor(() => {
            expect(getPromptLibraryCatalogValue(hook.getCurrent().library.scope, 'skill-rules').status).toBe('ready');
            expect(hook.getCurrent().firstRun.eligible).toBe(true);
        });
        failRules = false;
        await act(async () => { outcomes.push(...await Promise.all([hook.getCurrent().firstRun.turnOn(), hook.getCurrent().firstRun.turnOn()])); });
        expect(outcomes).toEqual([false, true, true]);
        const record = catalog.read('skill-rules');
        if (record.key !== 'skill-rules') throw new Error('Expected rules');
        expect(record.value.rules.filter(rule => rule.skillId === 'recent')).toMatchObject([{ enabled: true, target: { t: 'allMachines' } }]);
        expect(record.value.rules.filter(rule => rule.skillId === 'older' || rule.skillId === 'never')).toEqual([]);
        expect(catalog.requests.filter(request => request.key === 'skill-rules')).toHaveLength(1);
        expect(capabilityDismissalState.read('skillsFirstRunDecidedAt')).toEqual(expect.any(Number));
        await vi.waitFor(() => expect(hook.getCurrent().firstRun.eligible).toBe(false));
        usageUnavailable = true;
        await act(async () => hook.getCurrent().library.retry());
        await vi.waitFor(() => expect(hook.getCurrent().library).toMatchObject({ status: 'ready', usageObservedSince: null }));
        expect(hook.getCurrent().library.items.every(item => item.lastUsedAt === undefined)).toBe(true);
        const ruleWrites = catalog.requests.length;
        await act(async () => hook.getCurrent().firstRun.notNow());
        expect(capabilityDismissalState.read('skillsFirstRunDecidedAt')).toEqual(expect.any(Number));
        expect(catalog.requests).toHaveLength(ruleWrites);
    } finally {
        await hook.unmount();
        storage.getState().applySettingsLocal({ actionsSettingsV1: previousActionSettings });
        await home.dispose();
    }
});

it('keeps a successfully read empty selection count through a failed refresh', async () => {
    let fail = false;
    const home = await createSeededSkillsHome('https://skills-known-empty-count.test', { skills: [],
        handleRequest: async path => fail && path === '/v1/account/entity-rows/prompt-library'
            ? Response.json(PromptLibraryRowsListResponseV1Schema.parse({ status: 'invalid-stored-content' })) : null });
    const hook = await renderHook(() => useSkillsLibrary(undefined, { skillIds: [] }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().items).toEqual([]);
        expect(hook.getCurrent().itemCount).toBe(0);
        fail = true;
        await act(async () => hook.getCurrent().retry());
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
        expect(hook.getCurrent().itemCount).toBe(0);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('surfaces a failed rules catalog without a read-refresh-cancel loop and recovers through explicit retry', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    let unavailable = true;
    let miswiredArtifacts = false;
    let catalogReads = 0;
    const home = await createPlainArtifactHomeFixture('https://skills-library-catalog.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            // Mis-bind the genuine Home response once; the real list/Action/strict consumer must reject it.
            if (path.split('?')[0] === '/v1/artifacts' && miswiredArtifacts) return Response.json({ items: [] });
            if (path === '/v1/account/entity-rows/prompt-library') {
                catalogReads += 1;
                if (unavailable) return Response.json(PromptLibraryRowsListResponseV1Schema.parse({ status: 'invalid-stored-content' }));
            }
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            const response = await catalog.handle(path, init);
            if (path === '/v1/account/entity-rows/prompt-library' && response) {
                PromptLibraryRowsListResponseV1Schema.parse(await response.clone().json());
            }
            return response;
        },
    });
    const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'Review code', bundleSchemaId: 'skills.skill_md_v1' });
    const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{
        path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode('---\nname: review-code\ndescription: Review the current diff\n---\nCheck correctness.')),
    }] });
    const seed = await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'fixture-skill',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    expect(seed?.status).toBe(200);
    expect((await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'unreadable-skill',
        header: encodePlainArtifactStoredContent({ ...header, title: 'Retained unreadable skill' }),
        body: encodePlainArtifactStoredContent({ body: '{malformed' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) }))?.status).toBe(200);
    // The fixtures exist at Home, before the focused inventory has hydrated.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSkillsLibrary>>>> | undefined;
    try {
        hook = await renderHook(() => useSkillsLibrary());
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ status: 'unavailable', errorCode: 'invalid-stored-content' }));
        expect(hook.getCurrent().itemCount).toBeNull();
        const readsAfterFailure = catalogReads;
        await hook.rerender();
        expect(hook.getCurrent().status).toBe('unavailable');
        expect(catalogReads).toBe(readsAfterFailure);

        unavailable = false;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect({
            library: hook!.getCurrent(),
            rules: getPromptLibraryCatalogValue({ serverId: home.home.id, accountId: 'artifact-account' }, 'skill-rules'),
        }).toMatchObject({ library: { status: 'ready', errorCode: null }, rules: { status: 'ready' } }), { timeout: 10_000 });
        expect(hook.getCurrent().items.map(item => item.skillId)).toContain('fixture-skill');
        expect(hook.getCurrent().itemCount).toBe(hook.getCurrent().items.length);
        const failures = [{ skillId: 'unreadable-skill', title: 'Retained unreadable skill', reason: 'skill_content_unavailable' }];
        expect(hook.getCurrent().unavailableItems).toEqual(failures);
        const lastKnown = hook.getCurrent().items;
        miswiredArtifacts = true;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ status: 'unavailable', stale: true }));
        expect(getPromptLibraryCatalogValue({ serverId: home.home.id, accountId: 'artifact-account' }, 'skill-rules').status).toBe('ready');
        expect(hook.getCurrent().items).toBe(lastKnown);
        expect(hook.getCurrent().itemCount).toBe(lastKnown.length);
        expect(hook.getCurrent().unavailableItems).toEqual(failures);
        miswiredArtifacts = false;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect(hook!.getCurrent().status).toBe('ready'));
        unavailable = true;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ status: 'unavailable', stale: true, errorCode: 'invalid-stored-content' }));
        expect(hook.getCurrent().items).toBe(lastKnown);
        expect(hook.getCurrent().itemCount).toBe(lastKnown.length);
    } finally {
        await hook?.unmount();
        await home.dispose();
    }
});
