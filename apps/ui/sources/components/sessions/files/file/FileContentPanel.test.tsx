import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    Platform: {
        OS: 'ios',
        select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
    },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: 'CodeLinesView',
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: 'DiffViewer',
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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('FileContentPanel', () => {
    const theme = {
        colors: {
            textSecondary: '#999',
        },
    };

    it('renders diff view when diff mode is selected and diff exists', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');
        const onToggleLine = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const view = tree!.root.findByType('DiffViewer' as any);
        expect(view.props.mode).toBe('unified');
        expect(view.props.selectedLineIds instanceof Set).toBe(true);
        expect(Array.from(view.props.selectedLineIds.values())).toContain('a:1');
    });

    it('renders file content when file mode is selected', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(1);
    });

    it('disables virtualization when review comments are enabled', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const view = tree!.root.findByType('CodeLinesView' as any);
        expect(view.props.virtualized).toBe(false);
    });

    it('enables virtualization for large file content when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 100 };
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const view = tree!.root.findByType('CodeLinesView' as any);
        expect(view.props.virtualized).toBe(true);
    });

    it('enables virtualization for large diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 100 };
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const view = tree!.root.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(true);
    });

    it('passes scroll/highlight target for fileLine anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const view = tree!.root.findByType('CodeLinesView' as any);
        expect(view.props.scrollToLineId).toBe('f:2');
        expect(view.props.highlightLineId).toBe('f:2');
    });

    it('passes scroll/highlight target for diffLine anchors', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');

        // sourceIndex mapping: anchor.startLine is sourceIndex + 1 for the unified diff line list.
        const diff = ['@@ -1,1 +1,1 @@', '+const a = 1;', ''].join('\n');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const view = tree!.root.findByType('DiffViewer' as any);
        expect(view.props.scrollToLineId).toBe('a:1');
        expect(view.props.highlightLineId).toBe('a:1');
        expect(view.props.virtualized).toBe(false);
    });

    it('renders empty message when file mode has no content', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'files.fileEmpty')).toBe(true);
    });

    it('renders no changes message when nothing is available', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
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
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'files.noChanges')).toBe(true);
    });
});
