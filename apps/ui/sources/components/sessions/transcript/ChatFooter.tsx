import * as React from 'react';
import { View, ViewStyle, TextStyle, Pressable } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { SessionNoticeBanner, type SessionNoticeBannerProps } from '@/components/sessions/SessionNoticeBanner';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import type { SwitchToLocalControlDisabledReason } from '@/sync/domains/session/control/localControlSwitch';

export type ChatFooterLocalControlState = Readonly<{
    disabledReason: SwitchToLocalControlDisabledReason | null;
    onRequestSwitchToLocal?: () => void;
}> | null;

interface ChatFooterProps {
    controlledByUser?: boolean;
    permissionsInUiWhileLocal?: boolean;
    notice?: Pick<SessionNoticeBannerProps, 'title' | 'body'> | null;
    /**
     * UI-only ephemeral state while a remote↔local control switch RPC is in flight.
     * This is intentionally not persisted to the session transcript.
     */
    controlSwitchTo?: 'local' | 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    localControl?: ChatFooterLocalControlState;
}

export const ChatFooter = React.memo((props: ChatFooterProps) => {
    const { theme } = useUnistyles();
    const containerStyle: ViewStyle = {
        // Allow children to take full width so long banners can wrap instead of overflowing
        alignItems: 'stretch',
        paddingTop: 4,
        paddingBottom: 2,
    };
    const warningContainerStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.box.warning.background,
        borderRadius: 8,
        marginTop: 4,
        marginHorizontal: 8,
    };
    const warningTextStyle: TextStyle = {
        flex: 1,
        fontSize: 12,
        color: theme.colors.box.warning.text,
        marginLeft: 6,
        ...Typography.default()
    };
    const switchButtonStyle: ViewStyle = {
        flexShrink: 0,
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

    const localModeBanner = React.useMemo(() => {
        if (props.controlledByUser) return null;
        if (!props.localControl) return null;
        const switchingToLocal = props.controlSwitchTo === 'local';

        const textKey = (() => {
            if (switchingToLocal) return 'chatFooter.switchingToLocal';
            const reason = props.localControl?.disabledReason ?? null;
            if (reason === 'machineOffline') return 'chatFooter.localModeUnavailableMachineOffline';
            if (reason === 'daemonStarted') return 'chatFooter.localModeUnavailableDaemonStarted';
            if (reason === 'resumeUnsupported') return 'chatFooter.localModeUnavailableNeedsResume';
            return 'chatFooter.localModeAvailable';
        })();

        const canSwitch =
            !switchingToLocal &&
            props.localControl.disabledReason == null &&
            typeof props.localControl.onRequestSwitchToLocal === 'function';

        return (
            <View style={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                <View style={{ width: '100%', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
                    <View style={warningContainerStyle}>
                        <Ionicons
                            name="information-circle"
                            size={16}
                            color={theme.colors.box.warning.text}
                        />
                        <Text selectable style={warningTextStyle}>
                            {t(textKey)}
                        </Text>
                        {canSwitch && (
                            <Pressable
                                testID="session-chatFooter-switchToLocal"
                                accessibilityLabel={t('chatFooter.switchToLocal')}
                                onPress={props.localControl.onRequestSwitchToLocal}
                                style={switchButtonStyle}
                            >
                                <Text style={switchButtonTextStyle}>{t('chatFooter.switchToLocal')}</Text>
                            </Pressable>
                        )}
                    </View>
                </View>
            </View>
        );
    }, [
        props.controlledByUser,
        props.controlSwitchTo,
        props.localControl,
        switchButtonStyle,
        switchButtonTextStyle,
        theme.colors.box.warning.text,
        warningContainerStyle,
        warningTextStyle,
    ]);

    return (
        <View style={containerStyle}>
            {localModeBanner}
            {props.controlledByUser && (
                (() => {
                    const switchingToRemote = props.controlSwitchTo === 'remote';
                    const showSwitchButton = !switchingToRemote && Boolean(props.onRequestSwitchToRemote);
                    return (
                <View style={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                    <View style={{ width: '100%', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
                        <View style={warningContainerStyle}>
                            <Ionicons
                                name="information-circle"
                                size={16}
                                color={theme.colors.box.warning.text}
                            />
                            <Text selectable style={warningTextStyle}>
                                {t(
                                    switchingToRemote
                                        ? 'chatFooter.switchingToRemote'
                                        : props.permissionsInUiWhileLocal
                                            ? 'chatFooter.sessionRunningLocally'
                                            : 'chatFooter.permissionsTerminalOnly'
                                )}
                            </Text>
                            {showSwitchButton && (
                                <Pressable
                                    testID="session-chatFooter-switchToRemote"
                                    accessibilityLabel={t('chatFooter.switchToRemote')}
                                    onPress={props.onRequestSwitchToRemote}
                                    style={switchButtonStyle}
                                >
                                    <Text style={switchButtonTextStyle}>{t('chatFooter.switchToRemote')}</Text>
                                </Pressable>
                            )}
                        </View>
                    </View>
                </View>
                    );
                })()
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
