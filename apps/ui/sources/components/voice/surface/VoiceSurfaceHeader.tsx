import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';

type VoiceSurfaceHeaderStyles = Readonly<Record<string, unknown>>;

export function VoiceSurfaceHeader(props: Readonly<{
    bargeInLabel: string;
    canBargeIn: boolean;
    isConnecting: boolean;
    isListening: boolean;
    micBadgeStyle: object;
    micIconColor: string;
    modeTestID?: string;
    onBargeIn: () => void;
    statusDotColor: string;
    statusLabel: string;
    statusTestID?: string;
    statusTextColor: string;
    styles: VoiceSurfaceHeaderStyles;
    subtitle: string | null;
    subtitleColor: string;
}>) {
    const isWeb = Platform.OS === 'web';
    const webModeTestIdProps = isWeb && props.modeTestID
        ? ({ 'data-testid': props.modeTestID } as const)
        : undefined;
    const webStatusTestIdProps = isWeb && props.statusTestID
        ? ({ 'data-testid': props.statusTestID } as const)
        : undefined;

    return (
        <View style={props.styles.statusLeft as any}>
            {props.canBargeIn ? (
                <Pressable
                    testID={props.modeTestID}
                    {...webModeTestIdProps}
                    accessibilityRole="button"
                    accessibilityLabel={props.bargeInLabel}
                    onPress={props.onBargeIn}
                    style={({ pressed }) => [
                        props.styles.micBadge,
                        props.micBadgeStyle,
                        { opacity: pressed ? 0.72 : 1 },
                    ] as any}
                >
                    <StatusDot color={props.statusDotColor} isPulsing={props.isConnecting} size={7} style={props.styles.dot as any} />
                    <Ionicons name="mic-off-outline" size={13} color={props.micIconColor} style={props.styles.micIcon as any} />
                </Pressable>
            ) : (
                <View testID={props.modeTestID} {...webModeTestIdProps} style={[props.styles.micBadge as any, props.micBadgeStyle]}>
                    <StatusDot color={props.statusDotColor} isPulsing={props.isConnecting} size={7} style={props.styles.dot as any} />
                    <Ionicons
                        name={props.isListening ? 'mic' : 'mic-off-outline'}
                        size={13}
                        color={props.micIconColor}
                        style={props.styles.micIcon as any}
                    />
                </View>
            )}
            <View style={props.styles.statusTextCol as any}>
                <Text
                    testID={props.statusTestID}
                    {...webStatusTestIdProps}
                    style={[props.styles.statusText as any, { color: props.statusTextColor }]}
                    numberOfLines={1}
                >
                    {props.statusLabel}
                </Text>
                {props.subtitle ? (
                    <Text style={[props.styles.targetText as any, { color: props.subtitleColor }]} numberOfLines={1}>
                        {props.subtitle}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}
