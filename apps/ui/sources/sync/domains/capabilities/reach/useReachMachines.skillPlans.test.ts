import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Network and native boundaries are installed before the real catalog/reach composition loads.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { useReachMachines, projectReachOnMachines } = await import('./useReachProjection');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { buildSkillsReach, skillPlanOnMachine } = await import('@/components/settings/skills/skillsCollectionModel');
const { useAgentCatalogIdentities } = await import('@/agents/registry/useSessionAgentCatalogIdentity');
const { useWhereItsOnNames } = await import('@/components/capabilities/where/useWhereItsOnNames');
const { useSkillPlaces } = await import('@/components/settings/skills/useSkillPlaces');
const { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { WhereItsOnControl } = await import('@/components/capabilities/where/WhereItsOnControl');
const { describeReach } = await import('@/components/capabilities/where/whereItsOnPresentation');
const { summarizeMachines } = await import('@/components/settings/skills/detail/skillMachineSummary');
const { withdrawMachinePresenceForScope, recordMachineRequestFailed, recordMachineRequestSucceeded, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useMcpAddPlaces } = await import('@/components/settings/mcpServers/add/useMcpAddPlaces');
const machineDisplayNames = await import('@/utils/sessions/machineDisplayNames');
const { useMcpSignInViewOf } = await import('@/components/settings/mcpServers/signIn/useMcpSignInViewOf');
const { useMcpServerSignIn } = await import('@/components/settings/mcpServers/signIn/useMcpServerSignIn');
const { McpServersSettingsV1Schema } = await import('@happier-dev/protocol/mcp/servers/settingsV1');
const { useReachRulesState } = await import('./useReachRulesState');
const { reachRuleKeyV1 } = await import('@happier-dev/protocol/reach/reachRulesChangeV1');
const { SkillsRulesSetInputV1Schema, McpRulesSetInputV1Schema } = await import('@happier-dev/protocol/actions/specs/capabilityRules');
const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
const { createMcpServerActionExecuteV1 } = await import('@happier-dev/protocol/mcp/servers/serverActionsV1');
const { commitMcpServerCatalogMutationV1 } = await import('@happier-dev/protocol/mcp/servers/serverCatalogV1');
const { McpServerCatalogV1Schema } = await import('@happier-dev/protocol/mcp/servers/serverRowsV1');
const { PromptLibraryRecordV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
const { WorkspaceRefV1Schema } = await import('@happier-dev/protocol/workspaces/workspaceRefV1');
const before = storage.getState();
// Global cleanup retires runtimeFetch after each case; reinstall the network boundary before use.
beforeEach(() => network.resetRequests());
it('ignores unrelated raw Machine activity while keeping real capability facts current', async () => {
    const serverUrl = 'https://reach-subscription-cost.test';
    await network.addHome(serverUrl, 'reach-cost-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_reach_cost', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'reach-cost-account' };
    storage.setState({ settingsScope: scope, profileScope: scope });
    const machines = Array.from({ length: 101 }, (_, i) => createMachineFixture({ id: `reach-cost-${i}`,
        activeAt: Date.now(), daemonState: { pid: 100, contributionRegistryProjectionRevision: 1 }, metadata: { ...createMachineFixture().metadata!,
            agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } } }));
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    let renders = 0;
    const nameProjections = vi.spyOn(machineDisplayNames, 'resolveMachineDisplayNames');
    const hook = await renderHook(() => { renders++; return useReachMachines(); });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().machines).toHaveLength(101));
        await act(async () => storage.setState({ settingsScope: { ...scope, serverId: home.id } }));
        expect(hook.getCurrent().machines).toHaveLength(101);
        await act(async () => storage.setState({ settingsScope: scope }));
        const settled = renders;
        const previous = hook.getCurrent().machines;
        nameProjections.mockClear();
        for (let i = 0; i < 5; i++) await act(async () => {
            const machine = storage.getState().machines['reach-cost-0']!;
            storage.getState().applyMachines([{ ...machine, daemonStateVersion: machine.daemonStateVersion + 1,
                daemonState: { ...machine.daemonState, resources: { cpu: { percent: i + 1 } } } }], false,
            { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
        });
        expect(renders - settled).toBe(0);
        expect(nameProjections).not.toHaveBeenCalled();
        expect(hook.getCurrent().machines).toBe(previous);
        await act(async () => {
            const machine = storage.getState().machines['reach-cost-0']!;
            storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                metadata: { ...machine.metadata!, displayName: 'Renamed build machine' } }], false,
            { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
        });
        expect(hook.getCurrent().machines.find(machine => machine.machineId === 'reach-cost-0')?.name).toBe('Renamed build machine');
        const retainedDisplays = storage.getState().machineDisplayById;
        await act(async () => {
            await TokenStorage.removeCredentialsForServerUrl(serverUrl);
            // Credential retirement precedes Sync clearing its admitted display inputs.
            // Hold that projection to prove retirement, not the later reset, withdraws it.
            storage.setState({ settingsScope: scope, profileScope: scope, machineDisplayById: retainedDisplays });
        });
        expect(storage.getState().profileScope).toEqual(scope);
        expect(hook.getCurrent().machines).toEqual([]);
    } finally { nameProjections.mockRestore(); await hook.unmount(); }
});

