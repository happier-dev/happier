import * as React from 'react';
import { Platform, type TextInput as NativeTextInput, type StyleProp, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { TextInput } from './Text';

export type InlineTextEditor = Readonly<{
    value: string;
    placeholder: string;
    accessibilityLabel: string;
    accessibilityHint?: string;
    onChangeText: (next: string) => void;
    onCommit?: () => void;
    onFocus?: () => void;
    editable?: boolean;
    controlRef?: React.RefObject<NativeTextInput | null>;
    testID?: string;
}>;

/** Caret-only editing shared by entity titles, descriptions and authored block names. */
export function InlineTextField(props: Readonly<{
    editor: InlineTextEditor;
    multiline?: boolean;
    style: StyleProp<TextStyle>;
    /** `ink`: the placeholder is the title a reader sees until one is typed (an unnamed block's kind). */
    placeholderTone?: 'quiet' | 'ink';
}>) {
    const { theme } = useUnistyles();
    const { editor } = props;
    const inputRef = React.useRef<NativeTextInput | null>(null);
    const setInputRef = React.useCallback((input: NativeTextInput | null) => {
        inputRef.current = input;
        if (editor.controlRef) editor.controlRef.current = input;
    }, [editor.controlRef]);
    const valueAtFocusRef = React.useRef(editor.value);
    const latestRef = React.useRef(editor);
    latestRef.current = editor;
    // A canonical writer may trim values; keep spaces and IME text while the person is typing.
    const [focused, setFocused] = React.useState(false);
    const [editingValue, setEditingValue] = React.useState(editor.value);
    const singleLine = props.multiline !== true;
    const [contentHeight, setContentHeight] = React.useState<number | null>(null);
    const measuredWidthRef = React.useRef<number | null>(null);
    const handleLayout = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
        const width = event.nativeEvent.layout.width;
        if (width <= 0 || measuredWidthRef.current === width) return;
        measuredWidthRef.current = width;
        // RNW reports content-size changes for text edits, not reflow when a
        // docked pane closes. Measure the same textarea at its new width.
        const input = inputRef.current as unknown as { style?: { height: string }; scrollHeight?: number } | null;
        if (!input?.style || typeof input.scrollHeight !== 'number') return;
        const previousHeight = input.style.height;
        input.style.height = 'auto';
        const height = input.scrollHeight;
        input.style.height = previousHeight;
        if (Number.isFinite(height) && height > 0) setContentHeight(Math.ceil(height));
    }, []);
    const handleContentSizeChange = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ contentSize?: Readonly<{ height?: number }> }> }>) => {
        const height = event.nativeEvent.contentSize?.height;
        if (typeof height === 'number' && Number.isFinite(height) && height > 0) setContentHeight(Math.ceil(height));
    }, []);
    const handleKeyPress = React.useCallback((event: Readonly<{
        nativeEvent: Readonly<{ key?: string; shiftKey?: boolean; isComposing?: boolean }>;
        preventDefault?: () => void;
    }>) => {
        if (event.nativeEvent.isComposing === true) return;
        const key = event.nativeEvent.key;
        if (key === 'Escape') {
            event.preventDefault?.();
            setEditingValue(valueAtFocusRef.current);
            latestRef.current.onChangeText(valueAtFocusRef.current);
            inputRef.current?.blur?.();
            return;
        }
        if (singleLine && key === 'Enter' && event.nativeEvent.shiftKey !== true) {
            event.preventDefault?.();
            latestRef.current.onCommit?.();
            inputRef.current?.blur?.();
        }
    }, [singleLine]);
    return (
        <TextInput
            ref={setInputRef}
            testID={editor.testID}
            accessibilityLabel={editor.accessibilityLabel}
            accessibilityHint={editor.accessibilityHint}
            value={focused ? editingValue : editor.value}
            placeholder={editor.placeholder}
            placeholderTextColor={props.placeholderTone === 'ink' ? theme.colors.text.primary : theme.colors.text.tertiary}
            editable={editor.editable !== false}
            multiline
            {...(Platform.OS === 'web' ? { numberOfLines: 1, onContentSizeChange: handleContentSizeChange, onLayout: handleLayout } : {})}
            submitBehavior={singleLine ? 'blurAndSubmit' : 'newline'}
            onSubmitEditing={singleLine ? () => latestRef.current.onCommit?.() : undefined}
            onKeyPress={handleKeyPress as never}
            onFocus={() => {
                valueAtFocusRef.current = latestRef.current.value;
                setEditingValue(latestRef.current.value);
                setFocused(true);
                latestRef.current.onFocus?.();
            }}
            onBlur={() => { setFocused(false); latestRef.current.onCommit?.(); }}
            onChangeText={(next) => {
                const value = singleLine ? next.replace(/[\r\n]+/g, ' ') : next;
                setEditingValue(value);
                latestRef.current.onChangeText(value);
            }}
            scrollEnabled={false}
            style={[props.style, contentHeight === null ? null : { height: contentHeight }]}
        />
    );
}
