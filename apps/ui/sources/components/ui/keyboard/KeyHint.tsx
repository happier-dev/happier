import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type KeyHintProps = Readonly<{
    label: string;
    enabled?: boolean;
    /**
     * `attention`: a key on an attention pill — borderless, in its themed ink and well.
     * `onFill`: a key on a filled action, using the surface ink.
     * Default `neutral`: the bordered keycap of menus and settings.
     */
    tone?: 'neutral' | 'attention' | 'onFill';
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
    attentionContainer: {
        minWidth: 16,
        paddingHorizontal: 3,
        paddingVertical: 1,
        borderRadius: 5,
        borderWidth: 0,
        backgroundColor: theme.colors.state.attention.background,
    },
    attentionLabel: {
        ...resolveKeyHintTypography(),
        color: theme.colors.state.attention.foreground,
    },
    onFillLabel: { color: theme.colors.surface.base },
    onFillContainer: { backgroundColor: theme.colors.surface.pressedOverlay },
}));

export function KeyHint(props: KeyHintProps): React.ReactElement | null {
    if (props.enabled === false) return null;
    const styles = stylesheet;

    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.label}
            style={[styles.container, props.tone !== undefined && props.tone !== 'neutral' ? styles.attentionContainer : null,
                props.tone === 'onFill' ? styles.onFillContainer : null, props.style]}
        >
            <Text
                testID={props.testID ? `${props.testID}:label` : undefined}
                style={[styles.label, props.tone === 'attention' ? styles.attentionLabel : null,
                    props.tone === 'onFill' ? styles.onFillLabel : null]}
            >
                {props.label}
            </Text>
        </View>
    );
}