it('uses the visible-machine owner for Reach machine totals and destinations', async () => {
    const serverUrl = 'https://visible-reach.test';
    await network.addHome(serverUrl, 'visible-reach-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_visible_reach', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    const scope = { serverId: 'srv_visible_reach', accountId: 'visible-reach-account' };
    const machines = [createMachineFixture({ id: 'visible' }), createMachineFixture({ id: 'revoked', revokedAt: 1 }),
        createMachineFixture({ id: 'replaced', replacedByMachineId: 'visible' }),
        createMachineFixture({ id: 'runner', kind: 'ephemeral_session_runner' })];
    storage.setState({ settingsScope: scope, profileScope: scope });
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const hook = await renderHook(() => useReachMachines());
    try {
        await vi.waitFor(() => expect(hook.getCurrent().machines.map(machine => machine.machineId)).toEqual(['visible']));
        expect(hook.getCurrent().placeMachines.map(machine => machine.machineId)).toEqual(['visible']);
    } finally { await hook.unmount(); }
});

it('keeps warm capability places unknown, then retains answered presence across socket withdrawal within the exact Account', async () => {
    const serverUrl = 'https://capability-presence.test';
    await network.addHome(serverUrl, 'capability-presence-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_capability_presence', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'capability-presence-account' };
    const machines = [createMachineFixture({ id: 'online', active: true, activeAt: Date.now() }),
        createMachineFixture({ id: 'offline', active: false, activeAt: 1 })].map(machine => ({ ...machine,
            metadata: { ...machine.metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } } }));
    storage.setState({ settingsScope: scope, profileScope: scope });
    storage.getState().replaceMachineDisplays(machines, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{ id: 'oauth', name: 'oauth', transport: 'http', env: {},
        remote: { url: 'https://oauth.example/mcp', headers: {}, auth: { kind: 'oauth' } }, createdAt: 1, updatedAt: 1 }], bindings: [] });
    const hook = await renderHook(() => {
        const mcp = useMcpAddPlaces();
        return { skills: useSkillPlaces(), mcp, signInViewOf: useMcpSignInViewOf(settings, scope),
            signIn: useMcpServerSignIn(settings.servers[0]!, mcp.placeMachines) };
    });
    try {
        expect(hook.getCurrent().signInViewOf('oauth')?.state).toBe('not_connected');
        expect(hook.getCurrent().signIn.view?.state).toBe('not_connected');
        for (const places of [hook.getCurrent().skills, hook.getCurrent().mcp]) {
            expect(places.placeMachines.every(machine => machine.online === null)).toBe(true);
            expect(places.machines.every(machine => machine.offline === false)).toBe(true);
            const projection = projectReachOnMachines([{ id: 'all', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }], places.machines);
            const consequence = describeReach(projection, places.placeMachines, places.names, () => 'full');
            expect(consequence.availableAgentIds).toEqual([]);
            expect(consequence.notes).toEqual([]);
            expect(consequence.availabilityUnknown).toBe(true);
            const reach = buildSkillsReach([], places.machines);
            expect(reach.onlineInventory).toBe(false);
            expect(reach.offlineMachineIds).toEqual([]);
            expect(reach.bodies.every(body => !body.online)).toBe(true);
            expect(summarizeMachines(places.machines.map(machine => ({ machine, skillAgents: ['codex'], cannotLoad: [],
                facts: new Map([['codex', { kind: 'delivered' as const }]]), projectedAgents: ['codex'] })), ids => ids))
                .toEqual({ summary: 'Unknown', note: undefined });
        }
        await act(async () => storage.getState().applyMachines(machines, true,
            { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }));
        expect(hook.getCurrent().skills.placeMachines.find(machine => machine.machineId === 'online')?.online).toBe(true);
        expect(hook.getCurrent().skills.machines.find(machine => machine.machineId === 'offline')).toMatchObject({ offline: true });
        // a4df3f74f0e: Account socket withdrawal retains the Machine's settled presence.
        const answered = hook.getCurrent();
        await act(async () => withdrawMachinePresenceForScope(scope));
        expect(hook.getCurrent().skills).toBe(answered.skills);
        expect(hook.getCurrent().mcp).toBe(answered.mcp);
        await act(async () => recordMachineRequestFailed({ ...scope, accountId: 'another-account', machineId: 'online' }));
        expect(hook.getCurrent().skills.placeMachines.find(machine => machine.machineId === 'online')?.online).toBe(true);
        await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'online' }));
        expect(hook.getCurrent().skills.placeMachines.find(machine => machine.machineId === 'online')?.online).toBe(false);
        await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: 'online' }));
        expect(hook.getCurrent().skills.placeMachines.find(machine => machine.machineId === 'online')?.online).toBe(true);
        expect(hook.getCurrent().signInViewOf('oauth')?.state).toBe('not_connected');
        expect(hook.getCurrent().signIn.view?.state).toBe('not_connected');
    } finally { await hook.unmount(); clearMachineRequestReachabilityForTest(); }
});
it.each(['skill', 'mcp_server'] as const)('%s mounts Account Project choices and writes Only/Except with D33 precedence', async kind => {
    const serverUrl = 'https://project-places.test';
    await network.addHome(serverUrl, 'project-places-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_project_places', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'project-places-account' };
    const machines = ['a', 'b'].map(id => createMachineFixture({ id, activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'gemini'] },
    } }));
    const refs = machines.map(machine => WorkspaceRefV1Schema.parse({ id: `checkout-${machine.id}`, serverId: scope.serverId,
        machineId: machine.id, projectKey: 'project-key', rootPath: `/src/${machine.id}/garden`, label: 'Garden', createdAtMs: 1 }));
    storage.setState({ settingsScope: scope, profileScope: scope, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' },
        projectAccountRows: createProjectAccountRowsFixture(scope, { workspaceRefs: [...refs,
            { ...refs[0]!, id: 'second-checkout-a', rootPath: '/src/worktree' },
            { ...refs[0]!, id: 'foreign', serverId: 'srv_another_home', projectKey: 'foreign-project' }],
        }) });
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const placesHook = await renderHook(() => kind === 'skill' ? useSkillPlaces() : useMcpAddPlaces());
    expect(placesHook.getCurrent().names.projectName('project-key')).toBe('Garden');
    expect(placesHook.getCurrent().projects).toEqual([{ projectKey: 'project-key', name: 'Garden', machineCount: 2 }]);
    const foreignSessionPlaces = await renderHook(() => useSkillPlaces('srv_another_home'));
    expect(foreignSessionPlaces.getCurrent().projects).toEqual([]);
    expect(foreignSessionPlaces.getCurrent().names.projectName('project-key')).toBe('project-key');
    await foreignSessionPlaces.unmount();
    const firstProjects = placesHook.getCurrent().projects;
    await act(async () => storage.setState({ settingsVersion: 42 }));
    expect(placesHook.getCurrent().projects).toBe(firstProjects);
    const writes: Array<{ actionId: string; change: import('@happier-dev/protocol/reach/reachRulesChangeV1').ReachRulesChangeV1 }> = [];
    const acknowledgments: unknown[] = [];
    let persisted: import('@happier-dev/protocol/reach/reachRuleV1').ReachRulesV1 = [];
    let revision = 1;
    let nextId = 0;
    let initialRules: import('@happier-dev/protocol/reach/reachRuleV1').ReachRulesV1 = [];
    const ruleWriteContext = () => ({ nowMs: revision + 1, newId: () => `rule-${nextId++}` });
    const mcpCatalog = () => McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'item', name: 'garden-helper',
        transport: 'stdio', stdio: { command: 'garden-helper', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: persisted.map(rule => ({ ...rule, serverId: 'item' })) });
    // Only durable-row and library reads/writes are substituted; admission, Actions, mutation,
    // receipt schemas, optimistic state, places, sentence and resolver remain real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        // The native confirmation dialog is a host boundary; policy still decides whether to open it.
        presentUserActionConfirmation: async () => true,
        skillRules: {
            serverId: scope.serverId,
            assertCurrent: () => { expect(storage.getState().settingsScope).toEqual(scope); },
            ruleWriteContext,
            listSkills: async () => [{ id: 'item', name: 'garden-helper' }],
            readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ revision,
                record: PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: { v: 1,
                    rules: persisted.map(rule => ({ ...rule, skillId: 'item' })) } }) }], tombstones: [], diagnostics: [] } }),
            writeRecord: async input => {
                if (input.expectedRevision !== revision) return { status: 'conflict', revision };
                const record = PromptLibraryRecordV1Schema.parse(input.record);
                if (record.key !== 'skill-rules') throw new Error('Unexpected row write');
                persisted = record.value.rules.map(({ skillId: _skillId, ...rule }) => rule);
                return { status: 'updated', revision: ++revision, cursor: revision };
            },
        },
        mcpServerAction: createMcpServerActionExecuteV1({
            readCatalog: async () => ({ status: 'ready', authority: 'active', revision, scope,
                diagnostics: [], catalog: mcpCatalog() }),
            mutate: async (change, expectedRevision) => {
                if (expectedRevision !== revision) return { status: 'conflict', revision };
                return commitMcpServerCatalogMutationV1({ catalog: mcpCatalog(), revision, change, scope,
                    ctx: ruleWriteContext(), writeCatalog: async input => {
                        if (input.expectedRevision !== revision) return { status: 'conflict', revision };
                        persisted = input.catalog.bindings.map(({ serverId: _serverId, ...rule }) => rule);
                        return { status: 'updated', revision: ++revision, cursor: revision };
                    } });
            },
            machine: async () => { throw new Error('Unexpected Machine operation'); },
        }),
    }));
    const execute: import('./useReachRulesState').ExecuteReachRules = async (actionId, input) => {
        const parsed = (actionId === 'skills.rules.set' ? SkillsRulesSetInputV1Schema : McpRulesSetInputV1Schema).parse(input);
        writes.push({ actionId, change: parsed.change });
        try {
            const receipt = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
                actionCaller: { kind: 'host' }, serverId: scope.serverId });
            acknowledgments.push(receipt);
            return receipt;
        } catch (error) {
            acknowledgments.push(error);
            throw error;
        }
    };
    function ProjectControl() {
        const places = kind === 'skill' ? useSkillPlaces() : useMcpAddPlaces();
        const reach = useReachRulesState({ key: `${kind}/item`, kind, itemId: 'item', rules: initialRules,
            status: 'ready', revision: 1, valueAvailable: true }, execute);
        return React.createElement(WhereItsOnControl, { kind, rules: reach.rules, status: reach.status,
            projection: projectReachOnMachines(reach.rules, places.machines, undefined, places.workspaceRefs),
            places: { agentIds: places.agentIds, machines: places.placeMachines, projects: places.projects },
            onChange: reach.change, onUndo: async () => { await reach.undoLast(); },
            presentation: 'section', testID: 'account-project' });
    }
    let screen = await renderScreen(React.createElement(ProjectControl));
    const node = (testID: string, handler: string) => screen.findAll(n => n.props.testID === testID && typeof n.props[handler] === 'function')[0]!;
    const choose = async (testID: string, id: string) => { await act(async () => { await node(testID, 'onSelect').props.onSelect(id); }); };
    await act(async () => node('account-project:sentence', 'onPress').props.onPress());
    const menu = node('account-project:addMenu', 'onSelect');
    expect(menu.props.items.flatMap((item: { id: string }) => item.id)).toContain('project:project-key');
    expect(menu.props.items.flatMap((item: { id: string }) => item.id)).not.toContain('project:foreign-project');
    await choose('account-project:addMenu', 'project:project-key');
    expect(acknowledgments).toEqual([{ ok: true, result: expect.objectContaining({ ok: true }) }]);
    expect(writes[0]).toMatchObject({ actionId: kind === 'skill' ? 'skills.rules.set' : 'mcp.rules.set',
        change: { kind: 'replace', rules: [{ target: { t: 'project', projectKey: 'project-key' }, enabled: true }] } });
    const summaryText = async (renderer = screen) => {
        await renderer.pressByTestIdAsync('account-project:sentence');
        const result = renderer.getTextContent().replace(/\s+/gu, ' ');
        await renderer.pressByTestIdAsync('account-project:sentence');
        return result;
    };
    expect(await summaryText()).toContain('Only in Garden');
    expect(projectReachOnMachines(persisted, placesHook.getCurrent().machines, undefined, refs)
        .filter(row => row.projectKey === 'project-key').map(row => row.machineId)).toEqual(['a', 'b']);
    await act(async () => screen.findByType(WhereItsOnControl).props.onUndo());
    expect(persisted).toEqual([]);
    await choose('account-project:addMenu', 'project:project-key');
    await screen.unmount();
    initialRules = [...persisted, { id: 'gemini-off', target: { t: 'allMachines' }, agentId: 'gemini',
        enabled: false, createdAt: 1, updatedAt: 1 }];
    persisted = initialRules;
    screen = await renderScreen(React.createElement(ProjectControl));
    await act(async () => node('account-project:sentence', 'onPress').props.onPress());
    expect(await summaryText()).toContain('except Gemini');
    expect(projectReachOnMachines(persisted, placesHook.getCurrent().machines, 'project-key')
        .every(row => row.agents.find(agent => agent.agentId === 'gemini')?.enabled === false)).toBe(true);
    const projectRow = `account-project:rule:${reachRuleKeyV1({ target: { t: 'project', projectKey: 'project-key' } })}`;
    await choose(`${projectRow}:agents`, 'gemini');
    expect(await summaryText()).toContain('for Gemini in Garden');
    expect(projectReachOnMachines(persisted, placesHook.getCurrent().machines, 'project-key')
        .every(row => row.agents.find(agent => agent.agentId === 'gemini')?.enabled === true)).toBe(true);
    expect(projectReachOnMachines(persisted, placesHook.getCurrent().machines, 'other-project')
        .every(row => row.agents.find(agent => agent.agentId === 'gemini')?.enabled === false)).toBe(true);
    await screen.unmount();
    initialRules = []; persisted = []; revision = 1;
    const exceptScreen = await renderScreen(React.createElement(ProjectControl));
    await act(async () => exceptScreen.findAll(n => n.props.testID === 'account-project:sentence' && typeof n.props.onPress === 'function')[0]!.props.onPress());
    await act(async () => exceptScreen.findAll(n => n.props.testID === 'account-project:everywhere' && typeof n.props.onChange === 'function')[0]!.props.onChange('on'));
    await act(async () => exceptScreen.findAll(n => n.props.testID === 'account-project:addMenu' && typeof n.props.onSelect === 'function')[0]!.props.onSelect('project:project-key'));
    expect(writes.at(-1)).toMatchObject({ actionId: kind === 'skill' ? 'skills.rules.set' : 'mcp.rules.set',
        change: { rules: expect.arrayContaining([{ target: { t: 'project', projectKey: 'project-key' }, enabled: false }]) } });
    expect(await summaryText(exceptScreen)).toContain('except in Garden');
    await exceptScreen.unmount();
    const rows = storage.getState().projectAccountRows!;
    await act(async () => storage.setState({ projectAccountRows: { ...rows, status: 'loading', organizations: [
        { key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'project-key' },
            revision: 2, value: { label: 'Garden tools', hidden: true } },
    ] } }));
    expect(placesHook.getCurrent().names.projectName('project-key')).toBe('Garden tools');
    expect(placesHook.getCurrent().projects).toEqual([{ projectKey: 'project-key', name: 'Garden tools', machineCount: 2 }]);
    await act(async () => storage.setState({ settingsScope: { ...scope, accountId: 'another-account' } }));
    expect(placesHook.getCurrent().projects).toEqual([]);
    expect(placesHook.getCurrent().names.projectName('project-key')).toBe('project-key');
    await placesHook.unmount();
});
afterEach(async () => { await standardCleanup(); storage.setState(before, true); clearDaemonMergedProjectionCacheForTests();
    resetAcpCatalogSnapshotsForTests(); });
