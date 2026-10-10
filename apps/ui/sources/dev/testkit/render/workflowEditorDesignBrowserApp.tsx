import '@/unistyles';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { WorkflowEditorBody } from '@/components/workflows/screens/WorkflowEditorBody';
import { WorkflowEditorHostScreen } from '@/components/workflows/screens/WorkflowEditorHostScreen';
import { createWorkflowEditorDraft, insertWorkflowEditorBlock } from '@/sync/domains/workflows/workflowEditorDraft';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { WorkspaceBrowserPresentation } from './WorkspaceBrowserPresentation';

const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, friends: false, inbox: false, externalSessions: false } });

function Editor() {
    const [draft, setDraft] = React.useState(() => insertWorkflowEditorBlock(createWorkflowEditorDraft({
        draftId: 'design12-wait', name: 'Release check', blocks: [],
    }), { request: { kind: 'wait' }, list: { kind: 'root' } }).draft);
    const [selectedBlockId, selectBlock] = React.useState<string | null>(null);
    const [view, setView] = React.useState<'steps' | 'flow'>('steps');
    return <WorkflowEditorBody draft={draft} onChange={setDraft} machineName={null}
        selectedBlockId={selectedBlockId} onSelectBlock={selectBlock} onCustomizeBlock={selectBlock}
        view={view} onChangeView={setView} composerScope={{ kind: 'machine', machineId: null }}
        onRunNow={() => {}} onSave={() => {}} />;
}

/** Real editor and workspace owners; only the browser viewport/theme are supplied by the fixture. */
function mount(phone: boolean, theme: 'light' | 'dark', state: 'wait' | 'lost-copy') {
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(theme);
    publishAppliedActiveServerSnapshot({ serverId: 'home-a', serverUrl: location.origin, generation: 0 });
    storage.setState({ profileScope: { serverId: 'home-a', accountId: 'alice' }, isDataReady: true,
        settings: settingsDefaults, authoringMemory: authoringMemoryDefaults, machines: {}, machineListByServerId: {} });
    createRoot(document.getElementById('root')!).render(<WorkspaceBrowserPresentation><SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }}><InjectedAuthProvider credentials={null}><AppPaneProvider><WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>{navigation => {
        const group = navigation.state.groups[navigation.state.focusedGroupId];
        const tab = navigation.state.tabs[group.activeTabId];
        return <AppShellMaterialFrame showChrome={!phone} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
            titleStrip={null} rail={null} column={null} peek={null}>
        <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/workflows/new" focused visible
            phone={phone} navigation={navigation.navigationForTab(tab.id)}>
            <View style={{ flex: 1, height: window.innerHeight }}>{state === 'wait' ? <Editor />
                : <WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: 'lost-copy' }} />}</View>
        </DestinationInstanceHost></AppShellMaterialFrame>;
    }}</WorkspaceProvider></AppPaneProvider></InjectedAuthProvider></SafeAreaProvider></WorkspaceBrowserPresentation>);
}

Object.assign(globalThis, { editorHarness: { mount } });
