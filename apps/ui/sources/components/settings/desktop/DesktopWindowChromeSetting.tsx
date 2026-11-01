import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { useDesktopWindowChromePolicy } from '@/hooks/ui/useDesktopWindowChromePolicy';
import { setDesktopNativeTitleBar } from '@/utils/platform/desktopWindowBridge';
import { t } from '@/text';

export function DesktopWindowChromeSetting() {
    const policy = useDesktopWindowChromePolicy();
    const [writing, setWriting] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    if (policy.canSetNativeTitleBar !== true) return null;

    return (
        <Item
            testID="settings-desktop-native-title-bar"
            title={t('settingsDesktop.nativeTitleBarTitle')}
            subtitle={t(failed
                ? 'settingsDesktop.nativeTitleBarChangeFailed'
                : policy.nativeTitleBarPersistenceError
                    ? 'settingsDesktop.nativeTitleBarPersistenceFailed'
                    : 'settingsDesktop.nativeTitleBarSubtitle')}
            rightElement={(
                <Switch
                    accessibilityLabel={t('settingsDesktop.nativeTitleBarTitle')}
                    value={policy.strategy === 'native-windows-frame'}
                    disabled={writing}
                    onValueChange={async (enabled) => {
                        setWriting(true);
                        setFailed(false);
                        try { await setDesktopNativeTitleBar(enabled); }
                        catch { setFailed(true); }
                        finally { setWriting(false); }
                    }}
                />
            )}
            showChevron={false}
        />
    );
}
