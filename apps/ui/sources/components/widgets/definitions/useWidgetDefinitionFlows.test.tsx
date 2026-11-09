import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIDGET_SIZE_POLICY_V1, WidgetDefinitionV1Schema, type WidgetInstanceV1, type WidgetSizeDeclarationV1 } from '@happier-dev/protocol/widgets';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel: the harness
// installs its network boundaries with `vi.doMock`, which only reaches modules imported afterwards.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { WidgetAddSection } from '../add/widgetAddModel';

/**
 * About this widget and Duplicate run the canonical `widgets.definition.*` Actions over the Home's
 * real Account Artifact store; only the network and the credential store are replaced.
 */
const harness = createHomeGovernanceHarness();
// Only physical confirmation is substituted; the real Action policy and its Inbox custody remain.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// A native virtual list needs layout callbacks the host renderer cannot supply.
vi.mock('@legendapp/list/react-native', async importOriginal =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(), renderItems: true,
    }).module);
// Popover placement is a native layout boundary; keep the real Gallery visible in the host renderer.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, {
        maxHeight: 624, maxWidth: 960, placement: 'bottom',
    }));
installHomeGovernanceBoundaries(harness);
// The fixture Home is reachable. Deliver only the external transport event;
// the real connection owner still establishes scoped request authority.
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
await loadSyncSingletonForTests();
const { BoardWidgetAddPopover } = await import('../add/BoardWidgetAddPopover');

const ACCOUNT_ID = 'account-a';
const DEFINITION_LIST_PATH = '/v1/artifacts?limit=500&kind=widget_definition';
let restoreUuid: (() => void) | null = null;

async function addDefinitionHome(portable = false): Promise<string> {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://definitions-home.example',
        ...(portable ? { publicServerUrl: 'https://definitions-home.example', serverIdentityId: 'srv_definitions' } : {}), accountId: ACCOUNT_ID });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ profileScope: { serverId, accountId: ACCOUNT_ID }, settingsScope: { serverId, accountId: ACCOUNT_ID } });
    harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    harness.answer(serverId, '/v1/account/encryption/currentness', {
        body: { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 },
    });
    return serverId;
}

async function applyDefinitionHomeConnection() {
    const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://definitions-home.example');
    if (!credentials) throw new Error('The test Home must be signed in');
    await restoreConnectionToActiveServer(credentials);
    return disconnectActiveServerConnection;
}

const SIZE_DECLARATION = { sizes: [...WIDGET_SIZE_POLICY_V1.home.sizes], defaultSize: WIDGET_SIZE_POLICY_V1.home.defaultSize } satisfies WidgetSizeDeclarationV1;
const DRAFT = {
    sizeDeclaration: SIZE_DECLARATION,
    name: 'Checks on main',
    body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } },
    inputs: { fields: [{ path: 'repo', title: 'Repository', widget: 'text' }] },
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, additionalProperties: false },
} as const;

