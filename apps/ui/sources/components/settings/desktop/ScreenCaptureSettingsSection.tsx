import { router } from 'expo-router';
import * as React from 'react';

import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { showKeyboardShortcutCapturePrompt } from '@/components/settings/keyboard/showKeyboardShortcutCapturePrompt';
import {
    openNativeCapturePermissionSettings,
    pickCaptureLibraryFolder,
    readCaptureLibraryFolder,
    relaunchForCapturePermission,
    showCaptureLibraryFolder,
    type NativeCaptureBindingKey,
    type NativeCaptureShortcutSnapshot,
} from '@/desktop/capture/nativeCapture';
import { formatKeybindingLabel, parseKeybindingRule } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';

import { recordDesktopCaptureShortcut } from './desktopCapturePreferenceBinding';
import { DESKTOP_SETTINGS } from './desktopSettings';
import { ScreenCaptureSettingsRows, type CaptureShortcutRow } from './ScreenCaptureSettingsRows';
import { useScreenCaptureSettings, type CaptureSettingsRead } from './useScreenCaptureSettings';

const KEYS: readonly NativeCaptureBindingKey[] = ['captureShortcut', 'instantWindowShortcut', 'recordingShortcut'];
const SETTINGS = {
    captureShortcut: DESKTOP_SETTINGS.settings.captureShortcut,
    instantWindowShortcut: DESKTOP_SETTINGS.settings.instantWindowShortcut,
    recordingShortcut: DESKTOP_SETTINGS.settings.recordingShortcut,
} as const;

/** Native bindings spell the primary modifier CmdOrCtrl; everything the person reads says it their way. */
function formatNativeBinding(binding: string, platform: ReturnType<typeof resolveKeyboardPlatform>): string {
    return formatKeybindingLabel(parseKeybindingRule(binding.split('+').map((token) => token === 'CmdOrCtrl' ? 'Mod' : token).join('+')), platform);
}

export function projectCaptureShortcutRows(
    read: CaptureSettingsRead<NativeCaptureShortcutSnapshot>,
    platform: ReturnType<typeof resolveKeyboardPlatform>,
): Readonly<Record<NativeCaptureBindingKey, CaptureShortcutRow>> {
    const snapshot = read.status === 'ready' ? read.value : null;
    const status = read.status !== 'ready' ? read.status : snapshot?.availability === 'ready' ? 'ready'
        : snapshot?.availability === 'pending' ? 'loading' : 'failed';
    const row = (key: NativeCaptureBindingKey): CaptureShortcutRow => {
        const binding = snapshot?.bindings.find((candidate) => candidate.key === key);
        const portal = snapshot?.backend === 'portal';
        const noInstant = portal && key === 'instantWindowShortcut';
        return {
            status,
            label: status === 'ready' && binding?.active ? formatNativeBinding(binding.active, platform) : null,
            note: noInstant ? t('screenCapture.settings.notOnWayland')
                : binding?.failure === 'conflict' ? t('screenCapture.settings.conflict')
                : binding?.failure ? t('screenCapture.settings.refused') : null,
            editable: !noInstant && status === 'ready',
        };
    };
    return { captureShortcut: row('captureShortcut'), instantWindowShortcut: row('instantWindowShortcut'), recordingShortcut: row('recordingShortcut') };
}

/** Mounted only in the desktop app, so its native reads start with the page and end with it. */
export const ScreenCaptureSettingsSection = React.memo(function ScreenCaptureSettingsSection() {
    const { shortcuts, permissions, folder, windowShadow } = useScreenCaptureSettings();
    const { setSetting } = useSettingActionFeedback();
    const sound = useLocalSetting('screenCaptureSound');
    const includeWindowText = useLocalSetting('screenCaptureIncludeWindowText');
    const [platform] = React.useState(resolveKeyboardPlatform);
    const [defaultFolder, setDefaultFolder] = React.useState<string | null>(null);
    const chosenFolder = folder.status === 'ready' ? folder.value : null;
    React.useEffect(() => {
        if (chosenFolder === null) void readCaptureLibraryFolder().then(setDefaultFolder);
    }, [chosenFolder]);

    const record = async (key: NativeCaptureBindingKey) => {
        const value = await recordDesktopCaptureShortcut(() => showKeyboardShortcutCapturePrompt({
            title: t(`screenCapture.settings.${key}`),
            platform,
        }));
        if (value !== null) await setSetting(SETTINGS[key], value);
    };
    return (
        <ScreenCaptureSettingsRows
            shortcuts={projectCaptureShortcutRows(shortcuts, platform)}
            sound={sound}
            onSoundChange={(value) => void setSetting(DESKTOP_SETTINGS.settings.captureSound, value)}
            includeWindowText={includeWindowText}
            onIncludeWindowTextChange={(value) => void setSetting(DESKTOP_SETTINGS.settings.captureIncludeWindowText, value)}
            windowShadow={windowShadow.status === 'ready' ? windowShadow.value : null}
            onIncludeWindowShadowChange={(value) => void setSetting(DESKTOP_SETTINGS.settings.captureIncludeWindowShadow, value)}
            folder={chosenFolder ?? defaultFolder}
            onChooseFolder={() => void pickCaptureLibraryFolder().then((path) => {
                if (path) void setSetting(DESKTOP_SETTINGS.settings.captureFolder, path);
            })}
            onShowFolder={() => void showCaptureLibraryFolder()}
            onRecordShortcut={(key) => void record(key)}
            permissions={permissions.status === 'ready' ? permissions.value : null}
            onOpenPermission={(subject) => void openNativeCapturePermissionSettings(subject)}
            onReopen={() => void relaunchForCapturePermission()}
            onOpenApprovals={() => router.push('/settings/actions')}
        />
    );
});
