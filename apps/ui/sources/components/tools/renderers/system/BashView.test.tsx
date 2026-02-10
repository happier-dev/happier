import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

const commandViewSpy = vi.fn();
vi.mock('@/components/sessions/transcript/CommandView', () => ({
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
        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: ['/bin/zsh', '-lc', 'echo hi'] },
            result: { stdout: longStdout, stderr: '' },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(BashView, makeToolViewProps(tool)));
        });

        expect(tree.root.findAllByType('CommandView' as any)).toHaveLength(1);
        expect(commandViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'echo hi',
                stdout: expect.stringMatching(/^…/),
            }),
        );
        const lastCallProps = commandViewSpy.mock.calls.at(-1)?.[0] as { stdout?: string };
        expect(lastCallProps.stdout).toHaveLength(6001);
        expect(lastCallProps.stdout).not.toBe(longStdout);
    });

    it('shows full stdout when detailLevel=full', async () => {
        commandViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const longStdout = 'x'.repeat(7000);
        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: ['/bin/zsh', '-lc', 'echo hi'] },
            result: { stdout: longStdout, stderr: '' },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(BashView, makeToolViewProps(tool, { detailLevel: 'full' })));
        });

        expect(tree.root.findAllByType('CommandView' as any)).toHaveLength(1);
        expect(commandViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'echo hi',
                stdout: longStdout,
                fullWidth: true,
            }),
        );
    });

    it('does not dump structured JSON when stdout/stderr are empty', async () => {
        commandViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: ['/bin/zsh', '-lc', 'echo hi > /tmp/x'] },
            result: {
                stdout: '',
                stderr: '',
                exit_code: 0,
                aggregated_output: '',
                formatted_output: '',
            },
        });

        await act(async () => {
            renderer.create(React.createElement(BashView, makeToolViewProps(tool)));
        });

        const lastCallProps = commandViewSpy.mock.calls.at(-1)?.[0] as { stdout?: unknown; stderr?: unknown };
        expect(lastCallProps.stdout == null || lastCallProps.stdout === '').toBe(true);
        expect(lastCallProps.stderr == null || lastCallProps.stderr === '').toBe(true);
    });
});
