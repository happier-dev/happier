import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { t } from '@/text';
import {
    getDesktopActivityOverlayWindowState,
    listenDesktopActivityOverlayWindowState,
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
    findChoiceOptionById,
    PLACEMENT_MODE_OPTIONS,
    PRESENTATION_MODE_OPTIONS,
    VISIBILITY_MODE_OPTIONS,
    toSegmentedChoiceOptions,
} from './DesktopOverlaySettingsSection.options';
import { DesktopOverlayChoiceDropdownRow } from './DesktopOverlayChoiceDropdownRow';
import { DESKTOP_SETTINGS } from './desktopSettings';
import { commitDesktopOverlayPlacement } from './desktopOverlayPlacement';


/**
 * While the overlay is off, only its first section renders; it answers for every overlay row, and its
 * `Enabled` switch is what they need.
 */
const OVERLAY_SECTIONS_AFTER_ENABLED = [
    DESKTOP_SETTINGS.sectionRefs.interaction,
    DESKTOP_SETTINGS.sectionRefs.placement,
    DESKTOP_SETTINGS.sectionRefs.presentation,
];

export const DesktopOverlaySettingsSection = React.memo(function DesktopOverlaySettingsSection() {
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
        fireAndForget(commitDesktopOverlayPlacement({ kind: 'reset' }, setLocalSetting), {
            tag: 'DesktopOverlaySettingsSection.resetPosition',
        });
    }, [setLocalSetting]);

    const handlePlacementModeSelect = React.useCallback((value: 'anchored' | 'custom') => {
        fireAndForget(commitDesktopOverlayPlacement({ kind: 'mode', value }, setLocalSetting), {
            tag: 'DesktopOverlaySettingsSection.selectPlacementMode',
        });
    }, [setLocalSetting]);

    return (
        <>
            <SettingSection section={DESKTOP_SETTINGS.sectionRefs.overlay} answersFor={settingsVisibility.showOverlayConfiguration ? undefined : OVERLAY_SECTIONS_AFTER_ENABLED}>
            <ItemGroup
                title={t('settingsDesktop.overlay.title')}
                description={t('settingsDesktop.overlay.footer')}
            >
                <SettingAnchor setting={DESKTOP_SETTINGS.settings.enabled}>
                    <Item
                        testID="settings-desktop-overlay-enabled"
                        title={t('settingsDesktop.overlay.enabledTitle')}
                        subtitle={t('settingsDesktop.overlay.enabledSubtitle')}
                        rightElement={(
                            <Switch
                                value={desktopPolicy.enabled}
                                onValueChange={(value) => setLocalSetting({ desktopOverlayEnabled: Boolean(value) })}
                            />
                        )}
                        showChevron={false}
                    />
                </SettingAnchor>
                {settingsVisibility.showOverlayConfiguration ? (
                    <>
                        <SettingAnchor setting={DESKTOP_SETTINGS.settings.visibilityMode}>
                            <SegmentedChoiceItem
                                testID="settings-desktop-overlay-visibility-mode"
                                testIDPrefix="settings-desktop-overlay-visibility-mode"
                                title={t('settingsDesktop.overlay.visibilityModeTitle')}
                                subtitle={t('settingsDesktop.overlay.visibilityModeSubtitle')}
                                options={toSegmentedChoiceOptions(VISIBILITY_MODE_OPTIONS)}
                                value={desktopPolicy.visibilityMode}
                                onChange={(id) => {
                                    const choice = findChoiceOptionById(VISIBILITY_MODE_OPTIONS, id);
                                    if (choice) setLocalSetting({ desktopOverlayVisibilityMode: choice.value });
                                }}
                            />
                        </SettingAnchor>
                        {settingsVisibility.showAttentionFilterControls ? (
                            <>
                                <SettingAnchor setting={DESKTOP_SETTINGS.settings.showWhenRunning}>
                                    <Item
                                        title={t('settingsDesktop.overlay.showWhenRunningTitle')}
                                        subtitle={t('settingsDesktop.overlay.showWhenRunningSubtitle')}
                                        rightElement={(
                                            <Switch
                                                value={desktopPolicy.showWhenRunning}
                                                onValueChange={(value) => setLocalSetting({ desktopOverlayShowWhenRunning: Boolean(value) })}
                                            />
                                        )}
                                        showChevron={false}
                                    />
                                </SettingAnchor>
                                <SettingAnchor setting={DESKTOP_SETTINGS.settings.showWhenAttentionRequired}>
                                    <Item
                                        title={t('settingsDesktop.overlay.showWhenAttentionRequiredTitle')}
                                        subtitle={t('settingsDesktop.overlay.showWhenAttentionRequiredSubtitle')}
                                        rightElement={(
                                            <Switch
                                                value={desktopPolicy.showWhenAttentionRequired}
                                                onValueChange={(value) => setLocalSetting({ desktopOverlayShowWhenAttentionRequired: Boolean(value) })}
                                            />
                                        )}
                                        showChevron={false}
                                    />
                                </SettingAnchor>
                                <SettingAnchor setting={DESKTOP_SETTINGS.settings.showWhenReady}>
                                    <Item
                                        title={t('settingsDesktop.overlay.showWhenReadyTitle')}
                                        subtitle={t('settingsDesktop.overlay.showWhenReadySubtitle')}
                                        rightElement={(
                                            <Switch
                                                value={desktopPolicy.showWhenReady}
                                                onValueChange={(value) => setLocalSetting({ desktopOverlayShowWhenReady: Boolean(value) })}
                                            />
                                        )}
                                        showChevron={false}
                                    />
                                </SettingAnchor>
                            </>
                        ) : null}
                        <SettingAnchor setting={DESKTOP_SETTINGS.settings.alwaysOnTop}>
                            <Item
                                title={t('settingsDesktop.overlay.alwaysOnTopTitle')}
                                subtitle={t('settingsDesktop.overlay.alwaysOnTopSubtitle')}
                                rightElement={(
                                    <Switch
                                        value={desktopPolicy.alwaysOnTop}
                                        onValueChange={(value) => setLocalSetting({ desktopOverlayAlwaysOnTop: Boolean(value) })}
                                    />
                                )}
                                showChevron={false}
                            />
                        </SettingAnchor>
                    </>
                ) : null}
            </ItemGroup>
            </SettingSection>

            {settingsVisibility.showOverlayConfiguration ? (
                <SettingSection section={DESKTOP_SETTINGS.sectionRefs.interaction}>
                <ItemGroup
                    title={t('settingsDesktop.overlay.interactionTitle')}
                    description={t('settingsDesktop.overlay.interactionFooter')}
                >
                    <SettingAnchor setting={DESKTOP_SETTINGS.settings.autoHideEnabled}>
                        <Item
                            title={t('settingsDesktop.overlay.autoHideEnabledTitle')}
                            subtitle={t('settingsDesktop.overlay.autoHideEnabledSubtitle')}
                            rightElement={(
                                <Switch
                                    value={desktopPolicy.autoHideEnabled}
                                    onValueChange={(value) => setLocalSetting({ desktopOverlayAutoHideEnabled: Boolean(value) })}
                                />
                            )}
                            showChevron={false}
                        />
                    </SettingAnchor>
                    {settingsVisibility.showAutoHideDelay ? (
                        <SettingAnchor setting={DESKTOP_SETTINGS.settings.autoHideDelay}>
                            <SegmentedChoiceItem
                                testID="settings-desktop-overlay-auto-hide-delay"
                                testIDPrefix="settings-desktop-overlay-auto-hide-delay"
                                title={t('settingsDesktop.overlay.autoHideDelayTitle')}
                                subtitle={t('settingsDesktop.overlay.autoHideDelaySubtitle')}
                                options={toSegmentedChoiceOptions(AUTO_HIDE_DELAY_OPTIONS)}
                                value={String(desktopPolicy.autoHideDelayMs)}
                                onChange={(id) => {
                                    const choice = findChoiceOptionById(AUTO_HIDE_DELAY_OPTIONS, id);
                                    if (choice) setLocalSetting({ desktopOverlayAutoHideDelayMs: choice.value });
                                }}
                            />
                        </SettingAnchor>
                    ) : null}
                </ItemGroup>
                </SettingSection>
            ) : null}

            {settingsVisibility.showOverlayConfiguration ? (
                <SettingSection section={DESKTOP_SETTINGS.sectionRefs.placement}>
                <ItemGroup
                    title={t('settingsDesktop.overlay.placementTitle')}
                    description={t('settingsDesktop.overlay.placementFooter')}
                >
                    <SettingAnchor setting={DESKTOP_SETTINGS.settings.presentationMode}>
                        <SegmentedChoiceItem
                            testID="settings-desktop-overlay-presentation-mode"
                            testIDPrefix="settings-desktop-overlay-presentation-mode"
                            title={t('settingsDesktop.overlay.presentationModeTitle')}
                            subtitle={t('settingsDesktop.overlay.presentationModeSubtitle')}
                            options={toSegmentedChoiceOptions(PRESENTATION_MODE_OPTIONS)}
                            value={desktopPolicy.presentationMode}
                            onChange={(id) => {
                                const choice = findChoiceOptionById(PRESENTATION_MODE_OPTIONS, id);
                                if (choice) setLocalSetting({ desktopOverlayPresentationMode: choice.value });
                            }}
                        />
                    </SettingAnchor>
                    {settingsVisibility.showHostModeFallbackNotice ? (
                        <Item
                            title={t('settingsDesktop.overlay.hostModeFallbackTitle')}
                            subtitle={t('settingsDesktop.overlay.hostModeFallbackSubtitle')}
                            subtitleLines={0}
                            mode="info"
                            showChevron={false}
                        />
                    ) : null}
                    {settingsVisibility.showFloatingPlacementControls ? (
                        <>
                            <SettingAnchor setting={DESKTOP_SETTINGS.settings.placementMode}>
                                <SegmentedChoiceItem
                                    testID="settings-desktop-overlay-placement-mode"
                                    testIDPrefix="settings-desktop-overlay-placement-mode"
                                    title={t('settingsDesktop.overlay.placementModeTitle')}
                                    subtitle={t('settingsDesktop.overlay.placementModeSubtitle')}
                                    options={toSegmentedChoiceOptions(PLACEMENT_MODE_OPTIONS)}
                                    value={desktopPolicy.placementMode}
                                    onChange={(id) => {
                                        const choice = findChoiceOptionById(PLACEMENT_MODE_OPTIONS, id);
                                        if (choice) handlePlacementModeSelect(choice.value);
                                    }}
                                />
                            </SettingAnchor>
                            {desktopPolicy.placementMode === 'anchored' ? (
                                <SettingAnchor setting={DESKTOP_SETTINGS.settings.anchorPreset}>
                                    <DesktopOverlayChoiceDropdownRow
                                        testID="settings-desktop-overlay-anchor-preset"
                                        title={t('settingsDesktop.overlay.anchorPresetTitle')}
                                        subtitle={t('settingsDesktop.overlay.anchorPresetSubtitle')}
                                        selectedValue={desktopPolicy.anchor}
                                        choices={ANCHOR_OPTIONS}
                                        onSelect={(value) => {
                                            fireAndForget(commitDesktopOverlayPlacement({ kind: 'anchor', value }, setLocalSetting), {
                                                tag: 'DesktopOverlaySettingsSection.selectAnchorPreset',
                                            });
                                        }}
                                    />
                                </SettingAnchor>
                            ) : null}
                            <SettingAnchor setting={DESKTOP_SETTINGS.settings.resetPosition}>
                                <Item
                                    title={t('settingsDesktop.overlay.resetPositionTitle')}
                                    subtitle={t('settingsDesktop.overlay.resetPositionSubtitle')}
                                    onPress={handleResetPosition}
                                    showChevron={false}
                                />
                            </SettingAnchor>
                            {settingsVisibility.showCustomPlacementControls ? (
                                <>
                                    <SettingAnchor setting={DESKTOP_SETTINGS.settings.allowRepositioning}>
                                        <Item
                                            title={t('settingsDesktop.overlay.allowRepositioningTitle')}
                                            subtitle={t('settingsDesktop.overlay.allowRepositioningSubtitle')}
                                            rightElement={(
                                                <Switch
                                                    value={desktopPolicy.enableDragReposition}
                                                    onValueChange={(value) => setLocalSetting({ desktopOverlayEnableDragReposition: Boolean(value) })}
                                                />
                                            )}
                                            showChevron={false}
                                        />
                                    </SettingAnchor>
                                    <SettingAnchor setting={DESKTOP_SETTINGS.settings.lockPosition}>
                                        <Item
                                            title={t('settingsDesktop.overlay.lockPositionTitle')}
                                            subtitle={t('settingsDesktop.overlay.lockPositionSubtitle')}
                                            rightElement={(
                                                <Switch
                                                    value={desktopPolicy.lockPosition}
                                                    onValueChange={(value) => setLocalSetting({ desktopOverlayLockPosition: Boolean(value) })}
                                                />
                                            )}
                                            showChevron={false}
                                        />
                                    </SettingAnchor>
                                </>
                            ) : null}
                        </>
                    ) : null}
                </ItemGroup>
                </SettingSection>
            ) : null}

            {settingsVisibility.showOverlayConfiguration ? (
                <ItemGroup
                    title={t('settingsDesktop.overlay.presentationTitle')}
                    description={t('settingsDesktop.overlay.presentationFooter')}
                >
                    <SettingAnchor setting={DESKTOP_SETTINGS.settings.showPreviewText}>
                        <Item
                            title={t('settingsDesktop.overlay.showPreviewTextTitle')}
                            subtitle={t('settingsDesktop.overlay.showPreviewTextSubtitle')}
                            rightElement={(
                                <Switch
                                    value={desktopPolicy.showPreviewText}
                                    onValueChange={(value) => setLocalSetting({ desktopOverlayShowPreviewText: Boolean(value) })}
                                />
                            )}
                            showChevron={false}
                        />
                    </SettingAnchor>
                </ItemGroup>
            ) : null}
        </>
    );
});
