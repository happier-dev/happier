import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, onTestFinished, vi } from 'vitest';
import { AcpCatalogRowMutationV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';

import { standardCleanup } from '@/dev/testkit';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { installPromptRegistriesCommonModuleMocks, promptRegistriesRouterPushSpy } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original(), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { AgentAddModal } = await import('./agentAddModalConfig');
const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
const { StoreAgentListing } = await import('@/components/store/StoreAgentListing');
const actionFrontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');

const ACP = 'builtin:acp-registry';
const ACP_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

function observeReads() {
    const calls: { action: string; input: unknown }[] = [];
    const create = actionFrontDoor.createFrontDoorActionExecute;
    // Observe physical Action dispatch without replacing registry admission or setup logic.
    const spy = vi.spyOn(actionFrontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
        const execute = create(...args);
        return Object.assign((...invocation: Parameters<typeof execute>) => {
            if (invocation[0].startsWith('registries.items.') || invocation[0].startsWith('agents.acp.')
                || invocation[0] === 'plugins.install') calls.push({ action: invocation[0], input: invocation[1] });
            return execute(...invocation);
        }, { prepare: execute.prepare, confirmed: (...invocation: Parameters<typeof execute>) => {
            if (invocation[0].startsWith('registries.items.') || invocation[0].startsWith('agents.acp.')
                || invocation[0] === 'plugins.install') calls.push({ action: invocation[0], input: invocation[1] });
            return execute.confirmed(...invocation);
        } });
    });
    onTestFinished(() => spy.mockRestore());
    return calls;
}

async function setup(suffix: string) {
    const sourceUrl = `https://agent-add-${suffix}.test/plugins.json`;
    const plugins = createRegistryPluginCatalogFixture({ sourceUrl, entries: [{ pluginId: 'sample.agent', title: 'Plugin Agent' }] });
    const curated = createRegistryPluginCatalogFixture({ sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, kind: 'curated', entries: [] });
    const agents = Array.from({ length: 100 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}`, version: '1.2.3',
        description: 'An executable coding agent.', distribution: { npx: { package: `agent-${index}@1.2.3`, args: ['--acp'] } } }));
    let acpContent: unknown = { t: 'plain', v: { v: 1, definitions: [] } };
    let acpRevision = 1;
    let acpWrites = 0;
    let pendingAck: Promise<void> | null = null;
    let pendingPluginRead: Promise<void> | null = null;
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://agent-add-${suffix}.test`, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: plugins.source.id, title: 'Plugin Agents',
            format: 'happier-catalog', kinds: ['agent', 'plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
    }, 'updated', {
        handleRequest: async (path, init) => {
            if (path === '/plugins.json') { await pendingPluginRead; return Response.json(plugins); }
            if (path !== '/v1/account/entity-rows/acp') return null;
            if (init?.method !== 'POST') return Response.json({ status: 'present', revision: acpRevision, content: acpContent });
            const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
            expect(mutation.expectedRevision).toBe(acpRevision);
            acpContent = mutation.content;
            acpWrites += 1;
            const revision = ++acpRevision;
            await pendingAck;
            return Response.json({ status: 'updated', revision, cursor: revision });
        },
        handleExternalRequest: async url => url === ACP_URL ? Response.json({ version: '1.0.0', agents })
            : url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL ? Response.json(curated)
                : url.startsWith('https://registry.npmjs.org/-/v1/search') ? Response.json({ total: 0, objects: [] }) : null,
    });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    return { fixture, plugins, acpWrites: () => acpWrites, holdAcpAck: (pending: Promise<void> | null) => { pendingAck = pending; },
        holdPluginRead: (pending: Promise<void> | null) => { pendingPluginRead = pending; } };
}

