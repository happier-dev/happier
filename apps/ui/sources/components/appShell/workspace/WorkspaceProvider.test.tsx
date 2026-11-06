/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { BaseNavigationContainer, createNavigatorFactory, StackRouter, useNavigationBuilder } from '@react-navigation/core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { WORKSPACE_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { storage } from '@/sync/domains/state/storage';
import { hrefForDestinationRef, readDestinationInstanceTitle, resolveCompactAppDestinations, resolveDestinationRefFromHref, useActivateAppDestination, useCompactAppDestinations, useDestinationInstanceTitles, type CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import { useHydrateSessionForRoute, useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { AppPaneProvider } from '../panes/AppPaneProvider';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ConnectedAccountActionApprovalNotice } from '@/components/settings/connectedServices/ConnectedAccountActionApprovalNotice';
import { t } from '@/text';
import { DestinationInstanceHost, useDestinationInstanceKey, useDestinationParams, useDestinationRouter } from './DestinationInstanceHost';
import { buildBotTemplateEditorRoute } from '@/components/sessions/bots/templates/botTemplateEditorDestination';
import { useOptionalWorkspaceNavigation, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { WorkspaceProvider } from './WorkspaceProvider';
import { WorkspaceAppShellProvider } from './WorkspaceAppShellProvider';
import { AppWindowWorkspace } from '@/desktop/window/AppWindowWorkspace';
import { DesktopDestinationWindow } from '@/desktop/window/DesktopDestinationWindow';
import { AppWindowRecordContext } from '@/desktop/window/AppWindowRecordContext';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { prepareDesktopAppWindowReturn, registerDesktopAppWindowReturnHandler } from '@/sync/ops/actions/desktopAppWindowActionDispatch';
import { createSessionDraftRepository, getSessionDraftSnapshot, writeExistingSessionDraft, writeNewSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { getSessionDraftAuthoringFieldValues, getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import { useNewSessionDraftAutoPersist } from '@/components/sessions/new/hooks/useNewSessionDraftAutoPersist';
import { writeNewSessionAuthoringDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServer } from '@/sync/domains/server/serverRuntime';
import { AppShellPluginUiProjectionValueProvider } from '../plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { WorkspaceShell } from './WorkspaceShell';
import { captureMountedWorkspaceAction, invokeWorkspaceAction } from './workspaceActionRuntime';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard, type ActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { KeyboardShortcutProvider, useKeyboardCommand, type KeyboardCommandId } from '@/keyboard';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { parseWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutScopeKey, writeScopedWorkspaceLayout } from './workspacePersistence';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { AppShellTitleStrip } from '@/components/navigation/shell/appRail/AppShellTitleStrip';
import { reconcileWorkspaceSyncedTabs } from './workspaceSyncedTabs';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';
import { Redirect, Stack } from './destinationRoute';
import { WorkspaceRouteEntry } from './createWorkspaceRouteEntry';
import { WorkspaceRootStack } from './WorkspaceRootStack';
import { openInWorkspace } from './useWorkspaceOpenActions';
import { applyCloseDetailsTab, applyOpenDetailsTab, createEmptyPaneDetailsState } from '../panes/details/workspace/detailsWorkspaceReducer';
import { WorkspaceGroupTabs } from './titleBar/WorkspaceGroupTabs';
import { usePhoneWorkspaceTabs } from './usePhoneWorkspaceTabs';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequestV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

const boundary = vi.hoisted(() => ({ layouts: {} as Record<string, unknown>, mirrors: [] as string[], scope: { serverId: 'home-a', accountId: 'alice' }, dataReady: true,
    platform: 'ios', pathname: '/session/A1', params: { id: 'A1', serverId: 'home-a' } as Record<string, string | string[]>,
    renderScene: null as (() => React.ReactNode) | null }));
const nativeWindow = { handlers: new Map<string, (event: { payload: unknown }) => void>() };
// Keep Sync and record readers real; this layout suite has no connected Home transport.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal),
);
// This navigation journey never renders Markdown; the vendor/native SDK remains a boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in workspace navigation test'); },
}));
vi.mock('expo-router/build/fork/getPathFromState', async () => {
    const { loadInstalledExpoPathSerializer } = await import('@/dev/testkit/runtime/installedExpoPathSerializer');
    return loadInstalledExpoPathSerializer();
});
// This harness has no recipient-envelope HTTP/process authority; reaching that API is a setup bug.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace navigation test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
// Authentication is a boundary of this no-network layout harness.
vi.mock('@/auth/context/AuthContext', () => ({ useOptionalAuth: () => null, useAuth: () => ({ isAuthenticated: true }) }));
// Native has no browser History; Expo is the genuine platform URL boundary here.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.platform; }, select: (values: Record<string, unknown>) => values[boundary.platform] ?? values.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock({ pathname: () => boundary.pathname, params: () => boundary.params,
        router: { replace: (href: unknown) => { boundary.mirrors.push(String(href)); } } }).module;
    // Expo is the navigator boundary. Observe whether its admitted options mount a modal scene;
    // workspace admission, hydration, route entries and destination resolution remain real.
    return { ...module, Stack: Object.assign((props: React.ComponentProps<typeof module.Stack>) => {
        if (!boundary.renderScene) return React.createElement(module.Stack, props);
        const declaration = React.Children.toArray(props.children).find(child =>
            React.isValidElement<{ name?: string }>(child) && child.props.name === boundary.pathname.slice(1));
        if (!React.isValidElement<{ options?: unknown }>(declaration)) throw new Error('Missing route declaration');
        const options = typeof declaration.props.options === 'function'
            ? declaration.props.options({ route: { name: boundary.pathname.slice(1), params: boundary.params }, navigation: {} })
            : declaration.props.options;
        const presentation = (options as { presentation?: string } | undefined)?.presentation;
        const scene = boundary.renderScene();
        return presentation && presentation !== 'card' ? React.createElement('RouteModalShell', { presentation }, scene) : scene;
    }, { Screen: module.Stack.Screen }) };
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const initialStorageState = storage.getState();
const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
// Test inputs use the same store snapshots and selectors as the mounted workspace.
Object.defineProperties(boundary, {
    layouts: {
        get: () => workspaceLayoutsState.readAll(),
        set: (layouts: Record<string, unknown>) => {
            for (const key of Object.keys(workspaceLayoutsState.readAll())) workspaceLayoutsState.remove(key);
            for (const [key, layout] of Object.entries(layouts)) workspaceLayoutsState.set(key, layout);
            storage.setState({ localSettings: { ...storage.getState().localSettings, workspaceLayoutV1: {} } });
        },
    },
    scope: {
        get: () => storage.getState().profileScope,
        set: (scope: typeof boundary.scope) => storage.setState({ profileScope: scope }),
    },
    dataReady: {
        get: () => storage.getState().isDataReady,
        set: (isDataReady: boolean) => storage.setState({ isDataReady }),
    },
});

function HostedProbe() {
    const params = useDestinationParams<{ id?: string; serverId?: string }>();
    const router = useDestinationRouter();
    return React.createElement('HostedIdentity', { params, next: () => router.push('/session/A2?serverId=home-a') });
}

function WorkspaceRecordProbe() {
    const navigation = useOptionalWorkspaceNavigation();
    return React.createElement('WorkspaceOwner', { navigation });
}

function RailActivationProbe() {
    const activate = useActivateAppDestination();
    return React.createElement('RailActivation', { activate });
}

function CapabilityArrivalProbe() {
    const router = useDestinationRouter();
    return React.createElement('CapabilityArrival', {
        open: () => router.replace('/settings/teams/home-a/team-1'),
    });
}

function NavigationProbe(props: Readonly<{ navigation: WorkspaceNavigationContextValue }>) {
    const state = props.navigation.state;
    const group = state.groups[state.focusedGroupId];
    const tab = state.tabs[group.activeTabId];
    return <>
        {React.createElement('WorkspaceOwner', { navigation: props.navigation })}
        <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={`/session/${tab.target.params.id}`}
            focused visible navigation={props.navigation.navigationForTab(tab.id)}><HostedProbe /></DestinationInstanceHost>
    </>;
}

function ResizeLayout() { return <Stack />; }
function DestinationTitlesProbe(props: Readonly<{ navigation: WorkspaceNavigationContextValue; catalog: ReturnType<typeof resolveCompactAppDestinations> }>) {
    const entries = React.useMemo(() => Object.values(props.navigation.state.tabs).map(tab => ({ key: tab.id, ref: tab.target })), [props.navigation.state.tabs]);
    return React.createElement('DestinationTitles', { titles: useDestinationInstanceTitles(props.catalog, entries) });
}

function MissingSessionDataReader() {
    // Widgets without a Session input still call the shared hydration hook with an empty address.
    useHydrateSession('', 'destination-data-reader');
    return null;
}

function MissingSessionRouteTitle() {
    useHydrateSessionForRoute('', 'missing-session-route');
    return null;
}
function ResizeEditor() {
    const [draft, setDraft] = React.useState('');
    const params = useDestinationParams();
    return React.createElement('ResizeEditor', { draft, setDraft, params });
}

function RegisteredDirtyEditor(props: Readonly<{ guard: ActiveUnsavedChangesGuard }>) {
    useUnsavedChangesBeforeRemoveGuard({ ...props.guard, ignoreRef: props.guard.ignoreRef ?? undefined,
        isDirty: props.guard.isDirtyRef.current, onContinue: () => {} });
    return null;
}

function RetainedDirtyEditor(props: Readonly<{ tabId: string; focused: boolean; guard: ActiveUnsavedChangesGuard }>) {
    return <DestinationInstanceHost tabId={props.tabId} ref={{ kind: 'session', params: { id: props.tabId } }}
        pathname={`/session/${props.tabId}`} focused={props.focused} visible={props.focused}>
        <RegisteredDirtyEditor guard={props.guard} />
    </DestinationInstanceHost>;
}

function ColdAccountNavigator(props: Readonly<{ children: React.ReactNode }>) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, props);
    return <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>;
}
const ColdAccountStack = createNavigatorFactory(ColdAccountNavigator)();

function RetainedWorkspaceResource(props: Readonly<{ acquire: () => () => void }>) {
    React.useEffect(props.acquire, [props.acquire]);
    return React.createElement('RetainedWorkspaceResourceView');
}

const pendingNewSessionPrompt = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);

function PendingNewSessionAuthoring(props: Readonly<{ scope: ServerAccountScope; draftId: string }>) {
    const [profileId, selectProfile] = React.useState<string | null>(null);
    const draft: NewSessionDraft = { input: pendingNewSessionPrompt, selectedMachineId: 'machine', selectedPath: '/repo',
        entryIntent: 'session', selectedProfileId: profileId, selectedSecretId: null, agentType: 'codex',
        permissionMode: 'default', acpSessionModeId: null, updatedAt: 10 };
    const text = React.useMemo(() => ({ getLength: () => pendingNewSessionPrompt.length,
        subscribe: () => () => {} }), []);
    useNewSessionDraftAutoPersist({ focused: true, draftText: text, draftChangeKey: profileId ?? 'initial',
        persistDraftNow: () => writeNewSessionAuthoringDraftToRepository({ ...props, draft }) });
    return React.createElement('PendingNewSessionAuthoring', { selectProfile });
}

/** Real event dispatch beneath the external browser URL/history fixtures. */
function installBrowserBoundary(input: Record<string, unknown> & { history: object }) {
    const events = new EventTarget();
    vi.stubGlobal('window', { ...input,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
    });
}

/** IndexedDB is the external boundary; repository serialization and dirty-write draining stay real. */
async function installDelayedDraftRecordBoundary() {
    const records = new Map<string, string>();
    let commit!: () => void;
    let reject!: (error: Error) => void;
    const pendingCommit = new Promise<void>((resolve, rejectWrite) => { commit = resolve; reject = rejectWrite; });
    const browserRecords = {
        list: async () => new Map(records),
        read: async (key: string) => records.get(key),
        update: async (key: string, update: (current: string | undefined) => { value: string | undefined; result: string | undefined }) => {
            await pendingCommit;
            const next = update(records.get(key));
            if (next.value === undefined) records.delete(key);
            else records.set(key, next.value);
            return next.result;
        },
    };
    const legacy = { getAllKeys: () => [], getString: () => undefined, delete: () => {} };
    const drafts = createSessionDraftPersistenceStorage({ legacy, records: browserRecords });
    await drafts.prepare();
    const storage = getPersistenceStorage();
    const set = storage.set.bind(storage);
    const getString = storage.getString.bind(storage);
    const remove = storage.delete.bind(storage);
    vi.spyOn(storage, 'set').mockImplementation((key, value) => key.startsWith('session-drafts-repository-v1:')
        ? drafts.set(key, String(value)) : set(key, value));
    vi.spyOn(storage, 'getString').mockImplementation(key => key.startsWith('session-drafts-repository-v1:')
        ? drafts.getString(key) : getString(key));
    vi.spyOn(storage, 'delete').mockImplementation(key => key.startsWith('session-drafts-repository-v1:')
        ? drafts.delete(key) : remove(key));
    const previousFlush = Object.getOwnPropertyDescriptor(storage, 'flush');
    Object.defineProperty(storage, 'flush', { configurable: true, value: drafts.flush });
    onTestFinished(() => {
        if (previousFlush) Object.defineProperty(storage, 'flush', previousFlush);
        else Reflect.deleteProperty(storage, 'flush');
    });
    return { records, commit, reject, reopen: async () => {
        const reopened = createSessionDraftPersistenceStorage({ legacy, records: browserRecords });
        await reopened.prepare();
        return createSessionDraftRepository({ storage: reopened, syncEnabled: false,
            cipher: { seal: async () => { throw new Error('Unexpected draft network encryption'); }, open: async () => null } });
    } };
}

