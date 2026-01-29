import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

const diffSpy = vi.fn();
vi.mock('@/components/tools/ToolDiffView', () => ({
    ToolDiffView: (props: any) => {
        diffSpy(props);
        return React.createElement('ToolDiffView', props);
    },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        return undefined;
    },
}));

describe('EditView', () => {
    it('truncates long edit strings by default', async () => {
        diffSpy.mockClear();
        const { EditView } = await import('./EditView');

        const longText = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
        const tool: ToolCall = {
            name: 'Edit',
            state: 'completed',
            input: { old_string: longText, new_string: longText } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(EditView as any, { tool, metadata: null }));
        });

        expect(diffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                showLineNumbers: false,
                showPlusMinusSymbols: false,
            })
        );
        expect(diffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                oldText: Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n'),
            })
        );
    });

    it('shows full edit content when detailLevel=full', async () => {
        diffSpy.mockClear();
        const { EditView } = await import('./EditView');

        const longText = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
        const tool: ToolCall = {
            name: 'Edit',
            state: 'completed',
            input: { old_string: longText, new_string: longText } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(
                React.createElement(EditView as any, { tool, metadata: null, detailLevel: 'full' })
            );
        });

        expect(diffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                showLineNumbers: true,
                showPlusMinusSymbols: true,
                oldText: longText,
            })
        );
    });
});

