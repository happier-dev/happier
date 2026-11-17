import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { WIDGET_SIZE_POLICY_V1, WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, { maxHeight: 600, maxWidth: 800, placement: 'bottom' }));
vi.mock('@/components/ui/popover/Popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, { maxHeight: 600, maxWidth: 800, placement: 'bottom' }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { usePublishCurrentUiContext, useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { WidgetAreaLayoutBar } = await import('./WidgetAreaLayoutBar');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { useWidgetFrameRename } = await import('../frame/useWidgetFrameRename');
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
const { Text, TextInput } = await import('@/components/ui/text/Text');
const { Pressable } = await import('react-native');
const { WidgetAddPanel } = await import('../add/WidgetAddSurface');
const { useWidgetInputsEditor } = await import('../surface/useWidgetInputsEditor');
const { readWidgetDescriptor, describeAuthoredWidgetDefinitionV1 } = await import('../widgetCatalog');
const { t } = await import('@/text');
const { buildWidgetCandidateSetup } = await import('../surface/widgetSurfaceSetup');
const { WidgetSetupStep } = await import('../add/WidgetSetupStep');
const { WidgetSetupFieldRow, WidgetSetupOptionsNotice } = await import('../add/WidgetSetupFieldRow');
const { WidgetSizeControl } = await import('../frame/WidgetSizeControl');
const { useWidgetDefinitionFlows } = await import('../definitions/useWidgetDefinitionFlows');
const { useWidgetInstanceNetworkEditor } = await import('../surface/useWidgetInstanceNetworkEditor');
const { useInputFieldOptions } = await import('@/components/sessions/actions/useInputFieldOptions');
const { storage } = await import('@/sync/domains/state/storage');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { SessionVisualNetworkPanel } = await import('@/components/sessions/board/SessionVisualNetworkPanel');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { CorePluginUiPresentationScope } = await import('@/components/plugins/surfaces/CorePluginUiPresentationScope');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { createRepositoryComposerDocumentOwner } = await import('@/components/sessions/composer/repositoryComposerDocumentOwner');
const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { prepareSessionDraftPersistenceStorage, discardSessionDraftPersistenceWrites } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
let serverId = '';
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: ReturnType<typeof useOptionalCurrentUiContextReader>;
let artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'viewer', encryptionMode: 'plain' });
let definitionReads = 0;
let settingsVersion = 1;

function Publication() {
    reader = useOptionalCurrentUiContextReader();
    const commands = useCurrentUiContextComposedCommands();
    const enrichment = React.useMemo(() => ({ commands }), [commands]);
    usePublishCurrentUiContext(enrichment);
    return null;
}
function Page({ children }: React.PropsWithChildren) {
    const authority = captureActiveServerAccountScopeLifetime();
    const projection = React.useMemo(() => ({ pluginUiProjection: null, pluginBrowserProjection: null, phase: 'ready' as const,
        interactionEnabled: true, machineId: null, serverId: authority?.scope.serverId ?? null, platform: 'web' as const,
        accountLifetime: authority, reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' as const },
        reloadClientExecutables: () => {} }), [authority]);
    return <AppShellPluginUiProjectionValueProvider value={projection}>
        <CurrentUiContextCommandsProvider authority={authority}><CorePluginUiPresentationScope>
            <Publication />{children}</CorePluginUiPresentationScope></CurrentUiContextCommandsProvider>
    </AppShellPluginUiProjectionValueProvider>;
}
const labels = { list: 'Views', current: (name: string) => `View: ${name}`, create: 'Create view', createEllipsis: 'Create view…',
    actions: (name: string) => `${name} actions`, rename: 'Rename', moveBefore: (name: string) => `Before ${name}`,
    moveAfter: (name: string) => `After ${name}`, delete: 'Delete', deleteLabel: 'Delete' };
