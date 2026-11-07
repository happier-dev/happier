import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { LayoutChangeEvent, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useGlassBackedInk } from '@/components/ui/glass/glassBackedInk';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { extractWebAttachmentFilesFromDataTransfer } from '@/utils/files/webAttachmentDataTransfer';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone.web';
import { normalizeKeyboardKeyPressEvent, type KeyPressEvent as KeyboardKeyPressEvent } from '@/keyboard/events';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { recordLargeTextInputDiagnostic } from '@/utils/system/userInteractionDiagnostics';
import { TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS, containsLikelyNonWhitespace, isLargeTextInputValueLength } from './largeTextInputPolicy';
import { createComposerEditorController, type ComposerEditorDocument } from './composerEditor/composerEditorController.web';
import { ComposerChipView } from './composerEditor/ComposerChipView.web';
import { ComposerChipHoverCard, type ComposerChipHoverTarget } from './composerEditor/ComposerChipHoverCard.web';
import { useHoverPreviewPopover } from '@/components/ui/popover/useHoverPreviewPopover';
import { ensureReferenceChipStyles } from '@/components/ui/referenceChip/referenceChipStyles';
import { isUnrenderedLayoutBox } from '@/components/ui/presentation/retainedPresentationGeometry';
import { COMPOSER_EDITOR_CONTENT_STYLE, resolveComposerEditorHostStyle } from './composerEditor/composerEditorHostStyle.web';
import type { ComposerEditorCaretRect, ComposerEditorDecoration, ComposerEditorReference } from './composerEditor/composerEditorTypes';

