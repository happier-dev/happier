import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fileDiffSpy = vi.fn();
const virtualizerSpy = vi.fn();
const settingValues: Record<string, unknown> = {};

function resetSettingValues() {
    settingValues.filesDiffTokenizationMaxLineLength = 1234;
    settingValues.filesDiffIntraLineWordDiffEnabled = true;
    settingValues.filesDiffIntraLineWordDiffMaxPatchLines = 3;
    settingValues.filesDiffIntraLineWordDiffMaxLineLength = 987;
    settingValues.filesDiffPresentationStyle = 'split';
}

resetSettingValues();

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: false } }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (Object.prototype.hasOwnProperty.call(settingValues, key)) {
            return (settingValues as any)[key];
        }
        return null;
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('./pierreThemeRegistry.web', () => ({
    ensureHappierPierreThemesRegistered: () => {},
    HAPPIER_PIERRE_THEME_IDS: { light: 'light', dark: 'dark' },
}));

vi.mock('./pierreWorkerPool.web', () => ({
    getPierreDiffWorkerPool: () => null,
}));

vi.mock('./resolvePierreLanguageOverride.web', () => ({
    resolvePierreLanguageOverride: (path: string | null | undefined) => {
        const p = String(path ?? '');
        if (p === '.env.production') return 'dotenv';
        if (p.endsWith('.ts')) return 'ts';
        return null;
    },
}));

vi.mock('@pierre/diffs/react', async () => {
    const actual = await vi.importActual<any>('@pierre/diffs/react');
    return {
        ...actual,
        WorkerPoolContext: { Provider: ({ children }: any) => children },
        Virtualizer: ({ children }: any) => {
            virtualizerSpy();
            return React.createElement('Virtualizer', null, children);
        },
        FileDiff: (props: any) => {
            fileDiffSpy(props);
            return React.createElement('FileDiff', props);
        },
    };
});

