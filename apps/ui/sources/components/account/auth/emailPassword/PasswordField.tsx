import { HappierPressable, happierRaisedEdgeStyle } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FIELD_BOX_METRICS, fieldBoxShapeStyle, resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * Minimum comfortable target for the reveal control: 44 pt on iOS, 48 dp on
 * Android, and Happier's accessible pointer minimum elsewhere.
 */
const REVEAL_TARGET = Platform.select({ ios: 44, android: 48, default: 40 })!;

export type PasswordFieldProps = Readonly<{
    testID: string;
    label: string;
    value: string;
    onChangeText: (value: string) => void;
    /**
     * Password-manager semantics. `current-password` associates the field with
     * an existing saved credential; `new-password` asks for generation.
     */
    autoComplete: 'current-password' | 'new-password';
    inputRef?: React.RefObject<{ focus: () => void } | null>;
    supportingText?: string;
    error?: string | null;
    editable?: boolean;
    onSubmitEditing?: () => void;
    returnKeyType?: 'go' | 'next' | 'done';
    placeholder?: string;
}>;

/**
 * The one native password input composition. Reveal, Caps Lock indication and
 * password-manager association cannot be expressed coherently at each call
 * site, so they live here; everything else stays on the canonical `FieldItem`
 * and app `TextInput` owners.
 */
export const PasswordField = React.memo(function PasswordField(props: PasswordFieldProps) {
    const { theme } = useUnistyles();
    // On a configuration page the password shares the page's one field shape (`fieldBox`) with the
    // text fields beside it; sign-in and recovery screens keep their larger frame.
    const pageField = useListPresentation() === 'page';
    const pageColors = pageField ? resolveFieldBoxColors(theme, props.error ? 'invalid' : 'idle') : null;
    const [revealed, setRevealed] = React.useState(false);
    const [capsLockOn, setCapsLockOn] = React.useState(false);
    const errorId = `${props.testID}-error`;
    const supportingId = `${props.testID}-supporting`;
    const capsLockId = `${props.testID}-caps-lock`;

    // Caps Lock is only observable where the platform forwards the DOM keyboard
    // event. Everywhere else the notice simply never appears.
    const onKeyPress = React.useCallback((event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        const native = event.nativeEvent as unknown as { getModifierState?: (key: string) => boolean };
        if (typeof native?.getModifierState !== 'function') return;
        setCapsLockOn(native.getModifierState('CapsLock') === true);
    }, []);

    const describedBy = [
        props.error ? errorId : null,
        capsLockOn ? capsLockId : null,
        props.supportingText ? supportingId : null,
    ].filter((value): value is string => value !== null).join(' ') || undefined;

    return (
        <FieldItem
            label={props.label}
            supportingText={props.supportingText
                ? <Text nativeID={supportingId} testID={supportingId} style={styles.supporting}>{props.supportingText}</Text>
                : undefined}
        >
            {/* The reveal control lives inside the field frame so toggling it
                changes no geometry, focus, selection or password-manager
                association — only the glyph and the secure-entry flag. */}
            <View style={pageColors ? [
                fieldBoxShapeStyle,
                styles.pageFrame,
                { borderColor: pageColors.borderColor, backgroundColor: pageColors.backgroundColor },
                happierRaisedEdgeStyle(pageColors.edge),
            ] : [
                styles.frame,
                { borderColor: props.error ? theme.colors.status.error : theme.colors.border.default },
            ]}>
                <TextInput
                    ref={props.inputRef as never}
                    testID={props.testID}
                    accessibilityLabel={props.label}
                    aria-describedby={describedBy}
                    aria-invalid={Boolean(props.error)}
                    style={[styles.input, pageColors ? styles.pageInput : null, { color: pageColors?.valueColor ?? theme.colors.text.primary }]}
                    placeholder={props.placeholder}
                    placeholderTextColor={pageColors?.placeholderColor ?? theme.colors.text.secondary}
                    value={props.value}
                    onChangeText={props.onChangeText}
                    onKeyPress={onKeyPress}
                    onSubmitEditing={props.onSubmitEditing}
                    editable={props.editable !== false}
                    secureTextEntry={!revealed}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    importantForAutofill="yes"
                    autoComplete={props.autoComplete}
                    textContentType={props.autoComplete === 'new-password' ? 'newPassword' : 'password'}
                    returnKeyType={props.returnKeyType ?? 'go'}
                    submitBehavior="submit"
                />
                <HappierPressable
                    testID={`${props.testID}-reveal`}
                    accessibilityRole="button"
                    aria-pressed={revealed}
                    accessibilityLabel={revealed ? t('settingsAccount.nativePassword.hidePassword') : t('settingsAccount.nativePassword.showPassword')}
                    onPress={() => setRevealed((current) => !current)}
                    style={[styles.reveal, pageColors ? styles.pageReveal : null]}
                >
                    <Icon name={revealed ? 'eye-slash' : 'eye'} size={18} color={theme.colors.text.secondary} />
                </HappierPressable>
            </View>
            {capsLockOn ? (
                <Text nativeID={capsLockId} testID={capsLockId} style={styles.supporting}>
                    {t('settingsAccount.nativePassword.capsLock')}
                </Text>
            ) : null}
            {props.error ? (
                <Text
                    nativeID={errorId}
                    testID={errorId}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[styles.error, { color: theme.colors.status.error }]}
                >
                    {props.error}
                </Text>
            ) : null}
        </FieldItem>
    );
});

const styles = StyleSheet.create((theme) => ({
    frame: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        paddingLeft: 12,
        paddingRight: 4,
        minHeight: REVEAL_TARGET + 4,
    },
    input: {
        flex: 1,
        minWidth: 0,
        paddingVertical: 10,
    },
    reveal: {
        width: REVEAL_TARGET,
        height: REVEAL_TARGET,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pageFrame: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 2,
    },
    pageInput: {
        fontSize: FIELD_BOX_METRICS.fontSizePx,
        lineHeight: FIELD_BOX_METRICS.lineHeightPx,
        paddingVertical: 0,
        minHeight: FIELD_BOX_METRICS.lineHeightPx,
    },
    // The reveal glyph fits the page field; on touch platforms the shared pressable still gives it
    // the native target size.
    pageReveal: {
        width: FIELD_BOX_METRICS.minHeightPx - 2,
        height: FIELD_BOX_METRICS.minHeightPx - 2,
    },
    supporting: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        marginTop: 5,
    },
    error: {
        fontSize: 12,
        marginTop: 5,
    },
}));
