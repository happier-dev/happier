import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import type { TranslationKey } from '@/text';

import type { LocalSettings } from '@/sync/domains/settings/localSettings';

type ActivitySurfaceChoice<T extends string | number> = Readonly<{
    value: T;
    titleKey: TranslationKey;
    icon: string;
}>;

type ActivitySurfacesSettingsSectionProps = Readonly<{
    localSettings: LocalSettings;
    setLocalSetting: (delta: Partial<LocalSettings>) => void;
}>;

const ACTIVITY_SURFACE_TAP_TARGET_OPTIONS: readonly ActivitySurfaceChoice<'open_session' | 'open_sessions'>[] = [
    {
        value: 'open_session',
        titleKey: 'settingsNotifications.activitySurfaces.tapTargetOpenSessionTitle',
        icon: 'arrow-forward-outline',
    },
    {
        value: 'open_sessions',
        titleKey: 'settingsNotifications.activitySurfaces.tapTargetOpenSessionsTitle',
        icon: 'albums-outline',
    },
];

const ACTIVITY_SURFACE_PRIVACY_OPTIONS: readonly ActivitySurfaceChoice<'status_only' | 'title_only' | 'include_preview'>[] = [
    {
        value: 'status_only',
        titleKey: 'settingsNotifications.activitySurfaces.privacyStatusOnlyTitle',
        icon: 'shield-checkmark-outline',
    },
    {
        value: 'title_only',
        titleKey: 'settingsNotifications.activitySurfaces.privacyTitleOnlyTitle',
        icon: 'text-outline',
    },
    {
        value: 'include_preview',
        titleKey: 'settingsNotifications.activitySurfaces.privacyIncludePreviewTitle',
        icon: 'chatbubble-ellipses-outline',
    },
];

const LIVE_ACTIVITY_MODE_OPTIONS: readonly ActivitySurfaceChoice<'focused' | 'attention' | 'running'>[] = [
    {
        value: 'focused',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.focusedTitle',
        icon: 'locate-outline',
    },
    {
        value: 'attention',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.attentionTitle',
        icon: 'alert-circle-outline',
    },
    {
        value: 'running',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.runningTitle',
        icon: 'pulse-outline',
    },
];

const LIVE_ACTIVITY_MAX_CONCURRENT_OPTIONS: readonly ActivitySurfaceChoice<1 | 2 | 4>[] = [
    {
        value: 1,
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentOneTitle',
        icon: 'ellipse-outline',
    },
    {
        value: 2,
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTwoTitle',
        icon: 'layers-outline',
    },
    {
        value: 4,
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentFourTitle',
        icon: 'grid-outline',
    },
];

const HOME_SCREEN_WIDGET_MODE_OPTIONS: readonly ActivitySurfaceChoice<'summary' | 'attention' | 'running'>[] = [
    {
        value: 'summary',
        titleKey: 'settingsNotifications.activitySurfaces.widgets.summaryTitle',
        icon: 'list-outline',
    },
    {
        value: 'attention',
        titleKey: 'settingsNotifications.activitySurfaces.widgets.attentionTitle',
        icon: 'alert-circle-outline',
    },
    {
        value: 'running',
        titleKey: 'settingsNotifications.activitySurfaces.widgets.runningTitle',
        icon: 'pulse-outline',
    },
];

function renderChoiceRows<T extends string | number>(
    choices: readonly ActivitySurfaceChoice<T>[],
    params: {
        disabled: boolean;
        selectedValue: T;
        onSelect: (value: T) => void;
        color: string;
    },
) {
    return choices.map((choice) => (
        <Item
            key={String(choice.value)}
            title={t(choice.titleKey)}
            icon={<Ionicons name={choice.icon as keyof typeof Ionicons.glyphMap} size={29} color={params.color} />}
            selected={params.selectedValue === choice.value}
            disabled={params.disabled}
            onPress={() => params.onSelect(choice.value)}
            showChevron={false}
        />
    ));
}

