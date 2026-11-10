import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSkillsSurfaceHarness, createSkillsSurfaceItem as skill, createSkillsSurfaceLibrary as library } from '@/dev/testkit/harness/skillsSurfaceHarness';
import type { SettingsCollectionRowFacts } from '@/components/settings/shell/settingsCollectionAdapter';

const navigation = vi.hoisted(() => ({ params: {} as { machine?: string }, push: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/skills', params: () => navigation.params,
        router: { push: navigation.push, replace: navigation.replace } }).module;
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
// Select the real browser paint adapter; native Skia handles do not exist in this Node host.
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
installDisconnectedServerSocketBoundary();
const { SkillsList } = await import('./SkillsRail');
const { t } = await import('@/text');
const { CapabilityRow } = await import('@/components/capabilities/row/CapabilityRow');
const { useReachMachines } = await import('@/sync/domains/capabilities/reach/useReachProjection');
const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests, beginPromptLibraryCatalogLoad,
    applyPromptLibraryCatalogSnapshot, applyPromptLibraryCatalogRowsSnapshot, getPromptLibraryCatalogSnapshot,
    getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

/** The group label a row follows in the one shared list (rail and phone page draw the same rows). */
function groupOf(screen: Awaited<ReturnType<typeof renderScreen>>, rowId: string): string | null | undefined {
    let group: string | null = null;
    for (const node of screen.root.findAll(n => typeof n.type === 'string' && typeof n.props.testID === 'string'
        && /^skills\.rail\.(group|row)\./.test(n.props.testID))) {
        const id = node.props.testID as string;
        if (id.startsWith('skills.rail.group.')) group = id.slice('skills.rail.group.'.length);
        else if (id === `skills.rail.row.${rowId}`) return group;
    }
    return undefined;
}

afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); navigation.params = {}; vi.clearAllMocks(); });

it.each(['rail', 'page'] as const)('shows one library failure and retry on the %s', async variant => {
    const home = await createSkillsSurfaceHarness(`https://skills-one-failure-${variant}.test`);
    const retry = vi.fn();
    try {
        const screen = await renderScreen(<SkillsList variant={variant}
            library={library([], { status: 'unavailable', errorCode: 'transport_unavailable', retry })} />);
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const errors = screen.findAllByType(SurfaceStateCard).filter(node => node.props.kind === 'error');
        expect(errors).toHaveLength(1);
        await act(async () => errors[0]!.props.action.onPress());
        expect(retry).toHaveBeenCalledOnce();
    } finally { await standardCleanup(); await home.dispose(); }
});

