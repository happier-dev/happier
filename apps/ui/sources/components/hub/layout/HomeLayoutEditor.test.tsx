import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

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
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const initial = storage.getState();
let restoreGlobals: (() => void) | undefined;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;
function AccountShell({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={connection!.credentials}>
        <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: connection!.home.id, platform: 'web',
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
            {children}
        </AppShellPluginUiProjectionValueProvider>
    </InjectedAuthProvider>;
}
beforeEach(() => { restoreGlobals = withPopoverWebGlobals(); });
afterEach(async () => {
    standardCleanup();
    restoreGlobals?.();
    await connection?.dispose();
    connection = undefined;
    restoreActionLoader?.();
    storage.setState({ profileScope: initial.profileScope, settings: initial.settings });
});

describe('Home Customize entity reorder binding', () => {
    it('rejects failed Customize writes through the real queue and keeps mounted recovery available', async () => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, instances: [], order: ['setup'], hidden: ['setup'] });
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
        artifact.seed({ v: 1, instances: [instance], order: [], hidden: [] });
        let failWrite = true;
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-setup-write.test', accountId: 'account-a', request: async (url, init) => {
            if (failWrite && init?.method === 'POST' && new URL(String(url)).pathname.startsWith('/v1/artifacts')) return Response.json({ error: 'forbidden' }, { status: 403 });
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
        const candidate = { key: 'builtin:agent_plan', definition: { kind: 'builtin' as const, id: 'agent_plan' as const }, title: 'Plan', pluginName: 'Happier', sharedPluginName: false, icon: 'list-checks' as const, homeDefault: 'available' as const, target: 'session' as const,
            inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true }] } };
        const setup = buildHomeWidgetAddSections({ candidates: [candidate], instances: [instance], addInstance: layout!.addInstance, scope })[0]!.entries[0]!.setup!();
        const draft = { bindings: { session: { kind: 'value' as const, value: { serverId: scope.serverId, sessionId: 'session-1' } } } };
        await act(async () => { await expect(setup.submit(draft)).resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' }); });
        expect(layout!.status).toBe('error');
        expect(layout!.canCancelFailedIntent).toBe(true);
        expect(artifact.writes).toHaveLength(0);
        expect(artifact.layout().instances).toEqual([instance]);
        failWrite = false;
        await act(async () => { await layout!.retry(); });
        const added = artifact.layout().instances.find(copy => copy.id !== instance.id)!;
        expect(added).toMatchObject({ definition: candidate.definition, bindings: draft.bindings });
        expect(layout!.status).toBe('ready');
        failWrite = true;
        const updatedBindings = { session: { kind: 'value' as const, value: { serverId: scope.serverId, sessionId: 'session-2' } } };
        await act(async () => { await expect(runWidgetSetupCommand(() => layout!.setInputs(added.id, updatedBindings), 'saveFailed')).resolves.toEqual({ ok: false, message: 'saveFailed' }); });
        expect(artifact.layout().instances.find(copy => copy.id === added.id)!.bindings).toEqual(draft.bindings);
        expect(layout!.canCancelFailedIntent).toBe(true);
        failWrite = false;
        await act(async () => { await layout!.retry(); });
        expect(artifact.layout().instances.find(copy => copy.id === added.id)!.bindings).toEqual(updatedBindings);
        expect(layout!.status).toBe('ready');
        failWrite = true;
        await act(async () => { rename!.begin!(); });
        await act(async () => { screen.findByTestId('write.rename-title-input')!.props.onChangeText('My summary'); });
        await act(async () => { screen.findByTestId('write.rename-title-input')!.props.onSubmitEditing(); });
        expect(screen.findByTestId('write.rename-title-input')).not.toBeNull();
        expect(screen.findByTestId('write.rename-title-input')!.props.value).toBe('My summary');
        expect(artifact.layout().instances.find(copy => copy.id === instance.id)!.displayName).toBeUndefined();
        failWrite = false;
        await act(async () => { screen.findByTestId('write.rename-title-input')!.props.onSubmitEditing(); });
        expect(screen.findByTestId('write.rename-title-input')).toBeNull();
        expect(artifact.layout().instances.find(copy => copy.id === instance.id)!.displayName).toBe('My summary');
    });
    it.each(['retry', 'cancel'] as const)('keeps a rejected drag available for mounted %s recovery', async recovery => {
        const artifact = createHomeHubArtifactHttpBoundary('account-a');
        artifact.seed({ v: 1, instances: [], order: [], hidden: [] });
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
        artifact.seed({ v: 1, instances: [], order: [], hidden: ['setup'] });
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