const command = (title: string) => reader?.readCurrentUiContext()?.commands.find(row => row.title === title);
async function invoke(title: string, input?: string) {
    const found = command(title);
    expect(found, title).toBeDefined();
    return createDefaultActionExecutor().execute('ui.current_context.command.invoke', { commandId: found!.id,
        ...(input === undefined ? {} : { input }) }, { surface: 'mcp' });
}
beforeEach(async () => {
    await homes.reset();
    artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'viewer', encryptionMode: 'plain' });
    definitionReads = 0;
    settingsVersion = 1;
    home = await serveActionHomes({ homes: [{ key: 'widget', serverUrl: 'https://widget-chrome.test', accountId: 'viewer', currentAccount: true,
        settings: { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'widgets.definition.get': { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { 'widgets.definition.create': ['ui'], 'widgets.definition.get': ['ui'],
                'action.options.resolve': ['ui', 'agent'] } }) } }],
        route: async request => {
            if (request.method === 'GET' && request.path.startsWith('/v1/artifacts/')) definitionReads++;
            return await artifacts.handle(`${request.url.pathname}${request.url.search}`, { method: request.method,
                headers: request.headers, signal: request.signal,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
        } });
    serverId = home.homes.widget!.id;
});
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); reader = null; await home?.dispose(); home = undefined; });

it('publishes layout-menu visibility and routes the visible trigger through the same current command', async () => {
    const screen = await renderMountedCurrentUiContext(<Page><WidgetAreaLayoutBar layouts={[{ id: 'mine', name: 'My view' }]}
        selectedId="mine" onSelect={() => {}} onCreate={null} actions={{ rename: () => {} }} labels={labels} testID="bar" /></Page>);
    await act(async () => { expect((await invoke('View: My view')).ok).toBe(true); });
    expect(screen.root.findAllByType(DropdownMenu)[0]!.props.open).toBe(true);
    await act(async () => { expect((await invoke('View: My view')).ok).toBe(true); });
    expect(screen.root.findAllByType(DropdownMenu)[0]!.props.open).toBe(false);
    await act(async () => { expect((await invoke('My view actions')).ok).toBe(true); });
    expect(screen.root.findAllByType(DropdownMenu)[1]!.props.open).toBe(true);
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    await act(async () => { await screen.findHostByTestId('bar.current')!.props.onPress(); });
    expect(screen.root.findAllByType(DropdownMenu)[0]!.props.open).toBe(false);
});

it('exposes rename draft and cancel, and withdraws the UI begin control with its command', async () => {
    function Rename() {
        const rename = useWidgetFrameRename({ title: 'Spend', onRename: () => {}, testID: 'widget' });
        return <><Pressable testID="rename" onPress={rename.begin} />{rename.field ?? <Text>Spend</Text>}</>;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Rename /></Page>);
    await act(async () => { expect((await invoke('Rename: Spend')).ok).toBe(true); });
    await act(async () => { expect((await invoke('Rename: Spend', 'Monthly spend')).ok).toBe(true); });
    expect(screen.root.findByType(TextInput).props.value).toBe('Monthly spend');
    await act(async () => { expect((await invoke('Cancel: Spend')).ok).toBe(true); });
    expect(screen.findByTestId('widget-title-input')).toBeNull();
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    await act(async () => { await screen.findHostByTestId('rename')!.props.onPress(); });
    expect(screen.findByTestId('widget-title-input')).toBeNull();
});

it('makes an opted-in widget overflow discoverable and denies its retired UI trigger', async () => {
    const screen = await renderMountedCurrentUiContext(<Page><ItemRowActions title="Spend" overflowOnly currentUiContext
        overflowTriggerTestID="overflow" actions={[{ id: 'local', title: 'Local', onPress: () => {} }]} /></Page>);
    await act(async () => { expect((await invoke('Spend')).ok).toBe(true); });
    expect(screen.findHostByTestId('overflow')!.props.accessibilityState.expanded).toBe(true);
    await act(async () => { expect((await invoke('Spend')).ok).toBe(true); });
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    await act(async () => { await screen.findHostByTestId('overflow')!.props.onPress(); });
    expect(screen.findHostByTestId('overflow')!.props.accessibilityState.expanded).toBe(false);
});

