import * as React from 'react';
import type { CSSProperties } from 'react';
import { View, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import { useLocalSetting } from '@/sync/store/hooks';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import { normalizeKeyboardKeyPressEvent, type KeyPressEvent as KeyboardKeyPressEvent } from '@/keyboard/events';
import { recordLargeTextInputDiagnostic } from '@/utils/system/userInteractionDiagnostics';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from './multiTextInputTypography';
import {
    TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
    WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT,
    isLargeTextInputValueLength,
} from './largeTextInputPolicy';

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

    // --- Added in Lane A0 (D33) -----------------------------------------------
    /**
     * Calls getBoundingClientRect on the underlying textarea and fires the
     * callback with viewport/client coordinates (D47: no window.scrollX/Y
     * addition, matching the existing web Popover measurement contract).
     */
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;

    /**
     * Web: returns `null`. Native uses `getReactNodeTag()` for node identity.
     */
    getReactNodeTag: () => number | null;

    /**
     * Returns the underlying `<textarea>` DOM element (or `null` if unmounted).
     * Used by `useTextInputCaretRect.web.ts` to pass into `textarea-caret`.
     */
    getInputElement: () => HTMLTextAreaElement | null;
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
    onContentHeightChange?: (height: number) => void;
    initialScrollY?: number;
    scrollRestoreToken?: string;
    onScrollYChange?: (scrollY: number) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    submitBehavior?: MultiTextInputSubmitBehavior;
    onSubmitEditing?: () => void;
    onFilesPasted?: (files: readonly File[]) => void;
    onFilesDropped?: (files: readonly File[]) => void;
    onFileDragActiveChange?: (active: boolean) => void;
    accessibilityRole?: 'combobox';
    accessibilityState?: Readonly<{ expanded?: boolean }>;
    'aria-haspopup'?: 'listbox';
    'aria-autocomplete'?: 'list';
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
}

const DEFAULT_TEXT_STYLE: TextStyle = { fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE };

// The oversized-text round-trip is deferred (input debounce + parent sync
// deferral), so more than one of our own emissions can be in flight through
// React at once; remembering only the latest emission lets a superseded one
// replay late and be mistaken for external content. The cap only needs to
// cover emissions still in flight — a handful, not a history.
const RECENT_EMITTED_VALUES_LIMIT = 8;

type WebTextStyleOverride = Readonly<{
    color?: string;
    fontFamily?: string;
    fontSize?: string;
    fontStyle?: TextStyle['fontStyle'];
    fontWeight?: TextStyle['fontWeight'];
    letterSpacing?: string;
    lineHeight?: string;
}>;

type WebTextareaStyle = CSSProperties;

function toCssLength(value: TextStyle['fontSize'] | TextStyle['lineHeight'] | TextStyle['letterSpacing']) {
    if (typeof value === 'number') return `${value}px`;
    if (typeof value === 'string') return value;
    return undefined;
}

