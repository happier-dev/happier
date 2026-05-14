import * as React from 'react';
import { View, Platform, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

/**
 * RUX-10 — SelectionListInputMirror.
 *
 * The mirror is the BOTTOM layer of the layered-mirror autocomplete used by
 * `SelectionListSearchHeader` on web. It paints the typed value + the ghost
 * suffix as two adjacent `<Text>` spans inside a single text container so the
 * suffix sits visually flush to the right of the typed text (e.g. typing
 * `~/Doc` with ghost `uments/` reads as `~/Documents/`, with the suffix in
 * ghost styling).
 *
 * Layering contract (owned by the parent):
 *  - The mirror is rendered FIRST so the editable `<TextInput>` sits on top.
 *  - The TextInput is painted with `position: absolute; inset: 0;`,
 *    `color: 'transparent'`, and an explicit `caretColor` so the user sees a
 *    blinking caret while the visible text comes from the mirror.
 *
 * The mirror itself does NOT manage that overlay — it simply guarantees the
 * font metrics + visual styling match the underlying TextInput. This keeps
 * the typed-text width identical between the two layers, which is what makes
 * the ghost land "right after the cursor" on screen.
 *
 * Returns `null` when `ghostSuffix` is empty so callers can render the mirror
 * unconditionally without an additional guard in their JSX (mirrors the
 * behaviour of `SelectionListInputGhost`).
 */
const stylesheet = StyleSheet.create((theme) => ({
    mirror: {
        // Visual paint only; never intercepts pointer events (the TextInput
        // overlay is the focusable surface). `flexShrink: 1` lets the mirror
        // collapse to its content width so the parent can size correctly.
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        // Clip overflow so the mirror never wraps to a second line when the
        // typed text + ghost grows wider than the cell. The transparent
        // TextInput overlay handles its own scroll/clip independently.
        overflow: 'hidden',
    },
    line: {
        // The container `<Text>` keeps the inline spans on a single line.
        // Padding/margin zeroed for visual continuity with the TextInput.
        padding: 0,
        margin: 0,
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        color: theme.colors.input.text,
    },
    typed: {
        color: theme.colors.input.text,
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        padding: 0,
        margin: 0,
    },
    ghost: {
        color: theme.colors.input.text,
        // 0.4 matches the prior `SelectionListInputGhost` opacity so the
        // existing visual contract is preserved.
        opacity: 0.4,
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        padding: 0,
        margin: 0,
    },
}));

export type SelectionListInputMirrorProps = Readonly<{
    /** The text the user has typed. Rendered in the typed-text style. */
    value: string;
    /** The ghost suffix appended after the typed value. Empty hides the mirror. */
    ghostSuffix: string;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}>;

export function SelectionListInputMirror(
    props: SelectionListInputMirrorProps,
): React.ReactElement | null {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced for typed style closure
    const _theme = useUnistyles().theme;
    const styles = stylesheet;
    if (props.ghostSuffix.length === 0) return null;
    return (
        <View
            testID={props.testID}
            style={[styles.mirror, props.style]}
            pointerEvents="none"
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
        >
            <Text style={[styles.line, props.textStyle]} numberOfLines={1} ellipsizeMode="clip">
                <Text
                    testID={props.testID != null ? `${props.testID}:typed` : undefined}
                    style={styles.typed}
                >
                    {props.value}
                </Text>
                <Text
                    testID={props.testID != null ? `${props.testID}:ghost` : undefined}
                    style={styles.ghost}
                >
                    {props.ghostSuffix}
                </Text>
            </Text>
        </View>
    );
}
