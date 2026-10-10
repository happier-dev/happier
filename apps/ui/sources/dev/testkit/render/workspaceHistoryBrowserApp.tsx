import '@/unistyles';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { storage } from '@/sync/domains/state/storage';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { installWorkspaceBrowserHistory } from '@/components/appShell/workspace/workspaceBrowserTransport';
import { installUrlMirror } from './workspaceHistoryBrowserBoundary';
import { getActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { UnistylesRuntime } from 'react-native-unistyles';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { GlassMaterialRuntime } from '@/components/ui/glass/GlassMaterialRuntime';
import { AccountTriggersSection } from '@/components/workflows/triggers/AccountTriggersSection';
import { ScheduledWorkflowSection } from '@/components/workflows/triggers/ScheduledWorkflowSection';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider } from '@/modal';
import { upsertAndActivateServer, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { failTriggerReads, installWorkflowStatesHttpBoundary } from './workflowStatesHttpBoundary';
import { WorkspaceBrowserPresentation } from './WorkspaceBrowserPresentation';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { View } from 'react-native';

// Preserve Metro's lazy module evaluation while excluding unrelated route chunks.
declare const require: (path: string) => typeof import('./workspaceHistoryLazyEditor');
const LazyEditor = React.lazy(() => Promise.resolve().then(() => require('./workspaceHistoryLazyEditor')));
const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, friends: false, inbox: false, externalSessions: false } });
installWorkspaceBrowserHistory();

export function mount(phone: boolean) {
    storage.setState({ profileScope: { serverId: 'home-a', accountId: 'alice' }, isDataReady: true });
    const root = createRoot(document.getElementById('root')!);
    let current: WorkspaceNavigationContextValue;
    function AppShell() {
        return <WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>{navigation => {
            current = navigation;
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            const tab = navigation.state.tabs[group.activeTabId];
            const editorPathname = tab.target.kind === 'workflow' && tab.target.params.id === 'history-saved'
                ? '/workflows/history-saved' : tab.target.params.workspacePathname;
            const isEditor = editorPathname === '/workflows/new' || editorPathname === '/workflows/history-saved';
            return <AppShellMaterialFrame showChrome={!phone} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
                titleStrip={null} rail={null} column={null} peek={null}>
                {isEditor ? <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={editorPathname} focused visible phone={phone} navigation={navigation.navigationForTab(tab.id)}>
                    <React.Suspense fallback="Opening editor"><LazyEditor navigation={navigation.navigationForTab(tab.id)} /></React.Suspense></DestinationInstanceHost>
                    : <button id="new" onClick={() => navigation.openHref('/workflows/new')}>New</button>}
                <output id="target">{JSON.stringify(tab.target)}</output>
            </AppShellMaterialFrame>;
        }}</WorkspaceProvider>;
    }
    installUrlMirror();
    // Chromium has no device cutout. Supply its actual viewport at the native
    // safe-area boundary; phone chrome and the editor beneath it stay real.
    root.render(<WorkspaceBrowserPresentation><SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }}><AppShell /></SafeAreaProvider></WorkspaceBrowserPresentation>);
    return { open: (href: string) => current.openHref(href), back: () => current.back(),
        ready: () => Boolean(current?.active), read: () => ({ href: location.pathname,
            dirty: getActiveUnsavedChangesGuard()?.isDirtyRef.current,
            draft: document.querySelector('input')?.value, target: document.getElementById('target')?.textContent }) };
}

Object.assign(globalThis, { guardHarness: { mount } });

function ThemeSurface() {
    const [view, setView] = React.useState('steps');
    const phone = window.innerWidth < 500;
    return <WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>{() => <AppShellMaterialFrame showChrome={!phone} dragEnabled={false} leftOffsetPx={0} sidebarWidth={phone ? 0 : 200}
        titleStrip={null} rail={null}
        column={phone ? null : <View nativeID="theme-column"><CollectionListGroupLabel title="Library" first /></View>} peek={null}>
        <View nativeID="theme-content">
            <View nativeID="theme-title"><PageHeader title="Workflow" /></View>
            <SegmentedTabBar testIDPrefix="theme-tabs" presentation="plain" tabs={[{ id: 'steps', label: 'Steps' }, { id: 'flow', label: 'Flow' }]}
                activeTabId={view} onSelectTab={setView} />
            <StatusPill testID="theme-status" variant="attention" label="Needs you" />
            <SurfaceStateCard testID="theme-line-loading" size="line" kind="loading" title="Loading…" animationEnabled={false} />
            <SurfaceStateCard testID="theme-line-error" size="line" kind="error" title="Could not load your triggers." action={{ label: 'Retry', onPress: () => {} }} />
            <AccountTriggersSection />
            <ScheduledWorkflowSection />
        </View>
    </AppShellMaterialFrame>}</WorkspaceProvider>;
}

async function mountThemeSurface() {
    installWorkflowStatesHttpBoundary();
    const home = await upsertAndActivateServer({ serverUrl: 'http://states-browser.test', name: 'States browser' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    await TokenStorage.setCredentialsForServerUrl('http://states-browser.test', { serverId: home.id }, { token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature' });
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-a' }, isDataReady: true,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
    createRoot(document.getElementById('root')!).render(<WorkspaceBrowserPresentation><SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }}><InjectedAuthProvider credentials={null}><GlassMaterialRuntime><ModalProvider><ThemeSurface /></ModalProvider></GlassMaterialRuntime></InjectedAuthProvider></SafeAreaProvider></WorkspaceBrowserPresentation>);
}

Object.assign(globalThis, { themeHarness: {
    mount: (theme: 'light' | 'dark') => {
        UnistylesRuntime.setAdaptiveThemes(false);
        UnistylesRuntime.setTheme(theme);
        return mountThemeSurface();
    },
    switchTheme: (theme: 'light' | 'dark') => UnistylesRuntime.setTheme(theme),
    mountAdaptive: () => {
        UnistylesRuntime.setAdaptiveThemes(true);
        return mountThemeSurface();
    },
    failTriggerReads,
} });
