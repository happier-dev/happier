import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, pressTestInstance, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSkillsSurfaceHarness, createSkillsSurfaceItem as skill, createSkillsSurfaceLibrary as library } from '@/dev/testkit/harness/skillsSurfaceHarness';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
// Only the remote Machine transport is replaced; projection parsing, publication and reach stay real.
const machineRpc = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/skills', router: navigation }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Native modal presentation is the boundary; the opened Skills host/config remain real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
installDisconnectedServerSocketBoundary();
const { SkillsHomepage } = await import('./SkillsHomepage');
const { SkillsList } = await import('./SkillsRail');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { saveFoundWarmCacheEntry } = await import('@/sync/domains/state/warmCachePersistence');
const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
const { SkillFoundListResultV1Schema } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');

afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); clearDaemonMergedProjectionCacheForTests(); vi.clearAllMocks(); });

it.each(['wide', 'phone'] as const)('retains shared reach and every attention fix on %s without a Machine probe', async (placement) => {
    const home = await createSkillsSurfaceHarness(`https://skills-shared-${placement}.test`);
    try {
        await prepareWarmCacheEncryptionKey();
        saveFoundWarmCacheEntry(home.scope.serverId, home.scope.accountId, { kind: 'skill', machineId: 'nl2', observedAt: 5,
            result: SkillFoundListResultV1Schema.parse({ scannedAt: 5, roots: [], items: [{ name: 'masked', description: 'Machine copy',
                path: '/skills/masked', digest: 'masked', agents: ['codex'], scope: 'user',
                inLibrary: null, masksLibrary: true, happierInstalled: false, pluginOwned: null }] }) });
        const retry = vi.fn();
        const state = library([
            skill('update', { upstream: { state: 'update_available' } }),
            skill('modified', { modified: true, upstream: { state: 'update_available' } }),
            skill('removed', { upstream: { state: 'removed_from_source' } }),
            skill('masked'), skill('ordinary-edit', { modified: true }), skill('off', { rules: [] }),
        ], { retry, unavailableItems: [{ skillId: 'broken', title: 'Broken skill', reason: 'skill_content_unavailable' }] });
        const screen = await renderScreen(placement === 'wide'
            ? <SkillsHomepage library={state} /> : <SkillsList variant="page" library={state} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.home.reach')).not.toBeNull());
        await act(async () => screen.findByTestId('skills.home.reach')!.props.onLayout({ nativeEvent: { layout: { width: placement === 'wide' ? 800 : 350 } } }));
        expect(screen.findByTestId('skills.home.map')).not.toBeNull();
        expect(screen.findByTestId('skills.home.legend')).not.toBeNull();
        expect(screen.findByTestId('skills.home.sentence')).not.toBeNull();
        for (const id of ['broken', 'update', 'modified', 'removed', 'masked']) {
            expect(screen.findByTestId(`skills.home.needs.${id}`)).not.toBeNull();
        }
        for (const id of ['ordinary-edit', 'off']) expect(screen.findByTestId(`skills.home.needs.${id}`)).toBeNull();
        // A skill its source dropped says so in words, as the row's status (never only a description or a glyph).
        expect(screen.findByTestId('skills.home.needs.removed:status')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Removed from source');
        await act(async () => screen.pressByTestId('skills.home.legend.machine.nl2'));
        expect(navigation.replace).toHaveBeenLastCalledWith('/settings/skills?machine=nl2');
        await act(async () => screen.pressByTestId('skills.home.needs.modified'));
        expect(navigation.push).toHaveBeenLastCalledWith('/settings/skills/updates');
        await act(async () => screen.pressByTestId('skills.home.needs.removed'));
        expect(navigation.push).toHaveBeenLastCalledWith('/settings/skills/removed');
        await act(async () => screen.pressByTestId('skills.home.needs.masked'));
        expect(navigation.push).toHaveBeenLastCalledWith('/settings/skills/found');
        const unreadable = screen.findByTestId('skills.home.needs.broken')!;
        const retryButton = unreadable.findAll(node => typeof node.type === 'string'
            && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function'))[0]!;
        await act(async () => pressTestInstance(retryButton));
        expect(retry).toHaveBeenCalledOnce();
        expect(machineRpc).not.toHaveBeenCalled();
        if (placement === 'phone') {
            expect(home.externalRequests).toEqual([]);
            const { ItemList } = await import('@/components/ui/lists/ItemList');
            expect(screen.findAllByType(ItemList)).toHaveLength(1);
            // One phone order for every capability home (lab kp:home, np:home): the overview and Needs a look,
            // then the list's view switch and rows.
            const order = screen.root.findAll(node => typeof node.props.testID === 'string').map(node => node.props.testID as string);
            const switchAt = order.findIndex(id => id.startsWith('skills.page.view'));
            expect(switchAt).toBeGreaterThan(-1);
            expect(switchAt).toBeGreaterThan(order.lastIndexOf('skills.home.needs.removed'));
        }
    } finally { await standardCleanup(); await home.dispose(); }
});

it('keeps a plan-none Agent out of the rendered reach legend and names it once in the unsupported note', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-home-unsupported.test');
    try {
        const base = home.storage.getState().machines.nl2!;
        const machine = { ...base, metadata: { ...base.metadata!,
            agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'gemini'] } } };
        home.storage.getState().applyMachines([machine], true, {
            sourceServerId: home.scope.serverId, sourceAccountId: home.scope.accountId,
        });
        const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {
            codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                    skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' } } },
            gemini: { id: 'gemini', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' },
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                    skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' } } },
        } });
        machineRpc.mockResolvedValue({ protocolVersion: 1, projection });
        const credentials = await renderHook(() => useServerCredentialAccountScopeBinding(home.scope.serverId));
        await vi.waitFor(() => expect(credentials.getCurrent().binding).not.toBeNull());
        await act(async () => expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'nl2', serverId: home.scope.serverId,
            accountLifetime: credentials.getCurrent().binding! })).toMatchObject({ kind: 'ready' }));
        machineRpc.mockClear();
        const screen = await renderScreen(<SkillsHomepage library={library([skill('on')])} />);
        const legend = screen.findByTestId('skills.home.legend')!;
        expect(legend.findAll(node => node.children.some(child => typeof child === 'string' && child.includes('Codex')))).not.toHaveLength(0);
        expect(legend.findAll(node => node.children.some(child => typeof child === 'string' && child.includes('Gemini')))).toHaveLength(0);
        expect(screen.getTextContent().match(/Gemini/g)).toHaveLength(1);
        expect(machineRpc).not.toHaveBeenCalled();
    } finally { await standardCleanup(); await home.dispose(); }
});

