import * as React from 'react';
import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { formatKeycapLabel, splitKeybindingLabel, useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import type { KeyboardCommandId } from '@/keyboard/types';

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

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        minWidth: 22,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s6,
        paddingVertical: theme.space.s2,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    label: {
        ...Typography.variant('micro', 'regular'),
        ...Typography.mono(),
        ...Typography.tabular(),
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
        ...Typography.variant('micro', 'regular'),
        ...Typography.mono(),
        ...Typography.tabular(),
        color: theme.colors.state.attention.foreground,
    },
    onFillLabel: { color: theme.colors.surface.base },
}));

/**
 * A well of the label's own ink over the fill (not an opaque surface), so the key reads on any fill in
 * either theme: light keys on the light-labelled fill, dark keys on the dark-labelled one. Derived from
 * the resolved theme at render: on web a stylesheet sees theme colours as CSS variables, which `Color`
 * cannot read.
 */
function useOnFillWell(enabled: boolean): ViewStyle | null {
    const { theme } = useUnistyles();
    const base = theme.colors.surface.base;
    return React.useMemo(() => {
        if (!enabled) return null;
        return { backgroundColor: parseThemeColor(base)?.alpha(0.22).rgb().string() ?? base };
    }, [base, enabled]);
}

export function KeyHint(props: KeyHintProps): React.ReactElement | null {
    const onFillWell = useOnFillWell(props.tone === 'onFill');
    if (props.enabled === false) return null;
    const styles = stylesheet;

    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.label}
            style={[styles.container, props.tone !== undefined && props.tone !== 'neutral' ? styles.attentionContainer : null,
                onFillWell, props.style]}
        >
            <Text
                testID={props.testID ? `${props.testID}:label` : undefined}
                style={[styles.label, props.tone === 'attention' ? styles.attentionLabel : null,
                    props.tone === 'onFill' ? styles.onFillLabel : null]}
            >
                {/* The keycap's face: arrows and Return as glyphs, one owner for every key shown. */}
                {formatKeycapLabel(props.label)}
            </Text>
        </View>
    );
}

/**
 * The key combination a command's hint draws here, or null when none is drawn: no key runs the command,
 * or there is no hardware keyboard (a finger, a phone), where keycaps name nothing. A control wrapped
 * around the hint asks this first, so it never exists where its face is not drawn.
 */
export function useKeyboardCommandHintLabel(commandId: KeyboardCommandId): string | null {
    const shortcut = useKeyboardShortcutLabel(commandId);
    // Keycaps name a key: without a hardware keyboard they are not drawn, as in SelectionList's footer.
    const hasKeyboard = useHardwareKeyboard();
    return shortcut && hasKeyboard ? shortcut : null;
}

/**
 * The keycaps of one command as the person has bound it here (⌘ P), or nothing when no key runs it:
 * the hint beside a control that does the same thing (Go to file in the Files tree, Text in files).
 */
export function KeyboardCommandHint(props: Readonly<{ commandId: KeyboardCommandId; testID?: string }>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const shortcut = useKeyboardCommandHintLabel(props.commandId);
    if (!shortcut) return null;
    return (
        <View testID={props.testID} accessibilityLabel={shortcut} style={{ flexDirection: 'row', gap: theme.space.s2 }}>
            {splitKeybindingLabel(shortcut).map((label, index) => <KeyHint key={index} label={label} />)}
        </View>
    );
}
