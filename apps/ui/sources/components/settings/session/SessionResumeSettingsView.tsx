import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';

export const SessionResumeSettingsView = React.memo(function SessionResumeSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [sessionReplayEnabled, setSessionReplayEnabled] = useSettingMutable('sessionReplayEnabled');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.replayResume.title')} footer={t('settingsSession.replayResume.footer')}>
                <Item
                    testID="settings-session-replay-enabled-item"
                    title={t('settingsSession.replayResume.enabledTitle')}
                    subtitle={sessionReplayEnabled ? t('settingsSession.replayResume.enabledSubtitleOn') : t('settingsSession.replayResume.enabledSubtitleOff')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.state.success.foreground} />}
                    rightElement={<Switch value={sessionReplayEnabled} onValueChange={setSessionReplayEnabled} />}
                    showChevron={false}
                    onPress={() => setSessionReplayEnabled(!sessionReplayEnabled)}
                />
            </ItemGroup>
            <ItemGroup title={t('settingsSession.handoff.groupTitle')} footer={t('settingsSession.handoff.groupFooter')}>
                <Item
                    title={t('settingsSession.handoff.title')}
                    subtitle={t('settingsSession.handoff.entrySubtitle')}
                    icon={<Ionicons name="swap-horizontal-outline" size={29} color={theme.colors.accent.green} />}
                    onPress={() => router.push('/(app)/settings/session/handoff')}
                />
            </ItemGroup>
        </ItemList>
    );
});

export default SessionResumeSettingsView;
