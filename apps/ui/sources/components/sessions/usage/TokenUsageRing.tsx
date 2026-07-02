import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Svg, Circle } from 'react-native-svg';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

import { resolveTokenUsageProgressRatio } from './tokenUsageFormatting';
import { resolveTokenUsageToneColor, type TokenUsageTone } from './tokenUsageTone';

export type TokenUsageRingProps = Readonly<{
    used: number;
    limit: number | null | undefined;
    label: string;
    value: string;
    tone?: TokenUsageTone;
    size?: number;
    strokeWidth?: number;
    testID?: string;
    ringTestID?: string;
    valueTestID?: string;
    progressTestID?: string;
}>;

export function TokenUsageRing(props: TokenUsageRingProps) {
    const { theme } = useUnistyles();
    const size = props.size ?? 20;
    const strokeWidth = props.strokeWidth ?? 2;
    const ringRadius = (size - strokeWidth) / 2;
    const ringCircumference = 2 * Math.PI * ringRadius;
    const progressRatio = React.useMemo(
        () => resolveTokenUsageProgressRatio({ used: props.used, limit: props.limit }),
        [props.limit, props.used],
    );
    const ringDashOffset = React.useMemo(
        () => ringCircumference * (1 - progressRatio),
        [progressRatio, ringCircumference],
    );
    const toneColor = React.useMemo(
        () => resolveTokenUsageToneColor({
            tone: props.tone ?? 'neutral',
            neutralColor: theme.colors.text.secondary,
            warningColor: theme.colors.state.neutral.foreground,
            criticalColor: theme.colors.state.danger.foreground,
        }),
        [
            props.tone,
            theme.colors.state.danger.foreground,
            theme.colors.state.neutral.foreground,
            theme.colors.text.secondary,
        ],
    );

    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            accessibilityRole="image"
            accessibilityLabel={props.label}
            style={[
                styles.root,
                {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                },
            ]}
        >
            <Svg
                testID={props.ringTestID}
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                style={styles.ring}
            >
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={ringRadius}
                    fill="none"
                    stroke={theme.colors.border.default}
                    strokeWidth={strokeWidth}
                />
                <Circle
                    testID={props.progressTestID}
                    cx={size / 2}
                    cy={size / 2}
                    r={ringRadius}
                    fill="none"
                    stroke={toneColor}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeDasharray={`${ringCircumference} ${ringCircumference}`}
                    strokeDashoffset={ringDashOffset}
                    transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
            </Svg>
            <View pointerEvents="none" style={styles.labelOverlay}>
                <Text
                    testID={props.valueTestID}
                    style={[
                        styles.value,
                        {
                            color: toneColor,
                        },
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.5}
                >
                    {props.value}
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        position: 'relative',
        justifyContent: 'center',
        alignItems: 'center',
    },
    ring: {
        position: 'absolute',
        top: 0,
        left: 0,
    },
    labelOverlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        justifyContent: 'center',
        alignItems: 'center',
    },
    value: {
        fontSize: 8,
        lineHeight: 8,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
