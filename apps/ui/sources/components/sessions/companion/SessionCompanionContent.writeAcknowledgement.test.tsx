import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { SessionCompanionAddBinding } from './picker/SessionCompanionAddControl';
import type { SessionCompanionInstanceControls } from './SessionCompanionItemFrame';
import { resolveWidgetSizeChoicesV1, WidgetSizeDeclarationV1Schema } from '@happier-dev/protocol/widgets';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

installSettingsViewCommonModuleMocks({ storage: 'real' });
installDisconnectedServerSocketBoundary();

const { storage } = await import('@/sync/domains/state/storageStore');
const { SessionCompanionContent } = await import('./SessionCompanionContent');
const { SessionCompanionScreen } = await import('./SessionCompanionScreen');
const { SessionHeaderActionMenu } = await import('@/components/sessions/actions/SessionHeaderActionMenu');
const { SessionCompanionRevealPortProvider } = await import('./presentation/SessionCompanionRevealPort');
const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
const { SessionCompanionAddControl } = await import('./picker/SessionCompanionAddControl');
const { useSessionCompanionController } = await import('./state/useSessionCompanionController');
const { SessionCompanionPresentationBridge } = await import('./presentation/SessionCompanionPresentationBridge');
const { registerSessionPresentationOnlyTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { Modal } = await import('@/modal');
const { buildCompanionWidgetAddSections } = await import('@/components/widgets/add/widgetAddSections');
const initial = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreGlobals: (() => void) | undefined;
let restoreSyncLoader: (() => void) | undefined;

afterEach(async () => {
    standardCleanup();
    retirePresentationNotice();
    restoreGlobals?.();
    await connection?.dispose();
    restoreSyncLoader?.();
    connection = undefined;
    storage.setState({ profileScope: initial.profileScope, settings: initial.settings, localSettings: initial.localSettings });
});

function PresentationOwner({ serverId, sessionId }: { serverId: string; sessionId: string }) {
    const applierRef = React.useRef<React.ComponentProps<typeof SessionCompanionPresentationBridge>['applierRef']['current']>(null);
    React.useEffect(() => registerSessionPresentationOnlyTarget({ serverId, sessionId }, {
        isCurrent: () => true,
        applySessionPresentationIntent: (intent, observer) => applierRef.current?.(intent, observer) ?? { status: 'unavailable' },
    }), [serverId, sessionId]);
    return <SessionCompanionPresentationBridge sessionId={sessionId} serverId={serverId} applierRef={applierRef}
        openBoard={() => ({ status: 'unavailable' })} revealBoardItem={() => ({ status: 'unavailable' })}
        returnToChat={() => ({ status: 'unchanged' })} openFullSurface={() => ({ status: 'unchanged' })} />;
}

function HeaderActions() {
    return <>{usePublishedPaneHeaderContent('companion')?.action}</>;
}

// These control tests mount no Board body or primary host.
const unmountedBoardProps = { resolvePrimaryHost: () => null };

function httpBoundary() {
    const boundary = createHomeHubArtifactHttpBoundary('account-a');
    const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'session-1' });
    return { ...boundary, request: createSessionReadBatchFetchBoundary(async (input, init) =>
        new URL(String(input)).pathname === '/v2/sessions/session-1'
            ? Response.json({ session }) : boundary.request(input, init)) };
}

async function setActionEnabled(boundary: ReturnType<typeof httpBoundary>, enabled: boolean,
    actionId: 'widgets.item.rename' | 'session.presentation.apply' = 'widgets.item.rename') {
    const current = storage.getState();
    const scope = current.settingsScope;
    if (!scope) throw new Error('Expected mounted Account settings scope');
    const settings = { ...current.settings,
        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled } } }),
    };
    const previous = await (await boundary.request('https://companion-policy.test/v2/account/settings')).json() as { version: number };
    const update = await (await boundary.request('https://companion-policy.test/v2/account/settings', {
        method: 'POST', body: JSON.stringify({ expectedVersion: previous.version, content: { t: 'plain', v: settings } }),
    })).json() as { success: boolean; version: number };
    expect(update.success).toBe(true);
    await act(async () => current.applySettingsForScope(scope, settings, update.version));
}

