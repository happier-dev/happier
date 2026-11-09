// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { flushHookEffects, installBrowserStorageLockBoundary, standardCleanup } from '@/dev/testkit';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { ActionsSettingsV1Schema, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ScmWorkingEntrySchema } from '@happier-dev/protocol/scm/workingSnapshot';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

const viewport = { width: 1440, height: 900, scale: 1, fontScale: 1 };
installSessionFilesViewBoundaries({ platformOS: 'web', reactNativeOverrides: { Dimensions: { get: () => viewport } } });
await prepareSessionFilesViewTestkit();
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { FilePageHeader, FilePageToolbar } = await import('../file/FilePageHeader');
const { FilePagePluginViewerHeader } = await import('../file/FilePagePluginViewerHeader');
const { FileChangesSection } = await import('../file/changes/FileChangesRegions');
const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { PaneMainHideButton, PaneMainRestoreChip } = await import('@/components/appShell/panes/mainColumn/PaneMainColumnControls');
const scopeActions = await import('@/sync/ops/actions/scopeActionFamily');
const { invokeScopeAction, readShellColumnActionOwner, readActiveFileViewActionOwner } = scopeActions;
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { useRouter } = await import('expo-router');
const { getSharedBlockingApprovalCoordinator } = await import('@happier-dev/protocol/actions/blockingApprovalCoordinator');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { PluginPageContent } = await import('@/components/plugins/pages/PluginPageContent');
const { resolvePluginPages } = await import('@/components/plugins/pages/pluginPages');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createPluginDeclarativeModelFixture } = await import('@/dev/testkit/fixtures/pluginDeclarativeModelFixture');

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let policy: ActionsSettingsV1;
let serverSettings: ReturnType<typeof settingsParse>;
let settingsVersion: number;
let pane!: ReturnType<typeof useAppPaneScope>;
let command!: ReturnType<typeof useKeyboardCommand>;
let terminal: MockInstance<typeof scopeActions.invokeScopeAction>;
const filePath = 'source.txt';
let scenario = 0;
let scopeId: string;
const diff = '--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-before\n+after\n';
function Keys() { command = useKeyboardCommand(); return null; }
function Scene({ file, focused = true, fallback = false }: Readonly<{ file?: boolean; focused?: boolean; fallback?: boolean }>) {
    pane = useAppPaneScope(scopeId);
    const navigation = useRouter();
    const destinationNavigation = React.useMemo(() => ({ ...navigation, pushRetainingCurrent: navigation.push }), [navigation]);
    React.useEffect(() => { if (file) pane.openDetailsTab(createWorkspaceFileDetailsTab(filePath), { intent: 'pinned' }); }, [file]);
    return <DestinationInstanceHost tabId={scopeId} ref={{ kind: 'plugins', params: {} }} pathname="/plugins"
        navigation={destinationNavigation} focused={focused} visible><KeyboardShortcutProvider handlers={{}}><Keys />{file
        ? <SurfaceStateSizeProvider size={viewport.width === 390 ? 'phone' : 'page'}>
            <WorkspaceFileDetailsView scopeId={scopeId} scope={fixture.scope} filePath={filePath} presentation="panel" sessionIdForAugmentation={fixture.session.id} />
        </SurfaceStateSizeProvider>
        : <AppPaneScopeHost scopeId={scopeId}
            mainColumn={{ hideLabel: 'Hide session', showLabel: 'Show session', identity: { name: 'Session' } }}
            main={<PaneMainHideButton />}
            rightPaneBuiltinAdapter={{ destinationIds: ['git'], render: () => null }}
            destinationDetails={{ pane: fallback ? null : <PaneMainRestoreChip />, onClose: () => {} }} />
    }</KeyboardShortcutProvider></DestinationInstanceHost>;
}