function normalizeWebTextareaMaxHeight(maxHeight: number): number {
    return Number.isFinite(maxHeight) && maxHeight > 0 ? Math.round(maxHeight) : 120;
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
        onStateChange,
        onContentHeightChange,
    } = props;
    
    const { theme } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale');
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const isComposingRef = React.useRef(false);
    const liveValueRef = React.useRef(value);
    const lastEmittedValueRef = React.useRef(value);
    // Superseded-replay watermark for the DEFERRED pipeline only: holds recent
    // oversized emissions still potentially in flight. Small emissions are
    // synchronous and cannot be reordered, so they are never tracked.
    const recentEmittedValuesRef = React.useRef<string[]>([]);
    const pendingChangeTextRef = React.useRef<string | null>(null);
    const pendingChangeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastScrollRestoreKeyRef = React.useRef<string | null>(null);
    const lastReportedContentHeightRef = React.useRef<number | null>(null);
    const normalizedMaxHeight = normalizeWebTextareaMaxHeight(maxHeight);
    const [textareaHeight, setTextareaHeight] = React.useState<number | undefined>(
        () => (value.length > WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT ? normalizedMaxHeight : undefined),
    );
    const scaledTextStyle = React.useMemo(
        () => resolveWebTextStyle(props.textStyle, uiFontScale),
        [props.textStyle, uiFontScale],
    );
    const textareaStyle = React.useMemo<WebTextareaStyle>(() => ({
        width: '100%',
        padding: '0',
        fontSize: `${MULTI_TEXT_INPUT_BASE_FONT_SIZE}px`,
        color: theme.colors.input.text,
        border: 'none',
        outline: 'none',
        resize: 'none',
        boxSizing: 'border-box',
        backgroundColor: 'transparent',
        fontFamily: Typography.default().fontFamily,
        lineHeight: '1.4',
        scrollbarWidth: 'none',
        paddingTop: props.paddingTop,
        paddingBottom: props.paddingBottom,
        paddingLeft: props.paddingLeft,
        paddingRight: props.paddingRight,
        ...scaledTextStyle,
        caretColor: theme.colors.input.text,
    }), [
        props.paddingBottom,
        props.paddingLeft,
        props.paddingRight,
        props.paddingTop,
        scaledTextStyle,
        theme.colors.input.text,
    ]);
    const clearPendingChangeTimer = React.useCallback(() => {
        if (pendingChangeTimerRef.current === null) return;
        clearTimeout(pendingChangeTimerRef.current);
        pendingChangeTimerRef.current = null;
    }, []);

    const emitChangeText = React.useCallback((text: string) => {
        clearPendingChangeTimer();
        pendingChangeTextRef.current = null;
        lastEmittedValueRef.current = text;
        if (isLargeTextInputValueLength(text.length)) {
            const recentEmittedValues = recentEmittedValuesRef.current;
            if (recentEmittedValues[recentEmittedValues.length - 1] !== text) {
                recentEmittedValues.push(text);
                if (recentEmittedValues.length > RECENT_EMITTED_VALUES_LIMIT) {
                    recentEmittedValues.shift();
                }
            }
        }
        onChangeText(text);
    }, [clearPendingChangeTimer, onChangeText]);

    const scheduleChangeText = React.useCallback((text: string) => {
        if (!isLargeTextInputValueLength(text.length)) {
            emitChangeText(text);
            return;
        }
        pendingChangeTextRef.current = text;
        clearPendingChangeTimer();
        pendingChangeTimerRef.current = setTimeout(() => {
            const pendingText = pendingChangeTextRef.current;
            if (pendingText === null) return;
            emitChangeText(pendingText);
        }, TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS);
    }, [clearPendingChangeTimer, emitChangeText]);

    React.useEffect(() => () => {
        clearPendingChangeTimer();
        pendingChangeTextRef.current = null;
    }, [clearPendingChangeTimer]);

    const flushPendingTextChange = React.useCallback((): string => {
        const text = textareaRef.current?.value ?? liveValueRef.current;
        if (pendingChangeTextRef.current !== null || text !== lastEmittedValueRef.current) {
            emitChangeText(text);
        }
        return text;
    }, [emitChangeText]);

    const notifyContentHeightChange = React.useCallback((height: number) => {
        if (!onContentHeightChange) return;
        if (lastReportedContentHeightRef.current === height) return;
        lastReportedContentHeightRef.current = height;
        onContentHeightChange(height);
    }, [onContentHeightChange]);

    const applyTextareaHeight = React.useCallback((node: HTMLTextAreaElement, nextValueLength = liveValueRef.current.length) => {
        if (nextValueLength > WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT) {
            // No collapse-to-measure for oversized text (that double reflow is
            // what this branch avoids), but consumers still need the TRUE
            // content height — the expand toggle only appears when it exceeds
            // the collapsed max height, and reporting the clamped height made
            // the toggle vanish for >50k-char messages. A plain scrollHeight
            // read before any style write adds no extra reflow: the box height
            // is already explicit, so this is the same layout the browser
            // flushes at paint.
            const measuredContentHeight = Number.isFinite(node.scrollHeight) && node.scrollHeight > 0
                ? Math.ceil(node.scrollHeight)
                : normalizedMaxHeight;
            notifyContentHeightChange(Math.max(measuredContentHeight, normalizedMaxHeight));
            node.style.height = `${normalizedMaxHeight}px`;
            setTextareaHeight((current) => (current === normalizedMaxHeight ? current : normalizedMaxHeight));
            return;
        }

        // Collapse-to-measure forces a synchronous reflow at the `scrollHeight`
        // read. Without a lock, that one reflow shrinks the composer row to the
        // collapsed textarea height, the transcript's flex sibling grows by the
        // freed pixels, and the browser natively clamps its scrollTop — a tail
        // jump per keystroke/composer scroll event that survives the height
        // restore (live capture 2026-07-20). Pixel-lock the wrapper for the
        // whole non-explicit-height window so siblings only ever see the final
        // measured height.
        const wrapper = node.parentElement;
        const previousWrapperHeight = wrapper ? wrapper.style.height : '';
        // The collapse also destroys the textarea's OWN scroll offset: while the
        // box fits its content its maximum scroll offset is 0, so the browser
        // clamps scrollTop away and the visible text jumps to the top of the
        // draft on every keystroke once the text overflows. Carry it across the
        // whole non-explicit-height window — this runs inside one synchronous
        // layout pass, so no paint ever observes the collapsed offset.
        const previousScrollTop = node.scrollTop;
        if (wrapper) {
            wrapper.style.height = `${wrapper.offsetHeight}px`;
        }
        try {
            node.style.height = 'auto';
            const measuredHeight = Number.isFinite(node.scrollHeight) ? Math.ceil(node.scrollHeight) : normalizedMaxHeight;
            notifyContentHeightChange(measuredHeight);
            const nextHeight = Math.min(normalizedMaxHeight, Math.max(0, measuredHeight));
            node.style.height = `${nextHeight}px`;
            setTextareaHeight((current) => (current === nextHeight ? current : nextHeight));
        } finally {
            if (wrapper) {
                wrapper.style.height = previousWrapperHeight;
            }
            // Re-apply after the final height so the browser clamps against the
            // restored box: a shorter draft legitimately caps the offset.
            if (node.scrollTop !== previousScrollTop) {
                node.scrollTop = previousScrollTop;
            }
        }
    }, [normalizedMaxHeight, notifyContentHeightChange]);

    React.useLayoutEffect(() => {
        const node = textareaRef.current;
        if (!node) return;
        if (value === liveValueRef.current || value === lastEmittedValueRef.current) {
            applyTextareaHeight(node);
            return;
        }

        const pendingText = pendingChangeTextRef.current;
        if (
            pendingText !== null
            && pendingText === liveValueRef.current
            && value !== pendingText
            && value !== lastEmittedValueRef.current
        ) {
            recordLargeTextInputDiagnostic({
                phase: 'web-stale-props-skip',
                platform: 'web',
                surface: 'agentInput',
                textLength: pendingText.length,
                valueLength: value.length,
                liveTextLength: liveValueRef.current.length,
                lastEmittedTextLength: lastEmittedValueRef.current.length,
                pendingTextLength: pendingText.length,
            });
            applyTextareaHeight(node, pendingText.length);
            return;
        }

        // Reconcile adopts EXTERNAL values only. A value this input itself
        // emitted is a superseded round-trip replay (the deferred pipeline can
        // deliver an older emission after a newer one was already flushed);
        // adopting it would roll the live text back and jump the caret.
        if (recentEmittedValuesRef.current.includes(value)) {
            recordLargeTextInputDiagnostic({
                phase: 'web-stale-props-skip',
                platform: 'web',
                surface: 'agentInput',
                textLength: liveValueRef.current.length,
                valueLength: value.length,
                liveTextLength: liveValueRef.current.length,
                lastEmittedTextLength: lastEmittedValueRef.current.length,
                pendingTextLength: pendingChangeTextRef.current?.length,
            });
            applyTextareaHeight(node);
            return;
        }

        clearPendingChangeTimer();
        recordLargeTextInputDiagnostic({
            phase: 'web-props-reconcile',
            platform: 'web',
            surface: 'agentInput',
            textLength: value.length,
            valueLength: value.length,
            liveTextLength: liveValueRef.current.length,
            lastEmittedTextLength: lastEmittedValueRef.current.length,
            pendingTextLength: pendingChangeTextRef.current?.length,
        });
        pendingChangeTextRef.current = null;
        liveValueRef.current = value;
        lastEmittedValueRef.current = value;
        recentEmittedValuesRef.current = [];
        // The node.value write below resets the browser's scroll position, so
        // any already-consumed scroll restore must become applicable again
        // against the adopted content (session open applies the restore before
        // the async draft text lands).
        lastScrollRestoreKeyRef.current = null;
        node.value = value;
        applyTextareaHeight(node, value.length);
    }, [applyTextareaHeight, clearPendingChangeTimer, textareaStyle, value]);

    // `value` is a dependency so the restore re-applies in the same commit an
    // external adoption resets scrollTop; parent confirms of self-edits re-run
    // it too but bail on the consumed restore key.
    React.useLayoutEffect(() => {
        const node = textareaRef.current;
        const initialScrollY = props.initialScrollY;
        if (!node || isComposingRef.current) return;
        if (typeof initialScrollY !== 'number' || !Number.isFinite(initialScrollY) || initialScrollY < 0) return;
        const restoreKey = props.scrollRestoreToken ?? `scroll:${initialScrollY}`;
        if (lastScrollRestoreKeyRef.current === restoreKey) return;
        node.scrollTop = initialScrollY;
        lastScrollRestoreKeyRef.current = restoreKey;
    }, [props.initialScrollY, props.scrollRestoreToken, textareaStyle, value]);

    const renderedTextareaHeight = value.length > WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT
        ? normalizedMaxHeight
        : textareaHeight;

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

        const handled = onKeyPress({
            ...keyEvent,
            inputState: {
                text: e.currentTarget.value,
                selection: {
                    start: e.currentTarget.selectionStart,
                    end: e.currentTarget.selectionEnd,
                },
            },
        });
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
        liveValueRef.current = text;
        applyTextareaHeight(e.currentTarget, text.length);
        scheduleChangeText(text);
        recordLargeTextInputDiagnostic({
            phase: 'web-change',
            platform: 'web',
            surface: 'agentInput',
            textLength: text.length,
            selection,
            valueLength: value.length,
            liveTextLength: text.length,
            pendingTextLength: isLargeTextInputValueLength(text.length) ? text.length : undefined,
        });
        
        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [applyTextareaHeight, onStateChange, onSelectionChange, scheduleChangeText]);

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
            onStateChange({ text: target.value, selection });
        }
    }, [onSelectionChange, onStateChange]);

    const handleScroll = React.useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
        const scrollY = e.currentTarget.scrollTop;
        if (typeof scrollY !== 'number' || !Number.isFinite(scrollY) || scrollY < 0) return;
        props.onScrollYChange?.(scrollY);
    }, [props.onScrollYChange]);

    const handleCompositionStart = React.useCallback(() => {
        isComposingRef.current = true;
    }, []);

    const handleCompositionEnd = React.useCallback(() => {
        isComposingRef.current = false;
    }, []);

    const handlePaste = React.useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const cb = props.onFilesPasted;
        if (!cb) return;
        const files = extractWebAttachmentFilesFromDataTransfer(e.clipboardData);
        if (files.length > 0) {
            cb(files);
            e.preventDefault();
        }
    }, [props.onFilesPasted]);

    const dragDepthRef = React.useRef(0);
    const setDragActive = React.useCallback((active: boolean) => {
        props.onFileDragActiveChange?.(active);
    }, [props.onFileDragActiveChange]);

    const handleDragEnter = React.useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
        if (!props.onFilesDropped) return;
        const types = Array.from(e.dataTransfer?.types ?? []);
        if (!types.includes('Files')) return;
        dragDepthRef.current += 1;
        setDragActive(true);
    }, [props.onFilesDropped, setDragActive]);

    const handleDragLeave = React.useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
        if (!props.onFilesDropped) return;
        const types = Array.from(e.dataTransfer?.types ?? []);
        if (!types.includes('Files')) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
            setDragActive(false);
        }
    }, [props.onFilesDropped, setDragActive]);

    const handleDragOver = React.useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
        if (!props.onFilesDropped) return;
        e.preventDefault();
    }, [props.onFilesDropped]);

    const handleDrop = React.useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
        const cb = props.onFilesDropped;
        if (!cb) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        const files = extractWebAttachmentFilesFromDataTransfer(e.dataTransfer);
        if (files.length > 0) cb(files);
    }, [props.onFilesDropped, setDragActive]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            const nextSelection = clampTextSelection(selection, text.length);
            liveValueRef.current = text;
            if (textareaRef.current) {
                textareaRef.current.value = text;
                textareaRef.current.setSelectionRange(nextSelection.start, nextSelection.end);
                applyTextareaHeight(textareaRef.current, text.length);
            }

            emitChangeText(text);
            if (onStateChange) {
                onStateChange({ text, selection: nextSelection });
            }
            if (onSelectionChange) {
                onSelectionChange(nextSelection);
            }
        },
        setSelection: (selection: { start: number; end: number }) => {
            if (isComposingRef.current) return;
            const liveText = textareaRef.current?.value ?? liveValueRef.current;
            // Native parity (MultiTextInput.tsx): a selection may only be
            // applied while the live text matches the controlled value.
            // Callers compute selections against the controlled value; once
            // the user has typed ahead of it, applying that selection would
            // drag the live caret backwards mid-typing.
            if (liveText !== value) return;
            const nextSelection = clampTextSelection(selection, liveText.length);
            if (textareaRef.current) {
                textareaRef.current.setSelectionRange(nextSelection.start, nextSelection.end);
            }

            if (onStateChange) {
                onStateChange({ text: liveText, selection: nextSelection });
            }
            if (onSelectionChange) {
                onSelectionChange(nextSelection);
            }
        },
        getText: () => textareaRef.current?.value ?? liveValueRef.current,
        flushPendingTextChange,
        focus: () => {
            textareaRef.current?.focus();
        },
        blur: () => {
            textareaRef.current?.blur();
        },
        // Lane A0 (D33): measurement/identity helpers for useTextInputCaretRect
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
            const el = textareaRef.current;
            if (el) {
                // D47: use raw getBoundingClientRect viewport/client coordinates,
                // NO window.scrollX/Y addition.
                const rect = el.getBoundingClientRect();
                callback(rect.left, rect.top, rect.width, rect.height);
            }
        },
        getReactNodeTag: () => null,
        getInputElement: () => textareaRef.current,
    }), [applyTextareaHeight, emitChangeText, flushPendingTextChange, onStateChange, onSelectionChange, value]);

    const commonTextareaProps = {
        ref: textareaRef,
        'data-testid': props.testID,
        placeholder,
        defaultValue: value,
        onChange: handleChange,
        onSelect: handleSelect,
        onScroll: handleScroll,
        onKeyDown: handleKeyDown,
        onCompositionStart: handleCompositionStart,
        onCompositionEnd: handleCompositionEnd,
        onPaste: handlePaste,
        onDragEnter: handleDragEnter,
        onDragLeave: handleDragLeave,
        onDragOver: handleDragOver,
        onDrop: handleDrop,
        onFocus: props.onFocus,
        onBlur: props.onBlur,
        readOnly: props.editable === false,
        autoCapitalize: 'sentences',
        autoCorrect: 'on',
        autoComplete: 'off',
        role: props.accessibilityRole,
        'aria-expanded': props.accessibilityState?.expanded,
        'aria-haspopup': props['aria-haspopup'],
        'aria-autocomplete': props['aria-autocomplete'],
        'aria-controls': props['aria-controls'],
        'aria-activedescendant': props['aria-activedescendant'],
    } satisfies React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
        ref: React.Ref<HTMLTextAreaElement>;
        'data-testid'?: string;
    };

    return (
        <View style={{ width: '100%', position: 'relative' }}>
            <textarea
                {...commonTextareaProps}
                rows={1}
                style={{
                    ...textareaStyle,
                    maxHeight: normalizedMaxHeight,
                    height: renderedTextareaHeight,
                    overflowY: 'auto',
                    overscrollBehavior: 'contain',
                }}
            />
        </View>
    );
});

MultiTextInput.displayName = 'MultiTextInput';
