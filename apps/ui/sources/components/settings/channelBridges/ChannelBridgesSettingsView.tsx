import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { CodeView } from '@/components/ui/media/CodeView';
import { Text } from '@/components/ui/text/Text';
import { FeatureDiagnosticsPanel } from '@/components/settings/features/FeatureDiagnosticsPanel';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { t } from '@/text';

export const ChannelBridgesSettingsView = React.memo(function ChannelBridgesSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const decision = useFeatureDecision('channelBridges');

    const needsLocalEnablement = decision?.blockedBy === 'local_policy';
    const supported = decision?.state !== 'unsupported';

    const configureTelegramCommand = React.useMemo(() => {
        return [
            'happier bridge telegram set',
            '--bot-token <BOT_TOKEN>',
            '--allowed-chat-ids <CHAT_ID_1,CHAT_ID_2>',
            '--require-topics false',
        ].join(' ');
    }, []);

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings-channel-bridges-screen">
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <ItemGroup title={t('settings.channelBridges')} footer={t('settingsFeatures.expChannelBridgesSubtitle')}>
                    {!supported ? (
                        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                            <Text style={{ color: theme.colors.textSecondary }}>
                                {t('settingsChannelBridges.unsupported')}
                            </Text>
                        </View>
                    ) : needsLocalEnablement ? (
                        <Item
                            title={t('settingsChannelBridges.enableInFeatures')}
                            subtitle={t('settingsChannelBridges.enableInFeaturesSubtitle')}
                            icon={<Ionicons name="flask-outline" size={24} color={theme.colors.accent.orange} />}
                            onPress={() => router.push('/(app)/settings/features')}
                        />
                    ) : (
                        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                            <Text style={{ color: theme.colors.textSecondary }}>
                                {t('settingsChannelBridges.description')}
                            </Text>
                        </View>
                    )}
                </ItemGroup>

                {supported ? (
                    <ItemGroup title={t('settingsChannelBridges.telegramTitle')} footer={t('settingsChannelBridges.telegramFooter')}>
                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                            <CodeView code={configureTelegramCommand} language="bash" />
                        </View>
                    </ItemGroup>
                ) : null}

                {decision ? (
                    <ItemGroup title={t('settingsChannelBridges.diagnosticsTitle')}>
                        <FeatureDiagnosticsPanel decision={decision} />
                    </ItemGroup>
                ) : null}
            </View>
        </ItemList>
    );
});