it('keeps 139 rows mounted through unchanged catalog wakes and folder-name authority recovery', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-row-mount-cost.test', [{ key: 'folders',
        value: { v: 1, folders: [{ id: 'writing', name: 'Writing', parentId: null }] } }]);
    const row = CapabilityRow as React.MemoExoticComponent<React.FunctionComponent<React.ComponentProps<typeof CapabilityRow>>>;
    const original = row.type;
    let mounts = 0;
    // Observe real committed mounts; preserve the complete row implementation.
    const observe = vi.spyOn(row, 'type').mockImplementation(props => {
        React.useEffect(() => { if (props.testID.startsWith('skills.rail.row.')) mounts++; }, []);
        return original(props);
    });
    const items = Array.from({ length: 139 }, (_, i) => skill(`mount-${i}`, { folderId: 'writing' }));
    const screen = await renderScreen(<SkillsList variant="page" library={library(items)} />);
    try {
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.group.folder.writing')).not.toBeNull());
        expect(screen.findByTestId('skills.rail.row.mount-138')).not.toBeNull();
        const received = getPromptLibraryCatalogSnapshot(home.scope)!;
        if (received.catalog.status !== 'ready' && received.catalog.status !== 'partial') throw new Error('Expected admitted catalog');
        mounts = 0;
        for (let i = 0; i < 5; i++) {
            await act(async () => beginPromptLibraryCatalogLoad(home.scope));
            await act(async () => applyPromptLibraryCatalogRowsSnapshot(home.scope, ['skill-rules'], {
                rawSettings: {}, sourceSettingsVersion: 0, catalog: { status: 'ready', rows: [{ revision: 1,
                    record: { key: 'skill-rules', value: { v: 1, rules: [] } } }], tombstones: [], diagnostics: [] },
            }, true));
            expect(mounts).toBe(0);
            await screen.update(<SkillsList variant="page" library={library(items, { status: 'loading', stale: true })} />);
            await act(async () => applyPromptLibraryCatalogSnapshot(home.scope, { ...received,
                catalog: { status: 'unavailable', reason: 'encryption-material-unavailable' } }, true));
            // Losing folder-name authority must still withdraw the private catalog.
            expect(getPromptLibraryCatalogValue(home.scope, 'folders').value).toBeNull();
            await screen.update(<SkillsList variant="page" library={library(items,
                { status: 'unavailable', stale: true, errorCode: 'encryption-material-unavailable' })} />);
            await act(async () => applyPromptLibraryCatalogSnapshot(home.scope, received, true));
            await screen.update(<SkillsList variant="page" library={library(items)} />);
        }
        expect(mounts).toBe(0);
        // A received folder deletion is a real change, not unknown folder names.
        await act(async () => applyPromptLibraryCatalogSnapshot(home.scope, { ...received, catalog: {
            status: 'ready', rows: [{ revision: 2, record: { key: 'folders', value: { v: 1, folders: [] } } }],
            tombstones: [], diagnostics: [],
        } }, true));
        expect(screen.findByTestId('skills.rail.group.folder.writing')).toBeNull();
        expect(screen.findByTestId('skills.rail.group.inUse')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.mount-138')).not.toBeNull();
    } finally { await screen.unmount(); observe.mockRestore(); await home.dispose(); }
});

it('retains row render locality when one of 139 listed skills changes', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-rail-row-cost.test');
    // Observe the real render function without replacing any of its logic or dependencies.
    const row = CapabilityRow as React.MemoExoticComponent<React.FunctionComponent<React.ComponentProps<typeof CapabilityRow>>>;
    const original = row.type;
    const counts = new Map<string, number>();
    const render = vi.spyOn(row, 'type').mockImplementation(props => {
        if (props.testID.startsWith('skills.rail.row.')) counts.set(props.testID, (counts.get(props.testID) ?? 0) + 1);
        return original(props);
    });
    const items = Array.from({ length: 139 }, (_, i) => skill(`row-${i}`));
    const screen = await renderScreen(<SkillsList variant="page" library={library(items)} />);
    try {
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.row.row-138')).not.toBeNull());
        counts.clear();
        await screen.update(<SkillsList variant="page" library={library(items.map((item, i) => i === 0
            ? { ...item, description: 'Changed instructions' } : item))} />);
        expect([...counts.entries()]).toEqual([['skills.rail.row.row-0', 1]]);
    } finally { await screen.unmount(); render.mockRestore(); await home.dispose(); }
});

