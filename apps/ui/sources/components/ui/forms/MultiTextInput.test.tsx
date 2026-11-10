/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFormsCommonModuleMocks } from './formsTestHelpers';
import type { TiptapEditorHTMLElement } from '@tiptap/core';
import type { MultiTextInputHandle, MultiTextInputProps } from './MultiTextInput.web';
import { TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS, TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from './largeTextInputPolicy';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installFormsCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

const diagnostics = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/userInteractionDiagnostics', () => ({ recordLargeTextInputDiagnostic: diagnostics }));

const { MultiTextInput } = await import('./MultiTextInput.web');
const { storage } = await import('@/sync/domains/state/storage');
const { GlassBackedInkContext, glassQuietThemeInks, resolveGlassBackedInk } = await import('@/components/ui/glass/glassBackedInk');
const { lightTheme } = await import('@/theme');
const initialStorage = storage.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
    // jsdom has no layout; keep that boundary explicit while the editor and DOM events stay real.
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(25, 35, 0, 18) });
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
});
afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove(); root = null; container = null;
    vi.useRealTimers(); vi.restoreAllMocks(); diagnostics.mockReset();
    storage.setState(initialStorage, true);
});

async function render(props: Partial<MultiTextInputProps> = {}, wrapper?: (child: React.ReactElement) => React.ReactElement) {
    const ref = React.createRef<MultiTextInputHandle>();
    let current: MultiTextInputProps = { value: '', onChangeText: () => {}, testID: 'input', ...props };
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    const draw = async () => { await act(async () => {
        const child = <MultiTextInput {...current} ref={ref} />;
        root!.render(wrapper ? wrapper(child) : child);
    }); };
    await draw();
    const input = container.querySelector<HTMLElement>('[data-testid="input"]');
    if (!input) throw new Error('Missing editor surface');
    const host = container.querySelector<HTMLElement>('[data-composer-editor]');
    if (!host) throw new Error('Missing editor scroll host');
    return { ref, input, host, update: async (props: Partial<MultiTextInputProps>) => { current = { ...current, ...props }; await draw(); } };
}

async function paste(input: HTMLElement, text: string, files: readonly File[] = [], itemFiles: readonly (File | null)[] = []) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
        types: files.length || itemFiles.length ? ['Files'] : ['text/plain'], files,
        items: itemFiles.map(file => ({ kind: 'file', getAsFile: () => file })),
        getData: (type: string) => type === 'text/plain' ? text : '',
    } });
    await act(async () => { input.dispatchEvent(event); });
    return event;
}

async function key(input: HTMLElement, key: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    await act(async () => { input.dispatchEvent(event); });
    return event;
}

