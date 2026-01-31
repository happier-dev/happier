import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

const commandViewSpy = vi.fn();
vi.mock('@/components/CommandView', () => ({
    CommandView: (props: any) => {
        commandViewSpy(props);
        return React.createElement('CommandView', props);
    },
}));

describe('BashView', () => {
    it('tails long stdout by default', async () => {
        commandViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const longStdout = 'x'.repeat(7000);
        const tool: ToolCall = {
            name: 'Bash',
            state: 'completed',
            input: { command: ['/bin/zsh', '-lc', 'echo hi'] } as any,
            result: { stdout: longStdout, stderr: '' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(BashView as any, { tool, metadata: null }));
        });

        expect(tree.root.findAllByType('CommandView' as any)).toHaveLength(1);
        expect(commandViewSpy).toHaveBeenCalledWith(expect.objectContaining({ stdout: expect.stringMatching(/^…/) }));
    });

    it('shows full stdout when detailLevel=full', async () => {
        commandViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const longStdout = 'x'.repeat(7000);
        const tool: ToolCall = {
            name: 'Bash',
            state: 'completed',
            input: { command: ['/bin/zsh', '-lc', 'echo hi'] } as any,
            result: { stdout: longStdout, stderr: '' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(BashView as any, { tool, metadata: null, detailLevel: 'full' }));
        });

        expect(tree.root.findAllByType('CommandView' as any)).toHaveLength(1);
        expect(commandViewSpy).toHaveBeenCalledWith(expect.objectContaining({ stdout: longStdout }));
    });
});