it('publishes gallery search and visible choices, retaining the selected pane through search', async () => {
    const screen = await renderMountedCurrentUiContext(<Page><WidgetAddPanel title="Add widget" searchPlaceholder="Search widgets"
        sections={[{ id: 'builtins', title: 'Built in', entries: [
            { id: 'spend', title: 'Spend', icon: 'chart-bar', onPick: () => {} },
            { id: 'requests', title: 'Requests', icon: 'chart-bar', onPick: () => {} },
        ] }]} addLabel="Add" composition="push" onRequestClose={() => {}} testID="gallery" /></Page>);
    await act(async () => { expect((await invoke('Spend')).ok).toBe(true); });
    expect(screen.findByTestId('gallery.detail')).not.toBeNull();
    await act(async () => { expect((await invoke('Search widgets', 'Requests')).ok).toBe(true); });
    expect(screen.findByTestId('gallery.detail')).not.toBeNull();
    await act(async () => { expect((await invoke('Back: Add widget')).ok).toBe(true); });
    expect(screen.findByTestId('gallery.entry.requests')).not.toBeNull();
    expect(screen.findByTestId('gallery.entry.spend')).toBeNull();
});

it('opens and closes input repair through the published editor command', async () => {
    const definition = { kind: 'builtin' as const, id: 'usage_period_summary' };
    const candidate = readWidgetDescriptor(null, definition)!;
    function Editor() {
        const edit = useWidgetInputsEditor({ instance: { v: 1, id: 'spend', definition, bindings: {} }, candidate,
            scope: { serverId, accountId: 'viewer', owner: { kind: 'corePage', pageId: 'usage', area: 'main' } }, context: {},
            audience: 'personal', setInputs: async () => ({ ok: true }), testID: 'editor' });
        return <><Pressable testID="edit" onPress={edit.editInputs?.onPress} /><Text>{edit.popover ? 'open' : 'closed'}</Text></>;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Editor /></Page>);
    const title = `${t('widgetAdd.editInputs')}: ${candidate.title}`;
    await act(async () => { expect((await invoke(title)).ok).toBe(true); });
    expect(screen.getTextContent()).toContain('open');
    await act(async () => { expect((await invoke(`${t('common.close')}: ${candidate.title}`)).ok).toBe(true); });
    expect(screen.getTextContent()).toContain('closed');
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    await act(async () => { await screen.findHostByTestId('edit')!.props.onPress(); });
    expect(screen.getTextContent()).toContain('closed');
});

it('exposes the setup draft and admitted size choices without submitting a write', async () => {
    const candidate = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_period_summary' })!;
    const setup = buildWidgetCandidateSetup({ candidate, context: {}, audience: 'personal',
        scope: { serverId, accountId: 'viewer', owner: { kind: 'home' } },
        mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => { throw new Error('Draft changes must not submit'); } });
    const metric = setup.fields.find(entry => entry.field.path === 'metric')!;
    const screen = await renderMountedCurrentUiContext(<Page><WidgetSetupStep setup={setup} phone={false}
        onDone={() => {}} testID="setup" /></Page>);
    await act(async () => { expect((await invoke(`${setup.title}: ${metric.field.prompt ?? metric.field.title}`, 'tokens')).ok).toBe(true); });
    expect(screen.root.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === 'metric')!.props.plainValue).toBe('tokens');
    const size = setup.sizeChoices!.sizes.at(-1)!;
    await act(async () => { expect((await invoke(`${setup.title}: ${t('widgetAdd.size')}`, size)).ok).toBe(true); });
    expect(screen.root.findByType(WidgetSizeControl).props.size).toBe(size);
});

it('publishes About and Add to flow openers from the existing frame owner', async () => {
    function Definition() {
        const flows = useWidgetDefinitionFlows({ instance: { v: 1, id: 'spend', definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: {} },
            scope: { serverId, accountId: 'viewer', owner: { kind: 'corePage', pageId: 'usage', area: 'main' } },
            anchorRef: React.useRef(null), testID: 'definition' });
        return <>{flows.panel}</>;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Definition /></Page>);
    const candidate = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_period_summary' })!;
    await act(async () => { expect((await invoke(`${t('widgetDefinition.aboutTitle')}: ${candidate.title}`)).ok).toBe(true); });
    expect(screen.findByTestId('definition.about')).not.toBeNull();
    expect(command(`${t('widgetFrame.groupAddTo')}: ${candidate.title}`)).toBeDefined();
});

