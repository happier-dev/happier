// @vitest-environment jsdom

import React from 'react';
import renderer from 'react-test-renderer';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeDiffCommonModuleMocks } from '../codeDiffTestHelpers';
import { InitialPresentationReadinessProvider } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { buildDiffBlocks, buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { resolveCodeLineRangeSelection } from '@/components/ui/code/interactions/resolveCodeLineRangeSelection';
import { storage } from '@/sync/domains/state/storageStore';
import { BrowserWorker } from './pierreWorkerTestHelpers';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import type { CodeIntelligenceFallbackInput } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import type { DiffViewerProps } from '../diffViewerTypes';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fileDiffSpy = vi.fn();
const virtualizerSpy = vi.fn();
const realDomRenderer = vi.hoisted(() => ({ enabled: false }));

function resetSettingValues() {
    storage.setState({ settings: { ...storage.getState().settings,
        filesDiffTokenizationMaxLineLength: 1234,
        filesDiffIntraLineWordDiffEnabled: true,
        filesDiffIntraLineWordDiffMaxPatchLines: 3,
        filesDiffIntraLineWordDiffMaxLineLength: 987,
        filesDiffPresentationStyle: 'split',
    } });
}

resetSettingValues();

installCodeDiffCommonModuleMocks();

vi.mock('@pierre/diffs/react', async () => {
    const actual = await vi.importActual<any>('@pierre/diffs/react');
    return {
        ...actual,
        WorkerPoolContext: { Provider: ({ children }: any) => children },
        Virtualizer: ({ children, ...props }: any) => {
            virtualizerSpy();
            // Third-party scroll-container state must survive a patch refresh.
            const [scrollTop, setScrollTop] = React.useState(0);
            return React.createElement('Virtualizer', { ...props, scrollTop, onScroll: setScrollTop }, children);
        },
        FileDiff: (props: any) => {
            fileDiffSpy(props);
            if (realDomRenderer.enabled) return React.createElement(actual.FileDiff, props);
            return React.createElement('FileDiff', props);
        },
    };
});

function clickPierreHoverUtility(utility: any, nativeEvent: Record<string, unknown> = {}) {
    const clickEvent = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        nativeEvent: {
            stopImmediatePropagation: vi.fn(),
            ...nativeEvent,
        },
    };
    if (typeof utility?.props?.onClick === 'function') {
        utility.props.onClick(clickEvent);
        return;
    }
    utility?.props?.onPress?.(clickEvent);
    if (typeof utility?.props?.onPress === 'function') return;

    const rendered = renderer.create(utility);
    const button = rendered.root.findByType('button');
    button.props.onClick(clickEvent);
    rendered.unmount();
}

async function findPierreHoverUtilityButtonProps(utility: any): Promise<any> {
    if (utility?.type === 'button') return utility.props;
    let rendered!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
        rendered = renderer.create(utility);
    });
    const button = rendered.root.findByType('button');
    const props = button.props;
    await renderer.act(async () => {
        rendered.unmount();
    });
    return props;
}

function attachPierreClickCapture(screen: Awaited<ReturnType<typeof renderScreen>>, host: HTMLElement) {
    const wrapper = document.createElement('div');
    wrapper.append(host); document.body.append(wrapper);
    // React's DOM capture boundary; Pierre's body, event path and interaction manager remain real.
    wrapper.addEventListener('click', event => {
        const view = screen.findByTestId('pierre-diff-viewer');
        if (!view) throw new Error('Expected the mounted Pierre wrapper');
        view.props.onClickCapture?.({ nativeEvent: event });
    }, true);
    return () => wrapper.remove();
}

// Load the real runtime graph after installing its boundaries, before behavior deadlines begin.
await import('./PierreDiffViewer.web');
const { FileContentPanel } = await import('@/components/workspaces/files/file/FileContentPanel');

