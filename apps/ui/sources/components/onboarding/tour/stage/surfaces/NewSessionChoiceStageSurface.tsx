import * as React from 'react';
import { View } from 'react-native';

import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';
import { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { createDemoOpenCodeSessionFixture } from '@/demoMode/world/sessions';
import { DEMO_PROJECT_PATH } from '@/demoMode/world/constants';
import { t } from '@/text';

const noop = () => {};

/** New Session's real composer and Agent/model picker; every choice stays inside this stage mount. */
export function NewSessionChoiceStageSurface(): React.ReactElement {
    const [entries] = React.useState(() => getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude', 'codex', 'opencode'] }));
    const [selectedKey, setSelectedKey] = React.useState(() => entries.find(entry => entry.agentId === 'opencode')!.backendTargetKey);
    const [modelId, setModelId] = React.useState('claude-sonnet-4.5');
    const [promptStore] = React.useState(() => createNewSessionPromptStore('Polish the Northstar checkout and review the result.'));
    const popoverBoundaryRef = React.useRef<View>(null);
    const selected = entries.find(entry => entry.backendTargetKey === selectedKey)!;
    const [models] = React.useState(() => createDemoOpenCodeSessionFixture().metadata!.sessionModelsV1!.availableModels.map(model => ({
        value: model.id, label: model.name, description: model.description ?? '',
    })));
    const options = buildSessionAgentPickerOptions({
        entries,
        identityScope: { machineId: null, serverId: null, current: false },
        resolvePresentation: () => ({ disabled: false, muted: false }),
        resolveBehavior: ({ entry }) => ({
            renderDetailContent: () => <SessionModelPicker agentTargetKey={entry.backendTargetKey}
                nativeModels={entry.agentId === 'opencode' ? models : []} providerGroups={[]}
                providerProjectionAuthoritative={false}
                selected={entry.agentId === 'opencode' ? { agentTargetKey: entry.backendTargetKey, providerConnectionId: null, modelId } : null}
                onSelect={ref => {
                    setSelectedKey(entry.backendTargetKey);
                    setModelId(ref?.modelId ?? 'default');
                }} />,
        }),
    });
    const panelProps: NewSessionSimplePanelProps = {
        popoverBoundaryRef,
        headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
        newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0,
        containerStyle: {}, promptStore, setSessionPrompt: value => promptStore.setPrompt(value),
        handleCreateSession: noop, canCreate: false, isCreating: false,
        emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
        agentType: selected.builtInAgentId ?? 'opencode', agentLabel: selected.title,
        handleAgentClick: noop, agentPickerOptions: options,
        agentPickerSelectedOptionId: selected.backendTargetKey,
        onAgentPickerSelect: key => { setSelectedKey(key); setModelId('default'); },
        permissionMode: 'default', handlePermissionModeChange: noop,
        modelMode: modelId, setModelMode: setModelId, modelOptions: models,
        machineName: 'MacBook Pro', selectedPath: DEMO_PROJECT_PATH,
        showResumePicker: false, resumeSessionId: null, isResumeSupportChecking: false,
        useProfiles: false, selectedProfileId: null, connectionStatus: undefined,
    };
    return <ItemList>
        <PageHeader title={t('newSession.title')} />
        <ItemGroup><NewSessionComposerCard panelProps={panelProps} layout="embedded" attachments={false} voiceAffordance="none" /></ItemGroup>
    </ItemList>;
}