describe('MultiTextInput web surface', () => {
    it('keeps test identity, placeholder, accessible instructions and combobox relationships on the editable surface', async () => {
        const view = await render({ placeholder: 'Message', accessibilityLabel: 'Prompt', accessibilityHint: 'Write a prompt',
            accessibilityRole: 'combobox', accessibilityState: { expanded: true }, 'aria-haspopup': 'listbox',
            'aria-autocomplete': 'list', 'aria-controls': 'suggestions', 'aria-activedescendant': 'suggestion-one' });
        expect(view.input.getAttribute('contenteditable')).toBe('true');
        expect(view.input.getAttribute('data-placeholder')).toBe('Message');
        expect(view.input.getAttribute('data-happier-text-input')).toBe('true');
        expect(view.input.getAttribute('aria-label')).toBe('Prompt');
        expect(view.input.getAttribute('aria-description')).toBe('Write a prompt');
        expect(view.input.getAttribute('role')).toBe('combobox');
        // aria-multiline is not an allowed attribute on a combobox (axe aria-allowed-attr).
        expect(view.input.hasAttribute('aria-multiline')).toBe(false);
        expect(view.input.getAttribute('aria-expanded')).toBe('true');
        expect(view.input.getAttribute('aria-haspopup')).toBe('listbox');
        expect(view.input.getAttribute('aria-autocomplete')).toBe('list');
        expect(view.input.getAttribute('aria-controls')).toBe('suggestions');
        expect(view.input.getAttribute('aria-activedescendant')).toBe('suggestion-one');
        await view.update({ editable: false, accessibilityState: { expanded: false } });
        expect(view.input.getAttribute('contenteditable')).toBe('false');
        expect(view.input.getAttribute('aria-expanded')).toBe('false');
    });

    it('announces a plain editor as a multi-line textbox', async () => {
        const view = await render({ accessibilityLabel: 'Notes' });
        expect(view.input.getAttribute('role')).toBe('textbox');
        expect(view.input.getAttribute('aria-multiline')).toBe('true');
    });

    it('uses scaled caller typography and the containing glass placeholder ink', async () => {
        storage.setState({ localSettings: { ...storage.getState().localSettings, uiFontScale: 1.25 } });
        const backed = resolveGlassBackedInk(lightTheme.colors.text.primary, lightTheme.colors.text.secondary, glassQuietThemeInks(lightTheme.colors));
        let ink: React.ComponentProps<typeof GlassBackedInkContext.Provider>['value'] = null;
        const view = await render({ textStyle: { fontSize: 16 } },
            child => <GlassBackedInkContext.Provider value={ink}>{child}</GlassBackedInkContext.Provider>);
        expect(view.host.style.fontSize).toBe('20px');
        expect(view.host.style.getPropertyValue('--happier-placeholder-color')).toBe(lightTheme.colors.input.placeholder);
        await view.update({ placeholderTextColor: lightTheme.colors.composer.chipTint });
        expect(view.host.style.getPropertyValue('--happier-placeholder-color')).toBe(lightTheme.colors.composer.chipTint);
        ink = backed;
        await view.update({});
        expect(view.host.style.getPropertyValue('--happier-placeholder-color')).toBe(backed.secondary);
    });

    it('keeps the same editable surface and full text when a draft becomes oversized', async () => {
        const view = await render({ value: 'short', maxHeight: 144 });
        const text = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
        await view.update({ value: text });
        expect(container?.querySelector('[data-testid="input"]')).toBe(view.input);
        expect(view.ref.current?.getText()).toBe(text);
        expect(view.input.textContent).toBe(text);
        expect(view.host.style.maxHeight).toBe('144px');
        expect(view.host.style.overflowY).toBe('auto');
    });

    it('keeps oversized edits live while debouncing the parent change and flushes them before submit', async () => {
        vi.useFakeTimers();
        const onChangeText = vi.fn(), onStateChange = vi.fn(), onSubmitEditing = vi.fn();
        const view = await render({ onChangeText, onStateChange, onSubmitEditing, submitBehavior: 'submit' });
        const text = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
        await paste(view.input, text);
        expect(view.ref.current?.getText()).toBe(text);
        expect(onChangeText).not.toHaveBeenCalled();
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ text, selection: { start: text.length, end: text.length } }));
        expect(diagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ textLength: text.length, valueLength: 0, liveTextLength: text.length, pendingTextLength: text.length }));
        await key(view.input, 'Enter');
        expect(onChangeText).toHaveBeenCalledWith(text);
        expect(onSubmitEditing).toHaveBeenCalledOnce();
        expect(view.ref.current?.flushPendingTextChange()).toBe(text);
        expect(onChangeText).toHaveBeenCalledOnce();
    });

    it('preserves the newest pending oversized edit while an older controlled value replays', async () => {
        vi.useFakeTimers();
        const base = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
        const onChangeText = vi.fn();
        const view = await render({ value: base, onChangeText });
        await paste(view.input, 'one');
        await act(async () => { await vi.advanceTimersByTimeAsync(TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS); });
        await view.update({ value: base + 'one' });
        await paste(view.input, 'two');
        await view.update({ value: base });
        expect(view.ref.current?.getText()).toBe(base + 'onetwo');
        expect(view.input.textContent).toBe(base + 'onetwo');
    });

    it.each([false, true])('ignores superseded emissions before the latest acknowledgement, then adopts external text (oversized=%s)', async oversized => {
        vi.useFakeTimers();
        const base = oversized ? 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1) : '';
        const view = await render({ value: base });
        await paste(view.input, 'one');
        await act(async () => { view.ref.current?.flushPendingTextChange(); });
        await paste(view.input, 'two');
        await act(async () => { view.ref.current?.flushPendingTextChange(); });
        await view.update({ value: base + 'one' });
        expect(view.ref.current?.getText()).toBe(base + 'onetwo');
        await view.update({ value: base + 'onetwo' });
        await view.update({ value: 'An external draft' });
        expect(view.ref.current?.getText()).toBe('An external draft');
    });

    it('drops a pending oversized change when the input unmounts', async () => {
        vi.useFakeTimers();
        const onChangeText = vi.fn();
        const view = await render({ onChangeText });
        await paste(view.input, 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1));
        await act(async () => { root?.unmount(); root = null; await vi.advanceTimersByTimeAsync(TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS); });
        expect(onChangeText).not.toHaveBeenCalled();
    });

    it('preserves source offsets and state through selection and dictation handle methods', async () => {
        const onChangeText = vi.fn(), onSelectionChange = vi.fn(), onStateChange = vi.fn();
        const view = await render({ value: 'hello', onChangeText, onSelectionChange, onStateChange });
        await act(async () => view.ref.current?.setSelection({ start: 2, end: 4 }));
        expect(onChangeText).not.toHaveBeenCalled();
        expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 2, end: 4 });
        expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'hello', selection: { start: 2, end: 4 } }));
        await act(async () => view.ref.current?.setTextAndSelection('hello world', { start: 11, end: 11 }));
        expect(view.input.textContent).toBe('hello world');
        expect(onChangeText).toHaveBeenLastCalledWith('hello world');
        expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 11, end: 11 });
    });

    it('drops stale imperative selection restores and selection restores during composition', async () => {
        const onSelectionChange = vi.fn();
        const view = await render({ value: 'hello', onSelectionChange });
        await paste(view.input, ' world');
        onSelectionChange.mockClear();
        await act(async () => view.ref.current?.setSelection({ start: 2, end: 2 }));
        expect(onSelectionChange).not.toHaveBeenCalled();
        await view.update({ value: 'hello world' });
        await act(async () => { view.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        await act(async () => view.ref.current?.setSelection({ start: 2, end: 2 }));
        expect(onSelectionChange).not.toHaveBeenCalled();
    });

    it.each([{ start: 6, end: 6 }, { start: 6, end: 11 }])('keeps a restored selection through focus, replacement and refocus: %j', async selection => {
        const onChangeText = vi.fn();
        const view = await render({ value: 'hello world!', onChangeText });
        await act(async () => view.ref.current!.setSelection(selection));
        // An inactive row has no DOM selection. Focusing must publish the editor's
        // restored range to the browser before the next native edit reads it.
        await act(async () => { window.getSelection()?.removeAllRanges(); view.ref.current!.focus(); });
        expect(document.activeElement).toBe(view.input);
        expect(window.getSelection()?.anchorOffset).toBe(selection.start);
        expect(window.getSelection()?.focusOffset).toBe(selection.end);
        expect(window.getSelection()?.toString()).toBe(selection.start === selection.end ? '' : 'world');
        await paste(view.input, 'new');
        const expected = selection.start === selection.end ? 'hello newworld!' : 'hello new!';
        expect(onChangeText).toHaveBeenLastCalledWith(expected);
        await view.update({ value: expected });
        await act(async () => { view.ref.current!.blur(); window.getSelection()?.removeAllRanges(); view.ref.current!.focus(); });
        await paste(view.input, '?');
        expect(view.ref.current!.getText()).toBe(selection.start === selection.end ? 'hello new?world!' : 'hello new?!');
    });

    it('keeps a restored active range through focus and IME commit, then edits at the committed caret', async () => {
        const onChangeText = vi.fn(), onStateChange = vi.fn();
        const view = await render({ value: 'hello world!', onChangeText, onStateChange });
        await act(async () => { view.ref.current!.setSelection({ start: 6, end: 11 }); view.ref.current!.focus(); });
        const editor = (view.input as TiptapEditorHTMLElement).editor!;
        await act(async () => {
            view.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            editor.view.dispatch(editor.state.tr.insertText('ni'));
        });
        await view.update({ value: 'hello world!' });
        await act(async () => view.ref.current!.setSelection({ start: 6, end: 11 }));
        expect(view.ref.current!.getText()).toBe('hello ni!');
        expect(onChangeText).not.toHaveBeenCalled();
        await act(async () => {
            editor.view.dispatch(editor.state.tr.insertText('你', 7, 9));
            view.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            await Promise.resolve();
        });
        expect(onChangeText.mock.calls).toEqual([['hello 你!']]);
        expect(onStateChange).toHaveBeenLastCalledWith({ text: 'hello 你!', selection: { start: 7, end: 7 } });
        await view.update({ value: 'hello 你!' });
        await act(async () => { view.ref.current!.blur(); view.ref.current!.focus(); });
        await paste(view.input, '?');
        expect(view.ref.current!.getText()).toBe('hello 你?!');
    });

    it('keeps uncommitted IME composition inside the editor and reports the committed document once', async () => {
        const onChangeText = vi.fn(), onStateChange = vi.fn(), onSelectionChange = vi.fn();
        const view = await render({ value: 'hi ', onChangeText, onStateChange, onSelectionChange });
        const editor = (view.input as TiptapEditorHTMLElement).editor!;
        const compose = async (text: string, from: number, to = from) => {
            await act(async () => { editor.view.dispatch(editor.state.tr.insertText(text, from, to)); });
        };
        await act(async () => { view.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        await compose('n', 4);
        await compose('i', 5);
        // The parent re-rendering with its last confirmed value must not roll the composition back.
        await view.update({ value: 'hi ' });
        expect(view.ref.current?.getText()).toBe('hi ni');
        expect(onChangeText).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
        expect(onSelectionChange).not.toHaveBeenCalled();

        await compose('你', 4, 6);
        await act(async () => {
            view.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            await Promise.resolve();
        });
        expect(onChangeText.mock.calls).toEqual([['hi 你']]);
        expect(onStateChange.mock.calls).toEqual([[{ text: 'hi 你', selection: { start: 4, end: 4 } }]]);

        await view.update({ value: 'hi 你' });
        await compose('!', 5);
        expect(onChangeText.mock.calls).toEqual([['hi 你'], ['hi 你!']]);
    });

    it('reports a held composition when it crosses the send button emptiness edge', async () => {
        const onChangeText = vi.fn();
        const view = await render({ value: '', onChangeText });
        const editor = (view.input as TiptapEditorHTMLElement).editor!;
        const compose = async (text: string, from: number, to = from) => {
            await act(async () => { editor.view.dispatch(editor.state.tr.insertText(text, from, to)); });
        };
        await act(async () => { view.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        // Whitespace-only is still empty to the send button: held.
        await compose(' ', 1);
        expect(onChangeText).not.toHaveBeenCalled();
        // Gboard composes every word, so the first real word must enable send while composing.
        await compose('ni', 2);
        expect(onChangeText.mock.calls).toEqual([[' ni']]);
        await view.update({ value: ' ni' });
        await compose('hao', 4);
        expect(onChangeText).toHaveBeenCalledOnce();
        expect(view.ref.current?.getText()).toBe(' nihao');

        await compose('你好', 2, 7);
        await act(async () => {
            view.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            await Promise.resolve();
        });
        expect(onChangeText.mock.calls).toEqual([[' ni'], [' 你好']]);
        expect(view.ref.current?.getText()).toBe(' 你好');
    });

    it('forwards shortcut metadata with the live text and selection, and allows focus and blur through the handle', async () => {
        const onKeyPress = vi.fn(() => true), onFocus = vi.fn(), onBlur = vi.fn();
        const view = await render({ value: 'draft', onKeyPress, onFocus, onBlur });
        await act(async () => { view.ref.current?.focus(); view.ref.current?.setSelection({ start: 2, end: 2 }); });
        expect(document.activeElement).toBe(view.input);
        expect(onFocus).toHaveBeenCalledOnce();
        const event = await key(view.input, 'Enter', { code: 'Enter', altKey: true, metaKey: true, repeat: true });
        expect(event.defaultPrevented).toBe(true);
        expect(onKeyPress).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'Enter', code: 'Enter', altKey: true,
            metaKey: true, ctrlKey: false, shiftKey: false, repeat: true, isComposing: false,
            inputState: expect.objectContaining({ text: 'draft', selection: { start: 2, end: 2 } }) }));
        await act(async () => view.ref.current?.blur());
        expect(document.activeElement).not.toBe(view.input);
        expect(onBlur).toHaveBeenCalledOnce();
    });

    it('restores draft scroll on external adoption and new restore tokens while preserving user scroll through edits', async () => {
        const onScrollYChange = vi.fn();
        const view = await render({ value: 'first', initialScrollY: 12, scrollRestoreToken: 'a', onScrollYChange });
        expect(view.host.scrollTop).toBe(12);
        view.host.scrollTop = 50;
        await view.update({ value: 'external' });
        expect(view.host.scrollTop).toBe(12);
        view.host.scrollTop = 60;
        await act(async () => { view.host.dispatchEvent(new Event('scroll')); });
        expect(onScrollYChange).toHaveBeenLastCalledWith(60);
        await paste(view.input, ' edit');
        await view.update({ value: view.ref.current!.getText() });
        expect(view.host.scrollTop).toBe(60);
        await view.update({ scrollRestoreToken: 'b' });
        expect(view.host.scrollTop).toBe(12);
    });

    it('defers scroll restoration while the editor is composing', async () => {
        const view = await render({ value: 'hello', initialScrollY: 12, scrollRestoreToken: 'a' });
        await act(async () => { view.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        view.host.scrollTop = 3;
        await view.update({ value: 'hello updated', initialScrollY: 24, scrollRestoreToken: 'b' });
        expect(view.host.scrollTop).toBe(3);
    });

    it('reports full content height without collapsing the scroll viewport and deduplicates layout reports', async () => {
        const observers: Array<() => void> = [];
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) { observers.push(callback); }
            observe() {}
            disconnect() {}
        });
        try {
            const onContentHeightChange = vi.fn();
            const view = await render({ value: 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1), maxHeight: 144, onContentHeightChange });
            Object.defineProperty(view.host, 'scrollHeight', { configurable: true, value: 8000 });
            view.host.scrollTop = 200;
            await act(async () => { observers.forEach(notify => notify()); });
            expect(onContentHeightChange).toHaveBeenLastCalledWith(8000);
            const reports = onContentHeightChange.mock.calls.length;
            await act(async () => { observers.forEach(notify => notify()); });
            expect(onContentHeightChange).toHaveBeenCalledTimes(reports);
            expect(view.host.scrollTop).toBe(200);
            expect(view.host.style.maxHeight).toBe('144px');
        } finally { vi.unstubAllGlobals(); }
    });

    it('publishes no content height while a retained pane hides it (display: none reports every observed box 0×0)', async () => {
        const observers: Array<() => void> = [];
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) { observers.push(callback); }
            observe() {}
            disconnect() {}
        });
        try {
            const onContentHeightChange = vi.fn();
            const view = await render({ value: 'hello', onContentHeightChange });
            Object.defineProperty(view.host, 'scrollHeight', { configurable: true, value: 120 });
            await act(async () => { observers.forEach(notify => notify()); });
            expect(onContentHeightChange).toHaveBeenLastCalledWith(120);
            const reports = onContentHeightChange.mock.calls.length;
            // Hidden: the browser lays nothing out, so the host has no box and no scroll height.
            let hidden = true;
            Object.defineProperty(view.host, 'checkVisibility', { configurable: true, value: () => !hidden });
            Object.defineProperty(view.host, 'scrollHeight', { configurable: true, value: 0 });
            await act(async () => { observers.forEach(notify => notify()); });
            hidden = false;
            Object.defineProperty(view.host, 'scrollHeight', { configurable: true, value: 120 });
            await act(async () => { observers.forEach(notify => notify()); });
            expect(onContentHeightChange).toHaveBeenCalledTimes(reports);
        } finally { vi.unstubAllGlobals(); }
    });

    it('measures window and caret coordinates through the handle and releases caret notifications', async () => {
        const view = await render({ value: 'hello' });
        vi.spyOn(view.host, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 15, 200, 30));
        const measured = vi.fn(); view.ref.current?.measureInWindow(measured);
        expect(measured).toHaveBeenCalledWith(5, 15, 200, 30);
        expect(view.ref.current?.getReactNodeTag()).toBeNull();
        expect(view.ref.current?.getCaretRect()).toEqual({ left: 25, top: 35, height: 18 });
        const onCaret = vi.fn();
        const unsubscribe = view.ref.current!.subscribeCaretRect(onCaret);
        await act(async () => { view.host.dispatchEvent(new Event('scroll')); });
        expect(onCaret).toHaveBeenCalled();
        onCaret.mockClear(); unsubscribe();
        await act(async () => { view.host.dispatchEvent(new Event('scroll')); });
        expect(onCaret).not.toHaveBeenCalled();
    });

    it('refreshes caret coordinates when an ancestor reflows without changing the editor selection', async () => {
        const observers: Array<{ elements: Set<Element>; notify: () => void }> = [];
        vi.stubGlobal('ResizeObserver', class {
            elements = new Set<Element>();
            constructor(private callback: () => void) { observers.push(this); }
            observe(element: Element) { this.elements.add(element); }
            disconnect() { this.elements.clear(); }
            notify() { this.callback(); }
        });
        try {
            const view = await render({ value: 'hello' });
            let rect = view.ref.current!.getCaretRect();
            const unsubscribe = view.ref.current!.subscribeCaretRect(() => { rect = view.ref.current!.getCaretRect(); });
            vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(125, 135, 0, 18));
            await act(async () => {
                for (const observer of observers) if (observer.elements.has(container!)) observer.notify();
            });
            expect(rect).toEqual({ left: 125, top: 135, height: 18 });
            unsubscribe();
        } finally { vi.unstubAllGlobals(); }
    });

    it.each(['item', 'duplicate', 'fallback'] as const)('forwards pasted files once via the %s clipboard path', async kind => {
        const onFilesPasted = vi.fn();
        const view = await render({ value: 'Inspect this image', onFilesPasted });
        const file = new File(['image'], 'image.png', { type: 'image/png', lastModified: 2 });
        const duplicate = new File(['image'], 'image.png', { type: 'image/png', lastModified: 1 });
        const event = await paste(view.input, '', kind === 'duplicate' ? [duplicate] : kind === 'fallback' ? [file] : [],
            kind === 'fallback' ? [null] : [file]);
        expect(event.defaultPrevented).toBe(true);
        expect(onFilesPasted).toHaveBeenCalledExactlyOnceWith([file]);
        expect(view.ref.current?.getText()).toBe('Inspect this image');
    });
});
