import * as React from 'react';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { t } from '@/text';
import { getDesktopActivityOverlayWindowState, listenDesktopActivityOverlayWindowState } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { useDesktopHostRoleAvailability } from '@/utils/platform/desktopHost';
import { DOCK_OPTIONS, IDLE_OPTIONS, BOT_CONVERSATION_OPTIONS, VISIBILITY_MODE_OPTIONS,
    findChoiceOptionById, toSegmentedChoiceOptions } from './DesktopOverlaySettingsSection.options';
import { DesktopNotchDisplayRow, type DesktopNotchDisplayInUse } from './DesktopNotchDisplayRow';
import { DESKTOP_SETTINGS } from './desktopSettings';

function NotchEnabledRow() {
    const enabled = useLocalSetting('desktopOverlayEnabled');
    const { setSetting } = useSettingActionFeedback();
    return <SettingAnchor setting={DESKTOP_SETTINGS.settings.enabled}>
        <Item testID="settings-desktop-overlay-enabled" title={t('settingsDesktop.overlay.enabledTitle')}
            subtitle={t('settingsDesktop.overlay.enabledSubtitle')} showChevron={false}
            rightElement={<Switch value={enabled} onValueChange={value => { void setSetting(DESKTOP_SETTINGS.settings.enabled, value); }} />} />
    </SettingAnchor>;
}

function NotchDockRow({ onCameraNotch }: { onCameraNotch: boolean }) {
    const dock = useLocalSetting('desktopOverlayDock');
    const { setSetting } = useSettingActionFeedback();
    return <SettingAnchor setting={DESKTOP_SETTINGS.settings.dock}>
        <SegmentedChoiceItem testID="settings-desktop-overlay-dock" testIDPrefix="settings-desktop-overlay-dock"
            title={t('settingsDesktop.overlay.dockTitle')}
            subtitle={dock === 'floating' ? t('settingsDesktop.overlay.dockSubtitleFloating') : onCameraNotch
                ? t('settingsDesktop.overlay.dockSubtitleCamera') : t('settingsDesktop.overlay.dockSubtitleEdge')}
            options={toSegmentedChoiceOptions(DOCK_OPTIONS)} value={dock} onChange={id => {
                const choice = findChoiceOptionById(DOCK_OPTIONS, id);
                return choice ? setSetting(DESKTOP_SETTINGS.settings.dock, choice.value) : undefined;
            }} />
    </SettingAnchor>;
}

function NotchDisplaySetting({ inUse }: { inUse: DesktopNotchDisplayInUse | null }) {
    const display = useLocalSetting('desktopOverlayDisplayMode');
    const { setSetting } = useSettingActionFeedback();
    return <SettingAnchor setting={DESKTOP_SETTINGS.settings.display}>
        <DesktopNotchDisplayRow value={display} inUse={inUse}
            onSelect={value => { void setSetting(DESKTOP_SETTINGS.settings.display, value); }} />
    </SettingAnchor>;
}

function NotchIdleRow({ onCameraNotch }: { onCameraNotch: boolean }) {
    const idle = useLocalSetting('desktopOverlayIdle');
    const dock = useLocalSetting('desktopOverlayDock');
    const { setSetting } = useSettingActionFeedback();
    return <SettingAnchor setting={DESKTOP_SETTINGS.settings.idle}>
        <SegmentedChoiceItem testID="settings-desktop-overlay-idle" testIDPrefix="settings-desktop-overlay-idle"
            title={t('settingsDesktop.overlay.idleTitle')} subtitle={onCameraNotch && dock === 'top'
                ? t('settingsDesktop.overlay.idleSubtitleCamera') : t('settingsDesktop.overlay.idleSubtitleTip')}
            options={toSegmentedChoiceOptions(IDLE_OPTIONS)} value={idle} onChange={id => {
                const choice = findChoiceOptionById(IDLE_OPTIONS, id);
                return choice ? setSetting(DESKTOP_SETTINGS.settings.idle, choice.value) : undefined;
            }} />
    </SettingAnchor>;
}

function NotchShowBotsRow() {
    const mode = useLocalSetting('desktopOverlayVisibilityMode');
    const { setSetting } = useSettingActionFeedback();
    return <SettingAnchor setting={DESKTOP_SETTINGS.settings.visibilityMode}>
        <SegmentedChoiceItem testID="settings-desktop-overlay-visibility-mode" testIDPrefix="settings-desktop-overlay-visibility-mode"
            title={t('settingsDesktop.overlay.visibilityModeTitle')} subtitle={t('settingsDesktop.overlay.visibilityModeSubtitle')}
            options={toSegmentedChoiceOptions(VISIBILITY_MODE_OPTIONS)} value={mode} onChange={id => {
                const choice = findChoiceOptionById(VISIBILITY_MODE_OPTIONS, id);
                return choice ? setSetting(DESKTOP_SETTINGS.settings.visibilityMode, choice.value) : undefined;
            }} />
    </SettingAnchor>;
}