afterAll(() => network.dispose());

it('names same-name Account machines apart, as every machine list does', async () => {
    const serverUrl = 'https://reach-same-name.test';
    await network.addHome(serverUrl, 'reach-same-name-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_reach_same_name', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'reach-same-name-account' };
    const machines = ['08ccb961', '6a1f02d4', 'b7c3aa10'].map((id, index) => createMachineFixture({ id, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, host: 'shared-host', displayName: index < 2 ? 'Build box' : 'Laptop' } }));
    storage.setState({ settingsScope: scope, profileScope: scope, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const facts = await renderHook(() => useReachMachines());
    try {
        expect(facts.getCurrent().machines.map(machine => machine.name)).toEqual(['Build box · 08cc', 'Build box · 6a1f', 'Laptop']);
    } finally { await facts.unmount(); }
});

it('names admitted warm displays without requiring presence and withdraws locked or retired names', async () => {
    const serverUrl = 'https://reach-warm-names.test';
    await network.addHome(serverUrl, 'reach-warm-names-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_reach_warm_names', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'reach-warm-names-account' };
    const options = { sourceServerId: scope.serverId, sourceAccountId: scope.accountId };
    storage.setState({ settingsScope: scope, profileScope: scope, machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
    const machine = createMachineFixture({ id: 'warm-name', metadata: {
        ...createMachineFixture().metadata!, displayName: 'Warm builder', host: 'warm-host',
        agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] },
    } });
    storage.getState().replaceMachineDisplays([machine], options);
    const hook = await renderHook(() => useReachMachines());
    try {
        expect(hook.getCurrent().machines[0]).toMatchObject({ name: 'Warm builder', online: null, lastSeenAt: null });
        expect(hook.getCurrent().placeMachines).toEqual([{ machineId: machine.id, name: 'Warm builder' }]);
        await act(async () => storage.getState().replaceMachineDisplays([{ ...machine, metadata: null,
            availability: { kind: 'locked', reason: 'decryption_failed' }, metadataVersion: machine.metadataVersion + 1 }], options));
        expect(hook.getCurrent().machines[0]?.name).toBeTruthy();
        expect(hook.getCurrent().machines[0]?.name).not.toContain('Warm builder');
        expect(hook.getCurrent().placeMachines[0]?.name).toBe(hook.getCurrent().machines[0]?.name);
        const retainedDisplays = storage.getState().machineDisplayById;
        await act(async () => {
            await TokenStorage.removeCredentialsForServerUrl(serverUrl);
            storage.setState({ settingsScope: scope, profileScope: scope, machineDisplayById: retainedDisplays });
        });
        expect(hook.getCurrent().machines).toEqual([]);
        expect(hook.getCurrent().placeMachines).toEqual([]);
    } finally { await hook.unmount(); }
});

it('composes installed Machine publication and real catalog demand into passive skill-plan reach', async () => {
    const serverUrl = 'https://skill-plans-reach.test';
    await network.addHome(serverUrl, 'skill-plans-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_skill_plans', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'skill-plans-account' };
    const machine = createMachineFixture({ id: 'online', activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'gemini'] },
    } });
    storage.setState({ settingsScope: scope, profileScope: scope });
    storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {
        codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            capabilities: { tools: { delivery: 'native_mcp' }, skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' } } },
        gemini: { id: 'gemini', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
    } });
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { protocolVersion: 1, projection });
    network.setHttpResponder(async url => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        return null;
    });
    const facts = await renderHook(() => ({ reach: useReachMachines(), skillPlaces: useSkillPlaces(), mcpPlaces: useMcpAddPlaces(),
        credentials: useServerCredentialAccountScopeBinding(scope.serverId) }));
    try {
        await vi.waitFor(() => expect(facts.getCurrent().credentials.binding).not.toBeNull());
        expect(network.requests).toEqual([]);
        await act(async () => {
            const entry = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'online', serverId: scope.serverId,
                accountLifetime: facts.getCurrent().credentials.binding! });
            expect(entry, JSON.stringify({ entry, methods: network.requests.map(request => request.method) })).toMatchObject({ kind: 'ready' });
        });
        const machines = facts.getCurrent().reach.machines;
        expect(machines[0]?.agentDeclarationsById).toEqual(projection.agentsById);
        expect(skillPlanOnMachine(machines[0]!, 'codex')).toBe('session_dir');
        expect(facts.getCurrent().skillPlaces.agentTakes('codex')).toBe('full');
        expect(facts.getCurrent().mcpPlaces.agentTakes('gemini')).toBe('none');
        const item = SkillListItemV1Schema.parse({ skillId: 'reaching', name: 'reaching', description: null,
            revision: '1:1', rules: [{ id: 'on', skillId: 'reaching', target: { t: 'allMachines' },
                enabled: true, createdAt: 1, updatedAt: 1 }], trust: 'text_only', cost: { descriptionTokens: 1, bodyTokens: 2 },
            provenance: { kind: 'written' }, modified: false, updatePolicy: 'manual', createdAt: 1,
            migratedFromContext: false, userInvocable: true, folderId: null });
        expect(buildSkillsReach([item], machines).agentIds).toEqual(['codex']);
        const requests = network.requests.length;
        await facts.rerender();
        expect(network.requests).toHaveLength(requests);
    } finally { await facts.unmount(); }
});