describe('PierreDiffViewer (web)', () => {
    it('keeps the actual syntax token mounted through a focus-driven compatibility mousedown repaint and consumes current callbacks', async () => {
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const activate = vi.fn(() => true), beforeFocus = vi.fn(), afterFocus = vi.fn();
        function FocusedChanges({ name = 'target', note = true }: { name?: string; note?: boolean }) {
            const [focused, setFocused] = React.useState(false);
            return <div onMouseDownCapture={() => setFocused(true)}><PierreDiffViewer mode="unified" virtualized={false}
                unifiedDiff={`--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before();\n+${name}();\n`}
                interactionMode="commitSelection" onPressLine={focused ? afterFocus : beforeFocus} onPressLineRange={() => {}}
                renderAfterLine={line => note && line.kind === 'add' ? <button onClick={event => {
                    event.stopPropagation(); (focused ? afterFocus : beforeFocus)('annotation');
                }}>{focused ? 'current note' : 'initial note'}</button> : null}
                intelligence={{ onPointerToken: () => {}, onActivateToken: activate }} /></div>;
        }
        const host = document.createElement('div'); document.body.append(host);
        const root = createRoot(host);
        const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        realDomRenderer.enabled = true;
        try {
            await React.act(async () => root.render(<FocusedChanges />));
            await vi.waitFor(() => expect([...host.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line-type="change-addition"] span') ?? []].some(span => span.textContent === 'target')).toBe(true));
            const body = host.querySelector('diffs-container')!;
            const token = [...body.shadowRoot!.querySelectorAll('[data-line-type="change-addition"] span')].find(span => span.textContent === 'target')!;
            Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: token.firstChild, offset: 3 }) });
            const pointer = (type: string) => {
                const event = new MouseEvent(type, { bubbles: true, composed: true, clientX: 42, clientY: 22 });
                Object.defineProperty(event, 'pointerType', { value: 'touch' }); token.dispatchEvent(event);
            };
            await React.act(async () => { pointer('pointerdown'); pointer('pointerup'); });
            await React.act(async () => { token.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true })); });
            // A browser cannot synthesize the click after this target is removed between mousedown/up.
            expect(token.isConnected).toBe(true);
            expect(body.textContent).toContain('current note');
            await React.act(async () => { token.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true })); token.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });
            expect(activate).toHaveBeenCalledExactlyOnceWith(expect.any(String), 3, expect.objectContaining({ via: 'touch' }), 1);
            expect(beforeFocus).not.toHaveBeenCalled(); expect(afterFocus).not.toHaveBeenCalled();
            await React.act(async () => { token.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });
            expect(afterFocus).toHaveBeenCalledTimes(1); expect(beforeFocus).not.toHaveBeenCalled();
            await React.act(async () => { body.querySelector('button')!.click(); });
            expect(afterFocus).toHaveBeenLastCalledWith('annotation'); expect(beforeFocus).not.toHaveBeenCalled();
            await React.act(async () => root.render(<FocusedChanges name="updatedName" />));
            await vi.waitFor(() => expect(host.querySelector('diffs-container')!.shadowRoot!.textContent).toContain('updatedName'));
            expect(token.isConnected).toBe(false);
            await React.act(async () => root.render(<FocusedChanges name="updatedName" note={false} />));
            expect(host.textContent).not.toContain('current note');
        } finally {
            await React.act(async () => root.unmount()); host.remove(); realDomRenderer.enabled = false;
            if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
            else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('commits a real shadow-row touch on click before line selection, while gutter and cancelled selection gestures remain owned by Pierre', async () => {
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const { FileDiff } = await import('@pierre/diffs');
        const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before();\n+target();\n';
        const activate = vi.fn(() => true), select = vi.fn(), range = vi.fn();
        const screen = await renderScreen(<PierreDiffViewer mode="unified" unifiedDiff={patch} interactionMode="commitSelection"
            onPressLine={select} onPressLineRange={range} intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />);
        const body = screen.findAllByType('FileDiff')[0]!;
        const instance = new FileDiff<React.ReactNode, undefined>({ ...body.props.options, theme: 'pierre-light', unsafeCSS: undefined });
        const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
        Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        const host = document.createElement('diffs-container');
        const detach = attachPierreClickCapture(screen, host);
        const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        const dispatch = (type: string, target: Element) => {
            const event = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: 42, clientY: 22 });
            Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: 1 } });
            target.dispatchEvent(event);
        };
        try {
            instance.hydrate({ fileDiff: body.props.fileDiff, fileContainer: host });
            await vi.waitFor(() => expect(shadow.querySelector('[data-line="1"][data-line-type="change-addition"] span')).not.toBeNull());
            const code = shadow.querySelector('[data-line="1"][data-line-type="change-addition"]')!;
            const token = [...code.querySelectorAll('span')].find(span => span.textContent === 'target')!;
            Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: token.firstChild, offset: 3 }) });
            await renderer.act(async () => { dispatch('pointerdown', token); dispatch('pointerup', token); });
            expect(activate).not.toHaveBeenCalled();
            // A cold language-server publication repaints the same body before the compatibility click.
            await screen.update(<PierreDiffViewer mode="unified" unifiedDiff={patch} interactionMode="commitSelection"
                onPressLine={select} onPressLineRange={range} intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />);
            await renderer.act(async () => { dispatch('click', token); });
            expect(activate).toHaveBeenCalledExactlyOnceWith(expect.any(String), 3, expect.objectContaining({ via: 'touch' }), 1);
            expect(select).not.toHaveBeenCalled();
            expect(range).not.toHaveBeenCalled();
            activate.mockReturnValue(false);
            await renderer.act(async () => { dispatch('pointerdown', token); dispatch('pointerup', token); dispatch('click', token); });
            expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ newLine: 1 }));
            select.mockClear(); activate.mockReturnValue(true);
            activate.mockClear();
            // A platform text-selection cancellation must never turn its later release/click into a name tap.
            await renderer.act(async () => { dispatch('pointerdown', token); dispatch('contextmenu', token); dispatch('pointerup', token); dispatch('click', token); });
            expect(activate).not.toHaveBeenCalled();
            const gutter = shadow.querySelector('[data-column-number="1"][data-line-type="change-addition"]')!;
            await renderer.act(async () => { dispatch('pointerdown', gutter); dispatch('pointerup', gutter); dispatch('click', gutter); });
            expect(activate).not.toHaveBeenCalled();
            expect(range.mock.calls.some(([lines]) => lines.some((line: { newLine: number | null }) => line.newLine === 1))).toBe(true);
        } finally {
            await screen.unmount(); instance.cleanUp(); detach();
            if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
            else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('keeps real Changes identifier selection through subscribed parent repaints and definition navigation', async () => {
        storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'pierre' } });
        const source = ['export function delayFor() {}', '', '', '', '', '', '', 'delayFor(1);'].join('\n');
        const patch = '--- a/retry.ts\n+++ b/retry.ts\n@@ -8 +8 @@\n-oldDelay(1);\n+delayFor(1);\n';
        const query = vi.fn(async (_input: CodeIntelligenceFallbackInput) => ({ status: 'ok' as const, source: 'text_matches' as const, coverage: 'complete' as const, hasMore: false,
            locations: [{ path: 'retry.ts', range: { start: { line: 0, character: 16 }, end: { line: 0, character: 24 } }, lineText: 'export function delayFor() {}' }] }));
        const opened: string[] = [];
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'retry.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => source, query, openLocation: location => { opened.push(`${location.path}:${location.range.start.line + 1}`); },
        });
        const screen = await renderScreen(<FileContentPanel theme={createThemeFixture()} displayMode="diff" sessionId="session"
            filePath="retry.ts" diffContent={patch} fileContent={source} language="typescript" selectedLineKeys={new Set()}
            lineSelectionEnabled={false} onToggleLine={() => {}} intelligence={{
                onPointer: (line, character, anchor) => controller.inspect({ line: line - 1, character, ...(anchor ? { anchor } : {}) }),
                onPointerAway: () => controller.inspect(null),
                onActivate: (line, character) => { void controller.definition({ line: line - 1, character }); return true; },
                getDiagnosticsByLine: () => undefined, subscribeDiagnostics: controller.subscribe,
            }} />);
        await vi.dynamicImportSettled();
        await renderer.act(async () => {});
        // Vitest resolves the portable DiffViewer entry; consume the real panel's renderer props at
        // the web platform seam rather than mocking either the panel or its intelligence callbacks.
        const panelProps = screen.tree.root.findAll(node => node.props.mode === 'unified' && node.props.unifiedDiff === patch)[0].props;
        if (panelProps.mode !== 'unified' || typeof panelProps.unifiedDiff !== 'string') {
            throw new Error('The real FileContentPanel must bind a unified diff');
        }
        const diffProps: DiffViewerProps = { ...panelProps, mode: 'unified', unifiedDiff: panelProps.unifiedDiff };
        const intelligence = diffProps.intelligence;
        if (!intelligence) throw new Error('The real FileContentPanel must bind Changes intelligence');
        const { onPointerToken, onActivateToken } = intelligence;
        if (!onPointerToken || !onActivateToken) throw new Error('The real Changes intelligence must bind pointer and activation');
        const boundIntelligence = { ...intelligence, onPointerToken, onActivateToken };
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        function SubscribedChanges() {
            React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            // A parent commit may refresh the binding even though the pointer did not move.
            return <PierreDiffViewer {...diffProps} intelligence={{ ...boundIntelligence }} />;
        }
        const webScreen = await renderScreen(<SubscribedChanges />);
        const body = webScreen.findAllByType('FileDiff')[0];
        expect(body).toBeDefined();
        const { FileDiff } = await import('@pierre/diffs');
        // JSDOM cannot parse CSS @layer; painting is a live-browser check, not this position contract.
        const instance = new FileDiff<React.ReactNode, undefined>({ ...body.props.options, theme: 'pierre-light', unsafeCSS: undefined });
        // JSDOM omits constructed stylesheet replacement (same platform fixture as Pierre's DOM tests).
        const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
        Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        const host = document.createElement('diffs-container');
        const detach = attachPierreClickCapture(webScreen, host);
        const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        try {
            instance.hydrate({ fileDiff: body.props.fileDiff, fileContainer: host });
            await vi.waitFor(() => expect([...root.querySelectorAll('[data-line="8"][data-line-type="change-addition"] span')]
                .some(span => span.textContent === 'delayFor')).toBe(true));
            const addition = root.querySelector('[data-line="8"][data-line-type="change-addition"]')!;
            const name = [...addition.querySelectorAll('span')].find(span => span.textContent === 'delayFor')!;
            const text = name.firstChild!;
            Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: text, offset: 3 }) });
            await renderer.act(async () => {
                name.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, composed: true, clientX: 42, clientY: 22 }));
            });
            expect(controller.getSnapshot().selection).toMatchObject({ position: { line: 7, character: 3 }, identifier: { symbol: 'delayFor' } });
            await renderer.act(async () => {
                name.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ctrlKey: true, clientX: 42, clientY: 22 }));
            });
            await vi.waitFor(() => expect(opened).toEqual(['retry.ts:1']));
            expect(query.mock.calls[0]?.[0]).toMatchObject({ kind: 'definition', line: 8, symbol: 'delayFor' });
            await renderer.act(async () => {
                name.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, composed: true, relatedTarget: document.body }));
            });
            expect(controller.getSnapshot().selection).toBeNull();
        } finally {
            await webScreen.unmount();
            await screen.unmount();
            controller.dispose();
            instance.cleanUp();
            detach();
            if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
            else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('resolves expanded text-comparison context through the existing new-file row coordinates', async () => {
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const { FileDiff } = await import('@pierre/diffs');
        const newText = 'expandedName\ncontext\ncontext\ncontext\nafter\n';
        const expectedLine = buildCodeLinesFromFile({ text: newText })[0]!;
        const activate = vi.fn(() => true);
        const screen = await renderScreen(<PierreDiffViewer mode="text" contextLines={1}
            oldText={newText.replace('after', 'before')} newText={newText}
            intelligence={{ onPointerToken: () => {}, onActivateToken: activate }} />);
        const host = document.createElement('div');
        const detach = attachPierreClickCapture(screen, host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<code data-code data-unified><div data-line-type="context-expanded" data-line="1"><span>expandedName</span></div></code>';
        const text = root.querySelector('span')!.firstChild!;
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: text, offset: 3 }) });
        const instance = new FileDiff<React.ReactNode, undefined>();
        try {
            await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
            text.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, metaKey: true, clientX: 10, clientY: 10 }));
            expect(activate).toHaveBeenCalledExactlyOnceWith(expectedLine.id, 3, { via: 'modifier', rect: { x: 10, y: 0, width: 1, height: 0 } }, 1);
        } finally {
            await screen.unmount();
            detach();
            instance.cleanUp();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('binds new-side shadow text to the shared intelligence and owns only its diagnostic ranges', async () => {
        const highlights = new Map<string, Set<Range>>();
        vi.stubGlobal('CSS', { highlights });
        vi.stubGlobal('Highlight', class extends Set<Range> {});
        const pointer = vi.fn();
        const activate = vi.fn(() => true);
        const away = vi.fn();
        const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -4,2 +9,2 @@\n abc😀name\n-before\n+after\n';
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true });
        const context = lines.find(line => line.kind === 'context')!;
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const intelligence = { onPointerToken: pointer, onActivateToken: activate, onPointerAway: away,
            diagnosticsByNewLine: new Map([[9, [{ start: 5, end: 9, severity: 'error' as const }]]]) };
        const screen = await renderScreen(<PierreDiffViewer mode="unified" unifiedDiff={patch} intelligence={intelligence} />);
        const host = document.createElement('div');
        const detach = attachPierreClickCapture(screen, host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<code data-code data-deletions><div data-line-type="context" data-line="4">abc😀name</div><div data-line-type="change-deletion" data-line="5">before</div></code><code data-code data-additions><div data-line-type="context" data-line="9"><span>abc😀</span><span>name</span></div><div data-line-type="change-addition" data-line="10">after</div></code>';
        const code = root.querySelector('[data-additions] [data-line="9"]')!;
        const token = code.lastChild!;
        const geometry = vi.spyOn(code, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 200, 24));
        // Caret hit testing is a browser layout boundary; the text nodes/UTF-16 range are real.
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        const caret = vi.fn(() => ({ offsetNode: token.firstChild, offset: 2 }));
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: caret });
        try {
            const { FileDiff } = await import('@pierre/diffs');
            const instance = new FileDiff<React.ReactNode, undefined>();
            await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
            await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
            token.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 42, clientY: 22 }));
            expect(pointer).toHaveBeenLastCalledWith(context.id, 7, { x: 42, y: 20, width: 1, height: 24 }, 9);
            expect(caret).toHaveBeenLastCalledWith(42, 22, { shadowRoots: [root] });
            token.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ctrlKey: true, button: 2, clientX: 42, clientY: 22 }));
            expect(activate).not.toHaveBeenCalled();
            const click = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, ctrlKey: true, button: 0, clientX: 42, clientY: 22 });
            token.dispatchEvent(click);
            expect(click.defaultPrevented).toBe(true);
            expect(activate).toHaveBeenCalledExactlyOnceWith(context.id, 7, { via: 'modifier', rect: { x: 42, y: 20, width: 1, height: 24 } }, 9);
            const old = root.querySelector('[data-deletions] [data-line="4"]')!;
            old.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 42, clientY: 22 }));
            old.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ctrlKey: true, clientX: 42, clientY: 22 }));
            root.querySelector('[data-line-type="change-deletion"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ctrlKey: true, clientX: 42, clientY: 22 }));
            expect(pointer).toHaveBeenCalledTimes(1);
            expect(activate).toHaveBeenCalledTimes(1);
            expect(away).toHaveBeenCalled();
            expect([...highlights.get('happier-diagnostic-error') ?? []].map(range => range.toString())).toEqual(['name']);
            const second = await renderScreen(<PierreDiffViewer mode="unified" unifiedDiff={patch} intelligence={intelligence} />);
            const otherHost = host.cloneNode() as HTMLElement;
            const otherRoot = otherHost.attachShadow({ mode: 'open' });
            otherRoot.innerHTML = root.innerHTML;
            await renderer.act(async () => { second.findAllByType('FileDiff')[0].props.options.onPostRender(otherHost, instance); });
            expect(highlights.get('happier-diagnostic-error')?.size).toBe(2);
            await screen.unmount();
            expect(highlights.get('happier-diagnostic-error')?.size).toBe(1);
            token.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 42, clientY: 22 }));
            expect(pointer).toHaveBeenCalledTimes(1);
            await second.unmount();
            detach();
            expect(highlights.size).toBe(0);
            instance.cleanUp();
        } finally {
            geometry.mockRestore();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('reveals an offscreen line through the plain virtualizer using the file offset', async () => {
        fileDiffSpy.mockClear();
        const { VirtualizedFileDiff, Virtualizer } = await import('@pierre/diffs');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).find(line => line.kind === 'add')!;
        const virtualizer = new Virtualizer();
        const instance = new VirtualizedFileDiff<React.ReactNode, undefined>({}, virtualizer);
        // Geometry/reveal methods are the external renderer's DOM boundary.
        const reveal = vi.spyOn(instance, 'revealLine').mockReturnValueOnce(true).mockReturnValue(false);
        vi.spyOn(instance, 'getLinePosition').mockReturnValue({ top: 400, height: 20 });
        vi.spyOn(virtualizer, 'getOffsetInScrollContainer').mockReturnValue(120);
        const scroll = vi.spyOn(virtualizer, 'scrollTo').mockImplementation(() => {});
        const screen = await renderScreen(<PierreDiffViewer mode="unified" unifiedDiff={patch} scrollToLineId={target.id} />);
        const body = screen.findAllByType('FileDiff')[0];
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        await renderer.act(async () => { body.props.options.onPostRender(host, instance); });
        expect(reveal).toHaveBeenCalledWith(1);
        expect(scroll).not.toHaveBeenCalled();
        // The renderer owns the virtualizer context; feed its real context at the paint boundary.
        const context = (await import('@pierre/diffs/react')).VirtualizerContext;
        await screen.update(<context.Provider value={virtualizer}><PierreDiffViewer mode="unified" unifiedDiff={patch} scrollToLineId={target.id} /></context.Provider>);
        const updated = screen.findAllByType('FileDiff')[0];
        root.innerHTML = '<code data-unified><div data-line-type="change-addition" data-line="1">after</div></code>';
        await renderer.act(async () => { updated.props.options.onPostRender(host, instance); });
        expect(scroll).toHaveBeenCalledWith({ top: 520 });
        instance.cleanUp();
        virtualizer.cleanUp();
    });
    it('lands a mounted Find match on its own row, centered in whichever scroller holds the diff', async () => {
        fileDiffSpy.mockClear();
        const { VirtualizedFileDiff, Virtualizer } = await import('@pierre/diffs');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).find(line => line.kind === 'add')!;
        const virtualizer = new Virtualizer();
        const instance = new VirtualizedFileDiff<React.ReactNode, undefined>({}, virtualizer);
        vi.spyOn(instance, 'revealLine').mockReturnValue(false);
        vi.spyOn(instance, 'getLinePosition').mockReturnValue({ top: 400, height: 20 });
        vi.spyOn(virtualizer, 'getOffsetInScrollContainer').mockReturnValue(120);
        const scrollRoot = document.createElement('div');
        Object.defineProperty(scrollRoot, 'clientHeight', { value: 600 });
        vi.spyOn(virtualizer, 'getRoot').mockReturnValue(scrollRoot);
        const scroll = vi.spyOn(virtualizer, 'scrollTo').mockImplementation(() => {});
        const context = (await import('@pierre/diffs/react')).VirtualizerContext;
        const screen = await renderScreen(<context.Provider value={virtualizer}>
            <PierreDiffViewer mode="unified" unifiedDiff={patch} findActive scrollToLineId={target.id}
                {...({ findRangesByLineId: new Map([[target.id, [{ start: 0, end: 5, current: true }]]]) })} />
        </context.Provider>);
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<code data-unified><div data-line-type="change-addition" data-line="1">after</div></code>';
        const row = root.querySelector<HTMLElement>('[data-line="1"]');
        if (row) row.scrollIntoView = vi.fn();
        await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
        // Pierre's offset for an unmeasured (wrapped) row can be far off: a mounted row is landed on itself.
        expect(row!.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
        expect(scroll).not.toHaveBeenCalled();
        instance.cleanUp();
        virtualizer.cleanUp();
    });
    it('lands a mounted go-to-change row the same way as Find', async () => {
        fileDiffSpy.mockClear();
        const { VirtualizedFileDiff, Virtualizer } = await import('@pierre/diffs');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).find(line => line.kind === 'add')!;
        const virtualizer = new Virtualizer();
        const instance = new VirtualizedFileDiff<React.ReactNode, undefined>({}, virtualizer);
        vi.spyOn(instance, 'revealLine').mockReturnValue(false);
        vi.spyOn(instance, 'getLinePosition').mockReturnValue({ top: 400, height: 20 });
        vi.spyOn(virtualizer, 'getOffsetInScrollContainer').mockReturnValue(120);
        const scrollRoot = document.createElement('div');
        Object.defineProperty(scrollRoot, 'clientHeight', { value: 600 });
        vi.spyOn(virtualizer, 'getRoot').mockReturnValue(scrollRoot);
        const scroll = vi.spyOn(virtualizer, 'scrollTo').mockImplementation(() => {});
        const context = (await import('@pierre/diffs/react')).VirtualizerContext;
        const screen = await renderScreen(<context.Provider value={virtualizer}>
            <PierreDiffViewer mode="unified" unifiedDiff={patch} scrollToLineId={target.id}
                {...({})} />
        </context.Provider>);
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<code data-unified><div data-line-type="change-addition" data-line="1">after</div></code>';
        const row = root.querySelector<HTMLElement>('[data-line="1"]');
        if (row) row.scrollIntoView = vi.fn();
        await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
        // Pierre's offset for an unmeasured (wrapped) row can be far off: a mounted row is landed on itself.
        expect(row!.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
        expect(scroll).not.toHaveBeenCalled();
        instance.cleanUp();
        virtualizer.cleanUp();
    });
    it('brings an unmounted Find match into view mid-viewport through the virtualizer', async () => {
        fileDiffSpy.mockClear();
        const { VirtualizedFileDiff, Virtualizer } = await import('@pierre/diffs');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).find(line => line.kind === 'add')!;
        const virtualizer = new Virtualizer();
        const instance = new VirtualizedFileDiff<React.ReactNode, undefined>({}, virtualizer);
        vi.spyOn(instance, 'revealLine').mockReturnValue(false);
        vi.spyOn(instance, 'getLinePosition').mockReturnValue({ top: 400, height: 20 });
        vi.spyOn(virtualizer, 'getOffsetInScrollContainer').mockReturnValue(120);
        const scrollRoot = document.createElement('div');
        Object.defineProperty(scrollRoot, 'clientHeight', { value: 600 });
        vi.spyOn(virtualizer, 'getRoot').mockReturnValue(scrollRoot);
        const scroll = vi.spyOn(virtualizer, 'scrollTo').mockImplementation(() => {});
        const context = (await import('@pierre/diffs/react')).VirtualizerContext;
        const screen = await renderScreen(<context.Provider value={virtualizer}>
            <PierreDiffViewer mode="unified" unifiedDiff={patch} findActive scrollToLineId={target.id}
                {...({ findRangesByLineId: new Map([[target.id, [{ start: 0, end: 5, current: true }]]]) })} />
        </context.Provider>);
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<code data-unified></code>';
        const row = root.querySelector<HTMLElement>('[data-line="1"]');
        if (row) row.scrollIntoView = vi.fn();
        await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
        // 120 (file offset) + 400 (line) - (600 viewport - 20 line) / 2; the row then lands on itself once mounted.
        expect(scroll).toHaveBeenCalledWith({ top: 230 });
        instance.cleanUp();
        virtualizer.cleanUp();
    });
    it('lands a reveal requested during a virtualizer render after that pass restores its scroll anchor', async () => {
        fileDiffSpy.mockClear();
        const { VirtualizedFileDiff, Virtualizer } = await import('@pierre/diffs');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).find(line => line.kind === 'add')!;
        const virtualizer = new Virtualizer();
        const instance = new VirtualizedFileDiff<React.ReactNode, undefined>({}, virtualizer);
        // Geometry, reveal and scrolling are the external renderer's DOM boundary.
        vi.spyOn(instance, 'revealLine').mockReturnValue(false);
        vi.spyOn(instance, 'getLinePosition').mockReturnValue({ top: 400, height: 20 });
        vi.spyOn(virtualizer, 'getOffsetInScrollContainer').mockReturnValue(120);
        let scrollTop = 0;
        vi.spyOn(virtualizer, 'scrollTo').mockImplementation(({ top }) => { scrollTop = top; });
        const context = (await import('@pierre/diffs/react')).VirtualizerContext;
        const screen = await renderScreen(<context.Provider value={virtualizer}>
            <PierreDiffViewer mode="unified" unifiedDiff={patch} scrollToLineId={target.id} /></context.Provider>);
        const host = document.createElement('div');
        host.attachShadow({ mode: 'open' }).innerHTML = '<code data-unified><div data-line-type="change-addition" data-line="1">after</div></code>';
        // A Keep re-renders the rows and moves the target in the same pass: the virtualizer captures its
        // scroll anchor, paints (onPostRender) and then restores that anchor before the pass ends.
        await renderer.act(async () => {
            const anchor = scrollTop;
            screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance);
            scrollTop = anchor;
        });
        expect(scrollTop).toBe(520);
        instance.cleanUp();
        virtualizer.cleanUp();
    });
    it('leaves the reader in control after a landed change is repainted', async () => {
        fileDiffSpy.mockClear();
        const { VirtualizedFileDiff, Virtualizer } = await import('@pierre/diffs');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).find(line => line.kind === 'add')!;
        const virtualizer = new Virtualizer();
        const instance = new VirtualizedFileDiff<React.ReactNode, undefined>({}, virtualizer);
        // Geometry, reveal and scrolling are the external renderer's DOM boundary.
        const scroller = document.createElement('div');
        Object.defineProperty(scroller, 'scrollHeight', { value: 950 });
        Object.defineProperty(scroller, 'clientHeight', { value: 241 });
        vi.spyOn(instance, 'revealLine').mockReturnValue(false);
        vi.spyOn(instance, 'getLinePosition').mockReturnValue({ top: 400, height: 20 });
        vi.spyOn(virtualizer, 'getOffsetInScrollContainer').mockReturnValue(120);
        vi.spyOn(virtualizer, 'scrollTo').mockImplementation(({ top }) => { scroller.scrollTop = top; });
        const context = (await import('@pierre/diffs/react')).VirtualizerContext;
        const screen = await renderScreen(<context.Provider value={virtualizer}>
            <PierreDiffViewer mode="unified" unifiedDiff={patch} scrollToLineId={target.id} /></context.Provider>);
        const host = document.createElement('div');
        host.attachShadow({ mode: 'open' }).innerHTML = '<code data-unified><div data-line-type="change-addition" data-line="1">after</div></code>';
        scroller.append(host);
        document.body.append(scroller);
        const paint = () => renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
        await paint();
        expect(scroller.scrollTop).toBe(520);
        // Paint-only review updates preserve geometry (real-renderer coverage lives beside this suite).
        // A later repaint must not treat the retained reveal as a command to undo a reader's scroll.
        host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -400 }));
        scroller.scrollTop = 300;
        await paint();
        expect(scroller.scrollTop).toBe(300);
        await screen.unmount();
        scroller.remove();
        instance.cleanUp();
        virtualizer.cleanUp();
    });
    it('leaves the reader in control once the annotation is mounted even when its code line is virtualized away', async () => {
        const { VirtualizedFileDiff, Virtualizer } = await import('@pierre/diffs');
        const { VirtualizerContext } = await import('@pierre/diffs/react');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).find(line => line.kind === 'remove')!;
        const virtualizer = new Virtualizer();
        const instance = new VirtualizedFileDiff<React.ReactNode, undefined>({}, virtualizer);
        // The mounted annotation is taller than the viewport; its following code is not mounted.
        // Geometry and scroll are browser/third-party ports, with the real adapter below them.
        vi.spyOn(instance, 'getLinePosition').mockReturnValue({ top: 400, height: 20 });
        vi.spyOn(virtualizer, 'getOffsetInScrollContainer').mockReturnValue(120);
        let scrollTop = 0;
        vi.spyOn(virtualizer, 'scrollTo').mockImplementation(({ top }) => { scrollTop = top; });
        const screen = await renderScreen(<VirtualizerContext.Provider value={virtualizer}>
            <PierreDiffViewer mode="unified" unifiedDiff={patch} hunks={{}} scrollToLineId={target.id}
                renderAfterLine={line => line.renderIsHeaderLine ? <div>Change</div> : null} />
        </VirtualizerContext.Provider>);
        const host = document.createElement('div');
        host.attachShadow({ mode: 'open' });
        const annotation = document.createElement('div');
        annotation.slot = instance.getAnnotationSlotName({ side: 'additions', lineNumber: 0 });
        host.append(annotation); document.body.append(host);
        vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 300, 1000));
        vi.spyOn(annotation, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 300, 330));
        const paint = () => renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(host, instance); });
        try {
            await paint();
            expect(scrollTop).toBe(120);
            scrollTop = 300;
            await paint();
            expect(scrollTop).toBe(300);
        } finally {
            await screen.unmount(); host.remove(); instance.cleanUp(); virtualizer.cleanUp();
        }
    });
    it('maps a reversed cross-side range through the same row selection as the Happier renderer', async () => {
        fileDiffSpy.mockClear();
        const onPressLineRange = vi.fn();
        const onPressLine = vi.fn();
        const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -4,3 +9,3 @@\n context\n-before\n+after\n tail\n';
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true });
        const before = lines.find(line => line.kind === 'remove')!;
        const after = lines.find(line => line.kind === 'add')!;
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const screen = await renderScreen(<PierreDiffViewer mode="unified" unifiedDiff={patch} interactionMode="commitSelection"
            selectedLineIds={new Set([before.id, after.id])} onPressLineRange={onPressLineRange} onPressLine={onPressLine} />);
        const call = fileDiffSpy.mock.calls.at(-1)?.[0];
        expect(call.options.enableLineSelection).toBe(true);
        expect(call.options.controlledSelection).toBe(true);
        expect(call.selectedLines).toEqual({ start: 5, side: 'deletions', end: 10, endSide: 'additions' });
        await renderer.act(async () => {
            call.options.onLineSelected({ start: 10, side: 'additions', end: 5, endSide: 'deletions' });
        });
        expect(onPressLineRange.mock.calls[0]?.[0]).toEqual(resolveCodeLineRangeSelection({
            lines, startLineId: after.id, endLineId: before.id,
        }));
        await renderer.act(async () => { call.options.onLineSelected(null); });
        expect(onPressLineRange).toHaveBeenCalledTimes(1);
        call.options.onLineClick({ annotationSide: 'additions', lineNumber: 10, lineType: 'change-addition', numberColumn: true });
        expect(onPressLine).not.toHaveBeenCalled();
        const contexts = lines.filter(line => line.kind === 'context');
        await screen.update(<PierreDiffViewer mode="unified" unifiedDiff={patch} interactionMode="commitSelection"
            selectedLineIds={new Set(contexts.map(line => line.id))} onPressLineRange={onPressLineRange} />);
        expect(fileDiffSpy.mock.calls.at(-1)?.[0].selectedLines).toBeNull();
    });
    it('uses the surface evidence fallback if the external renderer fails', async () => {
        fileDiffSpy.mockImplementation(() => { throw new Error('renderer failed'); });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
            const screen = await renderScreen(<PierreDiffViewer mode="unified" filePath="a.ts"
                errorFallback={<div data-testid="evidence-unavailable">Evidence unavailable</div>}
                unifiedDiff={'--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n'} />);
            expect(screen.findAllByProps({ 'data-testid': 'evidence-unavailable' })).toHaveLength(1);
        } finally {
            fileDiffSpy.mockReset();
            error.mockRestore();
        }
    });
    it('preserves the final blank context row of a selected hunk without parser diagnostics', async () => {
        fileDiffSpy.mockClear();
        const error = vi.spyOn(console, 'error');
        try {
            const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
            await renderScreen(<PierreDiffViewer mode="unified" filePath="src/a.ts" unifiedDiff={[
                'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
                '@@ -1,2 +1,2 @@', '-before', '+after', '  ',
            ].join('\n')} />);
            const patch = fileDiffSpy.mock.calls.at(-1)?.[0].fileDiff;
            expect(patch?.additionLines).toEqual(['after\n', ' \n']);
            expect(error.mock.calls.filter((call) => String(call[0]).includes('invalid rawLine'))).toEqual([]);
        } finally {
            error.mockRestore();
        }
    });
    it('preserves a review-comment diff from Markdown through the file model to Pierre', async () => {
        fileDiffSpy.mockClear();
        const screen = await renderScreen(<React.Fragment />);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
            // Same shape as PR #657 discussion_r4359357458: the final context row is blank.
            const markdown = '```diff\n--- "a/routing.mdx"\n+++ "b/routing.mdx"\n'
                + '@@ -47,3 +47,3 @@\n-Automatic permission responses require an updated CLI.\n'
                + '+Older actions open the session for review.\n User-action requests include cases such as:\n \n```';
            const block = parseMarkdown(markdown).find((entry) => entry.type === 'code-block');
            if (block?.type !== 'code-block') throw new Error('Expected fenced review evidence');
            const [file] = buildDiffFileEntries(buildDiffBlocks({ unified_diff: block.content }));
            await screen.update(<PierreDiffViewer mode="unified" unifiedDiff={file!.unifiedDiff!} />);
            expect(fileDiffSpy.mock.calls.at(-1)?.[0].fileDiff).toBeTruthy();
            expect(error).not.toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });
    it('renders a hunk-only snippet without logging a parser diagnostic', async () => {
        fileDiffSpy.mockClear();
        // Renderer creation reports its SDK deprecation; observe the actual diff update separately.
        const screen = await renderScreen(<React.Fragment />);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
            await screen.update(<PierreDiffViewer mode="unified" unifiedDiff={'@@ -1 +1 @@\n-before\n+after\n'} />);
            // A hunk without a file prelude keeps its source visible through the owner's fallback.
            const snippet = screen.findByProps({ 'data-testid': 'pierre-diff-fallback' });
            expect(snippet.children.join('')).toContain('-before\n+after');
            expect(error).not.toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });
    it('keeps an incomplete hunk local without a parser diagnostic, then recovers on complete evidence', async () => {
        fileDiffSpy.mockClear();
        const screen = await renderScreen(<React.Fragment />);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
            // PR #657's first API hunk, with its final context row missing.
            const partial = '--- a/activityNotificationEvent.ts\n+++ b/activityNotificationEvent.ts\n'
                + '@@ -12,6 +12,7 @@ export type ActivityNotificationEvent =\n'
                + '     sessionTitle?: string | null;\n     agentDisplayName?: string | null;\n'
                + '     requestId: string;\n+    occurrenceId?: string;\n     toolName: string;\n     toolInput?: unknown;\n';
            await screen.update(<PierreDiffViewer mode="unified" filePath="activityNotificationEvent.ts"
                errorFallback={<div data-testid="evidence-unavailable">Evidence unavailable</div>} unifiedDiff={partial} />);
            expect(screen.findAllByProps({ 'data-testid': 'evidence-unavailable' })).toHaveLength(1);
            expect(error).not.toHaveBeenCalled();
            expect(fileDiffSpy).not.toHaveBeenCalled();
            await screen.update(<PierreDiffViewer mode="unified" filePath="activityNotificationEvent.ts"
                unifiedDiff={partial + '     toolDetails?: string | null;\n'} />);
            expect(fileDiffSpy.mock.calls.at(-1)?.[0].fileDiff).toBeTruthy();
        } finally {
            error.mockRestore();
        }
    });
    it('retains complete source for expandable text comparisons', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const oldText = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
        await renderScreen(<PierreDiffViewer mode="text" filePath="a.txt" oldText={oldText}
            newText={oldText.replace('line 20', 'changed 20')} contextLines={3} />);
        expect(fileDiffSpy.mock.calls.at(-1)?.[0]?.fileDiff.isPartial).toBe(false);
    });
    beforeEach(() => {
        resetSettingValues();
        vi.stubGlobal('Worker', BrowserWorker);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('uses an exact content-sensitive cache key for initial presentation terminality', async () => {
        const { buildPierreInitialPresentationCacheKey } = await import('./pierreInitialPresentation.web');
        const first = buildPierreInitialPresentationCacheKey({
            fileName: 'src/a.ts',
            language: 'typescript',
            patch: '@@ -1 +1 @@\n-a\n+b',
        });
        const second = buildPierreInitialPresentationCacheKey({
            fileName: 'src/a.ts',
            language: 'typescript',
            patch: '@@ -1 +1 @@\n-a\n+c',
        });

        expect(first).not.toBe(second);
        expect(first).toMatch(/^happier-pierre-diff:v1:[0-9a-f]{64}$/);
        expect(first).not.toContain('@@ -1 +1 @@\n-a\n+b');
        expect(second).toHaveLength(first.length);
    });

    it('requires both the exact worker cache entry and final shadow DOM, while accepting a virtualized placeholder', async () => {
        const { isPierreInitialPresentationDomTerminal } = await import('./pierreInitialPresentation.web');
        const root = document.createElement('div');
        const host = document.createElement('div');
        const shadowRoot = host.attachShadow({ mode: 'open' });
        const querySelector = root.querySelector.bind(root);
        vi.spyOn(root, 'querySelector').mockImplementation((selector: string) => (
            selector === 'diffs-container'
                ? host
                : querySelector(selector)
        ));
        const pre = document.createElement('pre');
        pre.setAttribute('data-diff', '');
        shadowRoot.appendChild(pre);
        root.appendChild(host);
        const fileDiff = { cacheKey: 'exact', hunks: [], name: 'a.ts' } as any;
        const getDiffResultCache = vi.fn((): unknown => undefined);
        const pool = { getDiffResultCache } as any;

        expect(isPierreInitialPresentationDomTerminal({
            fileDiff,
            pool,
            root,
            virtualized: false,
        })).toBe(false);

        getDiffResultCache.mockReturnValue({ highlighted: true });
        expect(isPierreInitialPresentationDomTerminal({
            fileDiff,
            pool,
            root,
            virtualized: false,
        })).toBe(true);

        pre.remove();
        const placeholder = document.createElement('div');
        placeholder.setAttribute('data-placeholder', '');
        shadowRoot.appendChild(placeholder);
        getDiffResultCache.mockReturnValue(undefined);
        expect(isPierreInitialPresentationDomTerminal({
            fileDiff,
            pool,
            root,
            virtualized: true,
        })).toBe(true);
        expect(isPierreInitialPresentationDomTerminal({
            fileDiff,
            pool,
            root,
            virtualized: false,
        })).toBe(false);
    });

    it('attaches to a Pierre shadow root that appears after observation starts', async () => {
        const { observePierreInitialPresentationDom } = await import('./pierreInitialPresentation.web');
        const root = document.createElement('div');
        const host = document.createElement('div');
        const shadowRoot = host.attachShadow({ mode: 'open' });
        let currentHost: HTMLElement | null = null;
        const querySelector = root.querySelector.bind(root);
        vi.spyOn(root, 'querySelector').mockImplementation((selector: string) => (
            selector === 'diffs-container'
                ? currentHost
                : querySelector(selector)
        ));
        const onMutation = vi.fn();
        const stop = observePierreInitialPresentationDom(root, onMutation);
        try {
            currentHost = host;
            root.appendChild(host);
            await Promise.resolve();
            onMutation.mockClear();

            const finalPre = document.createElement('pre');
            finalPre.setAttribute('data-diff', '');
            shadowRoot.appendChild(finalPre);
            await Promise.resolve();

            expect(onMutation).toHaveBeenCalled();
        } finally {
            stop();
        }
    });

    it('commits a final app fallback when the initial presentation has no worker pool', async () => {
        fileDiffSpy.mockClear();
        // Missing browser animation scheduling is a real pool-unavailable boundary.
        vi.stubGlobal('requestAnimationFrame', undefined);
        const handle = {
            complete: vi.fn(),
            dispose: vi.fn(),
        };
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        const screen = await renderScreen(
            <InitialPresentationReadinessProvider value={{
                presentationPending: true,
                registerProducer: () => handle,
            }}>
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines
                    showLineNumbers
                    showPrefix
                />
            </InitialPresentationReadinessProvider>,
        );
        try {
            expect(screen.findByProps({ 'data-testid': 'pierre-diff-fallback' })).not.toBeNull();
            expect(fileDiffSpy).not.toHaveBeenCalled();
            expect(handle.complete).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the owned virtualizer bounded by its pane when virtualized', async () => {
        fileDiffSpy.mockClear();
        virtualizerSpy.mockClear();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        await renderer.act(async () => {
            screen = await renderScreen(<div style={{ maxHeight: 320 }}>
                    <PierreDiffViewer
                        mode="unified"
                        filePath="src/a.ts"
                        unifiedDiff={patch}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        virtualized={true}
                    />
                </div>);
        });

        const wrapper = screen.findByProps({ 'data-testid': 'pierre-diff-viewer' });
        expect(wrapper.props.style).toMatchObject({
            inset: 0,
            minHeight: 0,
            overflow: 'hidden',
            position: 'absolute',
        });
        expect(screen.findByType('Virtualizer' as any).props.style).toMatchObject({
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
        });
    });

    it('windows a large diff against the list scroller it sits in, nesting no scroller of its own (QB-81)', async () => {
        virtualizerSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const { PierreScrollRootVirtualizerProvider } = await import('./PierreScrollRootVirtualizerProvider.web');
        const { Virtualizer: PierreVirtualizer } = await import('@pierre/diffs');
        // Browser observers and Pierre's DOM binding are the boundary jsdom lacks; the provider and viewer stay real.
        const observer = class { observe() {} unobserve() {} disconnect() {} };
        vi.stubGlobal('IntersectionObserver', observer);
        vi.stubGlobal('ResizeObserver', observer);
        const setup = vi.spyOn(PierreVirtualizer.prototype, 'setup').mockImplementation(() => {});
        const listScroller = document.createElement('div');
        const patch = ['--- a/long.txt', '+++ b/long.txt', '@@ -0,0 +1,3 @@', '+one', '+two', '+three', ''].join('\n');
        const screen = await renderScreen(<PierreScrollRootVirtualizerProvider getScrollRoot={() => listScroller}>
            <PierreDiffViewer mode="unified" filePath="long.txt" unifiedDiff={patch} virtualized />
        </PierreScrollRootVirtualizerProvider>);
        try {
            expect(virtualizerSpy).not.toHaveBeenCalled();
            const wrapper = screen.findByProps({ 'data-testid': 'pierre-diff-viewer' });
            expect(wrapper.props.style).not.toHaveProperty('overflow');
            expect(wrapper.props.style).not.toHaveProperty('position');
            expect(setup).toHaveBeenCalledWith(listScroller);
        } finally {
            await screen.unmount();
            setup.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it('publishes scale-aware diff typography CSS variables', async () => {
        const { resolvePierreTypographyStyle } = await import('./PierreDiffViewer.web');

        expect(resolvePierreTypographyStyle()).toMatchObject({
            '--diffs-font-size': 'calc(12px * var(--happier-ui-font-scale, 1))',
            '--diffs-line-height': 'calc(22px * var(--happier-ui-font-scale, 1))',
        });
    });

    it('uses the canonical default face for diff headers', async () => {
        const { resolvePierreTypographyStyle } = await import('./PierreDiffViewer.web');
        expect(resolvePierreTypographyStyle()).toHaveProperty(
            '--diffs-header-font-family', 'var(--happier-font-default-regular, Inter-Regular)',
        );
    });

    it('publishes theme-backed selection CSS variables for Pierre selected lines', async () => {
        const { resolvePierreSelectionStyle } = await import('./PierreDiffViewer.web');

        expect(resolvePierreSelectionStyle({
            colors: {
                surface: { base: '#surface', inset: '#surface-inset' },
                state: { success: { foreground: '#success' } },
                text: { link: '#link' },
            },
        })).toMatchObject({
            '--diffs-bg-selection': 'var(--happier-glass-content-background-color, color-mix(in srgb, #surface-inset var(--happier-glass-content-opacity, 100%), transparent))',
            '--diffs-selection-number-fg': '#surface',
            '--diffs-bg-selection-number': 'var(--happier-glass-content-background-color, color-mix(in srgb, #success var(--happier-glass-content-opacity, 100%), transparent))',
            '--diffs-selection-base': '#success',
        });
    });

    it('passes tokenization budgets into Pierre options', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.tokenizeMaxLineLength).toBe(1234);
        expect(options?.maxLineDiffLength).toBe(987);
    });

    it('uses the shared diff presentation preference', async () => {
        fileDiffSpy.mockClear();
        storage.setState({ settings: { ...storage.getState().settings, filesDiffPresentationStyle: 'unified' } });

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.diffStyle).toBe('unified');
    });

    it('honors presentationStyleOverride over the global filesDiffPresentationStyle setting', async () => {
        fileDiffSpy.mockClear();
        storage.setState({ settings: { ...storage.getState().settings, filesDiffPresentationStyle: 'split' } });

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    presentationStyleOverride="unified"
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.diffStyle).toBe('unified');
    });

    it('normalizes app language ids to Pierre/Shiki ids when overriding', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(fileDiff?.lang).toBe('ts');
    });

    it('disables intra-line diff when the patch is huge', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const hugePatch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@']
            .concat(['-a', '+b', ' c', '-d', '+e'])
            .join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={hugePatch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.lineDiffType).toBe('none');
    });

    it('sets an explicit language override for special file names', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="text"
                    filePath=".env.production"
                    oldText="FOO=1\n"
                    newText="FOO=2\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(fileDiff?.lang).toBe('dotenv');
    });

    it('infers the language override from the patch when filePath is missing', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/.env.production b/.env.production',
            '--- a/.env.production',
            '+++ b/.env.production',
            '@@ -1,1 +1,1 @@',
            '-FOO=1',
            '+FOO=2',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath={null}
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(fileDiff?.lang).toBe('dotenv');
    });

    it('retains the scroll container when a refreshed patch changes', async () => {
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-foo\n+bar\n';
        const view = (unifiedDiff: string) => <PierreDiffViewer mode="unified" filePath="a.ts" unifiedDiff={unifiedDiff} virtualized />;
        const screen = await renderScreen(view(patch));
        await renderer.act(async () => {
            screen.findByType('Virtualizer').props.onScroll(600);
        });
        await screen.update(view(patch.replace('+bar', '+updated')));
        expect(screen.findByType('Virtualizer').props.scrollTop).toBe(600);
    });

    it('does not reapply a consumed jump target on a patch refresh', async () => {
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const { FileDiff: VanillaFileDiff } = await import('@pierre/diffs');
        const instance = new VanillaFileDiff<React.ReactNode, undefined>();
        const root = document.createElement('div');
        const code = document.createElement('code');
        code.dataset.unified = '';
        root.append(code);
        const target = document.createElement('div');
        target.dataset.lineType = 'change-addition';
        target.dataset.line = '1';
        target.scrollIntoView = () => { root.scrollTop = 100; };
        code.append(target);
        const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-foo\n+bar\n';
        const view = (unifiedDiff: string, start = 0) => <PierreDiffViewer mode="unified" filePath="a.ts" unifiedDiff={unifiedDiff} scrollToLineId="a:5"
            findRangesByLineId={new Map([['a:5', [{ start, end: start + 1, current: true }]]])} />;
        const screen = await renderScreen(view(patch), { createNodeMock: () => root });
        await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(root, instance); });
        expect(root.scrollTop).toBe(100);
        root.scrollTop = 600;
        await screen.update(view(patch.replace('+bar', '+updated')));
        await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(root, instance); });
        expect(root.scrollTop).toBe(600);
        await screen.update(view(patch.replace('+bar', '+updated'), 1));
        await renderer.act(async () => { screen.findAllByType('FileDiff')[0].props.options.onPostRender(root, instance); });
        expect(root.scrollTop).toBe(100);
        instance.cleanUp();
    });

    it('does not render an inner Virtualizer for an intrinsic diff in a shared list viewport', async () => {
        fileDiffSpy.mockClear();
        virtualizerSpy.mockClear();

        const { VirtualizerContext } = await import('@pierre/diffs/react');
        const { Virtualizer: ScrollVirtualizer } = await import('@pierre/diffs');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
        const sharedVirtualizer = new ScrollVirtualizer();

        const patch = [
                            'diff --git a/a.ts b/a.ts',
                            '--- a/a.ts',
                            '+++ b/a.ts',
                            '@@ -1,1 +1,1 @@',
                            '-foo',
                            '+bar',
                            '',
                        ].join('\n');
        const view = (unifiedDiff: string) => (
            <VirtualizerContext.Provider value={sharedVirtualizer}>
                <PierreDiffViewer
                        mode="unified"
                        filePath="src/a.ts"
                        unifiedDiff={unifiedDiff}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        virtualized={false}
                    />
            </VirtualizerContext.Provider>
        );
        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        await renderer.act(async () => {
            screen = await renderScreen(view(patch));
        });

        expect(virtualizerSpy).toHaveBeenCalledTimes(0);
        expect(screen.findByProps({ 'data-testid': 'pierre-diff-viewer' }).props.style?.position).toBeUndefined();
        const firstRenderedKey = screen.tree.findByType('FileDiff').props.fileDiff.cacheKey;
        await screen.update(view(patch.replace('+bar', '+updated')));
        expect(screen.tree.findByType('FileDiff').props.fileDiff.cacheKey).not.toBe(firstRenderedKey);
        sharedVirtualizer.cleanUp();
    });

    it('wires Pierre line clicks to onPressLine with a mapped CodeLine', async () => {
        fileDiffSpy.mockClear();
        const onPressLine = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressLine={onPressLine as any}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineClick).toBe('function');

        await renderer.act(async () => {
            options.onLineClick({
                type: 'diff-line',
                annotationSide: 'additions',
                lineType: 'change-addition',
                lineNumber: 1,
                lineElement: {} as any,
                numberElement: {} as any,
                numberColumn: false,
                event: {} as any,
            });
        });

        expect(onPressLine).toHaveBeenCalledTimes(1);
        const lineArg = onPressLine.mock.calls[0]?.[0];
        expect(lineArg?.newLine).toBe(1);
        expect(lineArg?.renderPrefixText).toBe('+');
    });

    it('maps bubbled Pierre row clicks to onPressLine with a mapped CodeLine', async () => {
        fileDiffSpy.mockClear();
        const onPressLine = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        await renderer.act(async () => {
            screen = await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressLine={onPressLine as any}
                />);
        });

        const wrapper = screen.findByProps({ 'data-testid': 'pierre-diff-viewer' });
        const row = {
            getAttribute: (name: string) => {
                if (name === 'data-line-type') return 'change-addition';
                if (name === 'data-line') return '1';
                return null;
            },
        };

        await renderer.act(async () => {
            wrapper.props.onClickCapture?.({
                nativeEvent: {
                    composedPath: () => [row],
                },
            });
        });

        expect(onPressLine).toHaveBeenCalledTimes(1);
        const lineArg = onPressLine.mock.calls[0]?.[0];
        expect(lineArg?.newLine).toBe(1);
        expect(lineArg?.renderPrefixText).toBe('+');
    });

    it('provides a hover utility when onPressAddComment is enabled', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={[
                        'diff --git a/a.ts b/a.ts',
                        '--- a/a.ts',
                        '+++ b/a.ts',
                        '@@ -1,1 +1,1 @@',
                        '-foo',
                        '+bar',
                        '',
                    ].join('\n')}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const call = fileDiffSpy.mock.calls[0]?.[0];
        expect(typeof call?.renderGutterUtility).toBe('function');
        expect(call?.options?.unsafeCSS).toContain('[data-gutter-utility-slot]');
        expect(call?.options?.unsafeCSS).toContain('left: 0');
        expect(call?.options?.unsafeCSS).toContain('right: auto');
        expect(call?.options?.unsafeCSS).toContain('padding-left: calc(var(--happier-review-comment-affordance-width) + 2ch)');

        const utility = call.renderGutterUtility(() => ({ lineNumber: 1, side: 'additions' }));
        const buttonProps = await findPierreHoverUtilityButtonProps(utility);
        expect(buttonProps.testID ?? buttonProps['data-testid']).toBe('review-comment-line-affordance');
        expect(buttonProps['data-active']).toBeUndefined();

        await renderer.act(async () => {
            clickPierreHoverUtility(utility);
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        const lineArg = onPressAddComment.mock.calls[0]?.[0];
        expect(lineArg?.newLine).toBe(1);
        expect(lineArg?.renderPrefixText).toBe('+');
    });

    it('keeps the hover utility mounted before Pierre reports a hovered line', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={[
                        'diff --git a/a.ts b/a.ts',
                        '--- a/a.ts',
                        '+++ b/a.ts',
                        '@@ -1,0 +1,1 @@',
                        '+bar',
                        '',
                    ].join('\n')}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const call = fileDiffSpy.mock.calls[0]?.[0];
        expect(typeof call?.renderGutterUtility).toBe('function');

        const utility = call.renderGutterUtility(() => undefined);
        const buttonProps = await findPierreHoverUtilityButtonProps(utility);

        expect(buttonProps.testID ?? buttonProps['data-testid']).toBe('review-comment-line-affordance');
    });

    it('uses a native click handler for the Pierre hover slot', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={[
                        'diff --git a/a.ts b/a.ts',
                        '--- a/a.ts',
                        '+++ b/a.ts',
                        '@@ -1,0 +1,1 @@',
                        '+bar',
                        '',
                    ].join('\n')}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const call = fileDiffSpy.mock.calls[0]?.[0];
        const utility = call.renderGutterUtility(() => undefined);
        const buttonProps = await findPierreHoverUtilityButtonProps(utility);

        expect(typeof buttonProps.onClick).toBe('function');
    });

    it('resolves the hover utility target at press time', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={[
                        'diff --git a/a.ts b/a.ts',
                        '--- a/a.ts',
                        '+++ b/a.ts',
                        '@@ -1,0 +1,2 @@',
                        '+first',
                        '+second',
                        '',
                    ].join('\n')}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const call = fileDiffSpy.mock.calls[0]?.[0];
        expect(typeof call?.renderGutterUtility).toBe('function');

        let hovered = { lineNumber: 1, side: 'additions' as const };
        const getHoveredLine = () => hovered;
        const utility = call.renderGutterUtility(getHoveredLine);
        hovered = { lineNumber: 2, side: 'additions' };

        await renderer.act(async () => {
            clickPierreHoverUtility(utility);
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        const lineArg = onPressAddComment.mock.calls[0]?.[0];
        expect(lineArg?.newLine).toBe(2);
        expect(lineArg?.renderCodeText).toBe('second');
    });

    it('falls back to the press event path when Pierre clears the hovered line before icon press', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={[
                        'diff --git a/a.ts b/a.ts',
                        '--- a/a.ts',
                        '+++ b/a.ts',
                        '@@ -1,0 +1,2 @@',
                        '+first',
                        '+second',
                        '',
                    ].join('\n')}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const call = fileDiffSpy.mock.calls[0]?.[0];
        expect(typeof call?.renderGutterUtility).toBe('function');

        const numberElement = {
            getAttribute: (name: string) => {
                if (name === 'data-column-number') return '2';
                if (name === 'data-line-type') return 'change-addition';
                return null;
            },
            closest: () => null,
            getBoundingClientRect: () => ({ left: 0, width: 10 }),
        };
        const utility = call.renderGutterUtility(() => undefined);

        await renderer.act(async () => {
            clickPierreHoverUtility(utility, {
                composedPath: () => [numberElement],
            });
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        const lineArg = onPressAddComment.mock.calls[0]?.[0];
        expect(lineArg?.newLine).toBe(2);
        expect(lineArg?.renderCodeText).toBe('second');
    });

    it('uses the icon press event target instead of a stale hovered line', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={[
                        'diff --git a/a.ts b/a.ts',
                        '--- a/a.ts',
                        '+++ b/a.ts',
                        '@@ -1,0 +1,2 @@',
                        '+first',
                        '+second',
                        '',
                    ].join('\n')}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const call = fileDiffSpy.mock.calls[0]?.[0];
        expect(typeof call?.renderGutterUtility).toBe('function');

        const numberElement = {
            getAttribute: (name: string) => {
                if (name === 'data-column-number') return '2';
                if (name === 'data-line-type') return 'change-addition';
                return null;
            },
            closest: () => null,
            getBoundingClientRect: () => ({ left: 0, width: 10 }),
        };
        const utility = call.renderGutterUtility(() => ({ lineNumber: 1, side: 'additions' }));

        await renderer.act(async () => {
            clickPierreHoverUtility(utility, {
                composedPath: () => [numberElement],
            });
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        const lineArg = onPressAddComment.mock.calls[0]?.[0];
        expect(lineArg?.newLine).toBe(2);
        expect(lineArg?.renderCodeText).toBe('second');
    });

    it('maps line number clicks to onPressAddComment using lineType when annotationSide is unreliable', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineNumberClick).toBe('function');

        // If Pierre reports `annotationSide` incorrectly for number clicks, we still want to map
        // based on the lineType to ensure the comment targets the right CodeLine.
        await renderer.act(async () => {
            options.onLineNumberClick({
                type: 'diff-line',
                annotationSide: 'additions',
                lineType: 'change-deletion',
                lineNumber: 1,
                lineElement: {} as any,
                numberElement: {} as any,
                numberColumn: true,
                event: {} as any,
            });
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        const lineArg = onPressAddComment.mock.calls[0]?.[0];
        expect(lineArg?.oldLine).toBe(1);
        expect(lineArg?.renderPrefixText).toBe('-');
    });

    it('maps context line number clicks to a context CodeLine even when annotationSide is wrong', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,2 +1,3 @@',
            '+zero',
            ' one',
            ' two',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineNumberClick).toBe('function');

        // For split diffs, Pierre can report an unreliable annotationSide on context rows.
        // Ensure we still resolve to the context CodeLine when lineType indicates context.
        await renderer.act(async () => {
            options.onLineNumberClick({
                type: 'diff-line',
                annotationSide: 'additions',
                lineType: 'context',
                lineNumber: 1,
                lineElement: {} as any,
                numberElement: {} as any,
                numberColumn: true,
                event: {} as any,
            });
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        const lineArg = onPressAddComment.mock.calls[0]?.[0];
        expect(lineArg?.kind).toBe('context');
        expect(lineArg?.oldLine).toBe(1);
        expect(lineArg?.newLine).toBe(2);
        expect(lineArg?.renderCodeText).toBe('one');
    });

    it('maps context clicks to the correct side when old/new line numbers diverge', async () => {
        fileDiffSpy.mockClear();
        const onPressAddComment = vi.fn();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,3 +1,4 @@',
            ' one',
            '+added',
            ' two',
            ' three',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineNumberClick).toBe('function');

        const numberElement = {
            getAttribute: (name: string) => (name === 'data-column-side' ? 'additions' : null),
        } as any;

        // For context rows in split diffs, Pierre can report `annotationSide` incorrectly.
        // Ensure we still map the click based on the *actual* side being clicked (here: additions).
        await renderer.act(async () => {
            options.onLineNumberClick({
                type: 'diff-line',
                annotationSide: 'deletions',
                lineType: 'context',
                lineNumber: 3,
                lineElement: {} as any,
                numberElement,
                numberColumn: true,
                event: {} as any,
            });
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        const lineArg = onPressAddComment.mock.calls[0]?.[0];
        expect(lineArg?.renderCodeText).toBe('two');
        expect(lineArg?.oldLine).toBe(2);
        expect(lineArg?.newLine).toBe(3);
    });

    it('maps renderAfterLine results to Pierre line annotations', async () => {
        fileDiffSpy.mockClear();

        const renderAfterLine = vi.fn((line: any) => (line?.renderPrefixText === '+' ? React.createElement('span') : null));

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    renderAfterLine={renderAfterLine as any}
                />);
        });

        const lineAnnotations = fileDiffSpy.mock.calls[0]?.[0]?.lineAnnotations;
        expect(Array.isArray(lineAnnotations)).toBe(true);
        expect(lineAnnotations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    side: 'additions',
                    lineNumber: 1,
                }),
            ]),
        );
    });

    it('injects unsafeCSS to highlight Happier selectedLineIds in Pierre', async () => {
        fileDiffSpy.mockClear();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    selectedLineIds={new Set(['a:5'])}
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.unsafeCSS ?? '')).toContain("[data-line-type='change-addition'][data-line='1']");
    });

    it('clears selection styling when selectedLineIds becomes empty', async () => {
        fileDiffSpy.mockClear();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        await renderer.act(async () => {
            screen = await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    selectedLineIds={new Set(['a:5'])}
                />);
        });

        const firstOptions = fileDiffSpy.mock.calls[fileDiffSpy.mock.calls.length - 1]?.[0]?.options;
        expect(String(firstOptions?.unsafeCSS ?? '')).toContain("[data-line-type='change-addition'][data-line='1']");

        await renderer.act(async () => {
            await screen.update(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    selectedLineIds={undefined}
                />,
            );
        });

        const secondOptions = fileDiffSpy.mock.calls[fileDiffSpy.mock.calls.length - 1]?.[0]?.options;
        expect(String(secondOptions?.unsafeCSS ?? '')).not.toContain("[data-line-type='change-addition'][data-line='1']");
    });

    it('injects unsafeCSS to highlight a requested highlightLineId', async () => {
        fileDiffSpy.mockClear();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    highlightLineId="a:5"
                />);
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.unsafeCSS ?? '')).toContain("[data-line-type='change-addition'][data-line='1']");
    });

    it('renders a fallback state when the unified diff is empty', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        await renderer.act(async () => {
            screen = await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/empty.bin"
                    unifiedDiff=""
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(0);
        expect(JSON.stringify((screen.tree as any).toJSON())).toContain('files.noChanges');
    });

    it('does not crash when the patch is not a single-file unified diff (e.g. binary placeholders)', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = 'Binary files a/src/image.png and b/src/image.png differ';

        let tree: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = (await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="src/image.png"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />)).tree;
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(0);
        expect(JSON.stringify((tree! as any).toJSON())).toContain(patch);
    });

    it('renders a fallback state when Pierre throws while rendering a patch (e.g. binary/no-hunk diffs)', async () => {
        fileDiffSpy.mockClear();
        fileDiffSpy.mockImplementation(() => {
            throw new Error('FileDiff: Provided patch must contain exactly 1 file diff');
        });

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '',
        ].join('\n');

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await renderer.act(async () => {
                screen = await renderScreen(<PierreDiffViewer
                        mode="unified"
                        filePath="src/a.ts"
                        unifiedDiff={patch}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                    />);
            });
        } finally {
            consoleErrorSpy.mockRestore();
            fileDiffSpy.mockReset();
        }

        const fallback = screen.findByProps({ 'data-testid': 'pierre-diff-fallback' });
        const fallbackText = String((fallback.children ?? []).join(''));
        expect(fallbackText).toContain('--- a/a.ts');
        expect(fallbackText).toContain('+++ b/a.ts');
        await screen.update(<PierreDiffViewer mode="unified" filePath="src/a.ts" unifiedDiff={patch.replace('+bar', '+recovered')} />);
        expect(screen.findAllByProps({ 'data-testid': 'pierre-diff-fallback' })).toHaveLength(0);
        expect(fileDiffSpy.mock.calls.at(-1)?.[0].fileDiff).toBeTruthy();    });

    it('sanitizes multi-file unified diffs to a single-file patch for Pierre', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            'diff --git a/b.ts b/b.ts',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1,1 +1,1 @@',
            '-baz',
            '+qux',
            '',
        ].join('\n');

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        await renderer.act(async () => {
            screen = await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.patchText ?? '')).not.toContain('diff --git a/b.ts b/b.ts');
        expect(screen.findAllByProps({ 'data-testid': 'pierre-diff-fallback' }).length).toBe(0);
    });

    it('extracts the requested file from a multi-file patch (does not assume the first diff is the target)', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            'diff --git a/b.ts b/b.ts',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1,1 +1,1 @@',
            '-baz',
            '+qux',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="b.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(String(fileDiff?.name ?? '')).toContain('b.ts');
        expect(String(fileDiff?.name ?? '')).not.toContain('a.ts');
    });

    it('extracts the requested file from a multi-file patch when filePath has a leading slash', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            'diff --git a/b.ts b/b.ts',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1,1 +1,1 @@',
            '-baz',
            '+qux',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="/b.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(String(fileDiff?.name ?? '')).toContain('b.ts');
        expect(String(fileDiff?.name ?? '')).not.toContain('a.ts');

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.patchText ?? '')).not.toContain('diff --git a/a.ts b/a.ts');
    });

    it('sanitizes multi-file diffs without diff headers (---/+++ only) to a single file patch', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1,1 +1,1 @@',
            '-baz',
            '+qux',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.patchText ?? '')).not.toContain('--- a/b.ts');
    });

    it('extracts the requested file from a multi-file patch without diff headers (---/+++ only)', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1,1 +1,1 @@',
            '-baz',
            '+qux',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="b.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(String(fileDiff?.name ?? '')).toContain('b.ts');
        expect(String(fileDiff?.name ?? '')).not.toContain('a.ts');
    });

    it('sanitizes multi-file diffs with non-git diff headers (e.g. diff -r) to a single file patch', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = [
            'diff -r abc123 a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,1 +1,1 @@',
            '-foo',
            '+bar',
            'diff -r def456 b.ts',
            '--- a/b.ts',
            '+++ b/b.ts',
            '@@ -1,1 +1,1 @@',
            '-baz',
            '+qux',
            '',
        ].join('\n');

        await renderer.act(async () => {
            await renderScreen(<PierreDiffViewer
                    mode="unified"
                    filePath="a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.patchText ?? '')).not.toContain('diff -r def456 b.ts');
        expect(String(options?.patchText ?? '')).not.toContain('diff -r abc123 a.ts');
    });
});
