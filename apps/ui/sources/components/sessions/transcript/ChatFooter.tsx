import * as React from 'react';
import { View, ViewStyle, TextStyle, Pressable } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { SessionNoticeBanner, type SessionNoticeBannerProps } from '@/components/sessions/SessionNoticeBanner';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';


interface ChatFooterProps {
    controlledByUser?: boolean;
    permissionsInUiWhileLocal?: boolean;
    notice?: Pick<SessionNoticeBannerProps, 'title' | 'body'> | null;
    onRequestSwitchToRemote?: () => void;
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

    return (
        <View style={containerStyle}>
            {props.controlledByUser && (
                <View style={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                    <View style={{ width: '100%', flexGrow: 1, flexBasis: 0, maxWidth: layout.maxWidth }}>
                        <View style={warningContainerStyle}>
                            <Ionicons
                                name="information-circle"
                                size={16}
                                color={theme.colors.box.warning.text}
                            />
                            <Text style={warningTextStyle}>
                                {t(
                                    props.permissionsInUiWhileLocal
                                        ? 'chatFooter.sessionRunningLocally'
                                        : 'chatFooter.permissionsTerminalOnly'
                                )}
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
                    </View>
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