it('keeps the reach legend through refresh, names the offline Machine, and routes a waiting update to review', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-home-reach.test');
    try {
        const items = [skill('update', { upstream: { state: 'update_available' } }), skill('off', { rules: [] })];
        const screen = await renderScreen(<SkillsHomepage library={library(items)} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.home.legend')).not.toBeNull());
        expect(screen.getTextContent()).toContain('away');
        expect(screen.getTextContent()).toContain('Offline');
        await act(async () => screen.pressByTestId('skills.home.legend.machine.nl2'));
        expect(navigation.replace).toHaveBeenCalledWith('/settings/skills?machine=nl2');
        expect(screen.findByTestId('skills.home.needs.update')).not.toBeNull();
        expect(screen.findByTestId('skills.home.needs.off')).toBeNull();
        await act(async () => screen.pressByTestId('skills.home.needs.update'));
        expect(navigation.push).toHaveBeenCalledWith('/settings/skills/updates');
        await screen.update(<SkillsHomepage library={library(items, { status: 'loading', stale: true })} />);
        expect(screen.findByTestId('skills.home.legend')).not.toBeNull();
        expect(screen.findByTestId('skills.home.needs.update')).not.toBeNull();
    } finally { await standardCleanup(); await home.dispose(); }
});

it('emphasises only the sentence counts, never digits inside a Machine name', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-home-emphasis.test');
    try {
        const away = home.storage.getState().machines.away!;
        home.storage.getState().applyMachines([home.storage.getState().machines.nl2!,
            { ...away, metadata: { ...away.metadata!, displayName: 'NLDW4-5-40-40' } }], true, {
            sourceServerId: home.scope.serverId, sourceAccountId: home.scope.accountId,
        });
        const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {
            codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                    skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' } } },
        } });
        machineRpc.mockResolvedValue({ protocolVersion: 1, projection });
        const credentials = await renderHook(() => useServerCredentialAccountScopeBinding(home.scope.serverId));
        await vi.waitFor(() => expect(credentials.getCurrent().binding).not.toBeNull());
        await act(async () => expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'nl2', serverId: home.scope.serverId,
            accountLifetime: credentials.getCurrent().binding! })).toMatchObject({ kind: 'ready' }));
        const screen = await renderScreen(<SkillsHomepage library={library([skill('one'), skill('two')])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.home.sentence')).not.toBeNull());
        const sentence = screen.findByTestId('skills.home.sentence')!;
        const text = (node: typeof sentence): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
        expect(text(sentence)).toContain('NLDW4-5-40-40');
        const emphasised = sentence.findAll(node => node.props.emphasis === 'semiBold').map(text);
        expect(emphasised).toContain('2');
        expect(emphasised.filter(part => ['4', '5', '40'].includes(part))).toEqual([]);
    } finally { await standardCleanup(); await home.dispose(); }
});

