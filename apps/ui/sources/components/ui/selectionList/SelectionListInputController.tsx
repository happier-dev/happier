import * as React from 'react';
import { Pressable, View, Platform, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { SelectionListInputGhost } from './SelectionListInputGhost';
import { selectionListTestId } from './_shared';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * SelectionListInputController owns the input field plus its surrounding
 * decoration: optional prefix slot, the editable TextInput, the autocomplete
 * ghost, the optional clear button, and the optional suffix slot. It also
 * tracks the caret position (so the parent can detect end-of-input for the
 * Phase 2.5 keyboard contract) and IME composition status (web-only via
 * onCompositionStart / End).
 *
 * Composition (left → right):
 *
 *   [inputPrefix?]   [TextInput][ghost]   [clearable?]   [inputSuffix?]
 *
 * The component supports both controlled (parent passes `value` +
 * `onChangeText`) and uncontrolled usage. When `defaultValue` is provided
 * AND `value` is undefined, the controller manages its own state internally.
 */
const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    // R13 (Fix 1): focus-ring wrap. Sits between the prefix slot and the
    // editable TextInput. When the input is focused, an outline-equivalent
    // boxShadow is painted around this wrap so keyboard users have a visible
    // affordance (R6 nuked the native browser ring without a replacement).
    focusRing: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 0,
        // Default: no ring; we only flip the boxShadow on focus.
        ...(Platform.select({
            web: {
                borderRadius: 4,
            },
            default: {},
        }) as object),
    },
    focusRingActive: {
        ...(Platform.select({
            web: {
                // 2px ring sourced from the theme's focus role (`border.focus`).
                // Use a soft inset+outset combo so the ring stays crisp on
                // both light and dark themes without painting through the input
                // background.
                boxShadow: `0 0 0 2px ${theme.colors.border.focus}`,
            },
            default: {},
        }) as object),
    },
    inputWrap: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        // Keep the ghost flush with the input text — no gap between input + ghost.
        gap: 0,
    },
    input: {
        flex: 0,
        flexShrink: 1,
        flexBasis: 'auto',
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        color: theme.colors.input.text,
        paddingVertical: 0,
        // Remove the web focus ring; the popover container owns visual focus.
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
            },
            default: {},
        }) as object),
    },
    slot: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    clearButton: {
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.placeholder,
    },
}));

export type SelectionListInputControllerProps = Readonly<{
    /** Controlled value. Pair with `onChangeText`. */
    value?: string;
    /** Uncontrolled initial value when `value` is omitted. */
    defaultValue?: string;
    onChangeText?: (next: string) => void;
    placeholder?: string;
    /** Ghost suffix to render after the input value. Empty string hides the ghost. */
    ghostSuffix: string;
    /** Notified whenever the caret crosses the end-of-input boundary. */
    onCaretAtEndChange: (caretAtEnd: boolean) => void;
    /** Notified when IME composition starts/ends (web only — no-op on native). */
    onIsComposingChange?: (isComposing: boolean) => void;
    /** Render the clear button when `value` is non-empty. */
    clearable?: boolean;
    /** Optional element rendered to the left of the input. */
    inputPrefix?: React.ReactNode;
    /** Optional element rendered to the right of the input (inside the field). */
    inputSuffix?: React.ReactNode;
    /** Key event handler forwarded to the underlying TextInput. */
    onKeyPress?: (event: unknown) => void;
    /** Stable testID root. */
    testID?: string;
    style?: StyleProp<ViewStyle>;
    inputStyle?: StyleProp<TextStyle>;
}>;