describe('widget definition flows', () => {
    beforeEach(async () => {
        await harness.reset();
        // Connection readiness and scoped requests use one canonical Home boundary.
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(harness.request);
    });
    afterEach(async () => {
        standardCleanup(); restoreUuid?.(); restoreUuid = null;
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
    });

    it.each([
        { destinationKind: 'home', approval: true },
        { destinationKind: 'project', approval: true },
        { destinationKind: 'project', approval: false },
    ] as const)('copies resolved page inputs to $destinationKind through the shared menu and Add Action (approval=$approval)', async ({ destinationKind, approval }) => {
        const serverId = await addDefinitionHome();
        if (approval) await harness.requireUiApproval(serverId, 'widgets.item.add');
        const disconnect = await applyDefinitionHomeConnection();
        const React = await import('react');
        const { View } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useWidgetDefinitionFlows } = await import('./useWidgetDefinitionFlows');
        const { buildWidgetDefinitionActions } = await import('../frame/widgetFrameMenu');
        const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
        const { WidgetSetupStep } = await import('../add/WidgetSetupStep');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { storage } = await import('@/sync/domains/state/storage');
        const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'workspace', serverId, machineId: 'machine', rootPath: '/project',
            label: 'Destination project', projectKey: 'destination-project', createdAtMs: 0 }] });
        const { USAGE_QUERY_INPUT_FIELDS } = await import('@happier-dev/protocol/inputs/usageQuery');
        const { resolveUsageWidgetPageInitialQuery, readUsageWidgetPageScope } = await import('@/components/settings/usage/usageWidgetPageContext');
        const { projectNativeJsonValueForTransport } = await import('@happier-dev/protocol/json/strictJsonValue');
        const source: WidgetInstanceV1 = { v: 1, id: 'source', definition: { kind: 'builtin', id: 'usage_period_summary' },
            bindings: { ...Object.fromEntries(USAGE_QUERY_INPUT_FIELDS.filter(field => field.contextMode === 'follow')
                .map(field => [field.path, { kind: 'context' as const, slot: field.path }])),
                metric: { kind: 'value' as const, value: 'cost' }, breakdown: { kind: 'value' as const, value: ['agent'] } } };
        const pageScope = readUsageWidgetPageScope(resolveUsageWidgetPageInitialQuery({ nowMs: 1_791_450_000_000, timeZoneOffsetMinutes: 0 }));
        const pageInput = { ...pageScope, period: projectNativeJsonValueForTransport(pageScope.period),
            agents: ['agent'], machines: [], projects: ['source-project'], sources: [], session: null,
            costBasis: 'reported', metric: 'cost', breakdown: ['agent'] };
        function Card() {
            const flows = useWidgetDefinitionFlows({ instance: source, scope: { serverId, accountId: ACCOUNT_ID,
                owner: { kind: 'corePage', pageId: 'usage', area: 'main' } }, anchorRef: React.useRef(null),
                providedContext: Object.fromEntries(Object.entries(pageInput).map(([path, value]) => [path, [value]])), testID: 'copy' });
            const actions = buildWidgetDefinitionActions({ onAbout: flows.about, onAddTo: flows.addTo });
            return React.createElement(View, null,
                React.createElement(ItemRowActions, { title: 'Widget actions', actions }), flows.panel);
        }
        const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: null, children: React.createElement(Card) }));
        try {
            const menu = screen.tree.root.findByType(ItemRowActions);
            const action = menu.props.actions.find((entry: { id: string }) => entry.id === 'addTo');
            expect(action).toBeDefined();
            if (!action?.onPress) throw new Error('Expected the Add to action');
            const onPress = action.onPress;
            await act(async () => { onPress(); });
            await screen.pressByTestIdAsync(`copy.addTo.destination.${destinationKind === 'home' ? 'home' : 'project:destination-project'}`);
            const setup = screen.tree.root.findByType(WidgetSetupStep).props.setup;
            expect(setup.initial.bindings.period).toEqual({ kind: 'value', value: { relative: '7days' } });
            const { breakdown: _unused, ...consumedPageInput } = pageInput;
            expect(setup.fields.some((entry: { field: { path: string } }) => entry.field.path === 'breakdown')).toBe(false);
            expect(setup.resolve(setup.initial)).toMatchObject({ status: 'ready', input: { ...consumedPageInput,
                projects: destinationKind === 'home' ? pageInput.projects : ['destination-project'] } });
            expect(Object.entries(setup.initial.bindings).every(([path, binding]) => (binding as { kind: string }).kind
                === (path === 'projects' && destinationKind === 'project' ? 'context' : 'value'))).toBe(true);
            const before = new Set(harness.artifacts(serverId).list().map(row => row.id));
            const uuidBoundary = await import('@/platform/randomUUID');
            const uuid = vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw new Error('UUID unavailable'); });
            restoreUuid = () => uuid.mockRestore();
            await act(async () => { await expect(setup.submit(setup.initial)).resolves.toMatchObject({ ok: false }); });
            expect(harness.artifacts(serverId).list()).toHaveLength(before.size);
            uuid.mockRestore();
            const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
            const inventory = createDeferred<void>();
            // Unrelated Account inventory is a network boundary, not a prerequisite
            // for acknowledging this known builtin's exact copy.
            harness.answer(serverId, 'GET /v1/artifacts', { respondAfter: inventory.promise, body: { artifacts: [], nextCursor: null } });
            let outcome: Awaited<ReturnType<typeof setup.submit>> | undefined;
            const submission = setup.submit(setup.initial).then(result => { outcome = result; });
            try {
                await act(async () => { await expect.poll(() => outcome).toEqual(approval ? { ok: true, approvalPending: true } : { ok: true }); });
            } finally { inventory.resolve(); await submission; }
            const created = harness.artifacts(serverId).list().find(row => !before.has(row.id));
            expect(created).toBeDefined();
            if (!approval) {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const read = await createDefaultActionExecutor().execute('widgets.item.list', { surface: { serverId, accountId: ACCOUNT_ID,
                    owner: { kind: 'project', projectId: 'destination-project' } } }, { serverId, surface: 'ui', authority: 'present_user' });
                expect(read).toMatchObject({ ok: true, result: { instances: expect.arrayContaining([expect.objectContaining({ instance: expect.objectContaining({
                    definition: source.definition, bindings: setup.initial.bindings,
                }) })]) } });
                return;
            }
            const body = JSON.parse(harness.artifacts(serverId).readPlainBody(created!.id)!);
            expect(body).toMatchObject({ actionId: 'widgets.item.add', actionArgs: { surface: { serverId, accountId: ACCOUNT_ID,
                owner: destinationKind === 'home' ? { kind: 'home' } : { kind: 'project', projectId: 'destination-project' } },
                instance: { definition: source.definition, bindings: setup.initial.bindings } } });
            expect(body.actionArgs.instance.id).not.toBe(source.id);
            expect(source.bindings.period).toEqual({ kind: 'context', slot: 'period' });
            expect(source.bindings.breakdown).toEqual({ kind: 'value', value: ['agent'] });
        } finally { await screen.unmount(); await disconnect(); }
    });

    it('settles the open Project copy when its delayed durable receipt arrives', async () => {
        const serverId = await addDefinitionHome();
        const disconnect = await applyDefinitionHomeConnection();
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { WidgetCopyPanel } = await import('./WidgetCopyPanel');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { storage } = await import('@/sync/domains/state/storage');
        const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const { WidgetFlowPanel } = await import('../flow/WidgetFlowPanel');
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'workspace', serverId, machineId: 'machine', rootPath: '/project',
            label: 'Destination project', projectKey: 'destination-project', createdAtMs: 0 }] });
        const receipt = createDeferred<void>();
        let committed = false;
        setRuntimeFetch(async (input, init) => {
            const response = await harness.request(input, init);
            const path = new URL(String(input)).pathname;
            if (init?.method === 'POST' && /^\/v1\/artifacts\/[^/]+$/.test(path) && path !== '/v1/artifacts/read' && response.ok) {
                committed = true;
                await receipt.promise;
            }
            return response;
        });
        const done = vi.fn();
        const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: null, children: React.createElement(WidgetCopyPanel, {
            instance: { v: 1, id: 'source', definition: { kind: 'builtin', id: 'usage_coach' }, bindings: {
                period: { kind: 'value', value: { relative: '7days' } }, agents: { kind: 'value', value: [] },
                machines: { kind: 'value', value: [] }, projects: { kind: 'value', value: [] }, sources: { kind: 'value', value: [] },
                session: { kind: 'value', value: null }, costBasis: { kind: 'value', value: 'auto' },
            } }, current: { serverId, accountId: ACCOUNT_ID, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } },
            destinationKey: 'project:destination-project', providedContext: {}, onClose: () => {}, onDone: done, testID: 'lateCopy',
        }) }));
        try {
            await screen.pressByTestIdAsync('lateCopy.setup.submit');
            await vi.waitFor(() => expect(committed).toBe(true));
            expect(done).not.toHaveBeenCalled();
            expect(screen.tree.root.findByType(WidgetFlowPanel).props.primary?.busy).toBe(true);
            await act(async () => { receipt.resolve(); });
            await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
            expect(screen.tree.root.findByType(WidgetFlowPanel).props.primary?.busy).toBe(false);
        } finally { receipt.resolve(); setRuntimeFetch(harness.request); await screen.unmount(); await disconnect(); }
    });

    it('discovers setup metadata through the list Action without opening definition bodies', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        await executor.execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' });
        const listed = await executor.execute('widgets.definition.list', { account }, { serverId, surface: 'ui', authority: 'present_user' });
        expect(listed).toMatchObject({ ok: true, result: { definitions: [{ artifactId: '22222222-2222-4222-8222-222222222231', name: DRAFT.name,
            inputs: DRAFT.inputs, inputSchema: DRAFT.inputSchema, bodyKind: 'declarative' }] } });
    });

    it('discovers a saved definition in the mounted Companion gallery and keeps a personal reference through its real preference owner', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const { CompanionWidgetAddPopover } = await import('../add/CompanionWidgetAddPopover');
        const { WidgetAddSurface } = await import('../add/WidgetAddSurface');
        const { useSessionCompanionController } = await import('@/components/sessions/companion/state/useSessionCompanionController');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const account = { serverId, accountId: ACCOUNT_ID };
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        try {
            expect(await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222232', definition: DRAFT },
                { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
            const observed: { current: ReturnType<typeof useSessionCompanionController> | null } = { current: null };
            function Gallery() {
                const controller = useSessionCompanionController({ serverId, sessionId: 'personal', openFullSurface: () => {} });
                observed.current = controller;
                return React.createElement(CompanionWidgetAddPopover, { open: true, anchorRef: React.createRef<import('react-native').View>(),
                    onRequestClose: () => {}, testID: 'companionAdd', source: { refs: controller.preference.items, snapshot: null, pluginProjection: null,
                        context: { session: { ref: { serverId, sessionId: 'personal' }, label: 'Personal Session' } },
                        addItem: item => { if (!controller.addItem(item)) throw new Error('companion_unavailable'); } } });
            }
            const screen = await renderScreen(React.createElement(Gallery));
            try {
                const sections = (): readonly WidgetAddSection[] => screen.tree.root.findByType(WidgetAddSurface).props.sections;
                await vi.waitFor(() => { expect(sections().find(section => section.id === 'yours')?.entries[0]?.title).toBe(DRAFT.name); });
                const setup = sections().find(section => section.id === 'yours')!.entries[0]!.setup!();
                await act(async () => { expect(await setup.submit({ bindings: { repo: { kind: 'value', value: 'main' } } })).toEqual({ ok: true }); });
                await flushHookEffects({ cycles: 2 });
                expect(observed.current?.preference.items).toMatchObject([{ kind: 'instance', instance: {
                    definition: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222232' }, bindings: { repo: { kind: 'value', value: 'main' } },
                } }]);
            } finally { await screen.unmount(); }
        } finally { storage.setState(previousScopes); }
    });

    it('admits the selected widget’s preview through the configured surface and leaves unresolved inputs unmounted', async () => {
        const serverId = await addDefinitionHome();
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { widgetProjectionOf, widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const { selectWidgetCandidates } = await import('../widgetCatalog');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { ConfiguredInstalledWidgetSurface } = await import('../InstalledWidgetSurface');
        const { WidgetAddSurface } = await import('../add/WidgetAddSurface');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useSessionBoardController } = await import('@/components/sessions/board/useSessionBoardController');
        const { createSessionBoardActionsPort } = await import('@/sync/domains/session/board/sessionBoardActionsPort');
        const { projectSessionBoard } = await import('@/sync/domains/session/board');
        const React = await import('react');
        const account = { serverId, accountId: ACCOUNT_ID };
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        const session = createSessionFixture({ id: 'physical-A', serverId, encryptionMode: 'plain' });
        const projection = widgetProjectionOf([
            { pluginId: 'acme.preview', localId: 'app', target: 'app' },
            { pluginId: 'acme.preview', localId: 'missing', target: 'app', inputs: { fields: [{ path: 'repo', title: 'Repository', widget: 'text', required: true }] } },
        ], { 'acme.preview': widgetInstalledPackage('acme.preview', 'Preview') });
        const snapshot = projectSessionBoard({ layout: undefined, items: new Map(), capabilities: { readTranscript: true, editSessionRecords: true },
            freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false });
        const actions = createSessionBoardActionsPort({ serverId, sessionId: session.id });
        const candidates = selectWidgetCandidates(projection);
        function Gallery() {
            const controller = useSessionBoardController({ serverId, sessionId: session.id, actions, binding: { status: 'ready', snapshot },
                installedWidgetsAvailable: true });
            return React.createElement(BoardWidgetAddPopover, { open: true, anchorRef: React.createRef<import('react-native').View>(),
                onRequestClose: () => {}, controller, sessionId: session.id, session, candidates, testID: 'previewBoard' });
        }
        try {
            const screen = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
                pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: false, machineId: 'app-machine',
                serverId, platform: 'web', reloadConnectedAccountProjection: () => {}, accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
            }, children: React.createElement(Gallery) }));
            try {
                const sections: readonly WidgetAddSection[] = screen.tree.root.findByType(WidgetAddSurface).props.sections;
                const missing = sections.flatMap(section => section.entries).find(entry => entry.id === 'plugin-acme.preview/missing')!.setup!();
                // Its pane mounts a body only once the draft resolves; a missing input never does.
                expect(missing.resolve(missing.initial).status).not.toBe('ready');
                const app = sections.flatMap(section => section.entries).find(entry => entry.id === 'plugin-acme.preview/app')!.setup!();
                const resolution = app.resolve(app.initial);
                if (resolution.status !== 'ready') throw new Error('An inputless App widget resolves at once');
                const preview = app.renderPreview!({ input: resolution.input, draft: app.initial });
                const body = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
                    pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: false, machineId: 'app-machine',
                    serverId, platform: 'web', reloadConnectedAccountProjection: () => {}, accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
                }, children: preview }));
                try { expect(body.tree.root.findByType(ConfiguredInstalledWidgetSurface).props.resolution).toMatchObject({ status: 'ready', target: { kind: 'app' }, input: {} }); }
                finally { await body.unmount(); }
            } finally { await screen.unmount(); }
        } finally { storage.setState(previousScopes); }
    });

    it('offers saved widgets on a shared Board and submits an admitted inline copy to real approval custody', async () => {
        const serverId = await addDefinitionHome();
        await harness.requireUiApproval(serverId, 'widgets.item.add');
        const disconnect = await applyDefinitionHomeConnection();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { projectSessionBoard } = await import('@/sync/domains/session/board');
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useSessionBoardController } = await import('@/components/sessions/board/useSessionBoardController');
        const { createSessionBoardActionsPort } = await import('@/sync/domains/session/board/sessionBoardActionsPort');
        const { WidgetAddSurface } = await import('../add/WidgetAddSurface');
        const account = { serverId, accountId: ACCOUNT_ID };
        const surface = { ...account, owner: { kind: 'sessionBoard', sessionId: 'shared' } } as const;
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        const session = createSessionFixture({ id: 'shared', serverId, encryptionMode: 'plain' });
        storage.getState().applySessions([session]);
        try {
            const executor = createDefaultActionExecutor();
            expect(await executor.execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231', definition: DRAFT },
                { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
            const snapshot = projectSessionBoard({ layout: undefined, items: new Map(), capabilities: { readTranscript: true, editSessionRecords: true },
                freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false });
            const actions = createSessionBoardActionsPort({ serverId, sessionId: 'shared' });
            let updateBoard: React.Dispatch<React.SetStateAction<typeof snapshot>> = () => {};
            function Gallery() {
                const [board, setBoard] = React.useState(snapshot);
                updateBoard = setBoard;
                const controller = useSessionBoardController({ serverId, sessionId: 'shared', actions, binding: { status: 'ready', snapshot: board } });
                return React.createElement(BoardWidgetAddPopover, { open: true, anchorRef: React.createRef<import('react-native').View>(),
                    onRequestClose: () => {}, controller, sessionId: 'shared', session, candidates: [], testID: 'boardAdd' });
            }
            const screen = await renderScreen(React.createElement(Gallery));
            try {
                const sections = (): readonly WidgetAddSection[] => screen.tree.root.findByType(WidgetAddSurface).props.sections;
                await vi.waitFor(() => { expect(sections().find(section => section.id === 'yours')?.entries[0]?.title).toBe(DRAFT.name); });
                expect(sections().filter(section => section.id.startsWith('plugin:'))).toHaveLength(0);
                const entry = sections().find(section => section.id === 'yours')!.entries[0]!;
                const before = new Set(harness.artifacts(serverId).list().map(row => row.id));
                const setup = entry.setup!();
                expect(await setup.submit({ bindings: { repo: { kind: 'value', value: 'main' } } })).toEqual({ ok: true, approvalPending: true });
                const approvals = harness.artifacts(serverId).list().filter(row => !before.has(row.id));
                expect(approvals).toHaveLength(1);
                const approval = JSON.parse(harness.artifacts(serverId).readPlainBody(approvals[0]!.id)!);
                expect(approval).toMatchObject({ actionId: 'widgets.item.add', actionArgs: { surface, placement: { tabId: 'overview' },
                    instance: { definition: { kind: 'inline', definition: { id: '22222222-2222-4222-8222-222222222231', name: DRAFT.name } }, bindings: { repo: { kind: 'value', value: 'main' } } } } });
                const { SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
                const publishedItem = SessionSurfaceItemV1Schema.parse({ v: 1, title: DRAFT.name, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                    source: { kind: 'widget', instance: approval.actionArgs.instance } });
                const published = projectSessionBoard({ layout: undefined, items: new Map([['copy', { revision: 'r1', outcome: { status: 'ready' as const, value: publishedItem } }]]),
                    capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false });
                await act(async () => { updateBoard(published); });
                const copiedEntry = sections().find(section => section.id === 'yours')!.entries[0]!;
                expect(copiedEntry.count).toBe('1 on the board');
                expect(copiedEntry.added).not.toBe(true);
                const refused = await setup.submit({ bindings: { connection: { kind: 'value', value: { service: { pluginId: 'acme.checks', localId: 'cloud' }, accountId: 'private-author' } } } });
                expect(refused).toMatchObject({ ok: false });
                expect(harness.artifacts(serverId).list()).toHaveLength(before.size + 1);
            } finally { await act(async () => { screen.tree.unmount(); }); }
        } finally { await disconnect(); storage.setState(previousScopes); }
    });

    it.each(['sessionBoard', 'companion'] as const)('keeps the %s Gallery demand-gated and shows delayed, refused and retried saved inventory', async host => {
        const serverId = await addDefinitionHome();
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { useSessionBoardController } = await import('@/components/sessions/board/useSessionBoardController');
        const { createSessionBoardActionsPort } = await import('@/sync/domains/session/board/sessionBoardActionsPort');
        const { projectSessionBoard } = await import('@/sync/domains/session/board');
        const { CompanionWidgetAddPopover } = await import('../add/CompanionWidgetAddPopover');
        const account = { serverId, accountId: ACCOUNT_ID };
        expect(await createDefaultActionExecutor().execute('widgets.definition.create', {
            account, artifactId: '22222222-2222-4222-8222-222222222233', definition: DRAFT,
        }, { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
        const recovered = await harness.artifacts(serverId).handle(DEFINITION_LIST_PATH);
        if (!recovered) throw new Error('Expected the canonical Artifact list boundary');
        const recoveredInventory: unknown = await recovered.json();
        const session = createSessionFixture({ id: 'gallery-session', serverId, encryptionMode: 'plain' });
        const snapshot = projectSessionBoard({ layout: undefined, items: new Map(), capabilities: { readTranscript: true, editSessionRecords: true },
            freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false });
        const actions = createSessionBoardActionsPort({ serverId, sessionId: session.id });
        const anchorRef = React.createRef<import('react-native').View>();
        function Gallery({ open }: { open: boolean }) {
            const controller = useSessionBoardController({ serverId, sessionId: session.id, actions, binding: { status: 'ready', snapshot } });
            return host === 'sessionBoard'
                ? React.createElement(BoardWidgetAddPopover, { open, anchorRef, onRequestClose: () => {}, controller,
                    sessionId: session.id, session, candidates: [], testID: 'inventoryGallery' })
                : React.createElement(CompanionWidgetAddPopover, { open, anchorRef, onRequestClose: () => {}, testID: 'inventoryGallery',
                    source: { refs: [], snapshot: null, pluginProjection: null, addItem: () => {},
                        context: { session: { ref: { serverId, sessionId: session.id }, label: 'Current session' } } } });
        }
        const pending = createDeferred<void>();
        harness.answer(serverId, DEFINITION_LIST_PATH, { status: 403, body: { error: 'forbidden' }, respondAfter: pending.promise });
        const reads = () => harness.requestsFor(DEFINITION_LIST_PATH).length;
        const before = reads();
        const screen = await renderScreen(React.createElement(Gallery, { open: false }));
        try {
            expect(reads()).toBe(before);
            await screen.update(React.createElement(Gallery, { open: true }));
            await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
            expect(screen.findHostByTestId('inventoryGallery.pending.yours')).not.toBeNull();
            expect(screen.findHostByTestId('inventoryGallery.pending.yours.failed')).toBeNull();
            await act(async () => { screen.changeTextByTestId('inventoryGallery.search', DRAFT.name); });
            expect(screen.findHostByTestId('inventoryGallery.noMatch')).toBeNull();
            await act(async () => { pending.resolve(); });
            await vi.waitFor(() => expect(screen.findHostByTestId('inventoryGallery.pending.yours.failed')).not.toBeNull());
            expect(screen.findHostByTestId('inventoryGallery.noMatch')).toBeNull();
            // Restore the real HTTP Artifact store after the refused read.
            harness.answer(serverId, DEFINITION_LIST_PATH, { body: recoveredInventory });
            await screen.pressByTestIdAsync('inventoryGallery.pending.yours.retry');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(DRAFT.name));
            expect(reads()).toBeGreaterThan(before + 1);
            expect(screen.findHostByTestId('inventoryGallery.pending.yours')).toBeNull();
        } finally { pending.resolve(); await screen.unmount(); }
    });

    it('keeps authored gallery fields when the installed contribution declares different fields', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        const created = await executor.execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231',
            definition: { ...DRAFT, body: { kind: 'installed', surface: { pluginId: 'com.acme.checks', localId: 'checks' } } } },
            { serverId, surface: 'ui', authority: 'present_user' });
        expect(created).toMatchObject({ ok: true });
        const { widgetProjectionOf, widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const projection = widgetProjectionOf([{ pluginId: 'com.acme.checks', localId: 'checks' }], {
            'com.acme.checks': widgetInstalledPackage('com.acme.checks', 'Checks'),
        });
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useYourWidgetCandidatesState } = await import('./useYourWidgetCandidates');
        function Gallery() {
            const { candidates } = useYourWidgetCandidatesState(account, projection);
            return React.createElement(Text, {}, candidates.map(candidate => `${candidate.title}:${candidate.inputs?.fields.map(field => field.path).join(',')}:${candidate.target}`).join('|'));
        }
        const screen = await renderScreen(React.createElement(Gallery));
        try { await vi.waitFor(() => { expect(screen.getTextContent()).toContain(`${DRAFT.name}:repo:app`); }); }
        finally { await act(async () => { screen.tree.unmount(); }); }
    });

    it('settles a refused definition read as failed, never as endless loading, and reads again on Retry', async () => {
        const serverId = await addDefinitionHome();
        const account = { serverId, accountId: ACCOUNT_ID };
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useYourWidgetCandidatesState } = await import('./useYourWidgetCandidates');
        let retry = () => {};
        function Gallery() {
            const state = useYourWidgetCandidatesState(account, null);
            retry = state.retry;
            return React.createElement(Text, {}, state.status);
        }
        harness.answer(serverId, DEFINITION_LIST_PATH, { status: 403, body: { error: 'forbidden' } });
        const reads = () => harness.requestsFor(DEFINITION_LIST_PATH).length;
        const screen = await renderScreen(React.createElement(Gallery));
        try {
            await vi.waitFor(() => { expect(screen.getTextContent()).toBe('failed'); });
            const first = reads();
            await act(async () => { retry(); });
            // Retry asks again, and a second refusal settles again.
            await vi.waitFor(() => { expect(reads()).toBeGreaterThan(first); });
            await vi.waitFor(() => { expect(screen.getTextContent()).toBe('failed'); });
        } finally { await act(async () => { screen.tree.unmount(); }); }
    });

    it('keeps the Gallery empty before its Account scope is available', async () => {
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useYourWidgetCandidatesState } = await import('./useYourWidgetCandidates');
        function Gallery() {
            const { candidates } = useYourWidgetCandidatesState(null, null);
            return React.createElement(Text, {}, String(candidates.length));
        }
        const before = harness.requests.length;
        const screen = await renderScreen(React.createElement(Gallery));
        try {
            expect(screen.getTextContent()).toBe('0');
            expect(harness.requests).toHaveLength(before);
        } finally { await act(async () => { screen.tree.unmount(); }); }
    });

    it('mounts a demanded summary-backed App preview and refuses it truthfully until its runtime is available', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const account = { serverId, accountId: ACCOUNT_ID };
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { View } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useAccountWidgetAddSections } = await import('../add/accountWidgetAddSections');
        const { UnavailableInstalledWidget } = await import('../InstalledWidgetSurface');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        let demandPreview: React.Dispatch<React.SetStateAction<boolean>> = () => {};
        function Gallery() {
            const [demand, setDemand] = React.useState(false);
            demandPreview = setDemand;
            const { sections } = useAccountWidgetAddSections({ scope: { ...account, owner: { kind: 'home' } }, instances: [],
                addInstance: async () => {}, labels: { count: String, submit: 'Add' }, testID: 'gallery' });
            const setup = demand ? sections.find(section => section.id === 'yours')?.entries[0]?.setup?.() : undefined;
            return React.createElement(View, {}, setup ? setup.renderPreview?.({ input: {}, draft: setup.initial }) : null);
        }
        try {
            expect(await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231',
                definition: { ...DRAFT, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } } },
                { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
            const before = harness.requests.length;
            const screen = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, {
                value: { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                    machineId: 'machine-1', serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }, children: React.createElement(Gallery),
            }));
            try {
                await vi.waitFor(() => { expect(harness.requests.slice(before).some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true); });
                expect(harness.requests.slice(before).some(request => request.path === '/v1/artifacts/22222222-2222-4222-8222-222222222231')).toBe(false);
                await act(async () => { demandPreview(true); });
                // Selecting a Home is not an applied Sync runtime. The real mount must exist,
                // fail closed at that boundary, and never turn discovery into a body fetch.
                await vi.waitFor(() => { expect(screen.tree.root.findByType(UnavailableInstalledWidget).props.unresolved)
                    .toEqual({ state: 'unavailable', reasonCode: 'widget_scope_unavailable' }); });
                expect(harness.requests.slice(before).some(request => request.path === '/v1/artifacts/22222222-2222-4222-8222-222222222231')).toBe(false);
            } finally { await act(async () => { screen.tree.unmount(); }); }
        } finally { storage.setState(previousScopes); }
    });

    it('withdraws the previous Account gallery while the next Account inventory is pending', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const account = { serverId, accountId: ACCOUNT_ID };
        await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' });
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useYourWidgetCandidatesState } = await import('./useYourWidgetCandidates');
        let changeAccount: React.Dispatch<React.SetStateAction<typeof account>> = () => {};
        function Gallery() {
            const [selected, setSelected] = React.useState(account);
            changeAccount = setSelected;
            const { candidates } = useYourWidgetCandidatesState(selected, null);
            return React.createElement(Text, {}, candidates.map(candidate => candidate.title).join('|'));
        }
        const screen = await renderScreen(React.createElement(Gallery));
        let release = () => {};
        try {
            await vi.waitFor(() => { expect(screen.getTextContent()).toContain(DRAFT.name); });
            const nextServerId = await harness.addHome({ name: 'Home B', serverUrl: 'https://definitions-next.example', accountId: 'account-b' });
            harness.answer(nextServerId, '/v1/artifacts?limit=500', { body: [], respondAfter: new Promise<void>(resolve => { release = resolve; }) });
            await act(async () => { changeAccount({ serverId: nextServerId, accountId: 'account-b' }); });
            expect(screen.getTextContent()).not.toContain(DRAFT.name);
        } finally { release(); await act(async () => { screen.tree.unmount(); }); }
    });

    it('projects the saved definition name and updated inputs from the existing Artifact header', async () => {
        const serverId = await addDefinitionHome();
        const disconnect = await applyDefinitionHomeConnection();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        const { storage } = await import('@/sync/domains/state/storage');
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        await executor.execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' });
        const React = await import('react');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useWidgetInstanceDescriptor } = await import('../surface/useWidgetInstanceDescriptor');
        function Frame() {
            const descriptor = useWidgetInstanceDescriptor(account, { v: 1, id: 'copy',
                definition: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222231' }, bindings: {} }, null);
            return React.createElement(Text, { testID: 'definition-name' }, descriptor?.title ?? 'unavailable');
        }
        const screen = await renderScreen(React.createElement(Frame));
        const { act } = await import('react-test-renderer');
        try {
            await vi.waitFor(() => { expect(screen.getTextContent()).toContain(DRAFT.name); });
            await act(async () => { expect(await executor.execute('widgets.definition.update', { account, artifactId: '22222222-2222-4222-8222-222222222231', patch: { name: 'Updated checks' } },
                { serverId, surface: 'ui', authority: 'present_user', bypassApprovals: true })).toMatchObject({ ok: true, result: { definition: { name: 'Updated checks' } } }); });
            await vi.waitFor(() => { expect(screen.getTextContent()).toContain('Updated checks'); });
        } finally { await screen.unmount(); await disconnect(); storage.setState(previousScopes); }
    });

    it.each(['companion', 'area'] as const)('names the retained %s frame from the saved header without opening its body', async (placement) => {
        const serverId = await addDefinitionHome();
        const disconnect = await applyDefinitionHomeConnection();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const account = { serverId, accountId: ACCOUNT_ID };
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { widgetProjectionOf, widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { router } = await import('expo-router');
        const { SessionCompanionItemFrame } = await import('@/components/sessions/companion/SessionCompanionItemFrame');
        const { PluginGlance } = await import('@/components/sessions/companion/glances/PluginGlance');
        const { WidgetArea } = await import('@/components/widgets/area/WidgetArea');
        const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
        const { WidgetSurfaceReadV1Schema } = await import('@happier-dev/protocol/widgets');
        const projection = widgetProjectionOf([{ pluginId: 'com.acme.checks', localId: 'checks', title: 'Installed checks' }], {
            'com.acme.checks': widgetInstalledPackage('com.acme.checks', 'Checks'),
        });
        const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222231' }, bindings: {} } as const;
        const surface = { ...account, owner: { kind: 'pluginArea', pluginId: 'com.acme.checks', pageId: 'overview', area: 'pinned' } } as const;
        const widgetPlacement = { instance, size: WIDGET_SIZE_POLICY_V1.pluginArea.defaultSize };
        const layout = WidgetSurfaceReadV1Schema.parse({ surface, instances: [widgetPlacement], items: [{ kind: 'widget', ...widgetPlacement }], canEdit: true });
        // The plugin-page Host API is the external boundary; metadata comes from real Account storage.
        const port = { execute: async () => ({ ok: true as const, result: layout }) };
        const executor = createDefaultActionExecutor();
        try {
            expect(await executor.execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231',
                definition: { ...DRAFT, body: { kind: 'installed', surface: { pluginId: 'com.acme.checks', localId: 'checks' } } } },
                { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
            const before = harness.requests.length;
            const frame = placement === 'companion'
                ? React.createElement(SessionCompanionItemFrame, { label: 'Installed checks', testID: 'card', actions: [],
                    instanceControls: { instance, scope: { ...account, owner: { kind: 'companion', sessionId: 'session-a' } }, context: {},
                        setInputs: async () => ({ ok: true as const }), rename: () => {} },
                    children: (accessory, instanceView, bodyPresented) => React.createElement(PluginGlance, { instance, sessionId: 'session-a',
                        session: createSessionFixture({ id: 'session-a', serverId }), serverId, frameStyle: 'card', menu: accessory,
                        instanceView, bodyPresented: bodyPresented !== false, measurementOnly: true, testID: 'saved-frame' }),
                })
                : React.createElement(WidgetArea, { port, context: {}, geometry: 'grid', title: 'Pinned widgets',
                    surfaceName: 'Checks', testID: 'saved-area' });
            const screen = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, {
                value: { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                    machineId: 'machine-1', serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} },
                children: React.createElement(DestinationInstanceHost, { tabId: 'retained', ref: { kind: 'plugins', params: {} },
                    pathname: '/plugins', focused: false, visible: true, navigation: router, children: frame }),
            }));
            try {
                await vi.waitFor(() => { expect(screen.getTextContent()).toContain(DRAFT.name); });
                if (placement === 'companion') {
                    const menu = screen.tree.root.findByType(ItemRowActions);
                    expect(menu.props.title).toBe(DRAFT.name);
                    expect(menu.props.actions.some((action: { id: string }) => action.id === 'editInputs')).toBe(true);
                } else {
                    // A retained, unfocused area keeps its header but relinquishes active controls.
                    expect(screen.tree.root.findAllByType(ItemRowActions)).toHaveLength(0);
                }
                expect(harness.requests.slice(before).some(request => request.path === '/v1/artifacts/22222222-2222-4222-8222-222222222231')).toBe(false);
            } finally { await act(async () => { screen.tree.unmount(); }); }
        } finally { await disconnect(); storage.setState(previousScopes); }
    });

    it('describes placements in already opened WorkBoards without opening unrelated Board records', async () => {
        const serverId = await addDefinitionHome();
        // Configuration admission consumes the real applied Account lifetime, not merely a saved credential.
        const disconnect = await applyDefinitionHomeConnection();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const account = { serverId, accountId: ACCOUNT_ID };
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        try {
            const executor = createDefaultActionExecutor();
            const context = { serverId, surface: 'ui', authority: 'present_user' } as const;
            expect(await executor.execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231', definition: DRAFT }, context)).toMatchObject({ ok: true });
            expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222226', name: 'Checks board' } } }, context)).toMatchObject({ ok: true });
            const ref = { surface: { ...account, owner: { kind: 'workBoard', boardId: '22222222-2222-4222-8222-222222222226' } }, instanceId: 'copy-a' } as const;
            const instance = { v: 1, id: 'copy-a', definition: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222231' }, bindings: { repo: { kind: 'value', value: 'main' } } } as const;
            const placed = await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: '22222222-2222-4222-8222-222222222226', ref, instance } }, context);
            expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true });
            const before = harness.requests.length;
            const opened = await executor.execute('widgets.definition.get', { account, artifactId: '22222222-2222-4222-8222-222222222231' }, context);
            expect(opened).toMatchObject({ ok: true, result: { placementSummary: { placements: expect.arrayContaining([ref]), unavailableScopes: expect.arrayContaining(['workBoard']) } } });
            expect(harness.requests.slice(before).some(request => request.path.includes('/v1/artifacts/22222222-2222-4222-8222-222222222226'))).toBe(false);
        } finally { await disconnect(); storage.setState(previousScopes); }
    });

    it.each(['home', 'companion'] as const)('opens About from %s through the real definition read, edits this copy only, and duplicates into an independent definition', async (placement) => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        const created = await executor.execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222231', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' });
        expect(created).toMatchObject({ ok: true });

        const React = await import('react');
        const { View, Pressable } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { t } = await import('@/text');
        const { useWidgetDefinitionFlows } = await import('./useWidgetDefinitionFlows');
        const { SessionCompanionItemFrame } = await import('@/components/sessions/companion/SessionCompanionItemFrame');
        const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
        const editThisCopy = vi.fn();
        function Card() {
            const anchorRef = React.useRef(null);
            if (placement === 'companion') return React.createElement(SessionCompanionItemFrame, {
                label: 'Checks on main', testID: 'card', actions: [], instanceControls: {
                    instance: { v: 1, id: 'copy-a', definition: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222231' }, bindings: {} },
                    scope: { ...account, owner: { kind: 'companion', sessionId: 'session-a' } }, context: {},
                    setInputs: async () => ({ ok: true as const }), rename: () => {},
                }, children: (accessory: React.ReactNode) => accessory,
            });
            const flows = useWidgetDefinitionFlows({
                instance: { v: 1, id: 'copy-a', definition: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222231' }, bindings: {} },
                scope: { ...account, owner: { kind: 'home' } },
                anchorRef,
                editInputs: { onPress: editThisCopy, binding: 'happier · main' },
                testID: 'card',
            });
            return React.createElement(View, { ref: anchorRef },
                flows.about ? React.createElement(Pressable, { testID: 'card.openAbout', onPress: flows.about }) : null,
                flows.saveAsYours || flows.postSnapshot ? React.createElement(View, { testID: 'card.boardOnly' }) : null,
                flows.panel);
        }
        const screen = await renderScreen(React.createElement(Card));
        try {
            // Save as your widget and Post a snapshot belong to a Session Board card, not Home.
            expect(screen.findAllByTestId('card.boardOnly')).toHaveLength(0);
            await act(async () => {
                if (placement === 'home') await screen.pressByTestIdAsync('card.openAbout');
                else {
                    const menu = screen.tree.root.findByType(ItemRowActions);
                    const about = menu.props.actions.find((action: { id: string }) => action.id === 'about');
                    expect(about).toBeDefined();
                    if (!about?.onPress) throw new Error('Missing widget About action handler');
                    about.onPress();
                }
            });
            await vi.waitFor(() => { expect(screen.getTextContent()).toContain('Checks on main'); });
            expect(screen.getTextContent()).toContain(t('widgetDefinition.inputsThisCopy'));
            if (placement === 'home') expect(screen.getTextContent()).toContain('happier · main');
            // The consequence of editing the definition itself is said plainly.
            const consequence = screen.getTextContent();
            expect(consequence.includes(t('widgetDefinition.editsChangeEverywhere'))
                || consequence.includes(t('widgetDefinition.editsChangeAll', { count: 1 }))).toBe(true);

            const before = new Set(harness.artifacts(serverId).list().map((row) => row.id));
            const uuidBoundary = await import('@/platform/randomUUID');
            const { WidgetAboutPanel } = await import('./WidgetAboutPanel');
            const uuid = vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw new Error('UUID unavailable'); });
            restoreUuid = () => uuid.mockRestore();
            const duplicate = screen.tree.root.findByType(WidgetAboutPanel).props.onDuplicate;
            if (!duplicate) throw new Error('Expected the saved widget to offer Duplicate');
            await expect(duplicate()).resolves.toBeNull();
            expect(harness.artifacts(serverId).list()).toHaveLength(before.size);
            uuid.mockRestore();
            await act(async () => { await screen.pressByTestIdAsync('card.about.duplicate'); });
            await vi.waitFor(() => { expect(screen.findAllByTestId('card.about.duplicateResult').length).toBeGreaterThan(0); });
            expect(screen.getTextContent()).not.toContain(t('widgetDefinition.duplicateFailed'));
            // Duplicate wrote one new, independent definition Artifact through the Action.
            const added = harness.artifacts(serverId).list().filter((row) => !before.has(row.id));
            expect(added).toHaveLength(1);
            const copy = await executor.execute('widgets.definition.get', { account, artifactId: added[0]!.id }, { serverId, surface: 'ui', authority: 'present_user' });
            expect(copy, JSON.stringify(copy)).toMatchObject({ ok: true, result: { definition: { id: added[0]!.id } } });

            // Edit inputs from About changes this copy through the surface's own step, never the definition.
            if (placement === 'home') {
                await act(async () => { await screen.pressByTestIdAsync('card.about.editInputs'); });
                expect(editThisCopy).toHaveBeenCalledTimes(1);
            }
            const original = await executor.execute('widgets.definition.get', { account, artifactId: '22222222-2222-4222-8222-222222222231' }, { serverId, surface: 'ui', authority: 'present_user' });
            expect(original).toMatchObject({ ok: true, result: { definition: { name: 'Checks on main' } } });
        } finally {
            await act(async () => { screen.tree.unmount(); });
        }
    });

    it.each([
        ...(['builtin', 'installed', 'inline'] as const).flatMap(kind => [
            { kind, shared: false, readable: true }, { kind, shared: true, readable: true },
        ]),
        { kind: 'builtin' as const, shared: true, readable: false },
        { kind: 'artifact' as const, shared: true, readable: true },
    ])('opens About for a $kind definition (shared=$shared, readable=$readable) without reading a private Artifact', async ({ kind, shared, readable }) => {
        const serverId = await addDefinitionHome();
        const React = await import('react');
        const { View, Pressable } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useWidgetDefinitionFlows } = await import('./useWidgetDefinitionFlows');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { widgetProjectionOf, widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const projection = widgetProjectionOf([{ pluginId: 'acme.checks', localId: 'checks', title: 'Installed checks' }], {
            'acme.checks': widgetInstalledPackage('acme.checks', 'Checks plugin'),
        });
        const { WidgetAboutPanel } = await import('./WidgetAboutPanel');
        const definition: import('@happier-dev/protocol/widgets').WidgetDefinitionRefV1 = kind === 'builtin'
            ? { kind, id: 'changes' }
            : kind === 'installed' ? { kind, surface: { pluginId: 'acme.checks', localId: 'checks' } }
                : kind === 'artifact' ? { kind, artifactId: 'private-owner-definition' }
                : { kind, definition: { v: 1, id: 'shared-copy', ...DRAFT,
                    provenance: { source: { kind: 'session', serverId, sessionId: 'shared', itemId: 'shared-copy' } } } };
        function Card() {
            const flows = useWidgetDefinitionFlows({ instance: { v: 1, id: 'copy', definition, bindings: {} },
                scope: { serverId, accountId: shared ? 'layout-owner' : ACCOUNT_ID,
                    ...(shared ? { artifactId: 'shared-layout' } : {}), owner: { kind: 'project', projectId: 'project' } },
                ...(shared ? { admittedViewer: { serverId, accountId: ACCOUNT_ID }, isCurrent: () => readable } : {}),
                anchorRef: React.useRef(null), testID: 'aboutCopy' });
            return React.createElement(View, {}, flows.about ? React.createElement(Pressable, { testID: 'open', onPress: flows.about }) : null, flows.panel);
        }
        const before = harness.requests.length;
        const screen = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: 'machine-a', serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
        }, children: React.createElement(Card) }));
        try {
            expect(screen.findByTestId('open')).not.toBeNull();
            await act(async () => { await screen.pressByTestIdAsync('open'); });
            expect(screen.findByTestId('aboutCopy.about')).not.toBeNull();
            expect(screen.tree.root.findAllByType(WidgetAboutPanel)).toHaveLength(readable && kind !== 'artifact' ? 1 : 0);
            expect(screen.findByTestId('aboutCopy.about.duplicate')).toBeNull();
            if (kind === 'installed') expect(screen.getTextContent()).toContain('Checks plugin');
            if (kind === 'inline') expect(screen.getTextContent()).toContain(DRAFT.name);
            expect(harness.requests.slice(before).some(request => /^\/v1\/artifacts\//.test(request.path))).toBe(false);
        } finally { await act(async () => { screen.tree.unmount(); }); }
    });

    it('renews a mounted widget definition after same-Account activation and restoration', async () => {
        const serverId = await addDefinitionHome();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { useWidgetDefinition } = await import('@/sync/domains/widgets/useWidgetDefinition');
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const { act } = await import('react-test-renderer');
        const snapshot = getActiveServerSnapshot();
        const definition = WidgetDefinitionV1Schema.parse({ ...DRAFT, v: 1, id: 'inline-checks', provenance: { source: { kind: 'authored' } } });
        const scope = { serverId, accountId: ACCOUNT_ID, owner: { kind: 'home' as const } };
        publishAppliedActiveServerSnapshot(snapshot, false);
        const hook = await renderHook(() => useWidgetDefinition(scope, { kind: 'inline', definition }));
        try {
            expect(hook.getCurrent().state).toBe('unavailable');
            await act(async () => { publishAppliedActiveServerSnapshot(snapshot); });
            expect(hook.getCurrent()).toMatchObject({ state: 'available', definition });
            await act(async () => { publishAppliedActiveServerSnapshot(snapshot, false); });
            expect(hook.getCurrent().definition).toBeNull();
            await act(async () => { publishAppliedActiveServerSnapshot(snapshot); });
            expect(hook.getCurrent().definition).toBe(definition);
        } finally { await hook.unmount(); publishAppliedActiveServerSnapshot(snapshot); }
    });

    it('reports another Account’s saved definition as a durable unavailable definition, distinct from a Home that is not applied', async () => {
        const serverId = await addDefinitionHome();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { useWidgetDefinition } = await import('@/sync/domains/widgets/useWidgetDefinition');
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const snapshot = getActiveServerSnapshot();
        publishAppliedActiveServerSnapshot(snapshot);
        const ownerScope = { serverId, accountId: 'account-owner', owner: { kind: 'home' as const } };
        const hook = await renderHook(() => useWidgetDefinition(ownerScope, { kind: 'artifact', artifactId: 'owner-private-definition' }));
        try {
            expect(hook.getCurrent()).toEqual({ definition: null, state: 'unavailable', reasonCode: 'widget_definition_unavailable' });
        } finally { await hook.unmount(); publishAppliedActiveServerSnapshot(snapshot); }
    });

    it('keeps a settled About definition while resizing into the phone sheet', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const account = { serverId, accountId: ACCOUNT_ID };
        expect(await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId: '22222222-2222-4222-8222-222222222234', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
        const React = await import('react');
        const native = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useWidgetDefinitionFlows } = await import('./useWidgetDefinitionFlows');
        const dimensions = vi.spyOn(native, 'useWindowDimensions').mockReturnValue({ width: 1440, height: 1000, scale: 1, fontScale: 1 });
        function Card() {
            const flows = useWidgetDefinitionFlows({ instance: { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222234' }, bindings: {} },
                scope: { ...account, owner: { kind: 'home' } }, anchorRef: React.useRef(null), testID: 'resizeAbout' });
            return React.createElement(native.View, {}, React.createElement(native.Pressable, { testID: 'openAbout', onPress: flows.about }), flows.panel);
        }
        const screen = await renderScreen(React.createElement(Card));
        let release = () => {};
        try {
            await screen.pressByTestIdAsync('openAbout');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(DRAFT.name));
            const pending = new Promise<void>(resolve => { release = resolve; });
            harness.answer(serverId, '/v1/artifacts/22222222-2222-4222-8222-222222222234', { status: 503, body: {}, respondAfter: pending });
            dimensions.mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
            await screen.update(React.createElement(Card));
            expect(screen.findByTestId('resizeAbout.about.loading')).toBeNull();
            expect(screen.getTextContent()).toContain(DRAFT.name);
            dimensions.mockReturnValue({ width: 1440, height: 1000, scale: 1, fontScale: 1 });
            await screen.update(React.createElement(Card));
            expect(screen.findByTestId('resizeAbout.about.loading')).toBeNull();
            expect(screen.getTextContent()).toContain(DRAFT.name);
        } finally { release(); dimensions.mockRestore(); await screen.unmount(); }
    });

    it('dismisses About on a phone while loading, after an unavailable read, and for a resolved widget', async () => {
        const serverId = await addDefinitionHome();
        const React = await import('react');
        const native = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useWidgetDefinitionFlows } = await import('./useWidgetDefinitionFlows');
        const dimensions = vi.spyOn(native, 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        let respond = () => {};
        const pending = new Promise<void>(resolve => { respond = resolve; });
        harness.answer(serverId, '/v1/artifacts/missing-widget', { status: 404, body: { error: 'not_found' }, respondAfter: pending });
        function Card({ builtin = false }: { builtin?: boolean }) {
            const flows = useWidgetDefinitionFlows({ instance: { v: 1, id: 'copy', definition: builtin
                ? { kind: 'builtin', id: 'changes' } : { kind: 'artifact', artifactId: 'missing-widget' }, bindings: {} },
                scope: { serverId, accountId: ACCOUNT_ID, owner: { kind: 'home' } }, anchorRef: React.useRef(null), testID: 'phoneAbout' });
            return React.createElement(native.View, {}, React.createElement(native.Pressable, { testID: 'openAbout', onPress: flows.about }), flows.panel);
        }
        const screen = await renderScreen(React.createElement(Card));
        try {
            await screen.pressByTestIdAsync('openAbout');
            await vi.waitFor(() => expect(screen.findByTestId('phoneAbout.about.loading')).not.toBeNull());
            await screen.pressByTestIdAsync('phoneAbout.about.close');
            expect(screen.findByTestId('phoneAbout.about')).toBeNull();
            await act(async () => { respond(); });
            await screen.pressByTestIdAsync('openAbout');
            await vi.waitFor(() => expect(screen.findByTestId('phoneAbout.about.loading')).toBeNull());
            await screen.pressByTestIdAsync('phoneAbout.about.close');
            expect(screen.findByTestId('phoneAbout.about')).toBeNull();
            await screen.update(React.createElement(Card, { builtin: true }));
            await screen.pressByTestIdAsync('openAbout');
            await screen.pressByTestIdAsync('phoneAbout.about.close');
            expect(screen.findByTestId('phoneAbout.about')).toBeNull();
        } finally { respond(); dimensions.mockRestore(); await screen.unmount(); }
    });

    it('opens Save as your widget with an inert preview and discloses a converted pinned Session read', async () => {
        const serverId = await addDefinitionHome();
        const disconnect = await applyDefinitionHomeConnection();
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionWidgetHost } = await import('@/components/sessions/board/SessionWidgetHost');
        const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
        const { SaveAsWidgetPanel } = await import('./SaveAsWidgetPanel');
        const { SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
        const { WidgetSurface } = await import('../surface/WidgetSurface');
        const { SessionBoardDeclarativeContent } = await import('@/components/sessions/board/SessionBoardDeclarativeContent');
        const account = { serverId, accountId: ACCOUNT_ID };
        const previous = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        const session = createSessionFixture({ id: 'shared', serverId, encryptionMode: 'plain' });
        storage.getState().applySessions([session]);
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Session checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'shared-copy', definition: { kind: 'inline', definition: { v: 1, id: 'shared-definition',
                ...DRAFT, name: 'Session checks', inputs: { fields: [{ path: 'session', title: 'Read Session', widget: 'json' }] },
                inputSchema: { type: 'object', properties: { session: { type: 'object' } }, additionalProperties: false }, sessionInputPath: 'session',
                provenance: { source: { kind: 'session', serverId, sessionId: 'shared', itemId: 'shared-copy' } } } },
                bindings: { session: { kind: 'value', value: { serverId, sessionId: 'shared' } } } } } });
        const screen = await renderScreen(React.createElement(SessionWidgetHost, { serverId, sessionId: 'shared', session,
            item: { itemId: 'shared-copy', revision: 'r1', state: { kind: 'ready', item } }, host: 'details', primaryHost: 'details', density: 'full',
            canEdit: true, executableCurrentness: 'current', heightBounds: { min: 96, max: 520 }, testID: 'sessionCopy' }),
            { createNodeMock: element => ({ testID: element.props.testID ?? null }) });
        try {
            const save = screen.tree.root.findAllByType(ItemRowActions).flatMap(menu => menu.props.actions)
                .find((action: { id: string }) => action.id === 'saveAsYours');
            expect(save, screen.getTextContent()).toBeDefined();
            const onPress = save?.onPress;
            if (!onPress) throw new Error('Missing Save as yours widget action handler');
            await act(async () => { onPress(); });
            // Every flow a Session card opens (Save as your widget, About, Add to, Post a snapshot) opens on its own card, the one
            // anchor Post a snapshot already uses, so it never lands on a sibling or off the pane from a ⋯ measured elsewhere.
            const { WidgetFlowShell } = await import('@/components/widgets/flow/WidgetFlowShell');
            expect(screen.tree.root.findByType(WidgetFlowShell).props.anchorRef.current).toEqual({ testID: 'sessionCopy-card-region' });
            const panel = screen.tree.root.findByType(SaveAsWidgetPanel);
            expect(panel.props.converted).toEqual([{ path: 'session', title: 'Read Session', becomes: 'context' }]);
            const preview = screen.findByTestId('sessionCopy.save.preview');
            expect(preview).not.toBeNull();
            expect(preview!.findAllByType(WidgetSurface)).toHaveLength(0);
            await vi.waitFor(() => { expect(preview!.findAll(node => node.props.children === 'Checks').length).toBeGreaterThan(0); });
            expect(preview!.findByType(SessionBoardDeclarativeContent).props).toMatchObject({ snapshot: true, actionBinding: null });
            expect(harness.requests.some(request => request.path === '/v1/artifacts' && request.input)).toBe(false);
        } finally { await act(async () => { screen.tree.unmount(); }); await disconnect(); storage.setState(previous); }
    });

    it('describes an installed read from the admitted target projection and removes execution facts when admission is denied', async () => {
        const { readWidgetAboutSources } = await import('./WidgetAboutPanel');
        const { readWidgetDescriptor } = await import('../widgetCatalog');
        const { widgetProjectionOf, widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const source = { pluginId: 'acme.checks', localId: 'checks' };
        const ambientResource = { pluginId: source.pluginId, localId: 'ambient-count' };
        const boundResource = { pluginId: source.pluginId, localId: 'bound-count' };
        const ambient = widgetProjectionOf([{ ...source, target: 'app', resources: [ambientResource] }], {
            [source.pluginId]: widgetInstalledPackage(source.pluginId, 'Ambient source A'),
        });
        const bound = widgetProjectionOf([{ ...source, target: 'app', resources: [boundResource] }], {
            [source.pluginId]: widgetInstalledPackage(source.pluginId, 'Admitted source B'),
        });
        const descriptor = readWidgetDescriptor(ambient, { kind: 'installed', surface: source });
        const runtime = { pluginUiProjection: bound, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
            machineId: 'machine-b', serverId: 'home', platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' as const },
            reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} };
        expect(readWidgetAboutSources({ definition: null, descriptor, resolution: { status: 'ready', runtime, target: { kind: 'app' }, input: {} } }))
            .toEqual([{ key: 'acme.checks/bound-count', plugin: 'Admitted source B', machine: null, usesViewerConnection: false, read: 'Bound count', identity: 'acme.checks/bound-count' }]);
        expect(readWidgetAboutSources({ definition: null, descriptor, resolution: { status: 'denied', reasonCode: 'widget_session_access_denied' } })
            .every(source => source.machine === null && !source.usesViewerConnection)).toBe(true);
    });

    it.each(['hostedHtml', 'builtin'] as const)('keeps the saved %s copy on its original Home while a refused link is retried after switching Homes', async kind => {
        const serverId = await addDefinitionHome(true);
        if (kind === 'builtin') await harness.requireUiApproval(serverId, 'widgets.definition.saveFromSession');
        const disconnect = kind === 'builtin' ? await applyDefinitionHomeConnection() : null;
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { SessionVisualCopyPanel } = await import('@/components/sessions/board/SessionVisualCopyPanel');
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
        const { artifactHtmlBundleFromBodyV1 } = await import('@happier-dev/protocol/artifacts/artifactHtmlV1');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { tryWriteServerEnabledBitInPlace} = await import('@happier-dev/protocol/features/serverEnabledBit');
        const React = await import('react');
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'sharing.public', true)) throw new Error('Missing public feature');
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        harness.answer(serverId, 'GET /v1/public-shares', { body: { publicShares: [] } });
        harness.answer(serverId, 'GET /v1/public-shares?subjectKind=artifact', { body: { publicShares: [] } });
        harness.answer(serverId, 'POST /v1/public-shares', { status: 503, body: { error: 'public_share_failed' } });
        harness.artifacts(serverId).afterNextCreate(async () => {
            const artifactId = harness.artifacts(serverId).list()[0]!.id;
            harness.answer(serverId, `GET /v1/public-shares?subjectKind=artifact&subjectId=${artifactId}`, { body: { publicShares: [] } });
        });
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, destination: 'transcript', title: 'Saved copy', frame: 'card',
            height: { mode: 'auto', fallback: 'regular' }, source: kind === 'hostedHtml'
                ? { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Copy</p>') }
                : { kind: 'widget', instance: { v: 1, id: 'html', definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: {} } } });
        if (kind === 'builtin') {
            const { SessionSystemRecordStoredSchema} = await import('@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes');
            const { createSessionSystemRecordHttpFixture } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
            const { projectSessionAccessCapabilitiesV1 } = await import('@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1');
            const fixture = createSessionSystemRecordHttpFixture({ sessionId: 'source', effectiveAccess: { v: 1, level: 'owner',
                sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
                records: [SessionSystemRecordStoredSchema.parse({
                    id: 'source-record', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'html' },
                    content: { t: 'plain', v: item }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                    createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
                })] });
            for (const path of ['/v2/sessions/source', '/v2/sessions/source?accessProjectionVersion=1',
                '/v2/sessions/source/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout',
                '/v2/sessions/source/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=html']) {
                harness.answer(serverId, `GET ${path}`, { body: await (await fixture.request(`https://definitions-home.example${path}`)).json() });
            }
            const { SessionReadBatchResponseV1Schema } = await import('@happier-dev/protocol/sessions/read/sessionReadBatchV1');
            const detail: unknown = await (await fixture.request('https://definitions-home.example/v2/sessions/source?accessProjectionVersion=1')).json();
            harness.answer(serverId, 'POST /v2/sessions/read-batch', { body: SessionReadBatchResponseV1Schema.parse({
                results: [{ sessionId: 'source', detail: { status: 200, body: detail } }],
            }) });
        }
        let screen = await renderScreen(React.createElement(SessionVisualCopyPanel, { account: { serverId, accountId: ACCOUNT_ID },
            sessionId: 'source', itemId: 'html', item, share: true, onClose: () => {}, testID: 'copyHandoff' }));
        try {
            await screen.pressByTestIdAsync('copyHandoff.save');
            if (kind === 'builtin') {
                const { ApprovalRequestV2Schema} = await import('@happier-dev/protocol/approvals/approvalRequestV1');
                const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
                const { DocumentShareSheet } = await import('@/components/sharing/documents/DocumentShareSheet');
                await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
                const approvalId = harness.artifacts(serverId).list()[0]!.id;
                const request = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(approvalId)!));
                expect(request).toMatchObject({ actionId: 'widgets.definition.saveFromSession', actionArgs: {
                    account: { serverId, accountId: ACCOUNT_ID }, session: { serverId, sessionId: 'source' }, itemId: 'html',
                } });
                const decision = await decideApprovalAsInbox(serverId, approvalId, 'approve');
                expect(decision, JSON.stringify({ approval: harness.artifacts(serverId).readPlainBody(approvalId),
                    requests: harness.requests.map(request => request.path) }))
                    .toMatchObject({ ok: true, result: { status: 'executed' } });
                // Sharing the newly saved definition is the existing explicit share-sheet entry,
                // after approval custody completes; the pending copy panel does not auto-share.
                const saved = harness.artifacts(serverId).list().find(row => row.id !== approvalId)!;
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
                const read = await createDefaultActionExecutor().execute('widgets.definition.get', {
                    account: { serverId, accountId: ACCOUNT_ID }, artifactId: saved.id,
                }, { serverId, surface: 'ui', authority: 'present_user' });
                expect(read).toMatchObject({ ok: true });
                if (!read.ok) throw new Error('The saved builtin definition must remain readable');
                const outputSchema = getActionSpec('widgets.definition.get').outputSchema;
                if (!outputSchema) throw new Error('Expected the widget definition read output schema');
                expect(outputSchema.parse(read.result)).toMatchObject({
                    definition: { body: { kind: 'builtin', id: 'usage_period_summary' } },
                });
                await screen.unmount();
                screen = await renderScreen(React.createElement(DocumentShareSheet, { artifactId: saved.id,
                    kind: 'widget-definition.v1', scope: { serverId, accountId: ACCOUNT_ID }, testID: 'copyHandoff.share' }));
            }
            await vi.waitFor(() => expect(screen.findByTestId('copyHandoff.share:document-share-public-link'),
                `${screen.getTextContent()} ${JSON.stringify(harness.requests.map(request => request.path))}`).not.toBeNull());
            const artifactId = harness.artifacts(serverId).list().at(-1)!.id;
            harness.answer(serverId, `GET /v1/public-shares?subjectKind=artifact&subjectId=${artifactId}`, { body: { publicShares: [] } });
            await screen.pressByTestIdAsync('copyHandoff.share:document-share-public-link');
            await vi.waitFor(() => expect(screen.findByTestId('session-public-link-create'), screen.getTextContent()).not.toBeNull());
            await screen.pressByTestIdAsync('session-public-link-create');
            await screen.pressByTestIdAsync('session-public-link-options-cancel');
            expect(harness.requestsFor('/v1/public-shares').filter(request => request.input)).toHaveLength(0);
            const createdArtifacts = kind === 'builtin' ? 2 : 1;
            expect(harness.requestsFor('/v1/artifacts').filter(request => request.input)).toHaveLength(createdArtifacts);
            expect(harness.artifacts(serverId).list()).toHaveLength(createdArtifacts);
            const foreignHome = await harness.addHome({ name: 'Foreign Home', serverUrl: 'https://foreign-home.example', accountId: 'account-b' });
            storage.setState({ profileScope: { serverId: foreignHome, accountId: 'account-b' }, settingsScope: { serverId: foreignHome, accountId: 'account-b' } });
            await vi.waitFor(() => expect(screen.findByTestId('session-public-link-create')).not.toBeNull());
            await screen.pressByTestIdAsync('session-public-link-create');
            await screen.pressByTestIdAsync('session-public-link-options-create');
            await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
            await screen.pressByTestIdAsync('session-public-link-options-create');
            await vi.waitFor(() => expect(harness.requestsFor('/v1/public-shares').filter(request => request.input)).toHaveLength(2));
            expect(harness.requestsFor('/v1/artifacts').filter(request => request.input)).toHaveLength(createdArtifacts);
            expect(harness.requestsFor('/v1/public-shares').every(request => request.serverId === serverId)).toBe(true);
            expect(harness.artifacts(serverId).list()).toHaveLength(createdArtifacts);
            expect(harness.artifacts(foreignHome).list()).toHaveLength(0);
        } finally { await screen.unmount(); await disconnect?.(); }
    });

    it('lets a reader explicitly save an inline HTML visual as an independent HTML Artifact before sharing', async () => {
        const serverId = await addDefinitionHome();
        const disconnect = await applyDefinitionHomeConnection();
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionWidgetHost } = await import('@/components/sessions/board/SessionWidgetHost');
        const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
        const { SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
        const { artifactHtmlBundleFromBodyV1, ARTIFACT_HTML_BUNDLE_MIME_V1 } = await import('@happier-dev/protocol/artifacts/artifactHtmlV1');
        const { decodePlainArtifactStoredContent} = await import('@happier-dev/protocol/storage/artifactStoredContent');
        // This copy needs no workspace; avoid giving its fixture an unrelated Project identity.
        const session = createSessionFixture({ id: 'shared-html', serverId, encryptionMode: 'plain', metadata: null });
        storage.getState().applySessions([session]);
        const bundle = artifactHtmlBundleFromBodyV1('<p>Original HTML</p>');
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, destination: 'transcript', title: 'Original HTML', frame: 'card',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'hostedHtml', source: bundle,
                requestedCapabilities: { networkOrigins: ['https://api.example.com'] } } });
        const screen = await renderScreen(React.createElement(SessionWidgetHost, { serverId, sessionId: session.id, session,
            item: { itemId: 'html', revision: 'r1', state: { kind: 'ready', item } }, host: 'inlineTranscript', primaryHost: null,
            density: 'compact', canEdit: false, executableCurrentness: 'current', heightBounds: { min: 96, max: 520 }, testID: 'htmlCopy' }));
        try {
            const actions = screen.tree.root.findAllByType(ItemRowActions).flatMap(menu => menu.props.actions);
            const save = actions.find((action: { id: string }) => action.id === 'saveArtifact');
            expect(save).toBeDefined();
            expect(actions.find((action: { id: string }) => action.id === 'shareVisual')).toBeDefined();
            const saveArtifact = save?.onPress;
            if (typeof saveArtifact !== 'function') throw new Error('Save Artifact must expose its explicit action');
            await act(async () => { saveArtifact(); });
            expect(harness.requests.some(request => request.path === '/v1/artifacts' && request.input)).toBe(false);
            await screen.pressByTestIdAsync('htmlCopy.copy.save');
            await vi.waitFor(() => expect(harness.requests.some(request => request.path === '/v1/artifacts' && request.input)).toBe(true));
            const created = harness.requests.find(request => request.path === '/v1/artifacts' && request.input)!;
            const payload = created.input as { id: string; header: string; body: string };
            expect(decodePlainArtifactStoredContent(payload.header)).toMatchObject({ kind: 'html', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 });
            const body = decodePlainArtifactStoredContent(payload.body) as { body: string };
            expect(JSON.parse(body.body)).toEqual({ ...bundle, requestedCapabilities: item.source.kind === 'hostedHtml' ? item.source.requestedCapabilities : null });
            expect(harness.requests.some(request => request.path.startsWith('/v1/public-shares') && request.input)).toBe(false);
            expect(payload.id).not.toBe('html');
        } finally { await act(async () => { screen.tree.unmount(); }); await disconnect(); }
    });
});