it('keeps the About opener caller authority through its immediate definition read', async () => {
    const artifactId = '22222222-2222-4222-8222-222222222231';
    const account = { serverId, accountId: 'viewer' };
    const created = await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId, definition: {
        sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
        name: 'Private checks', body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } },
        inputs: { fields: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    } }, { serverId, surface: 'ui', authority: 'present_user' });
    expect(created.ok).toBe(true);
    function Definition() {
        const flows = useWidgetDefinitionFlows({ title: 'Private checks',
            instance: { v: 1, id: 'private', definition: { kind: 'artifact', artifactId }, bindings: {} },
            scope: { ...account, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } },
            anchorRef: React.useRef(null), testID: 'private-definition' });
        return <><Pressable testID="private-about" onPress={flows.about} />{flows.panel}</>;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Definition /></Page>);
    const title = `${t('widgetDefinition.aboutTitle')}: Private checks`;
    definitionReads = 0;
    await act(async () => {
        const found = command(title);
        expect(found).toBeDefined();
        expect((await createDefaultActionExecutor().execute('ui.current_context.command.invoke',
            { commandId: found!.id }, { surface: 'agent' })).ok).toBe(true);
    });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('private-definition.about.loading')).toBeNull()); });
    expect(definitionReads).toBe(0);
    expect(screen.getTextContent()).toContain(t('widgetDefinition.aboutUnavailable'));
    await act(async () => { expect((await invoke(`${t('common.close')}: Private checks`)).ok).toBe(true); });
    await act(async () => { await screen.findHostByTestId('private-about')!.props.onPress(); });
    await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('Private checks')); });
    expect(definitionReads).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain('Private checks');
});

it('opens an artifact network editor with caller admission and exposes its draft and cancel', async () => {
    const artifactId = '22222222-2222-4222-8222-222222222232';
    const account = { serverId, accountId: 'viewer' };
    const created = await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId, definition: {
        sizeDeclaration: { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize },
        name: 'HTML checks', body: { kind: 'html', source: artifactHtmlBundleFromBodyV1('<h1>Checks</h1>') },
        inputs: { fields: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    } }, { serverId, surface: 'ui', authority: 'present_user' });
    expect(created.ok).toBe(true);
    if (!created.ok || typeof created.result !== 'object' || created.result === null) throw new Error('Definition creation must succeed');
    const definition = WidgetDefinitionV1Schema.parse(Reflect.get(created.result, 'definition'));
    function Network() {
        const candidate = describeAuthoredWidgetDefinitionV1(definition, { kind: 'artifact', artifactId });
        const editor = useWidgetInstanceNetworkEditor({ candidate,
            instance: { v: 1, id: 'html', definition: { kind: 'artifact', artifactId }, bindings: {} },
            scope: { ...account, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } },
            anchorRef: React.useRef(null), setNetwork: async () => { throw new Error('Draft must not save'); }, testID: 'network' });
        return <><Pressable testID="network-open" onPress={editor.onNetwork} />{editor.panel}</>;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Network /></Page>);
    const title = `${t('sessionBoard.item.network.title')}: HTML checks`;
    await act(async () => {
        const found = command(title);
        expect(found).toBeDefined();
        expect((await createDefaultActionExecutor().execute('ui.current_context.command.invoke', { commandId: found!.id }, { surface: 'agent' })).ok).toBe(true);
    });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('network.network.loading')).toBeNull()); });
    expect(screen.root.findAllByType(SessionVisualNetworkPanel)).toHaveLength(0);
    await act(async () => { await screen.findHostByTestId('network-open')!.props.onPress(); });
    await act(async () => { await vi.waitFor(() => expect(screen.root.findAllByType(SessionVisualNetworkPanel)).toHaveLength(1)); });
    await act(async () => { expect((await invoke(t('sessionBoard.item.network.reach'), 'origins')).ok).toBe(true); });
    expect(screen.root.findByType(SegmentedChoiceItem).props.value).toBe('origins');
    await act(async () => { expect((await invoke(t('sessionBoard.item.network.sitesLabel'), 'https://checks.test')).ok).toBe(true); });
    expect(screen.root.findByType(FieldTextInput).props.value).toBe('https://checks.test');
    await act(async () => { expect((await invoke(`${t('common.close')}: HTML checks`)).ok).toBe(true); });
    expect(screen.root.findAllByType(SessionVisualNetworkPanel)).toHaveLength(0);
});

