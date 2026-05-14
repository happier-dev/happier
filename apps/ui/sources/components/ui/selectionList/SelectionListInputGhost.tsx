import * as React from 'react';
import { View, Platform, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

/**
 * Renders the autocomplete ghost suffix (e.g. `uments/` shown after the user's
 * typed `~/Doc`). Positioned to align with the input text — the parent input
 * controller (`SelectionListInputController`) is responsible for placing the
 * ghost immediately to the right of the user's typed text.
 *
 * Per the plan §Phase 2.4:
 *   - Web is the primary target (faithful ghost render).
 *   - iOS renders the ghost text identically; the only native-vs-web
 *     difference is hardware-keyboard Tab-acceptance is the recommended path
 *     on touch (the cursor is not visible mid-screen on iOS keyboards).
 *   - Android is deferred for v1 due to font-metric drift; the consumer can
 *     still accept the autocomplete with Tab on a hardware keyboard, but
 *     the ghost is hidden when `Platform.OS === 'android' && !forceRender`.
 *
 * The component returns null when `ghostSuffix` is empty — callers can render
 * it unconditionally without an additional conditional in their JSX.
 */
const stylesheet = StyleSheet.create((theme) => ({
    ghost: {
        opacity: 0.4,
        flexDirection: 'row',
        alignItems: 'center',
    },
    text: {
        color: theme.colors.input.text,
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        // Do not break the visual continuity between typed text + ghost.
        padding: 0,
        margin: 0,
    },
}));

export type SelectionListInputGhostProps = Readonly<{
    /** The user's typed text (currently unused for rendering, retained for future width-measure work). */
    inputValue: string;
    /** Suffix to ghost-render after the user's typed text. */
    ghostSuffix: string;
    /** Force-render the ghost even on Android (default: render when not Android). */
    forceRender?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}>;

export function SelectionListInputGhost(
    props: SelectionListInputGhostProps,
): React.ReactElement | null {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced for typed style closure
    const _theme = useUnistyles().theme;
    const styles = stylesheet;
    if (props.ghostSuffix.length === 0) return null;
    if (Platform.OS === 'android' && !props.forceRender) return null;
    return (
        <View
            testID={props.testID}
            style={[styles.ghost, props.style]}
            pointerEvents="none"
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
        >
            <Text style={[styles.text, props.textStyle]} numberOfLines={1}>
                {props.ghostSuffix}
            </Text>
        </View>
    );
}
