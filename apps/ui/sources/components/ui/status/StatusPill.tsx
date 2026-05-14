import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { StatusDot } from './StatusDot';

export const STATUS_PILL_VARIANTS = [
    'success',
    'warning',
    'danger',
    'info',
    'neutral',
] as const;

export type StatusPillVariant = (typeof STATUS_PILL_VARIANTS)[number];

export type StatusPillProps = Readonly<{
    variant: StatusPillVariant;
    label: string;
    chrome?: 'pill' | 'plain';
    count?: number;
    hideDot?: boolean;
    foregroundColor?: string;
    dotColor?: string;
    isPulsing?: boolean;
    testID?: string;
    variantTestID?: string;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}>;

function resolvePillLabelTypography() {
    const helpers = Typography as Readonly<{
        pillLabel?: () => object;
        default?: (weight?: 'regular' | 'italic' | 'semiBold') => object;
    }>;
    return typeof helpers.pillLabel === 'function'
        ? helpers.pillLabel()
        : (helpers.default?.('semiBold') ?? {});
}

function resolveTabularTypography() {
    const helpers = Typography as Readonly<{
        tabular?: () => object;
    }>;
    return helpers.tabular?.() ?? {};
}

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
    },
    plainContainer: {
        gap: 4,
        paddingHorizontal: 0,
        paddingVertical: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
    },
    variantMarker: {
        position: 'absolute',
        width: 0,
        height: 0,
        opacity: 0,
    },
    label: {
        ...resolvePillLabelTypography(),
    },
}));

export function StatusPill(props: StatusPillProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const state = theme.colors.state[props.variant];
    const chrome = props.chrome ?? 'pill';
    const foregroundColor = props.foregroundColor ?? state.foreground;
    const dotColor = props.dotColor ?? foregroundColor;

    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            style={[
                styles.container,
                chrome === 'plain'
                    ? styles.plainContainer
                    : {
                        backgroundColor: state.background,
                        borderColor: state.border,
                    },
                props.style,
            ]}
        >
            <View
                testID={props.variantTestID ?? (props.testID ? `${props.testID}:variant:${props.variant}` : undefined)}
                pointerEvents="none"
                style={styles.variantMarker}
            />
            {props.hideDot ? null : (
                <StatusDot
                    testID={props.testID ? `${props.testID}:dot` : undefined}
                    color={dotColor}
                    isPulsing={props.isPulsing}
                />
            )}
            {props.count !== undefined ? (
                <Text
                    testID={props.testID ? `${props.testID}:count` : undefined}
                    style={[styles.label, resolveTabularTypography(), { color: foregroundColor }]}
                >
                    {props.count}
                </Text>
            ) : null}
            <Text
                testID={props.testID ? `${props.testID}:label` : undefined}
                style={[styles.label, { color: foregroundColor }]}
            >
                {props.label}
            </Text>
        </View>
    );
}
