import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type KeyHintProps = Readonly<{
    label: string;
    enabled?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

function resolveKeyHintTypography() {
    const helpers = Typography as Readonly<{
        keyHint?: () => object;
        mono?: () => object;
        tabular?: () => object;
    }>;
    return typeof helpers.keyHint === 'function'
        ? helpers.keyHint()
        : {
            ...(helpers.mono?.() ?? {}),
            ...(helpers.tabular?.() ?? {}),
        };
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        minWidth: 22,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    label: {
        ...resolveKeyHintTypography(),
        color: theme.colors.text.secondary,
    },
}));

export function KeyHint(props: KeyHintProps): React.ReactElement | null {
    if (props.enabled === false) return null;
    const styles = stylesheet;

    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.label}
            style={[styles.container, props.style]}
        >
            <Text
                testID={props.testID ? `${props.testID}:label` : undefined}
                style={styles.label}
            >
                {props.label}
            </Text>
        </View>
    );
}
