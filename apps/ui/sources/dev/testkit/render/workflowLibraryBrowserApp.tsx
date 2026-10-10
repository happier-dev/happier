import '@/unistyles';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { UnistylesRuntime } from 'react-native-unistyles';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { WorkflowsLibraryHome } from '@/components/workflows/library/WorkflowsLibraryHome';
import { WorkflowEditorHostScreen } from '@/components/workflows/screens/WorkflowEditorHostScreen';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { installWorkspaceBrowserHistory } from '@/components/appShell/workspace/workspaceBrowserTransport';
import { ArtifactsBrowser } from '@/components/artifacts/ArtifactsBrowserScreen';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { ModalProvider } from '@/modal';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { storage } from '@/sync/domains/state/storage';
import { upsertAndActivateServer, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { installUrlMirror } from './workspaceHistoryBrowserBoundary';
import { settleLibraryDeletion, configureSingleLibraryDefinition, switchLibraryAccount, getLibraryFixtureAccountId, readLibraryFixtureResponse, isLibraryDeletionPending } from '../fixtures/workflowLibraryHttpFixture';
import { createWorkflowActionHttpTransport } from '../fixtures/workflowActionHttpTransport';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { WorkspaceBrowserPresentation } from './WorkspaceBrowserPresentation';

const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, friends: false, inbox: false, externalSessions: false } });
const search = { open: () => {}, buildCommands: () => [] };
installWorkspaceBrowserHistory();
function LibraryJourney() {
    const pathname = usePathname();
    const definitionId = /^\/workflows\/([^/]+)$/.exec(pathname)?.[1];
    return <AppPaneProvider>{definitionId === undefined ? <WorkflowsLibraryHome /> :
        <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} />}</AppPaneProvider>;
}
async function mount(phone: boolean, theme: 'light' | 'dark', singleDefinition = false, surface: 'library' | 'artifacts' = 'library') {
    if (singleDefinition) configureSingleLibraryDefinition();
    const transport = createWorkflowActionHttpTransport({ fixtureResponse: readLibraryFixtureResponse, accountId: getLibraryFixtureAccountId });
    const httpTrace: string[] = [];
    Object.assign(globalThis, { libraryHttpTrace: httpTrace });
    setRuntimeFetch(async (url, init) => {
        httpTrace.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
        try { return await transport.fetch(url, init); }
        catch (error) { httpTrace.push(String(error)); throw error; }
    });
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(theme);
    const home = await upsertAndActivateServer({ serverUrl: 'http://library-browser.test', name: 'Library browser' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    await TokenStorage.setCredentialsForServerUrl('http://library-browser.test', { serverId: home.id }, { token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature' });
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-a' }, isDataReady: true,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        ...(surface === 'artifacts' ? { localSettings: { ...storage.getState().localSettings, artifactsBrowserViewV1: { presentation: 'list' as const } } } : {}),
        workflowRunListWindows: {}, workflowRunsById: {} });
    installUrlMirror();
    createRoot(document.getElementById('root')!).render(<WorkspaceBrowserPresentation><SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
        <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={search}>
            <ModalProvider><WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>{navigation => {
                const group = navigation.state.groups[navigation.state.focusedGroupId];
                const tab = navigation.state.tabs[group.activeTabId];
                const pathname = tab.target.kind === 'workflow' ? `/workflows/${tab.target.params.id}`
                    : tab.target.params.workspacePathname ?? (surface === 'library' ? '/workflows' : '/artifacts');
                return <AppShellMaterialFrame showChrome={!phone} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
                    titleStrip={null} rail={null} column={null} peek={null}>
                    <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={pathname} focused visible phone={phone}
                        navigation={navigation.navigationForTab(tab.id)}>{surface === 'library' ? <LibraryJourney /> :
                            <AppPaneProvider><ArtifactsBrowser artifacts={[{
                                id: 'layout-note', title: 'Layout note', isDecrypted: true,
                                header: { title: 'Layout note' }, headerVersion: 1, bodyVersion: 1,
                                seq: 1, body: 'A note', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain',
                            }]} loaded loadFailed={false} onRetry={() => {}} usage={null} /></AppPaneProvider>
                        }</DestinationInstanceHost>
                </AppShellMaterialFrame>;
            }}</WorkspaceProvider></ModalProvider>
        </UniversalSearchRuntimeProvider></InjectedAuthProvider>
    </SafeAreaProvider></WorkspaceBrowserPresentation>);
}
async function switchAccount() {
    switchLibraryAccount();
    const scope = storage.getState().profileScope;
    if (!scope) throw new Error('Library Account scope unavailable');
    await TokenStorage.setCredentialsForServerUrl('http://library-browser.test', { serverId: scope.serverId }, { token: 'header.eyJzdWIiOiJhY2NvdW50LWIifQ==.signature' });
    storage.getState().activateProfileScope({ serverId: scope.serverId, accountId: 'account-b' });
}
function reactivateRuntime() {
    publishAppliedActiveServerRuntimeAvailability(false);
    publishAppliedActiveServerSnapshot(getAppliedActiveServerSnapshot());
}
Object.assign(globalThis, { libraryHarness: { mount, settleDeletion: settleLibraryDeletion, deletionPending: isLibraryDeletionPending, switchAccount, reactivateRuntime } });
