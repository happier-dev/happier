import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { t } from '@/text';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';

import { useDesktopLoginStart } from './useDesktopLoginStart';
import { DesktopOverlaySettingsSection } from './DesktopOverlaySettingsSection';
import { DesktopWindowsSettingsSection } from './DesktopWindowsSettingsSection';
import { DESKTOP_SETTINGS } from './desktopSettings';

export const DesktopAppSettingsScreen = React.memo(function DesktopAppSettingsScreen() {
    const loginStart = useDesktopLoginStart();
    const showOverlaySettings = settingRendersOnHost(DESKTOP_SETTINGS.settings.enabled);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsDesktop.footer')} />
            {!loginStart.supported && !showOverlaySettings ? (
                // Opened outside the desktop app (a shared link): say where these settings live.
                <ItemGroup>
                    <Item
                        testID="settings-desktop-unavailable"
                        title={t('settingsDesktop.unavailableTitle')}
                        subtitle={t('settingsDesktop.unavailableSubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
            {loginStart.supported ? (
                <ItemGroup title={t('settingsDesktop.startupTitle')}>
                    <SettingRow
                        testID="settings-desktop-autostart-enabled"
                        setting={DESKTOP_SETTINGS.settings.startOnLogin}
                        subtitle={loginStart.error ?? (
                            loginStart.installed === false
                                ? t('settingsDesktop.loginStart.notSetUp')
                                : loginStart.mode === null && !loginStart.loading
                                    ? t('settingsDesktop.loginStart.unknown')
                                    : t('settingsDesktop.loginStart.subtitle')
                        )}
                        rightElement={(
                            <Switch
                                value={loginStart.mode === 'at-login'}
                                disabled={loginStart.loading || loginStart.mode === null}
                                onValueChange={(value) => {
                                    void loginStart.setMode(value ? 'at-login' : 'on-demand');
                                }}
                            />
                        )}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {showOverlaySettings ? <DesktopOverlaySettingsSection /> : null}
            <DesktopWindowsSettingsSection />
        </ItemList>
    );
});