describe('consumed workspace navigation owner', () => {
    it('retains the nested Settings child when its URL mirror becomes a ready workspace', async () => {
        boundary.platform = 'web'; boundary.pathname = '/settings/server/add'; boundary.params = {};
        boundary.dataReady = false;
        installBrowserBoundary({ location: { pathname: boundary.pathname, search: '', hash: '' },
            history: { state: null, replaceState() {}, pushState() {}, go() {} }, sessionStorage: { getItem: () => 'join' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        function Overview() { return React.createElement('JoinSettingsOverview'); }
        function AddHome() { return React.createElement('JoinAddHomeForm'); }
        function Mirror() { return <ColdAccountStack.Navigator>
            <ColdAccountStack.Screen name="index" component={Overview} />
            <ColdAccountStack.Screen name="add" component={AddHome} />
        </ColdAccountStack.Navigator>; }
        function Settings() { return <WorkspaceRouteEntry Body={Overview} mirror={<Mirror />} />; }
        const render = () => <WorkspaceProvider enabled catalog={catalog}>
            <BaseNavigationContainer initialState={{ routes: [{ name: 'settings', state: { routes: [{ name: 'add' }] } }] }}>
                <ColdAccountStack.Navigator><ColdAccountStack.Screen name="settings" component={Settings} /></ColdAccountStack.Navigator>
            </BaseNavigationContainer>
        </WorkspaceProvider>;
        const screen = await renderScreen(render());
        try {
            expect(screen.tree.findAllByType('JoinAddHomeForm' as never)).toHaveLength(1);
            boundary.dataReady = true;
            await screen.update(render());
            expect(screen.tree.findAllByType('JoinAddHomeForm' as never)).toHaveLength(1);
            expect(screen.tree.findAllByType('JoinSettingsOverview' as never)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });


    it('keeps the dirty editor decision and pending NewSession authoring durable through full Close', async () => {
        boundary.platform = 'web';
        // Idle is an external browser scheduling boundary; do not let it hide a Close-time loss.
        vi.stubGlobal('requestIdleCallback', () => 1);
        vi.stubGlobal('cancelIdleCallback', () => {});
        const disk = await installDelayedDraftRecordBoundary();
        const scope = { serverId: 'full-close-authoring-home', accountId: 'alice' };
        const draftId = '00000000-0000-4000-8000-00000000c105';
        writeNewSessionDraft({ scope, draftId, patch: { text: pendingNewSessionPrompt }, materializationIntent: 'userEdit' });
        expect(getSessionDraftDocumentField(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document ?? null,
            { kind: 'composer', field: 'text' })?.value).toBe(pendingNewSessionPrompt);
        const record = { windowId: 'full-close-authoring', chrome: 'full' as const, homeId: scope.serverId,
            accountId: scope.accountId, layoutId: 'authoring-layout', selectedAddress: { kind: 'home' as const } };
        let allowClose = false;
        const dirty = { current: true };
        const guard: ActiveUnsavedChangesGuard = { isDirtyRef: dirty,
            requestDecision: async () => allowClose ? 'discard' : 'keepEditing', tag: 'full-close-file-editor' };
        const screen = await renderScreen(<AppWindowRecordContext.Provider value={record}>
            <DesktopDestinationWindow full><RetainedDirtyEditor tabId="dirty-file" focused guard={guard} />
                <PendingNewSessionAuthoring scope={scope} draftId={draftId} />
            </DesktopDestinationWindow>
        </AppWindowRecordContext.Provider>);
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType('PendingNewSessionAuthoring')).toHaveLength(1));
            await act(async () => { invokeTestInstanceHandler(screen.root.findByType('PendingNewSessionAuthoring'), 'selectProfile', 'latest-profile'); });
            await act(async () => { expect(await prepareDesktopAppWindowReturn('close')).toBe(false); });
            expect(screen.root.findAllByType('PendingNewSessionAuthoring')).toHaveLength(1);
            expect(dirty.current).toBe(true);
            allowClose = true;
            let closing!: Promise<boolean>;
            await act(async () => { closing = prepareDesktopAppWindowReturn('close'); });
            expect(getSessionDraftAuthoringFieldValues(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document).profileId).toBe('latest-profile');
            await act(async () => { disk.commit(); expect(await closing).toBe(true); });
            const reopened = await disk.reopen();
            const restored = reopened.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
            expect(getSessionDraftAuthoringFieldValues(restored?.document).profileId).toBe('latest-profile');
        } finally { disk.commit(); await screen.unmount(); }
    });

    it('keeps pending NewSession authoring durable when its tab unmounts immediately before full Close', async () => {
        boundary.platform = 'web';
        vi.stubGlobal('requestIdleCallback', () => 1);
        vi.stubGlobal('cancelIdleCallback', () => {});
        const disk = await installDelayedDraftRecordBoundary();
        const scope = { serverId: 'full-close-unmounted-authoring', accountId: 'alice' };
        const draftId = '00000000-0000-4000-8000-00000000c106';
        writeNewSessionDraft({ scope, draftId, patch: { text: pendingNewSessionPrompt }, materializationIntent: 'userEdit' });
        expect(getSessionDraftDocumentField(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document ?? null,
            { kind: 'composer', field: 'text' })?.value).toBe(pendingNewSessionPrompt);
        const record = { windowId: 'full-close-unmounted', chrome: 'full' as const, homeId: scope.serverId,
            accountId: scope.accountId, layoutId: 'unmounted-layout', selectedAddress: { kind: 'home' as const } };
        function AuthoringTab() {
            const [visible, setVisible] = React.useState(true);
            return <>{React.createElement('AuthoringTab', { close: () => setVisible(false) })}
                {visible && <DestinationInstanceHost tabId="new-session-tab" ref={{ kind: 'newTab', params: {} }}
                    pathname="/" focused visible><PendingNewSessionAuthoring scope={scope} draftId={draftId} /></DestinationInstanceHost>}</>;
        }
        const screen = await renderScreen(<AppWindowRecordContext.Provider value={record}>
            <DesktopDestinationWindow full><AuthoringTab /></DesktopDestinationWindow>
        </AppWindowRecordContext.Provider>);
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType('PendingNewSessionAuthoring')).toHaveLength(1));
            await act(async () => { invokeTestInstanceHandler(screen.root.findByType('PendingNewSessionAuthoring'), 'selectProfile', 'last-tab-profile'); });
            await act(async () => { invokeTestInstanceHandler(screen.root.findByType('AuthoringTab'), 'close'); });
            expect(screen.root.findAllByType('PendingNewSessionAuthoring')).toHaveLength(0);
            expect(getSessionDraftAuthoringFieldValues(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document).profileId).toBe('last-tab-profile');
            let closing!: Promise<boolean>;
            await act(async () => { closing = prepareDesktopAppWindowReturn('close'); });
            await act(async () => { disk.commit(); expect(await closing).toBe(true); });
            const reopened = await disk.reopen();
            const restored = reopened.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
            expect(getSessionDraftAuthoringFieldValues(restored?.document).profileId).toBe('last-tab-profile');
        } finally { disk.commit(); await screen.unmount(); }
    });

    it('keeps full Close mounted until every pending local draft write is durable', async () => {
        const disk = await installDelayedDraftRecordBoundary();
        const scope = { serverId: 'full-close-home', accountId: 'alice' };
        const otherScope = { serverId: 'retained-other-home', accountId: 'alice' };
        const record = { windowId: 'full-close', chrome: 'full' as const, homeId: scope.serverId, accountId: scope.accountId,
            layoutId: 'full-close-layout', selectedAddress: { kind: 'home' as const } };
        const screen = await renderScreen(<AppWindowRecordContext.Provider value={record}>
            <DesktopDestinationWindow full><RetainedWorkspaceResource acquire={() => () => {}} /></DesktopDestinationWindow>
        </AppWindowRecordContext.Provider>);
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType('RetainedWorkspaceResourceView')).toHaveLength(1));
            writeExistingSessionDraft({ scope, sessionId: 'closing-session', patch: { text: 'latest local edit' } });
            writeExistingSessionDraft({ scope: otherScope, sessionId: 'retained-session', patch: { text: 'other Home retained edit' } });
            expect(getSessionDraftDocumentField(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'closing-session' })!.document,
                { kind: 'composer', field: 'text' })?.value).toBe('latest local edit');
            let acknowledged = false;
            let closing!: Promise<boolean>;
            await act(async () => { closing = prepareDesktopAppWindowReturn('close').then(result => { acknowledged = true; return result; }); });
            expect(disk.records.size).toBe(0);
            expect(acknowledged).toBe(false);
            expect(screen.root.findAllByType('RetainedWorkspaceResourceView')).toHaveLength(1);
            await act(async () => { disk.commit(); expect(await closing).toBe(true); });
            expect(screen.root.findAllByType('RetainedWorkspaceResourceView')).toHaveLength(0);
            const reopened = await disk.reopen();
            for (const [draftScope, sessionId, text] of [[scope, 'closing-session', 'latest local edit'],
                [otherScope, 'retained-session', 'other Home retained edit']] as const) {
                expect(getSessionDraftDocumentField(reopened.getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId })!.document,
                    { kind: 'composer', field: 'text' })?.value).toBe(text);
            }
        } finally { disk.commit(); await screen.unmount(); }
    });

    it('keeps a full window live when its local draft durability fails', async () => {
        const disk = await installDelayedDraftRecordBoundary();
        const scope = { serverId: 'full-close-failed-home', accountId: 'alice' };
        const record = { windowId: 'full-close-failed', chrome: 'full' as const, homeId: scope.serverId, accountId: scope.accountId,
            layoutId: 'full-close-failed-layout', selectedAddress: { kind: 'home' as const } };
        const screen = await renderScreen(<AppWindowRecordContext.Provider value={record}>
            <DesktopDestinationWindow full><RetainedWorkspaceResource acquire={() => () => {}} /></DesktopDestinationWindow>
        </AppWindowRecordContext.Provider>);
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType('RetainedWorkspaceResourceView')).toHaveLength(1));
            writeExistingSessionDraft({ scope, sessionId: 'failed-session', patch: { text: 'unsaved local edit' } });
            let rejected!: Promise<unknown>;
            await act(async () => {
                rejected = expect(prepareDesktopAppWindowReturn('close')).rejects.toThrow('storage unavailable');
                disk.reject(new Error('storage unavailable'));
                await rejected;
            });
            expect(disk.records.size).toBe(0);
            expect(screen.root.findAllByType('RetainedWorkspaceResourceView')).toHaveLength(1);
            expect(getSessionDraftDocumentField(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'failed-session' })!.document,
                { kind: 'composer', field: 'text' })?.value).toBe('unsaved local edit');
        } finally { disk.commit(); await screen.unmount(); }
    });

    it('shows the existing unavailable surface when a full Home change cannot update its native record', async () => {
        boundary.platform = 'web'; boundary.pathname = '/desktop/app-window'; boundary.params = {};
        const home = await upsertServerProfile({ serverUrl: 'https://full-home-update.example.test', name: 'Full', source: 'manual' });
        const nextHome = await upsertServerProfile({ serverUrl: 'https://full-home-update-next.example.test', name: 'Next', source: 'manual' });
        const record = { windowId: 'full-home-update', chrome: 'full' as const, accountId: 'alice', homeId: home.id,
            layoutId: 'full-home-update-layout', selectedAddress: { kind: 'home' as const } };
        const callbacks = new Map<number, (event: { payload: unknown }) => void>();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'plugin:event|listen' && typeof args?.event === 'string' && typeof args.handler === 'number') {
                nativeWindow.handlers.set(args.event, callbacks.get(args.handler)!); return args.handler;
            }
            if (command === 'plugin:event|unlisten' && typeof args?.event === 'string') { nativeWindow.handlers.delete(args.event); return null; }
            if (command === 'desktop_app_window_read') return record;
            if (command === 'desktop_app_window_update') throw new Error('Native record persistence unavailable');
            if (command === 'desktop_host_get_availability') return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
            if (command === 'desktop_app_window_restore') return [record];
            if (command === 'desktop_app_window_responders') return [{ homeId: home.id, accountId: 'alice', windowId: record.windowId }];
            return null;
        });
        installBrowserBoundary({ location: { href: 'https://app.test/desktop/app-window', pathname: '/desktop/app-window', search: '', hash: '' },
            sessionStorage: globalThis.sessionStorage, history: { state: null, pushState() {}, replaceState() {}, go() {} },
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string) => nativeWindow.handlers.delete(event) },
            __TAURI_INTERNALS__: { invoke, metadata: { currentWindow: { label: 'destination_full-home-update' } },
                transformCallback: (callback: (event: { payload: unknown }) => void) => {
                    const id = callbacks.size + 1; callbacks.set(id, callback); return id;
                } } });
        await setActiveServer({ serverId: home.id, scope: 'tab' });
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<AppWindowWorkspace catalog={catalog}><WorkspaceRecordProbe /></AppWindowWorkspace>);
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType('WorkspaceOwner')).toHaveLength(1));
            await act(async () => { await setActiveServer({ serverId: nextHome.id, scope: 'tab' });
                boundary.scope = { serverId: nextHome.id, accountId: 'alice' }; });
            await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_app_window_update', { record: {
                ...record, homeId: nextHome.id, selectedAddress: { kind: 'home' },
            } }));
            await vi.waitFor(() => expect(screen.root.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'unavailable')).toBe(true));
            expect(invoke.mock.calls.some(([command, args]) => command === 'desktop_app_window_ready' && args?.failure)).toBe(false);
        } finally { await screen.unmount(); }
    });

    it('hydrates a blank full window with its retained layout, local navigation and ready guard', async () => {
        boundary.platform = 'web'; boundary.pathname = '/desktop/app-window'; boundary.params = {};
        const home = await upsertServerProfile({ serverUrl: 'https://full-window.example.test', name: 'Full', source: 'manual' });
        const record = { windowId: 'full', chrome: 'full' as const, accountId: 'alice', homeId: home.id, layoutId: 'full-layout',
            selectedAddress: { kind: 'home' as const } };
        const callbacks = new Map<number, (event: { payload: unknown }) => void>();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'plugin:event|listen' && typeof args?.event === 'string' && typeof args.handler === 'number') {
                nativeWindow.handlers.set(args.event, callbacks.get(args.handler)!); return args.handler;
            }
            if (command === 'plugin:event|unlisten' && typeof args?.event === 'string') { nativeWindow.handlers.delete(args.event); return null; }
            if (command === 'desktop_app_window_read') return record;
            if (command === 'desktop_host_get_availability') return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
            if (command === 'desktop_app_window_restore') return [record];
            if (command === 'desktop_app_window_responders') return [{ homeId: home.id, accountId: 'alice', windowId: 'full' }];
            return null;
        });
        installBrowserBoundary({ location: { href: 'https://app.test/desktop/app-window', pathname: '/desktop/app-window', search: '', hash: '' },
            sessionStorage: globalThis.sessionStorage, history: { state: null, pushState() {}, replaceState() {}, go() {} },
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string) => nativeWindow.handlers.delete(event) },
            __TAURI_INTERNALS__: { invoke, metadata: { currentWindow: { label: 'destination_full' } },
                transformCallback: (callback: (event: { payload: unknown }) => void) => {
                    const id = callbacks.size + 1; callbacks.set(id, callback); return id;
                } } });
        await setActiveServer({ serverId: home.id, scope: 'tab' });
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const key = workspaceLayoutScopeKey({ ...boundary.scope, windowId: record.layoutId });
        const saved = createWorkspaceState({ id: 'retained', target: { kind: 'session', params: { id: 'saved-session', serverId: home.id, accountId: 'alice' } }, pinned: true, preview: false });
        workspaceLayoutsState.set(key, serializeWorkspaceLayout(saved));
        const screen = await renderScreen(<AppWindowWorkspace catalog={catalog}><WorkspaceRecordProbe /></AppWindowWorkspace>);
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType('WorkspaceOwner')).toHaveLength(1));
            const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
            expect(navigation().state.tabs.retained.target.params.id).toBe('saved-session');
            await act(async () => { navigation().navigationForTab('retained').push('/session/local-next'); });
            expect(navigation().state.tabs[navigation().state.groups[navigation().state.focusedGroupId].activeTabId].target.params.id).toBe('local-next');
            expect(invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open')).toHaveLength(0);
            await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_app_window_ready', undefined));
            expect(boundary.mirrors).toEqual([]);
        } finally { await screen.unmount(); }
    });

    it('reports a hidden presentation failure without mounting a Session over unreadable retained drafts', async () => {
        boundary.platform = 'web'; boundary.pathname = '/desktop/window'; boundary.params = {};
        const home = await upsertServerProfile({ serverUrl: 'https://draft-failure-window.example.test', name: 'Destination', source: 'manual' });
        const record = { windowId: 'draft-failure', accountId: 'alice', homeId: home.id, layoutId: 'draft-failure-layout',
            selectedAddress: { kind: 'session' as const, sessionId: 'unreadable-session' } };
        const callbacks = new Map<number, (event: { payload: unknown }) => void>();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'plugin:event|listen' && typeof args?.event === 'string' && typeof args.handler === 'number') {
                nativeWindow.handlers.set(args.event, callbacks.get(args.handler)!); return args.handler;
            }
            if (command === 'plugin:event|unlisten' && typeof args?.event === 'string') { nativeWindow.handlers.delete(args.event); return null; }
            if (command === 'desktop_app_window_read') return record;
            if (command === 'desktop_host_get_availability') return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
            if (command === 'desktop_app_window_restore') return [record];
            if (command === 'desktop_get_window_chrome_policy') return { strategy: 'none' };
            return null;
        });
        installBrowserBoundary({ location: { href: 'https://app.test/desktop/window', pathname: '/desktop/window', search: '', hash: '' },
            sessionStorage: globalThis.sessionStorage, history: { state: null, pushState() {}, replaceState() {}, go() {} },
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string) => nativeWindow.handlers.delete(event) },
            __TAURI_INTERNALS__: { invoke, metadata: { currentWindow: { label: 'destination_draft-failure' } },
                transformCallback: (callback: (event: { payload: unknown }) => void) => {
                    const id = callbacks.size + 1; callbacks.set(id, callback); return id;
                } } });
        await setActiveServer({ serverId: home.id, scope: 'tab' });
        boundary.scope = { serverId: home.id, accountId: 'alice' };
        const storageKey = `session-drafts-repository-v1:${serverAccountScopeKeySuffix(boundary.scope)}`;
        getPersistenceStorage().set(storageKey, '{"unreadableRetainedContent":true}');
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<AppWindowWorkspace catalog={catalog}><DesktopDestinationWindow /></AppWindowWorkspace>);
        try {
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_app_window_ready', { failure: 'presentation_unavailable' }));
        expect(invoke).not.toHaveBeenCalledWith('desktop_app_window_ready', undefined);
        expect(getPersistenceStorage().getString(storageKey)).toBe('{"unreadableRetainedContent":true}');
        } finally {
            await screen.unmount();
            await vi.waitFor(() => expect([...nativeWindow.handlers.keys()].filter(event => event.startsWith('desktopAppWindow://'))).toEqual([]));
        }
    });
    it('restores the destination layout and navigates locally without rewriting its native boot route', async () => {
        boundary.platform = 'web'; boundary.pathname = '/desktop/window'; boundary.params = {};
        const location = { pathname: '/desktop/window', search: '', hash: '' };
        const pushState = vi.fn(); const replaceState = vi.fn();
        installBrowserBoundary({ location, history: { state: null, pushState, replaceState, go() {} },
            sessionStorage: { getItem: () => 'different-main-layout' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const initialTarget = { kind: 'session', params: { id: 'A1', serverId: 'home-a', accountId: 'alice' } };
        const retained = createWorkspaceState({ id: 'saved-tab', target: initialTarget, preview: false, pinned: false });
        boundary.layouts = { [workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'destination-layout' })]: serializeWorkspaceLayout(retained) };
        const record = { windowId: 'destination-id', accountId: 'alice', homeId: 'home-a', layoutId: 'destination-layout', selectedAddress: { kind: 'session' as const, sessionId: 'A1' } };
        const screen = await renderScreen(<WorkspaceProvider enabled appWindow={{ record, initialTarget }} catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation().active).toBe(true);
        expect(navigation().state.tabs['saved-tab']?.target).toEqual(initialTarget);
        await act(async () => { navigation().navigationForTab('saved-tab').push('/session/A2?serverId=home-a'); });
        expect(navigation().state.tabs['saved-tab']?.target.params.id).toBe('A2');
        expect(pushState).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
        expect(boundary.mirrors).toEqual([]);
        expect(location.pathname).toBe('/desktop/window');
        expect(parseWorkspaceLayout(boundary.layouts[workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'destination-layout' })])?.tabs['saved-tab']?.target.params.id).toBe('A2');
    });

    it('retains the initial settings navigator while its first Account catalog is published, but withdraws a retired Account', async () => {
        const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const runtime = await activateStorageAccountScope(boundary.scope, storage);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected admitted Account');
        boundary.platform = 'web';
        boundary.pathname = '/settings/usage';
        boundary.params = {};
        installBrowserBoundary({ location: { pathname: boundary.pathname, search: '', hash: '' },
            history: { state: null, replaceState() {}, pushState() {}, go() {} }, sessionStorage: { getItem: () => 'main' } });
        const value = {
            interactionEnabled: false, pluginBrowserProjection: null, phase: 'current' as const,
            machineId: null, serverId: 'home-a', platform: 'web' as const,
            clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {},
            reloadConnectedAccountProjection: () => {}, pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
        };
        function Navigator() {
            const [route, setRoute] = React.useState('/settings/usage');
            return React.createElement('InitialAccountNavigator', { route, setRoute });
        }
        const render = (accountLifetime: typeof lifetime | null, ready = true) => (
            <AppShellPluginUiProjectionValueProvider declarationReady={ready} value={{ ...value, accountLifetime }}>
                <WorkspaceAppShellProvider><Navigator /></WorkspaceAppShellProvider>
            </AppShellPluginUiProjectionValueProvider>
        );
        const screen = await renderScreen(render(null));
        const navigator = () => screen.tree.findByType('InitialAccountNavigator' as never);
        try {
            await act(async () => { navigator().props.setRoute('/settings/usage?view=plans'); });
            await screen.update(render(lifetime, false));
            expect(navigator().props.route).toBe('/settings/usage?view=plans');
            await screen.update(render(lifetime));
            expect(navigator().props.route).toBe('/settings/usage?view=plans');
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            await screen.update(render(lifetime, false));
            expect(screen.tree.findAllByType('InitialAccountNavigator' as never)).toHaveLength(0);
        } finally {
            await screen.unmount();
            runtime.dispose();
        }
    });

    it.each(['web', 'ios'])('requires the exact initial declaration when a %s workspace mounts after another catalog was retained', async (platform) => {
        boundary.platform = platform;
        const value = {
            interactionEnabled: false, pluginBrowserProjection: null, phase: 'current' as const,
            machineId: null, serverId: 'home-a', platform: 'web' as const, accountLifetime: null,
            clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {},
            reloadConnectedAccountProjection: () => {}, pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
        };
        function Seed() { useCompactAppDestinations(); return null; }
        const seed = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}><Seed /></AppShellPluginUiProjectionValueProvider>);
        await seed.unmount();
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.notes', destinationId: 'notes',
            rendererId: 'notes-renderer', container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('Expected admitted app-page binding');
        const placement: PluginUiSurfacePlacementProjection = {
            id: 'surfacePlacement:acme.notes:notes', pluginId: 'acme.notes', contributionKind: 'surfacePlacement',
            descriptorId: 'notes', binding, target: binding.target,
            renderer: { kind: 'hostedWeb', contributionId: 'notes-renderer' }, display: { developerFallback: 'Notes' },
            availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
        };
        boundary.pathname = '/plugins/acme.notes/notes';
        boundary.params = { pluginId: 'acme.notes', localId: 'notes' };
        if (platform === 'web') installBrowserBoundary({ location: { pathname: boundary.pathname, search: '', hash: '' },
            history: { state: null, replaceState() {}, pushState() {}, go() {} }, sessionStorage: { getItem: () => 'main' } });
        const firstTargets: unknown[] = [];
        function Probe() {
            const navigation = useOptionalWorkspaceNavigation();
            if (!navigation) throw new Error('Expected workspace');
            const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            React.useLayoutEffect(() => { firstTargets.push(tab.target); }, []);
            return null;
        }
        await renderScreen(<AppShellPluginUiProjectionValueProvider value={{ ...value,
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1, surfacePlacementsById: { [placement.id]: placement } } }}>
            <WorkspaceAppShellProvider><Probe /></WorkspaceAppShellProvider>
        </AppShellPluginUiProjectionValueProvider>);
        expect(firstTargets).toEqual([{ kind: 'plugin:acme.notes:notes', params: { pluginId: 'acme.notes', localId: 'notes' } }]);
    });

    it('admits the original plugin URL once when an unscoped navigator receives its first Account catalog', async () => {
        const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const previousState = storage.getState();
        const runtime = await activateStorageAccountScope({ serverId: 'home-a', accountId: 'alice' }, storage);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected admitted Account');
        storage.setState({ isDataReady: true, localSettings: { ...storage.getState().localSettings, workspaceLayoutV1: {} } });
        boundary.platform = 'web';
        boundary.pathname = '/plugins/acme.notes/notes';
        boundary.params = { pluginId: 'acme.notes', localId: 'notes' };
        const href = boundary.pathname;
        const urlWrites: string[] = [];
        const history = { state: null as unknown,
            replaceState: (state: unknown, _title: string, url?: string | URL | null) => {
                history.state = state;
                if (url != null) urlWrites.push(String(url));
            },
            pushState: (state: unknown, _title: string, url?: string | URL | null) => {
                history.state = state;
                if (url != null) urlWrites.push(String(url));
            }, go() {} };
        installBrowserBoundary({ location: { pathname: href, search: '', hash: '' }, history,
            sessionStorage: { getItem: () => 'first-account-plugin' } });
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.notes', destinationId: 'notes',
            rendererId: 'notes-renderer', container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('Expected admitted app-page binding');
        const placement: PluginUiSurfacePlacementProjection = {
            id: 'surfacePlacement:acme.notes:notes', pluginId: 'acme.notes', contributionKind: 'surfacePlacement',
            descriptorId: 'notes', binding, target: binding.target,
            renderer: { kind: 'hostedWeb', contributionId: 'notes-renderer' }, display: { developerFallback: 'Notes' },
            availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
        };
        const pluginProjection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            surfacePlacementsById: { [placement.id]: placement } };
        const admittedKinds: string[] = [];
        let navigatorMounts = 0;
        function Probe() {
            const navigation = useOptionalWorkspaceNavigation();
            if (!navigation) throw new Error('Expected workspace');
            const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            React.useLayoutEffect(() => { navigatorMounts++; }, []);
            React.useLayoutEffect(() => { admittedKinds.push(tab.target.kind); }, [tab.target.kind]);
            return React.createElement('FirstAccountPluginWorkspace', { navigation });
        }
        const value = { interactionEnabled: false, pluginBrowserProjection: null, phase: 'current' as const,
            machineId: null, serverId: 'home-a', platform: 'web' as const,
            clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {},
            reloadConnectedAccountProjection: () => {} };
        const render = (accountLifetime: typeof lifetime | null, ready = true, hasPlugin = false) => (
            <AppShellPluginUiProjectionValueProvider declarationReady={ready} value={{ ...value, accountLifetime,
                pluginUiProjection: hasPlugin ? pluginProjection : EMPTY_PLUGIN_UI_PROJECTION }}>
                <WorkspaceAppShellProvider><Probe /></WorkspaceAppShellProvider>
            </AppShellPluginUiProjectionValueProvider>
        );
        const screen = await renderScreen(render(null));
        try {
            await screen.update(render(lifetime, false));
            expect(navigatorMounts).toBe(1);
            await screen.update(render(lifetime, true, true));
            const navigation: WorkspaceNavigationContextValue = screen.tree.findByType('FirstAccountPluginWorkspace' as never).props.navigation;
            const state = navigation.state;
            expect(state.tabs[state.groups[state.focusedGroupId].activeTabId].target).toEqual({
                kind: 'plugin:acme.notes:notes', params: { pluginId: 'acme.notes', localId: 'notes' },
            });
            expect(Object.values(state.tabs).some(tab => tab.target.kind === 'newTab')).toBe(false);
            expect(admittedKinds.filter(kind => kind === 'plugin:acme.notes:notes')).toHaveLength(1);
            expect(navigatorMounts).toBe(1);
            expect(urlWrites.every(url => url === href)).toBe(true);
        } finally {
            await screen.unmount();
            runtime.dispose();
            storage.setState(previousState, true);
        }
    });

    it.each(['web', 'ios'])('admits the initial URL before initializing %s workspace state and retains its editor through catalog publication', async (platform) => {
        boundary.platform = platform;
        if (platform === 'web') {
            installBrowserBoundary({ location: { pathname: '/session/A1', search: '?serverId=home-a', hash: '' },
                history: { state: null, replaceState() {}, pushState() {}, go() {} }, sessionStorage: { getItem: () => 'main' } });
        }
        const mountedTargets: unknown[] = [];
        function Editor() {
            const navigation = useOptionalWorkspaceNavigation();
            const [draft, setDraft] = React.useState('');
            if (!navigation) throw new Error('Expected mounted workspace owner');
            const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            React.useLayoutEffect(() => { mountedTargets.push(tab.target); }, []);
            return React.createElement('PublicationEditor', { draft, setDraft, tab });
        }
        const value = {
            interactionEnabled: false, pluginBrowserProjection: null, phase: 'current' as const,
            machineId: null, serverId: 'home-a', platform: 'web' as const, accountLifetime: null,
            clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {},
            reloadConnectedAccountProjection: () => {}, pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1 },
        };
        const render = (generation: number, ready = true) => <AppShellPluginUiProjectionValueProvider declarationReady={ready} value={{ ...value,
            pluginUiProjection: { ...value.pluginUiProjection, generation } }}>
            <WorkspaceAppShellProvider><Editor /></WorkspaceAppShellProvider>
        </AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(render(1, false));
        expect(screen.tree.findAllByType('PublicationEditor' as never)).toHaveLength(0);
        expect(mountedTargets).toEqual([]);
        await screen.update(render(1));
        const editor = () => screen.tree.findByType('PublicationEditor' as never);
        expect(mountedTargets).toEqual([{ kind: 'session', params: { id: 'A1', serverId: 'home-a' } }]);
        const tabId = editor().props.tab.id;
        await act(async () => { editor().props.setDraft('unsaved draft'); });
        await screen.update(render(2));
        expect(editor().props.draft).toBe('unsaved draft');
        expect(editor().props.tab.id).toBe(tabId);
        expect(mountedTargets).toHaveLength(1);
    });

    it.each([
        ['/settings/agents', '/settings/agents/claude', 'Claude', '/settings/agents/codex', 'Codex'],
        ['/settings/profiles', '/settings/profiles/first', 'First profile', '/settings/profiles/second', 'Second profile'],
        ['/settings/providers', '/settings/providers/first', 'First connection', '/settings/providers/second', 'Second connection'],
    ] as const)('keeps %s as the tab identity after its automatic detail landing, until explicit navigation', async (rootHref, landingHref, landingTitle, explicitHref, explicitTitle) => {
        boundary.platform = 'web';
        boundary.pathname = rootHref;
        boundary.params = {};
        const location = { pathname: rootHref as string, search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                history.state = state;
                if (!href) return;
                const url = new URL(href, 'https://workspace.test');
                location.pathname = url.pathname; location.search = url.search;
            },
            pushState: (state: unknown, unused: string, href: string) => history.replaceState(state, unused, href), go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const collectionTitle = readDestinationInstanceTitle(catalog, resolveDestinationRefFromHref(catalog, rootHref)!);
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            const tab = navigation.state.tabs[group.activeTabId];
            const href = hrefForDestinationRef(catalog, tab.target)!;
            return <>
                {React.createElement('WorkspaceOwner', { navigation })}
                <DestinationTitlesProbe navigation={navigation} catalog={catalog} />
                <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={href} focused visible
                    navigation={navigation.navigationForTab(tab.id)}>
                    {href === rootHref ? <Redirect href={landingHref as never} />
                        : <PageHeader alwaysShowTitle title={href === landingHref ? landingTitle : explicitTitle} />}
                </DestinationInstanceHost>
            </>;
        }}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const tabId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        const title = () => (screen.root.findByType('DestinationTitles').props.titles as ReadonlyMap<string, string>).get(tabId);
        expect(hrefForDestinationRef(catalog, navigation().state.tabs[tabId].target)).toBe(landingHref);
        expect(title()).toBe(collectionTitle);
        expect(document.title).toBe(collectionTitle);
        await act(async () => { navigation().navigationForTab(tabId).push(explicitHref as never); });
        expect(title()).toBe(explicitTitle);
        expect(document.title).toBe(explicitTitle);
        await act(async () => { navigation().navigationForTab(tabId).replace(landingHref as never); });
        expect(title()).toBe(landingTitle);
        expect(document.title).toBe(landingTitle);
    });
    it.each([
        ['/', 'Home', 'Welcome back'],
        ['/boards', 'Boards', 'Launch week'],
        ['/boards/launch', 'Launch week', 'Launch week'],
        ['/session/named?serverId=home-a', 'Release captain', null],
        ['/plugins/acme.notes/notes', 'Notes', 'Notes'],
    ] as const)('isolates %s from missing Session data readers and a retained missing Session route', async (href, expected, pageTitle) => {
        boundary.platform = 'web';
        boundary.pathname = href.split('?')[0]!;
        boundary.params = {};
        const location = { pathname: boundary.pathname, search: href.includes('?') ? `?${href.split('?')[1]}` : '', hash: '' };
        const history = { state: null as unknown, pushState(data: unknown) { this.state = data; }, replaceState(data: unknown) { this.state = data; } };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const session = createSessionFixture({ id: 'named', serverId: 'home-a' });
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, summary: { text: 'Release captain', updatedAt: 1 } } }]);
        const catalog: readonly CompactAppDestination[] = [...resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } }), { kind: 'plugin', container: 'appPage', id: 'plugin:acme.notes:notes',
            destination: { pluginId: 'acme.notes', localId: 'notes' }, title: 'Notes', icon: 'note', order: 40,
            placement: { kind: 'rail', region: 'app' }, activation: 'navigate', availability: 'available',
            routePath: '/plugins/acme.notes/notes' }];
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <>
            {React.createElement('WorkspaceOwner', { navigation })}
            <DestinationTitlesProbe navigation={navigation} catalog={catalog} />
            {Object.values(navigation.state.tabs).map(tab => <DestinationInstanceHost key={tab.id} tabId={tab.id}
                ref={tab.target} pathname={hrefForDestinationRef(catalog, tab.target)?.split('?')[0] ?? ''}
                focused={tab.id === navigation.state.groups[navigation.state.focusedGroupId].activeTabId}
                visible={tab.id === navigation.state.groups[navigation.state.focusedGroupId].activeTabId}>
                {tab.target.params.id === 'gone' ? <MissingSessionRouteTitle /> : <>
                    {pageTitle ? <PageHeader title={pageTitle} alwaysShowTitle /> : null}
                    <MissingSessionDataReader />
                </>}
            </DestinationInstanceHost>)}
        </>}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const activeId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        await act(async () => { navigation().openHref('/session/gone?serverId=home-a', { mode: 'newTab' }); });
        const missingId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        await act(async () => { navigation().activateTab(navigation().state.focusedGroupId, activeId); });
        const titles = screen.root.findByType('DestinationTitles').props.titles as ReadonlyMap<string, string>;
        expect(titles.get(missingId)).toBe(t('errors.sessionDeleted'));
        expect(navigation().destinationTitles?.[activeId]?.title).not.toBe(t('errors.sessionDeleted'));
        expect(titles.get(activeId)).toBe(expected === 'Home' ? t('common.home') : expected === 'Boards' ? t('boards.title') : expected);
        expect(document.title).toBe(titles.get(activeId));
    });
    it.each(['clean', 'prepared', 'dirty', 'cancelled'] as const)('takes a %s editor departure from rail activation into the workspace', async scenario => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const screen = await renderScreen(<AppPaneProvider><WorkspaceProvider enabled catalog={catalog}>{navigation => {
            const state = navigation.state;
            const tab = state.tabs[state.groups[state.focusedGroupId].activeTabId];
            return <>{React.createElement('WorkspaceOwner', { navigation })}
                <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/session/A1" focused visible navigation={navigation.navigationForTab(tab.id)}>
                    <RailActivationProbe />
                </DestinationInstanceHost></>;
        }}</WorkspaceProvider></AppPaneProvider>);
        const guard: ActiveUnsavedChangesGuard = { isDirtyRef: { current: false }, tag: 'artifact-rail-exit',
            requestDecision: vi.fn(async () => scenario === 'cancelled' ? 'keepEditing' : 'discard'),
            ...(scenario === 'clean' ? {} : { prepareGuard: vi.fn(() => { guard.isDirtyRef.current = scenario === 'dirty' || scenario === 'cancelled'; }) }),
        };
        setActiveUnsavedChangesGuard(guard);
        const inbox = catalog.find(destination => destination.id === 'inbox');
        expect(inbox).toBeDefined();
        await act(async () => { screen.root.findByType('RailActivation').props.activate(inbox); });
        const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const target = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId].target;
        expect(target.kind).toBe(scenario === 'cancelled' ? 'session' : 'inbox');
        expect(guard.requestDecision).toHaveBeenCalledTimes(scenario === 'dirty' || scenario === 'cancelled' ? 1 : 0);
        if (guard.prepareGuard) expect(guard.prepareGuard).toHaveBeenCalledOnce();
    });

    it.each([false, true])('settles a retained approval tab from the live request lifecycle without mounting its page (phone=%s)', async phone => {
        boundary.pathname = '/inbox/approvals/request-a';
        boundary.params = { id: 'request-a', serverId: 'home-a' };
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: true, workflows: false, friends: false,
        } });
        const request: ApprovalRequestV1 = {
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' }, actionId: 'session.title.set',
            actionArgs: { sessionId: 'A1', title: 'Release notes' }, summary: 'Rename the release session',
        };
        const artifact = (status: ApprovalRequestV1['status']): DecryptedArtifact => ({
            id: 'request-a', isDecrypted: true, title: request.summary,
            header: buildApprovalRequestArtifactHeaderV1({ ...request, status }),
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        });
        storage.setState({ artifacts: { 'request-a': artifact('open') } });
        function PhoneTitles() {
            return React.createElement('PhoneTitles', { tabs: usePhoneWorkspaceTabs() });
        }
        const screen = await renderScreen(<WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>
            {navigation => <>
                {React.createElement('WorkspaceOwner', { navigation })}
                <DestinationTitlesProbe navigation={navigation} catalog={catalog} />
                <PhoneTitles />
            </>}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const tabId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        const title = () => (screen.root.findByType('DestinationTitles').props.titles as ReadonlyMap<string, string>).get(tabId);
        expect(title()).toBe(`${request.summary} · ${t('approvals.status.open')}`);
        await act(async () => { navigation().publishDestinationTitle?.(tabId, navigation().state.tabs[tabId].target, 'Earlier page title'); });
        for (const status of ['approved', 'executed', 'rejected', 'failed', 'canceled'] as const) {
            await act(async () => storage.setState({ artifacts: { 'request-a': artifact(status) } }));
            const settledTitle = `${request.summary} · ${t(`approvals.status.${status}`)}`;
            expect(title()).toBe(settledTitle);
            if (phone) expect(screen.root.findByType('PhoneTitles').props.tabs.tabs[0].title).toBe(settledTitle);
        }
        expect(navigation().state.tabs[tabId]).toBeDefined();
        const locked: DecryptedArtifact = {
            id: 'request-a', isDecrypted: false, title: null, storageMode: 'e2ee',
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
            headerVersion: 2, seq: 2, createdAt: 1, updatedAt: 2,
        };
        await act(async () => storage.setState({ artifacts: { 'request-a': locked } }));
        expect(title()).toBe(t('common.unavailable'));
        await act(async () => storage.setState({ artifacts: { 'request-a': artifact('canceled') } }));
        // Another Home's same Artifact id must never name the retained request.
        await act(async () => { boundary.scope = { serverId: 'home-b', accountId: 'alice' }; });
        expect([...screen.root.findByType('DestinationTitles').props.titles.values()]).not.toContain(`${request.summary} · ${t('approvals.status.canceled')}`);
    });
    it('settles a deleted Session in the actual strip and window title without removing the closable tab', async () => {
        boundary.platform = 'web';
        boundary.pathname = '/session/gone';
        boundary.params = { id: 'gone', serverId: 'home-a' };
        const history = { state: null as unknown, pushState(data: unknown) { this.state = data; }, replaceState(data: unknown) { this.state = data; } };
        installBrowserBoundary({ location: { pathname: boundary.pathname, search: '?serverId=home-a', hash: '' }, history,
            sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <>
            {React.createElement('WorkspaceOwner', { navigation })}
            <WorkspaceGroupTabs workspace={navigation} group={navigation.state.groups[navigation.state.focusedGroupId]}
                catalog={catalog} focused placement="bar" />
        </>}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const tabId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        expect(document.title).toBe(t('session.untitled'));
        await act(async () => storage.getState().deleteSession('gone', 'home-a'));
        expect(document.title).toBe(t('errors.sessionDeleted'));
        expect(screen.getTextContent()).toContain(t('errors.sessionDeleted'));
        expect(navigation().state.tabs[tabId]).toBeDefined();
        await act(async () => { navigation().closeTab(navigation().state.focusedGroupId, tabId); });
        expect(navigation().state.tabs[tabId]).toBeUndefined();
    });
    it.each([true, false])('retains the exact Team arrival while Expo mounts Settings from a public capability route (ready=%s)', async ready => {
        boundary.platform = 'web';
        boundary.pathname = '/join/invitation';
        boundary.params = {};
        boundary.dataReady = ready;
        const location = { pathname: boundary.pathname, search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                history.state = state;
                if (!href) return;
                const next = new URL(href, 'https://workspace.test');
                location.pathname = next.pathname; location.search = next.search;
            },
            pushState: (state: unknown, unused: string, href: string) => history.replaceState(state, unused, href),
            go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        // Public links have no shell, but an authenticated Account can explicitly
        // enter one. This is the same presentation transition the invitation uses.
        const entryProps = { entry: true };
        const element = (enabled: boolean) => <WorkspaceProvider enabled={enabled} {...entryProps} catalog={catalog}>
            {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}<CapabilityArrivalProbe /></>}
        </WorkspaceProvider>;
        const screen = await renderScreen(element(false));
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation().active).toBe(false);
        await act(async () => { screen.root.findByType('CapabilityArrival').props.open(); });
        // Expo's nested Settings navigator first publishes its index while its
        // child mounts. Browser custody must already retain the explicit Team.
        await act(async () => {
            boundary.pathname = '/settings';
            if (location.pathname.startsWith('/join/')) history.replaceState(history.state, '', boundary.pathname);
            boundary.dataReady = true;
        });
        await screen.update(element(true));
        const state = navigation().state;
        const target = state.tabs[state.groups[state.focusedGroupId].activeTabId].target;
        expect(hrefForDestinationRef(catalog, target)).toBe('/settings/teams/home-a/team-1');
        expect(location.pathname).toBe('/settings/teams/home-a/team-1');
    });
    it('does not promote a generic chrome header over the destination identity', async () => {
        boundary.pathname = '/session/A1/info';
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        let options: React.ComponentProps<typeof Stack.Screen>['options'] = { headerTitle: 'Session info' };
        const element = () => <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            const tab = navigation.state.tabs[group.activeTabId];
            return <>
                <DestinationTitlesProbe navigation={navigation} catalog={catalog} />
                <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={boundary.pathname} focused visible>
                    <Stack.Screen options={options} />
                </DestinationInstanceHost>
            </>;
        }}</WorkspaceProvider>;
        const screen = await renderScreen(element());
        const titles = () => screen.root.findByType('DestinationTitles').props.titles as ReadonlyMap<string, string>;
        expect([...titles().values()]).toEqual([t('session.untitled')]);
        options = { title: 'A named app page' };
        await screen.update(element());
        expect([...titles().values()]).toEqual(['A named app page']);
        options = { title: undefined, headerTitle: 'App page' };
        await screen.update(element());
        // Withdrawing a declaration preserves the last known name for this
        // same destination; a chrome-only label does not replace that identity.
        expect([...titles().values()]).toEqual(['A named app page']);
    });
    it('shares live page identity across tabs, keeps inactive names fresh and retires it before a new route loads without persisting title publication', async () => {
        boundary.pathname = '/workflows/deploy'; boundary.params = { id: 'deploy' };
        boundary.platform = 'web';
        const history = { state: null as unknown, pushState(data: unknown) { this.state = data; }, replaceState(data: unknown) { this.state = data; } };
        installBrowserBoundary({ location: { pathname: boundary.pathname, search: '', hash: '' }, history, sessionStorage: { getItem: () => 'main' } });
        document.title = 'Happier';
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const names = new Map([['deploy', 'Deploy Lumen'], ['release', 'Release Atlas']]);
        const element = () => <WorkspaceProvider enabled catalog={catalog}>{navigation => <>
            {React.createElement('WorkspaceOwner', { navigation })}
            <DestinationTitlesProbe navigation={navigation} catalog={catalog} />
            {Object.values(navigation.state.tabs).map(tab => <DestinationInstanceHost key={tab.id} tabId={tab.id}
                ref={tab.target} pathname={hrefForDestinationRef(catalog, tab.target) ?? ''} focused={tab.id === navigation.state.groups[navigation.state.focusedGroupId].activeTabId}
                visible navigation={navigation.navigationForTab(tab.id)}>
                <Stack.Screen options={{ headerTitle: 'Workflow' }} />
                {names.has(tab.target.params.id) ? <PageHeader alwaysShowTitle title={names.get(tab.target.params.id)!} /> : null}
            </DestinationInstanceHost>)}
        </>}</WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const titles = () => screen.root.findByType('DestinationTitles').props.titles as ReadonlyMap<string, string>;
        const first = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        expect(titles().get(first)).toBe('Deploy Lumen');
        expect(document.title).toBe('Deploy Lumen');
        names.set('deploy', '');
        await screen.update(element());
        expect(titles().get(first)).toBe(t('workflows.title'));
        expect(document.title).toBe(t('workflows.title'));
        names.set('deploy', 'Deploy Lumen');
        await screen.update(element());
        await act(async () => { navigation().openHref('/workflows/release', { mode: 'newTab' }); });
        const second = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        expect(titles().get(second)).toBe('Release Atlas');
        expect(document.title).toBe('Release Atlas');
        names.set('deploy', 'Deploy renamed');
        await screen.update(element());
        expect(titles().get(first)).toBe('Deploy renamed');
        expect(navigation().state.fallbackTitlesByTabId).toEqual({});
        await act(async () => { navigation().openHref('/workflows/not-loaded', { tabId: second }); });
        expect(titles().get(second)).toBe(t('workflows.title'));
        expect(titles().get(first)).toBe('Deploy renamed');
        const latePublisher = navigation().publishDestinationTitle!;
        const oldTarget = navigation().state.tabs[first].target;
        names.clear();
        await act(async () => { boundary.scope = { ...boundary.scope, accountId: 'another-account' }; });
        await screen.update(element());
        await act(async () => { latePublisher(first, oldTarget, 'Old Account name'); });
        expect([...titles().values()]).toEqual([t('workflows.title')]);
    });
    it.each([false, true])('retains a Board source on cancelled navigation and hands it off on admission (phone=%s)', async phone => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        let sidebar = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: { key: 'board', kind: 'board', title: 'Board', resource: { kind: 'board' } }, openAs: 'pinned',
        });
        const screen = await renderScreen(<WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const href = '/session/A1/details?serverId=home-a&details=board';
        const onOpened = () => { sidebar = applyCloseDetailsTab(sidebar, 'board'); };
        const before = navigation().state;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'board-handoff' });
        await act(async () => { openInWorkspace(navigation(), href, 'newTab', undefined, onOpened); });
        expect(navigation().state).toBe(before);
        expect(sidebar.tabsByKey.board).toBeDefined();
        clearActiveUnsavedChangesGuard();
        await act(async () => { openInWorkspace(navigation(), href, 'newTab', undefined, onOpened); });
        const state = navigation().state;
        expect(state.tabs[state.groups[state.focusedGroupId].activeTabId].target.kind).toBe('sessionDetails');
        expect(sidebar.tabsByKey.board).toBeUndefined();
        expect(sidebar.isOpen).toBe(false);
    });
    it('opens Connected Account approval review beside a dirty preview and preserves it through subsequent preview navigation', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => {
                const tab = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
                return <>
                    {React.createElement('WorkspaceOwner', { navigation })}
                    <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={hrefForDestinationRef(catalog, tab.target) ?? ''}
                        focused visible navigation={navigation.navigationForTab(tab.id)}>
                        <ConnectedAccountActionApprovalNotice execution={{ approval: { approvalId: 'request-a', approvalPending: true },
                            binding: { scope: { serverId: 'home-a', accountId: 'alice' } } }} />
                    </DestinationInstanceHost>
                </>;
            }}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const before = navigation().state;
        const groupId = before.focusedGroupId;
        const editorTabId = before.groups[groupId].activeTabId;
        const target = before.tabs[editorTabId].target;
        const dirty = { current: true };
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({ isDirtyRef: dirty, requestDecision, tag: 'approval-retention-test' });
        await act(async () => {
            invokeTestInstanceHandler(screen.root.findByProps({ title: t('approvals.review') }), 'onPress');
        });
        const reviewed = navigation().state;
        expect(reviewed.tabs[editorTabId]).toMatchObject({ target, preview: false });
        expect(reviewed.groups[groupId].activeTabId).not.toBe(editorTabId);
        expect(hrefForDestinationRef(catalog, reviewed.tabs[reviewed.groups[groupId].activeTabId].target))
            .toBe('/inbox/approvals/request-a?serverId=home-a');
        expect(requestDecision).not.toHaveBeenCalled();
        expect(dirty.current).toBe(true);
        // The approval owns focus now; opening another preview must not retire the editor.
        clearActiveUnsavedChangesGuard();
        await act(async () => { navigation().openHref('/session/A2?serverId=home-a'); });
        expect(navigation().state.tabs[editorTabId]).toMatchObject({ target, preview: false });
    });
    it('retains qualified Project page and resource through mounted phone tab admission and activation', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            {(navigation) => React.createElement('ProjectPhoneOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('ProjectPhoneOwner').props.navigation as WorkspaceNavigationContextValue;
        const href = '/projects/wr_1/changes?serverId=home-b&worktreeId=checkout-a&layoutId=selected&comparisonId=comparison-a&initialFile=src%2Fa.ts';
        await act(async () => { navigation().phone?.openHref(href, 'newTab'); });
        const state = navigation().state;
        const tabId = state.groups[state.focusedGroupId].activeTabId;
        expect(state.tabs[tabId].target).toEqual({ kind: 'project', params: { workspaceRefId: 'wr_1', pageId: 'changes',
            serverId: 'home-b', worktreeId: 'checkout-a', layoutId: 'selected', comparisonId: 'comparison-a', initialFile: 'src/a.ts' } });
        await act(async () => { navigation().phone?.activateTab(tabId); });
        expect(boundary.mirrors.at(-1)).toBe(href);
    });
    beforeEach(() => {
        // Existing navigation fixtures model a native/no-browser runtime unless
        // a test explicitly installs its own web History and location boundary.
        vi.stubGlobal('window', undefined);
        boundary.layouts = {};
        storage.setState({ ...initialStorageState, profileScope: { serverId: 'home-a', accountId: 'alice' }, isDataReady: true,
            localSettings: { ...initialStorageState.localSettings, workspaceLayoutV1: {}, titleStripThemeToggleVisible: false } }, true);
    });
    afterEach(() => { standardCleanup(); storage.setState(initialStorageState, true); boundary.mirrors = [];
        boundary.platform = 'ios'; boundary.pathname = '/session/A1'; boundary.params = { id: 'A1', serverId: 'home-a' };
        boundary.renderScene = null;
        clearActiveUnsavedChangesGuard(); vi.unstubAllGlobals(); });
    it('does not commit a hydration fallback when a ready settings route is re-admitted after remount', async () => {
        boundary.platform = 'web'; boundary.pathname = '/settings'; boundary.params = {};
        const history = { state: null as unknown,
            replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {},
        };
        installBrowserBoundary({ location: { pathname: '/settings', search: '', hash: '' }, history,
            sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        let loadingCommits = 0;
        function LoadingProbe() {
            React.useEffect(() => { loadingCommits += 1; }, []);
            return React.createElement('HydrationFallback');
        }
        const Body = () => React.createElement('SettingsBody');
        const element = (key: string, phone: boolean) => <WorkspaceProvider key={key} enabled={!phone} phone={phone} catalog={catalog}>
            {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}
                <WorkspaceRouteEntry Body={Body} loadingFallback={<LoadingProbe />} /></>}
        </WorkspaceProvider>;
        const screen = await renderScreen(element('wide', false));
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(true);
        loadingCommits = 0;
        await screen.update(element('phone', true));
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(true);
        expect(screen.root.findAllByType('SettingsBody')).toHaveLength(0);
        expect(loadingCommits).toBe(0);
    });
    it.each([true, false])('never mounts an empty route modal for hosted History before/after hydration or resize (desktop=%s)', async desktop => {
        boundary.platform = 'web'; boundary.pathname = '/external/browse'; boundary.params = {}; boundary.dataReady = false;
        const location = { pathname: boundary.pathname, search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: true, inbox: false, workflows: false, friends: false } });
        const Body = () => React.createElement('HistoryBody');
        boundary.renderScene = () => <WorkspaceRouteEntry Body={Body} />;
        const element = () => <WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            <WorkspaceRootStack><WorkspaceRootStack.Screen name="external/browse" options={() => ({ presentation: 'transparentModal' })} /></WorkspaceRootStack>
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        expect(screen.root.findAllByType('RouteModalShell')).toHaveLength(0);
        expect(screen.root.findAllByType('HistoryBody')).toHaveLength(0);
        await act(async () => { boundary.dataReady = true; screen.update(element()); });
        expect(screen.root.findAllByType('RouteModalShell')).toHaveLength(0);
        expect(screen.root.findAllByType('HistoryBody')).toHaveLength(0);
        for (const next of [!desktop, desktop]) {
            desktop = next;
            await act(async () => { screen.update(element()); });
            expect(screen.root.findAllByType('RouteModalShell')).toHaveLength(0);
        }
    });
    it.each(['web', 'ios', 'android'])('keeps unhosted History modal presentation on %s', async platform => {
        boundary.platform = platform; boundary.pathname = '/external/browse'; boundary.params = {};
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: platform !== 'web', inbox: false, workflows: false, friends: false } });
        const Body = () => React.createElement('HistoryBody');
        boundary.renderScene = () => <WorkspaceRouteEntry Body={Body} />;
        const presentation = platform === 'web' ? 'transparentModal' : 'modal';
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            <WorkspaceRootStack><WorkspaceRootStack.Screen name="external/browse" options={{ presentation }} /></WorkspaceRootStack>
        </WorkspaceProvider>);
        const modal = screen.root.findByType('RouteModalShell');
        expect(modal.props.presentation).toBe(presentation);
        expect(modal.findAllByType('HistoryBody')).toHaveLength(1);
    });
    it('keeps a hosted History entry non-modal while an unhosted modal is current', async () => {
        boundary.platform = 'web'; boundary.pathname = '/new/index'; boundary.params = {};
        const history = { state: null as unknown, replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {} };
        installBrowserBoundary({ location: { pathname: '/new', search: '', hash: '' },
            history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: true, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            <WorkspaceRootStack>
                <WorkspaceRootStack.Screen name="external/browse" options={() => ({ presentation: 'transparentModal' })} />
                <WorkspaceRootStack.Screen name="new/index" options={{ presentation: 'modal' }} />
            </WorkspaceRootStack>
        </WorkspaceProvider>);
        const optionsFor = (name: string) => {
            const options = screen.root.findByProps({ name }).props.options;
            return typeof options === 'function' ? options({ route: { name, params: {} }, navigation: {} }) : options;
        };
        expect(optionsFor('external/browse').presentation).toBe('card');
        expect(optionsFor('new/index').presentation).toBe('modal');
    });
    it.each([
        ['/settings/no-body', '', false],
        ['/settings/plugins/acme.review/policy', '?subPath=bindings%2F1&subPath=bindings%2F2', false],
        ['/settings/no-body', '', true],
        ['/settings/plugins/acme.review/policy', '?subPath=bindings%2F1&subPath=bindings%2F2', true],
    ] as const)('retains Expo ownership for the unadmitted web location %s%s (desktop=%s)', async (pathname, search, desktop) => {
        boundary.platform = 'web'; boundary.pathname = pathname; boundary.params = {}; boundary.dataReady = false;
        // Match Expo's query boundary, including repeated values; the route
        // entry may render before the parent observes the browser mirror.
        const query = new URLSearchParams(search);
        for (const key of query.keys()) {
            const values = query.getAll(key);
            boundary.params[key] = values.length === 1 ? values[0] : values;
        }
        const history = { state: null as unknown, pushState: () => { throw new Error('Unadmitted route must not be projected'); },
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                if (href) throw new Error('Unadmitted route must not be projected');
                history.state = state;
            } };
        installBrowserBoundary({ location: { pathname, search, hash: '' }, history,
            sessionStorage: { getItem: () => 'main' }, addEventListener: () => {}, removeEventListener: () => {} });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const Body = () => React.createElement('ExpoOwnedBody');
        const screen = await renderScreen(<WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}<WorkspaceRouteEntry Body={Body} /></>}
        </WorkspaceProvider>);
        const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation.active).toBe(false);
        expect(screen.root.findAllByType('ExpoOwnedBody')).toHaveLength(1);
        expect(boundary.mirrors).toEqual([]);
    });
    it('keeps an unready native phone route with its stack rather than the web workspace host', async () => {
        boundary.platform = 'ios'; boundary.dataReady = false;
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const Body = () => React.createElement('NativeOwnedDraft');
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            <WorkspaceRouteEntry Body={Body} />
        </WorkspaceProvider>);
        expect(screen.root.findAllByType('NativeOwnedDraft')).toHaveLength(1);
    });
    it('keeps a deliberately excluded web presentation with Expo rather than withholding its body', async () => {
        boundary.platform = 'web'; boundary.pathname = '/session/A1'; boundary.params = { id: 'A1' };
        const history = { state: null as unknown,
            replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {},
        };
        installBrowserBoundary({ location: { pathname: boundary.pathname, search: '', hash: '' }, history,
            sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const Body = () => React.createElement('ExcludedWebBody');
        const screen = await renderScreen(<WorkspaceProvider enabled={false} catalog={catalog}>
            <WorkspaceRouteEntry Body={Body} />
        </WorkspaceProvider>);
        expect(screen.root.findAllByType('ExcludedWebBody')).toHaveLength(1);
    });
    it('admits an external browser-history commit without waiting for an Expo or Account publication', async () => {
        boundary.platform = 'web'; boundary.pathname = '/new'; boundary.params = {};
        const location = { pathname: '/new', search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                history.state = state;
                if (!href) return;
                const next = new URL(href, 'https://happier.invalid');
                location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
            },
            pushState: (state: unknown, unused: string, href: string) => history.replaceState(state, unused, href), go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation().ownsRoute).toBe(false);
        await act(async () => history.pushState({}, '', '/workflows/new?newSessionDraftSeedId=local-handoff'));
        expect(navigation().ownsRoute).toBe(true);
        expect(navigation().active).toBe(true);
        const group = navigation().state.groups[navigation().state.focusedGroupId];
        expect(navigation().state.tabs[group.activeTabId].target.params.newSessionDraftSeedId).toBe('local-handoff');
    });
    it('readmits a previously mirrored Run URL after an external Home-qualified visit', async () => {
        boundary.platform = 'web'; boundary.pathname = '/workflows'; boundary.params = {};
        const location = { pathname: '/workflows', search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                history.state = state;
                if (!href) return;
                const next = new URL(href, 'https://happier.invalid');
                location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
            },
            pushState: (state: unknown, unused: string, href: string) => history.replaceState(state, unused, href), go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const target = () => {
            const state = navigation().state;
            return state.tabs[state.groups[state.focusedGroupId].activeTabId].target;
        };
        const { createWorkflowRunRoute } = await import('@/sync/domains/workflows/workflowRunRoute');
        const run = { kind: 'occurrence' as const, automationId: 'automation-one', runId: 'run-one' };
        const unqualified = createWorkflowRunRoute(run);
        await act(async () => { navigation().openHref(unqualified); });
        expect(boundary.mirrors.at(-1)).toBe(unqualified);

        // Expo's imperative router changes native history before its query hooks publish.
        await act(async () => { history.pushState({}, '', createWorkflowRunRoute(run, 'unknown-home')); });
        expect(target().params.serverId).toBe('unknown-home');
        await act(async () => { history.pushState({}, '', unqualified); });

        expect(target()).toEqual(resolveDestinationRefFromHref(catalog, unqualified));
        expect(target().params.serverId).toBeUndefined();
    });
    it.each([[true, '/workflows/new'], [false, '/workflows/new'],
        [false, '/settings/prompts/skills'], [false, '/settings/prompts/templates'],
        [true, '/settings/session/runtime'], [true, '/settings/session/new-session-wizard']] as const)(
        'admits the cold web route once readiness arrives without a throwaway body (desktop=%s, path=%s)', async (desktop, pathname) => {
        boundary.platform = 'web'; boundary.dataReady = false; boundary.pathname = pathname; boundary.params = {};
        const location = { pathname, search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        let mounts = 0;
        const Body = () => {
            const hosted = useDestinationInstanceKey() !== null;
            React.useEffect(() => { mounts += 1; }, []);
            return React.createElement('EditableDraft', { hosted });
        };
        const element = () => <WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            {navigation => {
                const group = navigation.state.groups[navigation.state.focusedGroupId];
                const tab = navigation.state.tabs[group.activeTabId];
                return <>{React.createElement('WorkspaceOwner', { navigation })}
                    <WorkspaceRouteEntry Body={Body} mirror={React.createElement('UrlMirror')} />
                    {navigation.active && <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={pathname}
                        focused visible navigation={navigation.navigationForTab(tab.id)}><Body /></DestinationInstanceHost>}
                </>;
            }}
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(false);
        expect(screen.root.findAllByType('EditableDraft')).toHaveLength(0);
        expect(mounts).toBe(0);
        await act(async () => { boundary.dataReady = true; await screen.update(element()); });
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(true);
        expect(screen.root.findByType('EditableDraft').props.hosted).toBe(true);
        expect(mounts).toBe(1);
        expect(screen.root.findAllByType('UrlMirror')).toHaveLength(1);
        expect(location.pathname).toBe(pathname);
        expect(boundary.mirrors.every(href => href.split('?')[0] === pathname)).toBe(true);
    });
    it.each(['usage', 'agents/custom', 'connected-services/connect', 'embeds/new', 'account/api-tokens/token-a', 'voice/service', 'personalize',
        'artifacts/new', 'artifacts/edit/document-a', 'workflows/new', 'workflows/edit', 'automations/new', 'boards/board-a', 'inbox',
        'external/browse', 'prompts/skills', 'prompts/templates', 'session/runtime',
        'session/new-session-wizard'])('retains the %s editor across mobile-web/desktop hosting changes', async pageId => {
        const appPage = /^(artifacts|workflows|automations|boards|inbox|external)(\/|$)/.test(pageId);
        const pathname = pageId === 'personalize' || appPage ? `/${pageId}` : `/settings/${pageId}`;
        const search = pageId === 'personalize' ? '?page=conversation' : '';
        boundary.platform = 'web'; boundary.pathname = pathname; boundary.params = {};
        const location = { pathname, search, hash: '' };
        const browserHistory = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => { browserHistory.state = state;
                if (!href) return;
                const url = new URL(href, 'https://happier.invalid'); location.pathname = url.pathname; location.search = url.search; location.hash = url.hash; },
            pushState: (state: unknown, unused: string, href: string) => browserHistory.replaceState(state, unused, href), go: () => {},
        };
        installBrowserBoundary({ location, history: browserHistory, sessionStorage: { getItem: () => 'main' } });
        const moduleName = pageId === 'agents/custom' ? 'agents/custom/index'
            : pageId === 'prompts/skills' || pageId === 'prompts/templates' ? `${pageId}/index`
            : pageId === 'account/api-tokens/token-a' ? 'account/api-tokens/[tokenId]' : pageId;
        const appModule = pageId === 'artifacts/edit/document-a' ? 'artifacts/edit/[id]'
            : pageId === 'boards/board-a' ? 'boards/[boardId]' : pageId === 'inbox' ? 'inbox/index'
                : pageId === 'workflows/new' ? 'workflows/[id]/index' : pageId;
        const moduleKey = pageId === 'personalize' || appPage ? `./(app)/${appModule}.tsx` : `./(app)/settings/${moduleName}.tsx`;
        const modules: Record<string, unknown> = {
            './(app)/settings/_layout.tsx': { default: ResizeLayout },
            './(app)/index.tsx': { WorkspaceRouteBody: () => null },
            [moduleKey]: { WorkspaceRouteBody: ResizeEditor },
        };
        registerWorkspaceRouteContext(Object.assign((key: string) => modules[key], { keys: () => Object.keys(modules) }));
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: pageId === 'external/browse', inbox: true, workflows: true, friends: false } });
        let desktop = true;
        const element = () => <WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}<WorkspaceShell catalog={catalog} /></>}
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation().active).toBe(true);
        // The native/browser layout boundary admits retained content after its slot is measured.
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 600 } },
            });
            const groupId = navigation().state.focusedGroupId;
            invokeTestInstanceHandler(screen.findByTestId(`split-canvas-content-slot-${groupId}`), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 40, width: 1000, height: 560 } },
            });
        });
        await act(async () => { screen.root.findByType('ResizeEditor').props.setDraft('unsaved draft'); });
        const tabId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        for (const next of [false, true, false]) {
            desktop = next;
            await act(async () => { screen.update(element()); });
            expect(navigation().active).toBe(true);
            expect(navigation().state.groups[navigation().state.focusedGroupId].activeTabId).toBe(tabId);
            expect(screen.root.findByType('ResizeEditor').props.draft).toBe('unsaved draft');
            expect(location.pathname).toBe(pathname);
            expect(location.search).toBe(search);
            if (pageId === 'personalize') expect(screen.root.findByType('ResizeEditor').props.params.page).toBe('conversation');
        }
    });
    it.each(['disabled', 'unready', 'entry'] as const)('retires a held desktop open when its workspace becomes %s', async transition => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        let enabled = true;
        let entry = false;
        const location = { pathname: '/session/A1', search: '', hash: '' };
        if (transition === 'entry') {
            boundary.platform = 'web';
            const history = { state: null as unknown, replaceState(state: unknown) { this.state = state; },
                pushState(state: unknown) { this.state = state; }, go: () => {} };
            installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        }
        const element = () => <WorkspaceProvider enabled={enabled} entry={entry} catalog={catalog}>{navigation => React.createElement('WorkspaceOwner', { navigation })}</WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        let settleDecision!: (value: 'discard') => void;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, tag: 'desktop-retirement-test',
            requestDecision: () => new Promise(resolve => { settleDecision = resolve; }) });
        await act(async () => { navigation().openHref('/session/A4?serverId=home-a', { mode: 'newTab' }); });
        await act(async () => {
            if (transition === 'unready') boundary.dataReady = false;
            else enabled = false;
            if (transition === 'entry') { entry = true; location.pathname = '/join/invitation'; }
            screen.update(element());
        });
        const before = navigation().state;
        const layouts = boundary.layouts;
        boundary.mirrors = [];
        await act(async () => { settleDecision('discard'); });
        expect(navigation().state).toBe(before);
        expect(boundary.layouts).toBe(layouts);
        expect(boundary.mirrors).toEqual([]);
    });
    it.each(['open', 'activate', 'close', 'bulk-close', 'dispatch', 'back', 'forward'] as const)(
        'retires a held desktop %s continuation before the replacement Account layout is touched', async (operation) => {
            const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
            const tab = (id: string) => ({ id, target: { kind: 'session', params: { id: id.toUpperCase(), serverId: 'home-a' } }, pinned: false, preview: false });
            let saved = createWorkspaceState(tab('a1'));
            for (const id of ['a2', 'a3']) saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
            saved = reduceWorkspaceState(saved, { type: 'activateTab', groupId: 'group:1', tabId: 'a1' });
            boundary.layouts = Object.fromEntries(['alice', 'bob'].map(accountId => [workspaceLayoutScopeKey({ serverId: 'home-a', accountId, windowId: 'main' }), serializeWorkspaceLayout(saved)]));
            const element = () => <WorkspaceProvider enabled catalog={catalog}>{navigation => React.createElement('WorkspaceOwner', { navigation })}</WorkspaceProvider>;
            const screen = await renderScreen(element());
            const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
            await act(async () => { navigation().activateTab('group:1', 'a2'); navigation().activateTab('group:1', 'a3'); });
            if (operation === 'forward') await act(async () => { navigation().back(); });
            let settleDecision!: (value: 'discard') => void;
            setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, tag: 'desktop-account-custody-test',
                requestDecision: () => new Promise(resolve => { settleDecision = resolve; }) });
            const source = navigation();
            await act(async () => {
                switch (operation) {
                    case 'open': source.openHref('/session/A4?serverId=home-a', { mode: 'newTab' }); break;
                    case 'activate': source.activateTab('group:1', 'a2'); break;
                    case 'close': source.closeTab('group:1', source.state.groups['group:1'].activeTabId); break;
                    case 'bulk-close': source.closeTabs('group:1', ['a1', source.state.groups['group:1'].activeTabId]); break;
                    case 'dispatch': source.dispatch({ type: 'openTab', groupId: 'group:1', tab: tab('a4') }); break;
                    case 'back': source.back(); break;
                    case 'forward': source.forward(); break;
                }
            });
            await act(async () => { boundary.scope = { serverId: 'home-a', accountId: 'bob' }; screen.update(element()); });
            const before = navigation().state;
            const layouts = boundary.layouts;
            boundary.mirrors = [];
            await act(async () => { settleDecision('discard'); });
            expect(navigation().state).toBe(before);
            expect(boundary.layouts).toBe(layouts);
            expect(boundary.mirrors).toEqual([]);
        });
    it.each(['home', 'back', 'forward'] as const)('continues the title strip %s through the real workspace after one discard decision', async (operation) => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <>
            {React.createElement('WorkspaceOwner', { navigation })}
            <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} navigation={navigation} />
        </>}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => { navigation().openHref('/session/A2?serverId=home-a'); navigation().openHref('/session/A3?serverId=home-a'); });
        if (operation === 'forward') await act(async () => { navigation().back(); });
        boundary.mirrors = [];
        const requestDecision = vi.fn(async () => 'discard' as const);
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision, tag: 'title-strip-owner-test' });
        await screen.pressByTestIdAsync(operation === 'home' ? 'app-shell-logo' : `app-shell-${operation}`);
        expect(requestDecision).toHaveBeenCalledOnce();
        expect(boundary.mirrors).toEqual([operation === 'home' ? '/' : `/session/${operation === 'back' ? 'A2' : 'A3'}?serverId=home-a`]);
    });
    it.each([false, true])('expands a private template into its page while retaining the Session (phone=%s)', async phone => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const destination = buildBotTemplateEditorRoute({ draftArtifactId: 'private-draft',
            sourceSessionRef: { serverId: 'home-a', sessionId: 'A1' }, presentation: 'page' });
        const screen = await renderScreen(<WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const before = navigation().state;
        const sessionTabId = before.groups[before.focusedGroupId].activeTabId;
        await act(async () => { navigation().navigationForTab(sessionTabId).pushRetainingCurrent!(destination); });
        const after = navigation().state;
        const page = after.tabs[after.groups[after.focusedGroupId].activeTabId];
        expect(page.id).not.toBe(sessionTabId);
        expect(hrefForDestinationRef(catalog, page.target)).toBe('/session/A1/template?serverId=home-a&artifactId=private-draft');
        expect(after.tabs[sessionTabId]).toMatchObject({ target: before.tabs[sessionTabId].target, preview: false });
    });
    it('closes a batch under one discard decision and preserves pinned tabs', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => React.createElement('WorkspaceOwner', { navigation })}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => {
            for (const id of ['A2', 'A3', 'A4']) navigation().openHref(`/session/${id}?serverId=home-a`, { mode: 'newTab' });
        });
        const state = navigation().state;
        const group = state.groups[state.focusedGroupId];
        const pinnedId = group.tabIds[1];
        await act(async () => { navigation().dispatch({ type: 'setPinned', tabId: pinnedId, pinned: true }); });
        let decision: 'keepEditing' | 'discard' = 'keepEditing';
        const requestDecision = vi.fn(async () => decision);
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision, tag: 'batch-close-test' });
        const before = navigation().state;
        await act(async () => { navigation().closeTabs(group.id, group.tabIds); });
        expect(navigation().state).toBe(before);
        decision = 'discard';
        await act(async () => { navigation().closeTabs(group.id, group.tabIds); });
        expect(requestDecision).toHaveBeenCalledTimes(2);
        expect(navigation().state.groups[group.id].tabIds).toEqual([pinnedId]);
        expect(navigation().state.recentlyClosed).toHaveLength(3);
    });
    it.each(['single', 'bulk'] as const)('protects a retained inactive editor from %s close through keep-editing, failed save and save-owned continuation', async mode => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        let editorTabId: string | null = null;
        let decision: 'keepEditing' | 'save' | 'discard' = 'keepEditing';
        let saveSucceeds = false;
        const guard: ActiveUnsavedChangesGuard = { isDirtyRef: { current: true }, requestDecision: vi.fn(async () => decision),
            onSave: () => saveSucceeds, continueOnSave: false, tag: 'retained-dirty-editor' };
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => {
            const state = navigation.state;
            const group = state.groups[state.focusedGroupId];
            editorTabId ??= group.activeTabId;
            return <>{React.createElement('WorkspaceOwner', { navigation })}{state.tabs[editorTabId]
                ? <RetainedDirtyEditor tabId={editorTabId} guard={guard} focused={group.activeTabId === editorTabId} /> : null}</>;
        }}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => { navigation().navigationForTab(editorTabId!).pushRetainingCurrent!('/inbox/approvals/request-a?serverId=home-a'); });
        expect(guard.requestDecision).not.toHaveBeenCalled();
        const before = navigation().state;
        const group = before.groups[before.focusedGroupId];
        const close = () => mode === 'bulk' ? navigation().closeTabs(group.id, group.tabIds) : navigation().closeTab(group.id, editorTabId!);
        expect(group.activeTabId).not.toBe(editorTabId);
        await act(async () => { close(); });
        expect(navigation().state).toBe(before);
        decision = 'save';
        await act(async () => { close(); });
        expect(navigation().state).toBe(before);
        expect(guard.isDirtyRef.current).toBe(true);
        saveSucceeds = true;
        await act(async () => { close(); });
        expect(navigation().state).toBe(before);
        expect(guard.isDirtyRef.current).toBe(false);
        guard.isDirtyRef.current = true;
        decision = 'discard';
        await act(async () => { close(); });
        expect(navigation().state.tabs[editorTabId!]).toBeUndefined();
        expect(navigation().state.recentlyClosed).toHaveLength(mode === 'bulk' ? 2 : 1);
    });
    it.each(['direct', 'action'] as const)('does not prompt a dirty active editor when %s close selects only pinned or other tabs', async mode => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        let retainedPinnedTabId: string | null = null;
        const pinnedGuard: ActiveUnsavedChangesGuard = { isDirtyRef: { current: true }, requestDecision: vi.fn(async () => 'keepEditing' as const), tag: 'pinned-dirty-editor' };
        const element = () => <WorkspaceProvider enabled catalog={catalog}>{navigation => <>
            {React.createElement('WorkspaceOwner', { navigation })}
            {retainedPinnedTabId && navigation.state.tabs[retainedPinnedTabId]
                ? <RetainedDirtyEditor tabId={retainedPinnedTabId} focused={false} guard={pinnedGuard} /> : null}
        </>}</WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => { navigation().openHref('/session/A2?serverId=home-a', { mode: 'newTab' }); });
        const group = navigation().state.groups[navigation().state.focusedGroupId];
        const inactiveId = group.tabIds.find(id => id !== group.activeTabId)!;
        await act(async () => { navigation().dispatch({ type: 'setPinned', tabId: inactiveId, pinned: true }); });
        retainedPinnedTabId = inactiveId;
        await screen.update(element());
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision, tag: 'surviving-active-editor' });
        const before = navigation().state;
        const close = async () => {
            if (mode === 'direct') navigation().closeTabs(group.id, [inactiveId]);
            else expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.close_others', input: { tabId: group.activeTabId } })).toMatchObject({ ok: true });
        };
        await act(async () => { await close(); });
        expect(navigation().state).toBe(before);
        expect(pinnedGuard.requestDecision).not.toHaveBeenCalled();
        pinnedGuard.isDirtyRef.current = false;
        await act(async () => { navigation().dispatch({ type: 'setPinned', tabId: inactiveId, pinned: false }); await close(); });
        expect(navigation().state.tabs[inactiveId]).toBeUndefined();
        expect(navigation().state.groups[group.id].activeTabId).toBe(group.activeTabId);
        expect(requestDecision).not.toHaveBeenCalled();
    });
    it.each(['cancel', 'account', 'selection'] as const)('retires a held bulk-close Action when its %s changes', async transition => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        let editorTabId: string | null = null;
        let resolveDecision!: (decision: 'discard') => void;
        const guard: ActiveUnsavedChangesGuard = { isDirtyRef: { current: true }, tag: 'held-close-action',
            requestDecision: () => new Promise(resolve => { resolveDecision = resolve; }) };
        const element = () => <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            const state = navigation.state;
            const group = state.groups[state.focusedGroupId];
            editorTabId ??= group.activeTabId;
            return <>{React.createElement('WorkspaceOwner', { navigation })}{state.tabs[editorTabId]
                ? <RetainedDirtyEditor tabId={editorTabId} guard={guard} focused={group.activeTabId === editorTabId} /> : null}</>;
        }}</WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => { navigation().navigationForTab(editorTabId!).pushRetainingCurrent!('/inbox/approvals/request-a?serverId=home-a'); });
        const abort = new AbortController();
        const pending = invokeWorkspaceAction({ actionId: 'workspace.tabs.close_all', input: {}, signal: abort.signal });
        await act(async () => { await Promise.resolve(); });
        expect(typeof resolveDecision).toBe('function');
        await act(async () => {
            if (transition === 'cancel') abort.abort();
            else if (transition === 'account') { boundary.scope = { serverId: 'home-a', accountId: 'bob' }; screen.update(element()); }
            else navigation().openHref('/session/A2?serverId=home-a', { mode: 'newTab' });
        });
        const before = navigation().state;
        await act(async () => { resolveDecision('discard'); });
        expect(await pending).toMatchObject({ ok: false, errorCode: transition === 'cancel' ? 'action_cancelled'
            : transition === 'account' ? 'workspace_unavailable' : 'workspace_navigation_cancelled' });
        expect(navigation().state).toBe(before);
    });
    it.each(['single', 'bulk', 'action'] as const)('does not carry a held %s close into a replacement destination with the same tab identity', async mode => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        let editorTabId: string | null = null;
        let resolveDecision!: (decision: 'discard') => void;
        const guard: ActiveUnsavedChangesGuard = { isDirtyRef: { current: true }, tag: 'held-retarget-close',
            requestDecision: () => new Promise(resolve => { resolveDecision = resolve; }) };
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => {
            const state = navigation.state;
            const group = state.groups[state.focusedGroupId];
            editorTabId ??= group.activeTabId;
            return <>{React.createElement('WorkspaceOwner', { navigation })}{state.tabs[editorTabId]
                ? <RetainedDirtyEditor tabId={editorTabId} guard={guard} focused={group.activeTabId === editorTabId} /> : null}</>;
        }}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const groupId = navigation().state.focusedGroupId;
        let pending: ReturnType<typeof invokeWorkspaceAction> | undefined;
        await act(async () => {
            if (mode === 'action') pending = invokeWorkspaceAction({ actionId: 'workspace.tabs.close_all', input: {} });
            else if (mode === 'single') navigation().closeTab(groupId, editorTabId!);
            else navigation().closeTabs(groupId, [editorTabId!]);
            await Promise.resolve();
        });
        expect(typeof resolveDecision).toBe('function');
        await act(async () => { navigation().dispatch({ type: 'setTarget', tabId: editorTabId!,
            target: { kind: 'session', params: { id: 'replacement', serverId: 'home-a' } } }); });
        const before = navigation().state;
        await act(async () => { resolveDecision('discard'); });
        if (pending) expect(await pending).toMatchObject({ ok: false, errorCode: 'workspace_navigation_cancelled' });
        expect(navigation().state).toBe(before);
        expect(navigation().state.tabs[editorTabId!].target.params.id).toBe('replacement');
    });
    it('admits the current browser location when readiness arrives before the Expo URL mirror', async () => {
        boundary.platform = 'web';
        boundary.pathname = '/session/A1';
        boundary.params = { id: 'A1', serverId: 'home-a' };
        boundary.dataReady = false;
        const location = { pathname: '/session/A1', search: '?serverId=home-a', hash: '' };
        const browserHistory = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                browserHistory.state = state;
                if (!href) return;
                const url = new URL(href, 'https://happier.invalid');
                location.pathname = url.pathname; location.search = url.search; location.hash = url.hash;
            },
            pushState: (state: unknown, unused: string, href: string) => browserHistory.replaceState(state, unused, href),
            go: () => {},
        };
        installBrowserBoundary({ location, history: browserHistory, sessionStorage: { getItem: () => 'main' },
            addEventListener: () => {}, removeEventListener: () => {} });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(false);
        await act(async () => {
            // Browser navigation is authoritative even while Expo still presents A1's mirror inputs.
            location.pathname = '/session/A2';
            boundary.dataReady = true;
        });
        const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const group = navigation.state.groups[navigation.state.focusedGroupId];
        expect(navigation.state.tabs[group.activeTabId].target.params.id).toBe('A2');
        expect(location.pathname).toBe('/session/A2');
    });
    it('admits the initial route over a restored layout without persisting until an explicit navigation', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const saved = createWorkspaceState({ id: 'saved', target: { kind: 'session', params: { id: 'saved', serverId: 'home-a' } }, pinned: true, preview: false });
        boundary.layouts = { [workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'main' })]: saved };
        const layouts = boundary.layouts;
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <NavigationProbe navigation={navigation} />}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const state = navigation().state;
        expect(state.tabs[state.groups[state.focusedGroupId].activeTabId].target.params.id).toBe('A1');
        expect(state.tabs.saved).toBeDefined();
        expect(boundary.layouts).toBe(layouts);
        act(() => { navigation().openHref('/session/A2?serverId=home-a', { mode: 'newTab' }); });
        expect(boundary.layouts).not.toBe(layouts);
        expect(Object.values(boundary.layouts)[0]).toEqual(serializeWorkspaceLayout(navigation().state));
        await screen.unmount();
    });
    it.each([true, false])('adopts the persisted terminal pane on a cold exact Home-alias URL (ready=%s)', async ready => {
        const endpoint = 'http://happier-agent-qa-find-search.localhost:3009';
        const alias = 'happier-agent-qa-find-search.localhost-3009';
        const home = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
        const sessionId = 'cmv88vp4l0062m2i1pvpsyc0i';
        const paneId = 'be022062-19f9-45a6-9adb-3fc5a79208d0';
        // Learn equivalence through the real profile producer before the cold mount.
        expect((await upsertServerProfile({ serverUrl: endpoint })).id).toBe(alias);
        const profile = await setServerProfileIdentityForUrl(endpoint, home);
        if (!profile) throw new Error('Home identity was not learned');
        // The MMKV backing is the testkit's isolated native-storage boundary.
        // Retire only the profile created for this case.
        onTestFinished(async () => {
            // Retire the browser boundary before native-profile cleanup.
            vi.stubGlobal('window', undefined);
            await removeServerProfile(profile.id);
        });
        boundary.scope = { serverId: profile.id, accountId: 'alice' };
        const saved = reduceWorkspaceState(createWorkspaceState({ id: paneId, target: { kind: 'session',
            params: { id: sessionId, serverId: home, bottom: 'terminal', right: 'terminal' } }, pinned: false, preview: false }),
            { type: 'openTab', groupId: 'group:1', tab: { id: 'saved-inbox', target: { kind: 'inbox', params: {} },
                pinned: false, preview: true } });
        const key = workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'main' });
        // Use the app's writer, JSON storage round-trip and exact reader, not a copied layout shape.
        boundary.layouts = JSON.parse(JSON.stringify(writeScopedWorkspaceLayout({}, key, saved)));
        expect(parseWorkspaceLayout(boundary.layouts[key])).toEqual(saved);
        const persisted = boundary.layouts;
        boundary.platform = 'web';
        boundary.pathname = `/session/${sessionId}`;
        boundary.params = { serverId: alias, bottom: 'terminal' };
        boundary.dataReady = ready;
        const history = { state: null as unknown,
            replaceState(data: unknown) { this.state = data; }, pushState(data: unknown) { this.state = data; } };
        installBrowserBoundary({ location: { pathname: boundary.pathname, search: `?serverId=${alias}&bottom=terminal`, hash: '' },
            history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: true, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => <NavigationProbe navigation={navigation} />}
        </WorkspaceProvider>);
        if (!ready) await act(async () => { boundary.dataReady = true; });
        const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const state = navigation.state;
        const active = state.tabs[state.groups[state.focusedGroupId].activeTabId];
        expect(active.id).toBe(paneId);
        expect(active.target).toEqual(saved.tabs[paneId].target);
        expect(Object.keys(state.tabs)).toEqual([paneId, 'saved-inbox']);
        expect(screen.root.findByType('HostedIdentity').props.params.serverId).toBe(home);
        expect(createSessionPaneScopeId(sessionId, active.target.params.serverId, active.id))
            .toBe(createSessionPaneScopeId(sessionId, home, paneId));
        expect(boundary.layouts).toBe(persisted);
        // A pending sync publication can temporarily withdraw readiness after
        // restoration. Re-admitting the unchanged alias URL must keep custody.
        await act(async () => { boundary.dataReady = false; });
        await act(async () => { boundary.dataReady = true; });
        const resumed = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(resumed.state.groups[resumed.state.focusedGroupId].activeTabId).toBe(paneId);
        // Explicit user intent writes the adopted pane through the real layout owner.
        await act(async () => { resumed.dispatch({ type: 'setPinned', tabId: paneId, pinned: true }); });
        expect(parseWorkspaceLayout(boundary.layouts[key])?.tabs[paneId]).toMatchObject({ pinned: true, target: active.target });
        await screen.unmount();
    });
    it('keeps an initial deep link selected when shared tabs hydrate afterwards', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const state = (screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue).state;
        const initialId = state.groups[state.focusedGroupId].activeTabId;
        const remote = { id: 'saved-machine', target: { kind: 'settings', params: { pageId: 'machines/machine-a', id: 'machine-a' } }, pinned: false };
        const hydrated = reconcileWorkspaceSyncedTabs(state, { v: 1, tabsById: { [remote.id]: remote }, order: [remote.id], pairs: [] }, () => 'blank');
        expect(hydrated.groups[hydrated.focusedGroupId].activeTabId).toBe(initialId);
        expect(hydrated.tabs[initialId].target.params.id).toBe('A1');
    });
    it('binds tab commands only while active and uses the current focused group through mounted Actions', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        let invoke: (command: KeyboardCommandId) => boolean = () => false;
        function Commands() { invoke = useKeyboardCommand(); return null; }
        let enabled = true;
        const element = () => <KeyboardShortcutProvider handlers={{}}><Commands /><WorkspaceProvider enabled={enabled} catalog={catalog}>
            {(navigation) => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider></KeyboardShortcutProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const state = () => navigation().state;
        const originalGroupId = state().focusedGroupId;
        const originalTabId = state().groups[originalGroupId].activeTabId;
        await act(async () => { expect(invoke('workspace.tab.new')).toBe(true); });
        const emptyTabId = state().groups[originalGroupId].activeTabId;
        expect(state().tabs[emptyTabId]).toMatchObject({ target: { kind: 'newTab' }, preview: false });
        expect(emptyTabId).not.toBe(originalTabId);
        await act(async () => { navigation().dispatch({ type: 'splitTab', tabId: emptyTabId, sourceGroupId: originalGroupId,
            targetGroupId: originalGroupId, newGroupId: 'other-group', axis: 'row', placement: 'after',
            availableSizePx: 1600, minimumFirstSizePx: 320, minimumSecondSizePx: 320 }); });
        expect(state().focusedGroupId).toBe('other-group');
        await act(async () => { expect(invoke('workspace.tab.new')).toBe(true); });
        expect(state().groups[originalGroupId].tabIds).toEqual([originalTabId]);
        const lastTabId = state().groups['other-group'].activeTabId;
        await act(async () => { expect(invoke('workspace.tab.select1')).toBe(true); });
        expect(state().groups['other-group'].activeTabId).toBe(emptyTabId);
        await act(async () => { expect(invoke('workspace.tab.select9')).toBe(true); });
        expect(state().groups['other-group'].activeTabId).toBe(lastTabId);
        const beforeOutOfRange = state();
        await act(async () => { invoke('workspace.tab.select8'); });
        expect(state()).toBe(beforeOutOfRange);
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'workspace-keyboard-test' });
        await act(async () => { invoke('workspace.tab.close'); });
        expect(state()).toBe(beforeOutOfRange);
        clearActiveUnsavedChangesGuard();
        await act(async () => { invoke('workspace.tab.close'); });
        await act(async () => { invoke('workspace.tab.close'); });
        expect(state().groups['other-group']).toBeUndefined();
        expect(state().focusedGroupId).toBe(originalGroupId);
        expect(state().groups[originalGroupId].tabIds).toEqual([originalTabId]);
        await act(async () => { invoke('workspace.tab.close'); });
        expect(state().groups[originalGroupId].tabIds).toHaveLength(1);
        expect(state().tabs[state().groups[originalGroupId].activeTabId].target.kind).toBe('newTab');
        const closedState = state();
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'workspace-reopen-test' });
        await act(async () => { expect(invoke('workspace.tab.reopen')).toBe(true); });
        expect(state()).toBe(closedState);
        clearActiveUnsavedChangesGuard();
        await act(async () => { invoke('workspace.tab.reopen'); });
        expect(state().groups[originalGroupId].activeTabId).toBe(originalTabId);
        expect(state().recentlyClosed).toEqual([]);
        enabled = false;
        await act(async () => { screen.update(element()); });
        expect(invoke('workspace.tab.new')).toBe(false);
        expect(invoke('workspace.tab.close')).toBe(false);
        expect(invoke('workspace.tab.reopen')).toBe(false);
        expect(invoke('workspace.tab.select1')).toBe(false);
    });
    it('does not carry a guarded Action into the replacement Account workspace', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const element = () => <WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => {
            const state = navigation().state;
            const group = state.groups[state.focusedGroupId];
            navigation().closeTab(group.id, group.activeTabId);
        });
        expect(WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.closed.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.closed.list', input: {} })).tabs).toHaveLength(1);
        const mounted = captureMountedWorkspaceAction();
        let settleDecision!: (value: 'discard') => void;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, tag: 'account-change-test',
            requestDecision: () => new Promise((resolve) => { settleDecision = resolve; }) });
        const pending = invokeWorkspaceAction({ actionId: 'workspace.tabs.reopen', input: {} });
        await act(async () => {
            boundary.scope = { serverId: 'home-a', accountId: 'bob' };
            screen.update(element());
        });
        await act(async () => { settleDecision('discard'); });
        expect(await pending).toMatchObject({ ok: false, errorCode: 'workspace_unavailable' });
        expect(await mounted?.({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: false, errorCode: 'workspace_unavailable' });
        const listed = WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} }));
        expect(listed.tabs).toHaveLength(1);
        expect(WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.closed.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.closed.list', input: {} })).tabs).toEqual([]);
    });
    it('splits an explicitly selected inactive-group tab through the mounted measured canvas and resizes that split', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        let showCanvas = false;
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => <>{React.createElement('WorkspaceOwner', { navigation })}
                {showCanvas ? <WorkspaceShell catalog={catalog} /> : null}</>}
        </WorkspaceProvider>);
        const state = () => (screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue).state;
        const sourceGroupId = state().focusedGroupId;
        await act(async () => {
            const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
            navigation.dispatch({ type: 'setTarget', tabId: state().groups[sourceGroupId].activeTabId, target: { kind: 'newTab', params: {} } });
            showCanvas = true;
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: {} })).toMatchObject({ ok: true });
        });
        const inactiveTabId = state().groups[sourceGroupId].activeTabId;
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: {} })).toMatchObject({ ok: true });
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', { nativeEvent: { layout: { width: 3000, height: 1000 } } });
        });
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.split', input: { direction: 'right' } })).toMatchObject({ ok: true });
        });
        const previouslyFocusedGroupId = state().focusedGroupId;
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.split', input: { tabId: inactiveTabId, direction: 'down' } })).toMatchObject({ ok: true });
        });
        const root = state().root;
        expect(root).toMatchObject({ kind: 'split', first: { kind: 'split', axis: 'column' }, second: { id: previouslyFocusedGroupId, kind: 'leaf' } });
        expect(state().groups[state().focusedGroupId].tabIds).toEqual([inactiveTabId]);
        if (root.kind !== 'split' || root.first.kind !== 'split') throw new Error('The source group must own the new split');
        const splitId = root.first.id;
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.resize', input: { splitId, ratio: 0.65 } }))
                .toMatchObject({ ok: false, errorCode: 'workspace_layout_unmeasured' });
            invokeTestInstanceHandler(screen.findByTestId(`split-canvas-split-${splitId}`), 'onLayout',
                { nativeEvent: { layout: { width: 1497, height: 1000 } } });
        });
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.resize', input: { splitId, ratio: 0.65 } })).toMatchObject({ ok: true });
        });
        expect(state().root).toMatchObject({ first: { id: splitId, ratio: 0.65 } });
        const listed = WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} }));
        expect(listed.tabs.find((tab) => tab.id === inactiveTabId)?.groupId).toBe(state().focusedGroupId);
        expect(listed.rootNodeId).toBe(state().root.id);
        expect(listed.splits).toEqual(expect.arrayContaining([expect.objectContaining({ id: splitId, axis: 'column', ratio: 0.65,
            firstNodeId: root.first.first.id, secondNodeId: root.first.second.id })]));
    });
    it('executes mounted Actions against real tabs, honors cancellation and retires with its owner', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const originalId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        const mounted = captureMountedWorkspaceAction();
        expect(mounted).not.toBeNull();
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { href: '/session/B1?serverId=home-b', mode: 'newTab' } })).toMatchObject({ ok: true });
        });
        const newId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        expect(newId).not.toBe(originalId);
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.pin', input: { tabId: newId, pinned: true } })).toMatchObject({ ok: true });
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { tabId: originalId, href: '/session/C1?serverId=home-c' } })).toMatchObject({ ok: true });
        });
        expect(navigation().state.tabs[newId]).toMatchObject({ pinned: true, target: { params: { id: 'B1', serverId: 'home-b' } } });
        expect(navigation().state.tabs[originalId].target.params).toEqual({ id: 'C1', serverId: 'home-c' });
        expect(Object.keys(navigation().state.tabs)).toHaveLength(2);
        const before = navigation().state;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'workspace-action-test' });
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.close', input: { tabId: originalId } })).toMatchObject({ ok: false, errorCode: 'workspace_navigation_cancelled' });
        });
        expect(navigation().state).toBe(before);
        clearActiveUnsavedChangesGuard();
        expect(await invokeWorkspaceAction({ actionId: 'workspace.split', input: { direction: 'right' } })).toMatchObject({ ok: false, errorCode: 'workspace_layout_unmeasured' });
        await act(async () => { screen.unmount(); });
        expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        expect(await mounted?.({ actionId: 'workspace.tabs.open', input: {} })).toMatchObject({ ok: false, errorCode: 'workspace_unavailable' });
    });
    it('routes hosted actions and cross-tab history through one owner with scoped server identity', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => <NavigationProbe navigation={navigation} />}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation().active).toBe(true);
        expect(screen.root.findByType('HostedIdentity').props.params).toEqual({ id: 'A1', serverId: 'home-a' });
        await act(async () => { screen.root.findByType('HostedIdentity').props.next(); });
        await act(async () => { navigation().openHref('/session/B1?serverId=home-b', { mode: 'newTab' }); });
        for (const [direction, id, serverId] of [['back', 'A2', 'home-a'], ['back', 'A1', 'home-a'], ['forward', 'A2', 'home-a'], ['forward', 'B1', 'home-b']] as const) {
            await act(async () => { navigation()[direction](); });
            expect(screen.root.findByType('HostedIdentity').props.params).toEqual({ id, serverId });
            expect(boundary.mirrors.at(-1)).toBe(`/session/${id}?serverId=${serverId}`);
        }
    });
});