async function mount(params: Parameters<typeof AgentAddModal>[0]['params']) {
    const onClose = vi.fn();
    const onAddedStay = vi.fn();
    const screen = await renderSettingsView(<AgentAddModal onClose={onClose} onAddedStay={onAddedStay} params={params} />);
    const config = () => screen.findAll(node => node.type === CapabilityAddModalBody)[0]!.props.config;
    const measure = async (width: number) => {
        const stage = screen.findAll(node => node.props.testID === 'agents.add:collection:stage'
            && typeof node.props.onLayout === 'function')[0]!;
        await act(async () => stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } } }));
    };
    return { screen, config, measure, onClose, onAddedStay };
}

const callbacks = () => ({ onOpenAgent: vi.fn(), onOpenDefinition: vi.fn() });

it('keeps the exact Agent seed and Plugin review continuation in a Store listing controller', async () => {
    const { plugins } = await setup('store-controller-plugin');
    const calls = observeReads();
    const onClose = vi.fn();
    promptRegistriesRouterPushSpy.mockClear();
    const screen = await renderSettingsView(<StoreAgentListing selection={{ sourceId: plugins.source.id, itemId: 'sample.agent', version: '1.2.3' }}
        onClose={onClose}>{state => <CapabilityAddModalBody config={state.config} onClose={onClose} />}</StoreAgentListing>);
    const config = () => screen.findAll(node => node.type === CapabilityAddModalBody)[0]!.props.config;
    await waitForHomeGovernance(() => expect(config().catalog.items).toHaveLength(1));
    const stage = screen.findAll(node => node.props.testID === 'agents.add:collection:stage' && typeof node.props.onLayout === 'function')[0]!;
    await act(async () => stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1080, height: 600 } } }));
    await waitForHomeGovernance(() => expect(config().detailFooter(config().catalog.items[0]).primary.disabledReason).toBeUndefined());
    await act(async () => { await config().detailFooter(config().catalog.items[0]).primary.onPress(); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.objectContaining({ params: {
        sourceId: plugins.source.id, itemId: 'sample.agent', pluginId: 'sample.agent', version: '1.2.3',
    } }));
    expect(calls.filter(call => call.action === 'registries.items.list' || call.action.startsWith('agents.acp.') || call.action === 'plugins.install')).toHaveLength(0);
});

it('reads no Agent bodies on a cold phone list and only the first selected wide item among 100 results', async () => {
    await setup('demand');
    const calls = observeReads();
    const modal = await mount({ ...callbacks(), sourceId: ACP });
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(100));
    await modal.measure(390);
    expect(calls.filter(call => call.action === 'registries.items.read')).toHaveLength(0);
    await modal.measure(1080);
    await waitForHomeGovernance(() => expect(calls.filter(call => call.action === 'registries.items.read')).toHaveLength(1));
    expect(calls.find(call => call.action === 'registries.items.read')?.input).toEqual({ kind: 'agent', sourceId: ACP, itemId: 'agent-0', version: '1.2.3' });
    expect(modal.onAddedStay.mock.calls.filter(([id]) => typeof id === 'string')).toHaveLength(0);
});

it.each(['available', 'missing pin', 'withdrawn source'] as const)('uses an exact Agent seed without listing or silent replacement: %s', async state => {
    await setup(`seed-${state.replaceAll(' ', '-')}`);
    const calls = observeReads();
    const sourceId = state === 'withdrawn source' ? 'removed-source' : ACP;
    const modal = await mount({ ...callbacks(), initialSelection: { sourceId, itemId: 'agent-42', version: state === 'missing pin' ? '9.9.9' : '1.2.3' } });
    await waitForHomeGovernance(() => expect(modal.config().catalog.loading).toBe(false));
    expect(modal.config().initialItemKey).toBe(`${sourceId}|agent-42`);
    expect(modal.config().catalog.items.map((row: { summary: { itemId: string } }) => row.summary.itemId)).toEqual(state === 'available' ? ['agent-42'] : []);
    expect(calls.filter(call => call.action === 'registries.items.list')).toHaveLength(0);
    if (state === 'available') {
        await modal.measure(1080);
        await waitForHomeGovernance(() => expect(modal.config().detailFooter(modal.config().catalog.items[0]).primary.disabledReason).toBeUndefined());
    }
    await act(async () => { modal.config().catalog.onQueryChange('Agent'); });
    try {
        await waitForHomeGovernance(() => expect(modal.config().catalog.items.some((row: { summary: { itemId: string } }) => row.summary.itemId === 'agent-42')).toBe(true));
    } catch (error) {
        console.error('Agent seed recovery:', JSON.stringify({ state, calls, failures: modal.config().catalog.sourceFailures,
            source: modal.screen.findAll(node => node.props.filter?.testID === 'agents.add.registries.select')[0]?.props.filter.renderPopoverContent({ close() {}, maxHeight: 400 }).props.selectedOptionId }));
        throw error;
    }
    expect(calls.some(call => call.action === 'registries.items.list')).toBe(true);
});

