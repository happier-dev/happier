import * as React from 'react';
import {
    View,
    NativeSyntheticEvent,
    TextInputKeyPressEventData,
    TextInputSelectionChangeEventData,
    TextStyle,
    findNodeHandle,
    type LayoutChangeEvent,
    Platform,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { TextInput } from '@/components/ui/text/Text';
import { normalizeKeyboardKeyPressEvent, type KeyPressEvent as KeyboardKeyPressEvent } from '@/keyboard/events';
import { useLocalSetting } from '@/sync/store/hooks';
import { recordLargeTextInputDiagnostic } from '@/utils/system/userInteractionDiagnostics';
import {
    normalizeNativeMultiTextInputMaxHeight,
    resolveNativeMultiTextInputMinHeight,
} from './nativeMultiTextInputHeight';
import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from './largeTextInputPolicy';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE, MULTI_TEXT_INPUT_BASE_LINE_HEIGHT } from './multiTextInputTypography';


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
    setSelection: (selection: { start: number; end: number }) => void;
    getText: () => string;
    flushPendingTextChange: () => string;
    focus: () => void;
    blur: () => void;
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    getReactNodeTag: () => number | null;
    getInputElement: () => HTMLTextAreaElement | null;
}

export type MultiTextInputSubmitBehavior = 'newline' | 'submit' | 'blurAndSubmit';

type NativeTextInputContentSizeChangeEvent = NativeSyntheticEvent<Readonly<{
    contentSize?: Readonly<{
        height?: number;
    }>;
}>>;

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
    onContentHeightChange?: (height: number) => void;
    initialScrollY?: number;
    scrollRestoreToken?: string;
    onScrollYChange?: (scrollY: number) => void;
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

function normalizeUiFontScale(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return value;
}

function clampTextSelection(selection: { start: number; end: number }, textLength: number): { start: number; end: number } {
    const start = Number.isFinite(selection.start)
        ? Math.min(Math.max(0, Math.trunc(selection.start)), textLength)
        : textLength;
    const end = Number.isFinite(selection.end)
        ? Math.min(Math.max(0, Math.trunc(selection.end)), textLength)
        : start;
    return { start, end };
}

function resolveTextDiffBounds(previousText: string, nextText: string): Readonly<{
    commonPrefixLength: number;
    commonSuffixLength: number;
}> {
    const previousLength = previousText.length;
    const nextLength = nextText.length;
    const sharedLength = Math.min(previousLength, nextLength);

    let commonPrefixLength = 0;
    while (
        commonPrefixLength < sharedLength
        && previousText.charCodeAt(commonPrefixLength) === nextText.charCodeAt(commonPrefixLength)
    ) {
        commonPrefixLength += 1;
    }

    let commonSuffixLength = 0;
    const remainingSharedLength = sharedLength - commonPrefixLength;
    while (
        commonSuffixLength < remainingSharedLength
        && previousText.charCodeAt(previousLength - commonSuffixLength - 1)
            === nextText.charCodeAt(nextLength - commonSuffixLength - 1)
    ) {
        commonSuffixLength += 1;
    }

    return { commonPrefixLength, commonSuffixLength };
}

function resolveCursorFromTextDiff(previousText: string, nextText: string): { start: number; end: number } {
    const nextLength = nextText.length;
    const { commonPrefixLength, commonSuffixLength } = resolveTextDiffBounds(previousText, nextText);

    const insertedLength = Math.max(0, nextLength - commonPrefixLength - commonSuffixLength);
    const cursor = commonPrefixLength + insertedLength;
    return clampTextSelection({ start: cursor, end: cursor }, nextLength);
}

function hasSelectionBasedChangeBoundaryEvidence(params: Readonly<{
    previousText: string;
    previousSelection: { start: number; end: number };
    nextText: string;
    insertedLength: number;
}>): boolean {
    if (params.insertedLength < 0) return true;

    if (
        params.previousSelection.start > 0
        && params.previousText.charCodeAt(params.previousSelection.start - 1)
            !== params.nextText.charCodeAt(params.previousSelection.start - 1)
    ) {
        return false;
    }

    const previousAfterOffset = params.previousSelection.end;
    const nextAfterOffset = params.previousSelection.start + params.insertedLength;
    if (
        previousAfterOffset < params.previousText.length
        && nextAfterOffset < params.nextText.length
        && params.previousText.charCodeAt(previousAfterOffset) !== params.nextText.charCodeAt(nextAfterOffset)
    ) {
        return false;
    }

    return true;
}