describe('PierreDiffViewer (web)', () => {
    beforeEach(() => {
        resetSettingValues();
    });

    it('passes tokenization budgets into Pierre options', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.tokenizeMaxLineLength).toBe(1234);
        expect(options?.maxLineDiffLength).toBe(987);
    });

    it('defaults diffStyle to unified when filesDiffPresentationStyle is unset', async () => {
        fileDiffSpy.mockClear();
        settingValues.filesDiffPresentationStyle = undefined;

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.diffStyle).toBe('unified');
    });

    it('honors presentationStyleOverride over the global filesDiffPresentationStyle setting', async () => {
        fileDiffSpy.mockClear();
        settingValues.filesDiffPresentationStyle = 'split';

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    presentationStyleOverride="unified"
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.diffStyle).toBe('unified');
    });

    it('normalizes app language ids to Pierre/Shiki ids when overriding', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="text"
                    filePath="src/demo.ts"
                    oldText="export const a = 1;\n"
                    newText="export const a = 2;\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(fileDiff?.lang).toBe('ts');
    });

    it('disables intra-line diff when the patch is huge', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const hugePatch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@']
            .concat(['-a', '+b', ' c', '-d', '+e'])
            .join('\n');

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={hugePatch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(options?.lineDiffType).toBe('none');
    });

    it('sets an explicit language override for special file names', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="text"
                    filePath=".env.production"
                    oldText="FOO=1\n"
                    newText="FOO=2\n"
                    contextLines={3}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath={null}
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        const fileDiff = fileDiffSpy.mock.calls[0]?.[0]?.fileDiff;
        expect(fileDiff?.lang).toBe('dotenv');
    });

    it('does not render an inner Virtualizer when a shared virtualizer context is already present', async () => {
        fileDiffSpy.mockClear();
        virtualizerSpy.mockClear();

        const { VirtualizerContext } = await import('@pierre/diffs/react');
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        renderer.act(() => {
            renderer.create(
                <VirtualizerContext.Provider value={{} as any}>
                    <PierreDiffViewer
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
                        virtualized={true}
                    />
                </VirtualizerContext.Provider>,
            );
        });

        expect(virtualizerSpy).toHaveBeenCalledTimes(0);
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressLine={onPressLine as any}
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineClick).toBe('function');

        renderer.act(() => {
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

    it('provides a hover utility when onPressAddComment is enabled', async () => {
        fileDiffSpy.mockClear();

        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
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
                    onPressAddComment={() => {}}
                />,
            );
        });

        const call = fileDiffSpy.mock.calls[0]?.[0];
        expect(typeof call?.renderHoverUtility).toBe('function');
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineNumberClick).toBe('function');

        // If Pierre reports `annotationSide` incorrectly for number clicks, we still want to map
        // based on the lineType to ensure the comment targets the right CodeLine.
        renderer.act(() => {
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineNumberClick).toBe('function');

        // For split diffs, Pierre can report an unreliable annotationSide on context rows.
        // Ensure we still resolve to the context CodeLine when lineType indicates context.
        renderer.act(() => {
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onPressAddComment={onPressAddComment as any}
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(typeof options?.onLineNumberClick).toBe('function');

        const numberElement = {
            getAttribute: (name: string) => (name === 'data-column-side' ? 'additions' : null),
        } as any;

        // For context rows in split diffs, Pierre can report `annotationSide` incorrectly.
        // Ensure we still map the click based on the *actual* side being clicked (here: additions).
        renderer.act(() => {
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    renderAfterLine={renderAfterLine as any}
                />,
            );
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    selectedLineIds={new Set(['a:5'])}
                />,
            );
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

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    selectedLineIds={new Set(['a:5'])}
                />,
            );
        });

        const firstOptions = fileDiffSpy.mock.calls[fileDiffSpy.mock.calls.length - 1]?.[0]?.options;
        expect(String(firstOptions?.unsafeCSS ?? '')).toContain("[data-line-type='change-addition'][data-line='1']");

        renderer.act(() => {
            tree.update(
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
        expect(String(secondOptions?.unsafeCSS ?? '')).toContain('happier:pierre:clear');
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    highlightLineId="a:5"
                />,
            );
        });

        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.unsafeCSS ?? '')).toContain("[data-line-type='change-addition'][data-line='1']");
    });

    it('renders a fallback state when the unified diff is empty', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        let tree: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/empty.bin"
                    unifiedDiff=""
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(0);
        expect(JSON.stringify((tree! as any).toJSON())).toContain('files.noChanges');
    });

    it('does not crash when the patch is not a single-file unified diff (e.g. binary placeholders)', async () => {
        fileDiffSpy.mockClear();
        const { PierreDiffViewer } = await import('./PierreDiffViewer.web');

        const patch = 'Binary files a/src/image.png and b/src/image.png differ';

        let tree: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="src/image.png"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
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

        let tree: renderer.ReactTestRenderer;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            renderer.act(() => {
                tree = renderer.create(
                    <PierreDiffViewer
                        mode="unified"
                        filePath="src/a.ts"
                        unifiedDiff={patch}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                    />,
                );
            });
        } finally {
            consoleErrorSpy.mockRestore();
            fileDiffSpy.mockReset();
        }

        const fallback = (tree! as any).root.findByProps({ 'data-testid': 'pierre-diff-fallback' });
        const fallbackText = String((fallback.children ?? []).join(''));
        expect(fallbackText).toContain('--- a/a.ts');
        expect(fallbackText).toContain('+++ b/a.ts');
    });

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

        let tree: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.patchText ?? '')).not.toContain('diff --git a/b.ts b/b.ts');
        expect((tree! as any).root.findAllByProps({ 'data-testid': 'pierre-diff-fallback' }).length).toBe(0);
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="b.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="/b.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="b.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
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

        renderer.act(() => {
            renderer.create(
                <PierreDiffViewer
                    mode="unified"
                    filePath="a.ts"
                    unifiedDiff={patch}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        expect(fileDiffSpy).toHaveBeenCalledTimes(1);
        const options = fileDiffSpy.mock.calls[0]?.[0]?.options;
        expect(String(options?.patchText ?? '')).not.toContain('diff -r def456 b.ts');
        expect(String(options?.patchText ?? '')).not.toContain('diff -r abc123 a.ts');
    });
});
