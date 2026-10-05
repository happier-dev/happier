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

it('passes focused Monaco shortcuts and reopens toolbar Find without overwriting the native query', async () => {
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
    Object.defineProperty(window, 'require', { configurable: true, value: (_modules: string[], ready: () => void) => ready() });
    Object.defineProperty(window, 'monaco', { configurable: true, value: { editor: {
        createModel: () => ({ getValue: () => 'first\\n', setValue() {}, dispose() {} }),
        create: () => ({ trigger, getDomNode: () => editorDom, hasWidgetFocus: () => editorDom.contains(document.activeElement),
            onDidChangeModelContent: () => ({ dispose() {} }), onDidBlurEditorText: () => ({ dispose() {} }),
            updateOptions() {}, dispose() {}, focus() {} }),
        defineTheme() {}, setTheme() {},
    } } });
    const editorRef = { current: null as CodeEditorHandle | null };
    let open: ReturnType<typeof useFindSurfaceRuntime>['open'] = () => false;
    function Probe() { open = useFindSurfaceRuntime().open; return null; }
    const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}} enabledWhenDisabledCommandIds={['find.open']}>
        <PluginSurfaceFocusEligibilityProvider active={true}>
            <Probe />
            <FileEditorPanel theme={createThemeFixture()} resetKey="a.ts" editorRef={editorRef}
                filePath="a.ts" surfaceId="file:editor" value="first\\n" language="plaintext" onChange={() => {}} />
        </PluginSurfaceFocusEligibilityProvider>
    </KeyboardShortcutProvider>);
    try {
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
