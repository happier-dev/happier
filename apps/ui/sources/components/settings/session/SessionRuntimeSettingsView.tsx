import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';

export const SessionRuntimeSettingsView = React.memo(function SessionRuntimeSettingsView() {
    const { theme } = useUnistyles();
    const [useTmux, setUseTmux] = useSettingMutable('sessionUseTmux');
    const [terminalConnectLegacySecretExportEnabled, setTerminalConnectLegacySecretExportEnabled] = useSettingMutable('terminalConnectLegacySecretExportEnabled');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('profiles.tmux.title')}>
                <Item
                    testID="settings-session-tmux-enabled-item"
                    title={t('profiles.tmux.spawnSessionsTitle')}
                    subtitle={useTmux ? t('profiles.tmux.spawnSessionsEnabledSubtitle') : t('profiles.tmux.spawnSessionsDisabledSubtitle')}
                    icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={useTmux} onValueChange={setUseTmux} />}
                    showChevron={false}
                    onPress={() => setUseTmux(!useTmux)}
                />
            </ItemGroup>
            <ItemGroup title={t('settingsSession.terminalConnect.title')}>
                <Item
                    title={t('settingsSession.terminalConnect.legacySecretExportTitle')}
                    subtitle={terminalConnectLegacySecretExportEnabled
                        ? t('settingsSession.terminalConnect.legacySecretExportEnabledSubtitle')
                        : t('settingsSession.terminalConnect.legacySecretExportDisabledSubtitle')}
                    icon={<Ionicons name="shield-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={terminalConnectLegacySecretExportEnabled} onValueChange={setTerminalConnectLegacySecretExportEnabled} />}
                    showChevron={false}
                    onPress={() => setTerminalConnectLegacySecretExportEnabled(!terminalConnectLegacySecretExportEnabled)}
                />
            </ItemGroup>
        </ItemList>
    );
});

export default SessionRuntimeSettingsView;
