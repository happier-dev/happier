import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit';
import { installSessionFileViewCommonModuleMocks } from './sessionFileViewTestHelpers';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionFileViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            Platform: {
                OS: 'android',
                select: (options: any) => options?.android ?? options?.native ?? options?.default ?? options?.web ?? options?.ios,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
});

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => {
        codeLinesViewPropsState.current = props;
        return React.createElement('CodeLinesView', props);
    },
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => {
        diffViewerPropsState.current = props;
        return React.createElement('DiffViewer', props);
    },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => {
        markdownViewPropsState.current = props;
        return React.createElement('MarkdownView', props);
    },
}));

let thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => thresholds,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

const diffViewerPropsState: { current: any | null } = { current: null };
const codeLinesViewPropsState: { current: any | null } = { current: null };
const markdownViewPropsState: { current: any | null } = { current: null };

describe('FileContentPanel', () => {
    const theme = {
        colors: {
            textSecondary: '#999',
            text: {
                secondary: '#999',
            },
        },
    };

    it('renders diff view when diff mode is selected and diff exists', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');
        const onToggleLine = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        diffViewerPropsState.current = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={['@@ -1,1 +1,1 @@', '+const a = 1;', ''].join('\n')}
                    fileContent="const a = 1;"
                    language="typescript"
                    selectedLineKeys={new Set(['additions:1'])}
                    lineSelectionEnabled
                    onToggleLine={onToggleLine}
                />)).tree;

        expect(diffViewerPropsState.current?.mode).toBe('unified');
        expect(diffViewerPropsState.current?.selectedLineIds instanceof Set).toBe(true);
        expect(Array.from(diffViewerPropsState.current?.selectedLineIds?.values() ?? [])).toContain('a:1');
    });

    it('maps a commit-selection line range to diff line keys', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');
        const onToggleLine = vi.fn();

        diffViewerPropsState.current = null;
        await renderScreen(<FileContentPanel
            theme={theme as any}
            displayMode="diff"
            sessionId="s1"
            filePath="src/a.ts"
            diffContent={['@@ -1,3 +1,3 @@', '+const a = 1;', '+const b = 2;', ' const c = 3;', ''].join('\n')}
            fileContent="const a = 1;"
            language="typescript"
            selectedLineKeys={new Set()}
            lineSelectionEnabled
            onToggleLine={onToggleLine}
        />);

        expect(typeof diffViewerPropsState.current?.onPressLineRange).toBe('function');
        diffViewerPropsState.current.onPressLineRange([
            { id: 'a:1', sourceIndex: 1, kind: 'add', oldLine: null, newLine: 1, renderPrefixText: '+', renderCodeText: 'const a = 1;', renderIsHeaderLine: false, selectable: true },
            { id: 'a:2', sourceIndex: 2, kind: 'add', oldLine: null, newLine: 2, renderPrefixText: '+', renderCodeText: 'const b = 2;', renderIsHeaderLine: false, selectable: true },
            { id: 'ctx:3', sourceIndex: 3, kind: 'context', oldLine: 3, newLine: 3, renderPrefixText: ' ', renderCodeText: 'const c = 3;', renderIsHeaderLine: false, selectable: false },
        ]);

        expect(onToggleLine.mock.calls.map((call) => call[0])).toEqual(['additions:1', 'additions:2']);
    });

    it('forwards explicit range selection state to file code lines', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        codeLinesViewPropsState.current = null;
        await renderScreen(<FileContentPanel
            theme={theme as any}
            displayMode="file"
            sessionId="s1"
            filePath="src/a.ts"
            diffContent={null}
            fileContent="const a = 1;"
            language="typescript"
            selectedLineKeys={new Set()}
            lineSelectionEnabled={false}
            onToggleLine={vi.fn()}
            reviewCommentsEnabled
            reviewCommentDrafts={[]}
            rangeSelectionActive
        />);

        expect(codeLinesViewPropsState.current?.rangeSelectionActive).toBe(true);
    });

    it('forwards explicit range selection state to diff code lines', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        diffViewerPropsState.current = null;
        await renderScreen(<FileContentPanel
            theme={theme as any}
            displayMode="diff"
            sessionId="s1"
            filePath="src/a.ts"
            diffContent={['@@ -1,1 +1,1 @@', '+const a = 1;', ''].join('\n')}
            fileContent={null}
            language="typescript"
            selectedLineKeys={new Set()}
            lineSelectionEnabled={false}
            onToggleLine={vi.fn()}
            reviewCommentsEnabled
            reviewCommentDrafts={[]}
            rangeSelectionActive
        />);

        expect(diffViewerPropsState.current?.rangeSelectionActive).toBe(true);
    });

    it('keeps applied selected diff lines visible when commit-selection mode is not active', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        diffViewerPropsState.current = null;
        await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={['@@ -1,1 +1,1 @@', '+const a = 1;', ''].join('\n')}
                    fileContent="const a = 1;"
                    language="typescript"
                    selectedLineKeys={new Set(['additions:1'])}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />);

        expect(diffViewerPropsState.current?.mode).toBe('unified');
        expect(Array.from(diffViewerPropsState.current?.selectedLineIds?.values() ?? [])).toContain('a:1');
    });

    it('renders file content when file mode is selected', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent="diff --git a/a.ts b/a.ts"
                    fileContent="const a = 1;"
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />)).tree;

        expect(codeLinesViewPropsState.current).toBeTruthy();
    });

    it('renders markdown content when markdown mode is selected', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        markdownViewPropsState.current = null;

        await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode={'markdown' as any}
                    sessionId="s1"
                    filePath="README.md"
                    diffContent={null}
                    fileContent={'# Title\n\nHello **world**.'}
                    language="markdown"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />);

        expect(markdownViewPropsState.current?.markdown).toBe('# Title\n\nHello **world**.');
        expect(markdownViewPropsState.current?.profile).toBe('default');
        expect(markdownViewPropsState.current?.streamingMode).toBe('static');
    });

    it('turns rendered markdown source ranges into review-comment targets in comment mode', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        markdownViewPropsState.current = null;

        await renderScreen(<FileContentPanel
            theme={theme as any}
            displayMode={'markdown' as any}
            sessionId="s1"
            filePath="README.md"
            diffContent={null}
            fileContent={'# Title\n\nBody'}
            language="markdown"
            selectedLineKeys={new Set()}
            lineSelectionEnabled={false}
            onToggleLine={vi.fn()}
            reviewCommentsEnabled
            reviewCommentModeActive
            reviewCommentDrafts={[]}
        />);

        expect(markdownViewPropsState.current?.onPressSourceRange).toEqual(expect.any(Function));
        expect(markdownViewPropsState.current?.renderAfterSourceRange).toEqual(expect.any(Function));
    });

    it('uses a gesture-handler ScrollView for no-wrap file content on Android', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        const screen = await renderScreen(<FileContentPanel
            theme={theme as any}
            displayMode="file"
            sessionId="s1"
            filePath="src/a.ts"
            diffContent={null}
            fileContent="const veryLongIdentifierName = someVeryLongCall(withManyArguments);"
            language="typescript"
            selectedLineKeys={new Set()}
            lineSelectionEnabled={false}
            onToggleLine={vi.fn()}
            wrapLines={false}
        />);

        const scrollView = screen.tree.root.findByType('GestureHandlerScrollView' as any);
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
        expect(scrollView.props.disallowInterruption).toBe(true);
    });

    it('disables virtualization when review comments are enabled', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        codeLinesViewPropsState.current = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={null}
                    fileContent="const a = 1;"
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    reviewCommentsEnabled
                    reviewCommentDrafts={[]}
                />)).tree;

        expect(codeLinesViewPropsState.current?.virtualized).toBe(false);
    });

    it('enables virtualization for large file content when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 100 };
        const { FileContentPanel } = await import('./FileContentPanel');
        codeLinesViewPropsState.current = null;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/minified.js"
                    diffContent={null}
                    fileContent={'a'.repeat(2_000)}
                    language="javascript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    reviewCommentsEnabled
                    reviewCommentDrafts={[]}
                />)).tree;

        expect(codeLinesViewPropsState.current?.virtualized).toBe(true);
    });

    it('enables virtualization for large diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 100 };
        const { FileContentPanel } = await import('./FileContentPanel');
        diffViewerPropsState.current = null;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={'a'.repeat(2_000)}
                    fileContent={null}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    reviewCommentsEnabled
                    reviewCommentDrafts={[]}
                />)).tree;

        expect(diffViewerPropsState.current?.virtualized).toBe(true);
    });

    it('passes scroll/highlight target for fileLine anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        codeLinesViewPropsState.current = null;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={null}
                    fileContent={['one', 'two', 'three'].join('\n')}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'fileLine', startLine: 2 }}
                />)).tree;

        expect(codeLinesViewPropsState.current?.scrollToLineId).toBe('f:2');
        expect(codeLinesViewPropsState.current?.highlightLineId).toBe('f:2');
    });

    it('passes scroll/highlight target for normalized line anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        codeLinesViewPropsState.current = null;

        await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={null}
                    fileContent={['one', 'two', 'three'].join('\n')}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'line', filePath: 'src/a.ts', line: 2 }}
                />);

        expect(codeLinesViewPropsState.current?.scrollToLineId).toBe('f:2');
        expect(codeLinesViewPropsState.current?.highlightLineId).toBe('f:2');
    });

    it('passes scroll/highlight target for normalized range anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        codeLinesViewPropsState.current = null;

        await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={null}
                    fileContent={['one', 'two', 'three'].join('\n')}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'range', filePath: 'src/a.ts', startLine: 2, endLine: 3 }}
                />);

        expect(codeLinesViewPropsState.current?.scrollToLineId).toBe('f:2');
        expect(codeLinesViewPropsState.current?.highlightLineId).toBe('f:2');
        expect(Array.from(codeLinesViewPropsState.current?.highlightLineIds?.values() ?? [])).toEqual(['f:2', 'f:3']);
    });

    it('falls back to line hash when a fileLine anchor moved', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        const { computeLineContentHash } = await import('@/utils/text/lineContentHash');
        codeLinesViewPropsState.current = null;

        await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={null}
                    fileContent={['inserted', 'one', 'two'].join('\n')}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'fileLine', startLine: 1, lineHash: computeLineContentHash('two') }}
                />);

        expect(codeLinesViewPropsState.current?.scrollToLineId).toBe('f:3');
        expect(codeLinesViewPropsState.current?.highlightLineId).toBe('f:3');
    });

    it('passes scroll/highlight target for diffLine anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        diffViewerPropsState.current = null;

        // sourceIndex mapping: anchor.startLine is sourceIndex + 1 for the unified diff line list.
        const diff = ['@@ -1,1 +1,1 @@', '+const a = 1;', ''].join('\n');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={diff}
                    fileContent={null}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'diffLine', startLine: 2, side: 'after', oldLine: null, newLine: 1 }}
                />)).tree;

        expect(diffViewerPropsState.current?.scrollToLineId).toBe('a:1');
        expect(diffViewerPropsState.current?.highlightLineId).toBe('a:1');
        expect(diffViewerPropsState.current?.virtualized).toBe(false);
    });

    it('passes scroll/highlight target for normalized diff line anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        diffViewerPropsState.current = null;

        const diff = ['@@ -1,1 +1,1 @@', '+const a = 1;', ''].join('\n');

        await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={diff}
                    fileContent={null}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'line', filePath: 'src/a.ts', line: 1, side: 'after' }}
                />);

        expect(diffViewerPropsState.current?.scrollToLineId).toBe('a:1');
        expect(diffViewerPropsState.current?.highlightLineId).toBe('a:1');
        expect(diffViewerPropsState.current?.virtualized).toBe(false);
    });

    it('passes range highlight targets for normalized diff range anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        diffViewerPropsState.current = null;

        const diff = ['@@ -1,3 +1,3 @@', '+const a = 1;', '+const b = 2;', '+const c = 3;', ''].join('\n');

        await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={diff}
                    fileContent={null}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'range', filePath: 'src/a.ts', startLine: 1, endLine: 2, side: 'after' }}
                />);

        expect(diffViewerPropsState.current?.scrollToLineId).toBe('a:1');
        expect(diffViewerPropsState.current?.highlightLineId).toBe('a:1');
        expect(Array.from(diffViewerPropsState.current?.highlightLineIds?.values() ?? [])).toEqual(['a:1', 'a:2']);
        expect(diffViewerPropsState.current?.virtualized).toBe(false);
    });

    it('renders empty message when file mode has no content', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        codeLinesViewPropsState.current = null;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent=""
                    fileContent=""
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />)).tree;

        expect(findTestInstanceByTypeContainingText(tree!, 'Text', 'files.fileEmpty')).toBeTruthy();
    });

    it('renders no changes message when nothing is available', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');
        diffViewerPropsState.current = null;
        codeLinesViewPropsState.current = null;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    sessionId="s1"
                    filePath="src/a.ts"
                    diffContent={null}
                    fileContent={null}
                    language="typescript"
                    selectedLineKeys={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />)).tree;

        expect(findTestInstanceByTypeContainingText(tree!, 'Text', 'files.noChanges')).toBeTruthy();
    });
});