function shouldResolveNativeChangedTextSelectionFromDiff(params: Readonly<{
    previousText: string;
    previousSelection: { start: number; end: number };
    nextText: string;
    insertedLength: number;
}>): boolean {
    if (params.previousText.length <= TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT) return false;
    if (params.insertedLength < 0) return false;

    const selectionWasAtDocumentStart = params.previousSelection.start === 0 && params.previousSelection.end === 0;
    return selectionWasAtDocumentStart || !hasSelectionBasedChangeBoundaryEvidence(params);
}

function resolveNativeChangedTextSelection(params: Readonly<{
    previousText: string;
    previousSelection: { start: number; end: number };
    nextText: string;
}>): { start: number; end: number } {
    const previousLength = params.previousText.length;
    const nextLength = params.nextText.length;
    const previousSelection = clampTextSelection(params.previousSelection, previousLength);
    const selectedLength = Math.max(0, previousSelection.end - previousSelection.start);
    const insertedLength = nextLength - (previousLength - selectedLength);

    if (shouldResolveNativeChangedTextSelectionFromDiff({
        previousText: params.previousText,
        previousSelection,
        nextText: params.nextText,
        insertedLength,
    })) {
        return resolveCursorFromTextDiff(params.previousText, params.nextText);
    }

    const cursor = insertedLength >= 0
        ? previousSelection.start + insertedLength
        : Math.min(previousSelection.start, nextLength);
    return clampTextSelection({ start: cursor, end: cursor }, nextLength);
}

function resolveNativeLineHeight(params: Readonly<{
    textStyle?: TextStyle;
    uiFontScale: number;
}>): number {
    const baseLineHeight = typeof params.textStyle?.lineHeight === 'number' && Number.isFinite(params.textStyle.lineHeight)
        ? params.textStyle.lineHeight
        : MULTI_TEXT_INPUT_BASE_LINE_HEIGHT;
    return Math.ceil(baseLineHeight * params.uiFontScale);
}