describe('Companion widget write acknowledgement', () => {
    it('rejects a disabled rename from the mounted personal-copy control before writing its preference', async () => {
        restoreGlobals = withPopoverWebGlobals();
        const boundary = httpBoundary();
        restoreSyncLoader = (await loadSyncSingletonForTests()).dispose;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-policy.test', accountId: 'account-a', request: boundary.request });
        const serverId = connection.home.id;
        storage.setState({ isDataReady: true, profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
        await setActionEnabled(boundary, false);
        const session = createSessionFixture({ id: 'session-1', serverId });
        let companion: ReturnType<typeof useSessionCompanionController> | undefined;
        function Probe() {
            const controller = useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface: () => {} });
            companion = controller;
            return <><PresentationOwner serverId={serverId} sessionId={session.id} /><SessionCompanionContent {...unmountedBoardProps} session={session} serverId={serverId} controller={controller} boardBinding={null} onRevealBoardItem={() => {}} /></>;
        }
        const screen = await renderScreen(<Probe />);
        await act(async () => { companion!.addItem({ kind: 'instance', instance: { v: 1, id: 'existing', definition: { kind: 'builtin', id: 'agent_plan' }, bindings: {} } }); });
        await flushHookEffects({ cycles: 3 });
        const controls: SessionCompanionInstanceControls = screen.root.findAll(node => node.props.instanceControls?.instance.id === 'existing')[0]!.props.instanceControls;
        const before = storage.getState().localSettings.sessionCompanionPreferencesBySessionV1;
        await expect(controls.rename('My plan')).rejects.toThrow();
        expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toBe(before);
        await setActionEnabled(boundary, true);
        vi.mocked(Modal.confirm).mockClear();
        await act(async () => { await controls.rename('My plan'); });
        expect(Modal.confirm).not.toHaveBeenCalled();
        await flushHookEffects({ cycles: 3 });
        expect(companion!.preference.items).toMatchObject([{ kind: 'instance', instance: { displayName: 'My plan' } }]);
        const undo = readPresentationNotice()?.undo;
        expect(undo).toBeDefined();
        await act(async () => { companion!.setDensity('comfortable'); undo!.run(); });
        await flushHookEffects({ cycles: 3 });
        expect(companion!.preference.density).toBe('comfortable');
        expect(companion!.preference.items).toMatchObject([{ kind: 'instance', instance: { id: 'existing' } }]);
        expect(companion!.preference.items[0]?.kind === 'instance' && companion!.preference.items[0].instance.displayName).toBeUndefined();
        await act(async () => { await controls.rename('First name'); });
        const staleUndo = readPresentationNotice()?.undo;
        expect(staleUndo).toBeDefined();
        await act(async () => { await controls.rename('Newer name'); staleUndo!.run(); });
        expect(companion!.preference.items).toMatchObject([{ kind: 'instance', instance: { displayName: 'Newer name' } }]);
    });
    it('admits the empty Summary control once before revealing it and keeps its Undo scoped to that change', async () => {
        restoreGlobals = withPopoverWebGlobals();
        const boundary = httpBoundary();
        restoreSyncLoader = (await loadSyncSingletonForTests()).dispose;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-summary-policy.test', accountId: 'account-a', request: boundary.request });
        const serverId = connection.home.id;
        storage.setState({ isDataReady: true, profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
        const session = createSessionFixture({ id: 'session-1', serverId });
        let companion: ReturnType<typeof useSessionCompanionController> | undefined;
        function Probe() {
            companion = useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface: () => {} });
            return <><PresentationOwner serverId={serverId} sessionId={session.id} /><SessionCompanionContent {...unmountedBoardProps} session={session} serverId={serverId}
                controller={companion} boardBinding={null} onRevealBoardItem={() => {}} /></>;
        }
        const screen = await renderScreen(<Probe />);
        await act(async () => { companion!.setCollapsed(true); });
        await setActionEnabled(boundary, false, 'session.presentation.apply');
        const before = storage.getState().localSettings.sessionCompanionPreferencesBySessionV1;
        const pressAdd = () => screen.root.findAll(node => node.props.testID === 'session-companion-content-empty'
            && typeof node.props.action?.onPress === 'function')[0]!.props.action.onPress();
        await act(async () => { pressAdd(); });
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'error' }));
        expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toBe(before);
        await setActionEnabled(boundary, true, 'session.presentation.apply');
        vi.mocked(Modal.confirm).mockClear();
        await act(async () => { pressAdd(); });
        await vi.waitFor(() => expect(companion!.preference).toMatchObject({ visible: true, collapsed: false,
            items: [{ kind: 'builtin', id: 'session_summary' }] }));
        expect(Modal.confirm).not.toHaveBeenCalled();
        const undo = readPresentationNotice()?.undo;
        expect(undo).toBeDefined();
        await act(async () => { companion!.setDensity('comfortable'); undo!.run(); });
        expect(companion!.preference).toMatchObject({ visible: false, collapsed: true, density: 'comfortable', items: [] });
    });
    it('admits the full-screen menu before layout edits or closing and retains reference reorder/removal Undo', async () => {
        restoreGlobals = withPopoverWebGlobals();
        const boundary = httpBoundary();
        restoreSyncLoader = (await loadSyncSingletonForTests()).dispose;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-screen-policy.test', accountId: 'account-a', request: boundary.request });
        const serverId = connection.home.id;
        storage.setState({ isDataReady: true, profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
        const session = createSessionFixture({ id: 'session-1', serverId });
        storage.getState().applySessions([session]);
        let companion: ReturnType<typeof useSessionCompanionController> | undefined;
        const close = vi.fn();
        function Probe() {
            companion = useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface: () => {} });
            return <><PresentationOwner serverId={serverId} sessionId={session.id} /><PaneHeaderSlotProvider><HeaderActions />
                <PaneHeaderSlotScope slotKey="companion"><SessionCompanionScreen {...unmountedBoardProps} sessionId={session.id} address={{ serverId, sessionId: session.id }}
                    onRequestClose={close} onRevealBoardItem={() => {}} /></PaneHeaderSlotScope></PaneHeaderSlotProvider></>;
        }
        const screen = await renderScreen(<Probe />);
        await act(async () => { companion!.show({ kind: 'builtin', id: 'session_summary' }); companion!.addItem({ kind: 'builtin', id: 'agent_plan' }); });
        const press = (testID: string, actionId: string) => screen.root.findAll(node => node.props.overflowTriggerTestID === testID
            && Array.isArray(node.props.actions))[0]!.props.actions.find((action: { id: string }) => action.id === actionId).onPress();
        await setActionEnabled(boundary, false, 'session.presentation.apply');
        const before = storage.getState().localSettings.sessionCompanionPreferencesBySessionV1;
        await act(async () => { press('session-companion-screen-menu', 'hide'); });
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'error' }));
        expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toBe(before);
        expect(close).not.toHaveBeenCalled();
        await setActionEnabled(boundary, true, 'session.presentation.apply');
        vi.mocked(Modal.confirm).mockClear();
        await act(async () => { press('session-companion-screen-menu', 'edge-leading'); });
        await vi.waitFor(() => expect(companion!.preference.edge).toBe('leading'));
        retirePresentationNotice();
        await act(async () => { press('session-companion-screen-menu', 'density-compact'); });
        await flushHookEffects({ cycles: 3 });
        expect(readPresentationNotice()).toBeNull();
        await act(async () => { press('session-companion-screen-menu', 'density-comfortable'); });
        await vi.waitFor(() => expect(companion!.preference.density).toBe('comfortable'));
        await act(async () => { press('session-companion-content-item-builtin:session_summary-actions', 'move-down'); });
        await vi.waitFor(() => expect(companion!.preference.items).toEqual([{ kind: 'builtin', id: 'agent_plan' }, { kind: 'builtin', id: 'session_summary' }]));
        const undoMove = readPresentationNotice()?.undo;
        expect(undoMove).toBeDefined();
        await act(async () => { undoMove!.run(); });
        expect(companion!.preference.items).toEqual([{ kind: 'builtin', id: 'session_summary' }, { kind: 'builtin', id: 'agent_plan' }]);
        await act(async () => { companion!.addItem({ kind: 'widget', widgetId: 'gone' }); });
        await act(async () => { press('session-companion-content-item-widget:gone-actions', 'remove'); });
        await vi.waitFor(() => expect(companion!.preference.items).toHaveLength(2));
        const undoRemove = readPresentationNotice()?.undo;
        expect(undoRemove).toBeDefined();
        await act(async () => { undoRemove!.run(); });
        expect(companion!.preference.items).toHaveLength(3);
        await act(async () => { press('session-companion-screen-menu', 'hide'); });
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(companion!.preference.visible).toBe(false);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(boundary.writes).toEqual([]);
    });
    it('admits the actual Session header before showing or opening Companion', async () => {
        restoreGlobals = withPopoverWebGlobals();
        const boundary = httpBoundary();
        restoreSyncLoader = (await loadSyncSingletonForTests()).dispose;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-header-policy.test', accountId: 'account-a', request: boundary.request });
        const serverId = connection.home.id;
        storage.setState({ isDataReady: true, profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
        const session = createSessionFixture({ id: 'session-1', serverId });
        storage.getState().applySessions([session]);
        let companion: ReturnType<typeof useSessionCompanionController> | undefined;
        const reveal = vi.fn();
        const open = vi.fn();
        function Probe({ operation }: { operation: 'show' | 'show_and_open_full' }) {
            companion = useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface: open });
            return <><PresentationOwner serverId={serverId} sessionId={session.id} /><SessionCompanionRevealPortProvider
                address={{ serverId, sessionId: session.id }} openFullSurface={open} revealAfterMutation={reveal} revealBoardItem={() => {}}>
                <SessionHeaderActionMenu sessionId={session.id} session={session} companionHeaderActionPlacement="direct"
                    companionHeaderIntent={{ operation, accessibility: 'show', itemCount: 0, expanded: false, checked: false }} />
            </SessionCompanionRevealPortProvider></>;
        }
        const screen = await renderScreen(<Probe operation="show" />);
        await setActionEnabled(boundary, false, 'session.presentation.apply');
        const before = storage.getState().localSettings.sessionCompanionPreferencesBySessionV1;
        await screen.pressByTestIdAsync('session-header-companion');
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'error' }));
        expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toBe(before);
        expect(reveal).not.toHaveBeenCalled();
        await setActionEnabled(boundary, true, 'session.presentation.apply');
        vi.mocked(Modal.confirm).mockClear();
        await screen.pressByTestIdAsync('session-header-companion');
        await vi.waitFor(() => expect(reveal).toHaveBeenCalledOnce());
        expect(companion!.preference).toMatchObject({ visible: true, collapsed: false });
        await act(async () => { readPresentationNotice()!.undo!.run(); });
        await screen.update(<Probe operation="show_and_open_full" />);
        await screen.pressByTestIdAsync('session-header-companion');
        await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
        await screen.pressByTestIdAsync('session-header-companion');
        await flushHookEffects({ cycles: 3 });
        expect(open).toHaveBeenCalledOnce();
        expect(Modal.confirm).not.toHaveBeenCalled();
    });
    it.each(['setup', 'inputs', 'rename'] as const)('keeps %s unsaved when the actual local preference owner loses its realm', async operation => {
        restoreGlobals = withPopoverWebGlobals();
        const boundary = httpBoundary();
        restoreSyncLoader = (await loadSyncSingletonForTests()).dispose;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://companion-write.test', accountId: 'account-a', request: boundary.request });
        const serverId = connection.home.id;
        storage.setState({ isDataReady: true, profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
        const session = createSessionFixture({ id: 'session-1', serverId });
        const openFullSurface = () => {};
        let companion: ReturnType<typeof useSessionCompanionController> | undefined;
        function Probe() {
            const controller = useSessionCompanionController({ sessionId: session.id, serverId, openFullSurface });
            companion = controller;
            return <><PresentationOwner serverId={serverId} sessionId={session.id} /><SessionCompanionContent {...unmountedBoardProps} session={session} serverId={serverId} controller={controller}
                boardBinding={null} onRevealBoardItem={() => {}}
                addBinding={{ pluginProjection: null }} /></>;
        }
        const screen = await renderScreen(<Probe />);
        await flushHookEffects({ cycles: 3 });
        const binding: SessionCompanionAddBinding = screen.root.findByType(SessionCompanionAddControl).props.binding;
        const candidate = { key: 'builtin:agent_plan', definition: { kind: 'builtin' as const, id: 'agent_plan' as const }, title: 'Plan', pluginName: 'Happier', sharedPluginName: false, icon: 'list-checks' as const, homeDefault: 'available' as const, target: 'session' as const,
            sizeDeclaration: WidgetSizeDeclarationV1Schema.parse(resolveWidgetSizeChoicesV1('sessionBoard')),
            inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true }] } };
        const setup = buildCompanionWidgetAddSections({ ...binding, glanceCandidates: [candidate] })[0]!.entries[0]!.setup!();
        const draft = { bindings: { session: { kind: 'value' as const, value: { serverId, sessionId: session.id } } } };
        if (operation !== 'setup') {
            await act(async () => { companion!.addItem({ kind: 'instance', instance: { v: 1, id: 'existing', definition: candidate.definition, bindings: draft.bindings } }); });
            await flushHookEffects({ cycles: 3 });
            expect(companion!.preference.items).toMatchObject([{ kind: 'instance', instance: { id: 'existing' } }]);
            const controls: SessionCompanionInstanceControls = screen.root.findAll(node => node.props.instanceControls?.instance.id === 'existing')[0]!.props.instanceControls;
            await expect(controls.setInputs(draft.bindings)).resolves.toEqual({ ok: true });
            const before = storage.getState().localSettings.sessionCompanionPreferencesBySessionV1;
            await act(async () => { storage.setState({ profileScope: null }); });
            if (operation === 'inputs') {
                const changed = { session: { kind: 'value' as const, value: { serverId, sessionId: 'session-2' } } };
                await expect(controls.setInputs(changed)).resolves.toEqual({ ok: false, message: 'widgetAdd.saveFailed' });
            } else {
                await expect(controls.rename('My plan')).rejects.toThrow('session_companion_write_refused');
            }
            expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toBe(before);
            return;
        }
        // Keep the real callback from the open step while the canonical storage authority retires.
        await act(async () => { storage.setState({ profileScope: null }); });
        await expect(setup.submit(draft)).resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' });
        expect(storage.getState().localSettings.sessionCompanionPreferencesBySessionV1).toEqual(initial.localSettings.sessionCompanionPreferencesBySessionV1);
    });
});
