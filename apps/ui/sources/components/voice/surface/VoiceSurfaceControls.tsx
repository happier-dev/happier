import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';

import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { VoiceBars } from '@/components/ui/status/VoiceBars';

type VoiceSurfaceControlStyles = Readonly<Record<string, unknown>>;

export function VoiceSurfaceControls(props: Readonly<{
    cancelTurnLabel: string;
    canCancelTurn: boolean;
    canMute: boolean;
    canOpenConversation: boolean;
    canStop: boolean;
    canTeleportToSessionRoot: boolean;
    controlsDisabled: boolean;
    controlsLoading: boolean;
    controlsActive: boolean;
    isMuted: boolean;
    isSpeaking: boolean;
    muteLabel: string;
    openLabel: string;
    startStopLabel: string;
    styles: VoiceSurfaceControlStyles;
    textColor: string;
    teleportLabel: string;
    tintColor: string;
    cancelTestID?: string;
    openConversationTestID?: string;
    toggleTestID?: string;
    onCancelTurn: () => void;
    onToggleMute: () => void;
    onOpenConversation: () => void;
    onTeleport: () => void;
    onToggle: () => void;
}>) {
    return (
        <View style={props.styles.statusRight as any}>
            {props.isSpeaking ? <VoiceBars isActive color={props.textColor} size="small" /> : null}

            {props.canCancelTurn ? (
                <Pressable
                    testID={props.cancelTestID}
                    accessibilityRole="button"
                    accessibilityLabel={props.cancelTurnLabel}
                    onPress={props.onCancelTurn}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any]}
                >
                    <Ionicons name="close-circle-outline" size={18} color={props.textColor} />
                </Pressable>
            ) : null}

            {props.canMute ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.muteLabel}
                    onPress={props.onToggleMute}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any]}
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
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any]}
                >
                    <Ionicons name="chatbubble-ellipses-outline" size={18} color={props.textColor} />
                </Pressable>
            ) : null}

            {props.canTeleportToSessionRoot ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.teleportLabel}
                    onPress={props.onTeleport}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.iconAction as any]}
                >
                    <Ionicons name="navigate-outline" size={18} color={props.textColor} />
                </Pressable>
            ) : null}

            <PrimaryCircleIconButton
                onPress={props.onToggle}
                disabled={props.controlsDisabled}
                loading={props.controlsLoading}
                active={props.controlsActive}
                accessibilityLabel={props.startStopLabel}
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
        </View>
    );
}
