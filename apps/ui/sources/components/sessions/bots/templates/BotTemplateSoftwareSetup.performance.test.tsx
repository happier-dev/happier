import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { MachineSetupObservationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineSetupPlanInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectedMachineRecipeEntryV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { BotTemplateSetupSelectionsV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { BotTemplateSoftwareSetup } = await import('./BotTemplateSoftwareSetup');
let previousState: ReturnType<typeof storage.getState>;

beforeEach(async () => {
    previousState = storage.getState();
    await homes.reset();
    network.resetRequests();
    network.setHttpResponder(async (input, init) => {
        if (new URL(String(input)).pathname.startsWith('/v1/machines/')) return null;
        return homes.request(input, init);
    });
});
afterEach(async () => {
    vi.useRealTimers();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await standardCleanup();
    storage.setState(previousState, true);
});
afterAll(async () => { await network.dispose(); });

describe('BT3.F2 selected software demand cost', () => {
    it('keeps one selected plan across edits and unrelated inventory, with no settled or closed reads', async () => {
        const serverUrl = 'https://template-software-cost.test';
        const serverIdentityId = 'srv_template_software_cost';
        const serverId = await homes.addHome({ name: 'Software costs', serverUrl, serverIdentityId, accountId: 'alice', active: true });
        await network.addHome(serverUrl, 'alice', { serverIdentityId });
        const needs: BotTemplateContentV1['needs']['software'] = ['git', 'node', 'python'].map(key => ({ key, name: key,
            purpose: 'Use the selected tool', requirement: 'optional', skipConsequence: 'Tool unavailable',
            recipe: { pluginId: 'com.example.tools', recipeId: key, revision: '1' } }));
        const recipes = needs.map(need => PluginProjectedMachineRecipeEntryV1Schema.parse({
            id: `${need.recipe.pluginId}/${need.key}`, pluginId: need.recipe.pluginId, pluginVersion: '1.0.0',
            definition: { id: need.key, revision: '1', title: need.name, software: true,
                inputSchema: { type: 'object', properties: { package: { type: 'string' } }, additionalProperties: false },
                inputHints: { fields: [{ path: 'package', title: { key: 'software.package', fallback: 'Package' }, widget: 'text' }] },
                steps: [{ id: need.key, kind: 'package', manager: 'apt', packages: [{ name: need.key }] }],
            },
        }));
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {},
                familiesById: { machineRecipes: { family: 'machineRecipes', entriesById: Object.fromEntries(recipes.map(recipe => [recipe.id, recipe])) } }, diagnostics: [] } });
        network.setRpcAckResponder(async () => ({ ok: true, result: response }));
        const plans: ReturnType<typeof MachineSetupPlanInputV1Schema.parse>[] = [];
        const http: string[] = [];
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            http.push(path);
            if (path === '/v1/actions/machines.setup.plan') {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                plans.push(MachineSetupPlanInputV1Schema.parse(envelope.input));
                // A failed native probe settles as unknown; it must not start a retry loop.
                return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
            }
            if (path.startsWith('/v1/machines/')) return null;
            return homes.request(input, init);
        });
        const selected = createMachineFixture({ id: 'selected-template-machine', activeAt: Date.now(),
            access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'alice', displayName: 'Alice' },
                role: 'manage', resourceMode: 'plain', accessState: 'ready' }) });
        storage.getState().applyMachines([selected, ...Array.from({ length: 120 }, (_, index) =>
            createMachineFixture({ id: `unrelated-machine-${index}` }))], false, { sourceServerId: serverId });
        const sessions = Array.from({ length: 1_000 }, (_, index) => createSessionFixture({ id: `unrelated-session-${index}`, serverId }));
        storage.getState().applySessions(sessions);
        const disposeLoader = await installRealActionExecutorModuleLoader();
        let commits = 0;
        let executionState = '';
        let installSummary: string | null = null;
        const onInstallSummaryChange = (summary: string) => { installSummary = summary; };
        function Form() {
            const execution = useMountedActionExecution(serverId);
            executionState = `${execution.ready}:${execution.resolution.kind}`;
            const [value, setValue] = React.useState<BotTemplateSetupSelectionsV1['software']>(needs.map(need => ({ key: need.key,
                selection: { action: 'install', inputs: { package: need.key } } })));
            return <React.Profiler id="software" onRender={() => { commits++; }}>
                <BotTemplateSoftwareSetup needs={needs} value={value} onChange={setValue} machineId={selected.id}
                    machineOnline serverId={serverId} execution={execution} onInstallSummaryChange={onInstallSummaryChange} />
            </React.Profiler>;
        }
        vi.useFakeTimers();
        const screen = await renderScreen(<Form />);
        try {
            await waitForHomeGovernance(() => expect(plans, JSON.stringify({ executionState, http,
                daemon: network.requests.map(request => ({ method: request.method, targetId: request.targetId })) })).toHaveLength(1));
            await flushHookEffects();
            expect(installSummary).toBe('git, node, python');
            expect(network.requests).toHaveLength(1);
            expect(network.requests[0]?.targetId).toBe(selected.id);
            expect(plans[0]?.machineId).toBe(selected.id);
            expect(plans[0]?.sources).toHaveLength(1);
            const source = plans[0]?.sources?.[0];
            expect(source?.kind).toBe('direct');
            if (source?.kind !== 'direct') throw new Error('Expected direct software setup source');
            expect(source.setup.items).toHaveLength(needs.length);
            const reads = { http: http.length, daemon: network.requests.length };
            const settledCommits = commits;
            await act(async () => {
                storage.getState().applySessions([{ ...sessions[0]!, updatedAt: 9, activeAt: 9 }]);
                storage.getState().applyMachines([createMachineFixture({ id: 'unrelated-machine-0', activeAt: 9 }),
                    ...Array.from({ length: 120 }, (_, index) => createMachineFixture({ id: `later-machine-${index}` }))],
                false, { sourceServerId: serverId });
                storage.getState().applyMachines([{ ...selected }], false, { sourceServerId: serverId });
            });
            const unrelatedCommits = commits - settledCommits;
            expect(unrelatedCommits).toBe(0);
            await act(async () => {
                const input = screen.tree.findAll(node => node.props.testID === 'bot-template-software-git-input-package'
                    && typeof node.props.onChangeText === 'function')[0];
                expect(input).toBeDefined();
                input!.props.onChangeText('custom-git');
            });
            await screen.pressByTestIdAsync('bot-template-software-node:skip');
            expect(installSummary).toBe('git, python');
            expect(screen.tree.findAll(node => node.props.testID === 'bot-template-software-git-input-package'
                && node.props.value === 'custom-git').length).toBeGreaterThan(0);
            expect(plans).toHaveLength(1);
            expect({ http: http.length, daemon: network.requests.length }).toEqual(reads);
            const beforeRelevant = commits;
            await act(async () => { storage.getState().applyMachines([{ ...selected, daemonStateVersion: 2, daemonState: {
                setup: MachineSetupObservationV1Schema.parse({ version: 1, desiredRevision: 0, status: 'satisfied',
                    recipes: [{ ref: needs[0]!.recipe, status: 'satisfied', steps: [{ stepId: 'git', status: 'satisfied',
                        packages: [{ manager: 'apt', name: 'git', present: true, version: '2.48' }] }] }],
                }),
            } }], false, { sourceServerId: serverId }); });
            expect(screen.getTextContent()).toContain('2.48');
            expect(installSummary).toBe('python');
            const relevantCommits = commits - beforeRelevant;
            expect(relevantCommits).toBe(1);
            expect({ http: http.length, daemon: network.requests.length }).toEqual(reads);
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect({ http: http.length, daemon: network.requests.length }).toEqual(reads);
            await screen.unmount();
            await act(async () => {
                storage.getState().applyMachines([{ ...selected, activeAt: 20 }], false, { sourceServerId: serverId });
                await vi.advanceTimersByTimeAsync(60_000);
            });
            expect({ http: http.length, daemon: network.requests.length }).toEqual(reads);
            console.info('BT3.F2 observed cost', { sessions: sessions.length, initialMachines: 121, addedMachines: 120,
                declaredTools: needs.length, selectedPlanHttp: plans.length, initialHttp: reads.http, initialDaemon: reads.daemon,
                unrelatedCommits, relevantCommits,
                editAndIdleAdditionalHttp: http.length - reads.http, editAndIdleAdditionalDaemon: network.requests.length - reads.daemon });
        } finally {
            vi.useRealTimers();
            await screen.unmount();
            disposeLoader();
        }
    });
});