async function setPolicy(action: 'shell.column.set' | 'file.view.set', mode: 'off' | 'ask' | 'default') {
    policy = ActionsSettingsV1Schema.parse({ v: 1, actions: { [action]: mode === 'off' ? { disabledSurfaces: ['ui'] }
        : mode === 'ask' ? { approvalRequiredSurfaces: ['ui'] } : {} } });
    serverSettings = settingsParse({ ...serverSettings, actionsSettingsV1: policy });
    settingsVersion += 1;
    await act(async () => fixture.storage.getState().applySettingsForScope({ serverId: fixture.scope.serverId, accountId: 'alice' }, serverSettings, settingsVersion));
}
async function waitForApproval(index: number) {
    await act(async () => { await vi.waitFor(() => {
        const id = fixture.artifacts.list()[index]?.id;
        expect(id).toBeDefined();
        // The Home persists before the requester receives its ACK; decide only after its live wait is ready.
        expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(id!)).toBe(1);
    }); });
}
beforeEach(async () => {
    scopeId = `session:action-ingress-${++scenario}`;
    policy = { v: 1, actions: {} };
    serverSettings = settingsParse({ actionsSettingsV1: policy });
    settingsVersion = 0;
    viewport.width = 1440;
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_action_ingress', sessionId: scopeId.slice('session:'.length), request: async url => {
        if (new URL(String(url)).pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: serverSettings }, version: settingsVersion });
        return new Response('{}', { status: 404 });
    }, rpc: request => request.method === 'daemon.filesystem.readFile'
        ? { success: true, content: Buffer.from('after\n').toString('base64') }
        : request.method === 'scm.diff.file' ? { success: true, diff }
        : request.method === 'scm.change.discard' ? { success: true, entries: [{ path: filePath, status: 'restored',
            hashBefore: 'a'.repeat(64), hashAfter: 'b'.repeat(64), previous: { inlineBase64: Buffer.from('after\n').toString('base64') } }] }
        : { success: true, exists: true, kind: 'file', sizeBytes: 6 } });
    fixture.storage.getState().applyLocalSettings({ paneArrangement: 'session', uiMultiPanePanelsEnabled: true }, { source: 'ui' });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ capabilities: { readBlame: true }, entries: [
        ScmWorkingEntrySchema.parse({ path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasPendingDelta: true }),
    ] }));
    serverSettings = fixture.storage.getState().settings;
    // Observe the real admitted terminal without replacing its implementation or policy.
    terminal = vi.spyOn(scopeActions, 'invokeScopeAction');
});
afterEach(async () => { retirePresentationNotice(); await standardCleanup(); await fixture?.dispose(); });