export const ActivitySurfacesSettingsSection = React.memo(function ActivitySurfacesSettingsSection({
    localSettings,
    setLocalSetting,
}: ActivitySurfacesSettingsSectionProps) {
    const { theme } = useUnistyles();

    const activitySurfacesEnabled = localSettings.activitySurfacesEnabled !== false;
    const liveActivitiesEnabled = localSettings.iosLiveActivitiesEnabled !== false;
    const widgetsEnabled = localSettings.iosWidgetsEnabled !== false;

    return (
        <>
            <ItemGroup
                title={t('settingsNotifications.activitySurfaces.title')}
                footer={t('settingsNotifications.activitySurfaces.footer')}
            >
                <Item
                    testID="settings-notifications-activity-surfaces-enabled"
                    title={t('common.enabled')}
                    subtitle={t('settingsNotifications.activitySurfaces.enabledSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={activitySurfacesEnabled}
                            onValueChange={(value) => setLocalSetting({ activitySurfacesEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.activitySurfaces.shared.title')}
                footer={t('settingsNotifications.activitySurfaces.shared.footer')}
            >
                <Item
                    title={t('settingsNotifications.activitySurfaces.tapTargetTitle')}
                    icon={<Ionicons name="arrow-forward-outline" size={29} color={theme.colors.textSecondary} />}
                    disabled={!activitySurfacesEnabled}
                    showChevron={false}
                />
                {renderChoiceRows(ACTIVITY_SURFACE_TAP_TARGET_OPTIONS, {
                    disabled: !activitySurfacesEnabled,
                    selectedValue: localSettings.activitySurfaceTapTarget,
                    onSelect: (value) => setLocalSetting({ activitySurfaceTapTarget: value }),
                    color: theme.colors.accent.blue,
                })}
                <Item
                    title={t('settingsNotifications.activitySurfaces.privacyTitle')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.textSecondary} />}
                    disabled={!activitySurfacesEnabled}
                    showChevron={false}
                />
                {renderChoiceRows(ACTIVITY_SURFACE_PRIVACY_OPTIONS, {
                    disabled: !activitySurfacesEnabled,
                    selectedValue: localSettings.activitySurfacePrivacyMode,
                    onSelect: (value) => setLocalSetting({ activitySurfacePrivacyMode: value }),
                    color: theme.colors.accent.blue,
                })}
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.activitySurfaces.liveActivities.title')}
                footer={t('settingsNotifications.activitySurfaces.liveActivities.footer')}
            >
                <Item
                    testID="settings-notifications-live-activities-enabled"
                    title={t('common.enabled')}
                    subtitle={t('settingsNotifications.activitySurfaces.liveActivities.enabledSubtitle')}
                    icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={liveActivitiesEnabled}
                            disabled={!activitySurfacesEnabled}
                            onValueChange={(value) => setLocalSetting({ iosLiveActivitiesEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                {renderChoiceRows(LIVE_ACTIVITY_MODE_OPTIONS, {
                    disabled: !activitySurfacesEnabled || !liveActivitiesEnabled,
                    selectedValue: localSettings.liveActivitiesMode,
                    onSelect: (value) => setLocalSetting({ liveActivitiesMode: value }),
                    color: theme.colors.accent.blue,
                })}
                <Item
                    title={t('settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTitle')}
                    icon={<Ionicons name="layers-outline" size={29} color={theme.colors.textSecondary} />}
                    disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                    showChevron={false}
                />
                {renderChoiceRows(LIVE_ACTIVITY_MAX_CONCURRENT_OPTIONS, {
                    disabled: !activitySurfacesEnabled || !liveActivitiesEnabled,
                    selectedValue: localSettings.liveActivitiesMaxConcurrent,
                    onSelect: (value) => setLocalSetting({ liveActivitiesMaxConcurrent: value }),
                    color: theme.colors.accent.blue,
                })}
                <Item
                    title={t('settingsNotifications.activitySurfaces.liveActivities.previewTextTitle')}
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.liveActivitiesShowPreviewText !== false}
                            disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                            onValueChange={(value) => setLocalSetting({ liveActivitiesShowPreviewText: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.activitySurfaces.liveActivities.actionButtonsTitle')}
                    icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.liveActivitiesAllowActionButtons !== false}
                            disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                            onValueChange={(value) => setLocalSetting({ liveActivitiesAllowActionButtons: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.activitySurfaces.liveActivities.includeReadyTitle')}
                    icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.liveActivitiesIncludeReady !== false}
                            disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                            onValueChange={(value) => setLocalSetting({ liveActivitiesIncludeReady: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.activitySurfaces.liveActivities.includeThinkingTitle')}
                    icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.liveActivitiesIncludeThinking !== false}
                            disabled={!activitySurfacesEnabled || !liveActivitiesEnabled}
                            onValueChange={(value) => setLocalSetting({ liveActivitiesIncludeThinking: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.activitySurfaces.widgets.title')}
                footer={t('settingsNotifications.activitySurfaces.widgets.footer')}
            >
                <Item
                    testID="settings-notifications-home-screen-widgets-enabled"
                    title={t('common.enabled')}
                    subtitle={t('settingsNotifications.activitySurfaces.widgets.enabledSubtitle')}
                    icon={<Ionicons name="grid-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={widgetsEnabled}
                            disabled={!activitySurfacesEnabled}
                            onValueChange={(value) => setLocalSetting({ iosWidgetsEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                {renderChoiceRows(HOME_SCREEN_WIDGET_MODE_OPTIONS, {
                    disabled: !activitySurfacesEnabled || !widgetsEnabled,
                    selectedValue: localSettings.homeScreenWidgetsMode,
                    onSelect: (value) => setLocalSetting({ homeScreenWidgetsMode: value }),
                    color: theme.colors.accent.blue,
                })}
                <Item
                    title={t('settingsNotifications.activitySurfaces.widgets.previewTextTitle')}
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.homeScreenWidgetsShowPreviewText !== false}
                            disabled={!activitySurfacesEnabled || !widgetsEnabled}
                            onValueChange={(value) => setLocalSetting({ homeScreenWidgetsShowPreviewText: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.activitySurfaces.widgets.machinePathTitle')}
                    icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.homeScreenWidgetsShowMachinePath !== false}
                            disabled={!activitySurfacesEnabled || !widgetsEnabled}
                            onValueChange={(value) => setLocalSetting({ homeScreenWidgetsShowMachinePath: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>
        </>
    );
});