export const MultiTextInput = React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const {
        value,
        onChangeText,
        placeholder,
        maxHeight,
        onKeyPress,
        onSelectionChange,
        onStateChange,
        onContentHeightChange,
    } = props;

    const { theme } = useUnistyles();
    const uiFontScale = normalizeUiFontScale(useLocalSetting('uiFontScale'));
    const normalizedMaxHeight = normalizeNativeMultiTextInputMaxHeight(maxHeight);
    const resolvedLineHeight = resolveNativeLineHeight({
        textStyle: props.textStyle,
        uiFontScale,
    });
    const resolvedInputMinHeight = resolveNativeMultiTextInputMinHeight({
        maxHeight: normalizedMaxHeight,
        lineHeight: resolvedLineHeight,
        paddingTop: props.paddingTop,
        paddingBottom: props.paddingBottom,
    });
    const selectionRef = React.useRef({ start: value.length, end: value.length });
    const latestNativeTextRef = React.useRef(value);
    const controlledValueRef = React.useRef(value);
    const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    if (controlledValueRef.current !== value) {
        const previousValue = controlledValueRef.current;
        const wasSelectionAtPreviousEnd = selectionRef.current.start === previousValue.length
            && selectionRef.current.end === previousValue.length;
        selectionRef.current = wasSelectionAtPreviousEnd
            ? { start: value.length, end: value.length }
            : clampTextSelection(selectionRef.current, value.length);
        controlledValueRef.current = value;
    }
    latestNativeTextRef.current = value;
    const lastReportedContentHeightRef = React.useRef<number | null>(null);

    const handleKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        const nativeEvent = e.nativeEvent as TextInputKeyPressEventData & Partial<KeyboardKeyPressEvent>;
        const keyEvent = normalizeKeyboardKeyPressEvent(nativeEvent);
        let handled = false;

        if (onKeyPress && keyEvent) {
            handled = onKeyPress({
                ...keyEvent,
                inputState: {
                    text: latestNativeTextRef.current,
                    selection: { ...selectionRef.current },
                },
            });
        }
        if (handled) {
            e.preventDefault();
        }
    }, [onKeyPress]);

    const handleTextChange = React.useCallback((text: string) => {
        const previousText = latestNativeTextRef.current;
        const selection = resolveNativeChangedTextSelection({
            previousText,
            previousSelection: selectionRef.current,
            nextText: text,
        });
        latestNativeTextRef.current = text;
        selectionRef.current = selection;

        recordLargeTextInputDiagnostic({
            phase: 'native-change',
            platform: Platform.OS,
            surface: 'agentInput',
            textLength: text.length,
            selection,
            valueLength: controlledValueRef.current.length,
        });

        onChangeText(text);

        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange]);

    const handleContentSizeChange = React.useCallback((e: NativeTextInputContentSizeChangeEvent) => {
        const measuredHeight = e.nativeEvent.contentSize?.height;
        if (typeof measuredHeight !== 'number' || !Number.isFinite(measuredHeight)) {
            return;
        }
        const nextHeight = Math.max(0, Math.ceil(measuredHeight));
        if (lastReportedContentHeightRef.current === nextHeight) {
            return;
        }
        lastReportedContentHeightRef.current = nextHeight;
        recordLargeTextInputDiagnostic({
            phase: 'native-content-size',
            platform: Platform.OS,
            surface: 'agentInput',
            textLength: latestNativeTextRef.current.length,
            contentHeight: nextHeight,
            maxHeight: normalizedMaxHeight,
        });
        onContentHeightChange?.(nextHeight);
    }, [normalizedMaxHeight, onContentHeightChange]);

    const handleSelectionChange = React.useCallback((e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        if (e.nativeEvent.selection) {
            const liveText = latestNativeTextRef.current;
            const selection = clampTextSelection(e.nativeEvent.selection, liveText.length);

            // Only update if selection actually changed
            if (selection.start !== selectionRef.current.start || selection.end !== selectionRef.current.end) {
                selectionRef.current = selection;

                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
                if (onStateChange) {
                    onStateChange({ text: liveText, selection });
                }
            }
        }
    }, [onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            const nextSelection = clampTextSelection(selection, text.length);
            latestNativeTextRef.current = text;
            if (inputRef.current) {
                inputRef.current.setNativeProps({
                    text,
                    selection: nextSelection,
                });
            }

            selectionRef.current = nextSelection;

            onChangeText(text);
            if (onStateChange) {
                onStateChange({ text, selection: nextSelection });
            }
            if (onSelectionChange) {
                onSelectionChange(nextSelection);
            }
        },
        setSelection: (selection: { start: number; end: number }) => {
            if (latestNativeTextRef.current !== value) {
                return;
            }
            const nextSelection = clampTextSelection(selection, value.length);
            if (inputRef.current) {
                inputRef.current.setNativeProps({
                    selection: nextSelection,
                });
            }

            selectionRef.current = nextSelection;

            if (onStateChange) {
                onStateChange({ text: value, selection: nextSelection });
            }
            if (onSelectionChange) {
                onSelectionChange(nextSelection);
            }
        },
        getText: () => latestNativeTextRef.current,
        flushPendingTextChange: () => latestNativeTextRef.current,
        focus: () => {
            inputRef.current?.focus();
        },
        blur: () => {
            inputRef.current?.blur();
        },
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
            inputRef.current?.measureInWindow(callback);
        },
        getReactNodeTag: () => findNodeHandle(inputRef.current) ?? null,
        getInputElement: () => null,
    }), [onChangeText, onStateChange, onSelectionChange, value]);

    return (
        <View style={{ width: '100%' }} onLayout={props.onLayout}>
            <TextInput
                ref={inputRef}
                testID={props.testID}
                style={{
                    width: '100%',
                    fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
                    color: theme.colors.input.text,
                    textAlignVertical: 'top',
                    padding: 0,
                    paddingTop: props.paddingTop,
                    paddingBottom: props.paddingBottom,
                    paddingLeft: props.paddingLeft,
                    paddingRight: props.paddingRight,
                    ...Typography.default(),
                    ...props.textStyle,
                    minHeight: resolvedInputMinHeight,
                    maxHeight: normalizedMaxHeight,
                }}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.input.placeholder}
                value={value}
                onChangeText={handleTextChange}
                onContentSizeChange={handleContentSizeChange}
                onKeyPress={handleKeyPress}
                onSelectionChange={handleSelectionChange}
                multiline={true}
                scrollEnabled={true}
                autoCapitalize="sentences"
                autoCorrect={true}
                keyboardType="default"
                disableFullscreenUI={true}
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