it('composes concrete ACP inventory and the Account catalog into distinct configured names without naming a bare carrier', async () => {
    const serverUrl = 'https://configured-reach-identity.test';
    await network.addHome(serverUrl, 'configured-identity-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_configured_reach_identity', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'configured-identity-account' };
    const machine = createMachineFixture({ id: 'configured-machine', activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'custom-acp'] },
    } });
    storage.setState({ settingsScope: scope, profileScope: scope });
    storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['review', 'build', 'absent'].map(id => ({
        id, name: id, title: `${id} configured agent`, launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] },
        env: {}, createdAt: 1, updatedAt: 1,
    })) });
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record }, true);
    const agentIds = ['custom-acp'];
    const places = [{ machineId: machine.id, name: 'Build machine' }];
    const projects = [] as const;
    const hook = await renderHook(() => ({
        reach: useReachMachines(),
        identities: useAgentCatalogIdentities({ agentIds, machineId: machine.id, serverId: scope.serverId }),
        names: useWhereItsOnNames({ agentIds, machines: places, projects, serverId: scope.serverId }),
        skillPlaces: useSkillPlaces(),
        mcpPlaces: useMcpAddPlaces(),
        credentials: useServerCredentialAccountScopeBinding(scope.serverId),
    }));
    try {
        expect(hook.getCurrent().reach.machines[0]?.agentIds).toEqual(['codex']);
        expect(hook.getCurrent().reach.machines[0]?.agentInventoryComplete).toBe(false);
        expect(hook.getCurrent().identities).toEqual([]);
        const rule = { id: 'on', skillId: 'skill', target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 };
        const knownProjection = projectReachOnMachines([rule], hook.getCurrent().reach.machines);
        expect(knownProjection[0]?.agentInventoryComplete).toBe(false);
        const places = hook.getCurrent().skillPlaces;
        expect(describeReach(knownProjection, places.placeMachines, places.names, places.agentTakes).availabilityUnknown).toBe(false);
        const emptyProjection = projectReachOnMachines([{ ...rule, enabled: false }], hook.getCurrent().reach.machines);
        expect(describeReach(emptyProjection, places.placeMachines, places.names, places.agentTakes).availabilityUnknown).toBe(true);
        const inventoryItems = record.definitions.map(definition => MachineAgentInventoryItemSchema.parse({
            agentId: 'custom-acp', definitionId: definition.id, title: 'Outdated inventory name', installed: definition.id !== 'absent',
            version: '1', latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'unknown', loginSupport: 'unsupported', required: false }, platform: { supported: true },
            install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
        }));
        await act(async () => {
            machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
                status: 'ready', lastCheckedAt: 3, items: inventoryItems,
            });
        });
        expect(hook.getCurrent().reach.machines[0]?.agentIds).toEqual(['codex', 'custom-acp']);
        expect(hook.getCurrent().reach.machines[0]?.agentInventoryComplete).toBe(true);
        // The generic ACP contribution has bundled runtime facts even without a UI core or warm daemon declaration.
        expect(hook.getCurrent().mcpPlaces.agentTakes('custom-acp')).toBe('full');
        const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {
            'custom-acp': { id: 'custom-acp', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
                capabilities: { tools: { delivery: 'native_mcp' } } },
        } });
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { protocolVersion: 1, projection });
        await act(async () => {
            const entry = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: machine.id, serverId: scope.serverId,
                accountLifetime: hook.getCurrent().credentials.binding! });
            expect(entry).toMatchObject({ kind: 'ready' });
        });
        expect(hook.getCurrent().mcpPlaces.agentTakes('custom-acp')).toBe('full');
        const requestsAfterProjection = network.requests.length;
        expect(hook.getCurrent().reach.machines[0]?.agentIds).toEqual(['codex', 'custom-acp']);
        expect(hook.getCurrent().reach.machines[0]?.agentInventoryComplete).toBe(true);
        expect(hook.getCurrent().identities.map(identity => [identity.entry.title, identity.entry.backendTargetKey, identity.entry.iconName]))
            .toEqual([
                ['review configured agent', 'agent:happier.agent.custom-acp/custom-acp:definition:review', 'hard-drives'],
                ['build configured agent', 'agent:happier.agent.custom-acp/custom-acp:definition:build', 'hard-drives'],
            ]);
        const name = hook.getCurrent().names.names.agentName('custom-acp');
        expect(name).toContain('review configured agent');
        expect(name).toContain('build configured agent');
        expect(name).not.toContain('absent configured agent');
        // A sentence that lists Agents gets each instance title on its own, never one joined "a and b" entry.
        expect(hook.getCurrent().names.names.agentNames(['codex', 'custom-acp']).slice(-2).sort())
            .toEqual(['build configured agent', 'review configured agent']);
        expect(hook.getCurrent().names.identityById.get('custom-acp')).toBeUndefined();
        expect(hook.getCurrent().names.identityById.get('agent:happier.agent.custom-acp/custom-acp:definition:review')?.entry.title)
            .toBe('review configured agent');
        expect(hook.getCurrent().names.identityById.get('agent:happier.agent.custom-acp/custom-acp:definition:build')?.entry.title)
            .toBe('build configured agent');
        const previousNames = hook.getCurrent().skillPlaces.names;
        await act(async () => machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
            status: 'ready', lastCheckedAt: 4, items: [],
        }));
        expect(hook.getCurrent().skillPlaces.names).toBe(previousNames);
        expect(network.requests).toHaveLength(requestsAfterProjection);
        function ConfiguredWhere() {
            const skillPlaces = useSkillPlaces();
            return React.createElement(WhereItsOnControl, {
                kind: 'skill', rules: [rule], status: 'ready',
                projection: projectReachOnMachines([rule], skillPlaces.machines),
                places: { agentIds: skillPlaces.agentIds, machines: skillPlaces.placeMachines, projects: [] },
                agentTakes: skillPlaces.agentTakes,
                onChange: async () => ({ ok: true as const }), presentation: 'pick', testID: 'configured-where',
            });
        }
        const screen = await renderScreen(React.createElement(ConfiguredWhere));
        const directText = (children: unknown): string => typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(directText).join('') : '';
        const renderedText = () => screen.findAll(() => true).map(node => directText(node.props.children)).join(' ');
        expect(renderedText()).toContain('review configured agent');
        expect(renderedText()).toContain('build configured agent');
        expect(renderedText()).not.toContain('absent configured agent');
        // 8e4096d97cb draws unbranded configured identities through the shared text-mark owner.
        expect(renderedText()).toMatch(/\bR\b/);
        expect(renderedText()).toMatch(/\bB\b/);
        await act(async () => machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
            status: 'ready', lastCheckedAt: 5, items: inventoryItems.map(item => ({ ...item, installed: item.definitionId === 'build' })),
        }));
        expect(hook.getCurrent().skillPlaces.names.agentNames(['custom-acp'])).toEqual(['build configured agent']);
        expect(renderedText()).not.toContain('review configured agent');
        await act(async () => applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 2, record: { v: 1, definitions: [] } }, true));
        expect(hook.getCurrent().identities).toEqual([]);
        expect(hook.getCurrent().reach.machines[0]?.agentIds).toEqual(['codex']);
        expect(hook.getCurrent().reach.machines[0]?.agentInventoryComplete).toBe(true);
        expect(renderedText()).not.toContain('review configured agent');
        expect(renderedText()).not.toContain('build configured agent');
    } finally { await hook.unmount(); }
});

