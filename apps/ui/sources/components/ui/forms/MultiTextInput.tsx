import * as React from 'react';
import { View, findNodeHandle, Platform, type LayoutChangeEvent, type TextStyle } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { referenceChipFill } from '@/components/ui/referenceChip/referenceChipFill';
import { nativeReferenceChipGlyph } from '@/components/ui/referenceChip/nativeReferenceChip';
import { useGlassBackedInk } from '@/components/ui/glass/glassBackedInk';
import { useNativeBackLayerInputBackEnabled } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import { normalizeKeyboardKeyPressEvent, type KeyPressEvent as KeyboardKeyPressEvent } from '@/keyboard/events';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { recordLargeTextInputDiagnostic } from '@/utils/system/userInteractionDiagnostics';
import type { CaretRect } from '@/hooks/ui/textInputCaretRect/useTextInputCaretRect.types';
import { normalizeNativeMultiTextInputMaxHeight, resolveNativeMultiTextInputMinHeight } from './nativeMultiTextInputHeight';
import {
    MULTI_TEXT_INPUT_BASE_FONT_SIZE,
    MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
    COMPOSER_REFERENCE_CHIP_HEIGHT,
    COMPOSER_REFERENCE_CHIP_PHONE_MAX_LABEL_WIDTH,
    NATIVE_REFERENCE_CHIP_ANATOMY,
} from './multiTextInputTypography';
import type {
    ComposerInputReference, ComposerInputDecoration,
    NativeComposerInputProps, NativeComposerInputHandle,
    NativeComposerAttachmentDrop,
} from './nativeComposerInput';
import type { ComposerEditorReference } from './composerEditor/composerEditorTypes';
import { boundComposerEditorReferences } from './composerEditor/composerTextDocMapping';
import { reconcileStructuredInputMentionsWithTextChange } from '@/components/sessions/agentInput/structuredInputMentions';

export type { SupportedKey } from '@/keyboard/events';
export type { ComposerInputReference, ComposerInputDecoration } from './nativeComposerInput';

export interface TextInputState {
    text: string;
    selection: { start: number; end: number };
}
export type KeyPressEvent = KeyboardKeyPressEvent & Readonly<{ inputState?: TextInputState }>;
export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;
export type MultiTextInputSubmitBehavior = 'newline' | 'submit' | 'blurAndSubmit';

export interface MultiTextInputHandle {
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    setSelection: (selection: { start: number; end: number }) => void;
    getText: () => string;
    flushPendingTextChange: () => string;
    focus: () => void;
    blur: () => void;
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    getReactNodeTag: () => number | null;
    getCaretRect: () => CaretRect | null;
    subscribeCaretRect: (listener: () => void) => () => void;
    offsetAtPoint: (point: Readonly<{ x: number; y: number }>) => Promise<number | null>;
    setDropCaret: (offset: number | null) => void;
}

export interface MultiTextInputProps {
    onAttachmentsDropped?: (drop: NativeComposerAttachmentDrop) => void;
    attachmentDropScope?: string;
    attachmentIds?: readonly string[];
    onReferencesChange?: (references: readonly ComposerEditorReference[]) => void;
    textStyle?: TextStyle;
    value: string;
    references?: readonly ComposerEditorReference[];
    decorations?: readonly ComposerInputDecoration[];
    onReferencePress?: (ref: string) => void;
    onChangeText: (text: string) => void;
    placeholder?: string;
    placeholderTextColor?: string;
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
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityRole?: 'combobox';
    accessibilityState?: Readonly<{ expanded?: boolean }>;
    'aria-haspopup'?: 'listbox';
    'aria-autocomplete'?: 'list';
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    onFilesPasted?: (files: readonly File[]) => void;
    onFilesDropped?: (files: readonly File[]) => void;
    onFileDragActiveChange?: (active: boolean) => void;
}

// Expo's declared view type omits its native AsyncFunction ref methods.
const NativeComposerInput = requireNativeViewManager<NativeComposerInputProps>('HappierComposerInput') as unknown as
    React.ForwardRefExoticComponent<NativeComposerInputProps & React.RefAttributes<NativeComposerInputHandle>>;