it('retries setup options through the existing resolver with the command caller and standalone UI', async () => {
    const account = { serverId, accountId: 'viewer' };
    const setPolicy = (disabledSurfaces: ('ui' | 'agent')[]) => {
        const settings = storage.getState().settings;
        const next = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            ...settings.actionsSettingsV1,
            actions: { ...settings.actionsSettingsV1.actions, 'action.options.resolve': { disabledSurfaces } },
        }) };
        home!.replaceAccountSettings('widget', { settings: next, version: ++settingsVersion });
        storage.getState().applySettingsForScope(account, next, settingsVersion);
    };
    setPolicy(['ui', 'agent']);
    const field = { path: 'period', title: 'Period', widget: 'select', inputType: { hostType: 'usageQuery', field: 'period' } } as const;
    let current: ReturnType<typeof useInputFieldOptions> | undefined;
    function Options() {
        current = useInputFieldOptions({ serverId, enabled: true, requests: [{ field,
            consumer: { kind: 'widget', surface: { ...account, owner: { kind: 'home' } }, definition: { kind: 'builtin', id: 'usage_flow' } }, draftInput: {} }] });
        const state = current.state(field);
        return <>
            {state.status === 'failed' ? <WidgetSetupOptionsNotice label="Period" onRetry={current.retry} testID="retry.optionsFailed" /> : null}
            <WidgetSetupFieldRow entry={{ field }} row={{ kind: 'needed' }} options={state.options.map(option => ({ ...option, value: option.value as import('@happier-dev/protocol/json/strictJsonValue').JsonValue }))}
                optionsStatus={state.status} plainValue={undefined} phone={false} onChange={() => {}} testID="retry" />
        </>;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Options /></Page>);
    await act(async () => { await vi.waitFor(() => expect(current!.state(field).status).toBe('failed')); });
    await act(async () => { setPolicy(['agent']); });
    const uiOptions = await createDefaultActionExecutor().execute('action.options.resolve', {
        optionsSourceId: 'usage.query.period', fieldPath: 'period', draftInput: {},
        consumer: { kind: 'widget', surface: { ...account, owner: { kind: 'home' } }, definition: { kind: 'builtin', id: 'usage_flow' } },
    }, { serverId, surface: 'ui' });
    expect(uiOptions.ok, JSON.stringify(uiOptions)).toBe(true);
    await act(async () => {
        const found = command(`${t('common.retry')}: Period`);
        expect(found).toBeDefined();
        await createDefaultActionExecutor().execute('ui.current_context.command.invoke', { commandId: found!.id }, { surface: 'agent' });
    });
    await act(async () => { await vi.waitFor(() => expect(current!.state(field)).toMatchObject({ status: 'failed', errorCode: 'action_disabled' })); });
    expect(current!.state(field).options).toHaveLength(0);
    await act(async () => { await screen.root.findByType(SurfaceStateCard).props.action.onPress(); });
    await act(async () => { await vi.waitFor(() => expect(current!.state(field).status).toBe('ready')); });
    expect(current!.state(field).errorCode).toBeUndefined();
    expect(current!.state(field).options.length).toBeGreaterThan(0);
    await act(async () => { standardCleanup(); await Promise.resolve(); });
    await act(async () => { setPolicy(['ui', 'agent']); });
    const standalone = await renderMountedCurrentUiContext(<CorePluginUiPresentationScope><Options /></CorePluginUiPresentationScope>);
    await act(async () => { await vi.waitFor(() => expect(current!.state(field).status).toBe('failed')); });
    await act(async () => { setPolicy(['agent']); });
    await act(async () => { await standalone.root.findByType(SurfaceStateCard).props.action.onPress(); });
    await act(async () => { await vi.waitFor(() => expect(current!.state(field).status).toBe('ready')); });
    expect(current!.state(field).options.length).toBeGreaterThan(0);
});

