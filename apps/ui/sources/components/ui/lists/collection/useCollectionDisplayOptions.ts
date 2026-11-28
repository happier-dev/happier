import * as React from 'react';
import type { CollectionArtifactPresentation, CollectionLines, CollectionTableCardPresentation, CollectionWorkflowGrouping, CollectionWorkflowRunGrouping, SessionCollectionRowDetails } from '@happier-dev/protocol/account/settings/accountSettings';
import { useSettingActionFeedback, type DeclaredSettingsWrite } from '@/components/settings/shell/useSettingActionFeedback';
import type { Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';

import { COLLECTION_DISPLAY_SETTING_ANCHOR, readSessionCollectionLines, readSessionCollectionRowDetails } from './collectionDisplaySettings';

const DISPLAY_KEYS = ['collectionDisplayPreferencesV1'] as const;
const readWorkflowPresentation = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflow?.presentation ?? 'table';

const readWorkflowGroupBy = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflow?.groupBy ?? 'source';
const readWorkflowLines = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflow?.lines ?? 2;
const readRunGroupBy = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflowRun?.groupBy ?? 'date';
const readRunLines = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflowRun?.lines ?? 2;
const readSessionDetails = (settings: Settings) => settings.collectionDisplayPreferencesV1.sessionWork?.details;
const readSessionLines = (settings: Settings) => readSessionCollectionLines(settings.sessionListDensity);
const readSessionDensity = (settings: Settings) => settings.sessionListDensity;
const readSessionGroupBy = (settings: Settings) => settings.sessionListLayoutV1;
const readSessionRowContext = (settings: Settings) => settings.sessionListRowContextV1;
const readSessionStatusWords = (settings: Settings) => settings.sessionListStatusWords;
const readWorkflowDetails = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflow?.details;
const readRunDetails = (settings: Settings) => settings.collectionDisplayPreferencesV1.workflowRun?.details;
const readArtifactPresentation = (settings: Settings) => settings.collectionDisplayPreferencesV1.artifact?.presentation;

/** Settings and View offer the details Session rows can draw. Stored details can include other keys. */
export const SESSION_COLLECTION_ROW_DETAILS = [
    { id: 'currentWork', labelKey: 'settingsSession.sessionList.detailCurrentWork' },
    { id: 'progress', labelKey: 'settingsSession.sessionList.detailProgress' },
    { id: 'latestMessage', labelKey: 'settingsSession.sessionList.detailLatestMessage' },
    { id: 'project', labelKey: 'settingsSession.sessionList.detailProject' },
    { id: 'machine', labelKey: 'newSession.wizardSection.machine' },
    { id: 'branch', labelKey: 'settingsSession.sessionList.detailBranch' },
    { id: 'pullRequest', labelKey: 'files.sourceControlOperations.update.pullRequest.title' },
    { id: 'changes', labelKey: 'sessionGitPane.subTabs.changes' },
] as const satisfies readonly Readonly<{ id: keyof SessionCollectionRowDetails; labelKey: string }>[];

export function useSessionCollectionRowDetails(): SessionCollectionRowDetails {
    const details = useSettingsSelector(readSessionDetails, DISPLAY_KEYS, 'collection.display.sessionWork.details');
    const rowContext = useSettingsSelector(readSessionRowContext, ['sessionListRowContextV1'], 'collection.display.sessionWork.rowContext');
    return React.useMemo(() => readSessionCollectionRowDetails(details, rowContext), [details, rowContext]);
}

export function useSessionCollectionRowDetailWriter() {
    const { setSetting } = useSettingActionFeedback();
    return React.useCallback((id: keyof SessionCollectionRowDetails, enabled: boolean) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind: 'sessionWork', details: { [id]: enabled } }, { confirmed: true }), [setSetting]);
}

export function useSessionCollectionLines(): CollectionLines {
    return useSettingsSelector(readSessionLines, ['sessionListDensity'], 'collection.display.sessionWork.lines');
}

