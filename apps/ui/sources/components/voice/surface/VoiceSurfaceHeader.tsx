import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import type { VoiceSurfaceState } from './resolveVoiceSurfaceState';
import { VoiceLevelVisualizer } from './VoiceLevelVisualizer';

type VoiceSurfaceHeaderStyles = Readonly<Record<string, unknown>>;
const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const MINIMUM_TARGET_STYLE = Object.freeze({
    minWidth: MINIMUM_TARGET_SIZE,
    minHeight: MINIMUM_TARGET_SIZE,
});

export const VoiceSurfaceHeader = React.memo(function VoiceSurfaceHeader(props: Readonly<{
    announceSubtitle: boolean;
    bargeInLabel: string;
    canBargeIn: boolean;
    isMicCaptureActive: boolean;
    isMuted: boolean;
    surfaceState: VoiceSurfaceState;
    micBadgeStyle: object;
    micIconColor: string;
    microphoneActiveLabel: string;
    microphoneInactiveLabel: string;
    microphoneMutedLabel: string;
    modeTestID?: string;
    onBargeIn: () => void;
    dataDisclosureLabel: string;
    dataDisclosureTestID?: string;
    onOpenDataDisclosure: () => void;
    showDataDisclosure: boolean;
    statusDotColor: string;
    statusFocusRef?: React.Ref<NonNullable<FocusReturnTarget>>;
    statusLabel: string;
    providerLabel: string | null;
    statusTestID?: string;
    statusTextColor: string;
    styles: VoiceSurfaceHeaderStyles;
    subtitle: string | null;
    subtitleColor: string;
}>) {
    const reduceMotion = useReducedMotionPreference();
    const isWeb = Platform.OS === 'web';
    const webModeTestIdProps = isWeb && props.modeTestID
        ? ({ 'data-testid': props.modeTestID } as const)
        : undefined;
    const webStatusTestIdProps = isWeb && props.statusTestID
        ? ({ 'data-testid': props.statusTestID } as const)
        : undefined;
    const isMicInputActive = props.isMicCaptureActive && !props.isMuted;
    const microphoneStateLabel = props.isMuted
        ? props.microphoneMutedLabel
        : props.isMicCaptureActive
            ? props.microphoneActiveLabel
            : props.microphoneInactiveLabel;
    const levelChannel = isMicInputActive
        ? 'input'
        : props.surfaceState === 'speaking'
            ? 'output'
            : null;
    const isStatusPulsing = props.surfaceState === 'connecting'
        || props.surfaceState === 'reconnecting'
        || props.surfaceState === 'thinking';
    const announceSpecificError = props.announceSubtitle && Boolean(props.subtitle);

    return (
        <View style={props.styles.statusLeft as any}>
            {props.canBargeIn ? (
                <Pressable
                    testID={props.modeTestID}
                    {...webModeTestIdProps}
                    accessibilityRole="button"
                    accessibilityLabel={props.bargeInLabel}
                    accessibilityValue={{ text: microphoneStateLabel }}
                    onPress={props.onBargeIn}
                    style={({ pressed }) => [
                        props.styles.micBadge,
                        props.micBadgeStyle,
                        { opacity: pressed ? 0.72 : 1 },
                        MINIMUM_TARGET_STYLE,
                    ] as any}
                >
                    <StatusDot color={props.statusDotColor} isPulsing={isStatusPulsing && !reduceMotion} size={7} style={props.styles.dot as any} />
                    <Ionicons
                        name={isMicInputActive ? 'mic' : 'mic-off-outline'}
                        size={13}
                        color={props.micIconColor}
                        style={props.styles.micIcon as any}
                    />
                    {levelChannel ? (
                        <VoiceLevelVisualizer
                            isActive
                            color={props.micIconColor}
                            channel={levelChannel}
                            fallbackPulse={levelChannel === 'output'}
                            size="small"
                        />
                    ) : null}
                </Pressable>
            ) : (
                <View
                    testID={props.modeTestID}
                    {...webModeTestIdProps}
                    accessible
                    accessibilityLabel={microphoneStateLabel}
                    style={[props.styles.micBadge as any, props.micBadgeStyle]}
                >
                    <StatusDot color={props.statusDotColor} isPulsing={isStatusPulsing && !reduceMotion} size={7} style={props.styles.dot as any} />
                    <Ionicons
                        name={isMicInputActive ? 'mic' : 'mic-off-outline'}
                        size={13}
                        color={props.micIconColor}
                        style={props.styles.micIcon as any}
                    />
                    {levelChannel ? (
                        <VoiceLevelVisualizer
                            isActive
                            color={props.micIconColor}
                            channel={levelChannel}
                            fallbackPulse={levelChannel === 'output'}
                            size="small"
                        />
                    ) : null}
                </View>
            )}
            <View style={props.styles.statusTextCol as any}>
                <View style={props.styles.statusTitleRow as any}>
                    <Text
                        ref={props.statusFocusRef as any}
                        testID={props.statusTestID}
                        {...webStatusTestIdProps}
                        accessibilityLiveRegion={announceSpecificError ? undefined : 'polite'}
                        tabIndex={isWeb ? -1 : undefined}
                        style={[props.styles.statusText as any, { color: props.statusTextColor }]}
                    >
                        {props.statusLabel}
                    </Text>
                    {props.providerLabel ? (
                        <Text style={[props.styles.providerText as any, { color: props.subtitleColor }]}>
                            {props.providerLabel}
                        </Text>
                    ) : null}
                    {props.showDataDisclosure ? (
                        <IconButton
                            testID={props.dataDisclosureTestID}
                            accessibilityLabel={props.dataDisclosureLabel}
                            tooltip={props.dataDisclosureLabel}
                            iconName="information-circle-outline"
                            size={MINIMUM_TARGET_SIZE}
                            iconSize={18}
                            variant="plain"
                            onPress={props.onOpenDataDisclosure}
                        />
                    ) : null}
                </View>
                {props.subtitle ? (
                    <Text
                        accessibilityLiveRegion={announceSpecificError ? 'polite' : undefined}
                        style={[props.styles.targetText as any, { color: props.subtitleColor }]}
                    >
                        {props.subtitle}
                    </Text>
                ) : null}
            </View>
        </View>
    );
});
