import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import type { TranslationKey } from '@/text';

import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import type { DeclaredSettingsWrite } from '@/components/settings/shell/useSettingActionFeedback';

type ActivitySurfaceChoice<T extends string | number> = Readonly<{
    value: T;
    titleKey: TranslationKey;
}>;

type ActivitySurfacesSettingsSectionProps = Readonly<{
    localSettings: Pick<LocalSettings,
        | 'activitySurfacesEnabled'
        | 'liveActivitiesEnabled'
        | 'widgetsEnabled'
        | 'liveActivitiesStrategy'
        | 'activitySurfaceTapTarget'
        | 'activitySurfacePrivacyMode'
        | 'liveActivitiesMode'
        | 'liveActivitiesMaxConcurrent'
        | 'liveActivitiesShowPreviewText'
        | 'liveActivitiesAllowActionButtons'
        | 'liveActivitiesIncludeReady'
        | 'liveActivitiesIncludeThinking'
        | 'widgetsPresetMode'
        | 'widgetsShowPreviewText'
        | 'widgetsShowMachinePath'
    >;
    setSetting: DeclaredSettingsWrite;
    renderMode?: 'all' | 'shared_only';
}>;

const ACTIVITY_SURFACE_TAP_TARGET_OPTIONS: readonly ActivitySurfaceChoice<'open_session' | 'open_sessions'>[] = [
    {
        value: 'open_session',
        titleKey: 'settingsNotifications.activitySurfaces.tapTargetOpenSessionTitle',
    },
    {
        value: 'open_sessions',
        titleKey: 'settingsNotifications.activitySurfaces.tapTargetOpenSessionsTitle',
    },
];

const ACTIVITY_SURFACE_PRIVACY_OPTIONS: readonly ActivitySurfaceChoice<'status_only' | 'title_only' | 'include_preview'>[] = [
    {
        value: 'status_only',
        titleKey: 'settingsNotifications.activitySurfaces.privacyStatusOnlyTitle',
    },
    {
        value: 'title_only',
        titleKey: 'settingsNotifications.activitySurfaces.privacyTitleOnlyTitle',
    },
    {
        value: 'include_preview',
        titleKey: 'settingsNotifications.activitySurfaces.privacyIncludePreviewTitle',
    },
];

const LIVE_ACTIVITY_MODE_OPTIONS: readonly ActivitySurfaceChoice<'focused' | 'attention' | 'running'>[] = [
    {
        value: 'focused',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.focusedTitle',
    },
    {
        value: 'attention',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.attentionTitle',
    },
    {
        value: 'running',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.runningTitle',
    },
];

const LIVE_ACTIVITY_STRATEGY_OPTIONS: readonly ActivitySurfaceChoice<'dynamic_primary' | 'pinned_primary' | 'session_specific'>[] = [
    {
        value: 'dynamic_primary',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.dynamicPrimaryTitle',
    },
    {
        value: 'pinned_primary',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.pinnedPrimaryTitle',
    },
    {
        value: 'session_specific',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.sessionSpecificTitle',
    },
];

const LIVE_ACTIVITY_MAX_CONCURRENT_OPTIONS: readonly ActivitySurfaceChoice<1 | 2 | 4>[] = [
    {
        value: 1,
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentOneTitle',
    },
    {
        value: 2,
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTwoTitle',
    },
    {
        value: 4,
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentFourTitle',
    },
];

const HOME_SCREEN_WIDGET_MODE_OPTIONS: readonly ActivitySurfaceChoice<'summary' | 'attention' | 'running'>[] = [
    {
        value: 'summary',
        titleKey: 'settingsNotifications.activitySurfaces.widgets.summaryTitle',
    },
    {
        value: 'attention',
        titleKey: 'settingsNotifications.activitySurfaces.widgets.attentionTitle',
    },
    {
        value: 'running',
        titleKey: 'settingsNotifications.activitySurfaces.widgets.runningTitle',
    },
];

/**
 * One choice among an activity-surface option table. `segmented` for short labels; `select` (the page
 * field select) where the labels would not fit beside each other on a phone (R5: segmented is for
 * 2–4 short options).
 */