export function useSessionCollectionDensity(): Settings['sessionListDensity'] {
    return useSettingsSelector(readSessionDensity, ['sessionListDensity'], 'collection.display.sessionWork.density');
}

export function useSessionCollectionGroupBy(): Settings['sessionListLayoutV1'] {
    return useSettingsSelector(readSessionGroupBy, ['sessionListLayoutV1'], 'collection.display.sessionWork.groupBy');
}

export function useSessionCollectionStatusWords(): boolean {
    return useSettingsSelector(readSessionStatusWords, ['sessionListStatusWords'], 'collection.display.sessionWork.statusWords');
}

function usePluginDetailOptions(kind: 'workflow' | 'workflowRun', setSetting: DeclaredSettingsWrite) {
    const details = useSettingsSelector(kind === 'workflow' ? readWorkflowDetails : readRunDetails, DISPLAY_KEYS,
        kind === 'workflow' ? 'collection.display.workflow.details' : 'collection.display.workflowRun.details');
    const setDetail = React.useCallback((id: string, enabled: boolean) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind, details: { [id]: enabled } }, { confirmed: true }), [kind, setSetting]);
    return { details, setDetail };
}

export function useCollectionDisplayOptions(kind: 'workflow', compact: boolean) {
    const preferredPresentation = useSettingsSelector(readWorkflowPresentation, DISPLAY_KEYS, 'collection.display.workflow');
    const groupBy = useSettingsSelector(readWorkflowGroupBy, DISPLAY_KEYS, 'collection.display.workflow.groupBy');
    const lines = useSettingsSelector(readWorkflowLines, DISPLAY_KEYS, 'collection.display.workflow.lines');
    const { setSetting } = useSettingActionFeedback();
    const setPresentation = React.useCallback((presentation: CollectionTableCardPresentation) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind, presentation }, { confirmed: true }), [kind, setSetting]);
    const setGroupBy = React.useCallback((groupBy: CollectionWorkflowGrouping) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind, groupBy }, { confirmed: true }), [kind, setSetting]);
    const setLines = React.useCallback((lines: CollectionLines) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind, lines }, { confirmed: true }), [kind, setSetting]);
    const pluginDetails = usePluginDetailOptions(kind, setSetting);
    return { preferredPresentation, presentation: compact ? 'list' as const : preferredPresentation, setPresentation, groupBy, setGroupBy, lines, setLines, ...pluginDetails };
}

export function useWorkflowRunDisplayOptions() {
    const groupBy = useSettingsSelector(readRunGroupBy, DISPLAY_KEYS, 'collection.display.workflowRun.groupBy');
    const lines = useSettingsSelector(readRunLines, DISPLAY_KEYS, 'collection.display.workflowRun.lines');
    const { setSetting } = useSettingActionFeedback();
    const setGroupBy = React.useCallback((groupBy: CollectionWorkflowRunGrouping) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind: 'workflowRun', groupBy }, { confirmed: true }), [setSetting]);
    const setLines = React.useCallback((lines: CollectionLines) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind: 'workflowRun', lines }, { confirmed: true }), [setSetting]);
    const pluginDetails = usePluginDetailOptions('workflowRun', setSetting);
    return { groupBy, lines, setGroupBy, setLines, ...pluginDetails };
}

export function useArtifactCollectionPresentation(defaultPresentation: CollectionArtifactPresentation) {
    const preferred = useSettingsSelector(readArtifactPresentation, DISPLAY_KEYS, 'collection.display.artifact');
    const { setSetting } = useSettingActionFeedback();
    const setPresentation = React.useCallback((presentation: CollectionArtifactPresentation) =>
        setSetting({ anchor: COLLECTION_DISPLAY_SETTING_ANCHOR }, { kind: 'artifact', presentation }, { confirmed: true }), [setSetting]);
    return [preferred ?? defaultPresentation, setPresentation] as const;
}
