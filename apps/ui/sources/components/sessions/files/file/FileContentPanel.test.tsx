import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: 'CodeLinesView',
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
                    selectedLineIndexes={new Set([1])}
                    lineSelectionEnabled
                    onToggleLine={onToggleLine}
                />
            );
        });

        const views = tree!.root.findAllByType('CodeLinesView' as any);
        expect(views).toHaveLength(1);
        expect(JSON.stringify(views[0]!.props.lines)).toContain('\"renderPrefixText\":\"+\"');
        const lines = views[0]!.props.lines as Array<{ id: string; renderPrefixText?: string }>;
        const selected = views[0]!.props.selectedLineIds as Set<string>;
        const firstSelectable = lines.find((l) => l.renderPrefixText === '+' || l.renderPrefixText === '-')?.id ?? null;
        expect(firstSelectable).not.toBeNull();
        expect(Array.from(selected.values())).toContain(firstSelectable);
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
                    selectedLineIndexes={new Set()}
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
                    selectedLineIndexes={new Set()}
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

    it('passes scroll/highlight target for fileLine anchors', async () => {
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
                    selectedLineIndexes={new Set()}
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
                    selectedLineIndexes={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                    jumpToAnchor={{ kind: 'diffLine', startLine: 2, side: 'after', oldLine: null, newLine: 1 }}
                />
            );
        });

        const view = tree!.root.findByType('CodeLinesView' as any);
        const lines = view.props.lines as Array<{ id: string; sourceIndex: number }>;
        const target = lines.find((l) => l.sourceIndex === 1);
        expect(target).toBeTruthy();
        expect(view.props.scrollToLineId).toBe(target!.id);
        expect(view.props.highlightLineId).toBe(target!.id);
    });

    it('renders empty message when file mode has no content', async () => {
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
                    selectedLineIndexes={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'files.fileEmpty')).toBe(true);
    });

    it('renders no changes message when nothing is available', async () => {
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
                    selectedLineIndexes={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'files.noChanges')).toBe(true);
    });
});
