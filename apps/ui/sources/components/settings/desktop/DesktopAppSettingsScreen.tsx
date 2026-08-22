import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { useDesktopAutostart } from './useDesktopAutostart';
import { DesktopOverlaySettingsSection } from './DesktopOverlaySettingsSection';
import { DesktopSettingsIonicon } from './DesktopSettingsIonicon';

export const DesktopAppSettingsScreen = React.memo(function DesktopAppSettingsScreen() {
    const { theme } = useUnistyles();
    const autostart = useDesktopAutostart();
    const showOverlaySettings = isDesktopHost();

    if (!autostart.supported && !showOverlaySettings) {
        return null;
    }

    return (
        <>
            <ItemList style={{ paddingTop: 0 }}>
                {autostart.supported ? (
                    <ItemGroup>
                        <Item
                            testID="settings-desktop-autostart-enabled"
                            title={t('settingsDesktop.startOnLoginTitle')}
                            subtitle={autostart.error ?? t('settingsDesktop.startOnLoginSubtitle')}
                            icon={<DesktopSettingsIonicon name="desktop-outline" size={29} color={theme.colors.accent.blue} />}
                            rightElement={(
                                <Switch
                                    value={autostart.enabled}
                                    disabled={autostart.loading}
                                    onValueChange={(value) => {
                                        void autostart.setEnabled(Boolean(value));
                                    }}
                                />
                            )}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : null}

                {showOverlaySettings ? <DesktopOverlaySettingsSection /> : null}
            </ItemList>
        </>
    );
});
