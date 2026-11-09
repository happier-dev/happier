import * as React from 'react';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { DESKTOP_SETTINGS } from './desktopSettings';
import { Switch } from '@/components/ui/forms/Switch';
import { useDesktopWindowChromePolicy } from '@/hooks/ui/useDesktopWindowChromePolicy';
import type { DesktopWindowChromePolicy } from '@/utils/platform/desktopWindowBridge';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { t } from '@/text';

export function DesktopWindowChromeSetting() {
    const policy = useDesktopWindowChromePolicy();
    return policy.canSetNativeTitleBar === true ? <NativeTitleBarSetting policy={policy} /> : null;
}

function NativeTitleBarSetting({ policy }: Readonly<{ policy: DesktopWindowChromePolicy }>) {
    const write = useSettingActionWriter();
    const [writing, setWriting] = React.useState(false);
    const [failed, setFailed] = React.useState(false);

    return (
        <ItemGroup>
        <SettingRow
            testID="settings-desktop-native-title-bar"
            setting={DESKTOP_SETTINGS.settings.nativeTitleBar}
            subtitle={t(policy.nativeTitleBarPersistenceError
                ? 'settingsDesktop.nativeTitleBarPersistenceFailed'
                : failed
                    ? 'settingsDesktop.nativeTitleBarChangeFailed'
                    : policy.nativeTitleBarRestartRequired
                        ? 'settingsDesktop.nativeTitleBarRestartRequired'
                        : 'settingsDesktop.nativeTitleBarSubtitle')}
            rightElement={(
                <Switch
                    accessibilityLabel={t('settingsDesktop.nativeTitleBarTitle')}
                    value={policy.useNativeTitleBar ?? (policy.strategy === 'native-windows-frame')}
                    disabled={writing}
                    onValueChange={async (enabled) => {
                        setWriting(true);
                        setFailed(false);
                        try {
                            const result = await write(DESKTOP_SETTINGS.settings.nativeTitleBar, enabled);
                            if (!result.ok) setFailed(true);
                        }
                        catch { setFailed(true); }
                        finally { setWriting(false); }
                    }}
                />
            )}
            showChevron={false}
        />
        </ItemGroup>
    );
}