function ActivitySurfaceChoiceRow<T extends string | number>(props: Readonly<{
    setting: SettingRef;
    subtitle?: string;
    testIDPrefix: string;
    choices: readonly ActivitySurfaceChoice<T>[];
    disabled: boolean;
    selectedValue: T;
    onSelect: (value: T) => void;
    control?: 'segmented' | 'select';
    /** Injected by the enclosing `ItemGroup`. */
    showDivider?: boolean;
}>) {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const select = (next: string) => {
        const choice = props.choices.find((candidate) => String(candidate.value) === next);
        if (choice) props.onSelect(choice.value);
    };
    if (props.control === 'select') {
        return (
            <SettingAnchor setting={props.setting} showDivider={props.showDivider}>
                <DropdownMenu
                    testID={props.testIDPrefix}
                    open={menuOpen}
                    onOpenChange={(next) => setMenuOpen(props.disabled ? false : next)}
                    selectedId={String(props.selectedValue)}
                    items={props.choices.map((choice) => ({ id: String(choice.value), title: t(choice.titleKey) }))}
                    onSelect={(id) => {
                        setMenuOpen(false);
                        select(id);
                    }}
                    itemTrigger={{
                        title: t(props.setting.titleKey),
                        subtitle: props.subtitle,
                        showSelectedSubtitle: false,
                        itemProps: { disabled: props.disabled, testID: `${props.testIDPrefix}-trigger` },
                    }}
                />
            </SettingAnchor>
        );
    }
    const options = props.choices.map((choice) => ({ id: String(choice.value), label: t(choice.titleKey) }));
    return (
        <SettingAnchor setting={props.setting} showDivider={props.showDivider}>
            <SegmentedChoiceItem<string>
                testID={props.testIDPrefix}
                testIDPrefix={props.testIDPrefix}
                title={t(props.setting.titleKey)}
                subtitle={props.subtitle}
                disabled={props.disabled}
                options={options}
                value={String(props.selectedValue)}
                onChange={select}
            />
        </SettingAnchor>
    );
}

