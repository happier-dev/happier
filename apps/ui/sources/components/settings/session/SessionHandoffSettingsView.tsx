import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';
import {
    normalizeSessionHandoffDefaults,
    parseSessionHandoffIgnoredIncludeGlobs,
    SESSION_HANDOFF_ADVANCED_WORKSPACE_SYNC_MODE_OPTIONS,
    SESSION_HANDOFF_COMMON_WORKSPACE_SYNC_MODE_OPTIONS,
    SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS,
    SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS,
    SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS,
    type SessionHandoffDefaultsV1,
    type SessionHandoffWorkspaceMode,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { useSetting } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { WorkspaceSyncRelationshipList } from '@/components/workspaces/sync/WorkspaceSyncRelationshipList';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { HANDOFF_SETTINGS } from '@/components/settings/session/handoffSettings';

/** Rows inside the Advanced disclosure: a search reveal of one of them opens it. */
const ADVANCED_SETTINGS = [
    HANDOFF_SETTINGS.settings.mode,
    HANDOFF_SETTINGS.settings.includeIgnoredMode,
    HANDOFF_SETTINGS.settings.ignoredIncludeGlobs,
];

export const SessionHandoffSettingsView = React.memo(function SessionHandoffSettingsView() {
    const rawDefaults = useSetting('sessionHandoffDefaultsV1');
    const { setSetting } = useSettingActionFeedback();
    const defaults = React.useMemo(() => normalizeSessionHandoffDefaults(rawDefaults), [rawDefaults]);
    const advancedModeActive = defaults.workspaceSyncMode === 'mirror_exactly' || defaults.workspaceSyncMode === 'keep_both_in_sync';
    // Open on arrival when something inside needs attention: an advanced mode is in force,
    // or "Include selected" needs its patterns (a required field is never hidden).
    const [advancedExpanded, setAdvancedExpanded] = React.useState(
        advancedModeActive
        || defaults.includeIgnoredMode === 'include_selected',
    );

    const selectedWorkspaceMode = React.useMemo(
        () => SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS.find((option) => option.id === defaults.workspaceSyncMode)
            ?? SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS[0],
        [defaults.workspaceSyncMode],
    );
    const selectedIgnoredMode = SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS.find((option) => option.id === defaults.includeIgnoredMode)
        ?? SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS[0];
    const advancedSummary = [
        advancedModeActive ? t(selectedWorkspaceMode.titleKey) : null,
        t(selectedIgnoredMode.titleKey),
    ].filter(Boolean).join(' · ');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.handoff.pageDescription')} />
            {/* The globs row exists only while ignored files are "Include selected"; the section answers otherwise. */}
            <SettingSection section={HANDOFF_SETTINGS.sectionRefs.workspace}>
            <ItemGroup
                title={t('settingsSessionPages.handoff.workspaceSection')}
                description={t('settingsSessionPages.handoff.workspaceDescription')}
            >
                <SettingAnchor setting={HANDOFF_SETTINGS.settings.workspaceMode}>
                    <SegmentedChoiceItem<SessionHandoffWorkspaceMode>
                        subtitleLines={0}
                        testID="session-handoff-workspace-sync-mode-trigger"
                        testIDPrefix="session-handoff-workspace-sync-mode"
                        title={t(HANDOFF_SETTINGS.settings.workspaceMode.titleKey)}
                        // An advanced mode is chosen in the disclosure below; this row then describes it.
                        subtitle={t(selectedWorkspaceMode.subtitleKey)}
                        options={SESSION_HANDOFF_COMMON_WORKSPACE_SYNC_MODE_OPTIONS.map((item) => ({
                            id: item.id,
                            label: item.id === 'keep_synced' ? t('settingsSessionPages.handoff.keepUpdated') : t(item.titleKey),
                            description: t(item.subtitleKey),
                        }))}
                        value={defaults.workspaceSyncMode}
                        onChange={(nextMode) => { void setSetting(HANDOFF_SETTINGS.settings.workspaceMode, nextMode); }}
                    />
                </SettingAnchor>
                <SettingAnchor settings={ADVANCED_SETTINGS}><ExpandableItem
                    testID="session-handoff-settings-advanced"
                    expanded={advancedExpanded}
                    onExpandedChange={setAdvancedExpanded}
                    header={({ headerProps }) => (
                        <Item
                            {...headerProps}
                            title={t('settingsSession.handoff.advanced.title')}
                            subtitle={t('settingsSession.handoff.advanced.subtitle')}
                            detail={advancedExpanded ? undefined : advancedSummary}
                        />
                    )}
                >
                    <SettingAnchor setting={HANDOFF_SETTINGS.settings.mode}>
                        <SegmentedChoiceItem<SessionHandoffWorkspaceMode>
                            subtitleLines={0}
                            testID="session-handoff-settings-advanced-mode-trigger"
                            testIDPrefix="session-handoff-settings-advanced-mode"
                            title={t(HANDOFF_SETTINGS.settings.mode.titleKey)}
                            subtitle={t('settingsSessionPages.handoff.advancedModeDescription')}
                            options={SESSION_HANDOFF_ADVANCED_WORKSPACE_SYNC_MODE_OPTIONS.map((item) => ({
                                id: item.id,
                                label: t(item.titleKey),
                                description: t(item.subtitleKey),
                            }))}
                            value={defaults.workspaceSyncMode}
                            onChange={(nextMode) => { void setSetting(HANDOFF_SETTINGS.settings.mode, nextMode); }}
                        />
                    </SettingAnchor>
                    <SettingAnchor setting={HANDOFF_SETTINGS.settings.includeIgnoredMode}>
                        <SegmentedChoiceItem<SessionHandoffDefaultsV1['includeIgnoredMode']>
                            subtitleLines={0}
                            testID="session-handoff-ignored-mode-trigger"
                            testIDPrefix="session-handoff-ignored-mode"
                            title={t(HANDOFF_SETTINGS.settings.includeIgnoredMode.titleKey)}
                            options={SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS.map((item) => ({
                                id: item.id,
                                label: item.id === 'exclude'
                                    ? t('settingsSessionPages.handoff.ignoredExclude')
                                    : t('settingsSessionPages.handoff.ignoredIncludeSelected'),
                                description: t(item.subtitleKey),
                            }))}
                            value={defaults.includeIgnoredMode}
                            onChange={(nextMode) => { void setSetting(HANDOFF_SETTINGS.settings.includeIgnoredMode, nextMode); }}
                        />
                    </SettingAnchor>
                    {defaults.includeIgnoredMode === 'include_selected' ? (
                        <SettingAnchor setting={HANDOFF_SETTINGS.settings.ignoredIncludeGlobs}>
                            <FieldValueItem
                                title={t(HANDOFF_SETTINGS.settings.ignoredIncludeGlobs.titleKey)}
                                placeholder={t('settingsSession.handoff.includeIgnoredMode.globsPlaceholder')}
                                monospace
                                // The shared field keeps an unfinished comma while typing and follows the stored
                                // list when it changes elsewhere; the list is normalized only here, on commit.
                                value={defaults.ignoredIncludeGlobs.join(', ')}
                                onCommit={(draft) => {
                                    const patterns = parseSessionHandoffIgnoredIncludeGlobs(draft);
                                    void setSetting(HANDOFF_SETTINGS.settings.ignoredIncludeGlobs, patterns);
                                    return patterns.join(', ');
                                }}
                            />
                        </SettingAnchor>
                    ) : null}
                </ExpandableItem></SettingAnchor>
            </ItemGroup>
            </SettingSection>

            <ItemGroup
                title={t('settingsSession.handoff.directTargetMode.groupTitle')}
                description={t('settingsSession.handoff.directTargetMode.groupFooter')}
            >
                <SettingAnchor setting={HANDOFF_SETTINGS.settings.directTargetMode}>
                    <SegmentedChoiceItem<SessionHandoffDefaultsV1['directTargetMode']>
                        subtitleLines={0}
                        testID="session-handoff-direct-target-mode"
                        testIDPrefix="session-handoff-direct-target-mode"
                        title={t(HANDOFF_SETTINGS.settings.directTargetMode.titleKey)}
                        options={SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS.map((item) => ({
                            id: item.id,
                            label: t(item.titleKey),
                            description: t(item.subtitleKey),
                        }))}
                        value={defaults.directTargetMode}
                        onChange={(nextMode) => { void setSetting(HANDOFF_SETTINGS.settings.directTargetMode, nextMode); }}
                    />
                </SettingAnchor>
            </ItemGroup>

            <WorkspaceSyncRelationshipList />
        </ItemList>
    );
});

export default SessionHandoffSettingsView;
