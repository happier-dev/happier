import * as React from 'react';
import {
    HAPPIER_FIELD_TEXT_METRICS,
    HappierFieldTextBox,
    resolveHappierFieldTextInputMetrics,
    useHappierHitArea,
    type HappierFieldTextBoxProps,
} from '@happier-dev/plugin-ui/presentation';
import { Platform, type StyleProp, type TextInputProps as RNTextInputProps, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FIELD_BOX_METRICS, resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type FieldTextInputProps = Readonly<{
    value: string;
    onChangeText: (text: string) => void;
    /** Names the field for assistive technology (the row title it sits beside). */
    accessibilityLabel: string;
    /** The field's current state for assistive technology ("A token is saved"); an error replaces it. */
    accessibilityHint?: string;
    /** The `nativeID` of a persistent visible label (`FieldItem` `labelNativeID`) that names this field. */
    accessibilityLabelledBy?: string;
    /** The `nativeID` of persistent visible help (a form field's support line) that describes this field. */
    accessibilityDescribedBy?: string;
    placeholder?: string;
    /** The field's refusal, shown under it and announced. */
    error?: string | null;
    /**
     * Marks the field invalid when its refusal is shown once for a group of fields (a filter's
     * clauses) instead of under this field; pair it with an `accessibilityHint` naming the problem.
     */
    invalid?: boolean;
    multiline?: boolean;
    /** A multiline field's minimum height, in lines (default 3): a JSON document needs more room than a note. */
    minLines?: number;
    /** A multiline field grows with its text so the whole value stays visible (a decision, a title); `document` always does. */
    growWithText?: boolean;
    /** `false` shows a value that can be read, selected and copied but not changed (an export). */
    editable?: boolean;
    /** Commands, identifiers and paths read better in the monospace face. */
    monospace?: boolean;
    autoCapitalize?: RNTextInputProps['autoCapitalize'];
    autoFocus?: boolean;
    /** Selects the whole value on focus, so typing replaces a suggested value (a rename). */
    selectTextOnFocus?: boolean;
    /** Masks the value as it is typed (secrets); the value is never echoed back. */
    secureTextEntry?: boolean;
    keyboardType?: RNTextInputProps['keyboardType'];
    inputMode?: RNTextInputProps['inputMode'];
    /** Password-manager and autofill association (an email that is also the sign-in username). */
    autoComplete?: RNTextInputProps['autoComplete'];
    textContentType?: RNTextInputProps['textContentType'];
    returnKeyType?: RNTextInputProps['returnKeyType'];
    onSubmitEditing?: () => void;
    /** Raw key presses (web carries Escape here): an in-place field cancels on Escape. */
    onKeyPress?: RNTextInputProps['onKeyPress'];
    /** Fires when focus leaves the field: fields that commit a draft (numbers, prompts) save here. */
    onBlur?: () => void;
    maxLength?: number;
    /** Test id of the input; its error is `<testID>.error`. */
    testID?: string;
    style?: StyleProp<ViewStyle>;
    /** Inline field actions (paste, reveal, clear), kept inside the shared field box. */
    trailing?: React.ReactNode;
    /** Where the typed text sits in the field (a count against its unit sits right). */
    textAlign?: 'left' | 'center' | 'right';
    /** A fixed adornment the value continues (the `/` of a shortcut), drawn in the field box before the text. */
    leading?: React.ReactNode;
    /**
     * `document`: long prose edited in place (a role's instructions) as a soft filled card at reading
     * size that grows with its text. Default `field`: the bordered box of a row's control.
     */
    presentation?: 'field' | 'document';
}>;

/**
 * A configuration page's text field: the bordered field box a page select also uses, placed as a
 * row's control (`Item` `rightElement`, `accessoryLayout="adaptive"`), with its error beneath it.
 */
export const FieldTextInput = React.memo(React.forwardRef<React.ElementRef<typeof TextInput>, FieldTextInputProps>(
    function FieldTextInput(props, ref) {
        const { theme } = useUnistyles();
        const styles = stylesheet;
        const invalid = Boolean(props.error) || props.invalid === true;
        const presentation = props.presentation ?? 'field';
        const inputMetrics = resolveHappierFieldTextInputMetrics({
            multiline: props.multiline,
            minLines: props.minLines,
            presentation,
        });
        const hitArea = useHappierHitArea({ restingStyle: () => inputMetrics });
        const colors = resolveFieldBoxColors(theme, invalid ? 'invalid' : 'idle', presentation);
        // A document grows with its text instead of scrolling inside a fixed box.
        const grows = (presentation === 'document' || props.growWithText === true) && props.multiline === true;
        const [contentHeight, setContentHeight] = React.useState<number | null>(null);
        const handleContentSizeChange = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ contentSize?: Readonly<{ height?: number }> }> }>) => {
            const height = event.nativeEvent.contentSize?.height;
            if (typeof height === 'number' && Number.isFinite(height) && height > 0) setContentHeight(Math.ceil(height));
        }, []);
        return (
            <HappierFieldTextBox
                presentation={presentation}
                multiline={props.multiline}
                colors={colors}
                leading={props.leading}
                trailing={props.trailing}
                // App callers pass React Native layout styles; the shared box keeps its anatomy under them.
                style={props.style as HappierFieldTextBoxProps['style']}
                error={props.error ? (
                    <Text
                        testID={props.testID ? `${props.testID}.error` : undefined}
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                        style={styles.error}
                    >
                        {props.error}
                    </Text>
                ) : undefined}
            >
                <TextInput
                    ref={ref}
                    testID={props.testID}
                    value={props.value}
                    onChangeText={props.onChangeText}
                    placeholder={props.placeholder}
                    placeholderTextColor={theme.colors.input.placeholder}
                    accessibilityLabel={props.accessibilityLabel}
                    accessibilityHint={props.error ?? props.accessibilityHint}
                    accessibilityLabelledBy={props.accessibilityLabelledBy}
                    accessibilityDescribedBy={props.accessibilityDescribedBy}
                    accessibilityState={invalid ? { invalid: true } as never : undefined}
                    autoCapitalize={props.autoCapitalize ?? 'none'}
                    autoCorrect={false}
                    autoFocus={props.autoFocus}
                    selectTextOnFocus={props.selectTextOnFocus}
                    secureTextEntry={props.secureTextEntry}
                    keyboardType={props.keyboardType}
                    inputMode={props.inputMode}
                    autoComplete={props.autoComplete}
                    textContentType={props.textContentType}
                    returnKeyType={props.returnKeyType}
                    onSubmitEditing={props.onSubmitEditing}
                    onKeyPress={props.onKeyPress}
                    onBlur={props.onBlur}
                    maxLength={props.maxLength}
                    // A multiline field keeps the platform default: Return inserts a newline and
                    // keeps focus. Only a single-line field leaves on Return unless it submits.
                    blurOnSubmit={props.multiline ? undefined : !props.onSubmitEditing}
                    multiline={props.multiline}
                    editable={props.editable}
                    {...(Platform.OS === 'web' ? {} : { hitSlop: hitArea.hitSlop, onLayout: hitArea.onLayout })}
                    {...(grows ? { onContentSizeChange: handleContentSizeChange, scrollEnabled: false } : {})}
                    style={[
                        styles.input,
                        // The input's text box inside the field box is the shared owner's.
                        inputMetrics,
                        // The mono face is for what is typed (a path, a command); an empty field's placeholder is
                        // prose ("Whole repository") and keeps the field's own face.
                        props.monospace && props.value ? styles.inputMono : null,
                        grows && contentHeight !== null ? { height: Math.max(contentHeight, 0) } : null,
                        props.textAlign ? { textAlign: props.textAlign, fontVariant: ['tabular-nums'] } : null,
                        // A right-aligned value keeps a word space before its trailing unit.
                        props.textAlign === 'right' && props.trailing ? { paddingRight: theme.space.s4 } : null,
                        { color: colors.valueColor },
                    ]}
                />
            </HappierFieldTextBox>
        );
    },
));

const stylesheet = StyleSheet.create((theme) => ({
    input: {
        ...Typography.default(),
    },
    inputMono: {
        ...Typography.mono(),
        fontSize: FIELD_BOX_METRICS.fontSizePx - 0.5,
    },
    error: {
        ...Typography.default(),
        fontSize: HAPPIER_FIELD_TEXT_METRICS.errorFontSizePx,
        lineHeight: HAPPIER_FIELD_TEXT_METRICS.errorLineHeightPx,
        color: theme.colors.state.danger.foreground,
    },
}));
