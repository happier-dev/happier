// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default } });
});

const { readCodeLineFromDomNode, resolveSourceLinesForText, readDomCodeSelectionRange, useDomTextSelection } = await import('./useDomTextSelection');

describe('read-body selection lines', () => {
    it.each(['code', 'markdown'])('reads a whole %s block whose exclusive end is outside the reader', async (mode) => {
        const host = document.createElement('div');
        host.innerHTML = '<div><div id="reader-f:1"><span>alpha own sync139</span></div></div><p>foreign text</p>';
        document.body.append(host);
        const root = host.firstElementChild!;
        const text = root.querySelector('span')!.firstChild!;
        const range = document.createRange(); range.setStart(text, 0); range.setEnd(host.lastElementChild!, 0);
        const bounds = { left: 20, top: 200, width: 160, height: 20 };
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => bounds });
        Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [bounds] });
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        const hook = await renderHook(() => useDomTextSelection({ rootRef: { current: root }, active: true,
            resolveLines: ({ startNode, endNode, text: selected }) => mode === 'markdown'
                ? resolveSourceLinesForText('alpha own sync139', selected)
                : (() => { const startLine = readCodeLineFromDomNode(startNode), endLine = readCodeLineFromDomNode(endNode);
                    return startLine && endLine ? { startLine, endLine } : null; })() }));
        try {
            expect(hook.getCurrent().getSelection()).toMatchObject({ startLine: 1, endLine: 1, text: 'alpha own sync139' });
            range.setEnd(host.lastElementChild!.firstChild!, 7);
            expect(hook.getCurrent().getSelection()).toBeNull();
        } finally { await hook.unmount(); selection.removeAllRanges(); host.remove(); }
    });
    it('reads UTF-16 selection endpoints across syntax spans and refuses removed or foreign text', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div data-code-line-kind="file" data-code-line-new="7"><span data-code-text="f:7"><span>😀 </span><span>target</span></span></div>';
        document.body.append(root);
        const text = root.querySelector('[data-code-text]')!.lastChild!.firstChild!;
        const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 5);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        expect(readDomCodeSelectionRange(root)).toEqual({ start: { line: 6, character: 4 }, end: { line: 6, character: 8 } });
        expect(readDomCodeSelectionRange(document.createElement('div'))).toBeNull();
        root.firstElementChild!.removeAttribute('data-code-line-new');
        root.firstElementChild!.setAttribute('data-code-line-old', '7');
        expect(readDomCodeSelectionRange(root)).toBeNull();
        selection.removeAllRanges(); root.remove();
    });
    it('reads a text node\'s file line from its rendered code row', () => {
        const row = { id: ':r5:-f:23', parentElement: null, nodeType: 1 };
        const span = { id: '', parentElement: row, nodeType: 1 };
        const text = { parentElement: span, nodeType: 3 };
        expect(readCodeLineFromDomNode(text)).toBe(23);
        expect(readCodeLineFromDomNode({ parentElement: { id: 'pane', parentElement: null, nodeType: 1 }, nodeType: 3 })).toBeNull();
    });

    it('finds a rendered Markdown selection\'s lines in its source', () => {
        const source = '# Demo project\n\nA small project for Files & Editor QA.\n\nSee [the retry helper](src/retry.ts).\n';
        expect(resolveSourceLinesForText(source, 'A small project for Files & Editor QA.')).toEqual({ startLine: 3, endLine: 3 });
        expect(resolveSourceLinesForText(source, 'Demo project\nA small project')).toEqual({ startLine: 1, endLine: 3 });
        expect(resolveSourceLinesForText(source, 'nowhere')).toBeNull();
    });
});
