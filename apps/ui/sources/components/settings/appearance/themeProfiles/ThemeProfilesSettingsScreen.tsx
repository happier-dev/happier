import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';

import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useThemeLibraryInventory, useThemeProfileDocument } from '@/sync/store/useThemeProfiles';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { t } from '@/text';
import { readSystemTheme } from '@/theme/profiles/themeProfileRuntime';
import { readThemeProfileReferenceSelection } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileMode, ThemeReference } from '@/theme/profiles/themeProfileTypes';
import { buildThemePresetSourceOptions } from './themeProfilePresetOptions';
import { ThemeLibraryView } from './ThemeLibraryView';
import { useThemeActionExecution } from './useThemeActionExecution';
import { useThemePluginShare } from './useThemePluginShare';
import { useThemeLibraryModel, type ThemeLibraryModelInput } from './useThemeLibraryModel';
import { ThemeDevicePickerHost } from './ThemeDevicePickerHost';
import type { ThemeDevicePickerInput } from './useThemeDevicePicker';

const profileEditorRoute = (profileId: string, from?: string) => ({
    pathname: '/settings/appearance/themes/[profileId]' as const,
    params: from ? { profileId, from } : { profileId },
});
const profileExportRoute = (profileId: string) => ({
    pathname: '/settings/appearance/themes/export' as const,
    params: { profileId },
});

const showingMode = (themePreference: string): ThemeProfileMode => (
    themePreference === 'light' || themePreference === 'dark' ? themePreference : readSystemTheme()
);

function presentThemeSelectionFailure(error: unknown): void {
    presentActionTurnedOffNoticeIfOff({ errorCode: readActionErrorCodeV1(error) }, THEME_ACTION_IDS.apply);
}

/**
 * Appearance → Themes: binds this device's selection, the Account library headers and navigation to the
 * library controller (`useThemeLibraryModel`, choices through theme Actions); `ThemeLibraryView` draws it.
 */
export const ThemeProfilesSettingsScreen = React.memo(function ThemeProfilesSettingsScreen() {
    const router = useRouter();
    const themePreference = useLocalSetting('themePreference');
    const storedSelection = useLocalSetting('themeProfileSelection');
    const selection = React.useMemo(() => readThemeProfileReferenceSelection(storedSelection), [storedSelection]);
    const lightDocument = useThemeProfileDocument(selection.light).document;
    const darkDocument = useThemeProfileDocument(selection.dark).document;
    const selectedDocuments = React.useMemo(() => ({ light: lightDocument, dark: darkDocument }), [lightDocument, darkDocument]);
    const inventory = useThemeLibraryInventory();
    const options = React.useMemo(() => buildThemePresetSourceOptions(inventory.entries), [inventory.entries]);
    const execute = useThemeActionExecution();
    const [deviceTarget, setDeviceTarget] = React.useState<ThemeDevicePickerInput['theme'] | null>(null);
    const lightDevicesAnchor = React.useRef<unknown>(null);
    const darkDevicesAnchor = React.useRef<unknown>(null);
    const dismissDevices = React.useCallback(() => setDeviceTarget(null), []);
    const share = useThemePluginShare(execute);
    const labels = React.useMemo(() => ({
        sourceYours: t('settingsAppearance.themeProfiles.sourceYours'),
        sourceStore: t('settingsAppearance.themeProfiles.sourceStore'),
        sourcePlugin: t('settingsAppearance.themeProfiles.sourcePlugin'),
        editTheme: t('settingsAppearance.themeProfiles.editTheme'),
        exportFile: t('settingsAppearance.themeProfiles.exportFile'),
    }), []);
    const navigation = React.useMemo(() => ({
        onCreate: (from?: string) => router.push(profileEditorRoute('new', from)),
        onEdit: (id: string) => router.push(profileEditorRoute(id)),
        onExport: (id: string) => router.push(profileExportRoute(id)),
        onShare: (reference: ThemeReference) => share([reference]),
        onImport: () => router.push('/settings/appearance/themes/import'),
        onOpenStore: () => router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'theme' }) as never),
        onUpdate: () => router.push('/settings/system-status'),
    }), [router, share]);
    const input: ThemeLibraryModelInput = {
        options,
        labels,
        selection,
        selectedDocuments,
        showing: showingMode(themePreference),
        native: Platform.OS !== 'web',
        failed: inventory.failed,
        retry: inventory.retry,
        onFailure: presentThemeSelectionFailure,
        onUseOtherDevices: setDeviceTarget,
        ...navigation,
    };
    const viewProps = useThemeLibraryModel(input, execute);
    return <>
        <ThemeLibraryView {...viewProps} slots={{
            light: { ...viewProps.slots.light, devicesAnchorRef: lightDevicesAnchor },
            dark: { ...viewProps.slots.dark, devicesAnchorRef: darkDevicesAnchor },
        }} />
        {deviceTarget ? <ThemeDevicePickerHost theme={deviceTarget}
            anchorRef={deviceTarget.mode === 'light' ? lightDevicesAnchor : darkDevicesAnchor}
            execute={execute} onDismiss={dismissDevices} /> : null}
    </>;
});
