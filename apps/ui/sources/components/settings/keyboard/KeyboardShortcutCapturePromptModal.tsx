import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
import {
    formatKeybindingCaptureEvent,
    type KeybindingCaptureEvent,
} from '@/keyboard/bindings';
import type { KeyboardPlatform } from '@/keyboard/types';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

export type KeyboardShortcutCapturePromptModalProps = CustomModalInjectedProps & Readonly<{
    title: string;
    message?: string;
    placeholder?: string;
    defaultValue?: string;
    platform: KeyboardPlatform;
    onResolve: (value: string | null) => void;
}>;

type ShortcutCaptureTextInputProps = React.ComponentProps<typeof TextInput> & Readonly<{
    onKeyDown?: (event: KeybindingCaptureEvent) => void;
}>;

function stopCapturedShortcutEvent(event: KeybindingCaptureEvent) {
    const cancellableEvent = event as KeybindingCaptureEvent & Readonly<{
        preventDefault?: () => void;
        stopPropagation?: () => void;
        nativeEvent?: KeybindingCaptureEvent['nativeEvent'] & Readonly<{ stopPropagation?: () => void }>;
    }>;
    cancellableEvent.preventDefault?.();
    cancellableEvent.stopPropagation?.();
    cancellableEvent.nativeEvent?.stopPropagation?.();
}

export function KeyboardShortcutCapturePromptModal(props: KeyboardShortcutCapturePromptModalProps) {
    const { theme } = useUnistyles();
    const [value, setValue] = React.useState(props.defaultValue ?? '');
    const didResolveRef = React.useRef(false);
    const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);

    React.useEffect(() => {
        const timer = setTimeout(() => inputRef.current?.focus?.(), 0);
        return () => clearTimeout(timer);
    }, []);

    const resolveAndClose = React.useCallback((nextValue: string | null) => {
        if (didResolveRef.current) return;
        didResolveRef.current = true;
        props.onResolve(nextValue);
        props.onClose();
    }, [props]);

    const captureShortcut = React.useCallback((event: KeybindingCaptureEvent) => {
        const nextValue = formatKeybindingCaptureEvent(event, props.platform);
        if (nextValue == null) return;
        stopCapturedShortcutEvent(event);
        setValue(nextValue);
    }, [props.platform]);

    const webCaptureProps = React.useMemo<Pick<ShortcutCaptureTextInputProps, 'onKeyDown'>>(() => (
        Platform.OS === 'web' ? { onKeyDown: captureShortcut } : {}
    ), [captureShortcut]);

    return (
        <ModalCardFrame
            testID="keyboard-shortcut-capture-modal"
            title={props.title}
            subtitle={props.message}
            onClose={() => resolveAndClose(null)}
            dimensions={{ width: 440, size: 'dialog' }}
            footer={(
                <View style={styles.footer}>
                    <Pressable
                        testID="keyboard-shortcut-capture-cancel"
                        accessibilityRole="button"
                        onPress={() => resolveAndClose(null)}
                        style={({ pressed }) => [
                            styles.button,
                            { backgroundColor: theme.colors.button.secondary.background },
                            pressed ? { opacity: 0.82 } : null,
                        ]}
                    >
                        <Text style={{ color: theme.colors.button.secondary.tint }}>
                            {t('common.cancel')}
                        </Text>
                    </Pressable>
                    <Pressable
                        testID="keyboard-shortcut-capture-confirm"
                        accessibilityRole="button"
                        onPress={() => resolveAndClose(value.trim())}
                        style={({ pressed }) => [
                            styles.button,
                            { backgroundColor: theme.colors.button.primary.background },
                            pressed ? { opacity: 0.86 } : null,
                        ]}
                    >
                        <Text style={{ color: theme.colors.button.primary.tint }}>
                            {t('common.ok')}
                        </Text>
                    </Pressable>
                </View>
            )}
        >
            <View style={styles.body}>
                <TextInput
                    ref={inputRef}
                    testID="keyboard-shortcut-capture-input"
                    autoFocus={true}
                    value={value}
                    placeholder={props.placeholder}
                    placeholderTextColor={theme.colors.text.tertiary}
                    onChangeText={setValue}
                    onKeyPress={captureShortcut}
                    selectTextOnFocus={true}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[
                        Typography.mono(),
                        styles.input,
                        {
                            backgroundColor: theme.colors.surface.inset,
                            borderColor: theme.colors.border.default,
                            color: theme.colors.text.primary,
                        },
                    ]}
                    {...webCaptureProps}
                />
                <Text style={[styles.hint, { color: theme.colors.text.secondary }]}>
                    {t('settingsKeyboard.setShortcutPromptMessage')}
                </Text>
            </View>
        </ModalCardFrame>
    );
}

const styles = StyleSheet.create(() => ({
    body: {
        gap: 10,
    },
    input: {
        borderRadius: 10,
        borderWidth: 1,
        minHeight: 44,
        paddingHorizontal: 18,
        paddingVertical: 14,
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
    hint: {
        lineHeight: 20,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    button: {
        borderRadius: 10,
        minHeight: 36,
        paddingHorizontal: 14,
        paddingVertical: 8,
        justifyContent: 'center',
        alignItems: 'center',
    },
}));
