import type { HomeHubLayoutValue } from '@happier-dev/protocol/home';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1, SessionCurrentProjectionRecordV1Schema, SessionListQueryResponseV1Schema, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installSettingsViewCommonModuleMocks({ storage: (importOriginal) => importOriginal() });
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
const { EntityFlatReorderList } = await import('@/components/ui/treeDragDrop/ui/EntityFlatReorder');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useHomeHubArtifactLayout } = await import('./useHomeHubArtifactLayout');
const { useHomeHubLayout } = await import('./useHomeHubLayout');
const { buildHomeWidgetAddSections } = await import('@/components/widgets/add/HomeWidgetAddPopover');
const { runWidgetSetupCommand } = await import('@/components/widgets/surface/widgetSurfaceSetup');
const { useWidgetFrameRename } = await import('@/components/widgets/frame/useWidgetFrameRename');
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
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-size-header.test', accountId: 'account-a', request: artifact.request });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope, artifacts: { ...storage.getState().artifacts,
            [definition.id]: { id: definition.id, ownerAccountId: scope.accountId, isDecrypted: true, title: definition.name,
                rawHeader: buildWidgetDefinitionArtifactHeaderV1(definition), headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
        let layout: ReturnType<typeof useHomeHubLayout> | undefined;
        function Probe() { layout = useHomeHubLayout(); return null; }
        await renderScreen(<AccountShell><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        expect(layout!.sections.find(section => section.id === 'copy')).toMatchObject({ size: sizeDeclaration.defaultSize });
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
        // Hiding a group would remove its widgets, so it has no switch; it still moves by its grip.
        expect(screen.findByTestId('home-layout.g')).not.toBeNull();
        expect(screen.findByTestId('home-layout.g.grip')).not.toBeNull();
        expect(screen.findByTestId('home-layout.g.shown')).toBeNull();
        // One owner for a group's name, width and ⋯: its bar on the page, never a second copy in this list.
        expect(screen.findByTestId('home-layout.g.groupMenu')).toBeNull();
        expect(screen.root.findAll(node => node.props.testIDPrefix === 'home-layout.g.group.width')).toHaveLength(0);
        expect(artifact.writes).toHaveLength(0);
    });
    it('rejects failed Customize writes through the real queue and keeps mounted recovery available', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, items: [], order: ['setup'], hidden: ['setup'] });
        let failWrite = true;
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-customize-write.test', accountId: 'account-a', request: async (url, init) => {
            if (failWrite && init?.method === 'POST' && new URL(String(url)).pathname.startsWith('/v1/artifacts')) return Response.json({ error: 'forbidden' }, { status: 403 });
            return artifact.request(url, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'account-a' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        let layout: ReturnType<typeof useHomeHubLayout> | undefined;
        function Probe() { layout = useHomeHubLayout(); return null; }
        const screen = await renderScreen(<AccountShell><HomeLayoutEditor presentation="popover" /><Probe /></AccountShell>);
        await flushHookEffects({ cycles: 3 });
        await act(async () => { await expect(layout!.reset()).rejects.toBeInstanceOf(Error); });
        expect(artifact.layout()).toMatchObject({ order: ['setup'], hidden: ['setup'] });
        expect(screen.findByTestId('home-layout.save-error')).not.toBeNull();
        await act(async () => { await expect(layout!.setHidden('setup', false)).rejects.toBeInstanceOf(Error); });
        expect(artifact.layout().hidden).toEqual(['setup']);
        await screen.pressByTestIdAsync('home-layout.reset');
        expect(layout!.status).toBe('error');
        expect(screen.findByTestId('home-layout.retry')).not.toBeNull();
        failWrite = false;
        await screen.pressByTestIdAsync('home-layout.retry');
        expect(artifact.layout()).toMatchObject({ order: [], hidden: [] });
        expect(layout!.status).toBe('ready');
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
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-setup-write.test', accountId: 'account-a', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            requestedPaths.push(path);
            // The native Session input admits both exact-record access and membership
            // in the real Sessions options source before the Artifact write.
            if (path === '/v2/sessions/query') return Response.json(SessionListQueryResponseV1Schema.parse({
                sessions: [...wireSessions.values()].map(session => ({ ...session, viewer: {
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
        } });
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
        expect(list().props.initialOrganizing).toBe(true);
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
        await act(async () => { await list().props.binding.execute(effect.effect); });
        await flushHookEffects({ cycles: 3 });
        expect(artifact.layout().order.indexOf('setup')).toBeLessThan(artifact.layout().order.indexOf('start'));
        expect(list().props.binding.resolve('gone', { anchorId: 'start', placement: 'before' }).status).toBe('refused');
        await act(async () => storage.setState({ profileScope: null }));
        expect(list().props.binding.getItem('setup')).toBeNull();
        expect(list().props.binding.resolve('setup', { anchorId: 'start', placement: 'before' }).status).toBe('refused');
    });
});