describe('explicit File and pane Action ingress', () => {
    it.each([
        ...(['side-key', 'main-key', 'hide', 'restore', 'fallback-restore'] as const).map(ingress => ({ ingress, close: false })),
        { ingress: 'side-key' as const, close: true },
    ])('retained plugin page keeps $ingress approval alive through real workspace navigation (close: $close)', async ({ ingress, close }) => {
        const restoreLocks = installBrowserStorageLockBoundary();
        const pluginId = 'acme.column-approval';
        const localId = 'inspector-page';
        const path = `/plugins/${pluginId}/${localId}`;
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: localId,
            rendererId: 'page', container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('The column fixture requires an admitted app-page binding');
        const placement = {
            id: `surfacePlacement:${pluginId}:${localId}`, pluginId, occurrenceId: 'column-approval-page',
            contributionKind: 'surfacePlacement', descriptorId: localId, binding, target: binding.target,
            renderer: { kind: 'declarative', contributionId: 'page', model: createPluginDeclarativeModelFixture({
                pluginId, localId: 'page', occurrenceId: 'column-approval-page',
                document: { version: 1, root: { kind: 'text', text: 'Column approval fixture' } },
            }) },
            display: { developerFallback: 'Inspector fixture' }, headerActions: [],
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            hostOrigin: { serverId: fixture.scope.serverId, machineId: null, phase: 'current', interactionEnabled: true, executionOrigin: null },
        } satisfies PluginUiSurfacePlacementProjection;
        const pages = resolvePluginPages({ target: { kind: 'app' }, placements: [placement] });
        const page = pages[0];
        if (!page) throw new Error('The column fixture requires a selectable app page');
        const projection = { pluginUiProjection: null, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: fixture.scope.serverId, platform: 'web',
            accountLifetime: captureActiveServerAccountScopeLifetime(), reloadConnectedAccountProjection: () => {},
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        } satisfies AppShellPluginUiProjectionValue;
        const catalog = resolveCompactAppDestinations({ pages, builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const fallback = ingress === 'fallback-restore';
        const hiddenInitially = ingress === 'restore' || fallback;
        let navigation!: WorkspaceNavigationContextValue;
        let pluginTabId = '';
        const renderContent = (content: React.ReactElement) => <AppPaneScopeHost scopeId={scopeId}
            mainColumn={{ hideLabel: 'Hide Inspector', showLabel: 'Show Inspector', identity: { name: 'Inspector' } }}
            main={<>{content}<PaneMainHideButton /></>}
            rightPaneBuiltinAdapter={{ destinationIds: ['git'], render: () => null }}
            destinationDetails={{ pane: fallback ? null : <PaneMainRestoreChip />, onClose: () => {} }} />;
        function PaneReader() { pane = useAppPaneScope(scopeId); return null; }
        fixture.storage.setState({ isDataReady: true });
        window.history.replaceState(null, '', path);
        const screen = await fixture.render(<KeyboardShortcutProvider handlers={{}}><Keys /><PaneReader />
            <WorkspaceProvider enabled catalog={catalog}>{owner => {
                navigation = owner;
                return Object.values(owner.state.groups).flatMap(group => group.tabIds.map(tabId => {
                    const tab = owner.state.tabs[tabId]!;
                    const isPlugin = tab.target.kind === page.id;
                    if (isPlugin) pluginTabId = tabId;
                    const visible = group.activeTabId === tabId;
                    return <DestinationInstanceHost key={tabId} tabId={tabId} ref={tab.target}
                        pathname={isPlugin ? path : '/inbox/approvals'} focused={visible} visible={visible}
                        navigation={owner.navigationForTab(tabId)}>{isPlugin
                            ? <PluginPageContent pluginId={pluginId} localId={localId} page={page} projection={projection}
                                routePathFor={() => path} subPath="" renderContent={renderContent} />
                            : React.createElement('ApprovalDestinationProbe')}
                    </DestinationInstanceHost>;
                }));
            }}</WorkspaceProvider>
        </KeyboardShortcutProvider>);
        try {
            await vi.waitFor(() => expect(readShellColumnActionOwner('side')?.available).toBe(true));
            expect(pluginTabId).not.toBe('');
            if (hiddenInitially) await act(async () => { await invokeScopeAction('shell.column.set', { column: 'main', visible: false }); });
            await setPolicy('shell.column.set', 'ask');
            terminal.mockClear();
            const read = () => ingress === 'side-key' ? pane.scopeState?.right.isOpen : pane.scopeState?.mainHidden;
            const initial = read();
            await act(async () => {
                if (ingress === 'hide') screen.findByTestId('pane-main-hide')!.props.onPress();
                else if (hiddenInitially) screen.findByTestId('pane-main-restore-chip')!.props.onPress();
                else expect(command(ingress === 'side-key' ? 'panes.side.toggle' : 'panes.main.toggle')).toBe(true);
            });
            await vi.waitFor(() => expect(screen.findAllByType('ApprovalDestinationProbe')).toHaveLength(1));
            await flushHookEffects({ cycles: 20 });
            const artifactId = fixture.artifacts.list()[0]!.id;
            expect(StoredApprovalRequestSchema.parse(JSON.parse(fixture.artifacts.readPlainBody(artifactId)!)).status).toBe('open');
            expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1);
            expect(read()).toBe(initial);
            expect(navigation.state.tabs[pluginTabId]).toBeDefined();
            if (close) {
                const group = Object.values(navigation.state.groups).find(candidate => candidate.tabIds.includes(pluginTabId))!;
                await act(async () => { navigation.closeTab(group.id, pluginTabId); });
                await vi.waitFor(() => expect(StoredApprovalRequestSchema.parse(JSON.parse(fixture.artifacts.readPlainBody(artifactId)!)).status).toBe('canceled'));
                expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(0);
                expect(read()).toBe(initial);
                expect(terminal.mock.calls.filter(([id]) => id === 'shell.column.set')).toHaveLength(0);
                return;
            }
            const decision = await decideApprovalAsInbox(fixture.scope.serverId, artifactId, 'approve');
            expect(decision).toMatchObject({ ok: true });
            await vi.waitFor(() => expect(read()).toBe(!initial));
            expect(terminal.mock.calls.filter(([id]) => id === 'shell.column.set')).toHaveLength(1);
        } finally { await screen.unmount(); restoreLocks(); }
    });

    it.each([1440, 390])('plugin-viewer Edit keeps file.view.set admission at width %i', async width => {
        viewport.width = width;
        let edits = 0;
        const screen = await fixture.render(<SurfaceStateSizeProvider size={width === 390 ? 'phone' : 'page'}>
            <FilePagePluginViewerHeader scope={fixture.scope} filePath={filePath} onEdit={() => { edits += 1; }} />
        </SurfaceStateSizeProvider>);
        const run = () => screen.findByType(FilePageHeader).props.edit.onPress();
        await setPolicy('file.view.set', 'off'); await act(async () => { void run(); });
        expect(edits).toBe(0);
        await setPolicy('file.view.set', 'ask'); await act(async () => { void run(); });
        await waitForApproval(0);
        await decideApprovalAsInbox(fixture.scope.serverId, fixture.artifacts.list()[0]!.id, 'reject');
        expect(edits).toBe(0);
        await act(async () => { void run(); }); await waitForApproval(1);
        await decideApprovalAsInbox(fixture.scope.serverId, fixture.artifacts.list()[1]!.id, 'approve');
        await vi.waitFor(() => expect(edits).toBe(1));
        await setPolicy('file.view.set', 'default'); await act(async () => { void run(); });
        await vi.waitFor(() => expect(edits).toBe(2));
        expect(terminal.mock.calls.filter(([id]) => id === 'file.view.set')).toHaveLength(2);
    });
    it.each(['hide', 'restore', 'fallback-restore', 'main-key', 'side-key'] as const)('%s obeys Off, Ask reject/approve and the default', async ingress => {
        const fallback = ingress === 'fallback-restore';
        const screen = await fixture.render(<Scene fallback={fallback} />);
        const hiddenInitially = ingress === 'restore' || fallback;
        if (hiddenInitially) await act(async () => { await invokeScopeAction('shell.column.set', { column: 'main', visible: false }); });
        if (fallback) expect(screen.findByTestId('pane-main-restore-fallback')).not.toBeNull();
        const read = () => ingress === 'side-key' ? pane.scopeState?.right.isOpen : pane.scopeState?.mainHidden;
        const initial = read();
        terminal.mockClear();
        const run = async () => {
            await act(async () => {
                if (ingress === 'hide') screen.findByTestId('pane-main-hide')!.props.onPress();
                else if (hiddenInitially) screen.findByTestId('pane-main-restore-chip')!.props.onPress();
                else expect(command(ingress === 'main-key' ? 'panes.main.toggle' : 'panes.side.toggle')).toBe(true);
            });
        };
        await setPolicy('shell.column.set', 'off'); await run();
        expect(read()).toBe(initial); expect(fixture.artifacts.list()).toHaveLength(0);
        expect(terminal.mock.calls.filter(([id]) => id === 'shell.column.set')).toHaveLength(0);
        await setPolicy('shell.column.set', 'ask'); await run();
        await waitForApproval(0);
        expect(read()).toBe(initial);
        await decideApprovalAsInbox(fixture.scope.serverId, fixture.artifacts.list()[0]!.id, 'reject');
        expect(read()).toBe(initial);
        await run();
        await waitForApproval(1);
        // Opening the Inbox approval retains this destination but removes its keyboard/global-column ownership.
        await screen.update(fixture.wrap(<Scene focused={false} fallback={fallback} />));
        const decision = await decideApprovalAsInbox(fixture.scope.serverId, fixture.artifacts.list()[1]!.id, 'approve');
        expect(decision).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(read()).toBe(!initial));
        expect(terminal.mock.calls.filter(([id]) => id === 'shell.column.set')).toHaveLength(1);
        await screen.update(fixture.wrap(<Scene fallback={fallback} />));
        await setPolicy('shell.column.set', 'default');
        // Reset through the raw terminal so default policy exercises this same ingress, not its inverse.
        await act(async () => { await invokeScopeAction('shell.column.set', {
            column: ingress === 'side-key' ? 'side' : 'main',
            visible: ingress === 'side-key' ? initial : !initial,
        }); });
        await vi.waitFor(() => expect(read()).toBe(initial));
        terminal.mockClear();
        // The raw Action terminal must not dispatch another Action, including restore.
        await run();
        await vi.waitFor(() => expect(read()).toBe(!initial));
        expect(fixture.artifacts.list()).toHaveLength(2);
        expect(terminal.mock.calls.filter(([id]) => id === 'shell.column.set')).toHaveLength(1);
        expect(readShellColumnActionOwner('main')?.present).toBe(true);
    });

    it.each([1440, 390].flatMap(width => ['mode', 'scope', 'blame', 'edit'].map(ingress => ({ width, ingress }))))('File $ingress honours policy at width $width', async ({ width, ingress }) => {
        viewport.width = width;
        if (ingress === 'edit') {
            fixture.storage.getState().applySettingsLocal({ featureToggles: { ...serverSettings.featureToggles, 'files.editor': true } });
            serverSettings = fixture.storage.getState().settings;
        }
        const screen = await fixture.render(<Scene file />);
        await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.modes.length).toBeGreaterThan(0));
        const read = () => readActiveFileViewActionOwner();
        // The real SCM projection offers Changes before its diff load completes.
        await vi.waitFor(() => expect(read()?.availableModes).toContain('changes'));
        const initialView = { tabId: `file:${filePath}`,
            mode: ingress === 'scope' ? 'changes' : 'view', changesScope: { kind: ingress === 'scope' ? 'workingTree' : 'session' }, blame: false };
        await act(async () => { expect(await invokeScopeAction('file.view.set', initialView)).toEqual({ ok: true }); });
        if (ingress === 'scope') {
            await vi.waitFor(() => expect(screen.findByType(FileChangesSection).props.review.changed).toBe(true));
            await act(async () => { await screen.findByType(FileChangesSection).props.review.menuChanges.discardAll(); });
            await vi.waitFor(() => expect(screen.findByType(FileChangesSection).props.review.undoAvailable).toBe(true));
        }
        const retainedUndo = ingress === 'scope' ? readPresentationNotice() : null;
        terminal.mockClear();
        if (ingress === 'mode') expect(screen.findAllByType(FilePageToolbar)).toHaveLength(width === 390 ? 1 : 0);
        const runMode = (mode = 'diff') => {
            const node = screen.findAllByType(FilePageToolbar)[0] ?? screen.findByType(FilePageHeader);
            return node.props.onDisplayMode(mode);
        };
        const runBlame = () => screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'blame').onSelect();
        const runScope = () => screen.findByType(FileChangesSection).props.review.selectScope('session');
        const runEdit = () => screen.findByType(FilePageHeader).props.edit.onPress();
        const run = ingress === 'mode' ? () => runMode() : ingress === 'scope' ? runScope : ingress === 'edit' ? runEdit : runBlame;
        const changed = ingress === 'mode' ? () => read()?.mode === 'changes'
            : ingress === 'scope' ? () => read()?.changesScope?.kind === 'session' : ingress === 'edit' ? () => read()?.mode === 'edit' : () => read()?.blame === true;
        await setPolicy('file.view.set', 'off'); await act(async () => { void run(); });
        if (retainedUndo) expect(readPresentationNotice()).toBe(retainedUndo);
        expect(changed()).toBe(false);
        expect(terminal.mock.calls.filter(([id]) => id === 'file.view.set')).toHaveLength(0);
        const before = fixture.artifacts.list().length;
        await setPolicy('file.view.set', 'ask'); await act(async () => { void run(); });
        await waitForApproval(before);
        expect(changed()).toBe(false);
        await decideApprovalAsInbox(fixture.scope.serverId, fixture.artifacts.list()[before]!.id, 'reject');
        if (retainedUndo) expect(readPresentationNotice()).toBe(retainedUndo);
        expect(changed()).toBe(false);
        await act(async () => { void run(); });
        await waitForApproval(before + 1);
        const decision = await decideApprovalAsInbox(fixture.scope.serverId, fixture.artifacts.list()[before + 1]!.id, 'approve');
        expect(decision).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(changed()).toBe(true));
        if (retainedUndo) expect(readPresentationNotice()).toBeNull();
        expect(terminal.mock.calls.filter(([id]) => id === 'file.view.set')).toHaveLength(1);
        await setPolicy('file.view.set', 'default');
        await act(async () => { expect(await invokeScopeAction('file.view.set', initialView)).toEqual({ ok: true }); });
        await vi.waitFor(() => expect(changed()).toBe(false));
        terminal.mockClear();
        await act(async () => { void run(); });
        await vi.waitFor(() => expect(changed()).toBe(true));
        expect(fixture.artifacts.list()).toHaveLength(2);
        expect(terminal.mock.calls.filter(([id]) => id === 'file.view.set')).toHaveLength(1);
    });

    it('reviews a Save held by an explicit Ask over the editor instead of leaving the Session', async () => {
        fixture.storage.getState().applySettingsLocal({ featureToggles: { ...serverSettings.featureToggles, 'files.editor': true } });
        policy = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'daemon.filesystem.writeFile': { approvalRequiredSurfaces: ['ui'] } } });
        serverSettings = settingsParse({ ...fixture.storage.getState().settings, actionsSettingsV1: policy });
        settingsVersion += 1;
        await act(async () => fixture.storage.getState().applySettingsForScope({ serverId: fixture.scope.serverId, accountId: 'alice' }, serverSettings, settingsVersion));
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { FileEditorNoticeLine } = await import('../file/editor/FileEditorNoticeLine');
        const { Modal } = await import('@/modal');
        const screen = await fixture.render(<Scene file />);
        await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit).toBeTruthy());
        await act(async () => { await screen.findByType(FilePageHeader).props.edit.onPress(); });
        await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
        await act(async () => { screen.findByType(FileEditorPanel).props.onChange('after, edited\n'); });
        vi.mocked(Modal.show).mockClear();
        const save = [...screen.findAllByType(FilePageHeader), ...screen.findAllByType(FilePageToolbar)]
            .map(node => node.props.onSaveEditingFile).find(onSave => typeof onSave === 'function');
        await act(async () => { void save(); });
        await vi.waitFor(() => expect(fixture.artifacts.list()).toHaveLength(1));
        const artifactId = fixture.artifacts.list()[0]!.id;
        const reviews = () => vi.mocked(Modal.show).mock.calls.map(([config]) => config)
            .filter(config => (config.props as { artifactId?: string } | undefined)?.artifactId === artifactId);
        await vi.waitFor(() => expect(reviews()).toHaveLength(1));
        // Closing without an answer leaves the waiting line, whose Review reopens it in place.
        await act(async () => { reviews()[0]!.onRequestClose?.(); });
        const reopen = screen.findByType(FileEditorNoticeLine).props.onOpenApproval;
        expect(reopen).toEqual(expect.any(Function));
        await act(async () => { reopen(); });
        await vi.waitFor(() => expect(reviews()).toHaveLength(2));
    });
});
