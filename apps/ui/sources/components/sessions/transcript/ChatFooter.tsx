import * as React from 'react';
import { View, ViewStyle, TextStyle, Pressable } from 'react-native';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { SessionNoticeBanner, type SessionNoticeBannerProps } from '@/components/sessions/SessionNoticeBanner';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import type { SessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';

export type ChatFooterDirectControlState = Readonly<{
    machineOnline: boolean;
    runnerActive: boolean;
    activity: 'running' | 'active_recently' | 'idle' | 'unknown';
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    takeoverInFlight: 'direct' | 'persisted' | null;
    onRequestTakeOverDirect?: () => void | Promise<void>;
    onRequestTakeOverPersist?: () => void | Promise<void>;
}> | null;

interface ChatFooterProps {
    controlledByUser?: boolean;
    localControl?: SessionLocalControlState | null;
    permissionsInUiWhileLocal?: boolean;
    notice?: Pick<SessionNoticeBannerProps, 'title' | 'body'> | null;
    /**
     * UI-only ephemeral state while a local-controlled session is switching back to remote.
     * This is intentionally not persisted to the session transcript.
     */
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    onRequestSwitchToLocal?: () => void;
    directControl?: ChatFooterDirectControlState;
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

    const localControlBanner = React.useMemo(() => {
        const localControl = props.localControl ?? null;
        if (!localControl && !props.controlledByUser) return null;

        const derived = localControl ?? {
            attached: props.controlledByUser === true,
            topology: 'exclusive',
            remoteWritable: false,
            canAttach: false,
            canDetach: props.controlledByUser === true,
        } satisfies SessionLocalControlState;

        if (!derived.attached && !derived.canAttach) return null;

        const switchingToRemote = props.controlSwitchTo === 'remote';
        const isSharedAttached = derived.attached && derived.topology === 'shared';
        const showSwitchToRemoteButton =
            derived.attached
            && derived.topology === 'exclusive'
            && !switchingToRemote
            && Boolean(props.onRequestSwitchToRemote);
        const showDetachButton =
            derived.attached
            && derived.topology === 'shared'
            && !switchingToRemote
            && derived.canDetach
            && Boolean(props.onRequestSwitchToRemote);
        const showAttachButton =
            !derived.attached
            && derived.canAttach
            && Boolean(props.onRequestSwitchToLocal);

        const textKey = (() => {
            if (switchingToRemote) return 'chatFooter.switchingToRemote';
            if (isSharedAttached) return 'chatFooter.sessionRunningLocallyAndRemotely';
            if (props.permissionsInUiWhileLocal) return 'chatFooter.sessionRunningLocally';
            return 'chatFooter.permissionsTerminalOnly';
        })();

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
                        {showSwitchToRemoteButton && (
                            <Pressable
                                testID="session-chatFooter-switchToRemote"
                                accessibilityLabel={t('chatFooter.switchToRemote')}
                                onPress={props.onRequestSwitchToRemote}
                                style={switchButtonStyle}
                            >
                                <Text style={switchButtonTextStyle}>{t('chatFooter.switchToRemote')}</Text>
                            </Pressable>
                        )}
                        {showDetachButton && (
                            <Pressable
                                testID="session-chatFooter-detachLocalTerminal"
                                accessibilityLabel={t('chatFooter.detachLocalTerminal')}
                                onPress={props.onRequestSwitchToRemote}
                                style={switchButtonStyle}
                            >
                                <Text style={switchButtonTextStyle}>{t('chatFooter.detachLocalTerminal')}</Text>
                            </Pressable>
                        )}
                        {showAttachButton && (
                            <Pressable
                                testID="session-chatFooter-switchToLocal"
                                accessibilityLabel={t('chatFooter.switchToLocal')}
                                onPress={props.onRequestSwitchToLocal}
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
        props.controlSwitchTo,
        props.controlledByUser,
        props.localControl,
        props.onRequestSwitchToLocal,
        props.onRequestSwitchToRemote,
        props.permissionsInUiWhileLocal,
        switchButtonStyle,
        switchButtonTextStyle,
        theme.colors.box.warning.text,
        warningContainerStyle,
        warningTextStyle,
    ]);

    const directModeBanner = React.useMemo(() => {
        if (!props.directControl) return null;
        if (props.directControl.runnerActive) return null;

        const switchingToDirect = props.directControl.takeoverInFlight === 'direct';
        const switchingToPersisted = props.directControl.takeoverInFlight === 'persisted';
        const showDirectAction =
            !switchingToDirect
            && !switchingToPersisted
            && props.directControl.machineOnline
            && props.directControl.canTakeOverDirect
            && typeof props.directControl.onRequestTakeOverDirect === 'function';
        const showPersistAction =
            !switchingToDirect
            && !switchingToPersisted
            && props.directControl.machineOnline
            && props.directControl.canTakeOverPersist
            && typeof props.directControl.onRequestTakeOverPersist === 'function';

        const textKey = (() => {
            if (switchingToPersisted) return 'chatFooter.switchingToPersistedTakeover';
            if (switchingToDirect) return 'chatFooter.switchingToDirectTakeover';
            if (!props.directControl.machineOnline) return 'chatFooter.directSessionMachineOffline';
            return 'chatFooter.directSessionTakeoverAvailable';
        })();

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
                        {showDirectAction && (
                            <Pressable
                                testID="session-chatFooter-takeOverDirect"
                                accessibilityLabel={t('chatFooter.takeOverDirect')}
                                onPress={props.directControl.onRequestTakeOverDirect}
                                style={switchButtonStyle}
                            >
                                <Text style={switchButtonTextStyle}>{t('chatFooter.takeOverDirect')}</Text>
                            </Pressable>
                        )}
                        {showPersistAction && (
                            <Pressable
                                testID="session-chatFooter-takeOverPersist"
                                accessibilityLabel={t('chatFooter.takeOverPersist')}
                                onPress={props.directControl.onRequestTakeOverPersist}
                                style={switchButtonStyle}
                            >
                                <Text style={switchButtonTextStyle}>{t('chatFooter.takeOverPersist')}</Text>
                            </Pressable>
                        )}
                    </View>
                </View>
            </View>
        );
    }, [
        props.directControl,
        switchButtonStyle,
        switchButtonTextStyle,
        theme.colors.box.warning.text,
        warningContainerStyle,
        warningTextStyle,
    ]);

    return (
        <View style={containerStyle}>
            {directModeBanner}
            {localControlBanner}
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