const NO_REFERENCES: readonly ComposerEditorReference[] = [];
const NO_DECORATIONS: readonly ComposerInputDecoration[] = [];

function clampSelection(selection: TextInputState['selection'], length: number, references: readonly Pick<ComposerEditorReference, 'start' | 'end'>[] = []): TextInputState['selection'] {
    const clamp = (offset: number) => Number.isFinite(offset) ? Math.min(length, Math.max(0, Math.trunc(offset))) : length;
    const start = clamp(Math.min(selection.start, selection.end));
    const end = clamp(Math.max(selection.start, selection.end));
    const snap = (offset: number, edge: 'start' | 'end' | 'nearest') => {
        const reference = references.find(reference => reference.start < offset && offset < reference.end);
        if (!reference) return offset;
        return edge === 'start' || (edge === 'nearest' && offset - reference.start <= reference.end - offset) ? reference.start : reference.end;
    };
    return { start: snap(start, start === end ? 'nearest' : 'start'), end: snap(end, start === end ? 'nearest' : 'end') };
}

const bindingKey = (ref: string, token: string) => JSON.stringify([ref, token]);

function serializeReferences(references: readonly ComposerEditorReference[]): readonly ComposerInputReference[] {
    return references.map(reference => ({
        token: reference.token, start: reference.start, end: reference.end, ref: reference.ref, label: reference.label, kind: reference.kind,
        glyph: nativeReferenceChipGlyph(reference.ref, undefined, Platform.OS, reference.kind === 'image'),
        ...(reference.state === undefined ? {} : { state: reference.state }),
        ...(reference.accessibilityLabel === undefined ? {} : { accessibilityLabel: reference.accessibilityLabel }),
        ...(reference.readableMarker === undefined ? {} : { marker: reference.readableMarker }),
    }));
}