function NotchConversationRow() {
    const presentation = useLocalSetting('desktopBotConversationPresentation');
    const { setSetting } = useSettingActionFeedback();
    return <SettingAnchor setting={DESKTOP_SETTINGS.settings.botConversationPresentation}>
        <SegmentedChoiceItem testID="settings-desktop-bot-conversation-presentation" testIDPrefix="settings-desktop-bot-conversation-presentation"
            title={t('settingsDesktop.overlay.botConversationPresentationTitle')} subtitle={t('settingsDesktop.overlay.botConversationPresentationSubtitle')}
            options={toSegmentedChoiceOptions(BOT_CONVERSATION_OPTIONS)} value={presentation} onChange={id => {
                const choice = findChoiceOptionById(BOT_CONVERSATION_OPTIONS, id);
                return choice ? setSetting(DESKTOP_SETTINGS.settings.botConversationPresentation, choice.value) : undefined;
            }} />
    </SettingAnchor>;
}

function NotchAlwaysOnTopRow() {
    const alwaysOnTop = useLocalSetting('desktopOverlayAlwaysOnTop');
    const { setSetting } = useSettingActionFeedback();
    return <SettingAnchor setting={DESKTOP_SETTINGS.settings.alwaysOnTop}>
        <Item title={t('settingsDesktop.overlay.alwaysOnTopTitle')} subtitle={t('settingsDesktop.overlay.alwaysOnTopSubtitle')}
            showChevron={false} rightElement={<Switch value={alwaysOnTop}
                onValueChange={value => { void setSetting(DESKTOP_SETTINGS.settings.alwaysOnTop, value); }} />} />
    </SettingAnchor>;
}

export const DesktopOverlaySettingsSection = React.memo(function DesktopOverlaySettingsSection() {
    const enabled = useLocalSetting('desktopOverlayEnabled');
    const availability = useDesktopHostRoleAvailability('activity');
    const [onCameraNotch, setOnCameraNotch] = React.useState(false);
    const [displayInUse, setDisplayInUse] = React.useState<DesktopNotchDisplayInUse | null>(null);
    React.useEffect(() => {
        if (availability?.kind !== 'available') {
            return;
        }

        let cancelled = false;
        let unlisten: (() => void) | null = null;
        const applyDisplayFacts = (state: Awaited<ReturnType<typeof getDesktopActivityOverlayWindowState>>) => {
            if (cancelled) {
                return;
            }

            const context = state?.placementDiagnostics?.displayContext;
            setOnCameraNotch(Boolean(context?.hasPhysicalNotch && context.isBuiltinDisplay));
            const display = state?.placementDiagnostics?.display;
            setDisplayInUse((previous) => {
                if (!display) return null;
                return previous && previous.storageKey === display.storageKey && previous.name === display.name
                    && previous.fellBack === display.fellBack && previous.requestedName === display.requestedName
                    ? previous
                    : { storageKey: display.storageKey, name: display.name, fellBack: display.fellBack, requestedName: display.requestedName };
            });
        };

        void getDesktopActivityOverlayWindowState()
            .then((state) => {
                applyDisplayFacts(state);
            })
            .catch(() => {});
        void listenDesktopActivityOverlayWindowState((state) => {
            applyDisplayFacts(state);
        })
            .then((dispose) => {
                if (cancelled) dispose();
                else unlisten = dispose;
            })
            .catch(() => {});

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [availability]);

    return <SettingSection section={DESKTOP_SETTINGS.sectionRefs.overlay}>
        <ItemGroup title={t('settingsDesktop.overlay.title')} description={t('settingsDesktop.overlay.footer')}>
            {availability === null ? <Item testID="settings-desktop-overlay-loading"
                title={t('common.loading')} mode="info" showChevron={false} />
                : availability.kind === 'unavailable' ? <Item testID="settings-desktop-overlay-unavailable"
                    title={t('common.unavailable')} subtitle={availability.reason} mode="info" showChevron={false} />
                : <>
                    <NotchEnabledRow />
                    {enabled ? <>
                        <NotchDockRow onCameraNotch={onCameraNotch} />
                        <NotchDisplaySetting inUse={displayInUse} />
                        <NotchIdleRow onCameraNotch={onCameraNotch} />
                        <NotchShowBotsRow />
                        <NotchConversationRow />
                        <NotchAlwaysOnTopRow />
                    </> : null}
                </>}
        </ItemGroup>
    </SettingSection>;
});
