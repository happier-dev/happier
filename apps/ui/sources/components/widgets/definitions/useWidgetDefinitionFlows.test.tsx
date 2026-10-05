import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel: the harness
// installs its network boundaries with `vi.doMock`, which only reaches modules imported afterwards.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { WidgetAddSection } from '../add/widgetAddModel';

/**
 * About this widget and Duplicate run the canonical `widgets.definition.*` Actions over the Home's
 * real Account Artifact store; only the network and the credential store are replaced.
 */
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
const { BoardWidgetAddPopover } = await import('../add/BoardWidgetAddPopover');

const ACCOUNT_ID = 'account-a';

async function addDefinitionHome(): Promise<string> {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://definitions-home.example', accountId: ACCOUNT_ID });
    harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    harness.answer(serverId, '/v1/account/encryption/currentness', {
        body: { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 },
    });
    return serverId;
}

const DRAFT = {
    name: 'Checks on main',
    body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } },
    inputs: { fields: [{ path: 'repo', title: 'Repository', widget: 'text' }] },
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, additionalProperties: false },
} as const;

describe('widget definition flows', () => {
    beforeEach(async () => { await harness.reset(); });
    afterEach(() => { standardCleanup(); });

    it('discovers setup metadata through the list Action without opening definition bodies', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        await executor.execute('widgets.definition.create', { account, artifactId: 'checks-definition', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' });
        const listed = await executor.execute('widgets.definition.list', { account }, { serverId, surface: 'ui', authority: 'present_user' });
        expect(listed).toMatchObject({ ok: true, result: { definitions: [{ artifactId: 'checks-definition', name: DRAFT.name,
            inputs: DRAFT.inputs, inputSchema: DRAFT.inputSchema, bodyKind: 'declarative' }] } });
    });

    it('offers saved widgets on a shared Board and submits an admitted inline copy to real approval custody', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { projectSessionBoard } = await import('@/sync/domains/session/board');
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useSessionBoardController } = await import('@/components/sessions/board/useSessionBoardController');
        const { createSessionBoardActionsPort } = await import('@/sync/domains/session/board/sessionBoardActionsPort');
        const { WidgetAddPopover } = await import('../add/WidgetAddPopover');
        const account = { serverId, accountId: ACCOUNT_ID };
        const surface = { ...account, owner: { kind: 'sessionBoard', sessionId: 'shared' } } as const;
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        const session = createSessionFixture({ id: 'shared', serverId, encryptionMode: 'plain' });
        storage.getState().applySessions([session]);
        try {
            const executor = createDefaultActionExecutor();
            expect(await executor.execute('widgets.definition.create', { account, artifactId: 'checks-definition', definition: DRAFT },
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
                const sections = (): readonly WidgetAddSection[] => screen.tree.root.findByType(WidgetAddPopover).props.sections;
                await vi.waitFor(() => { expect(sections().find(section => section.id === 'yours')?.entries[0]?.title).toBe(DRAFT.name); });
                expect(sections().find(section => section.id === 'plugins')?.entries).toHaveLength(0);
                const entry = sections().find(section => section.id === 'yours')!.entries[0]!;
                const before = new Set(harness.artifacts(serverId).list().map(row => row.id));
                const setup = entry.setup!();
                expect(await setup.submit({ bindings: { repo: { kind: 'value', value: 'main' } } })).toEqual({ ok: true, approvalPending: true });
                const approvals = harness.artifacts(serverId).list().filter(row => !before.has(row.id));
                expect(approvals).toHaveLength(1);
                const approval = JSON.parse(harness.artifacts(serverId).readPlainBody(approvals[0]!.id)!);
                expect(approval).toMatchObject({ actionId: 'widgets.instance.add', actionArgs: { surface, placement: { tabId: 'overview' },
                    instance: { definition: { kind: 'inline', definition: { id: 'checks-definition', name: DRAFT.name } }, bindings: { repo: { kind: 'value', value: 'main' } } } } });
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
        } finally { storage.setState(previousScopes); }
    });

    it('keeps authored gallery fields when the installed contribution declares different fields', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        const created = await executor.execute('widgets.definition.create', { account, artifactId: 'checks-definition',
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
        const { useYourWidgetCandidates } = await import('./useYourWidgetCandidates');
        function Gallery() {
            const candidates = useYourWidgetCandidates(account, projection);
            return React.createElement(Text, {}, candidates.map(candidate => `${candidate.title}:${candidate.inputs?.fields.map(field => field.path).join(',')}:${candidate.target}`).join('|'));
        }
        const screen = await renderScreen(React.createElement(Gallery));
        try { await vi.waitFor(() => { expect(screen.getTextContent()).toContain(`${DRAFT.name}:repo:app`); }); }
        finally { await act(async () => { screen.tree.unmount(); }); }
    });

    it('keeps the Gallery empty before its Account scope is available', async () => {
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useYourWidgetCandidates } = await import('./useYourWidgetCandidates');
        function Gallery() {
            const candidates = useYourWidgetCandidates(null, null);
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
            const sections = useAccountWidgetAddSections({ scope: { ...account, owner: { kind: 'home' } }, instances: [],
                addInstance: async () => {}, labels: { count: String, submit: 'Add', fromPluginsHint: '' }, testID: 'gallery' });
            return React.createElement(View, {}, demand ? sections.find(section => section.id === 'yours')?.entries[0]?.renderPreview?.() : null);
        }
        try {
            expect(await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId: 'checks-definition',
                definition: { ...DRAFT, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } } },
                { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
            const before = harness.requests.length;
            const screen = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, {
                value: { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                    machineId: 'machine-1', serverId, platform: 'web', clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }, children: React.createElement(Gallery),
            }));
            try {
                await vi.waitFor(() => { expect(harness.requests.slice(before).some(request => request.path.startsWith('/v1/artifacts?'))).toBe(true); });
                expect(harness.requests.slice(before).some(request => request.path === '/v1/artifacts/checks-definition')).toBe(false);
                await act(async () => { demandPreview(true); });
                // Selecting a Home is not an applied Sync runtime. The real mount must exist,
                // fail closed at that boundary, and never turn discovery into a body fetch.
                await vi.waitFor(() => { expect(screen.tree.root.findByType(UnavailableInstalledWidget).props.unresolved)
                    .toEqual({ state: 'unavailable', reasonCode: 'widget_scope_unavailable' }); });
                expect(harness.requests.slice(before).some(request => request.path === '/v1/artifacts/checks-definition')).toBe(false);
            } finally { await act(async () => { screen.tree.unmount(); }); }
        } finally { storage.setState(previousScopes); }
    });

    it('withdraws the previous Account gallery while the next Account inventory is pending', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const account = { serverId, accountId: ACCOUNT_ID };
        await createDefaultActionExecutor().execute('widgets.definition.create', { account, artifactId: 'checks-definition', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' });
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useYourWidgetCandidates } = await import('./useYourWidgetCandidates');
        let changeAccount: React.Dispatch<React.SetStateAction<typeof account>> = () => {};
        function Gallery() {
            const [selected, setSelected] = React.useState(account);
            changeAccount = setSelected;
            const candidates = useYourWidgetCandidates(selected, null);
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
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        const { storage } = await import('@/sync/domains/state/storage');
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        await executor.execute('widgets.definition.create', { account, artifactId: 'checks-definition', definition: DRAFT },
            { serverId, surface: 'ui', authority: 'present_user' });
        const React = await import('react');
        const { Text } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { useWidgetInstanceDescriptor } = await import('../surface/useWidgetInstanceDescriptor');
        function Frame() {
            const descriptor = useWidgetInstanceDescriptor(account, { v: 1, id: 'copy',
                definition: { kind: 'artifact', artifactId: 'checks-definition' }, bindings: {} }, null);
            return React.createElement(Text, { testID: 'definition-name' }, descriptor?.title ?? 'unavailable');
        }
        const screen = await renderScreen(React.createElement(Frame));
        const { act } = await import('react-test-renderer');
        try {
            await vi.waitFor(() => { expect(screen.getTextContent()).toContain(DRAFT.name); });
            await act(async () => { expect(await executor.execute('widgets.definition.update', { account, artifactId: 'checks-definition', patch: { name: 'Updated checks' } },
                { serverId, surface: 'ui', authority: 'present_user', bypassApprovals: true })).toMatchObject({ ok: true, result: { definition: { name: 'Updated checks' } } }); });
            await vi.waitFor(() => { expect(screen.getTextContent()).toContain('Updated checks'); });
        } finally { await act(async () => { screen.tree.unmount(); }); storage.setState(previousScopes); }
    });

    it.each(['companion', 'area'] as const)('names the retained %s frame and its setup controls from the saved header without opening its body', async (placement) => {
        const serverId = await addDefinitionHome();
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
        const { SessionCompanionItemFrame } = await import('@/components/sessions/companion/SessionCompanionItemFrame');
        const { PluginGlance } = await import('@/components/sessions/companion/glances/PluginGlance');
        const { WidgetArea } = await import('@/components/widgets/area/WidgetArea');
        const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
        const { WidgetSurfaceReadV1Schema } = await import('@happier-dev/protocol/widgets');
        const projection = widgetProjectionOf([{ pluginId: 'com.acme.checks', localId: 'checks', title: 'Installed checks' }], {
            'com.acme.checks': widgetInstalledPackage('com.acme.checks', 'Checks'),
        });
        const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'checks-definition' }, bindings: {} } as const;
        const surface = { ...account, owner: { kind: 'pluginArea', pluginId: 'com.acme.checks', pageId: 'overview', area: 'pinned' } } as const;
        const layout = WidgetSurfaceReadV1Schema.parse({ surface, instances: [{ instance, width: 'half' }], canEdit: true });
        // The plugin-page Host API is the external boundary; metadata comes from real Account storage.
        const port = { execute: async () => ({ ok: true as const, result: layout }) };
        const executor = createDefaultActionExecutor();
        try {
            expect(await executor.execute('widgets.definition.create', { account, artifactId: 'checks-definition',
                definition: { ...DRAFT, body: { kind: 'installed', surface: { pluginId: 'com.acme.checks', localId: 'checks' } } } },
                { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
            const before = harness.requests.length;
            const frame = placement === 'companion'
                ? React.createElement(SessionCompanionItemFrame, { label: 'Installed checks', testID: 'card', actions: [],
                    instanceControls: { instance, scope: { ...account, owner: { kind: 'companion', sessionId: 'session-a' } }, context: {},
                        setInputs: async () => ({ ok: true as const }), rename: () => {} },
                    children: (accessory, instanceView) => React.createElement(PluginGlance, { instance, sessionId: 'session-a',
                        session: createSessionFixture({ id: 'session-a', serverId }), serverId, frameStyle: 'card', menu: accessory,
                        instanceView, measurementOnly: true, testID: 'saved-frame' }),
                })
                : React.createElement(WidgetArea, { port, context: {}, geometry: 'grid', title: 'Pinned widgets',
                    surfaceName: 'Checks', testID: 'saved-area' });
            const screen = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, {
                value: { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                    machineId: 'machine-1', serverId, platform: 'web', clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} },
                children: React.createElement(DestinationInstanceHost, { tabId: 'retained', ref: { kind: 'plugins', params: {} },
                    pathname: '/plugins', focused: false, visible: true, children: frame }),
            }));
            try {
                await vi.waitFor(() => { expect(screen.getTextContent()).toContain(DRAFT.name); });
                const menu = screen.tree.root.findByType(ItemRowActions);
                expect(menu.props.title).toBe(DRAFT.name);
                expect(menu.props.actions.some((action: { id: string }) => action.id === 'editInputs')).toBe(true);
                expect(harness.requests.slice(before).some(request => request.path === '/v1/artifacts/checks-definition')).toBe(false);
            } finally { await act(async () => { screen.tree.unmount(); }); }
        } finally { storage.setState(previousScopes); }
    });

    it('describes placements in already opened WorkBoards without opening unrelated Board records', async () => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const account = { serverId, accountId: ACCOUNT_ID };
        const previousScopes = { profileScope: storage.getState().profileScope, settingsScope: storage.getState().settingsScope };
        storage.setState({ profileScope: account, settingsScope: account });
        try {
            const executor = createDefaultActionExecutor();
            const context = { serverId, surface: 'ui', authority: 'present_user' } as const;
            expect(await executor.execute('widgets.definition.create', { account, artifactId: 'checks-definition', definition: DRAFT }, context)).toMatchObject({ ok: true });
            expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: 'board-a', name: 'Checks board' } } }, context)).toMatchObject({ ok: true });
            const ref = { surface: { ...account, owner: { kind: 'workBoard', boardId: 'board-a' } }, instanceId: 'copy-a' } as const;
            const instance = { v: 1, id: 'copy-a', definition: { kind: 'artifact', artifactId: 'checks-definition' }, bindings: {} } as const;
            expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'board-a', ref, instance } }, context)).toMatchObject({ ok: true });
            const before = harness.requests.length;
            const opened = await executor.execute('widgets.definition.get', { account, artifactId: 'checks-definition' }, context);
            expect(opened).toMatchObject({ ok: true, result: { placementSummary: { placements: expect.arrayContaining([ref]), unavailableScopes: expect.arrayContaining(['workBoard']) } } });
            expect(harness.requests.slice(before).some(request => request.path.includes('/v1/artifacts/board-a'))).toBe(false);
        } finally { storage.setState(previousScopes); }
    });

    it.each(['home', 'companion'] as const)('opens About from %s through the real definition read, edits this copy only, and duplicates into an independent definition', async (placement) => {
        const serverId = await addDefinitionHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const account = { serverId, accountId: ACCOUNT_ID };
        const created = await executor.execute('widgets.definition.create', { account, artifactId: 'checks-definition', definition: DRAFT },
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
                    instance: { v: 1, id: 'copy-a', definition: { kind: 'artifact', artifactId: 'checks-definition' }, bindings: {} },
                    scope: { ...account, owner: { kind: 'companion', sessionId: 'session-a' } }, context: {},
                    setInputs: async () => ({ ok: true as const }), rename: () => {},
                }, children: (accessory: React.ReactNode) => accessory,
            });
            const flows = useWidgetDefinitionFlows({
                instance: { v: 1, id: 'copy-a', definition: { kind: 'artifact', artifactId: 'checks-definition' }, bindings: {} },
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
            const original = await executor.execute('widgets.definition.get', { account, artifactId: 'checks-definition' }, { serverId, surface: 'ui', authority: 'present_user' });
            expect(original).toMatchObject({ ok: true, result: { definition: { name: 'Checks on main' } } });
        } finally {
            await act(async () => { screen.tree.unmount(); });
        }
    });
});
