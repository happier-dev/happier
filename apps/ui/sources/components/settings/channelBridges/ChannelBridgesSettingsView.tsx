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
import type { FeatureId } from '@happier-dev/protocol';
import { FeatureDiagnosticsPanel } from '@/components/settings/features/FeatureDiagnosticsPanel';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { t } from '@/text';

export const ChannelBridgesSettingsView = React.memo(function ChannelBridgesSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const channelBridgesDecision = useFeatureDecision('channelBridges', { scopeKind: 'runtime' });
    const telegramDecision = useFeatureDecision('channelBridges.telegram', { scopeKind: 'runtime' });

    const loading = channelBridgesDecision === null;
    const needsLocalEnablement = channelBridgesDecision?.blockedBy === 'local_policy';
    const supported = channelBridgesDecision?.state !== 'unsupported';
    const telegramEnabled = telegramDecision?.state === 'enabled';

    const configureTelegramCommand = React.useMemo(() => {
        return [
            'happier bridge telegram set',
            '--bot-token <BOT_TOKEN>',
            '--allowed-chat-ids <CHAT_ID_1,CHAT_ID_2>',
            '--require-topics false',
        ].join(' ');
    }, []);

    const diagnosticsFeatureIds = React.useMemo(() => ([
        'channelBridges',
        'channelBridges.telegram',
    ] as const satisfies readonly FeatureId[]), []);

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings-channel-bridges-screen">
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <ItemGroup title={t('settings.channelBridges')} footer={t('settingsFeatures.expChannelBridgesSubtitle')}>
                    {loading ? (
                        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }} testID="settings-channel-bridges-loading">
                            <Text style={{ color: theme.colors.textSecondary }}>
                                {t('common.loading')}
                            </Text>
                        </View>
                    ) : !supported ? (
                        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }} testID="settings-channel-bridges-unsupported">
                            <Text style={{ color: theme.colors.textSecondary }}>
                                {t('settingsChannelBridges.unsupported')}
                            </Text>
                        </View>
                    ) : needsLocalEnablement ? (
                        <Item
                            testID="settings-channel-bridges-enable-in-features"
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

                {supported && !needsLocalEnablement && telegramEnabled && !loading ? (
                    <ItemGroup title={t('settingsChannelBridges.telegramTitle')} footer={t('settingsChannelBridges.telegramFooter')}>
                        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }} testID="settings-channel-bridges-telegram-config">
                            <CodeView code={configureTelegramCommand} language="bash" />
                        </View>
                    </ItemGroup>
                ) : null}

                {!loading && supported ? <FeatureDiagnosticsPanel featureIds={diagnosticsFeatureIds} /> : null}
            </View>
        </ItemList>
    );
});