it('keeps the published machines when an inventory refresh re-reads the same Agents', async () => {
    const serverUrl = 'https://reach-equal-refresh.test';
    await network.addHome(serverUrl, 'reach-equal-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_reach_equal', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'reach-equal-account' };
    const machine = createMachineFixture({ id: 'equal-machine', activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] },
    } });
    storage.setState({ settingsScope: scope, profileScope: scope, machines: { [machine.id]: machine },
        machineListByServerId: { [scope.serverId]: [machine] }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const items = [MachineAgentInventoryItemSchema.parse({
        agentId: 'codex', title: 'Codex', installed: true, version: '1', latestVersion: null, update: { supported: false, command: null },
        signIn: { status: 'unknown', loginSupport: 'unsupported', required: false }, platform: { supported: true },
        install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
    })];
    const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
    const hook = await renderHook(() => useReachMachines());
    try {
        await act(async () => machineAgentInventoryStore.publish(key, { status: 'ready', lastCheckedAt: 3, items }));
        await vi.waitFor(() => expect(hook.getCurrent().machines[0]?.agentInventoryComplete).toBe(true));
        const settled = hook.getCurrent();
        // The next check finds the very same Agents; only its check time moved.
        await act(async () => machineAgentInventoryStore.publish(key, { status: 'ready', lastCheckedAt: 4, items: items.map(item => ({ ...item })) }));
        expect(hook.getCurrent().machines).toBe(settled.machines);
        expect(hook.getCurrent().agentIds).toBe(settled.agentIds);
    } finally { await hook.unmount(); }
});