it('offers first-run choice only while Account rules remain undecided and separates empty from unreadable', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-home-moments.test');
    try {
        const item = skill('waiting', { rules: [] });
        const screen = await renderScreen(<SkillsHomepage library={library([item])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.home.choose')).not.toBeNull());
        await act(async () => screen.pressByTestId('skills.home.choose'));
        expect(navigation.push).toHaveBeenCalledWith('/settings/skills/choose');
        await act(async () => applyPromptLibraryCatalogSnapshot(home.scope, { catalog: { status: 'ready', rows: [{ revision: 2,
            record: { key: 'skill-rules', value: { v: 1, rules: skill('decided').rules } } }], tombstones: [], diagnostics: [] },
            rawSettings: {}, sourceSettingsVersion: 1 }, true));
        expect(screen.findByTestId('skills.home.choose')).toBeNull();
        await screen.update(<SkillsHomepage library={library([])} />);
        expect(screen.findByTestId('skills.home.empty.add')).not.toBeNull();
        // The canonical list always carries the built-in skill: a library of only that one is still empty.
        await screen.update(<SkillsHomepage library={library([skill('happier:happier', { provenance: { kind: 'first_party' }, rules: [] })])} />);
        expect(screen.findByTestId('skills.home.empty.add')).not.toBeNull();
        expect(screen.findByTestId('skills.home.choose')).toBeNull();
        const retry = vi.fn();
        await screen.update(<SkillsHomepage library={library([], { status: 'unavailable', errorCode: 'skill_content_unavailable', retry })} />);
        expect(screen.findByTestId('skills.home.empty.add')).toBeNull();
        expect(screen.findByTestId('skills.home.error')).not.toBeNull();
        await act(async () => screen.pressByTestId('skills.home.error-action'));
        expect(retry).toHaveBeenCalledOnce();
    } finally { await standardCleanup(); await home.dispose(); }
});

it('shows a few addable skills found on the machines from the last known scan, without reading a machine, and anticipates them when the library is empty', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-home-found.test');
    try {
        const found = SkillFoundListResultV1Schema.parse({ scannedAt: 5, roots: [], items: ['grill-me', 'ui-polish', 'held', 'plugin', 'masked', 'extra']
            .map(name => ({ name, description: `${name} purpose`, path: `/skills/${name}`, digest: name, agents: ['codex'], scope: 'user',
                inLibrary: name === 'held' ? 'library-held' : null, masksLibrary: name === 'masked', happierInstalled: false,
                pluginOwned: name === 'plugin' ? { pluginName: 'review-kit' } : null })) });
        await prepareWarmCacheEncryptionKey();
        saveFoundWarmCacheEntry(home.scope.serverId, home.scope.accountId, { kind: 'skill', machineId: 'nl2', observedAt: 5, result: found });
        const screen = await renderScreen(<SkillsHomepage library={library([skill('on')])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.home.found')).not.toBeNull());
        // Held, plugin and same-name rows need the Found page; the block offers the plain ones, three at most.
        expect(screen.findByTestId('skills.home.found.grill-me')).not.toBeNull();
        expect(screen.findByTestId('skills.home.found.ui-polish')).not.toBeNull();
        expect(screen.findByTestId('skills.home.found.extra')).not.toBeNull();
        expect(screen.findByTestId('skills.home.found.held')).toBeNull();
        expect(screen.findByTestId('skills.home.found.masked')).toBeNull();
        // "See all" counts what the rail counts: every last-known row not in the library.
        expect(screen.getTextContent()).toContain('See all 5');
        await act(async () => screen.pressByTestId('skills.home.found.seeAll'));
        expect(navigation.push).toHaveBeenCalledWith('/settings/skills/found');
        expect(machineRpc).not.toHaveBeenCalled();
        // Needs a look joins the machine copy that wins over a library skill (Compare) and an unreadable item (Try again).
        const retry = vi.fn();
        await screen.update(<SkillsHomepage library={library([skill('on'), skill('masked')], { retry,
            unavailableItems: [{ skillId: 'broken', title: 'broken-skill', reason: 'skill_content_unavailable' },
                { skillId: '736cb1a6-6067-4fe9-bce1-cb7a33e4feaf', title: null, reason: 'skill_content_unavailable' }] })} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.home.needs.masked')).not.toBeNull());
        // One message per state: the mask is said by the row's description, not again by a status chip.
        expect(screen.getTextContent().match(/copy wins/g) ?? []).toHaveLength(1);
        await act(async () => screen.pressByTestId('skills.home.needs.masked'));
        expect(navigation.push).toHaveBeenLastCalledWith('/settings/skills/found');
        expect(screen.findByTestId('skills.home.needs.broken')).not.toBeNull();
        // A skill with no readable title is identified by the first block of its id, never as unnamed or by the whole id.
        expect(screen.getTextContent()).toContain('Skill 736cb1a6');
        expect(screen.getTextContent()).not.toContain('736cb1a6-6067');
        expect(screen.getTextContent()).not.toMatch(/unnamed/i);
        expect(screen.findByTestId('skills.home.needs.on')).toBeNull();
        await screen.update(<SkillsHomepage library={library([])} />);
        // An empty library offers Add and Write, and anticipates the found skills in one line.
        expect(screen.findByTestId('skills.home.empty.write')).not.toBeNull();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        await act(async () => screen.pressByTestId('skills.home.empty.write'));
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ params: expect.objectContaining({ modeKey: 'write' }) }) }));
        expect(screen.getTextContent()).toContain('5 skills are already on your machines');
        expect(screen.findByTestId('skills.home.found.grill-me')).not.toBeNull();
    } finally { await standardCleanup(); await home.dispose(); }
});