export function SelectionListInputController(
    props: SelectionListInputControllerProps,
): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isControlled = props.value !== undefined;
    const [uncontrolledValue, setUncontrolledValue] = React.useState<string>(
        props.defaultValue ?? '',
    );
    const value = isControlled ? (props.value ?? '') : uncontrolledValue;

    const handleChangeText = React.useCallback(
        (next: string) => {
            if (!isControlled) setUncontrolledValue(next);
            props.onChangeText?.(next);
        },
        [isControlled, props.onChangeText],
    );

    const handleClear = React.useCallback(() => {
        if (!isControlled) setUncontrolledValue('');
        props.onChangeText?.('');
    }, [isControlled, props.onChangeText]);

    const onCaretAtEndChange = props.onCaretAtEndChange;
    const lastCaretAtEndRef = React.useRef<boolean | null>(null);
    const handleSelectionChange = React.useCallback(
        (event: { nativeEvent?: { selection?: { start: number; end: number } } }) => {
            const selection = event?.nativeEvent?.selection;
            if (!selection) return;
            const next = selection.start === value.length && selection.end === value.length;
            if (lastCaretAtEndRef.current === next) return;
            lastCaretAtEndRef.current = next;
            onCaretAtEndChange(next);
        },
        [onCaretAtEndChange, value.length],
    );

    const onIsComposingChange = props.onIsComposingChange;
    const handleCompositionStart = React.useCallback(() => {
        onIsComposingChange?.(true);
    }, [onIsComposingChange]);
    const handleCompositionEnd = React.useCallback(() => {
        onIsComposingChange?.(false);
    }, [onIsComposingChange]);

    const testIDRoot = props.testID;
    const showClear = props.clearable === true && value.length > 0;

    // R13 (Fix 1): track focus so the wrap below the input can paint a
    // visible ring on web. R6 cleared the native browser ring with
    // `outline: none` but left no replacement, so keyboard users had no focus
    // affordance at all. Native platforms keep their OS-controlled ring.
    const [isFocused, setIsFocused] = React.useState(false);
    const handleFocus = React.useCallback(() => setIsFocused(true), []);
    const handleBlur = React.useCallback(() => setIsFocused(false), []);

    return (
        <View testID={testIDRoot} style={[styles.container, props.style]}>
            {props.inputPrefix != null ? (
                <View
                    testID={selectionListTestId(testIDRoot, 'prefix')}
                    style={styles.slot}
                >
                    {props.inputPrefix}
                </View>
            ) : null}
            <View
                testID={selectionListTestId(testIDRoot, 'focus-ring')}
                style={[styles.focusRing, isFocused ? styles.focusRingActive : null]}
            >
                <View style={styles.inputWrap}>
                    <TextInput
                        testID={selectionListTestId(testIDRoot, 'input')}
                        style={[styles.input, props.inputStyle]}
                        value={value}
                        onChangeText={handleChangeText}
                        placeholder={props.placeholder ?? ''}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onFocus={handleFocus}
                        onBlur={handleBlur}
                        onKeyPress={props.onKeyPress as never}
                        onSelectionChange={handleSelectionChange as never}
                        // Web composition handlers are passed through RN-web to the
                        // underlying DOM input; not part of RN's typed TextInputProps.
                        {...({
                            onCompositionStart: handleCompositionStart,
                            onCompositionEnd: handleCompositionEnd,
                        } as Record<string, unknown>)}
                    />
                    <SelectionListInputGhost
                        testID={selectionListTestId(testIDRoot, 'ghost')}
                        inputValue={value}
                        ghostSuffix={props.ghostSuffix}
                    />
                </View>
            </View>
            {showClear ? (
                <Pressable
                    testID={selectionListTestId(testIDRoot, 'clear')}
                    onPress={handleClear}
                    style={styles.clearButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('selectionList.clearInput')}
                >
                    <Icon name="x" size={14} color={theme.colors.surface.base} />
                </Pressable>
            ) : null}
            {props.inputSuffix != null ? (
                <View
                    testID={selectionListTestId(testIDRoot, 'suffix')}
                    style={styles.slot}
                >
                    {props.inputSuffix}
                </View>
            ) : null}
        </View>
    );
}
