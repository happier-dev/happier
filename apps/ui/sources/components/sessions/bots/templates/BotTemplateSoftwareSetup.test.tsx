import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { MachineSetupObservationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { MachineSetupPlanInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
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
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
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
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await standardCleanup();
    storage.setState(previousState, true);
});
afterAll(async () => { await network.dispose(); });

const need: BotTemplateContentV1['needs']['software'][number] = { key: 'git', name: 'Git', purpose: 'Read repository history',
    requirement: 'optional', skipConsequence: 'Repository history is unavailable', recipe: { pluginId: 'com.example.tools', recipeId: 'git', revision: '1' } };

describe('template software setup', () => {
    it('reviews setup against the stable Home identity when the device profile has another id', async () => {
        const serverUrl = 'https://software-stable-home.test';
        const homeId = 'srv_template_software';
        const serverId = await homes.addHome({ name: 'Software', serverUrl, serverIdentityId: homeId, accountId: 'alice', active: true });
        expect(serverId).not.toBe(homeId);
        await network.addHome(serverUrl, 'alice', { serverIdentityId: homeId });
        const recipe = PluginProjectedMachineRecipeEntryV1Schema.parse({ id: 'com.example.tools/git', pluginId: 'com.example.tools', pluginVersion: '1.0.0',
            definition: { id: 'git', revision: '1', title: { key: 'software.git.title', fallback: 'Git command line' }, software: true,
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                steps: [{ id: 'git', kind: 'package', manager: 'apt', packages: [{ name: 'git' }] }],
            } });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {},
                familiesById: { machineRecipes: { family: 'machineRecipes', entriesById: { [recipe.id]: recipe } } }, diagnostics: [] } });
        network.setRpcAckResponder(async () => ({ ok: true, result: response }));
        let plannedHome: string | null = null;
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/actions/machines.setup.plan') {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                plannedHome = MachineSetupPlanInputV1Schema.parse(envelope.input).homeId;
                return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
            }
            if (path.startsWith('/v1/machines/')) return null;
            return homes.request(input, init);
        });
        const disposeLoader = await installRealActionExecutorModuleLoader();
        function Form() {
            const execution = useMountedActionExecution(serverId);
            return <BotTemplateSoftwareSetup needs={[need]} value={[]} onChange={() => {}} machineId="recipe-machine" machineOnline
                serverId={serverId} execution={execution} />;
        }
        const screen = await renderScreen(<Form />);
        try {
            await waitForHomeGovernance(() => expect(network.requests.length).toBeGreaterThan(0));
            await waitForHomeGovernance(() => expect(plannedHome).not.toBeNull());
            expect(plannedHome).toBe(homeId);
            expect(screen.getTextContent()).toContain(need.name);
            expect(screen.getTextContent()).not.toContain('Git command line');
            expect(screen.getTextContent()).not.toContain('botTemplateRecipient.softwareUnknown');
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('botTemplateRecipient.softwareCheckUnavailable'));
            expect(screen.getTextContent()).not.toContain(need.recipe.pluginId);
        } finally {
            await screen.unmount();
            disposeLoader();
        }
    });

    it('seeds a late recipe declaration once, preserving entered values and later removals', async () => {
        const serverUrl = 'https://software-recipe-arrival.test';
        const serverId = await homes.addHome({ name: 'Software', serverUrl, serverIdentityId: 'srv_software_arrival', accountId: 'alice', active: true });
        await network.addHome(serverUrl, 'alice', { serverIdentityId: 'srv_software_arrival' });
        const recipe = PluginProjectedMachineRecipeEntryV1Schema.parse({ id: 'com.example.tools/git', pluginId: 'com.example.tools', pluginVersion: '1.0.0',
            definition: { id: 'git', revision: '1', title: 'Git', software: true,
                inputSchema: { type: 'object', properties: { manager: { type: 'string' }, package: { type: 'string' } },
                    required: ['manager', 'package'], additionalProperties: false },
                inputHints: { fields: [
                    { path: 'manager', title: { key: 'software.manager', fallback: 'Manager' }, widget: 'text', defaultValue: 'apt' },
                    { path: 'package', title: { key: 'software.package', fallback: 'Package' }, widget: 'text', defaultValue: 'git' },
                ] }, steps: [{ id: 'git', kind: 'package', manager: 'apt', packages: [{ name: 'git' }] }],
            } });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {},
                familiesById: { machineRecipes: { family: 'machineRecipes', entriesById: { [recipe.id]: recipe } } }, diagnostics: [] } });
        const reply = createDeferred<typeof response>();
        network.setRpcAckResponder(async () => ({ ok: true, result: await reply.promise }));
        const disposeLoader = await installRealActionExecutorModuleLoader();
        let selected: BotTemplateSetupSelectionsV1['software'] = [];
        let replace: React.Dispatch<React.SetStateAction<BotTemplateSetupSelectionsV1['software']>> = () => {};
        let valid = true;
        function Form() {
            const execution = useMountedActionExecution(serverId);
            const [value, setValue] = React.useState(selected);
            selected = value;
            replace = setValue;
            return <BotTemplateSoftwareSetup needs={[need]} value={value} onChange={setValue} machineId="recipe-machine" machineOnline
                serverId={serverId} execution={execution} onValidityChange={value => { valid = value; }} />;
        }
        const screen = await renderScreen(<Form />);
        try {
            await waitForHomeGovernance(() => expect(network.requests.length).toBeGreaterThan(0));
            await act(async () => { screen.pressByTestId('bot-template-software-git:install'); });
            await act(async () => { replace([{ key: need.key, selection: { action: 'install', inputs: { package: 'custom-git' } } }]); });
            await act(async () => { reply.resolve(response); });
            await waitForHomeGovernance(() => expect(selected).toEqual([{ key: need.key,
                selection: { action: 'install', inputs: { manager: 'apt', package: 'custom-git' } } }]));
            expect(valid).toBe(true);
            await act(async () => { replace([{ key: need.key, selection: { action: 'install', inputs: { package: 'custom-git' } } }]); });
            await flushHookEffects();
            expect(selected).toEqual([{ key: need.key, selection: { action: 'install', inputs: { package: 'custom-git' } } }]);
            expect(valid).toBe(false);
        } finally {
            await screen.unmount();
            disposeLoader();
        }
    });

    it('does not allow a required tool to be skipped while its Machine is unavailable', async () => {
        const changed = vi.fn();
        function Form() {
            const execution = useMountedActionExecution(null);
            return <BotTemplateSoftwareSetup needs={[{ ...need, requirement: 'required' }]} value={[]} onChange={changed}
                machineId={null} machineOnline={null} serverId="home" execution={execution} />;
        }
        const screen = await renderScreen(<Form />);
        const skip = screen.tree.findAll(node => node.props.testID === 'bot-template-software-git:skip' && node.props.disabled !== undefined)[0];
        expect(skip?.props.disabled).toBe(true);
        expect(changed).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('keeps unknown tools choosable without claiming they are missing and shows the consequence of skipping', async () => {
        let selected: BotTemplateSetupSelectionsV1['software'] = [];
        function Form() {
            const execution = useMountedActionExecution(null);
            const [value, setValue] = React.useState(selected);
            selected = value;
            return <BotTemplateSoftwareSetup needs={[need]} value={value} onChange={setValue} machineId={null} machineOnline={null} serverId="home" execution={execution} />;
        }
        const screen = await renderScreen(<Form />);
        expect(screen.getTextContent()).toContain('botTemplateRecipient.softwareUnknown');
        await act(async () => { screen.pressByTestId('bot-template-software-git:skip'); });
        expect(selected).toEqual([{ key: 'git', selection: { action: 'skip' } }]);
        expect(screen.getTextContent()).toContain(need.skipConsequence);
        await screen.unmount();
    });

    it('preserves reviewed recipe inputs when the selected Install segment is activated again', async () => {
        const value: BotTemplateSetupSelectionsV1['software'] = [{ key: need.key, selection: { action: 'install', inputs: { package: 'git' } } }];
        let selected = value;
        function Form() {
            const execution = useMountedActionExecution(null);
            const [current, setCurrent] = React.useState(value);
            selected = current;
            return <BotTemplateSoftwareSetup needs={[need]} value={current} onChange={setCurrent} machineId={null}
                machineOnline={null} serverId="home" execution={execution} />;
        }
        const screen = await renderScreen(<Form />);
        await act(async () => { screen.pressByTestId('bot-template-software-git:install'); });
        expect(selected).toEqual(value);
        await screen.unmount();
    });

    it('shows the exact pushed installed version and removes the install/skip chooser', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const machine = createMachineFixture({ id: 'template-software-found', daemonState: { setup: MachineSetupObservationV1Schema.parse({
            version: 1, desiredRevision: 0, status: 'satisfied', recipes: [{ ref: need.recipe, status: 'satisfied',
                steps: [{ stepId: 'git', status: 'satisfied', packages: [{ manager: 'apt', name: 'git', present: true, version: '2.47.1' }] }] }],
        }) } });
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId });
        function Form() {
            const execution = useMountedActionExecution(null);
            const [value, setValue] = React.useState<BotTemplateSetupSelectionsV1['software']>([]);
            return <BotTemplateSoftwareSetup needs={[need]} value={value} onChange={setValue} machineId={machine.id} machineOnline serverId={serverId} execution={execution} />;
        }
        const screen = await renderScreen(<Form />);
        expect(screen.getTextContent()).toContain('2.47.1');
        expect(screen.getTextContent()).not.toContain(need.recipe.pluginId);
        expect(screen.getTextContent()).not.toContain(need.purpose);
        expect(screen.tree.findAll(node => node.props.testID === 'bot-template-software-git:install')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props.testID === 'bot-template-software-git:skip')).toHaveLength(0);
        await screen.unmount();
    });

    it('does not present retained satisfied observations as current facts on an asleep Machine', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const machine = createMachineFixture({ id: 'template-software-asleep', daemonState: { setup: MachineSetupObservationV1Schema.parse({
            version: 1, desiredRevision: 0, status: 'satisfied', recipes: [{ ref: need.recipe, status: 'satisfied',
                steps: [{ stepId: 'git', status: 'satisfied', packages: [{ manager: 'apt', name: 'git', present: true, version: '2.47.1' }] }] }],
        }) } });
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId });
        function Form() {
            const execution = useMountedActionExecution(null);
            return <BotTemplateSoftwareSetup needs={[need]} value={[]} onChange={() => {}} machineId={machine.id}
                machineOnline={false} serverId={serverId} execution={execution} />;
        }
        const screen = await renderScreen(<Form />);
        expect(screen.getTextContent()).toContain('botTemplateRecipient.softwareUnknown');
        expect(screen.getTextContent()).not.toContain('2.47.1');
        expect(screen.tree.findAll(node => node.props.testID === 'bot-template-software-git:skip').length).toBeGreaterThan(0);
        await screen.unmount();
    });
});