export const ActivitySurfacesSettingsSection = React.memo(function ActivitySurfacesSettingsSection({
    localSettings,
    setSetting,
    renderMode = 'all',
}: ActivitySurfacesSettingsSectionProps) {
    const activitySurfacesEnabled = localSettings.activitySurfacesEnabled !== false;
    const liveActivitiesEnabled = localSettings.liveActivitiesEnabled !== false;
    const widgetsEnabled = localSettings.widgetsEnabled !== false;
    const showPlatformSpecificSections = renderMode === 'all';
    const liveActivitiesConcurrencyEnabled =
        activitySurfacesEnabled
        && liveActivitiesEnabled
        && localSettings.liveActivitiesStrategy === 'session_specific';

    return (
        <>
            <ItemGroup
                title={t('settingsNotifications.activitySurfaces.title')}
                description={t('settingsNotifications.activitySurfaces.footer')}
            >
                <SettingRow
                    testID="settings-notifications-activity-surfaces-enabled"
                    setting={NOTIFICATIONS_SETTINGS.settings.enabled}
                    rightElement={(
                        <Switch
                            value={activitySurfacesEnabled}
                            onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.enabled, Boolean(value)); }}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.activitySurfaces.shared.title')}
                description={t('settingsNotifications.activitySurfaces.shared.footer')}
            >
                <ActivitySurfaceChoiceRow
                    setting={NOTIFICATIONS_SETTINGS.settings.tapTarget}
                    testIDPrefix="settings-notifications-activity-tap-target"
                    control="select"
                    choices={ACTIVITY_SURFACE_TAP_TARGET_OPTIONS}
                    disabled={!activitySurfacesEnabled}
                    selectedValue={localSettings.activitySurfaceTapTarget}
                    onSelect={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.tapTarget, value); }}
                />
                <ActivitySurfaceChoiceRow
                    setting={NOTIFICATIONS_SETTINGS.settings.privacy}
                    testIDPrefix="settings-notifications-activity-privacy"
                    control="select"
                    choices={ACTIVITY_SURFACE_PRIVACY_OPTIONS}
                    disabled={!activitySurfacesEnabled}
                    selectedValue={localSettings.activitySurfacePrivacyMode}
                    onSelect={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.privacy, value); }}
                />
            </ItemGroup>

            {showPlatformSpecificSections ? (
                <>
                    <ItemGroup
                        title={t('settingsNotifications.activitySurfaces.liveActivities.title')}
                        description={t('settingsNotifications.activitySurfaces.liveActivities.footer')}
                    >
                        <SettingRow
                            testID="settings-notifications-live-activities-enabled"
                            setting={NOTIFICATIONS_SETTINGS.settings.liveActivitiesEnabled}
                            rightElement={(
                                <Switch
                                    value={liveActivitiesEnabled}
                                    disabled={!activitySurfacesEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.liveActivitiesEnabled, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                        <ActivitySurfaceChoiceRow
                            setting={NOTIFICATIONS_SETTINGS.settings.strategy}
                            subtitle={t('settingsNotifications.activitySurfaces.liveActivities.strategySubtitle')}
                            testIDPrefix="settings-notifications-live-activities-strategy"
                            control="select"
                            choices={LIVE_ACTIVITY_STRATEGY_OPTIONS}
                            disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                            selectedValue={localSettings.liveActivitiesStrategy}
                            onSelect={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.strategy, value); }}
                        />
                        <ActivitySurfaceChoiceRow
                            setting={NOTIFICATIONS_SETTINGS.settings.presentation}
                            subtitle={t('settingsNotifications.activitySurfaces.liveActivities.presentationSubtitle')}
                            testIDPrefix="settings-notifications-live-activities-mode"
                            control="select"
                            choices={LIVE_ACTIVITY_MODE_OPTIONS}
                            disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                            selectedValue={localSettings.liveActivitiesMode}
                            onSelect={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.presentation, value); }}
                        />
                        <ActivitySurfaceChoiceRow
                            setting={NOTIFICATIONS_SETTINGS.settings.maxConcurrent}
                            subtitle={liveActivitiesConcurrencyEnabled ? undefined : t('settingsNotifications.activitySurfaces.liveActivities.maxConcurrentNeedsSessionSpecific')}
                            testIDPrefix="settings-notifications-live-activities-max-concurrent"
                            choices={LIVE_ACTIVITY_MAX_CONCURRENT_OPTIONS}
                            disabled={!liveActivitiesConcurrencyEnabled}
                            selectedValue={localSettings.liveActivitiesMaxConcurrent}
                            onSelect={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.maxConcurrent, value); }}
                        />
                        <SettingRow
                            setting={NOTIFICATIONS_SETTINGS.settings.previewText}
                            rightElement={(
                                <Switch
                                    value={localSettings.liveActivitiesShowPreviewText !== false}
                                    disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.previewText, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                        <SettingRow
                            setting={NOTIFICATIONS_SETTINGS.settings.actionButtons}
                            rightElement={(
                                <Switch
                                    value={localSettings.liveActivitiesAllowActionButtons !== false}
                                    disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.actionButtons, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                        <SettingRow
                            setting={NOTIFICATIONS_SETTINGS.settings.includeReady}
                            rightElement={(
                                <Switch
                                    value={localSettings.liveActivitiesIncludeReady !== false}
                                    disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.includeReady, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                        <SettingRow
                            setting={NOTIFICATIONS_SETTINGS.settings.includeThinking}
                            rightElement={(
                                <Switch
                                    value={localSettings.liveActivitiesIncludeThinking !== false}
                                    disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.includeThinking, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                    </ItemGroup>

                    <ItemGroup
                        title={t('settingsNotifications.activitySurfaces.widgets.title')}
                        description={t('settingsNotifications.activitySurfaces.widgets.footer')}
                    >
                        <SettingRow
                            testID="settings-notifications-home-screen-widgets-enabled"
                            setting={NOTIFICATIONS_SETTINGS.settings.widgetsEnabled}
                            rightElement={(
                                <Switch
                                    value={widgetsEnabled}
                                    disabled={!activitySurfacesEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.widgetsEnabled, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                        <ActivitySurfaceChoiceRow
                            setting={NOTIFICATIONS_SETTINGS.settings.widgetsMode}
                            testIDPrefix="settings-notifications-widgets-mode"
                            control="select"
                            choices={HOME_SCREEN_WIDGET_MODE_OPTIONS}
                            disabled={!activitySurfacesEnabled || !widgetsEnabled}
                            selectedValue={localSettings.widgetsPresetMode}
                            onSelect={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.widgetsMode, value); }}
                        />
                        <SettingRow
                            setting={NOTIFICATIONS_SETTINGS.settings.widgetsPreviewText}
                            rightElement={(
                                <Switch
                                    value={localSettings.widgetsShowPreviewText !== false}
                                    disabled={!activitySurfacesEnabled || !widgetsEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.widgetsPreviewText, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                        <SettingRow
                            setting={NOTIFICATIONS_SETTINGS.settings.machinePath}
                            rightElement={(
                                <Switch
                                    value={localSettings.widgetsShowMachinePath !== false}
                                    disabled={!activitySurfacesEnabled || !widgetsEnabled}
                                    onValueChange={(value) => { void setSetting(NOTIFICATIONS_SETTINGS.settings.machinePath, Boolean(value)); }}
                                />
                            )}
                            showChevron={false}
                        />
                    </ItemGroup>
                </>
            ) : null}
        </>
    );
});
