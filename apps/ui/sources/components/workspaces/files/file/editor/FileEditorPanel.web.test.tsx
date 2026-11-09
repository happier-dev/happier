// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { createThemeFixture, renderScreen } from '@/dev/testkit';
import { KeyboardShortcutProvider, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { FindBar } from '@/components/ui/find/FindBar';
import { executeFindAction } from '@/keyboard/findActionRuntime';

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = React.forwardRef((props: { children?: React.ReactNode }, ref) => {
        React.useImperativeHandle(ref, () => document.createElement('div'));
        return React.createElement('View', props, props.children);
    });
    return createReactNativeWebMock({ View });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// Resolve Metro's web suffix without replacing the real editor/host logic.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => import('@/components/ui/code/editor/CodeEditor.web'));

import { FileEditorPanel } from './FileEditorPanel';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';

it.each(['code', 'markdown'])('passes focused Monaco shortcuts and reopens %s Find without overwriting the native query', async (kind) => {
    const measuredLayout = { lineNumbersWidth: 0, decorationsWidth: 10, contentLeft: 10 };
    const measureDigits = (digits: number) => { measuredLayout.lineNumbersWidth = Math.round(digits * 7.8); measuredLayout.contentLeft = measuredLayout.lineNumbersWidth + measuredLayout.decorationsWidth; };
    const editorDom = document.createElement('div');
    const bodyInput = document.createElement('textarea');
    const widget = document.createElement('div');
    widget.className = 'find-widget';
    const findInput = document.createElement('input');
    // Genuine Monaco boundary: 0.55.1 findController.js applies explicit searchString arguments;
    // normal actions.find seeds the editor selection, whereas findWithArgs without arguments
    // preserves an existing native query. Keep the native field independent of the host snapshot.
    const selectedText = 'previous seed';
    const trigger = vi.fn((_source: string, action: string, args: unknown) => {
        if (action === 'actions.find') findInput.value = selectedText;
        if (action === 'editor.actions.findWithArgs') {
            if (args && typeof args === 'object' && 'searchString' in args && typeof args.searchString === 'string') {
                findInput.value = args.searchString;
            } else if (!findInput.value) findInput.value = selectedText;
        }
    });
    widget.append(findInput);
    editorDom.append(bodyInput, widget);
    document.body.append(editorDom);
    const languageDefaults = { modeConfiguration: {}, setModeConfiguration() {} };
    Object.defineProperty(window, 'require', { configurable: true, value: (_modules: string[], ready: () => void) => ready() });
    Object.defineProperty(window, 'monaco', { configurable: true, value: {
        KeyCode: { Tab: 2, RightArrow: 17, Escape: 9, Backslash: 88 },
        KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512 },
        typescript: { typescriptDefaults: { setModeConfiguration() {} }, javascriptDefaults: { setModeConfiguration() {} } },
        json: { jsonDefaults: languageDefaults },
        css: { cssDefaults: languageDefaults, scssDefaults: languageDefaults, lessDefaults: languageDefaults },
        html: { htmlDefaults: languageDefaults, handlebarDefaults: languageDefaults, razorDefaults: languageDefaults },
        languages: { registerInlineCompletionsProvider: () => ({ dispose() {} }) },
        editor: {
        createModel: () => ({ uri: { scheme: 'inmemory', path: '/find-test' }, getLanguageId: () => 'plaintext',
            getValue: () => 'first\\n', getLineCount: () => 1, getVersionId: () => 1, getEOL: () => '\n', setValue() {}, dispose() {} }),
        create: (_node: unknown, options: { lineNumbersMinChars: number }) => { measureDigits(options.lineNumbersMinChars); return ({ trigger, getDomNode: () => editorDom, hasWidgetFocus: () => editorDom.contains(document.activeElement),
            createContextKey: () => ({ set() {}, reset() {} }),
            createDecorationsCollection: () => ({ set() {}, clear() {} }),
            addAction: () => ({ dispose() {} }),
            onDidChangeModelContent: () => ({ dispose() {} }), onDidBlurEditorText: () => ({ dispose() {} }),
            getLayoutInfo: () => measuredLayout,
            updateOptions(next: { lineDecorationsWidth?: number; lineNumbersMinChars?: number }) {
                if (next.lineDecorationsWidth !== undefined) measuredLayout.decorationsWidth = next.lineDecorationsWidth;
                measureDigits(next.lineNumbersMinChars ?? Math.round(measuredLayout.lineNumbersWidth / 7.8));
            }, dispose() {}, focus() {} }); },
        defineTheme() {}, setTheme() {},
    } } });
    const editorRef = { current: null as CodeEditorHandle | null };
    let open: ReturnType<typeof useFindSurfaceRuntime>['open'] = () => false;
    function Probe() { open = useFindSurfaceRuntime().open; return null; }
    const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}} enabledWhenDisabledCommandIds={['find.open']}>
        <PluginSurfaceFocusEligibilityProvider active={true}>
            <Probe />
            {kind === 'code' ? <FileEditorPanel theme={createThemeFixture()} resetKey="a.ts" editorRef={editorRef}
                lineNumberDigits={5} reviewLaneWidth={32} showLineNumbers
                filePath="a.ts" surfaceId="file:editor" value="first\\n" language="plaintext" onChange={() => {}} /> :
                <MarkdownCodeEditorField resetKey="a.md" editorRef={editorRef} filePath="a.md"
                    lineNumberDigits={5} reviewLaneWidth={32} showLineNumbers
                    findSurfaceId="file:editor" value="first\\n" language="markdown" sourceOnly onChange={() => {}} />}
        </PluginSurfaceFocusEligibilityProvider>
    </KeyboardShortcutProvider>);
    try {
        // The real composition must reach Monaco's measured layout, beyond forwarding props.
        // The code view's geometry: five 11 px digits (33), and on the File page's canvas its 16 px inset.
        expect(measuredLayout.contentLeft).toBe((kind === 'code' ? 16 : 0) + 8 + 32 + 4 + 33 + 18);
        await act(async () => { bodyInput.focus(); });
        const first = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true });
        await act(async () => { bodyInput.dispatchEvent(first); });
        expect(first.defaultPrevented).toBe(false);
        expect(trigger).not.toHaveBeenCalled();
        widget.classList.add('visible');
        await act(async () => { findInput.focus(); });
        const second = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true });
        await act(async () => { findInput.dispatchEvent(second); });
        expect(second.defaultPrevented).toBe(false);
        for (const init of [{ key: 'g', code: 'KeyG', ctrlKey: true }, { key: 'Enter', code: 'Enter' }, { key: 'Escape', code: 'Escape' }]) {
            const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
            await act(async () => { findInput.dispatchEvent(event); });
            expect(event.defaultPrevented).toBe(false);
        }
        expect(trigger).not.toHaveBeenCalled();
        const execute = (input: unknown) => executeFindAction({ actionId: 'ui.find', input, context: { surface: 'ui' } });
        await expect(execute({ op: 'read' })).resolves.toEqual({ ok: true, result: {
            status: 'unavailable', unavailable: 'engineOwned', query: '', options: { matchCase: false, regex: false },
        } });
        await act(async () => { await execute({ op: 'set', query: 'Action needle', options: { matchCase: false, regex: true } }); });
        expect(findInput.value).toBe('Action needle');
        await expect(execute({ op: 'read' })).resolves.toMatchObject({ result: {
            status: 'unavailable', unavailable: 'engineOwned', query: 'Action needle', options: { matchCase: false, regex: true },
        } });
        await execute({ op: 'step', direction: -1 });
        expect(trigger).toHaveBeenLastCalledWith('happier.find', 'editor.action.previousMatchFindAction', null);
        await act(async () => { await execute({ op: 'close' }); });
        expect(trigger).toHaveBeenCalledWith('happier.find', 'closeFindWidget', null);
        await act(async () => { editorRef.current!.find!.seed(selectedText, { matchCase: true, regex: false }); });
        expect(findInput.value).toBe(selectedText);
        findInput.value = 'typed native query with no match';
        expect(editorRef.current!.find!.getSnapshot().query).toBe(selectedText);
        await act(async () => { expect(open('file:editor')).toBe(true); });
        expect(findInput.value).toBe('typed native query with no match');
        expect(screen.tree.root.findAllByType(FindBar)).toHaveLength(0);
    } finally {
        await act(async () => { screen.tree.unmount(); });
        editorDom.remove();
    }
});
