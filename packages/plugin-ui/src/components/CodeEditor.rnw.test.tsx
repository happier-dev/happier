import { act, createRef, forwardRef, useImperativeHandle } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CodeEditor } from './CodeEditor.js';
import type { CodeEditorHandle } from '../presentation/content/CodeEditor.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';

describe('portable CodeEditor selection', () => {
    it('publishes host ranges, preserves the public handle and retires subscriptions on unmount', async () => {
        const listeners = new Set<() => void>();
        let selection: ReturnType<NonNullable<CodeEditorHandle['getSelection']>> = null;
        const handle: CodeEditorHandle = {
            getValue: () => '😀 select', flushPendingChange: async () => {}, revealLine() {}, runCommand() {},
            subscribeHistory: () => () => {}, setDecorations() {}, removeDecoration() {}, onDecorationPress: () => () => {},
            getSelection: () => selection,
            subscribeSelection: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        };
        // The host renderer is the package's platform boundary; selection facts come from its handle.
        const HostEditor = forwardRef<CodeEditorHandle>(function HostEditor(_props, ref) {
            useImperativeHandle(ref, () => handle, []);
            return null;
        });
        const host = { renderCodeEditor: ({ editorRef }) => <HostEditor ref={editorRef} />,
            renderMarkdown: () => null, renderCodeBlock: () => null, renderIcon: () => null,
            renderPopover: () => null } satisfies PluginUiPresentationHost;
        const onSelection = vi.fn();
        const ref = createRef<CodeEditorHandle>();
        const screen = mountThroughReactNativeWeb(<PluginUiPresentationHostProviderInternal host={host}>
            <CodeEditor ref={ref} value="😀 select" resetKey="sql" language="sql" onChange={() => {}} onSelection={onSelection} />
        </PluginUiPresentationHostProviderInternal>);
        try {
            expect(ref.current).toBe(handle);
            expect(onSelection).toHaveBeenLastCalledWith(null);
            selection = { startLine: 1, endLine: 1, text: 'select', rect: null, range: { start: 3, end: 9 }, collapsed: false };
            await act(async () => { for (const listener of listeners) listener(); });
            expect(onSelection).toHaveBeenLastCalledWith({ start: 3, end: 9 });
            const publications = onSelection.mock.calls.length;
            // Geometry changes share the handle subscription but do not change the SQL range.
            selection = { ...selection, rect: { x: 1, y: 2, width: 0, height: 12 } };
            await act(async () => { for (const listener of listeners) listener(); });
            expect(onSelection.mock.calls).toHaveLength(publications);
            selection = { ...selection, range: { start: 9, end: 9 }, collapsed: true };
            await act(async () => { for (const listener of listeners) listener(); });
            expect(onSelection).toHaveBeenLastCalledWith({ start: 9, end: 9 });
        } finally { screen.unmount(); }
        expect(listeners.size).toBe(0);
    });
});
