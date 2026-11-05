import { HomeHubLayoutV1Schema, type HomeHubLayoutValue } from '@happier-dev/protocol/home';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1, SessionCurrentProjectionRecordV1Schema, SessionListQueryResponseV1Schema, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { createHomeHubArtifactHttpBoundary, createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

installSettingsViewCommonModuleMocks({ storage: 'real' });
installDisconnectedServerSocketBoundary();
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

const { storage } = await import('@/sync/domains/state/storageStore');
const { HomeLayoutEditor } = await import('./HomeLayoutEditor');
const { EntityFlatReorderList, EntityFlatReorderRow } = await import('@/components/ui/treeDragDrop/ui/EntityFlatReorder');
const { Switch } = await import('@/components/ui/forms/Switch');
const { EntityDragGripChooser } = await import('@/components/ui/treeDragDrop/ui/EntityDragGripChooser');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useHomeHubArtifactLayout } = await import('./useHomeHubArtifactLayout');
const { useHomeHubLayout } = await import('./useHomeHubLayout');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { buildHomeWidgetAddSections } = await import('@/components/widgets/add/HomeWidgetAddPopover');
const { runWidgetSetupCommand } = await import('@/components/widgets/surface/widgetSurfaceSetup');
const { useWidgetFrameRename, WidgetFrameNameField } = await import('@/components/widgets/frame/useWidgetFrameRename');
const { readWidgetDescriptor } = await import('@/components/widgets/widgetCatalog');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const initial = storage.getState();
let restoreGlobals: (() => void) | undefined;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;
function AccountShell({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={connection!.credentials}>
        <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: connection!.home.id, platform: 'web',
            accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
            {children}
        </AppShellPluginUiProjectionValueProvider>
    </InjectedAuthProvider>;
}
beforeEach(async () => { restoreGlobals = withPopoverWebGlobals(); await loadSyncSingletonForTests(); });
afterEach(async () => {
    standardCleanup();
    retirePresentationNotice();
    restoreGlobals?.();
    await connection?.dispose();
    connection = undefined;
    restoreActionLoader?.();
    storage.setState({ profileScope: initial.profileScope, settings: initial.settings, artifacts: initial.artifacts });
});

/** Every placed copy in the acknowledged Home layout (widget items, and group children). */
function storedInstances(artifact: Readonly<{ layout(): { items?: HomeHubLayoutValue['items'] } }>) {
    return (artifact.layout().items ?? []).flatMap(item => item.kind === 'widget' ? [item.instance] : item.children.map(child => child.instance));
}

describe('Home Customize entity reorder binding', () => {
    it.each([false, true])('round-trips every mixed Home section through the mounted Move chooser (concurrent add: %s)', async concurrentAdd => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        const vitals = (id: string, machineId: string) => ({ kind: 'widget' as const, size: 'small' as const,
            instance: { v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'machine_vitals' as const },
                bindings: { machine: { kind: 'value' as const, value: { serverId: 'machine-home', machineId } } } } });
        const group = (id: string) => ({ kind: 'group' as const, id, width: 'full' as const, frameStyle: 'card' as const,
            dividers: 'hairline' as const, children: [vitals(`${id}-child`, 'offline-machine')] });
        const before = HomeHubLayoutV1Schema.parse({ v: 1,
            order: ['attention', 'first-vitals', 'unavailable-widget', 'start', 'first-group', 'moving-group', 'automations', 'setup', 'last-vitals'],
            hidden: [], items: [vitals('first-vitals', 'online-machine'),
                { kind: 'widget', instance: { v: 1, id: 'unavailable-widget',
                    definition: { kind: 'artifact', artifactId: 'unavailable-definition' }, bindings: {} } },
                group('first-group'), group('moving-group'), vitals('last-vitals', 'offline-machine')] });
        artifact.seed(before);
        let raced = false;
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-chooser-preservation.test', accountId: 'account-a', request: async (url, init) => {
            if (concurrentAdd && !raced && init?.method === 'POST' && new URL(String(url)).pathname === `/v1/artifacts/${artifact.artifactId}`) {
                raced = true;
                // A second client's write wins after this Action's read. The real HTTP
                // boundary advances its CAS, so the chooser must replay on that winner.
                const wire: unknown = JSON.parse(String(init.body));
                if (!wire || typeof wire !== 'object') throw new Error('Expected an Artifact write');
                const competing = { ...before, order: [...before.order, 'concurrent-vitals'],
                    items: [...before.items, vitals('concurrent-vitals', 'offline-machine')] };
                const response = await artifact.request(url, { ...init, body: JSON.stringify({ ...wire,
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(competing) }) }) });
                expect(await response.json()).toMatchObject({ success: true });
            }
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        const screen = await renderScreen(<AccountShell><HomeLayoutEditor presentation="popover" /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        const list = () => screen.root.findByType(EntityFlatReorderList);
        expect(list().props.binding.items.map((item: { id: string }) => item.id)).toEqual(before.order);
        const grip = screen.findByTestId('home-layout.moving-group.grip')!;
        // The real chooser is above its trigger, rather than a consumer-created reorder effect.
        let chooser = grip.parent;
        while (chooser && chooser.type !== EntityDragGripChooser) chooser = chooser.parent;
        if (!chooser) throw new Error('Expected the section grip to belong to the Move chooser');
        const mountedChooser = chooser;
        await act(async () => { mountedChooser.props.onOpenChange(true); });
        const { t } = await import('@/text');
        const chooserProps: Pick<React.ComponentProps<typeof EntityDragGripChooser>, 'sections' | 'onSelect'> = {
            sections: mountedChooser.props.sections, onSelect: mountedChooser.props.onSelect,
        };
        const option = chooserProps.sections.flatMap(section => section.options)
            .find(entry => entry.label === t('entityDragDrop.preview.moveAbove', { target: t('settingsOverview.homeStartSection') }));
        if (!option || option.disabled) throw new Error('Expected Move above Start a session to be available');
        await act(async () => { chooserProps.onSelect(option.id); });
        await flushHookEffects({ cycles: 3 });
        const after = HomeHubLayoutV1Schema.parse(artifact.layout());
        expect(artifact.writes).toHaveLength(concurrentAdd ? 2 : 1);
        expect(after.order).toEqual(['attention', 'first-vitals', 'unavailable-widget', 'moving-group', 'start', 'first-group', 'automations', 'setup', 'last-vitals',
            ...(concurrentAdd ? ['concurrent-vitals'] : [])]);
        expect(new Map(after.items.map(item => [item.kind === 'group' ? item.id : item.instance.id, item])))
            .toEqual(new Map([...before.items, ...(concurrentAdd ? [vitals('concurrent-vitals', 'offline-machine')] : [])]
                .map(item => [item.kind === 'group' ? item.id : item.instance.id, item])));
        expect(after.hidden).toEqual(before.hidden);
        expect(list().props.binding.items.map((item: { id: string }) => item.id)).toEqual(after.order);
    });
    it.each([{ kind: 'group', pending: false }, { kind: 'widget', pending: false },
        { kind: 'group', pending: true }, { kind: 'widget', pending: true }] as const)
    ('explains a cold Home failure from the $kind frame rename and retains its draft (pending: $pending)', async ({ kind, pending }) => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'session_summary' as const }, bindings: {} };
        artifact.seed({ v: 1, items: kind === 'group'
            ? [{ kind: 'group', id: 'g', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance }] }]
            : [{ kind: 'widget', instance }], order: [], hidden: [] });
        let unreachable = false;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: `https://home-frame-${kind}.test`, accountId: 'account-a', request: async (url, init) => {
            if (unreachable && new URL(String(url)).pathname === '/v2/account/settings') {
                if (pending) await held;
                else throw new TypeError('Failed to fetch');
            }
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        let rename: ReturnType<typeof useWidgetFrameRename> | undefined;
        let write: Promise<void> | undefined;
        function Probe() {
            const layout = useHomeHubLayout();
            rename = useWidgetFrameRename({ title: 'Checks', testID: 'frame', serverId: scope.serverId,
                onRename: next => write = layout.rename('copy', next) });
            return kind === 'group' ? <WidgetFrameNameField value="" placeholder="Name" accessibilityLabel="Group name"
                testID="frame-title-input" serverId={scope.serverId} onRename={next => write = layout.rename('g', next)} /> : rename.field;
        }
        const screen = await renderScreen(<AccountShell><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        if (kind === 'widget') await act(async () => { rename!.begin!(); });
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { accountSettingsScopeKeySuffix } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        getPersistenceStorage().delete(`account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`);
        storage.setState({ settingsScope: null });
        expect(loadAccountSettings(scope).version).toBeNull();
        unreachable = true;
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert');
        const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousApplied = runtime.getAppliedActiveServerSnapshot();
        const previousAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
        const previousHealth = storage.getState();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        runtime.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ endpointStatus: 'online', endpointReason: null, socketStatus: 'connected', syncError: null });
        try {
        await act(async () => { screen.findByTestId('frame-title-input')!.props.onChangeText('Unsaved checks'); });
        await act(async () => { screen.findByTestId('frame-title-input')!.props.onSubmitEditing(); });
        const { t } = await import('@/text');
        if (pending) {
            await act(async () => { storage.setState({ endpointStatus: 'connecting', socketStatus: 'connecting', syncError: null }); });
            expect(screen.findByTestId('frame-title-input')!.props.accessibilityState).toMatchObject({ busy: true });
            expect(screen.findByTestId('home-unreachable')).toBeNull();
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(screen.findByTestId('home-unreachable')).not.toBeNull();
            expect(screen.findByTestId('frame-title-input')!.props.accessibilityState).toMatchObject({ busy: false });
            expect(screen.findByTestId('frame-title-input')!.props.editable).toBe(false);
            expect(screen.findByTestId('frame-title-input')!.props.value).toBe('Unsaved checks');
            expect(artifact.writes).toHaveLength(0);
            await act(async () => { storage.setState({ endpointStatus: 'online' }); release(); await write; });
            expect(artifact.writes).toHaveLength(1);
            expect(alert).not.toHaveBeenCalled();
            return;
        }
        expect(alert).toHaveBeenCalledWith(t('common.error'), t('settingsPlugins.targetSelection.unreachableThisHome'));
        expect(artifact.writes).toHaveLength(0);
        expect(screen.findByTestId('frame-title-input')!.props.value).toBe('Unsaved checks');
        expect(screen.findByTestId('frame-title-input')!.props.editable).toBe(true);
        } finally {
            release(); await write?.catch(() => {}); alert.mockRestore();
            storage.setState({ endpointStatus: previousHealth.endpointStatus, endpointReason: previousHealth.endpointReason,
                socketStatus: previousHealth.socketStatus, syncError: previousHealth.syncError });
            runtime.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
    it.each([
        { sizes: ['wide'], defaultSize: 'wide' },
        { sizes: ['medium', 'tall'], defaultSize: 'tall' },
    ])('projects an authored cached header default before grid and body sizing without writing saved placement: $defaultSize', async (sizeDeclaration) => {
        const { buildWidgetDefinitionArtifactHeaderV1, WidgetDefinitionV1Schema } = await import('@happier-dev/protocol/widgets');
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'authored-wide', name: 'Wide checks',
            provenance: { authorAccountId: 'account-a', source: { kind: 'authored' } },
            sizeDeclaration,
            inputs: { fields: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } } });
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [{ kind: 'widget', instance: { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: definition.id }, bindings: {} } }], order: [], hidden: [] });
        const definitionArtifact = createLayoutArtifactHttpBoundary('account-a', { artifactId: definition.id, kind: 'widget-definition.v1',
            defaultLayout: definition, parseLayout: value => WidgetDefinitionV1Schema.parse(value), buildHeader: buildWidgetDefinitionArtifactHeaderV1 });
        definitionArtifact.seed(definition);
        let definitionBodyReads = 0;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-size-header.test', accountId: 'account-a', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/artifacts' && (!init?.method || init.method === 'GET')) {
                // A complete census must include the retained definition; omission means deletion to the real sync owner.
                const homeRows: unknown = await (await artifact.request(url, init)).json();
                const definitionRows: unknown = await (await definitionArtifact.request(url, init)).json();
                if (!Array.isArray(homeRows) || !Array.isArray(definitionRows)) throw new Error('Expected Artifact inventory arrays');
                return Response.json([...homeRows, ...definitionRows]);
            }
            if (path === `/v1/artifacts/${definition.id}`) {
                definitionBodyReads += 1;
                return definitionArtifact.request(url, init);
            }
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope, artifacts: { ...storage.getState().artifacts,
            [definition.id]: { id: definition.id, ownerAccountId: scope.accountId, isDecrypted: true, title: definition.name,
                rawHeader: buildWidgetDefinitionArtifactHeaderV1(definition), headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
        let layout: ReturnType<typeof useHomeHubLayout> | undefined;
        function Probe() { layout = useHomeHubLayout(); return null; }
        await renderScreen(<AccountShell><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        expect(layout!.sections.find(section => section.id === 'copy')).toMatchObject({ size: sizeDeclaration.defaultSize });
        expect(definitionBodyReads).toBe(0);
        expect(artifact.writes).toHaveLength(0);
        expect(artifact.layout().sections).toBeUndefined();
    });
    it('lists a group as one row to reorder: no show switch, and its options stay with its bar on Home', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        const child = (id: string, displayName: string) => ({ v: 1 as const, id, displayName, definition: { kind: 'builtin' as const, id: 'session_summary' as const }, bindings: {} });
        artifact.seed({ v: 1, order: [], hidden: [], items: [{ kind: 'group', id: 'g', width: 'full', frameStyle: 'card', dividers: 'hairline',
            children: [{ kind: 'widget', instance: child('wide-one', 'Daily usage'), size: 'wide' }, { kind: 'widget', instance: child('small-one', 'Checks'), size: 'small' }] }] });
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-customize-group.test', accountId: 'account-a', request: artifact.request });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        const screen = await renderScreen(<AccountShell><HomeLayoutEditor presentation="popover" /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        // Groups have the same reversible visibility switch as standalone widgets.
        expect(screen.findByTestId('home-layout.g')).not.toBeNull();
        expect(screen.findByTestId('home-layout.g.grip')).not.toBeNull();
        expect(screen.findByTestId('home-layout.g.shown')!.props.value).toBe(true);
        // One owner for a group's name, width and ⋯: its bar on the page, never a second copy in this list.
        expect(screen.findByTestId('home-layout.g.groupMenu')).toBeNull();
        expect(screen.root.findAll(node => node.props.testIDPrefix === 'home-layout.g.group.width')).toHaveLength(0);
        expect(artifact.writes).toHaveLength(0);
    });
    it('tells apart the groups placed from one saved group, and only those', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        const child = (id: string) => ({ v: 1 as const, id, displayName: 'Daily usage', definition: { kind: 'builtin' as const, id: 'session_summary' as const }, bindings: {} });
        const group = (id: string, title: string) => ({ kind: 'group' as const, id, title, width: 'full' as const, frameStyle: 'card' as const, dividers: 'hairline' as const,
            children: [{ kind: 'widget' as const, instance: child(`${id}-child`) }] });
        artifact.seed({ v: 1, order: [], hidden: [], items: [group('g1', 'Capacity copy'), group('g2', 'Capacity copy'), group('g3', 'Release room')] });
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-customize-copies.test', accountId: 'account-a', request: artifact.request });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        const screen = await renderScreen(<AccountShell><HomeLayoutEditor presentation="popover" /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        const subtitle = (id: string) => screen.root.findAll(node => node.props.testID === `home-layout.${id}` && 'subtitle' in node.props)[0]?.props.subtitle;
        expect(subtitle('g1')).toBe('widgetFrame.groupCopyOf(count=1,index=1,total=2)');
        expect(subtitle('g2')).toBe('widgetFrame.groupCopyOf(count=1,index=2,total=2)');
        expect(subtitle('g3')).toBe('widgetFrame.groupCount(count=1)');
        // The staged dock, chooser and grip labels name the target by the same copy-aware label (H25).
        const titles = new Map<string, string>(screen.root.findByType(EntityFlatReorderList).props.binding.items
            .map((item: { id: string; title: string }) => [item.id, item.title]));
        expect(titles.get('g1')).toMatch(/groupNameCopyOf.*index=1/);
        expect(titles.get('g2')).toMatch(/groupNameCopyOf.*index=2/);
        expect(titles.get('g3')).toBe('Release room');
    });
    it.each([false, true])('shares a pending visibility intent across Sections remounts and Appearance until settlement (refused: %s, H18)', async refused => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: [], hidden: ['setup'] });
        await import('@/sync/syncEngine');
        let hold = false;
        let attempts = 0;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-switch-pending.test', accountId: 'account-a', request: async (url, init) => {
            if (hold && init?.method === 'POST' && new URL(String(url)).pathname === `/v1/artifacts/${artifact.artifactId}`) {
                attempts++;
                await held;
                if (refused) return Response.json({ error: 'artifact_access_forbidden' }, { status: 403 });
            }
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        const editors = (sectionsOpen: boolean) => <AccountShell>
            {sectionsOpen ? <HomeLayoutEditor key="sections" presentation="popover" /> : null}
            <HomeLayoutEditor key="appearance" />
        </AccountShell>;
        const screen = await renderScreen(editors(true));
        await flushHookEffects({ cycles: 3 });
        const rows = () => screen.root.findAllByType(EntityFlatReorderRow).filter(row => row.props.id === 'setup');
        const states = () => rows().map(row => [row.findByType(Switch).props.value, row.props.pending]);
        expect(states()).toEqual([[false, false], [false, false]]);
        hold = true;
        try {
            await act(async () => { rows()[0]!.findByType(Switch).props.onValueChange?.(true); });
            expect(states()).toEqual([[true, true], [true, true]]);
            expect(artifact.writes).toHaveLength(0);
            await act(async () => { screen.update(editors(false)); });
            expect(states()).toEqual([[true, true]]);
            await act(async () => { screen.update(editors(true)); });
            expect(states()).toEqual([[true, true], [true, true]]);
            // Both newly mounted and existing observers must suppress duplicate writes.
            await act(async () => { for (const row of rows()) row.findByType(Switch).props.onValueChange?.(false); });
            expect(states()).toEqual([[true, true], [true, true]]);
            await act(async () => { release(); });
            await flushHookEffects({ cycles: 3 });
            expect(attempts).toBe(1);
            expect(artifact.writes).toHaveLength(refused ? 0 : 1);
            expect(artifact.layout().hidden.includes('setup')).toBe(refused);
            expect(states()).toEqual([[!refused, false], [!refused, false]]);
            if (refused) expect(screen.findByTestId('home-layout.save-error')).not.toBeNull();
        } finally { await act(async () => { release(); }); }
    });
    it('names an unreachable Home when a preparatory read prevents a Customize write', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: ['setup'], hidden: ['setup'] });
        let unreachable = false;
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-customize-unreachable.test', accountId: 'account-a', request: async (url, init) => {
            if (unreachable && new URL(String(url)).pathname === '/v2/account/settings') throw new TypeError('Failed to fetch');
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        let layout: ReturnType<typeof useHomeHubLayout> | undefined;
        function Probe() { layout = useHomeHubLayout(); return <HomeLayoutEditor presentation="popover" />; }
        const screen = await renderScreen(<AccountShell><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        // Both mounted and device-persisted Settings are real warm read sources.
        // Retire only this test Account's fake MMKV entry to exercise a cold read.
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { accountSettingsScopeKeySuffix } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        getPersistenceStorage().delete(`account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`);
        storage.setState({ settingsScope: null });
        expect(loadAccountSettings(scope).version).toBeNull();
        unreachable = true;
        await act(async () => { await expect(layout!.reset()).rejects.toBeInstanceOf(Error); });
        const { t } = await import('@/text');
        expect(screen.getTextContent()).toContain(t('settingsPlugins.targetSelection.unreachableThisHome'));
        expect(artifact.writes).toHaveLength(0);
        expect(artifact.layout()).toMatchObject({ order: ['setup'], hidden: ['setup'] });
    });
    it('persists a group title through the real Action and exposes a refused rename without acknowledging it', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [{ kind: 'group', id: 'g', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget',
            instance: { v: 1, id: 'child', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }] }], order: [], hidden: [] });
        let failWrite = false;
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-group-title.test', accountId: 'account-a', request: async (url, init) => {
            if (failWrite && init?.method === 'POST' && new URL(String(url)).pathname.startsWith('/v1/artifacts')) return Response.json({ error: 'forbidden' }, { status: 403 });
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        let layout: ReturnType<typeof useHomeHubLayout> | undefined;
        function Probe() {
            layout = useHomeHubLayout();
            const group = layout.items.find(item => item.kind === 'group' && item.id === 'g');
            return <WidgetFrameNameField value={group?.kind === 'group' ? group.title ?? '' : ''}
                placeholder="Name" accessibilityLabel="Group name" testID="group-name" onRename={next => layout!.rename('g', next)} />;
        }
        const screen = await renderScreen(<AccountShell><HomeLayoutEditor presentation="popover" /><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        await act(async () => { screen.findByTestId('group-name')!.props.onChangeText('Release room'); });
        await act(async () => { screen.findByTestId('group-name')!.props.onSubmitEditing(); });
        expect(artifact.layout().items).toMatchObject([{ kind: 'group', id: 'g', title: 'Release room' }]);
        await act(async () => { await layout!.retry(); });
        expect(layout!.items).toMatchObject([{ kind: 'group', id: 'g', title: 'Release room' }]);
        failWrite = true;
        await act(async () => { screen.findByTestId('group-name')!.props.onChangeText('Unsaved room'); });
        await act(async () => { screen.findByTestId('group-name')!.props.onSubmitEditing(); });
        expect(screen.findByTestId('home-layout.save-error')).not.toBeNull();
        expect(layout!.status).toBe('error');
        expect(artifact.layout().items).toMatchObject([{ kind: 'group', id: 'g', title: 'Release room' }]);
        expect(screen.findByTestId('group-name')!.props.value).toBe('Unsaved room');
    });
    it('keeps failed Home setup and input edits unsaved through the real Action queue, then retries them', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        const instance = { v: 1 as const, id: 'existing', definition: { kind: 'builtin' as const, id: 'session_summary' as const }, bindings: {} };
        artifact.seed({ v: 1, items: [{ kind: 'widget', instance }], order: [], hidden: [] });
        let failWrite = true;
        let rejectedWrites = 0;
        const requestedPaths: string[] = [];
        const wireSessions = new Map(['session-1', 'session-2'].map(id => {
            const session = createSessionFixture({ id });
            return [id, SessionCurrentProjectionRecordV1Schema.parse({
                ...session, metadataLayoutVersion: 1,
                metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: session.metadata!, agentState: session.agentState })),
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1,
                    workspace: { path: session.metadata!.path, host: session.metadata!.host, machineId: session.metadata!.machineId } })),
                effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
                responsibleAccountId: null, responsibleAccount: null, share: null,
                archivedAt: null, agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
            })] as const;
        }));
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-setup-write.test', accountId: 'account-a', request: createSessionReadBatchFetchBoundary(async (url, init) => {
            const path = new URL(String(url)).pathname;
            requestedPaths.push(path);
            // The native Session input admits both exact-record access and membership
            // in the real Sessions options source before the Artifact write.
            if (path === '/v2/sessions/query') return Response.json(SessionListQueryResponseV1Schema.parse({
                sessions: [...wireSessions.values()].map(session => ({ ...session, viewer: {
                    latestFailureSeq: null,
                    readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
                    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                    follow: { follows: false, notificationLevel: null, includeInVoice: false },
                    notification: { level: 'important', source: 'owner' },
                } })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            }));
            if (path === '/v2/sessions/session-1' || path === '/v2/sessions/session-2') {
                return Response.json({ session: wireSessions.get(path.split('/').at(-1)!) });
            }
            if (failWrite && init?.method === 'POST' && path.startsWith('/v1/artifacts')) {
                rejectedWrites += 1;
                return Response.json({ error: 'forbidden' }, { status: 403 });
            }
            return artifact.request(url, init);
        }) });
        const scope = { serverId: connection.home.id, accountId: 'account-a', owner: { kind: 'home' as const } };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        let layout: ReturnType<typeof useHomeHubLayout> | undefined;
        let rename: ReturnType<typeof useWidgetFrameRename> | undefined;
        function Probe() {
            layout = useHomeHubLayout();
            rename = useWidgetFrameRename({ title: 'Summary', testID: 'write.rename', onRename: next => layout!.rename(instance.id, next) });
            return rename.field;
        }
        const screen = await renderScreen(<AccountShell><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        const definition = { kind: 'builtin' as const, id: 'agent_plan' as const };
        const { sync } = await import('@/sync/sync');
        await expect(sync.withSessionSystemRecordRuntime({ serverId: scope.serverId, sessionId: 'session-1' },
            async runtime => ({ canRead: runtime.session.access?.capabilities.readTranscript, current: runtime.isCurrent() })))
            .resolves.toEqual({ status: 'ok', value: { canRead: true, current: true } });
        const candidate = readWidgetDescriptor(null, definition)!;
        const setup = buildHomeWidgetAddSections({ candidates: [candidate], instances: [instance], addInstance: layout!.addInstance, scope })[0]!.entries[0]!.setup!();
        const draft = { bindings: { session: { kind: 'value' as const, value: { serverId: scope.serverId, sessionId: 'session-1' } } } };
        await act(async () => { await expect(setup.submit(draft)).resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' }); });
        expect(rejectedWrites, JSON.stringify({ errorCode: layout!.errorCode, requestedPaths })).toBeGreaterThan(0);
        expect(layout!.status).toBe('error');
        expect(layout!.canCancelFailedIntent).toBe(true);
        expect(artifact.writes).toHaveLength(0);
        expect(storedInstances(artifact)).toEqual([instance]);
        failWrite = false;
        await act(async () => { await layout!.retry(); });
        const added = storedInstances(artifact).find(copy => copy.id !== instance.id)!;
        expect(added).toMatchObject({ definition, bindings: draft.bindings });
        expect(layout!.status).toBe('ready');
        failWrite = true;
        const updatedBindings = { session: { kind: 'value' as const, value: { serverId: scope.serverId, sessionId: 'session-2' } } };
        await act(async () => { await expect(runWidgetSetupCommand(() => layout!.setInputs(added.id, updatedBindings), 'saveFailed')).resolves.toEqual({ ok: false, message: 'saveFailed' }); });
        expect(storedInstances(artifact).find(copy => copy.id === added.id)!.bindings).toEqual(draft.bindings);
        expect(layout!.canCancelFailedIntent).toBe(true);
        failWrite = false;
        await act(async () => { await layout!.retry(); });
        expect(storedInstances(artifact).find(copy => copy.id === added.id)!.bindings).toEqual(updatedBindings);
        expect(layout!.status).toBe('ready');
        failWrite = true;
        await act(async () => { rename!.begin!(); });
        await act(async () => { screen.findByTestId('write.rename-title-input')!.props.onChangeText('My summary'); });
        await act(async () => { screen.findByTestId('write.rename-title-input')!.props.onSubmitEditing(); });
        expect(screen.findByTestId('write.rename-title-input')).not.toBeNull();
        expect(screen.findByTestId('write.rename-title-input')!.props.value).toBe('My summary');
        expect(storedInstances(artifact).find(copy => copy.id === instance.id)!.displayName).toBeUndefined();
        failWrite = false;
        await act(async () => { screen.findByTestId('write.rename-title-input')!.props.onSubmitEditing(); });
        expect(screen.findByTestId('write.rename-title-input')).toBeNull();
        expect(storedInstances(artifact).find(copy => copy.id === instance.id)!.displayName).toBe('My summary');
    });
    it.each(['retry', 'cancel'] as const)('keeps a rejected drag available for mounted %s recovery', async recovery => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: [], hidden: [] });
        let failWrite = true;
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-editor-retry.test', accountId: 'account-a', request: async (url, init) => {
            if (failWrite && init?.method === 'POST' && new URL(String(url)).pathname.startsWith('/v1/artifacts')) return Response.json({ error: 'forbidden' }, { status: 403 });
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        let projection: ReturnType<typeof useHomeHubArtifactLayout> | undefined;
        function Probe() { projection = useHomeHubArtifactLayout(); return null; }
        const screen = await renderScreen(<AccountShell><HomeLayoutEditor /><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        const list = () => screen.root.findByType(EntityFlatReorderList);
        const admission = list().props.binding.resolve('setup', { anchorId: 'start', placement: 'before' });
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') throw new Error('Expected the layout move to be admitted');
        let outcome: unknown;
        await act(async () => { outcome = await list().props.binding.execute(admission.effect); });
        expect(outcome).not.toMatchObject({ status: 'applied' });
        expect(projection).toMatchObject({ status: 'error', failedIntent: { kind: 'move_to', sectionId: 'setup', position: { anchorId: 'start', placement: 'before' } } });
        expect(artifact.writes).toHaveLength(0);
        failWrite = false;
        await screen.pressByTestIdAsync(`home-layout.${recovery}`);
        expect(projection).toMatchObject({ status: 'ready' });
        expect(projection!.failedIntent).toBeUndefined();
        if (recovery === 'retry') {
            expect(list().props.binding.items[0].id).toBe('setup');
            expect(artifact.layout().order[0]).toBe('setup');
        } else {
            expect(artifact.writes).toHaveLength(0);
            await act(async () => { await projection!.retry(); });
            expect(artifact.writes).toHaveLength(0);
            expect(artifact.layout().order).toEqual([]);
        }
    });
    it('uses current Account sections and semantic anchors while Customize starts in Organize', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: [], hidden: ['setup'] });
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-editor.test', accountId: 'account-a', request: artifact.request });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        const screen = await renderScreen(<AccountShell><HomeLayoutEditor /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        const list = () => screen.root.findByType(EntityFlatReorderList);
        expect(list().props.alwaysOrganizing).toBe(true);
        const binding = list().props.binding;
        expect(binding.getItem('setup')).toEqual({ kind: 'home-section', scope, sectionId: 'setup' });
        expect(binding.resolve('setup', { anchorId: 'start', placement: 'before' })).toMatchObject({ status: 'allowed', effect: { actionId: 'home.hub.layout.update', input: { intent: { kind: 'move_to', sectionId: 'setup', position: { anchorId: 'start', placement: 'before' } } } } });
        expect(binding.resolve('start', { anchorId: 'attention', placement: 'before' }).status).toBe('refused');
        // Hidden builtins remain customizable; current admission follows their current order.
        expect(list().props.binding.items.find((item: { id: string }) => item.id === 'setup')).toBeTruthy();
        await act(async () => {
            screen.findByTestId('home-layout.setup.shown')!.props.onValueChange(true);
        });
        await flushHookEffects({ cycles: 3 });
        expect(artifact.layout().hidden).not.toContain('setup');
        const effect = list().props.binding.resolve('setup', { anchorId: 'start', placement: 'before' });
        expect(effect.status).toBe('allowed');
        if (effect.status !== 'allowed') throw new Error('Expected the layout move to be admitted');
        const projectMove = list().props.binding.projectMove;
        if (!projectMove) throw new Error('Expected the Home layout placement owner to be bound');
        const projectedOrder = projectMove('setup', { anchorId: 'start', placement: 'before' });
        await act(async () => { await list().props.binding.execute(effect.effect); });
        await flushHookEffects({ cycles: 3 });
        expect(list().props.binding.items.map((item: { id: string }) => item.id)).toEqual(projectedOrder);
        expect(artifact.layout().order.indexOf('setup')).toBeLessThan(artifact.layout().order.indexOf('start'));
        // Acknowledged writes do not leave the mounted editor on the first Artifact revision.
        for (const [sectionId, anchorId] of [['start', 'setup'], ['attention', 'start']] as const) {
            const next = list().props.binding.resolve(sectionId, { anchorId, placement: 'before' });
            if (next.status !== 'allowed') throw new Error(`Expected the next ${sectionId} move to be admitted`);
            await act(async () => { expect(await list().props.binding.execute(next.effect)).toEqual({ status: 'applied' }); });
            await flushHookEffects({ cycles: 3 });
            const stored = HomeHubLayoutV1Schema.parse(artifact.layout());
            expect(stored.order.indexOf(sectionId)).toBeLessThan(stored.order.indexOf(anchorId));
            expect(list().props.binding.items.map((item: { id: string }) => item.id).slice(0, 3))
                .toEqual(stored.order.slice(0, 3));
        }
        expect(list().props.binding.resolve('gone', { anchorId: 'start', placement: 'before' }).status).toBe('refused');
        await act(async () => storage.setState({ profileScope: null }));
        expect(list().props.binding.getItem('setup')).toBeNull();
        expect(list().props.binding.resolve('setup', { anchorId: 'start', placement: 'before' }).status).toBe('refused');
    });
});
