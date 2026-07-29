import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { streamPlayerStyles } from './styles';

function StreamControlButton(props: Readonly<{
    disabled: boolean;
    label: string;
    onPress?: () => void;
    testID: string;
}>): React.ReactElement {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.disabled ? undefined : props.onPress}
            style={[
                streamPlayerStyles.controlButton,
                props.disabled ? streamPlayerStyles.controlButtonDisabled : null,
            ]}
            testID={props.testID}
        >
            <Text style={[
                streamPlayerStyles.controlButtonText,
                props.disabled ? streamPlayerStyles.controlButtonTextDisabled : null,
            ]}>
                {props.label}
            </Text>
        </Pressable>
    );
}

export function StreamQualityControls(props: Readonly<{
    canRequestKeyframe: boolean;
    canSetQuality: boolean;
    onRequestKeyframe?: () => void;
    onLowerQuality?: () => void;
    testID: string;
}>): React.ReactElement {
    return (
        <View style={streamPlayerStyles.controls}>
            <StreamControlButton
                disabled={!props.canRequestKeyframe}
                label={t('streamPlayer.actions.requestKeyframe')}
                onPress={props.onRequestKeyframe}
                testID={`${props.testID}-request-keyframe`}
            />
            <StreamControlButton
                disabled={!props.canSetQuality}
                label={t('streamPlayer.actions.lowerQuality')}
                onPress={props.onLowerQuality}
                testID={`${props.testID}-lower-quality`}
            />
        </View>
    );
}