it('routes an Agent-browse Plugin payload to its exact existing review and never invokes ACP setup', async () => {
    const { plugins } = await setup('plugin');
    promptRegistriesRouterPushSpy.mockClear();
    const calls = observeReads();
    const modal = await mount({ ...callbacks(), ...{ initialSelection: { sourceId: plugins.source.id, itemId: 'sample.agent', version: '1.2.3' } } });
    await waitForHomeGovernance(() => expect(modal.config().catalog.loading).toBe(false));
    await modal.measure(1080);
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(1));
    await waitForHomeGovernance(() => expect(modal.config().detailFooter(modal.config().catalog.items[0]).primary.disabledReason).toBeUndefined());
    await act(async () => { await modal.config().detailFooter(modal.config().catalog.items[0]).primary.onPress(); });
    expect(modal.onClose).toHaveBeenCalledOnce();
    expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
        sourceId: plugins.source.id, itemId: 'sample.agent', pluginId: 'sample.agent', version: '1.2.3',
    }) }));
    expect(modal.onAddedStay.mock.calls.filter(([id]) => typeof id === 'string')).toHaveLength(0);
    expect(calls.filter(call => call.action === 'registries.items.list')).toHaveLength(0);
    expect(calls.filter(call => call.action.startsWith('agents.acp.') || call.action === 'plugins.install')).toHaveLength(0);
});

it.each(['source', 'Account'] as const)('retires an already prepared Plugin handoff when its %s is withdrawn', async authority => {
    const { plugins, fixture } = await setup(`retire-${authority.toLowerCase()}`);
    promptRegistriesRouterPushSpy.mockClear();
    const modal = await mount({ ...callbacks(), ...{ initialSelection: { sourceId: plugins.source.id, itemId: 'sample.agent', version: '1.2.3' } } });
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(1));
    await modal.measure(1080);
    await waitForHomeGovernance(() => expect(modal.config().detailFooter(modal.config().catalog.items[0]).primary.disabledReason).toBeUndefined());
    const prepared = modal.config().detailFooter(modal.config().catalog.items[0]).primary;
    await act(async () => {
        if (authority === 'Account') {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            await TokenStorage.removeCredentialsForServerUrl(fixture.home.serverUrl, { serverId: fixture.home.id });
        } else {
            const result = await actionFrontDoor.createFrontDoorActionExecute()('registries.sources.update', {
                sourceId: plugins.source.id, enabled: false,
            }, { surface: 'ui', authority: 'present_user', serverId: fixture.home.id });
            expect(result.ok).toBe(true);
        }
    });
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(0));
    await act(async () => { await prepared.onPress(); });
    expect(modal.onClose).not.toHaveBeenCalled();
    expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
});