it('does not render retained skill rows for real Machine heartbeat and unrelated display publications', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-machine-name-cost.test');
    const machines = Array.from({ length: 101 }, (_, i) => createMachineFixture({ id: `machine-${i}`,
        presenceProtocolVersion: 1, active: true, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!,
            displayName: `Build ${i}`, host: `host-${i}`, agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } } }));
    const options = { sourceServerId: home.scope.serverId, sourceAccountId: home.scope.accountId, replace: false };
    home.storage.getState().applyMachines(machines, true, options);
    const row = CapabilityRow as React.MemoExoticComponent<React.FunctionComponent<React.ComponentProps<typeof CapabilityRow>>>;
    const original = row.type;
    let renders = 0;
    let mounts = 0;
    // Every SkillListRow render reaches this real child with freshly derived row facts.
    const observe = vi.spyOn(row, 'type').mockImplementation(props => {
        if (props.testID.startsWith('skills.rail.row.')) renders++;
        React.useEffect(() => { if (props.testID.startsWith('skills.rail.row.')) mounts++; }, []);
        return original(props);
    });
    const items = Array.from({ length: 139 }, (_, i) => skill(`machine-cost-${i}`, {
        rules: [{ id: `on-${i}`, skillId: `machine-cost-${i}`, target: { t: 'machine', machineId: 'machine-0' },
            enabled: true, createdAt: 1, updatedAt: 1 }],
    }));
    const screen = await renderScreen(<SkillsList variant="page" library={library(items)} />);
    const reach = await renderHook(() => useReachMachines());
    const clock = vi.spyOn(Date, 'now');
    try {
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.row.machine-cost-138')).not.toBeNull());
        renders = 0; mounts = 0;
        for (let i = 0; i < 5; i++) {
            await act(async () => {
                const machine = home.storage.getState().machines['machine-0']!;
                home.storage.getState().applyMachines([{ ...machine, activeAt: machine.activeAt + 1,
                    updatedAt: machine.updatedAt + 1, metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, homeDir: `/presence-home-${i}` } }], false, options);
            });
            expect(renders).toBe(0);
            await act(async () => {
                const machine = home.storage.getState().machineDisplayById['machine-0']!;
                home.storage.getState().replaceMachineDisplays([{ ...machine, updatedAt: machine.updatedAt + 1,
                    metadata: { ...machine.metadata!, homeDir: `/changed-home-${i}` } }], options);
            });
        }
        expect(renders).toBe(0);
        expect(mounts).toBe(0);
        await act(async () => {
            const machine = home.storage.getState().machines['machine-0']!;
            home.storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                metadata: { ...machine.metadata!, agentInventory: { checkedAt: 3, installedAgentIds: ['codex'] } } }], false, options);
        });
        expect(renders).toBe(0);
        const lastSeenAt = readMachineActivity(home.storage.getState().machines['machine-0']!).activeAt!;
        clock.mockReturnValue(lastSeenAt + 1);
        await act(async () => {
            home.storage.getState().applyMachineActivityUpdates([{ id: 'machine-0', active: false, activeAt: lastSeenAt }], options);
        });
        expect(reach.getCurrent().machines.find(machine => machine.machineId === 'machine-0')).toMatchObject({ online: false, lastSeenAt });
        expect(renders).toBe(0);
        await act(async () => {
            const machine = home.storage.getState().machines['machine-0']!;
            home.storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                metadata: { ...machine.metadata!, displayName: 'Renamed builder' } }], false, options);
        });
        expect(screen.findAllByType(CapabilityRow).find(row => row.props.testID === 'skills.rail.row.machine-cost-0')?.props.whereSummary)
            .toContain('Renamed builder');
        expect(renders).toBe(139);
        expect(mounts).toBe(0);
    } finally { clock.mockRestore(); await reach.unmount(); await screen.unmount(); observe.mockRestore(); await home.dispose(); }
});

it('re-evaluates a retained row time status when its parent renders after the existing usage boundary', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-rail-usage-boundary.test');
    const now = Date.now();
    const days30 = 30 * 86_400_000;
    const items = [skill('aging', { lastUsedAt: now - days30 + 500 }), skill('edited')];
    const observed = now - days30 - 1;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
        const screen = await renderScreen(<SkillsList variant="page" library={library(items, { usageObservedSince: observed })} />);
        try {
            const status = () => screen.findAll(node => node.props.testID === 'skills.rail.row.aging'
                && Object.hasOwn(node.props, 'status'))[0]?.props.status;
            expect(status()).toBeNull();
            clock.mockReturnValue(now + 1000);
            await screen.update(<SkillsList variant="page" library={library([items[0]!, { ...items[1]!, description: 'Changed' }],
                { usageObservedSince: observed })} />);
            expect(status()).toMatchObject({ kind: 'unused' });
        } finally { await screen.unmount(); }
    } finally { clock.mockRestore(); await home.dispose(); }
});