it.each(['editor', 'gallery', 'copy', 'about'] as const)('keeps initial setup options admission with the %s opener caller', async (mode) => {
    const account = { serverId, accountId: 'viewer' };
    const setPolicy = (disabledSurfaces: ('agent')[]) => {
        const settings = storage.getState().settings;
        const next = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            ...settings.actionsSettingsV1,
            actions: { ...settings.actionsSettingsV1.actions, 'action.options.resolve': { disabledSurfaces } },
        }) };
        home!.replaceAccountSettings('widget', { settings: next, version: ++settingsVersion });
        storage.getState().applySettingsForScope(account, next, settingsVersion);
    };
    setPolicy(['agent']);
    const definition = { kind: 'builtin' as const, id: 'usage_period_summary' };
    const candidate = readWidgetDescriptor(null, definition)!;
    const scope = { ...account, owner: { kind: 'corePage' as const, pageId: 'usage', area: 'main' as const } };
    const setup = buildWidgetCandidateSetup({ candidate, context: {}, audience: 'personal', scope,
        mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => { throw new Error('Options must not submit'); } });
    expect(await createDefaultActionExecutor().execute('action.options.resolve', {
        optionsSourceId: 'usage.query.period', fieldPath: 'period', draftInput: {},
        consumer: { kind: 'widget', surface: scope, definition },
    }, { serverId, surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    function Editor() {
        const edit = useWidgetInputsEditor({ candidate, instance: { v: 1, id: 'period', definition, bindings: {} },
            scope, context: {}, audience: 'personal', setInputs: async () => { throw new Error('Options must not save'); }, testID: 'initial' });
        const flow = useWidgetDefinitionFlows({ instance: { v: 1, id: 'period', definition, bindings: {} }, scope,
            title: candidate.title, anchorRef: edit.anchorRef, editInputs: edit.editInputs, testID: 'initial' });
        return <>{edit.popover}{mode === 'about' ? flow.panel : null}</>;
    }
    function Copy() {
        const flow = useWidgetDefinitionFlows({ instance: { v: 1, id: 'period', definition, bindings: {} }, scope,
            title: candidate.title, anchorRef: React.useRef(null), testID: 'initial' });
        return <>{flow.panel}</>;
    }
    const screen = await renderMountedCurrentUiContext(<Page>{mode === 'editor' || mode === 'about' ? <Editor /> : mode === 'copy' ? <Copy /> : <WidgetAddPanel
        title="Add widget" searchPlaceholder="Search widgets" sections={[{ id: 'usage', title: 'Usage', entries: [
            { id: 'period', title: candidate.title, icon: candidate.icon, setup: () => setup },
        ] }]} serverId={serverId} addLabel="Add" composition="push" onRequestClose={() => {}} testID="initial" />}</Page>);
    if (mode === 'copy') await act(async () => { expect((await invoke(`${t('widgetFrame.groupAddTo')}: ${candidate.title}`)).ok).toBe(true); });
    const aboutTitle = `${t('widgetDefinition.aboutTitle')}: ${candidate.title}`;
    if (mode === 'about') await act(async () => { expect((await invoke(aboutTitle)).ok).toBe(true); });
    const title = mode === 'about' ? `${t('common.edit')}: ${candidate.title}` : mode === 'editor' ? `${t('widgetAdd.editInputs')}: ${candidate.title}` : mode === 'copy' ? t('common.home') : candidate.title;
    const open = async () => {
        const found = command(title);
        expect(found).toBeDefined();
        expect((await createDefaultActionExecutor().execute('ui.current_context.command.invoke', { commandId: found!.id }, { surface: 'agent' })).ok).toBe(true);
    };
    const period = () => screen.root.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === 'period');
    await act(open);
    if (mode === 'about') expect(screen.findByTestId('initial.about')).toBeNull();
    await act(async () => { await vi.waitFor(() => expect(period()?.props.optionsStatus).toBe('failed')); });
    expect(period()!.props.options).toHaveLength(0);
    await act(async () => { expect((await invoke(mode === 'gallery' ? 'Back: Add widget' : mode === 'copy'
        ? `${t('common.back')}: ${candidate.title}` : `${t('common.close')}: ${candidate.title}`)).ok).toBe(true); });
    if (mode === 'about') await act(async () => { expect((await invoke(aboutTitle)).ok).toBe(true); });
    await act(async () => { setPolicy([]); });
    const agentOptions = await createDefaultActionExecutor().execute('action.options.resolve', {
        optionsSourceId: 'usage.query.period', fieldPath: 'period', draftInput: {},
        consumer: { kind: 'widget', surface: scope, definition },
    }, { serverId, surface: 'agent' });
    expect(agentOptions.ok, JSON.stringify(agentOptions)).toBe(true);
    await act(open);
    await act(async () => { await vi.waitFor(() => expect(period()?.props.optionsStatus).toBe('ready')); });
    expect(period()!.props.options.length).toBeGreaterThan(0);
});

