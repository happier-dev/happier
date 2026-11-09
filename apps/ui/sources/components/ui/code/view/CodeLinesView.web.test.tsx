// @vitest-environment jsdom
import React from 'react';
import renderer from 'react-test-renderer';
import type { TextProps } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { codeViewListRef, installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import type { CodeLinePressEvent } from './CodeLineRow';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rowTextCommits = new Map<string, number>();
const rowTextRenders = new Map<string, number>();

installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            // Count commits at the native text boundary; the code row and Find paint stay real.
            Text: ({ children, ...props }: TextProps & { dataSet?: { codeText?: string } }) => {
                const id = props.dataSet?.codeText;
                if (id) rowTextRenders.set(id, (rowTextRenders.get(id) ?? 0) + 1);
                React.useLayoutEffect(() => {
                    if (id) rowTextCommits.set(id, (rowTextCommits.get(id) ?? 0) + 1);
                });
                return React.createElement('Text', props, children);
            },
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    surface: { base: '#fff', inset: '#fff' },
                    text: { primary: '#111', secondary: '#666' },
                    syntax: {
                        default: '#111',
                        keyword: '#123456',
                        string: '#0a3069',
                        comment: '#666',
                        number: '#0550ae',
                        function: '#8250df',
                    },
                },
            },
        });
    },
});

async function findCodeRows(tree: renderer.ReactTestRenderer) {
    const { CodeLineRow } = await import('./CodeLineRow');
    return tree.root.findAllByType(CodeLineRow);
}

const createHighlighterSpy = vi.fn(async (..._args: any[]) => ({
    loadLanguage: async () => {},
    codeToTokens: (code: string) => ({
        fg: '#000',
        tokens: code.split('\n').map(text => [{ content: text, color: '#f00' }]),
    }),
}));

vi.mock('shiki', () => ({
    bundledLanguages: {
        ts: {},
        js: {},
        python: {},
    },
    createHighlighter: (...args: any[]) => createHighlighterSpy(...args),
}));

// Vite's cold module graph is setup, not part of the first layout scenario's deadline.
await import('./CodeLinesViewCore');
const { VirtualizedList } = await import('@/components/ui/lists/virtualized');
beforeEach(() => { Object.values(codeViewListRef).forEach(mock => mock.mockReset()); });

async function flushReactAsyncWork(): Promise<void> {
    // The highlighter and its regex engine load through dynamic imports; microtask
    // flushing alone does not wait for Vite to finish those module requests.
    await vi.dynamicImportSettled();
    await flushHookEffects({ cycles: 10, turns: 25 });
}

