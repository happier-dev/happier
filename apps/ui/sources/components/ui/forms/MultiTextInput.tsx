import * as React from 'react';
import { View, NativeSyntheticEvent, TextInputKeyPressEventData, TextInputSelectionChangeEventData, TextStyle, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { TextInput } from '@/components/ui/text/Text';
import { normalizeKeyboardKeyPressEvent, type KeyPressEvent as KeyboardKeyPressEvent } from '@/keyboard/events';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from './multiTextInputTypography';


export type { SupportedKey } from '@/keyboard/events';

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export type KeyPressEvent = KeyboardKeyPressEvent & Readonly<{
    inputState?: TextInputState;
}>;

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export interface MultiTextInputHandle {
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

export type MultiTextInputSubmitBehavior = 'newline' | 'submit' | 'blurAndSubmit';

interface MultiTextInputProps {
    textStyle?: TextStyle;
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
    testID?: string;
    maxHeight?: number;
    autoFocus?: boolean;
    editable?: boolean;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    onLayout?: (event: LayoutChangeEvent) => void;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    submitBehavior?: MultiTextInputSubmitBehavior;
    onSubmitEditing?: () => void;
    // Web-only: file attachments via paste or drag-and-drop.
    onFilesPasted?: (files: readonly File[]) => void;
    onFilesDropped?: (files: readonly File[]) => void;
    onFileDragActiveChange?: (active: boolean) => void;
}

function resolveNativeReturnKeyType(submitBehavior: MultiTextInputSubmitBehavior | undefined): 'default' | 'send' {
    return submitBehavior === 'submit' || submitBehavior === 'blurAndSubmit' ? 'send' : 'default';
}

export const MultiTextInput = React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const {
        value,
        onChangeText,
        placeholder,
        maxHeight = 120,
        onKeyPress,
        onSelectionChange,
        onStateChange
    } = props;

    const { theme } = useUnistyles();
    // Track latest selection in a ref
    const selectionRef = React.useRef({ start: value.length, end: value.length });
    const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);

    const handleKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (!onKeyPress) return;

        const nativeEvent = e.nativeEvent as TextInputKeyPressEventData & Partial<KeyboardKeyPressEvent>;
        const keyEvent = normalizeKeyboardKeyPressEvent(nativeEvent);
        if (!keyEvent) return;

        const handled = onKeyPress({
            ...keyEvent,
            inputState: {
                text: value,
                selection: { ...selectionRef.current },
            },
        });
        if (handled) {
            e.preventDefault();
        }
    }, [onKeyPress, value]);

    const handleTextChange = React.useCallback((text: string) => {
        // When text changes, assume cursor moves to end
        const selection = { start: text.length, end: text.length };
        selectionRef.current = selection;

        onChangeText(text);
        
        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange]);

    const handleSelectionChange = React.useCallback((e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        if (e.nativeEvent.selection) {
            const { start, end } = e.nativeEvent.selection;
            const selection = { start, end };
            
            // Only update if selection actually changed
            if (selection.start !== selectionRef.current.start || selection.end !== selectionRef.current.end) {
                selectionRef.current = selection;

                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
                if (onStateChange) {
                    onStateChange({ text: value, selection });
                }
            }
        }
    }, [value, onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            if (inputRef.current) {
                // Use setNativeProps for direct native manipulation when the host ref is available.
                inputRef.current.setNativeProps({
                    text: text,
                    selection: selection
                });
            }

            selectionRef.current = selection;

            onChangeText(text);
            if (onStateChange) {
                onStateChange({ text, selection });
            }
            if (onSelectionChange) {
                onSelectionChange(selection);
            }
        },
        focus: () => {
            inputRef.current?.focus();
        },
        blur: () => {
            inputRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    return (
        <View style={{ width: '100%' }} onLayout={props.onLayout}>
            <TextInput
                ref={inputRef}
                testID={props.testID}
                style={{
                    width: '100%',
                    fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
                    maxHeight,
                    color: theme.colors.input.text,
                    textAlignVertical: 'top',
                    padding:0,
                    paddingTop: props.paddingTop,
                    paddingBottom: props.paddingBottom,
                    paddingLeft: props.paddingLeft,
                    paddingRight: props.paddingRight,
                    ...Typography.default(),
                    ...props.textStyle,
                }}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.input.placeholder}
                value={value}
                onChangeText={handleTextChange}
                onKeyPress={handleKeyPress}
                onSelectionChange={handleSelectionChange}
                multiline={true}
                autoCapitalize="sentences"
                autoCorrect={true}
                keyboardType="default"
                returnKeyType={resolveNativeReturnKeyType(props.submitBehavior)}
                autoComplete="off"
                autoFocus={props.autoFocus}
                editable={props.editable}
                textContentType="none"
                submitBehavior={props.submitBehavior ?? 'newline'}
                onSubmitEditing={props.onSubmitEditing ? () => props.onSubmitEditing?.() : undefined}
                onFocus={props.onFocus}
                onBlur={props.onBlur}
            />
        </View>
    );
});

MultiTextInput.displayName = 'MultiTextInput';