it('changes a widget from About through its editable composer Action without promoting an agent caller', async () => {
    const scope = { serverId, accountId: 'viewer' };
    const sessionId = 'widget-about-composer';
    const ref = { kind: 'session' as const, sessionId };
    await prepareSessionDraftPersistenceStorage();
    storage.setState(state => ({ sessions: { ...state.sessions, [sessionId]: createSessionFixture({ id: sessionId, serverId }) } }));
    writeExistingSessionDraft({ scope, sessionId, patch: { text: 'Keep this draft' } });
    const owner = createRepositoryComposerDocumentOwner({ scope, ref });
    let editable = true;
    const unregister = registerSessionComposerPresentationTarget({ serverId, sessionId }, {
        readScope: () => scope, isPresented: () => true,
        readRevision: () => owner.read().revision,
        replace: text => owner.replaceDocument({ ...owner.read().document, text }),
        readSnapshot: () => projectComposerDocumentSnapshot({ owner, attachmentCatalog: { entriesById: {} },
            presentation: { layout: 'wrap', focused: false, editable, submittable: editable, submitting: false, running: false } }),
        commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
        commitDocumentEmitsChange: true,
    });
    try {
        const settings = storage.getState().settings;
        const next = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ ...settings.actionsSettingsV1,
            actions: { ...settings.actionsSettingsV1.actions, 'composer.transaction.apply': { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { ...settings.actionsSettingsV1.approvalWaivedSurfaces, 'composer.transaction.apply': ['ui'] },
        }) };
        home!.replaceAccountSettings('widget', { settings: next, version: ++settingsVersion });
        storage.getState().applySettingsForScope(scope, next, settingsVersion);
        function Definition() {
            const flow = useWidgetDefinitionFlows({ instance: { v: 1, id: 'period', definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: {} },
                scope: { ...scope, owner: { kind: 'sessionBoard', sessionId } }, anchorRef: React.useRef(null), testID: 'about-change' });
            return <>{flow.panel}</>;
        }
        const screen = await renderMountedCurrentUiContext(<Page><Definition /></Page>);
        const name = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_period_summary' })!.title;
        const aboutTitle = `${t('widgetDefinition.aboutTitle')}: ${name}`;
        const changeTitle = `${t('widgetDefinition.changeWithAgent')}: ${name}`;
        await act(async () => { expect((await invoke(aboutTitle)).ok).toBe(true); });
        await act(async () => {
            const found = command(changeTitle);
            expect(found, changeTitle).toBeDefined();
            expect((await createDefaultActionExecutor().execute('ui.current_context.command.invoke', { commandId: found!.id }, { surface: 'agent' })).ok).toBe(true);
        });
        expect(owner.read().document.text).toBe('Keep this draft');
        expect(screen.findByTestId('about-change.about')).not.toBeNull();
        await act(async () => { await screen.findHostByTestId('about-change.about.changeWithAgent')!.props.onPress(); });
        await act(async () => { await vi.waitFor(() => expect(owner.read().document.text).toBe(`Keep this draft\n${t('widgetDefinition.changeDraft', { widget: name })}`)); });
        expect(screen.findByTestId('about-change.about')).toBeNull();
        editable = false;
        await act(async () => { expect((await invoke(aboutTitle)).ok).toBe(true); });
        expect(command(changeTitle)).toBeUndefined();
        expect(screen.findByTestId('about-change.about.changeWithAgent')).toBeNull();
    } finally {
        unregister();
        await discardSessionDraftPersistenceWrites();
    }
});

