import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierFieldTextBox, resolveHappierFieldTextInputMetrics } from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';
import { TextInput } from '@/components/ui/text/Text';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
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
        if ((event.key ?? event.nativeEvent?.key) === 'Escape') {
            stopCapturedShortcutEvent(event);
            resolveAndClose(null);
            return;
        }
        const nextValue = formatKeybindingCaptureEvent(event, props.platform);
        if (nextValue == null) return;
        stopCapturedShortcutEvent(event);
        setValue(nextValue);
    }, [props.platform, resolveAndClose]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const recorderWindow = window;
        const cancel = () => resolveAndClose(null);
        recorderWindow.addEventListener('blur', cancel);
        return () => recorderWindow.removeEventListener('blur', cancel);
    }, [resolveAndClose]);

    // The capture field is the shared field box; only its key handling is this dialog's own.
    const fieldColors = resolveFieldBoxColors(theme);

    const webCaptureProps = React.useMemo<Pick<ShortcutCaptureTextInputProps, 'onKeyDown'>>(() => (
        Platform.OS === 'web' ? { onKeyDown: captureShortcut } : {}
    ), [captureShortcut]);

    return (
        <ModalCardFrame
            testID="keyboard-shortcut-capture-modal"
            title={props.title}
            subtitle={props.message}
            onClose={() => resolveAndClose(null)}
            dimensions={{ width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, size: 'dialog' }}
            footer={(
                <View style={styles.footer}>
                    <RoundButton
                        testID="keyboard-shortcut-capture-cancel"
                        display="inverted"
                        title={t('common.cancel')}
                        onPress={() => resolveAndClose(null)}
                    />
                    <RoundButton
                        testID="keyboard-shortcut-capture-confirm"
                        title={t('common.ok')}
                        onPress={() => resolveAndClose(value.trim())}
                    />
                </View>
            )}
        >
            <View style={styles.body}>
                <HappierFieldTextBox colors={fieldColors}>
                <TextInput
                    ref={inputRef}
                    testID="keyboard-shortcut-capture-input"
                    autoFocus={true}
                    value={value}
                    placeholder={props.placeholder}
                    placeholderTextColor={fieldColors.placeholderColor}
                    onChangeText={setValue}
                    onKeyPress={captureShortcut}
                    selectTextOnFocus={true}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[
                        Typography.mono(),
                        resolveHappierFieldTextInputMetrics({}),
                        { color: fieldColors.valueColor },
                    ]}
                    {...webCaptureProps}
                />
                </HappierFieldTextBox>
            </View>
        </ModalCardFrame>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The card's edge inset, shared with its title band and footer: the field lines up under the title.
    body: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s4,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
}));