it('keeps a late Agent A acknowledgement on A while B is selected and registers only the presented added detail', async () => {
    const boundary = await setup('late-ack');
    let release!: () => void;
    boundary.holdAcpAck(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => release());
    const modal = await mount({ ...callbacks(), sourceId: ACP });
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(100));
    await modal.measure(1080);
    await waitForHomeGovernance(() => expect(modal.config().detailFooter(modal.config().catalog.items[0]).primary.disabledReason).toBeUndefined());
    await act(async () => { modal.screen.pressByTestId('agents.add:primary'); });
    try {
        await waitForHomeGovernance(() => expect(boundary.acpWrites()).toBe(1));
    } catch (error) {
        console.error('Agent Add boundary:', JSON.stringify({ requests: boundary.fixture.requests, text: modal.screen.getTextContent() }));
        throw error;
    }
    const select = async (key: string) => {
        const collection = modal.screen.findAll(node => node.props.testID === 'agents.add:collection'
            && typeof node.props.model?.actions?.open === 'function')[0]!;
        await act(async () => collection.props.model.actions.open(key));
    };
    await select(`${ACP}|agent-1`);
    await act(async () => { release(); });
    await waitForHomeGovernance(() => expect(modal.config().detailFooter(modal.config().catalog.items[0]).afterAdd).toBeDefined());
    expect(modal.onAddedStay.mock.calls.at(-1)?.[0] ?? null).toBeNull();
    expect(modal.onClose).not.toHaveBeenCalled();
    await select(`${ACP}|agent-0`);
    await waitForHomeGovernance(() => expect(modal.onAddedStay.mock.calls.at(-1)?.[0]).toEqual(expect.any(String)));
    expect(boundary.acpWrites()).toBe(1);
});

it('withdraws catalog demand while source administration is open, then reads current results on return', async () => {
    const { fixture, plugins } = await setup('source-demand');
    const calls = observeReads();
    const modal = await mount({ ...callbacks(), sourceId: ACP });
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(100));
    // Source management legitimately reads its selected user source's details. Count the hidden Add's ACP acquisition only.
    const addLists = () => calls.filter(({ action, input }) => action === 'registries.items.list' && input !== null
        && typeof input === 'object' && 'sourceIds' in input && Array.isArray(input.sourceIds)
        && input.sourceIds.length === 1 && input.sourceIds[0] === ACP);
    const initialLists = addLists().length;
    const selector = modal.screen.findAll(node => node.props.filter?.testID === 'agents.add.registries.select')[0]!;
    await act(async () => selector.props.filter.renderPopoverContent({ close() {}, maxHeight: 400 }).props.onSelect('action:manage'));
    await waitForHomeGovernance(() => expect(modal.screen.findByTestId('agents.add.registries.view')).not.toBeNull());
    await act(async () => {
        const result = await actionFrontDoor.createFrontDoorActionExecute()('registries.sources.update', {
            sourceId: plugins.source.id, title: 'Renamed Plugin Agents',
        }, { surface: 'ui', authority: 'present_user', serverId: fixture.home.id });
        expect(result.ok).toBe(true);
    });
    expect(addLists()).toHaveLength(initialLists);
    await act(async () => modal.screen.pressByTestId('agents.add:back'));
    try {
        await waitForHomeGovernance(() => expect(addLists().length).toBeGreaterThan(initialLists));
    } catch (error) {
        console.error('Agent source demand:', JSON.stringify({ calls, text: modal.screen.getTextContent() }));
        throw error;
    }
});

it('keeps a former source preview inert while the newly selected source is still loading', async () => {
    const boundary = await setup('source-transition');
    const calls = observeReads();
    const modal = await mount({ ...callbacks(), sourceId: ACP });
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(100));
    await modal.measure(1080);
    await waitForHomeGovernance(() => expect(modal.config().detailFooter(modal.config().catalog.items[0]).primary.disabledReason).toBeUndefined());
    const previous = modal.config().detailFooter(modal.config().catalog.items[0]).primary;
    let release!: () => void;
    boundary.holdPluginRead(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => release());
    const selector = modal.screen.findAll(node => node.props.filter?.testID === 'agents.add.registries.select')[0]!;
    await act(async () => selector.props.filter.renderPopoverContent({ close() {}, maxHeight: 400 }).props.onSelect(boundary.plugins.source.id));
    // The existing read owner retains the former source's rows during acquisition; they confer no new selection authority.
    expect(modal.config().catalog.items).toHaveLength(100);
    let invocation: Promise<unknown> | undefined;
    try {
        await act(async () => { invocation = previous.onPress(); });
        expect(calls.filter(call => call.action === 'agents.acp.backends.installFromRegistry')).toHaveLength(0);
        expect(boundary.acpWrites()).toBe(0);
    } finally {
        await act(async () => { release(); await invocation; });
    }
    await waitForHomeGovernance(() => expect(modal.config().catalog.items.map((row: { summary: { itemId: string } }) => row.summary.itemId)).toEqual(['sample.agent']));
});