it('uses the actual public field choice visibility owner for UI and agent opens', async () => {
    const screen = await renderMountedCurrentUiContext(<Page><WidgetSetupFieldRow
        entry={{ field: { path: 'repository', title: 'Repository', widget: 'select' } }}
        row={{ kind: 'needed' }} options={Array.from({ length: 9 }, (_, index) => ({ value: String(index), label: `Project ${index}` }))}
        optionsStatus="ready" plainValue={undefined} phone={false} onChange={() => {}} testID="choice" /></Page>);
    await act(async () => { expect((await invoke(`${t('common.open')}: Repository`)).ok).toBe(true); });
    expect(screen.findHostByTestId('choice.control.trigger')!.props.accessibilityState.expanded).toBe(true);
    await act(async () => { expect((await invoke(`${t('common.open')}: Repository`)).ok).toBe(true); });
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    await act(async () => { await screen.findHostByTestId('choice.control.trigger')!.props.onPress(); });
    expect(screen.findHostByTestId('choice.control.trigger')!.props.accessibilityState.expanded).toBe(false);
});

it('withdraws setup choice commands while the public field cannot offer its options', async () => {
    let settle: (() => void) | undefined;
    function Field() {
        const [status, setStatus] = React.useState<'failed' | 'ready'>('failed');
        settle = () => setStatus('ready');
        return <WidgetSetupFieldRow entry={{ field: { path: 'repository', title: 'Repository', widget: 'select' } }}
            row={{ kind: 'needed' }} options={Array.from({ length: 9 }, (_, index) => ({ value: String(index), label: `Project ${index}` }))}
            optionsStatus={status} plainValue={undefined} phone={false} onChange={() => {}} testID="choice" />;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Field /></Page>);
    expect(screen.findHostByTestId('choice.control.trigger')!.props.accessibilityState.disabled).toBe(true);
    expect(command(`${t('common.open')}: Repository`)).toBeUndefined();
    await act(async () => { settle!(); });
    await act(async () => { expect((await invoke(`${t('common.open')}: Repository`)).ok).toBe(true); });
    expect(screen.findHostByTestId('choice.control.trigger')!.props.accessibilityState.expanded).toBe(true);
});

it('publishes the open setup field search and dismissal without replacing its choice owner', async () => {
    const screen = await renderMountedCurrentUiContext(<Page><WidgetSetupFieldRow
        entry={{ field: { path: 'repository', title: 'Repository', widget: 'select' } }}
        row={{ kind: 'needed' }} options={Array.from({ length: 9 }, (_, index) => ({ value: String(index), label: `Project ${index}` }))}
        optionsStatus="ready" plainValue={undefined} phone={false} autoOpen onChange={() => {}} testID="choice" /></Page>);
    await act(async () => { expect((await invoke(`${t('common.search')}: Repository`, 'Project 8')).ok).toBe(true); });
    expect(screen.findByTestId('choice.option.8')).not.toBeNull();
    expect(screen.findByTestId('choice.option.0')).toBeNull();
    await act(async () => { expect((await invoke(`${t('common.close')}: Repository`)).ok).toBe(true); });
    expect(screen.findByTestId('choice.option.8')).toBeNull();
});
