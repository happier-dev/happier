import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';

import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';

type VoiceSurfaceControlStyles = Readonly<Record<string, unknown>>;
const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const MINIMUM_TARGET_STYLE = Object.freeze({
    minWidth: MINIMUM_TARGET_SIZE,
    minHeight: MINIMUM_TARGET_SIZE,
});

export const VoiceSurfaceControls = React.memo(function VoiceSurfaceControls(props: Readonly<{
    cancelTurnLabel: string;
    canCancelTurn: boolean;
    canMute: boolean;
    canOpenConversation: boolean;
    canRecover: boolean;
    canStop: boolean;
    canTeleportToSessionRoot: boolean;
    controlsDisabled: boolean;
    controlsLoading: boolean;
    controlsActive: boolean;
    showStartStopAction: boolean;
    isMuted: boolean;
    muteLabel: string;
    openLabel: string;
    recoveryLabel: string;
    startStopLabel: string;
    styles: VoiceSurfaceControlStyles;
    textColor: string;
    teleportLabel: string;
    tintColor: string;
    cancelTestID?: string;
    openConversationTestID?: string;
    recoveryTestID?: string;
    toggleTestID?: string;
    onCancelTurn: () => void;
    onToggleMute: () => void;
    onOpenConversation: () => void;
    onRecover: () => void;
    onTeleport: () => void;
    onToggle: () => void;
}>) {
    const recoveryActionRef = React.useRef<FocusReturnTarget>(null);
    const focusRecoveryAfterStartRef = React.useRef(false);
    const wasRecoverableRef = React.useRef(props.canRecover);

    React.useLayoutEffect(() => {
        const becameRecoverable = !wasRecoverableRef.current && props.canRecover;
        wasRecoverableRef.current = props.canRecover;
        if (!becameRecoverable || !focusRecoveryAfterStartRef.current) return;
        focusRecoveryAfterStartRef.current = false;
        restoreFocusToBestTarget(recoveryActionRef);
    }, [props.canRecover]);

    React.useEffect(() => {
        if (!props.showStartStopAction || props.canStop || props.controlsActive) {
            focusRecoveryAfterStartRef.current = false;
        }
    }, [props.canStop, props.controlsActive, props.showStartStopAction]);

    const handleToggle = React.useCallback(() => {
        if (!props.canStop) {
            focusRecoveryAfterStartRef.current = true;
        }
        props.onToggle();
    }, [props.canStop, props.onToggle]);

    if (props.canRecover) {
        return (
            <View style={props.styles.statusRight as any}>
                <Pressable
                    ref={recoveryActionRef as any}
                    testID={props.recoveryTestID}
                    accessibilityRole="button"
                    accessibilityLabel={props.recoveryLabel}
                    onPress={props.onRecover}
                    style={({ pressed }) => [
                        props.styles.recoveryAction as any,
                        MINIMUM_TARGET_STYLE,
                        { opacity: pressed ? 0.72 : 1 },
                    ]}
                >
                    <Text style={[props.styles.recoveryActionText as any, { color: props.textColor }]}>
                        {props.recoveryLabel}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={props.styles.statusRight as any}>
            {props.canCancelTurn ? (
                <Pressable
                    testID={props.cancelTestID}
                    accessibilityRole="button"
                    accessibilityLabel={props.cancelTurnLabel}
                    onPress={props.onCancelTurn}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any, MINIMUM_TARGET_STYLE]}
                >
                    <Ionicons name="close-circle-outline" size={18} color={props.textColor} />
                </Pressable>
            ) : null}

            {props.canMute ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.muteLabel}
                    accessibilityState={{ selected: props.isMuted }}
                    aria-pressed={props.isMuted}
                    onPress={props.onToggleMute}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any, MINIMUM_TARGET_STYLE]}
                >
                    <Ionicons name={props.isMuted ? 'mic-off-outline' : 'mic-outline'} size={18} color={props.textColor} />
                </Pressable>
            ) : null}

            {props.canOpenConversation ? (
                <Pressable
                    testID={props.openConversationTestID}
                    accessibilityRole="button"
                    accessibilityLabel={props.openLabel}
                    onPress={props.onOpenConversation}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any, MINIMUM_TARGET_STYLE]}
                >
                    <Ionicons name="chatbubble-ellipses-outline" size={18} color={props.textColor} />
                </Pressable>
            ) : null}

            {props.canTeleportToSessionRoot ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.teleportLabel}
                    onPress={props.onTeleport}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any, MINIMUM_TARGET_STYLE]}
                >
                    <Ionicons name="navigate-outline" size={18} color={props.textColor} />
                </Pressable>
            ) : null}

            {props.showStartStopAction ? (
                <PrimaryCircleIconButton
                    onPress={handleToggle}
                    disabled={props.controlsDisabled}
                    loading={props.controlsLoading}
                    active={props.controlsActive}
                    accessibilityLabel={props.startStopLabel}
                    style={[props.styles.primaryAction as any, MINIMUM_TARGET_STYLE]}
                    testID={props.toggleTestID}
                >
                    {props.canStop ? (
                        <Ionicons name="stop-circle" size={22} color={props.tintColor} />
                    ) : (
                        <Image
                            source={require('@/assets/images/icon-voice-white.png')}
                            style={{ width: 22, height: 22 }}
                            tintColor={props.tintColor}
                        />
                    )}
                </PrimaryCircleIconButton>
            ) : null}
        </View>
    );
});