it('moves rendered rows from use groups to personal folders, filters by the route Machine and clears that filter', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-rail-groups.test', [{ key: 'folders', value: { v: 1,
        folders: [{ id: 'writing', name: 'Writing', parentId: null }] } }]);
    try {
        const on = skill('on');
        const off = skill('off', { rules: [] });
        const elsewhere = skill('elsewhere', { rules: [{ ...skill('elsewhere').rules[0]!, target: { t: 'machine', machineId: 'away' } }] });
        const screen = await renderScreen(<SkillsList variant="page" library={library([on, off, elsewhere])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.group.inUse')).not.toBeNull());
        expect(screen.findByTestId('skills.rail.group.off')).not.toBeNull();
        expect(groupOf(screen, 'on')).toBe('inUse');
        expect(groupOf(screen, 'off')).toBe('off');
        await screen.update(<SkillsList variant="page" library={library([{ ...on, folderId: 'writing' }, off, elsewhere])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.group.folder.writing')).not.toBeNull());
        expect(screen.findByTestId('skills.rail.group.folder.none')).not.toBeNull();
        expect(groupOf(screen, 'on')).toBe('folder.writing');
        expect(groupOf(screen, 'off')).toBe('folder.none');
        expect(screen.findByTestId('skills.rail.group.inUse')).toBeNull();
        navigation.params = { machine: 'nl2' };
        await screen.update(<SkillsList variant="page" library={library([on, off, elsewhere])} />);
        expect(screen.findByTestId('skills.rail.row.on')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.off')).toBeNull();
        expect(screen.findByTestId('skills.rail.row.elsewhere')).toBeNull();
        // The route Machine is the column filter's own Machine condition: one token, no second row.
        expect(screen.findByTestId('skills.rail-filter-token:machine')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.machineFilter')).toBeNull();
        await act(async () => screen.pressByTestId('skills.rail-filter-token:machine'));
        expect(screen.findByTestId('skills.rail.row.off')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.elsewhere')).not.toBeNull();
    } finally { await standardCleanup(); await home.dispose(); }
});

it.each(['rail', 'page'] as const)('keeps an unknown route Machine as a removable condition instead of widening the %s collection', async variant => {
    const home = await createSkillsSurfaceHarness('https://skills-unknown-machine-filter.test');
    const items = [skill('on'), skill('off', { rules: [] })];
    navigation.params = { machine: 'not-in-this-account' };
    try {
        const screen = await renderScreen(<SkillsList variant={variant} library={library(items)} />);
        expect(screen.findByTestId('skills.rail.row.on')).toBeNull();
        expect(screen.findByTestId('skills.rail.row.off')).toBeNull();
        expect(screen.findByTestId('skills.rail-filter-token:machine')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.machineFilter')).toBeNull();
        await act(async () => screen.pressByTestId('skills.rail-filter-token:machine'));
        expect(screen.findByTestId('skills.rail.row.on')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.off')).not.toBeNull();
    } finally { await standardCleanup(); await home.dispose(); }
});

it('composes Made by with Source, Machine and search through the existing filter Action without reading data', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-maker-composition.test');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const items = [skill('review-local'), skill('notes')];
    const screen = await renderScreen(<SkillsList variant="rail" library={library(items, { scope: home.scope })} />);
    const executor = createDefaultActionExecutor();
    const target = { column: 'skills' as const, ...home.scope };
    const context = { surface: 'agent' as const, serverId: home.scope.serverId, runtimeAccountId: home.scope.accountId };
    try {
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.row.review-local')).not.toBeNull());
        const before = home.requests.length;
        await act(async () => {
            expect(await executor.execute('settings.column.filter.set', { ...target, searchQuery: 'review', filters: {
                maker: { include: ['anyone'], exclude: [] }, source: { include: ['you'], exclude: [] },
                machine: { include: ['nl2'], exclude: [] },
            } }, context)).toMatchObject({ ok: true });
        });
        expect(screen.findByTestId('skills.rail.row.review-local')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.notes')).toBeNull();
        expect(screen.findByTestId('skills.rail-filter-token:maker')).not.toBeNull();
        expect(home.requests).toHaveLength(before);
        await act(async () => {
            expect(await executor.execute('settings.column.filter.set', { ...target, filters: {
                maker: { include: ['you'], exclude: [] },
            } }, context)).toMatchObject({ ok: true });
        });
        // Legacy written provenance is origin, never evidence that the person created the skill.
        expect(screen.findByTestId('skills.rail.row.review-local')).toBeNull();
        expect(home.requests).toHaveLength(before);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('keeps maker tokens bound to creator ids across Session rename and loss, without loading identities', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-maker-identity.test');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const bot = createSessionListRenderableSessionFixture({ id: 'bot-1', metadata: {
        path: '/project', name: 'Researcher', bot: { kind: 'bot' },
    } });
    home.storage.setState({ sessionListRowsByServerId: { [home.scope.serverId]: { 'bot-1': bot } } });
    const items = [skill('from-bot', { creator: { kind: 'agent', accountId: home.scope.accountId, sessionId: 'bot-1' } }),
        skill('mine', { creator: { kind: 'person', accountId: home.scope.accountId } }), skill('legacy')];
    const screen = await renderScreen(<SkillsList variant="page" library={library(items, { scope: home.scope })} />);
    const executor = createDefaultActionExecutor();
    const target = { column: 'skills' as const, ...home.scope };
    const context = { surface: 'agent' as const, serverId: home.scope.serverId, runtimeAccountId: home.scope.accountId };
    const filter = async (value: string) => act(async () => {
        expect(await executor.execute('settings.column.filter.set', { ...target, filters: {
            maker: { include: [value], exclude: [] },
        } }, context)).toMatchObject({ ok: true });
    });
    try {
        const before = home.requests.length;
        await filter('you');
        expect(screen.findByTestId('skills.rail.row.mine')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.legacy')).toBeNull();
        await filter('any-bot');
        expect(screen.findByTestId('skills.rail.row.from-bot')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.mine')).toBeNull();
        await filter('session:bot-1');
        expect(screen.getTextContent()).toContain('Researcher');
        await act(async () => home.storage.setState({ sessionListRowsByServerId: { [home.scope.serverId]: {
            'bot-1': { ...bot, metadata: { ...bot.metadata!, name: 'Writer' } },
        } } }));
        expect(screen.findByTestId('skills.rail.row.from-bot')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Writer');
        expect(screen.getTextContent()).not.toContain('Researcher');
        await act(async () => home.storage.setState({ sessionListRowsByServerId: {} }));
        expect(screen.findByTestId('skills.rail.row.from-bot')).toBeNull();
        expect(screen.findByTestId('skills.rail-filter-token:maker')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Writer');
        await filter('anyone');
        expect(screen.findByTestId('skills.rail.row.from-bot')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.legacy')).not.toBeNull();
        expect(home.requests).toHaveLength(before);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('keeps source and Action query when clearing the route Machine token, with Updates still reachable', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-independent-conditions.test');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { skillSourceId } = await import('./skillSource');
    const on = skill('postgres-on', { upstream: { state: 'update_available' } });
    const elsewhere = skill('postgres-away', { rules: [{ ...skill('postgres-away').rules[0]!,
        target: { t: 'machine', machineId: 'away' } }] });
    navigation.params = { machine: 'nl2' };
    const screen = await renderScreen(<SkillsList variant="rail" library={library([on, elsewhere, skill('notes')])} />);
    const executor = createDefaultActionExecutor();
    const target = { column: 'skills' as const, ...home.scope };
    const context = { surface: 'agent' as const, serverId: home.scope.serverId, runtimeAccountId: home.scope.accountId };
    const source = { include: [skillSourceId(on)], exclude: [] };
    try {
        await act(async () => {
            expect(await executor.execute('settings.column.filter.set', { ...target,
                filters: { machine: { include: ['nl2'], exclude: [] }, source }, searchQuery: 'postgres' }, context))
                .toMatchObject({ ok: true });
        });
        expect(screen.findHostByTestId('skills.rail.search')?.props.value).toBe('postgres');
        expect(screen.findByTestId('skills.rail.row.postgres-on')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.postgres-away')).toBeNull();
        expect(screen.findByTestId('skills.rail.updates')).not.toBeNull();
        await act(async () => { screen.pressByTestId('skills.rail-filter-token:machine'); });
        expect(await executor.execute('settings.column.filter.get', target, context)).toMatchObject({ ok: true,
            result: { filters: { source }, searchQuery: 'postgres' } });
        expect(screen.findByTestId('skills.rail-filter-token:machine')).toBeNull();
        expect(screen.findByTestId('skills.rail-filter-token:source')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.postgres-on')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.postgres-away')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.notes')).toBeNull();
        expect(screen.findByTestId('skills.rail.updates')).not.toBeNull();
    } finally { await screen.unmount(); await home.dispose(); }
});

it('adds the Updates destination only for a waiting update and preserves known rows on a failed refresh', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-rail-states.test');
    try {
        const item = skill('review');
        const screen = await renderScreen(<SkillsList variant="rail" library={library([item])} />);
        expect(screen.findByTestId('skills.rail.updates')).toBeNull();
        await screen.update(<SkillsList variant="rail" library={library([{ ...item, upstream: { state: 'update_available' } }])} />);
        expect(screen.findByTestId('skills.rail.updates')).not.toBeNull();
        await act(async () => screen.pressByTestId('skills.rail.updates'));
        expect(navigation.push).toHaveBeenCalledWith('/settings/skills/updates');
        const retry = vi.fn();
        await screen.update(<SkillsList variant="rail" library={library([item], { status: 'unavailable', stale: true, errorCode: 'catalog_unavailable', retry })} />);
        expect(screen.findByTestId('skills.rail.row.review')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.error')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.empty')).toBeNull();
        await screen.update(<SkillsList variant="rail" library={library([], { status: 'unavailable', errorCode: 'catalog_unavailable', retry })} />);
        expect(screen.findByTestId('skills.rail.error')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.empty')).toBeNull();
        await act(async () => screen.pressByTestId('skills.rail.error-action'));
        expect(retry).toHaveBeenCalledOnce();
    } finally { await standardCleanup(); await home.dispose(); }
});

it.each(['rail', 'page'] as const)('narrows the %s by a Source condition from the shared filter editor, worded as the source reads (P8 R8-6)', async variant => {
    const home = await createSkillsSurfaceHarness(`https://skills-source-filter-${variant}.test`);
    const mine = skill('mine');
    const builtIn = skill('builtin', { provenance: { kind: 'first_party' } });
    // The editor is a positioned popover; its placement listens to the browser window (a platform boundary).
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
        const screen = await renderScreen(<SkillsList variant={variant} library={library([mine, builtIn])} />);
        expect(screen.findByTestId('skills.rail.row.builtin')).not.toBeNull();
        await act(async () => screen.pressByTestId('skills.rail-filter-open'));
        const editor = () => screen.findAll(node => node.props.testID === 'skills.rail-editor' && node.props.model !== undefined)[0]!;
        const fields = editor().props.model.availableFields as readonly { id: string; label: string;
            valueOptions: readonly { value: unknown; label?: string }[] }[];
        expect(fields.map(field => [field.id, field.label])).toEqual([
            ['source', t('sessionsList.filtersSource')], ['machine', t('sessionsList.filtersMachine')],
            ['maker', t('capabilities.skills.maker.title')]]);
        // Source values are where each skill came from, in the words its row shows, never provenance ids.
        expect(fields[0]!.valueOptions).toEqual(expect.arrayContaining([
            { value: 'you', label: t('capabilities.facts.you') }, { value: 'happier', label: t('capabilities.facts.happier') }]));
        await act(async () => { editor().props.onChange({ type: 'add', condition: { fieldId: 'source', operator: 'is', values: ['you'] } }); });
        expect(screen.findByTestId('skills.rail.row.mine')).not.toBeNull();
        expect(screen.findByTestId('skills.rail.row.builtin')).toBeNull();
        expect(screen.findByTestId('skills.rail-filter-token:source')).not.toBeNull();
        await screen.pressByTestIdAsync('collection-filter-condition:source:is:value');
        expect(editor().props.model.availableFields[0].valueOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: 'you', count: 1 }), expect.objectContaining({ value: 'happier', count: 1 }),
        ]));
        await screen.pressByTestIdAsync('collection-filter-back');
        await act(async () => screen.pressByTestId('skills.rail-filter-token:source'));
        expect(screen.findByTestId('skills.rail.row.builtin')).not.toBeNull();
    } finally { vi.unstubAllGlobals(); await standardCleanup(); await home.dispose(); }
});

it('counts held values only while the actual condition value picker is open and retains equal results', async () => {
    const { defineSettingsCollectionAdapter } = await import('@/components/settings/shell/settingsCollectionAdapter');
    const { useCollectionConditionHeader } = await import('@/components/ui/lists/collection/useCollectionConditionHeader');
    const adapter = defineSettingsCollectionAdapter(['source'] as const);
    const filters = { source: { include: ['you'], exclude: [] } };
    const bindings = { fields: { source: { label: 'Source', valueOptions: [
        { value: 'you', label: 'You' }, { value: 'happier', label: 'Happier' }, { value: 'absent', label: 'Absent' },
    ] } } };
    const facts: readonly SettingsCollectionRowFacts<'source'>[] = ['you', 'happier'].map((source, i) => ({ key: String(i), title: source, context: null,
        status: null, fields: { source: [source] } }));
    let reads = 0;
    const readHeldFacts = () => { reads++; return facts; };
    let current!: ReturnType<typeof useCollectionConditionHeader>;
    function HeaderProbe(props: Readonly<{ readFacts: typeof readHeldFacts }>) {
        const header = useCollectionConditionHeader({ testIDPrefix: 'counts', registry: adapter.registry,
            filters, bindings, baseFilter: {}, setFilters: () => {}, readHeldFacts: props.readFacts });
        current = header;
        return <>{header.filterButton}{header.editorOverlay}</>;
    }
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
        const screen = await renderScreen(<HeaderProbe readFacts={readHeldFacts} />);
        expect(reads).toBe(0);
        await screen.pressByTestIdAsync('counts-filter-open');
        expect(reads).toBe(0);
        await screen.pressByTestIdAsync('collection-filter-condition:source:is:value');
        expect(current.model.availableFields[0]!.valueOptions.map(({ value, count }) => [value, count]))
            .toEqual([['you', 1], ['happier', 1], ['absent', 0]]);
        const countedModel = current.model;
        const readCount = reads;
        await screen.update(<HeaderProbe readFacts={readHeldFacts} />);
        expect(reads).toBe(readCount);
        expect(current.model).toBe(countedModel);
        // A rebuilt ordinary corpus with identical facts keeps the published count projection unchanged.
        await screen.update(<HeaderProbe readFacts={() => { reads++; return [...facts]; }} />);
        expect(current.model).toBe(countedModel);
        await screen.update(<HeaderProbe readFacts={() => [...facts, { ...facts[0]!, key: 'unknown', fields: {} }]} />);
        expect(current.model.availableFields[0]!.valueOptions.every(option => option.count === undefined)).toBe(true);
        await screen.pressByTestIdAsync('collection-filter-back');
        expect(current.model.availableFields[0]!.valueOptions.every(option => option.count === undefined)).toBe(true);
        const closedReads = reads;
        await screen.update(<HeaderProbe readFacts={() => { reads++; return [...facts]; }} />);
        expect(reads).toBe(closedReads);
    } finally { vi.unstubAllGlobals(); }
});

it('opens the filter editor at the search field\'s width, and keeps its own width under a header button', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-filter-width.test');
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
        const items = Array.from({ length: 9 }, (_, i) => skill(`width-${i}`));
        const withField = await renderScreen(<SkillsList variant="rail" library={library(items)} />);
        // The field's frame is measured once the rail has laid out; the editor opens under it.
        withField.findAll(node => node.props.testID === 'skills.rail.search' && node.props.anchorRef !== undefined)[0]!.props.anchorRef.current = { measure: vi.fn() };
        await act(async () => withField.pressByTestId('skills.rail-filter-open'));
        const under = withField.findAll(node => node.props.placement === 'bottom' && node.props.open === true && node.props.anchorRef !== undefined)[0]!;
        expect(under.props.portal.matchAnchorWidth).toBe(true);

        // A short list has no search field: the editor hangs from the filter button at its own width.
        const noField = await renderScreen(<SkillsList variant="rail" library={library(items.slice(0, 2))} />);
        await act(async () => noField.pressByTestId('skills.rail-filter-open'));
        const hung = noField.findAll(node => node.props.placement === 'bottom' && node.props.open === true && node.props.anchorRef !== undefined)[0]!;
        expect(hung.props.portal.matchAnchorWidth).toBe(false);
    } finally { vi.unstubAllGlobals(); await standardCleanup(); await home.dispose(); }
});

it.each(['rail', 'page'] as const)('anchors the %s filter editor on the search field, not on the filter button inside its well', async variant => {
    const home = await createSkillsSurfaceHarness(`https://skills-filter-anchor-${variant}.test`);
    const items = Array.from({ length: 9 }, (_, i) => skill(`anchor-${i}`));
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
        const screen = await renderScreen(<SkillsList variant={variant} library={library(items)} />);
        await act(async () => screen.pressByTestId('skills.rail-filter-open'));
        const field = screen.findAll(node => node.props.testID === 'skills.rail.search' && node.props.anchorRef !== undefined)[0];
        const popover = screen.findAll(node => node.props.placement === 'bottom' && node.props.open === true && node.props.anchorRef !== undefined)[0];
        expect(field).toBeDefined();
        expect(popover).toBeDefined();
        // What the search field's frame resolves to is what the editor opens under.
        const frame = { measure: vi.fn() };
        field!.props.anchorRef.current = frame;
        expect(popover!.props.anchorRef.current).toBe(frame);
    } finally { vi.unstubAllGlobals(); await standardCleanup(); await home.dispose(); }
});

it("keeps the shared reach overview and rail rows in the phone page's single list", async () => {
    const home = await createSkillsSurfaceHarness('https://skills-page-anatomy.test');
    try {
        const screen = await renderScreen(<SkillsList variant="page" library={library([skill('on'), skill('off', { rules: [] })])} />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.rail.row.on')).not.toBeNull());
        const header = screen.findAll(node => node.props.testID === 'skills.page.header' && node.props.titleAccessory !== undefined)[0];
        expect(header?.props.titleAccessory).toBeTruthy();
        expect(screen.findByTestId('skills.home.reach')).not.toBeNull();
        expect(screen.findAll(node => node.props.testID === 'skills.rail.row.on' && node.props.density !== undefined)[0]?.props.density).toBe('rail');
        expect(groupOf(screen, 'on')).toBe('inUse');
        await screen.unmount();
    } finally { await home.dispose(); }
});
