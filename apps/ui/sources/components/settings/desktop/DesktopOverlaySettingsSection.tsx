import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import {
    getDesktopActivityOverlayWindowState,
    listenDesktopActivityOverlayWindowState,
    resetDesktopActivityOverlayPosition,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import {
    resolveDesktopOverlayPolicy,
    resolveDesktopOverlaySettingsVisibilityState,
} from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { useLocalSettings } from '@/sync/domains/state/storage';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import {
    ANCHOR_OPTIONS,
    AUTO_HIDE_DELAY_OPTIONS,
    PLACEMENT_MODE_OPTIONS,
    PRESENTATION_MODE_OPTIONS,
    VISIBILITY_MODE_OPTIONS,
} from './DesktopOverlaySettingsSection.options';
import { DesktopOverlayChoiceDropdownRow } from './DesktopOverlayChoiceDropdownRow';
import { DesktopSettingsIonicon } from './DesktopSettingsIonicon';

export const DesktopOverlaySettingsSection = React.memo(function DesktopOverlaySettingsSection() {
    const { theme } = useUnistyles();
    const localSettings = useLocalSettings();
    const applyLocalSettings = useApplyLocalSettings();
    const [resolvedHostMode, setResolvedHostMode] = React.useState<'floating' | 'notch_integrated' | null>(null);

    const desktopPolicy = React.useMemo(
        () => resolveDesktopOverlayPolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const settingsVisibility = React.useMemo(
        () => resolveDesktopOverlaySettingsVisibilityState(desktopPolicy, resolvedHostMode),
        [desktopPolicy, resolvedHostMode],
    );

    React.useEffect(() => {
        if (!isDesktopHost()) {
            return;
        }

        let cancelled = false;
        let unlisten: (() => void) | null = null;
        const applyResolvedHostMode = (state: Awaited<ReturnType<typeof getDesktopActivityOverlayWindowState>>) => {
            if (cancelled) {
                return;
            }

            setResolvedHostMode(state?.placementDiagnostics?.hostMode ?? null);
        };

        void getDesktopActivityOverlayWindowState()
            .then((state) => {
                applyResolvedHostMode(state);
            })
            .catch(() => {
                if (!cancelled) {
                    setResolvedHostMode(null);
                }
            });
        void listenDesktopActivityOverlayWindowState((state) => {
            applyResolvedHostMode(state);
        })
            .then((dispose) => {
                unlisten = dispose;
            })
            .catch(() => {});

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

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

    const handlePlacementModeSelect = React.useCallback((value: 'anchored' | 'custom') => {
        if (value === 'anchored') {
            setLocalSetting({
                desktopOverlayPlacementMode: 'anchored',
                desktopOverlayAnchor: 'top_center',
                desktopOverlayOffsetX: 0,
                desktopOverlayOffsetY: 0,
            });
            fireAndForget(resetDesktopActivityOverlayPosition(), {
                tag: 'DesktopOverlaySettingsSection.selectAnchoredPlacementMode',
            });
            return;
        }

        setLocalSetting({ desktopOverlayPlacementMode: value });
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
                    icon={<DesktopSettingsIonicon name="sparkles-outline" size={29} color={theme.colors.accent.blue} />}
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
                            icon={<DesktopSettingsIonicon name="eye-outline" size={29} color={theme.colors.text.secondary} />}
                            selectedValue={desktopPolicy.visibilityMode}
                            choices={VISIBILITY_MODE_OPTIONS}
                            onSelect={(value) => setLocalSetting({ desktopOverlayVisibilityMode: value })}
                        />
                        {settingsVisibility.showAttentionFilterControls ? (
                            <>
                                <Item
                                    title={t('settingsDesktop.overlay.showWhenRunningTitle')}
                                    subtitle={t('settingsDesktop.overlay.showWhenRunningSubtitle')}
                                    icon={<DesktopSettingsIonicon name="pulse-outline" size={29} color={theme.colors.text.secondary} />}
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
                                    icon={<DesktopSettingsIonicon name="alert-circle-outline" size={29} color={theme.colors.text.secondary} />}
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
                                    icon={<DesktopSettingsIonicon name="checkmark-circle-outline" size={29} color={theme.colors.text.secondary} />}
                                    rightElement={(
                                        <Switch
                                            value={desktopPolicy.showWhenReady}
                                            onValueChange={(value) => setLocalSetting({ desktopOverlayShowWhenReady: Boolean(value) })}
                                        />
                                    )}
                                    showChevron={false}
                                />
                            </>
                        ) : null}
                        <Item
                            title={t('settingsDesktop.overlay.alwaysOnTopTitle')}
                            subtitle={t('settingsDesktop.overlay.alwaysOnTopSubtitle')}
                            icon={<DesktopSettingsIonicon name="layers-outline" size={29} color={theme.colors.text.secondary} />}
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
                        icon={<DesktopSettingsIonicon name="timer-outline" size={29} color={theme.colors.text.secondary} />}
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
                            icon={<DesktopSettingsIonicon name="time-outline" size={29} color={theme.colors.text.secondary} />}
                            selectedValue={desktopPolicy.autoHideDelayMs}
                            choices={AUTO_HIDE_DELAY_OPTIONS}
                            onSelect={(value) => setLocalSetting({ desktopOverlayAutoHideDelayMs: Number(value) })}
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
                        testID="settings-desktop-overlay-presentation-mode"
                        title={t('settingsDesktop.overlay.presentationModeTitle')}
                        subtitle={t('settingsDesktop.overlay.presentationModeSubtitle')}
                        icon={<DesktopSettingsIonicon name="scan-outline" size={29} color={theme.colors.text.secondary} />}
                        selectedValue={desktopPolicy.presentationMode}
                        choices={PRESENTATION_MODE_OPTIONS}
                        onSelect={(value) => setLocalSetting({ desktopOverlayPresentationMode: value })}
                    />
                    {settingsVisibility.showHostModeFallbackNotice ? (
                        <Item
                            title={t('settingsDesktop.overlay.hostModeFallbackTitle')}
                            subtitle={t('settingsDesktop.overlay.hostModeFallbackSubtitle')}
                            subtitleLines={0}
                            icon={<DesktopSettingsIonicon name="information-circle-outline" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                            showChevron={false}
                        />
                    ) : null}
                    {settingsVisibility.showFloatingPlacementControls ? (
                        <>
                            <DesktopOverlayChoiceDropdownRow
                                testID="settings-desktop-overlay-placement-mode"
                                title={t('settingsDesktop.overlay.placementModeTitle')}
                                subtitle={t('settingsDesktop.overlay.placementModeSubtitle')}
                                icon={<DesktopSettingsIonicon name="move-outline" size={29} color={theme.colors.text.secondary} />}
                                selectedValue={desktopPolicy.placementMode}
                                choices={PLACEMENT_MODE_OPTIONS}
                                onSelect={handlePlacementModeSelect}
                            />
                            {desktopPolicy.placementMode === 'anchored' ? (
                                <DesktopOverlayChoiceDropdownRow
                                    testID="settings-desktop-overlay-anchor-preset"
                                    title={t('settingsDesktop.overlay.anchorPresetTitle')}
                                    subtitle={t('settingsDesktop.overlay.anchorPresetSubtitle')}
                                    icon={<DesktopSettingsIonicon name="pin-outline" size={29} color={theme.colors.text.secondary} />}
                                    selectedValue={desktopPolicy.anchor}
                                    choices={ANCHOR_OPTIONS}
                                    onSelect={(value) => {
                                        setLocalSetting({ desktopOverlayAnchor: value });
                                        fireAndForget(resetDesktopActivityOverlayPosition(), {
                                            tag: 'DesktopOverlaySettingsSection.selectAnchorPreset',
                                        });
                                    }}
                                />
                            ) : null}
                            <Item
                                title={t('settingsDesktop.overlay.resetPositionTitle')}
                                subtitle={t('settingsDesktop.overlay.resetPositionSubtitle')}
                                icon={<DesktopSettingsIonicon name="refresh-outline" size={29} color={theme.colors.text.secondary} />}
                                onPress={handleResetPosition}
                                showChevron={false}
                            />
                            {settingsVisibility.showCustomPlacementControls ? (
                                <>
                                    <Item
                                        title={t('settingsDesktop.overlay.allowRepositioningTitle')}
                                        subtitle={t('settingsDesktop.overlay.allowRepositioningSubtitle')}
                                        icon={<DesktopSettingsIonicon name="hand-left-outline" size={29} color={theme.colors.text.secondary} />}
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
                                        icon={<DesktopSettingsIonicon name="lock-closed-outline" size={29} color={theme.colors.text.secondary} />}
                                        rightElement={(
                                            <Switch
                                                value={desktopPolicy.lockPosition}
                                                onValueChange={(value) => setLocalSetting({ desktopOverlayLockPosition: Boolean(value) })}
                                            />
                                        )}
                                        showChevron={false}
                                    />
                                </>
                            ) : null}
                        </>
                    ) : null}
                </ItemGroup>
            ) : null}

            {settingsVisibility.showOverlayConfiguration ? (
                <ItemGroup
                    title={t('settingsDesktop.overlay.presentationTitle')}
                    footer={t('settingsDesktop.overlay.presentationFooter')}
                >
                    <Item
                        title={t('settingsDesktop.overlay.showPreviewTextTitle')}
                        subtitle={t('settingsDesktop.overlay.showPreviewTextSubtitle')}
                        icon={<DesktopSettingsIonicon name="chatbubble-ellipses-outline" size={29} color={theme.colors.text.secondary} />}
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
