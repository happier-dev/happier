/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { tiptapWebViewApi } from '../tiptapWebViewEntry';
import { readCodeMirrorFindStatus } from '../../../../code/editor/bridge/codeEditorFindBridge';
import { TIPTAP_WEBVIEW_BUNDLE_JS } from '../tiptapWebViewBundle.generated';

new Function(TIPTAP_WEBVIEW_BUNDLE_JS)();
const generatedApi = globalThis.HAPPIER_TIPTAP_WEBVIEW!;
describe.each([{ name: 'source', api: tiptapWebViewApi }, { name: 'generated bundle', api: generatedApi }])('rich WebView document and Find contract ($name)', ({ api }) => {
    it('delegates keyboard history and preserves exact replacement source bytes across a flush', () => {
        const messages: Array<{ type: string; payload?: unknown }> = [];
        const root = document.createElement('div');
        document.body.appendChild(root);
        const runtime = api.createRuntime({ root, postEnvelope: message => messages.push(message), config: { readOnly: false, changeDebounceMs: 0, sharedHistory: true } });
        try {
            runtime.onEnvelope({ v: 1, type: 'init', payload: { doc: '# Draft\n' } });
            const input = root.querySelector('.ProseMirror')!;
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
            expect(messages.filter(message => message.type === 'history.command').at(-1)?.payload).toEqual({ command: 'undo' });
            const systemUndo = new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true });
            input.dispatchEvent(systemUndo);
            expect(systemUndo.defaultPrevented).toBe(true);
            expect(messages.filter(message => message.type === 'history.command')).toHaveLength(2);
            input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));
            expect(messages.filter(message => message.type === 'history.command')).toHaveLength(2);
            const doc = '# Exact\r\n\r\n- one\r\n';
            runtime.onEnvelope({ v: 1, type: 'text.command', payload: { command: { replaceDocument: doc, history: 'undo' } } });
            runtime.onEnvelope({ v: 1, type: 'requestDoc', payload: { requestId: 'undo-flush' } });
            expect(messages.filter(message => message.type === 'docSnapshot').at(-1)?.payload).toEqual({ requestId: 'undo-flush', doc });
            expect(messages.filter(message => message.type === 'docChanged')).toHaveLength(0);
        } finally { runtime.destroy(); root.remove(); }
    });
    it('returns the original source on flush before edits', () => {
        const messages: Array<{ type: string; payload?: unknown }> = [];
        const root = document.createElement('div');
        document.body.appendChild(root);
        const runtime = api.createRuntime({ root, postEnvelope: message => messages.push(message), config: { readOnly: false, changeDebounceMs: 0 } });
        try {
            const doc = '# Guide\n\n- one\n- two\n';
            runtime.onEnvelope({ v: 1, type: 'init', payload: { doc } });
            runtime.onEnvelope({ v: 1, type: 'requestDoc', payload: { requestId: 'flush' } });
            expect(messages.find(message => message.type === 'docSnapshot')?.payload).toEqual({ requestId: 'flush', doc });
            runtime.onEnvelope({ v: 1, type: 'setDoc', payload: { doc: `${doc}\n` } });
            runtime.onEnvelope({ v: 1, type: 'requestDoc', payload: { requestId: 'reseed' } });
            expect(messages.filter(message => message.type === 'docSnapshot').at(-1)?.payload).toEqual({ requestId: 'reseed', doc: `${doc}\n` });
        } finally { runtime.destroy(); root.remove(); }
    });

    it('searches through the runtime bridge with host-readable counts and no doc change', () => {
        const messages: Array<{ type: string; payload?: unknown }> = [];
        const root = document.createElement('div');
        document.body.appendChild(root);
        const runtime = api.createRuntime({ root, postEnvelope: message => messages.push(message), config: { readOnly: false, changeDebounceMs: 0 } });
        try {
            runtime.onEnvelope({ v: 1, type: 'init', payload: { doc: '# Retry\n\nRetry **now**. Retry now.' } });
            const request = { query: 'Retry now', options: { matchCase: false, regex: false } };
            runtime.onEnvelope({ v: 1, type: 'find.set', payload: request });
            const status = () => readCodeMirrorFindStatus(messages.filter(message => message.type === 'find.status').at(-1)?.payload, request);
            expect(status()).toEqual({ kind: 'results', total: 2, current: 1, coverage: 'complete' });
            runtime.onEnvelope({ v: 1, type: 'find.step', payload: { direction: 1 } });
            expect(status()).toMatchObject({ current: 2 });
            expect(Array.from(root.querySelectorAll('[data-rich-find]')).map(node => node.textContent).join('')).toBe('Retry nowRetry now');
            runtime.onEnvelope({ v: 1, type: 'find.close', payload: {} });
            expect(root.querySelectorAll('[data-rich-find]')).toHaveLength(0);
            expect(messages.filter(message => message.type === 'docChanged')).toHaveLength(0);
        } finally { runtime.destroy(); root.remove(); }
    });
});
