import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { resetDesktopActivityOverlayPosition } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import {
    resolveDesktopOverlayPolicy,
    resolveDesktopOverlaySettingsVisibilityState,
} from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { useLocalSettings } from '@/sync/domains/state/storage';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    ANCHOR_OPTIONS,
    AUTO_HIDE_DELAY_OPTIONS,
    COLLAPSED_CLICK_ACTION_OPTIONS,
    COMPACT_STYLE_OPTIONS,
    DENSITY_OPTIONS,
    EXPANDED_BEHAVIOR_OPTIONS,
    PLACEMENT_MODE_OPTIONS,
    VISIBILITY_MODE_OPTIONS,
} from './DesktopOverlaySettingsSection.options';
import { DesktopOverlayChoiceDropdownRow } from './DesktopOverlayChoiceDropdownRow';

export const DesktopOverlaySettingsSection = React.memo(function DesktopOverlaySettingsSection() {
    const { theme } = useUnistyles();
    const localSettings = useLocalSettings();
    const applyLocalSettings = useApplyLocalSettings();

    const desktopPolicy = React.useMemo(
        () => resolveDesktopOverlayPolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const settingsVisibility = React.useMemo(
        () => resolveDesktopOverlaySettingsVisibilityState(desktopPolicy),
        [desktopPolicy],
    );

    const setLocalSetting = React.useCallback((delta: Partial<LocalSettings>) => {
        applyLocalSettings(delta);
    }, [applyLocalSettings]);

    const handleResetPosition = React.useCallback(() => {
        setLocalSetting({
            desktopOverlayPlacementMode: 'anchored',
            desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0,
            desktopOverlayOffsetY: 0,
        });
        fireAndForget(resetDesktopActivityOverlayPosition(), {
            tag: 'DesktopOverlaySettingsSection.resetPosition',
        });
    }, [setLocalSetting]);

    return (
        <>
            <ItemGroup
                title={t('settingsDesktop.overlay.title')}
                footer={t('settingsDesktop.overlay.footer')}
            >
                <Item
                    testID="settings-desktop-overlay-enabled"
                    title={t('settingsDesktop.overlay.enabledTitle')}
                    subtitle={t('settingsDesktop.overlay.enabledSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={desktopPolicy.enabled}
                            onValueChange={(value) => setLocalSetting({ desktopOverlayEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                {settingsVisibility.showOverlayConfiguration ? (
                    <>
                        <DesktopOverlayChoiceDropdownRow
                            testID="settings-desktop-overlay-visibility-mode"
                            title={t('settingsDesktop.overlay.visibilityModeTitle')}
                            subtitle={t('settingsDesktop.overlay.visibilityModeSubtitle')}
                            icon={<Ionicons name="eye-outline" size={29} color={theme.colors.textSecondary} />}
                            selectedValue={desktopPolicy.visibilityMode}
                            choices={VISIBILITY_MODE_OPTIONS}
                            onSelect={(value) => setLocalSetting({ desktopOverlayVisibilityMode: value })}
                        />
                        <Item
                            title={t('settingsDesktop.overlay.showWhenRunningTitle')}
                            subtitle={t('settingsDesktop.overlay.showWhenRunningSubtitle')}
                            icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={(
                                <Switch
                                    value={desktopPolicy.showWhenRunning}
                                    onValueChange={(value) => setLocalSetting({ desktopOverlayShowWhenRunning: Boolean(value) })}
                                />
                            )}
                            showChevron={false}
                        />
                        <Item
                            title={t('settingsDesktop.overlay.showWhenAttentionRequiredTitle')}
                            subtitle={t('settingsDesktop.overlay.showWhenAttentionRequiredSubtitle')}
                            icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={(
                                <Switch
                                    value={desktopPolicy.showWhenAttentionRequired}
                                    onValueChange={(value) => setLocalSetting({ desktopOverlayShowWhenAttentionRequired: Boolean(value) })}
                                />
                            )}
                            showChevron={false}
                        />
                        <Item
                            title={t('settingsDesktop.overlay.showWhenReadyTitle')}
                            subtitle={t('settingsDesktop.overlay.showWhenReadySubtitle')}
                            icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={(
                                <Switch
                                    value={desktopPolicy.showWhenReady}
                                    onValueChange={(value) => setLocalSetting({ desktopOverlayShowWhenReady: Boolean(value) })}
                                />
                            )}
                            showChevron={false}
                        />
                        <Item
                            title={t('settingsDesktop.overlay.alwaysOnTopTitle')}
                            subtitle={t('settingsDesktop.overlay.alwaysOnTopSubtitle')}
                            icon={<Ionicons name="layers-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={(
                                <Switch
                                    value={desktopPolicy.alwaysOnTop}
                                    onValueChange={(value) => setLocalSetting({ desktopOverlayAlwaysOnTop: Boolean(value) })}
                                />
                            )}
                            showChevron={false}
                        />
                    </>
                ) : null}
            </ItemGroup>

            {settingsVisibility.showOverlayConfiguration ? (
                <ItemGroup
                    title={t('settingsDesktop.overlay.interactionTitle')}
                    footer={t('settingsDesktop.overlay.interactionFooter')}
                >
                    <Item
                        title={t('settingsDesktop.overlay.autoHideEnabledTitle')}
                        subtitle={t('settingsDesktop.overlay.autoHideEnabledSubtitle')}
                        icon={<Ionicons name="timer-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={(
                            <Switch
                                value={desktopPolicy.autoHideEnabled}
                                onValueChange={(value) => setLocalSetting({ desktopOverlayAutoHideEnabled: Boolean(value) })}
                            />
                        )}
                        showChevron={false}
                    />
                    {settingsVisibility.showAutoHideDelay ? (
                        <DesktopOverlayChoiceDropdownRow
                            testID="settings-desktop-overlay-auto-hide-delay"
                            title={t('settingsDesktop.overlay.autoHideDelayTitle')}
                            subtitle={t('settingsDesktop.overlay.autoHideDelaySubtitle')}
                            icon={<Ionicons name="time-outline" size={29} color={theme.colors.textSecondary} />}
                            selectedValue={desktopPolicy.autoHideDelayMs}
                            choices={AUTO_HIDE_DELAY_OPTIONS}
                            onSelect={(value) => setLocalSetting({ desktopOverlayAutoHideDelayMs: Number(value) })}
                        />
                    ) : null}
                    <Item
                        title={t('settingsDesktop.overlay.interactiveCollapsedTitle')}
                        subtitle={t('settingsDesktop.overlay.interactiveCollapsedSubtitle')}
                        icon={<Ionicons name="finger-print-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={(
                            <Switch
                                value={desktopPolicy.interactiveCollapsed}
                                onValueChange={(value) => setLocalSetting({ desktopOverlayInteractiveCollapsed: Boolean(value) })}
                            />
                        )}
                        showChevron={false}
                    />
                    {settingsVisibility.showCollapsedClickAction ? (
                        <DesktopOverlayChoiceDropdownRow
                            testID="settings-desktop-overlay-collapsed-click-action"
                            title={t('settingsDesktop.overlay.collapsedClickActionTitle')}
                            subtitle={t('settingsDesktop.overlay.collapsedClickActionSubtitle')}
                            icon={<Ionicons name="return-down-forward-outline" size={29} color={theme.colors.textSecondary} />}
                            selectedValue={desktopPolicy.clickAction}
                            choices={COLLAPSED_CLICK_ACTION_OPTIONS}
                            onSelect={(value) => setLocalSetting({ desktopOverlayClickAction: value })}
                        />
                    ) : null}
                    {settingsVisibility.showExpandedBehavior ? (
                        <DesktopOverlayChoiceDropdownRow
                            testID="settings-desktop-overlay-expanded-behavior"
                            title={t('settingsDesktop.overlay.expandedBehaviorTitle')}
                            subtitle={t('settingsDesktop.overlay.expandedBehaviorSubtitle')}
                            icon={<Ionicons name="expand-outline" size={29} color={theme.colors.textSecondary} />}
                            selectedValue={desktopPolicy.expandedBehavior}
                            choices={EXPANDED_BEHAVIOR_OPTIONS}
                            onSelect={(value) => setLocalSetting({ desktopOverlayExpandedBehavior: value })}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}

            {settingsVisibility.showOverlayConfiguration ? (
                <ItemGroup
                    title={t('settingsDesktop.overlay.placementTitle')}
                    footer={t('settingsDesktop.overlay.placementFooter')}
                >
                    <DesktopOverlayChoiceDropdownRow
                        testID="settings-desktop-overlay-placement-mode"
                        title={t('settingsDesktop.overlay.placementModeTitle')}
                        subtitle={t('settingsDesktop.overlay.placementModeSubtitle')}
                        icon={<Ionicons name="move-outline" size={29} color={theme.colors.textSecondary} />}
                        selectedValue={desktopPolicy.placementMode}
                        choices={PLACEMENT_MODE_OPTIONS}
                        onSelect={(value) => setLocalSetting({ desktopOverlayPlacementMode: value })}
                    />
                    <DesktopOverlayChoiceDropdownRow
                        testID="settings-desktop-overlay-anchor-preset"
                        title={t('settingsDesktop.overlay.anchorPresetTitle')}
                        subtitle={t('settingsDesktop.overlay.anchorPresetSubtitle')}
                        icon={<Ionicons name="pin-outline" size={29} color={theme.colors.textSecondary} />}
                        selectedValue={desktopPolicy.anchor}
                        choices={ANCHOR_OPTIONS}
                        onSelect={(value) => setLocalSetting({ desktopOverlayAnchor: value })}
                    />
                    {settingsVisibility.showCustomPlacementControls ? (
                        <>
                            <Item
                                title={t('settingsDesktop.overlay.allowRepositioningTitle')}
                                subtitle={t('settingsDesktop.overlay.allowRepositioningSubtitle')}
                                icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
                                rightElement={(
                                    <Switch
                                        value={desktopPolicy.enableDragReposition}
                                        onValueChange={(value) => setLocalSetting({ desktopOverlayEnableDragReposition: Boolean(value) })}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsDesktop.overlay.lockPositionTitle')}
                                subtitle={t('settingsDesktop.overlay.lockPositionSubtitle')}
                                icon={<Ionicons name="lock-closed-outline" size={29} color={theme.colors.textSecondary} />}
                                rightElement={(
                                    <Switch
                                        value={desktopPolicy.lockPosition}
                                        onValueChange={(value) => setLocalSetting({ desktopOverlayLockPosition: Boolean(value) })}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsDesktop.overlay.resetPositionTitle')}
                                subtitle={t('settingsDesktop.overlay.resetPositionSubtitle')}
                                icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.textSecondary} />}
                                onPress={handleResetPosition}
                                showChevron={false}
                            />
                        </>
                    ) : null}
                </ItemGroup>
            ) : null}

            {settingsVisibility.showOverlayConfiguration ? (
                <ItemGroup
                    title={t('settingsDesktop.overlay.presentationTitle')}
                    footer={t('settingsDesktop.overlay.presentationFooter')}
                >
                    <DesktopOverlayChoiceDropdownRow
                        testID="settings-desktop-overlay-density"
                        title={t('settingsDesktop.overlay.densityTitle')}
                        subtitle={t('settingsDesktop.overlay.densitySubtitle')}
                        icon={<Ionicons name="resize-outline" size={29} color={theme.colors.textSecondary} />}
                        selectedValue={desktopPolicy.density}
                        choices={DENSITY_OPTIONS}
                        onSelect={(value) => setLocalSetting({ desktopOverlayDensity: value })}
                    />
                    <DesktopOverlayChoiceDropdownRow
                        testID="settings-desktop-overlay-compact-style"
                        title={t('settingsDesktop.overlay.compactStyleTitle')}
                        subtitle={t('settingsDesktop.overlay.compactStyleSubtitle')}
                        icon={<Ionicons name="square-outline" size={29} color={theme.colors.textSecondary} />}
                        selectedValue={desktopPolicy.compactStyle}
                        choices={COMPACT_STYLE_OPTIONS}
                        onSelect={(value) => setLocalSetting({ desktopOverlayCompactStyle: value })}
                    />
                    <Item
                        title={t('settingsDesktop.overlay.showSessionCountTitle')}
                        subtitle={t('settingsDesktop.overlay.showSessionCountSubtitle')}
                        icon={<Ionicons name="people-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={(
                            <Switch
                                value={desktopPolicy.showSessionCount}
                                onValueChange={(value) => setLocalSetting({ desktopOverlayShowSessionCount: Boolean(value) })}
                            />
                        )}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsDesktop.overlay.showPreviewTextTitle')}
                        subtitle={t('settingsDesktop.overlay.showPreviewTextSubtitle')}
                        icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={(
                            <Switch
                                value={desktopPolicy.showPreviewText}
                                onValueChange={(value) => setLocalSetting({ desktopOverlayShowPreviewText: Boolean(value) })}
                            />
                        )}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});
