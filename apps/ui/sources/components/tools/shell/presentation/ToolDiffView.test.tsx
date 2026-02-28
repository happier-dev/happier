import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffViewerSpy = vi.fn();
let wrapLinesSetting: boolean = true;
let inlineVirtualizationThresholdSetting: number | undefined = undefined;
let inlineVirtualizationByteThresholdSetting: number | undefined = undefined;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            ...(actual.Platform ?? {}),
            OS: 'web',
            select: (actual.Platform?.select ?? ((value: any) => value?.web ?? value?.default ?? null)),
        },
        useWindowDimensions: actual.useWindowDimensions ?? (() => ({ width: 1024, height: 768, scale: 1, fontScale: 1 })),
    };
});

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => {
        diffViewerSpy(props);
        return React.createElement('DiffViewer', props);
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'wrapLinesInDiffs') return wrapLinesSetting;
        if (key === 'filesDiffInlineVirtualizationLineThreshold') return inlineVirtualizationThresholdSetting;
        if (key === 'filesDiffInlineVirtualizationByteThreshold') return inlineVirtualizationByteThresholdSetting;
        return undefined;
    },
}));

const toolDiffViewModule = import('./ToolDiffView');

describe('ToolDiffView', () => {
    it('plumbs filePath and wrapLines into DiffViewer', async () => {
        wrapLinesSetting = true;
        diffViewerSpy.mockClear();
        const { ToolDiffView } = await toolDiffViewModule;

        await act(async () => {
            renderer.create(
                React.createElement(ToolDiffView, {
                    filePath: 'src/foo.ts',
                    oldText: 'const x = 1;\n',
                    newText: 'const x = 2;\n',
                }),
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'text',
                filePath: 'src/foo.ts',
                wrapLines: true,
            }),
        );
    });

    it('passes wrapLines=false through to DiffViewer', async () => {
        wrapLinesSetting = false;
        diffViewerSpy.mockClear();
        const { ToolDiffView } = await toolDiffViewModule;

        await act(async () => {
            renderer.create(
                React.createElement(ToolDiffView, {
                    filePath: 'src/foo.ts',
                    oldText: 'const x = 1;\n',
                    newText: 'const x = 2;\n',
                }),
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ wrapLines: false }));
    });

    it('virtualizes large tool diffs to avoid rendering thousands of rows inline', async () => {
        wrapLinesSetting = true;
        inlineVirtualizationThresholdSetting = 400;
        diffViewerSpy.mockClear();
        const { ToolDiffView } = await toolDiffViewModule;

        const oldLines: string[] = [];
        const newLines: string[] = [];
        for (let i = 0; i < 900; i++) {
            oldLines.push(`const a${i} = ${i};`);
            newLines.push(`const a${i} = ${i + 1};`);
        }

        await act(async () => {
            renderer.create(
                React.createElement(ToolDiffView, {
                    filePath: 'src/huge.ts',
                    oldText: oldLines.join('\n') + '\n',
                    newText: newLines.join('\n') + '\n',
                }),
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualized: true }));
    });

    it('respects the inline virtualization threshold setting', async () => {
        wrapLinesSetting = true;
        inlineVirtualizationThresholdSetting = 2_000;
        inlineVirtualizationByteThresholdSetting = undefined;
        diffViewerSpy.mockClear();
        const { ToolDiffView } = await toolDiffViewModule;

        const oldLines: string[] = [];
        const newLines: string[] = [];
        for (let i = 0; i < 900; i++) {
            oldLines.push(`const a${i} = ${i};`);
            newLines.push(`const a${i} = ${i + 1};`);
        }

        await act(async () => {
            renderer.create(
                React.createElement(ToolDiffView, {
                    filePath: 'src/huge.ts',
                    oldText: oldLines.join('\n') + '\n',
                    newText: newLines.join('\n') + '\n',
                }),
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualized: false }));
    });

    it('virtualizes diffs above the byte threshold even when line count is below the line threshold', async () => {
        wrapLinesSetting = true;
        inlineVirtualizationThresholdSetting = 50_000;
        inlineVirtualizationByteThresholdSetting = 100;
        diffViewerSpy.mockClear();
        const { ToolDiffView } = await toolDiffViewModule;

        await act(async () => {
            renderer.create(
                React.createElement(ToolDiffView, {
                    filePath: 'src/minified.js',
                    oldText: 'a'.repeat(2_000),
                    newText: 'b',
                }),
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualized: true }));
    });

    it('forces unified presentation for creation/deletion diffs to avoid empty split columns', async () => {
        wrapLinesSetting = true;
        diffViewerSpy.mockClear();
        const { ToolDiffView } = await toolDiffViewModule;

        await act(async () => {
            renderer.create(
                React.createElement(ToolDiffView, {
                    filePath: 'src/new.ts',
                    oldText: '',
                    newText: 'export const x = 1;\n',
                }),
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ presentationStyleOverride: 'unified' }));
    });
});