export type { SupportedKey } from '@/keyboard/events';
export interface TextInputState { text: string; selection: { start: number; end: number } }
export type KeyPressEvent = KeyboardKeyPressEvent & Readonly<{ inputState?: TextInputState }>;
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
    getCaretRect: () => ComposerEditorCaretRect | null;
    subscribeCaretRect: (listener: () => void) => () => void;
    offsetAtPoint: (point: Readonly<{ x: number; y: number }>) => Promise<number | null>;
    setDropCaret: (offset: number | null) => void;
}
export type MultiTextInputSubmitBehavior = 'newline' | 'submit' | 'blurAndSubmit';
export interface MultiTextInputProps {
    onAttachmentsDropped?: (drop: import('./nativeComposerInput').NativeComposerAttachmentDrop) => void;
    attachmentDropScope?: string;
    textStyle?: TextStyle;
    testID?: string;
    value: string;
    references?: readonly ComposerEditorReference[];
    decorations?: readonly ComposerEditorDecoration[];
    attachmentIds?: readonly string[];
    onReferencesChange?: (references: readonly ComposerEditorReference[]) => void;
    onReferencePress?: (ref: string) => void;
    onChangeText: (text: string) => void;
    placeholder?: string;
    placeholderTextColor?: string;
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

type Controller = ReturnType<typeof createComposerEditorController>;

/** A picture element rebuilt for the same source draws the same picture. */
function sameThumbnail(left: React.ReactNode, right: React.ReactNode): boolean {
    if (left === right) return true;
    if (!React.isValidElement<{ source?: { uri?: string } }>(left) || !React.isValidElement<{ source?: { uri?: string } }>(right)) return false;
    return left.type === right.type && left.props.source?.uri !== undefined && left.props.source?.uri === right.props.source?.uri;
}

function sameChipPresentation(left: ComposerEditorReference, right: ComposerEditorReference): boolean {
    return left.ref === right.ref && left.label === right.label && left.state === right.state
        && Boolean(left.onOpen) === Boolean(right.onOpen) && sameThumbnail(left.thumbnail, right.thumbnail);
}
const EMPTY_REFERENCES: readonly ComposerEditorReference[] = [];
const EMPTY_DECORATIONS: readonly ComposerEditorDecoration[] = [];

export const MultiTextInput = React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const { theme } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale');
    const hostRef = React.useRef<HTMLDivElement>(null);
    const controllerRef = React.useRef<Controller | null>(null);
    const currentProps = React.useRef(props);
    currentProps.current = props;
    const pending = React.useRef<string | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastEmitted = React.useRef(props.value);
    const confirmed = React.useRef(true);
    const scrollRestoreKey = React.useRef<string | null>(null);
    const caretListeners = React.useRef(new Set<() => void>());
    const lastContentHeight = React.useRef<number | null>(null);
    // A chip's hover card is drawn here, in the input's own tree; chips report the pointer to it.
    const chipHover = useHoverPreviewPopover<ComposerChipHoverTarget>({ enabled: props.editable !== false });
    const chipHoverRef = React.useRef(chipHover);
    chipHoverRef.current = chipHover;
    const clearTimer = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
    const emit = (text: string) => {
        clearTimer(); pending.current = null; lastEmitted.current = text; confirmed.current = false;
        currentProps.current.onChangeText(text);
    };
    const flush = (): string => {
        const text = controllerRef.current?.read().text ?? currentProps.current.value;
        if (pending.current !== null || text !== lastEmitted.current) emit(text);
        return text;
    };
    const notifyCaret = () => { for (const listener of caretListeners.current) listener(); };
    const measureContentHeight = () => {
        const host = hostRef.current;
        if (!host) return;
        const height = Math.ceil(host.scrollHeight);
        if (lastContentHeight.current !== height) {
            lastContentHeight.current = height;
            currentProps.current.onContentHeightChange?.(height);
        }
    };
    const measure = () => { measureContentHeight(); notifyCaret(); };
    const reportState = (document: ComposerEditorDocument, changed: boolean, composing: boolean) => {
        const latest = currentProps.current;
        const dom = controllerRef.current?.editor.view.dom;
        if (dom) {
            if (document.text.length === 0) dom.setAttribute('data-empty', 'true');
            else dom.removeAttribute('data-empty');
        }
        // Editor reports are always followed by the controller's caret notification.
        measureContentHeight();
        // Uncommitted IME text stays inside the editor: reporting every pinyin/kana update
        // re-rendered the composer and wrote the draft per composition keystroke. The controller
        // settles the composition with one committed report. The exception is crossing the send
        // button's emptiness edge (`resolveLiveInputTextStatus().hasText`): Gboard composes every
        // word, so holding the first word into an empty field would keep send disabled.
        if (composing) {
            const parentText = pending.current ?? lastEmitted.current;
            if (!changed || containsLikelyNonWhitespace(document.text) === containsLikelyNonWhitespace(parentText)) return;
        }
        const inputState = { text: document.text, selection: document.selection };
        latest.onStateChange?.(inputState);
        if (changed) latest.onReferencesChange?.(document.references);
        latest.onSelectionChange?.(document.selection);
        // Text the parent already holds is not re-emitted: it would never be confirmed by a
        // differing `value`, leaving the next genuine external value misread as stale.
        if (changed && (pending.current !== null || document.text !== lastEmitted.current)) {
            if (isLargeTextInputValueLength(document.text.length)) {
                pending.current = document.text; clearTimer();
                timer.current = setTimeout(() => { if (pending.current !== null) emit(pending.current); }, TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS);
            } else emit(document.text);
            recordLargeTextInputDiagnostic({ phase: 'web-change', platform: 'web', surface: 'agentInput',
                textLength: document.text.length, selection: document.selection, valueLength: latest.value.length,
                liveTextLength: document.text.length, pendingTextLength: pending.current?.length });
        }
    };
    const makeOptions = () => ({
        text: currentProps.current.value,
        references: currentProps.current.references ?? EMPTY_REFERENCES,
        decorations: currentProps.current.decorations ?? EMPTY_DECORATIONS,
        attachmentIds: currentProps.current.attachmentIds,
        editable: currentProps.current.editable,
        onChange: (document: ComposerEditorDocument, composing: boolean) => reportState(document, true, composing),
        onSelection: (document: ComposerEditorDocument, composing: boolean) => reportState(document, false, composing),
        onCaretChange: notifyCaret,
        onFocus: () => currentProps.current.onFocus?.(),
        onBlur: () => currentProps.current.onBlur?.(),
        onOpenLink: (url: string) => { void openExternalUrl(url); },
        onKeyDown: (event: KeyboardEvent, document: ComposerEditorDocument) => {
            const latest = currentProps.current;
            const normalized = normalizeKeyboardKeyPressEvent(event);
            if (normalized && latest.onKeyPress?.({ ...normalized, inputState: { text: document.text, selection: document.selection } })) return true;
            if (event.key === 'Enter' && !event.shiftKey && (latest.submitBehavior === 'submit' || latest.submitBehavior === 'blurAndSubmit')) {
                flush(); latest.onSubmitEditing?.();
                if (latest.submitBehavior === 'blurAndSubmit') controllerRef.current?.editor.view.dom.blur();
                return true;
            }
            return false;
        },
        onPasteFiles: (event: ClipboardEvent) => {
            if (!event.clipboardData || !currentProps.current.onFilesPasted) return false;
            const files = extractWebAttachmentFilesFromDataTransfer(event.clipboardData);
            if (files.length === 0) return false;
            currentProps.current.onFilesPasted(files); event.preventDefault(); return true;
        },
        renderChip: (host: HTMLElement, reference: ComposerEditorReference, selected: boolean, remove: () => void) => {
            const root = createRoot(host);
            let current: ComposerChipHoverTarget | null = null;
            let shown: Readonly<{ reference: ComposerEditorReference; selected: boolean }> | null = null;
            const removeFromMessage = () => { chipHoverRef.current.close(); remove(); };
            const openCurrent = () => current?.open?.();
            const render = (reference: ComposerEditorReference, selected: boolean) => {
                const open = reference.onOpen
                    ?? (currentProps.current.onReferencePress ? () => currentProps.current.onReferencePress?.(reference.ref) : undefined);
                current = { element: host, reference, ...(open ? { open } : {}), remove: removeFromMessage };
                // Every document update refreshes every chip; draw again only when what it shows changed.
                if (shown && shown.selected === selected && sameChipPresentation(shown.reference, reference)) return;
                shown = { reference, selected };
                root.render(<ComposerChipView reference={reference} selected={selected} onOpen={open ? openCurrent : undefined} onRemove={removeFromMessage} />);
            };
            const enter = () => { if (current) chipHoverRef.current.triggerHoverProps(current)?.onPointerEnter(); };
            const leave = () => { chipHoverRef.current.triggerHoverProps(current!)?.onPointerLeave(); };
            host.addEventListener('pointerenter', enter);
            host.addEventListener('pointerleave', leave);
            render(reference, selected);
            return {
                update: render,
                destroy: () => {
                    host.removeEventListener('pointerenter', enter);
                    host.removeEventListener('pointerleave', leave);
                    if (chipHoverRef.current.target?.element === host) chipHoverRef.current.close();
                    queueMicrotask(() => root.unmount());
                },
            };
        },
    });
    React.useLayoutEffect(() => {
        if (!hostRef.current) return;
        ensureReferenceChipStyles();
        const controller = createComposerEditorController(hostRef.current, makeOptions());
        controllerRef.current = controller;
        const host = hostRef.current;
        const dom = controller.editor.view.dom;
        const onScroll = () => { currentProps.current.onScrollYChange?.(host.scrollTop); notifyCaret(); };
        host.addEventListener('scroll', onScroll);
        // A hidden retained pane reports every observed box 0×0; its content height did not change.
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
            if (!isUnrenderedLayoutBox(host, host.offsetWidth, host.offsetHeight)) measure();
        }) : null;
        for (let node: Element | null = host; node && observer; node = node.parentElement) observer.observe(node);
        Object.assign(dom.style, COMPOSER_EDITOR_CONTENT_STYLE);
        if (currentProps.current.autoFocus) dom.focus();
        measure();
        return () => {
            clearTimer(); pending.current = null; host.removeEventListener('scroll', onScroll);
            observer?.disconnect(); controller.destroy(); controllerRef.current = null;
        };
    }, []);
    React.useLayoutEffect(() => {
        const controller = controllerRef.current;
        if (!controller) return;
        const live = controller.read().text;
        if (props.value === lastEmitted.current) confirmed.current = true;
        // Live text ahead of our own confirmed emission is a held IME composition, not an
        // external value: adopting it would replay the older text when the composition settles.
        const stale = props.value !== live
            && (!confirmed.current || pending.current !== null || props.value === lastEmitted.current);
        if (!stale) {
            const external = live !== props.value;
            controller.update(makeOptions());
            if (external) { clearTimer(); pending.current = null; lastEmitted.current = props.value; scrollRestoreKey.current = null; }
        }
        const dom = controller.editor.view.dom;
        const attributes: Record<string, string | undefined> = {
            'data-testid': props.testID, 'data-placeholder': props.placeholder,
            'aria-label': props.accessibilityLabel, 'aria-description': props.accessibilityHint,
            role: props.accessibilityRole ?? 'textbox', 'aria-multiline': 'true',
            'aria-expanded': props.accessibilityState?.expanded === undefined ? undefined : String(props.accessibilityState.expanded),
            'aria-haspopup': props['aria-haspopup'], 'aria-autocomplete': props['aria-autocomplete'],
            'aria-controls': props['aria-controls'], 'aria-activedescendant': props['aria-activedescendant'],
            autocapitalize: 'sentences', autocorrect: 'on', autocomplete: 'off',
            'data-empty': controller.read().text.length === 0 ? 'true' : undefined,
        };
        // Every render reaches here; unchanged attributes are not rewritten.
        for (const [name, value] of Object.entries(attributes)) {
            if (value === undefined) { if (dom.hasAttribute(name)) dom.removeAttribute(name); }
            else if (dom.getAttribute(name) !== value) dom.setAttribute(name, value);
        }
        if (!controller.editor.view.composing && props.initialScrollY !== undefined && Number.isFinite(props.initialScrollY) && props.initialScrollY >= 0) {
            const key = props.scrollRestoreToken ?? `scroll:${props.initialScrollY}`;
            if (scrollRestoreKey.current !== key) { hostRef.current!.scrollTop = props.initialScrollY; scrollRestoreKey.current = key; }
        }
        measure();
    });
    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text, selection) => { controllerRef.current?.setTextAndSelection(text, selection); flush(); },
        setSelection: selection => { if (controllerRef.current?.read().text === currentProps.current.value) controllerRef.current.setSelection(selection); },
        getText: () => controllerRef.current?.read().text ?? currentProps.current.value,
        flushPendingTextChange: flush,
        // The editor's own focus keeps its selection (a restored caret) instead of the browser's
        // default caret, then brings that caret into view.
        focus: () => {
            const view = controllerRef.current?.editor.view;
            if (!view) return;
            view.focus();
            view.dispatch(view.state.tr.scrollIntoView());
        },
        blur: () => controllerRef.current?.editor.view.dom.blur(),
        measureInWindow: callback => { const rect = hostRef.current?.getBoundingClientRect(); if (rect) callback(rect.left, rect.top, rect.width, rect.height); },
        getReactNodeTag: () => null,
        getCaretRect: () => controllerRef.current?.getCaretRect() ?? null,
        subscribeCaretRect: listener => { caretListeners.current.add(listener); return () => { caretListeners.current.delete(listener); }; },
        offsetAtPoint: async point => controllerRef.current?.offsetAtPoint(point) ?? null,
        setDropCaret: offset => controllerRef.current?.setDropCaret(offset),
    }), []);
    useWebFileDropZone({
        hostRef, present: Boolean(props.onFilesDropped), enabled: props.editable !== false && Boolean(props.onFilesDropped),
        onFileDragActiveChange: props.onFileDragActiveChange,
        onFilesDropped: event => {
            const files = extractWebAttachmentFilesFromDataTransfer(event.dataTransfer);
            if (files.length > 0) currentProps.current.onFilesDropped?.(files);
        },
    });
    const placeholderInk = useGlassBackedInk()(props.placeholderTextColor ?? theme.colors.input.placeholder);
    const style = resolveComposerEditorHostStyle({
        theme, uiFontScale, textStyle: props.textStyle, placeholderInk,
        paddingTop: props.paddingTop, paddingBottom: props.paddingBottom, paddingLeft: props.paddingLeft, paddingRight: props.paddingRight,
        maxHeight: props.maxHeight,
    });
    const hoveredChip = chipHover.mode !== 'closed' ? chipHover.target : null;
    return <>
        <div ref={hostRef} data-composer-editor="" style={style} />
        {hoveredChip ? <ComposerChipHoverCard target={hoveredChip} panelHoverProps={chipHover.panelHoverProps} onRequestClose={chipHover.close} /> : null}
    </>;
});
MultiTextInput.displayName = 'MultiTextInput';
