import * as React from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { Text } from '@/components/ui/text/Text';


export type CliNotDetectedBannerDismissScope = 'machine' | 'global' | 'temporary';

export function CliNotDetectedBanner(props: {
    agentId: AgentId;
    theme: any;
    onDismiss: (scope: CliNotDetectedBannerDismissScope) => void;
}) {
    const core = getAgentCore(props.agentId);
    const cliLabel = t(core.displayNameKey);
    const guideUrl = core.cli.installBanner.guideUrl;
    const openGuide = () => {
        if (!guideUrl) return;
        if (Platform.OS === 'web') {
            window.open(guideUrl, '_blank');
            return;
        }
        void Linking.openURL(guideUrl).catch(() => {});
    };

    return (
        <ItemGroup
            title={<View />}
            style={{ marginBottom: 12 }}
            headerStyle={{ paddingTop: 0, paddingBottom: 0 }}
            containerStyle={{
                backgroundColor: props.theme.colors.state.warning.background,
                borderColor: props.theme.colors.state.warning.border,
                borderWidth: 1,
            }}
        >
            <Item
                title={t('newSession.cliBanners.cliNotDetectedTitle', { cli: cliLabel })}
                subtitle={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                        <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                            {core.cli.installBanner.installKind === 'command'
                                ? t('newSession.cliBanners.installCommand', { command: core.cli.installBanner.installCommand ?? '' })
                                : t('newSession.cliBanners.installCliIfAvailable', { cli: cliLabel })}
                        </Text>
                        {guideUrl ? (
                            <Pressable onPress={openGuide}>
                                <Text style={{ fontSize: 11, color: props.theme.colors.text.link, ...Typography.default() }}>
                                    {t('newSession.cliBanners.viewInstallationGuide')}
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>
                )}
                icon={<Ionicons name="warning" size={16} color={props.theme.colors.state.neutral.foreground} />}
                showChevron={false}
                rightElement={(
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            flexWrap: 'wrap',
                            gap: 8,
                            maxWidth: 420,
                        }}
                    >
                        <Text style={{ fontSize: 10, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                            {t('newSession.cliBanners.dontShowFor')}
                        </Text>
                        <Pressable
                            onPress={() => props.onDismiss('machine')}
                            style={{
                                borderRadius: 8,
                                borderWidth: 1,
                                borderColor: props.theme.colors.text.secondary,
                                paddingHorizontal: 10,
                                paddingVertical: 6,
                            }}
                        >
                            <Text style={{ fontSize: 10, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                                {t('newSession.cliBanners.thisMachine')}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => props.onDismiss('global')}
                            style={{
                                borderRadius: 8,
                                borderWidth: 1,
                                borderColor: props.theme.colors.text.secondary,
                                paddingHorizontal: 10,
                                paddingVertical: 6,
                            }}
                        >
                            <Text style={{ fontSize: 10, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                                {t('newSession.cliBanners.anyMachine')}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => props.onDismiss('temporary')}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Ionicons name="close" size={18} color={props.theme.colors.text.secondary} />
                        </Pressable>
                    </View>
                )}
            />
        </ItemGroup>
    );
}
