import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { installSystemToolRendererCommonModuleMocks } from './systemToolRendererTestHelpers';


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

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
}));

const codeViewSpy = vi.fn();
vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => {
        codeViewSpy(props);
        return React.createElement('CodeView', props);
    },
}));

installSystemToolRendererCommonModuleMocks();

describe('BashView', () => {
    it('tails long stdout by default', async () => {
        commandViewSpy.mockClear();
        codeViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const longStdout = 'x'.repeat(7000);
        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: ['/bin/zsh', '-lc', 'echo hi'] },
            result: { stdout: longStdout, stderr: '' },
        });

        const screen = await renderScreen(React.createElement(BashView, makeToolViewProps(tool)));

        expect(screen.findAllByType('CommandView' as any)).toHaveLength(1);
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
        codeViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const longStdout = 'x'.repeat(7000);
        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: ['/bin/zsh', '-lc', 'echo hi'] },
            result: { stdout: longStdout, stderr: '' },
        });

        const screen = await renderScreen(React.createElement(BashView, makeToolViewProps(tool, { detailLevel: 'full' })));

        expect(screen.findAllByType('CommandView' as any)).toHaveLength(1);
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
        codeViewSpy.mockClear();
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

        await renderScreen(React.createElement(BashView, makeToolViewProps(tool)));

        const lastCallProps = commandViewSpy.mock.calls.at(-1)?.[0] as { stdout?: unknown; stderr?: unknown };
        expect(lastCallProps.stdout == null || lastCallProps.stdout === '').toBe(true);
        expect(lastCallProps.stderr == null || lastCallProps.stderr === '').toBe(true);
    });

    it('strips a leading unset prelude (Claude auth scrub) from the displayed command', async () => {
        commandViewSpy.mockClear();
        codeViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; rm -rf /tmp/x' },
            result: { stdout: '', stderr: '' },
        });

        await renderScreen(React.createElement(BashView, makeToolViewProps(tool)));

        expect(commandViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'rm -rf /tmp/x',
            }),
        );
    });

    it('shows a subtle hint + raw command in full view when a prelude was stripped', async () => {
        commandViewSpy.mockClear();
        codeViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const raw = 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; rm -rf /tmp/x';
        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: raw },
            result: { stdout: '', stderr: '' },
        });

        const screen = await renderScreen(React.createElement(BashView, makeToolViewProps(tool, { detailLevel: 'full' })));

        // The main command line stays clean.
        expect(commandViewSpy).toHaveBeenCalledWith(expect.objectContaining({ command: 'rm -rf /tmp/x' }));

        // Full view exposes the raw command for transparency.
        expect(codeViewSpy).toHaveBeenCalledWith(expect.objectContaining({ code: raw }));

        const texts = screen.findAllByType('Text' as any);
        const flattened = texts
            .map((t) => t.props.children)
            .flat()
            .filter((c) => typeof c === 'string') as string[];
        expect(flattened).toContain('tools.bashView.commandDiffHint');
    });
});
