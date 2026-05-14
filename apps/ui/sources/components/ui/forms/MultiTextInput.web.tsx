import * as React from 'react';
import { View, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import TextareaAutosize from 'react-textarea-autosize';
import { Typography } from '@/constants/Typography';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import { useLocalSetting } from '@/sync/store/hooks';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import { normalizeKeyboardKeyPressEvent, type KeyPressEvent } from '@/keyboard/events';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from './multiTextInputTypography';

export type { KeyPressEvent, SupportedKey } from '@/keyboard/events';

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export interface MultiTextInputHandle {
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

export type MultiTextInputSubmitBehavior = 'newline' | 'submit' | 'blurAndSubmit';

interface MultiTextInputProps {
    textStyle?: TextStyle;
    testID?: string;
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
    maxHeight?: number;
    editable?: boolean;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    submitBehavior?: MultiTextInputSubmitBehavior;
    onSubmitEditing?: () => void;
    onFilesPasted?: (files: readonly File[]) => void;
    onFilesDropped?: (files: readonly File[]) => void;
    onFileDragActiveChange?: (active: boolean) => void;
}

const DEFAULT_TEXT_STYLE: TextStyle = { fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE };

type WebTextStyleOverride = Readonly<{
    color?: string;
    fontFamily?: string;
    fontSize?: string;
    fontStyle?: TextStyle['fontStyle'];
    fontWeight?: TextStyle['fontWeight'];
    letterSpacing?: string;
    lineHeight?: string;
}>;

function toCssLength(value: TextStyle['fontSize'] | TextStyle['lineHeight'] | TextStyle['letterSpacing']) {
    if (typeof value === 'number') return `${value}px`;
    if (typeof value === 'string') return value;
    return undefined;
}

function resolveWebTextStyle(textStyle: TextStyle | undefined, uiFontScale: number): WebTextStyleOverride {
    const scaledStyle = scaleTextStyle(textStyle ?? DEFAULT_TEXT_STYLE, uiFontScale);
    const next: Record<string, string | TextStyle['fontStyle'] | TextStyle['fontWeight']> = {};
    const color = typeof scaledStyle.color === 'string' ? scaledStyle.color : undefined;
    const fontFamily = typeof scaledStyle.fontFamily === 'string' ? scaledStyle.fontFamily : undefined;
    const fontSize = toCssLength(scaledStyle.fontSize);
    const letterSpacing = toCssLength(scaledStyle.letterSpacing);
    const lineHeight = toCssLength(scaledStyle.lineHeight);

    if (color) next.color = color;
    if (fontFamily) next.fontFamily = fontFamily;
    if (fontSize) next.fontSize = fontSize;
    if (scaledStyle.fontStyle) next.fontStyle = scaledStyle.fontStyle;
    if (scaledStyle.fontWeight) next.fontWeight = scaledStyle.fontWeight;
    if (letterSpacing) next.letterSpacing = letterSpacing;
    if (lineHeight) next.lineHeight = lineHeight;

    return next;
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
    const uiFontScale = useLocalSetting('uiFontScale');
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const scaledTextStyle = React.useMemo(
        () => resolveWebTextStyle(props.textStyle, uiFontScale),
        [props.textStyle, uiFontScale],
    );

    // Convert maxHeight to approximate maxRows (assuming ~24px line height)
    const maxRows = Math.floor(maxHeight / 24);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!onKeyPress) return;

        const isComposing = e.nativeEvent.isComposing || e.keyCode === 229;
        if (isComposing) {
            return;
        }

        const keyEvent = normalizeKeyboardKeyPressEvent({
            key: e.key,
            code: e.code,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            repeat: e.repeat,
            isComposing,
        });
        if (!keyEvent) return;

        const handled = onKeyPress(keyEvent);
        if (handled) {
            e.preventDefault();
        }
    }, [onKeyPress]);

    const handleChange = React.useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const text = e.target.value;
        const selection = { 
            start: e.target.selectionStart, 
            end: e.target.selectionEnd 
        };
        
        onChangeText(text);
        
        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange]);

    const handleSelect = React.useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement;
        const selection = { 
            start: target.selectionStart, 
            end: target.selectionEnd 
        };
        
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
        if (onStateChange) {
            onStateChange({ text: value, selection });
        }
    }, [value, onSelectionChange, onStateChange]);

    const handlePaste = React.useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const cb = props.onFilesPasted;
        if (!cb) return;
        const files = extractWebAttachmentFilesFromDataTransfer(e.clipboardData);
        if (files.length > 0) cb(files);
        if (files.length > 0) {
            e.preventDefault();
        }
    }, [props.onFilesPasted]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            if (textareaRef.current) {
                // Directly set value and selection on DOM element
                textareaRef.current.value = text;
                textareaRef.current.setSelectionRange(selection.start, selection.end);
                
                // Trigger React's onChange by dispatching an input event
                const event = new Event('input', { bubbles: true });
                textareaRef.current.dispatchEvent(event);
                
                // Also call callbacks directly for immediate update
                onChangeText(text);
                if (onStateChange) {
                    onStateChange({ text, selection });
                }
                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
            }
        },
        focus: () => {
            textareaRef.current?.focus();
        },
        blur: () => {
            textareaRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    return (
        <View style={{ width: '100%' }}>
            <TextareaAutosize
                ref={textareaRef}
                data-testid={props.testID}
                style={{
                    width: '100%',
                    padding: '0',
                    fontSize: `${MULTI_TEXT_INPUT_BASE_FONT_SIZE}px`,
                    color: theme.colors.input.text,
                    border: 'none',
                    outline: 'none',
                    resize: 'none' as const,
                    backgroundColor: 'transparent',
                    fontFamily: Typography.default().fontFamily,
                    lineHeight: '1.4',
                    scrollbarWidth: 'none',
                    paddingTop: props.paddingTop,
                    paddingBottom: props.paddingBottom,
                    paddingLeft: props.paddingLeft,
                    paddingRight: props.paddingRight,
                    ...scaledTextStyle,
                }}
                placeholder={placeholder}
                value={value}
                onChange={handleChange}
                onSelect={handleSelect}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={props.onFocus}
                onBlur={props.onBlur}
                readOnly={props.editable === false}
                maxRows={maxRows}
                autoCapitalize="sentences"
                autoCorrect="on"
                autoComplete="off"
            />
        </View>
    );
});

MultiTextInput.displayName = 'MultiTextInput';