export const MultiTextInput = React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const { theme } = useUnistyles();
    const resolveInk = useGlassBackedInk();
    const forwardHardwareBack = useNativeBackLayerInputBackEnabled();
    const scaleSetting = useLocalSetting('uiFontScale');
    const uiFontScale = typeof scaleSetting === 'number' && Number.isFinite(scaleSetting) && scaleSetting > 0 ? scaleSetting : 1;
    const textStyle = React.useMemo(() => scaleTextStyle({
        ...Typography.default(),
        fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE,
        lineHeight: MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
        ...props.textStyle,
    }, uiFontScale), [props.textStyle, uiFontScale]);
    const maxHeight = normalizeNativeMultiTextInputMaxHeight(props.maxHeight);
    const minHeight = resolveNativeMultiTextInputMinHeight({
        maxHeight, lineHeight: textStyle.lineHeight, paddingTop: props.paddingTop, paddingBottom: props.paddingBottom,
    });
    const [contentHeight, setContentHeight] = React.useState<number | null>(null);
    const inputRef = React.useRef<NativeComposerInputHandle | null>(null);
    // A command queued as the editor leaves (the docked composer closing) runs against a view that is gone and
    // rejects ("Unable to find the 'HappierComposerInputView' view"). Once unmounted there is nothing to update, so
    // that rejection is settled here, the one place the editor's commands are sent; a live editor's failure stays loud.
    const mountedRef = React.useRef(false);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const sendCommand = React.useCallback((command: (input: NativeComposerInputHandle) => Promise<unknown> | void) => {
        const input = inputRef.current;
        if (!input) return;
        const pending = command(input);
        if (pending && typeof pending.then === 'function') {
            pending.then(undefined, (error: unknown) => { if (mountedRef.current) throw error; });
        }
    }, []);
    const dropCaretRef = React.useRef<number | null>(null);
    const textRef = React.useRef(props.value);
    const controlledValueRef = React.useRef(props.value);
    const selectionRef = React.useRef({ start: props.value.length, end: props.value.length });
    const eventCountRef = React.useRef(0);
    const inputTagRef = React.useRef<number | null>(null);
    const caretRectRef = React.useRef<CaretRect | null>(null);
    const lastHeightRef = React.useRef<number | null>(null);
    const caretListenersRef = React.useRef(new Set<() => void>());
    // Native undo retains attachment/span identity; opaque JS owner bindings stay on this side of the bridge.
    const bindingsRef = React.useRef(new Map<string, ComposerEditorReference>());
    const boundReferences = React.useMemo(() => boundComposerEditorReferences(props.value, props.references ?? NO_REFERENCES), [props.value, props.references]);
    const liveReferencesRef = React.useRef(boundReferences);
    const controlledReferencesRef = React.useRef(boundReferences);
    if (controlledReferencesRef.current !== boundReferences) {
        controlledReferencesRef.current = boundReferences;
        liveReferencesRef.current = boundReferences;
    }
    for (const reference of boundReferences) bindingsRef.current.set(bindingKey(reference.ref, reference.token), reference);
    const nativeReferences = React.useMemo(() => serializeReferences(boundReferences), [boundReferences]);
    if (controlledValueRef.current !== props.value) {
        const atEnd = selectionRef.current.start === controlledValueRef.current.length
            && selectionRef.current.end === controlledValueRef.current.length;
        controlledValueRef.current = props.value;
        textRef.current = props.value;
        selectionRef.current = atEnd
            ? { start: props.value.length, end: props.value.length }
            : clampSelection(selectionRef.current, props.value.length, boundReferences);
    }

    const recordGeometry = React.useCallback((geometry: Readonly<{ nativeInputTag?: number; caretRect?: CaretRect | null }>) => {
        if (typeof geometry.nativeInputTag === 'number') inputTagRef.current = geometry.nativeInputTag;
        if ('caretRect' in geometry) {
            caretRectRef.current = geometry.caretRect ?? null;
            for (const listener of caretListenersRef.current) listener();
        }
    }, []);
    const publishSelection = React.useCallback((selection: TextInputState['selection']) => {
        selectionRef.current = selection;
        props.onSelectionChange?.(selection);
        props.onStateChange?.({ text: textRef.current, selection });
    }, [props.onSelectionChange, props.onStateChange]);

    const onChange = React.useCallback<NativeComposerInputProps['onComposerChange']>((event) => {
        const { text, selection, eventCount, references } = event.nativeEvent;
        recordGeometry(event.nativeEvent);
        eventCountRef.current = eventCount;
        textRef.current = text;
        selectionRef.current = selection;
        recordLargeTextInputDiagnostic({
            phase: 'native-change', platform: Platform.OS, surface: 'agentInput',
            textLength: text.length, selection, valueLength: controlledValueRef.current.length,
        });
        // Selection and chip bindings address this text. Publish it first so
        // the document owner never rebases next-text ranges a second time.
        props.onChangeText(text);
        publishSelection(selection);
        const restored = references.flatMap((reference, index) => {
            const occurrence = liveReferencesRef.current[index];
            const binding = occurrence?.ref === reference.ref && occurrence.token === reference.token
                ? occurrence : bindingsRef.current.get(bindingKey(reference.ref, reference.token));
            if (!binding) return [];
            return [binding.start === reference.start && binding.end === reference.end
                ? binding : { ...binding, start: reference.start, end: reference.end }];
        });
        const nextReferences = boundComposerEditorReferences(text, restored);
        if (nextReferences.length !== liveReferencesRef.current.length
            || nextReferences.some((reference, index) => reference !== liveReferencesRef.current[index])) {
            liveReferencesRef.current = nextReferences;
            props.onReferencesChange?.(nextReferences);
        }
    }, [recordGeometry, props.onChangeText, props.onReferencesChange, publishSelection]);
    const onSelection = React.useCallback<NativeComposerInputProps['onComposerSelection']>((event) => {
        recordGeometry(event.nativeEvent);
        const selection = event.nativeEvent.selection;
        if (selection.start !== selectionRef.current.start || selection.end !== selectionRef.current.end) publishSelection(selection);
    }, [recordGeometry, publishSelection]);
    const onContentHeightChange = React.useCallback<NativeComposerInputProps['onComposerContentHeightChange']>((event) => {
        const measured = event.nativeEvent.height;
        if (!Number.isFinite(measured)) return;
        const height = Math.max(0, Math.ceil(measured));
        if (lastHeightRef.current === height) return;
        lastHeightRef.current = height;
        setContentHeight(height);
        recordLargeTextInputDiagnostic({
            phase: 'native-content-size', platform: Platform.OS, surface: 'agentInput',
            textLength: textRef.current.length, contentHeight: height, maxHeight,
        });
        props.onContentHeightChange?.(height);
    }, [maxHeight, props.onContentHeightChange]);

    // Stable paint props avoid repainting every native attachment for an ordinary text edit.
    const nativeTheme = React.useMemo<NativeComposerInputProps['theme']>(() => ({
        text: typeof textStyle.color === 'string' ? resolveInk(textStyle.color) ?? textStyle.color : theme.colors.input.text,
        placeholder: resolveInk(props.placeholderTextColor ?? theme.colors.input.placeholder) ?? theme.colors.input.placeholder,
        chipForeground: theme.colors.text.primary,
        chipGlyphForeground: theme.colors.text.secondary,
        chipBackground: referenceChipFill(theme.colors.text.primary),
        selection: theme.colors.border.focus,
        warning: theme.colors.state.warning.foreground,
        success: theme.colors.state.success.foreground,
        muted: theme.colors.text.secondary,
        link: theme.colors.text.link,
    }), [textStyle.color, resolveInk, theme, props.placeholderTextColor]);
    const nativeTypography = React.useMemo<NativeComposerInputProps['typography']>(() => ({
        fontFamily: textStyle.fontFamily,
        fontSize: textStyle.fontSize ?? MULTI_TEXT_INPUT_BASE_FONT_SIZE,
        lineHeight: textStyle.lineHeight ?? MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
        fontWeight: textStyle.fontWeight === undefined ? undefined : String(textStyle.fontWeight),
        chipFontFamily: Typography.default('medium').fontFamily,
        monoFontFamily: Typography.mono().fontFamily,
        chipHeight: COMPOSER_REFERENCE_CHIP_HEIGHT * uiFontScale,
        chipRadius: NATIVE_REFERENCE_CHIP_ANATOMY.radius * uiFontScale,
        chipPaddingLeft: NATIVE_REFERENCE_CHIP_ANATOMY.paddingLeft * uiFontScale,
        chipPaddingRight: NATIVE_REFERENCE_CHIP_ANATOMY.paddingRight * uiFontScale,
        chipGlyphSize: NATIVE_REFERENCE_CHIP_ANATOMY.glyphSize * uiFontScale,
        chipGap: NATIVE_REFERENCE_CHIP_ANATOMY.gap * uiFontScale,
        chipMaxLabelWidth: COMPOSER_REFERENCE_CHIP_PHONE_MAX_LABEL_WIDTH * uiFontScale,
    }), [textStyle, uiFontScale, theme.borderRadius.sm]);
    const nativePadding = React.useMemo(() => ({
        top: props.paddingTop ?? 0, bottom: props.paddingBottom ?? 0, left: props.paddingLeft ?? 0, right: props.paddingRight ?? 0,
    }), [props.paddingTop, props.paddingBottom, props.paddingLeft, props.paddingRight]);

    React.useImperativeHandle(ref, () => ({
        setTextAndSelection(text, selection) {
            const references = reconcileStructuredInputMentionsWithTextChange({
                previousText: textRef.current, nextText: text, previousSelection: selectionRef.current,
                mentions: liveReferencesRef.current.map(reference => ({ ...reference, tokenText: reference.token })),
            }).map(({ tokenText: _tokenText, ...reference }) => reference);
            const nextSelection = clampSelection(selection, text.length, references);
            textRef.current = text;
            selectionRef.current = nextSelection;
            liveReferencesRef.current = references;
            sendCommand(input => input.setTextAndSelection(text, nextSelection, serializeReferences(references)));
            // Match native edits: the host must process new text before receiving its rebased bindings.
            props.onChangeText(text);
            publishSelection(nextSelection);
            props.onReferencesChange?.(references);
        },
        setSelection(selection) {
            if (textRef.current !== props.value) return;
            const nextSelection = clampSelection(selection, textRef.current.length, boundReferences);
            sendCommand(input => input.setSelection(nextSelection));
            publishSelection(nextSelection);
        },
        getText: () => textRef.current,
        flushPendingTextChange: () => textRef.current,
        focus: () => { sendCommand(input => input.focus()); },
        blur: () => { sendCommand(input => input.blur()); },
        measureInWindow: callback => { inputRef.current?.measureInWindow(callback); },
        getReactNodeTag: () => inputTagRef.current ?? findNodeHandle(inputRef.current as unknown as React.Component | null),
        getCaretRect: () => caretRectRef.current,
        subscribeCaretRect(listener) {
            caretListenersRef.current.add(listener);
            return () => { caretListenersRef.current.delete(listener); };
        },
        offsetAtPoint: async point => await inputRef.current?.offsetAtPoint(point.x, point.y) ?? null,
        setDropCaret: offset => {
            // Idle drop targets clear on mount and cleanup; there is no native feedback to retire yet.
            if (offset === null && dropCaretRef.current === null) return;
            dropCaretRef.current = offset;
            sendCommand(input => input.setDropCaret(offset));
        },
    }), [props.value, props.onChangeText, props.onReferencesChange, publishSelection, boundReferences, sendCommand]);

    return <View style={{ width: '100%' }} onLayout={props.onLayout}>
        <NativeComposerInput
            ref={inputRef}
            testID={props.testID}
            style={{ width: '100%', height: Math.min(maxHeight, Math.max(minHeight, contentHeight ?? minHeight)) }}
            value={props.value}
            mostRecentEventCount={eventCountRef.current}
            references={nativeReferences}
            decorations={props.decorations ?? NO_DECORATIONS}
            theme={nativeTheme}
            typography={nativeTypography}
            padding={nativePadding}
            maxHeight={maxHeight}
            minHeight={minHeight}
            editable={props.editable !== false}
            {...(Platform.OS === 'android' ? { forwardHardwareBack } : {})}
            placeholder={props.placeholder ?? ''}
            returnKeyType={props.submitBehavior === 'submit' || props.submitBehavior === 'blurAndSubmit' ? 'send' : 'default'}
            submitBehavior={props.accessibilityState?.expanded === true ? 'submit' : props.submitBehavior ?? 'newline'}
            autoFocus={props.autoFocus === true}
            autoCorrect={true}
            autoCapitalize="sentences"
            initialScrollY={props.initialScrollY}
            scrollRestoreToken={props.scrollRestoreToken}
            referenceMenuLabels={{ open: t('common.open'), remove: t('common.remove') }}
            acceptsAttachmentDrops={props.editable !== false && Boolean(props.onAttachmentsDropped)}
            attachmentDropScope={props.attachmentDropScope ?? ''}
            onComposerAttachmentDrop={event => {
                const { scope, ...drop } = event.nativeEvent;
                if (props.editable !== false && (scope ?? '') === (props.attachmentDropScope ?? '')) props.onAttachmentsDropped?.(drop);
            }}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            accessibilityRole={props.accessibilityRole}
            accessibilityState={props.accessibilityState}
            onComposerChange={onChange}
            onComposerSelection={onSelection}
            onComposerContentHeightChange={onContentHeightChange}
            onComposerKeyPress={event => {
                // Submit-producing Enter is handled once, from the corresponding native submit event.
                if (event.nativeEvent.submitting) return;
                const key = normalizeKeyboardKeyPressEvent(event.nativeEvent);
                if (key) props.onKeyPress?.({ ...key, inputState: { text: textRef.current, selection: selectionRef.current } });
            }}
            onComposerScroll={event => { recordGeometry(event.nativeEvent); props.onScrollYChange?.(event.nativeEvent.y); }}
            onComposerFocus={event => { if (event) recordGeometry(event.nativeEvent); props.onFocus?.(); }}
            onComposerBlur={props.onBlur}
            onComposerSubmitEditing={event => {
                const key = normalizeKeyboardKeyPressEvent(event?.nativeEvent ?? { key: 'Enter' });
                if (key && props.onKeyPress?.({ ...key, inputState: { text: textRef.current, selection: selectionRef.current } })) return;
                props.onSubmitEditing?.();
            }}
            onComposerReferencePress={event => {
                if (props.onReferencePress) props.onReferencePress(event.nativeEvent.ref);
                else boundReferences.find(reference => reference.ref === event.nativeEvent.ref)?.onOpen?.();
            }}
            onComposerDecorationPress={event => { void openExternalUrl(event.nativeEvent.url); }}
        />
    </View>;
});
MultiTextInput.displayName = 'MultiTextInput';