describe('CodeLinesView (web)', () => {
    it('bootstraps an unmeasured wrapped phone target, then lands on its real row layout', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: Array.from({ length: 360 }, (_, index) =>
            `export const coast${index + 1} = "Coastal notebook line ${index + 1}";`).join('\n') });
        const phone = document.createElement('div');
        phone.style.width = '390px';
        document.body.append(phone);
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} wrapLines virtualized scrollToLineId={lines[149].id} />);
        try {
            const list = screen.tree.root.findByType('LegendList');
            expect(list.props.estimatedItemSize).toBeGreaterThan(0);
            expect(codeViewListRef.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 149 }));
            const row = screen.tree.root.findAll(node => typeof node.props.nativeID === 'string'
                && node.props.nativeID.endsWith(`-${lines[149].id}`) && typeof node.props.onLayout === 'function')[0];
            const target = document.createElement('div');
            target.id = row.props.nativeID;
            target.scrollIntoView = vi.fn();
            phone.append(target);
            await renderer.act(async () => row.props.onLayout());
            expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
            await renderer.act(async () => screen.tree.root.findByType(VirtualizedList).props.onContentSizeChange(390, 15_000));
            expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
        } finally { await screen.unmount(); phone.remove(); }
    });

    it.each(['content', 'viewport', 'resize', 'find', 'scroll', 'wheel', 'pointerdown', 'keydown', 'touchmove'] as const)(
        'finishes a clamped reading landing on growth, yielding to %s', async scenario => {
            const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
            const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
            const lines = buildCodeLinesFromFile({ text: Array.from({ length: 213 }, (_, index) => `line ${index + 1}`).join('\n') });
            const scroller = document.createElement('div'); scroller.style.overflowY = 'auto';
            const content = document.createElement('div'); const target = document.createElement('div');
            content.append(target); scroller.append(content); document.body.append(scroller);
            let extent = 4470, offset = 0;
            Object.defineProperties(scroller, {
                clientHeight: { value: 794 }, scrollHeight: { get: () => extent },
                scrollTop: { get: () => offset, set: (top: number) => { offset = Math.max(0, Math.min(top, extent - 794)); } },
            });
            scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 794);
            target.getBoundingClientRect = () => new DOMRect(0, 4300 - offset, 400, 22);
            // Substitute only browser layout and scroll clamping while the real Core owns navigation.
            const land = vi.fn(() => { scroller.scrollTop = 4300 - Number.parseFloat(target.style.scrollMarginTop || '0'); });
            target.scrollIntoView = land;
            const observers = new Set<{ callback: ResizeObserverCallback; nodes: Set<Element> }>();
            class LayoutObserver {
                nodes = new Set<Element>();
                constructor(public callback: ResizeObserverCallback) { observers.add(this); }
                observe(node: Element) { this.nodes.add(node); }
                unobserve(node: Element) { this.nodes.delete(node); }
                disconnect() { observers.delete(this); }
            }
            vi.stubGlobal('ResizeObserver', LayoutObserver);
            const ranges = scenario === 'find' ? new Map([['f:150', [{ start: 0, end: 4, current: true }]]]) : undefined;
            const render = () => <CodeLinesViewCore lines={[...lines]} scrollToLineId="f:150" findRangesByLineId={ranges} />;
            const screen = await renderScreen(render());
            const row = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.nativeID?.endsWith('-f:150'))[0]!;
            target.id = row.props.nativeID;
            const layout = async () => renderer.act(async () => {
                const list = screen.tree.root.findByType(VirtualizedList);
                if (scenario === 'viewport') list.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 794 } } });
                else if (scenario === 'content') list.props.onContentSizeChange?.(400, extent);
                else for (const observer of [...observers]) if (observer.nodes.has(content)) {
                    observer.callback([], observer as unknown as ResizeObserver);
                }
            });
            try {
                await renderer.act(async () => { row.props.onLayout?.(); });
                expect(offset).toBe(3676); // The target mounted before the rows beneath it were measured.
                const readerMoved = ['scroll', 'wheel', 'pointerdown', 'keydown', 'touchmove'].includes(scenario);
                if (readerMoved) {
                    if (scenario === 'scroll') scroller.scrollTop = 100;
                    scroller.dispatchEvent(scenario === 'keydown' ? new KeyboardEvent('keydown', { key: 'ArrowDown' }) : new Event(scenario));
                }
                const beforeGrowth = offset;
                extent = 6252;
                await layout();
                expect(offset).toBe(readerMoved ? beforeGrowth : 4035);
                const settledLandings = land.mock.calls.length;
                await layout();
                expect(land).toHaveBeenCalledTimes(settledLandings); // Unchanged geometry causes no scrolling work.
                scroller.scrollTop = 100;
                scroller.dispatchEvent(new Event('scroll'));
                await screen.update(render());
                extent += 100;
                await layout();
                expect(offset).toBe(100); // An equivalent rerender cannot reacquire the reader's position.
            } finally { await screen.unmount(); scroller.remove(); vi.unstubAllGlobals(); }
        },
    );
    it.each(['viewport', 'content'] as const)('resumes a pending line landing after the %s becomes measurable', async measurement => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: Array.from({ length: 161 }, (_, index) => `line ${index + 1}`).join('\n') });
        const scroller = document.createElement('div'); scroller.style.overflowY = 'auto';
        const first = document.createElement('div'); scroller.append(first); document.body.append(scroller);
        let measured = false;
        Object.defineProperties(scroller, { clientHeight: { value: 473 }, scrollHeight: { get: () => measured ? 3590 : 473 },
            scrollTo: { value: ({ top }: ScrollToOptions) => { scroller.scrollTop = measured ? top ?? 0 : 0; } } });
        codeViewListRef.scrollToIndex.mockImplementation(() => { scroller.scrollTop = measured ? 3000 : 0; });
        // DOM availability/measurement is the browser boundary. The pending-target owner remains real.
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} scrollToLineId="f:150" />);
        const rows = screen.tree.root.findAll(node => typeof node.type === 'string' && typeof node.props.nativeID === 'string');
        first.id = rows.find(row => row.props.nativeID.endsWith('-f:1'))!.props.nativeID;
        const row = rows.find(row => row.props.nativeID.endsWith('-f:150'))!;
        const list = () => screen.tree.root.findByType(VirtualizedList);
        try {
            expect(scroller.scrollTop).toBe(0);
            measured = true;
            await renderer.act(async () => {
                if (measurement === 'viewport') list().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 473 } } });
                else list().props.onContentSizeChange?.(400, 3590);
            });
            expect(scroller.scrollTop).toBeGreaterThan(0);
            const target = document.createElement('div'); target.id = row.props.nativeID;
            let landedMarginTop = '';
            const land = vi.fn(() => { landedMarginTop = target.style.scrollMarginTop; scroller.scrollTop = 3000; }); target.scrollIntoView = land;
            scroller.append(target);
            await renderer.act(async () => { row.props.onLayout?.(); });
            // The line lands in the upper third of what the reader sees (lab G1o), so the context below it is readable.
            expect(land).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
            expect(landedMarginTop).toBe('158px');
            expect(target.style.scrollMarginTop).toBe('');
            scroller.scrollTop = 100;
            await screen.update(<CodeLinesViewCore lines={[...lines]} scrollToLineId="f:150" />);
            await renderer.act(async () => { list().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 473 } } }); list().props.onContentSizeChange?.(400, 3590); });
            expect(scroller.scrollTop).toBe(100);
            expect(land).toHaveBeenCalledTimes(1);
        } finally { await screen.unmount(); scroller.remove(); }
    });
    it('accepts bare DOM modifier clicks at the row press boundary', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const { Pressable } = await import('react-native');
        const lines = buildCodeLinesFromFile({ text: '😀 target' });
        const activate = vi.fn(() => true), select = vi.fn();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized={false} onPressLine={select}
            intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />);
        const code = document.createElement('span');
        code.setAttribute('data-code-text', lines[0]!.id);
        code.innerHTML = '<span>😀 </span><span>target</span>';
        document.body.append(code);
        const target = code.lastElementChild!;
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true,
            value: () => ({ offsetNode: target.firstChild, offset: 2 }) });
        try {
            const row = (await findCodeRows(screen.tree))[0]!;
            const press = row.findByType(Pressable).props.onPress;
            if (!press) throw new Error('Expected the View row press handler');
            // The external press boundary can deliver a DOM event without a React nativeEvent wrapper.
            const event = new MouseEvent('click', { ctrlKey: true, clientX: 10, clientY: 20 });
            Object.defineProperty(event, 'target', { value: target });
            // RN's declaration admits only responder events; RN-web also supplies bare browser events.
            expect(() => press(event as unknown as Parameters<typeof press>[0])).not.toThrow();
            expect(activate).toHaveBeenCalledExactlyOnceWith(lines[0]!.id, 5, expect.objectContaining({ via: 'modifier' }), 1);
            expect(select).not.toHaveBeenCalled();
        } finally {
            await screen.unmount(); code.remove(); rowTextCommits.clear(); rowTextRenders.clear();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it.each(['off', 'simple', 'advanced'] as const)('renders only changed decorations and newly revealed rows with %s syntax', async (mode) => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { CodeLinesView } = await import('./CodeLinesView.web');
        const CodeView = mode === 'advanced' ? CodeLinesView : CodeLinesViewCore;
        const { collapseUnifiedDiffContext } = await import('../diff/happier/collapseUnifiedDiffContext');
        const { createChangedFilesReviewDiffStateSource } = await import('@/components/workspaces/scm/review/ChangedFilesReviewDiffStore');
        const { createChangedFilesReviewFind } = await import('@/components/workspaces/scm/review/useChangedFilesReviewFind');
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('large.ts', { status: 'loaded', error: null,
            diff: ['@@ -1,1000 +1,1000 @@', ...Array.from({ length: 1000 }, (_, index) => ` ${index < 2 || index === 500 ? 'needle' : 'context'} ${index}`)].join('\n') });
        const model = createChangedFilesReviewFind();
        const disconnect = model.connect({ paths: ['large.ts'], diffStateSource: source, reveal() {} });
        model.open(); model.setQuery('needle');
        const allLines = model.getFileSnapshot('large.ts').lines!;
        const folded = collapseUnifiedDiffContext({ lines: allLines, contextThreshold: 10, contextRadius: 3, expandedLineIndices: new Set() }).lines;
        const syntaxHighlighting = { mode, language: 'typescript', maxLines: 2000, maxBytes: 100_000, maxLineLength: 1000 };
        const onPressLineRange = vi.fn();
        const intelligence = { onPointerToken: vi.fn(), onActivateToken: vi.fn(() => true) };
        const render = (lines = folded) => {
            const file = model.getFileSnapshot('large.ts');
            return <CodeView lines={lines} syntaxHighlightingLines={allLines} virtualized={false} findRangesByLineId={file.ranges} syntaxHighlighting={syntaxHighlighting}
                interactionMode="commitSelection" onPressLineRange={onPressLineRange} intelligence={intelligence} />;
        };
        const ids = [...model.getFileSnapshot('large.ts').ranges.keys()];
        const screen = await renderScreen(render());
        try {
            if (mode === 'advanced') await flushReactAsyncWork();
            expect(rowTextCommits.size).toBe(7); // The hunk header plus both ends of the fold.
            rowTextCommits.clear();
            rowTextRenders.clear();
            model.step(1);
            await screen.update(render());
            if (mode === 'advanced') await flushReactAsyncWork();
            expect(rowTextCommits.size).toBe(2);
            expect([...rowTextRenders.values()].reduce((sum, renders) => sum + renders, 0)).toBe(2);
            expect([...rowTextCommits.keys()].sort()).toEqual(ids.slice(0, 2).sort());
            const before = new Map((await findCodeRows(screen.tree)).map(row => [row.props.line.id, row.props]));
            rowTextCommits.clear();
            rowTextRenders.clear();
            // Reveal the whole context run containing the next (hidden) match.
            model.step(1);
            const revealed = collapseUnifiedDiffContext({ lines: allLines, contextThreshold: 10, contextRadius: 3, expandedLineIndices: new Set([501]) }).lines;
            await screen.update(render(revealed));
            if (mode === 'advanced') await flushReactAsyncWork();
            const unchanged = (await findCodeRows(screen.tree)).find(row => row.props.line.id === ids[0])!;
            const changedInputs = Object.keys(unchanged.props).filter(key => unchanged.props[key] !== before.get(ids[0])![key]);
            expect(rowTextCommits.size, `unchanged-row prop churn: ${changedInputs.join(', ')}`).toBe(revealed.length - folded.length + 1);
            expect([...rowTextRenders.values()].reduce((sum, renders) => sum + renders, 0)).toBe(revealed.length - folded.length + 1);
            expect(changedInputs).toEqual([]);
            expect([...rowTextCommits.keys()].filter(id => folded.some(line => line.id === id))).toEqual([ids[1]]);
            // The retained handler must select through the newly revealed lines.
            const press = before.get(ids[0])!.onPressLine;
            if (!press) throw new Error('A code row must expose its line press handler');
            press(allLines[1]);
            // A web shift-click: the row's range selection reads only these fields of the press event.
            const shiftClick = { shiftKey: true, nativeEvent: { type: 'click' } } as unknown as CodeLinePressEvent;
            press(allLines[501], shiftClick);
            expect(onPressLineRange).toHaveBeenCalledWith(allLines.slice(1, 502));
        } finally {
            await screen.unmount(); rowTextCommits.clear(); rowTextRenders.clear(); disconnect();
        }
    });
    it('commits only the two changed rows when Find moves across a thousand matching lines', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { createChangedFilesReviewDiffStateSource } = await import('@/components/workspaces/scm/review/ChangedFilesReviewDiffStore');
        const { createChangedFilesReviewFind } = await import('@/components/workspaces/scm/review/useChangedFilesReviewFind');
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('large.ts', { status: 'loaded', error: null,
            diff: ['@@ -1,1000 +1,1000 @@', ...Array.from({ length: 1000 }, (_, index) => ` needle ${index}`)].join('\n') });
        const model = createChangedFilesReviewFind();
        const disconnect = model.connect({ paths: ['large.ts'], diffStateSource: source, reveal() {} });
        model.open(); model.setQuery('needle');
        const render = () => {
            const file = model.getFileSnapshot('large.ts');
            return <CodeLinesViewCore lines={file.lines!} virtualized={false} findRangesByLineId={file.ranges} />;
        };
        const ids = [...model.getFileSnapshot('large.ts').ranges.keys()];
        const screen = await renderScreen(render());
        try {
            rowTextCommits.clear();
            model.step(1);
            await screen.update(render());
            expect([...rowTextCommits.keys()].sort()).toEqual(ids.slice(0, 2).sort());
        } finally {
            await screen.unmount(); rowTextCommits.clear(); disconnect();
        }
    });
    it('keeps a Find landing through later row resizing until the reader scrolls', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: 'before\nfolded match\nafter' });
        const target = lines[1]!;
        const scroller = document.createElement('div');
        scroller.style.overflowY = 'auto';
        Object.defineProperties(scroller, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
        const content = document.createElement('div');
        const element = document.createElement('div');
        content.append(element); scroller.append(content); document.body.append(scroller);
        let rowTop = 800, rowHeight = 22;
        element.getBoundingClientRect = () => new DOMRect(0, rowTop - scroller.scrollTop, 400, rowHeight);
        scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600);
        element.scrollIntoView = () => { scroller.scrollTop = rowTop - Number.parseFloat(element.style.scrollMarginTop || '0'); };
        const observers = new Set<{ callback: ResizeObserverCallback; nodes: Set<Element> }>();
        class LayoutObserver {
            nodes = new Set<Element>();
            constructor(public callback: ResizeObserverCallback) { observers.add(this); }
            observe(node: Element) { this.nodes.add(node); }
            unobserve(node: Element) { this.nodes.delete(node); }
            disconnect() { observers.delete(this); }
        }
        vi.stubGlobal('ResizeObserver', LayoutObserver);
        const resize = async (node: Element) => renderer.act(async () => {
            for (const observer of [...observers]) if (observer.nodes.has(node)) {
                observer.callback([], observer as unknown as ResizeObserver);
            }
        });
        const ranges = new Map([[target.id, [{ start: 0, end: 6, current: true }]]]);
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId={target.id} findRangesByLineId={ranges} />);
        const row = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.nativeID?.endsWith(`-${target.id}`))[0]!;
        element.id = row.props.nativeID;
        try {
            await renderer.act(async () => { row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: rowTop, width: 400, height: 22 } } }); });
            expect(scroller.scrollTop).toBe(600);
            rowTop += 62;
            rowHeight = 66;
            await resize(content);
            expect(element.getBoundingClientRect().top + rowHeight / 2).toBe(211);
            // An equivalent decoration publication does not reacquire a reader's scroll.
            scroller.scrollTop += 100;
            scroller.dispatchEvent(new Event('scroll'));
            await screen.update(<CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId={target.id} findRangesByLineId={new Map(ranges)} />);
            rowTop += 22;
            await resize(content);
            expect(scroller.scrollTop).toBe(784);
            await screen.update(<CodeLinesViewCore lines={lines} virtualized={false} />);
            expect(observers.size).toBe(0);
        } finally {
            await screen.unmount(); scroller.remove(); vi.unstubAllGlobals();
        }
    });
    it.each([500, 5_000])('lands a revealed target when its row is measured after %i ms', async (mountDelay) => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: 'before\nfolded match\nafter' });
        const target = lines[1]!;
        vi.useFakeTimers();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId={target.id} />);
        const row = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.nativeID?.endsWith(`-${target.id}`))[0]!;
        const element = document.createElement('div');
        element.id = row.props.nativeID;
        // Browser layout and the React Native Web layout event are the only substituted boundaries.
        const scrollIntoView = vi.fn();
        element.scrollIntoView = scrollIntoView;
        try {
            await renderer.act(async () => { vi.advanceTimersByTime(mountDelay); });
            expect(scrollIntoView).not.toHaveBeenCalled();
            document.body.append(element);
            await renderer.act(async () => { row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 1200, width: 400, height: 22 } } }); });
            expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
            scrollIntoView.mockClear();
            await screen.update(<CodeLinesViewCore lines={[...lines]} virtualized={false} scrollToLineId={target.id} />);
            await renderer.act(async () => { row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 1200, width: 400, height: 22 } } }); });
            expect(scrollIntoView).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            element.remove();
            vi.useRealTimers();
        }
    });

    it('washes the block the agent writes and stands its caret after the block\'s last line (P5 Track)', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { EditorAgentCaret } = await import('@/components/ui/motion/EditorAgentCaret');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join('\n') });
        const presence = { startLine: 3, endLine: 4, agentId: null, agentName: 'Claude', reducedMotion: false };
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} agentPresence={presence} />);
        const rows = await findCodeRows(screen.tree);
        expect(rows.filter(row => row.props.agentWash).map(row => row.props.line.newLine)).toEqual([3, 4]);
        expect(rows.filter(row => row.props.agentCaret).map(row => row.props.line.newLine)).toEqual([4]);
        expect(screen.tree.root.findAllByType(EditorAgentCaret)).toHaveLength(1);

        // The next region: the caret leaves line 4 and arrives after line 6, travelling from where it stood.
        await screen.update(<CodeLinesViewCore lines={lines} agentPresence={{ ...presence, startLine: 6, endLine: 6 }} />);
        const moved = await findCodeRows(screen.tree);
        expect(moved.filter(row => row.props.agentCaret).map(row => row.props.line.newLine)).toEqual([6]);
        expect(screen.tree.root.findByType(EditorAgentCaret).props.travelFromPx).toBeLessThan(0);
        await screen.update(<CodeLinesViewCore lines={lines} agentPresence={null} />);
        expect(screen.tree.root.findAllByType(EditorAgentCaret)).toHaveLength(0);
    });

    it('opens a web list at a later line from the top, so rows before that line are not left as an unrendered gap', async () => {
        // React Native Web's list rendered only the window after `initialScrollIndex` and never filled the rows
        // above it when the content did not scroll (File page Changes opening at its first change). The scroll
        // effect lands the line instead.
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') });
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized scrollToLineId={lines[12]!.id} />);

        const list = screen.tree.root.findAll((node) => (node.type as unknown) === 'LegendList')[0]!;
        expect(list.props.initialScrollIndex).toBeUndefined();
    });

    it('delegates nested token pointer offsets in UTF-16 and never activates removed diff lines', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: '😀 target' });
        const pointer = vi.fn();
        const activate = vi.fn();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} intelligence={{ onPointerToken: pointer, onActivateToken: activate }} />);
        const row = document.createElement('div');
        row.id = screen.tree.root.findAll(node => typeof node.props.nativeID === 'string' && node.props.nativeID.endsWith(`-${lines[0].id}`))[0].props.nativeID;
        const code = document.createElement('span');
        code.setAttribute('data-code-text', lines[0].id);
        code.innerHTML = '<span>😀 </span><span>target</span>';
        row.append(code);
        document.body.append(row);
        const target = code.lastElementChild!;
        // Only caret hit testing and geometry substitute browser layout; DOM spans/ranges stay real.
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: target.firstChild, offset: 2 }) });
        const geometry = vi.spyOn(code, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 200, 20));
        try {
            const list = screen.tree.root.findByType('LegendList');
            expect(list.props.onPointerMove).toEqual(expect.any(Function));
            list.props.onPointerMove({ target, clientX: 10, clientY: 20 });
            expect(pointer).toHaveBeenLastCalledWith(lines[0].id, 5, { x: 10, y: 10, width: 1, height: 20 }, 1);
            // Activation is covered through the real row press in CodeLinesView.touch.web.test.
            pointer.mockClear(); activate.mockClear();
            await screen.update(<CodeLinesViewCore lines={[{ ...lines[0], kind: 'remove', newLine: null }]} intelligence={{ onPointerToken: pointer, onActivateToken: activate }} />);
            const updated = screen.tree.root.findByType('LegendList');
            updated.props.onPointerMove({ target, clientX: 10, clientY: 20 });
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20, ctrlKey: true }));
            expect(pointer).not.toHaveBeenCalled();
            expect(activate).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            row.remove();
            geometry.mockRestore();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('completes a web drag range in an explicit interaction mode', async () => {
        const { CodeLinesView } = await import('./CodeLinesView.web');

        const onPressLineRange = vi.fn();
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'one',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:2',
                sourceIndex: 1, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 2,
                renderPrefixText: '',
                renderCodeText: 'two',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:3',
                sourceIndex: 2, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 3,
                renderPrefixText: '',
                renderCodeText: 'three',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ];

        const screen = await renderScreen(<CodeLinesView
            virtualized={false}
            interactionMode="commitSelection"
            lines={lines}
            onPressLineRange={onPressLineRange}
        />);

        const rows = await findCodeRows(screen.tree);
        const event = { preventDefault: vi.fn(), nativeEvent: { preventDefault: vi.fn() } };
        const onPressInLine = rows[0]!.props.onPressInLine;
        const onHoverLine = rows[2]!.props.onHoverLine;
        const onPressOutLine = rows[2]!.props.onPressOutLine;
        if (!onPressInLine || !onHoverLine || !onPressOutLine) throw new Error('Expected web drag-range interaction callbacks');
        onPressInLine(lines[0], event);
        onHoverLine(lines[2], event);
        onPressOutLine(lines[2], event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.nativeEvent.preventDefault).toHaveBeenCalled();
        expect(onPressLineRange).toHaveBeenCalledTimes(1);
        expect(onPressLineRange.mock.calls[0]?.[0].map((line: any) => line.id)).toEqual(['f:1', 'f:2', 'f:3']);
    });

    it('retries highlighter initialization after a cached failure', async () => {
        const { clearShikiCacheForKey } = await import('../highlighting/shiki/shikiTokenize');
        for (const [options] of createHighlighterSpy.mock.calls) {
            const themeId = options?.themes?.[0]?.name;
            if (typeof themeId === 'string') clearShikiCacheForKey(themeId);
        }
        createHighlighterSpy.mockReset();
        createHighlighterSpy
            .mockImplementationOnce(async () => {
                throw new Error('shiki_init_failed');
            })
            .mockImplementation(async () => ({
                loadLanguage: async () => {},
                codeToTokens: () => ({
                    fg: '#000',
                    tokens: [[{ content: 'const', color: '#f00' }]],
                }),
            }));

        const { CodeLinesView } = await import('./CodeLinesView.web');

        const view = (
            <CodeLinesView
                lines={[
                    {
                        id: 'f:1',
                        sourceIndex: 0, hunkIndex: null,
                        kind: 'file',
                        oldLine: null,
                        newLine: 1,
                        renderPrefixText: '',
                        renderCodeText: 'const x = 1;',
                        renderIsHeaderLine: false,
                        selectable: false,
                    },
                ]}
                syntaxHighlighting={{
                    mode: 'advanced',
                    language: 'typescript',
                    maxBytes: 1_000_000,
                    maxLines: 10_000,
                    maxLineLength: 10_000,
                }}
            />
        );

        const screen1 = await renderScreen(view);
        await flushReactAsyncWork();

        // Uses Happier themes instead of generic GitHub themes.
        expect(createHighlighterSpy.mock.calls[0]?.[0]?.themes?.[0]?.name).toMatch(/^happier-light-/);

        const calls1 = (await findCodeRows(screen1.tree)).map((row) => row.props);
        expect(calls1.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0)).toBe(false);

        renderer.act(() => {
            screen1.tree.unmount();
        });

        const screen2 = await renderScreen(view);
        await flushReactAsyncWork();

        const calls2 = (await findCodeRows(screen2.tree)).map((row) => row.props);
        expect(calls2.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0)).toBe(true);
        expect(createHighlighterSpy).toHaveBeenCalledTimes(2);

        expect(await findCodeRows(screen2.tree)).toHaveLength(1);
    });

    it('computes Shiki tokens when advanced syntax highlighting is enabled', async () => {
        createHighlighterSpy.mockClear();
        const { CodeLinesView } = await import('./CodeLinesView.web');

        const screen = await renderScreen(<CodeLinesView
                    lines={[
                        {
                            id: 'f:1',
                            sourceIndex: 0, hunkIndex: null,
                            kind: 'file',
                            oldLine: null,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    syntaxHighlighting={{
                        mode: 'advanced',
                        language: 'typescript',
                        maxBytes: 1_000_000,
                        maxLines: 10_000,
                        maxLineLength: 10_000,
                    }}
                />);

        // The row will be rendered at least once; after async tokenization, it should receive advancedTokens.
        let hasAdvanced = false;
        for (let i = 0; i < 10; i++) {
            // eslint-disable-next-line no-await-in-loop
            await flushReactAsyncWork();
            const calls = (await findCodeRows(screen.tree)).map((row) => row.props);
            if (calls.length === 0) continue;
            hasAdvanced = calls.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0);
            if (hasAdvanced) break;
        }
        expect(hasAdvanced).toBe(true);

        // Keep tree referenced to avoid act warnings about unmounted trees.
        expect(await findCodeRows(screen.tree)).toHaveLength(1);
    });
});
