import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

import { useDesktopBackgroundServiceAutostart } from './useDesktopBackgroundServiceAutostart';
import { Icon } from '@/components/ui/icons/Icon';
import { DesktopWindowChromeSetting } from './DesktopWindowChromeSetting';

/**
 * One truthful sentence for the background-service row (U12): not set up yet is not the same as a
 * CLI that cannot report its mode, and a failed change is said in words — the raw error is a
 * diagnostic, not a subtitle.
 */
function resolveBackgroundServiceSubtitle(state: ReturnType<typeof useDesktopBackgroundServiceAutostart>): string {
    if (state.installed === false) {
        return t('settingsDesktop.backgroundServiceNotSetUp');
    }
    if (state.mode === null) {
        return t('settingsDesktop.backgroundServiceUnknown');
    }
    return state.error ? t('settingsDesktop.backgroundServiceChangeFailed') : t('settingsDesktop.backgroundServiceSubtitle');
}

export const DesktopSettingsSection = React.memo(function DesktopSettingsSection() {
    const { theme } = useUnistyles();
    const backgroundService = useDesktopBackgroundServiceAutostart();

    // R16 (b) — one login-start setting: when the background service starts at login, the app
    // starts at login too, in the menu bar (the native side follows this setting; there is no
    // second switch for the app itself).
    if (!backgroundService.supported) {
        return null;
    }

    return (
        <ItemGroup
            title={t('settingsDesktop.title')}
            footer={t('settingsDesktop.footer')}
        >
            <DesktopWindowChromeSetting />
            <Item
                testID="settings-desktop-background-service-enabled"
                title={t('settingsDesktop.backgroundServiceTitle')}
                subtitle={resolveBackgroundServiceSubtitle(backgroundService)}
                icon={<Icon name="pulse" size={29} color={theme.colors.accent.green} />}
                rightElement={(
                    <Switch
                        value={backgroundService.mode === 'at-login'}
                        disabled={backgroundService.loading || backgroundService.mode === null}
                        onValueChange={(value) => {
                            // The switch position is presentation; the mode is the contract.
                            void backgroundService.setMode(value ? 'at-login' : 'on-demand');
                        }}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
});
