import * as React from 'react';
import { View, Text, ViewStyle, TextStyle, Pressable } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { SessionNoticeBanner, type SessionNoticeBannerProps } from '@/components/sessions/SessionNoticeBanner';
import { layout } from '@/components/layout';
import type { SwitchToLocalControlDisabledReason } from '@/sync/localControlSwitch';

interface ChatFooterProps {
    controlledByUser?: boolean;
    notice?: Pick<SessionNoticeBannerProps, 'title' | 'body'> | null;
    onRequestSwitchToRemote?: () => void;
    onRequestSwitchToLocal?: () => void;
    switchToLocalDisabledReason?: SwitchToLocalControlDisabledReason;
}

export const ChatFooter = React.memo((props: ChatFooterProps) => {
    const { theme } = useUnistyles();
    const containerStyle: ViewStyle = {
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 2,
    };
    const warningContainerStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: theme.colors.box.warning.background,
        borderRadius: 8,
        marginHorizontal: 32,
        marginTop: 4,
    };
    const warningTextStyle: TextStyle = {
        fontSize: 12,
        color: theme.colors.box.warning.text,
        marginLeft: 6,
        ...Typography.default()
    };
    const switchButtonStyle: ViewStyle = {
        marginLeft: 10,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.box.warning.text,
    };
    const switchButtonTextStyle: TextStyle = {
        fontSize: 12,
        color: theme.colors.box.warning.background,
        fontWeight: '700',
        ...Typography.default(),
    };

    const switchToLocalUnavailableText = React.useMemo(() => {
        switch (props.switchToLocalDisabledReason) {
            case 'machineOffline':
                return t('chatFooter.localModeUnavailableMachineOffline');
            case 'daemonStarted':
                return t('chatFooter.localModeUnavailableDaemonStarted');
            case 'resumeUnsupported':
                return t('chatFooter.localModeUnavailableNeedsResume');
            default:
                return null;
        }
    }, [props.switchToLocalDisabledReason]);

    return (
        <View style={containerStyle}>
            {props.controlledByUser && (
                <View style={warningContainerStyle}>
                    <Ionicons
                        name="information-circle"
                        size={16}
                        color={theme.colors.box.warning.text}
                    />
                    <Text style={warningTextStyle}>
                        {t('chatFooter.permissionsTerminalOnly')}
                    </Text>
                    {props.onRequestSwitchToRemote && (
                        <Pressable
                            accessibilityLabel={t('chatFooter.switchToRemote')}
                            onPress={props.onRequestSwitchToRemote}
                            style={switchButtonStyle}
                        >
                            <Text style={switchButtonTextStyle}>{t('chatFooter.switchToRemote')}</Text>
                        </Pressable>
                    )}
                </View>
            )}
            {!props.controlledByUser && (props.onRequestSwitchToLocal || switchToLocalUnavailableText) && (
                <View style={warningContainerStyle}>
                    <Ionicons
                        name="terminal-outline"
                        size={16}
                        color={theme.colors.box.warning.text}
                    />
                    <Text style={warningTextStyle}>
                        {props.onRequestSwitchToLocal ? t('chatFooter.localModeAvailable') : switchToLocalUnavailableText}
                    </Text>
                    {props.onRequestSwitchToLocal && (
                        <Pressable
                            accessibilityLabel={t('chatFooter.switchToLocal')}
                            onPress={props.onRequestSwitchToLocal}
                            style={switchButtonStyle}
                        >
                            <Text style={switchButtonTextStyle}>{t('chatFooter.switchToLocal')}</Text>
                        </Pressable>
                    )}
                </View>
            )}
            {props.notice && (
                <View style={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                    <View style={{ width: '100%', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
                        <SessionNoticeBanner
                            title={props.notice.title}
                            body={props.notice.body}
                            style={{ marginTop: 10, marginHorizontal: 8 }}
                        />
                    </View>
                </View>
            )}
        </View>
    );
});
