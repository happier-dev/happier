import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

const diffSpy = vi.fn();
vi.mock('@/components/tools/shell/presentation/ToolDiffView', () => ({
    ToolDiffView: (props: any) => {
        diffSpy(props);
        return React.createElement('ToolDiffView', props);
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        return undefined;
    },
}));

describe('WriteView', () => {
    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'Write',
            state: 'completed',
            input: { file_path: '/tmp/a.txt', content: Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n') },
            result: null,
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { WriteView } = await import('./WriteView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    WriteView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ),
            );
        });
        return tree;
    }

    it('truncates long writes by default', async () => {
        diffSpy.mockClear();
        await renderView(makeTool());

        expect(diffSpy).toHaveBeenCalledTimes(1);
        const last = diffSpy.mock.calls.at(-1)?.[0];
        expect(last.newText).toContain('line-0');
        expect(last.newText).toContain('line-19');
        expect(last.newText).not.toContain('line-20');
        expect(last.showLineNumbers).toBe(false);
        expect(last.showPlusMinusSymbols).toBe(false);
    });

    it('shows substantially more content when detailLevel=full', async () => {
        diffSpy.mockClear();
        await renderView(makeTool(), 'full');

        expect(diffSpy).toHaveBeenCalledTimes(1);
        const last = diffSpy.mock.calls.at(-1)?.[0];
        expect(last.newText).toContain('line-0');
        expect(last.newText).toContain('line-99');
        expect(last.showLineNumbers).toBe(true);
        expect(last.showPlusMinusSymbols).toBe(true);
    });

    it('renders a one-line preview when detailLevel=title', async () => {
        diffSpy.mockClear();
        const tree = await renderView(
            makeTool({ input: { file_path: '/tmp/a.txt', content: Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n') } }),
            'title',
        );

        expect(diffSpy).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree).join(' ')).toContain('line-0');
    });

    it('falls back to placeholder content when input schema is malformed', async () => {
        diffSpy.mockClear();
        await renderView(makeTool({ input: { file_path: '/tmp/a.txt', content: 123 } }));

        expect(diffSpy).toHaveBeenCalledTimes(1);
        const last = diffSpy.mock.calls.at(-1)?.[0];
        expect(last.newText).toContain('<no contents>');
    });
});