it('From a command shows the custom-agent form in the dialog, and Save opens the new agent', async () => {
    const env = await setup('command-mode');
    const params = { ...callbacks(), sourceId: ACP };
    const modal = await mount(params);
    promptRegistriesRouterPushSpy.mockClear();
    await act(async () => { await modal.screen.pressByTestIdAsync('agents.add:mode:command'); });
    const editor = 'settings.acpCatalog.backendEditor';
    const field = (testID: string) => modal.screen.findAll(node => node.props?.testID === testID && typeof node.props?.onChangeText === 'function')[0];
    // The segment switches the dialog's body in place: no close, no navigation.
    await waitForHomeGovernance(() => expect(field(`${editor}.title`)).toBeDefined());
    expect(modal.onClose).not.toHaveBeenCalled();
    expect(promptRegistriesRouterPushSpy).not.toHaveBeenCalled();
    await act(async () => { field(`${editor}.title`)!.props.onChangeText('Kiro'); });
    await act(async () => { field(`${editor}.command`)!.props.onChangeText('kiro-cli'); });
    await waitForHomeGovernance(() => expect(modal.screen.findHostByTestId(`${editor}.save`)?.props.disabled).toBe(false));
    await act(async () => { await modal.screen.pressByTestIdAsync(`${editor}.save`); });
    await waitForHomeGovernance(() => expect(params.onOpenDefinition).toHaveBeenCalledWith('kiro'));
    expect(env.acpWrites()).toBe(1);
    expect(modal.onClose).toHaveBeenCalled();
});


it('offers first use when every compatible machine is offline, including a requested Now draft', async () => {
    await setup('offline-install-choice');
    const modal = await mount({ ...callbacks(), sourceId: ACP });
    await waitForHomeGovernance(() => expect(modal.config().catalog.items).toHaveLength(100));
    const { AgentRegistryDetail } = await import('./AgentRegistryDetail');
    const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
    const onDraft = vi.fn();
    const row = modal.config().catalog.items[0];
    const detail = await renderSettingsView(<AgentRegistryDetail row={row} sourceTitle="ACP Registry" sourceRevision="offline"
        machines={[{ machineId: 'linux', name: 'Linux', platform: 'linux', arch: 'x64', offline: true }]}
        serverId={null} added={null} onRetryInstall={async () => {}} existingDefinitionId={null}
        targetSelection={{ candidates: [], pickerRows: [], state: { kind: 'unselected', candidates: [] },
            selectedTarget: null, selectedTargetServerMatchesActiveAccount: false, canExecute: false,
            selectTarget: () => undefined, clearTarget: () => undefined, resolveExecutionTarget: () => null }}
        onDraft={onDraft} initialChoice="now" testID="offline-agent" />);
    await waitForHomeGovernance(() => expect(onDraft.mock.lastCall?.[0].item).not.toBeNull());
    const choice = detail.findAll(node => node.type === SegmentedChoiceItem)[0];
    expect(choice?.props.value).toBe('firstUse');
    expect(choice?.props.options.find((option: { id: string }) => option.id === 'now').disabled).toBe(true);
    expect(onDraft.mock.lastCall?.[0].choice).toBe('firstUse');
});
