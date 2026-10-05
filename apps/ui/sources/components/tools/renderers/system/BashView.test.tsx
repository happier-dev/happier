import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { installSystemToolRendererCommonModuleMocks } from './systemToolRendererTestHelpers';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';


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
    it('excludes whitespace-only streams but preserves all whitespace in displayed output', async () => {
        const { projectBashDisplayText } = await import('./BashView');
        const blank = projectBashDisplayText(makeToolCall({ name: 'Bash', state: 'completed', result: { stdout: ' \n', stderr: '\t\n' } }));
        expect(blank.some((block) => block.id === 'tool-stdout' || block.id === 'tool-stderr')).toBe(false);
        const stdout = ' \nvisible\n ';
        expect(projectBashDisplayText(makeToolCall({ name: 'Bash', state: 'completed', result: { stdout } })).find((block) => block.id === 'tool-stdout')?.text).toBe(stdout);
    });
    it('projects the raw-command explanation that the full body renders', async () => {
        const { projectBashDisplayText } = await import('./BashView');
        const blocks = projectBashDisplayText(makeToolCall({ name: 'Bash', input: { command: 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; echo hi' } }));
        expect(blocks.find((block) => block.id === 'tool-command-raw-title')?.text).toBe('tools.bashView.commandDiffTitle');
        expect(blocks.find((block) => block.id === 'tool-command-raw-hint')?.text).toBe('tools.bashView.commandDiffHint');
    });
    it('projects decoded standard streams without matching hidden result metadata', async () => {
        const { projectBashDisplayText } = await import('./BashView');
        const tool = makeToolCall({ name: 'Bash', state: 'completed', input: { command: 'printf hello' }, result: { stdout: 'visible stdout', stderr: 'visible stderr', _raw: { hidden: 'metadata-only' } } });
        const blocks = projectBashDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-stdout')?.text).toBe('visible stdout');
        expect(blocks.find((block) => block.id === 'tool-stderr')?.text).toBe('visible stderr');
        expect(blocks.some((block) => block.text.includes('metadata-only'))).toBe(false);
    });
    it('reveals the full running output and forwards exact source ranges when Find owns a match', async () => {
        commandViewSpy.mockClear();
        const { BashView } = await import('./BashView');
        const stdout = 'needle at beginning\n' + 'x'.repeat(9000);
        const tool = makeToolCall({ name: 'Bash', state: 'running', input: { command: 'echo hi' }, result: { stdout, stderr: '', hidden: 'metadata-only' } });
        const store = createTranscriptFindRowStore();
        const ranges = [{ start: 0, end: 6, current: true }];
        store.publish(new Map([['find-tool', { blocks: [{ id: 'tool-stdout', sourceRanges: ranges }], reveal: { blockId: 'tool-stdout', requestId: 1 } }]]));
        await renderScreen(<TranscriptFindProvider store={store}><BashView {...makeToolViewProps(tool, { messageId: 'find-tool' })} /></TranscriptFindProvider>);
        expect(commandViewSpy).toHaveBeenLastCalledWith(expect.objectContaining({ stdout, stdoutFindRanges: ranges }));
    });
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

    it('renders camelCase command execution aggregatedOutput as stdout', async () => {
        commandViewSpy.mockClear();
        codeViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { cmd: 'pwd' },
            result: {
                type: 'commandExecution',
                command: '/bin/zsh -lc pwd',
                aggregatedOutput: '/Users/leeroy/Documents/Development/happier/dev\n',
                exitCode: 0,
            },
        });

        await renderScreen(React.createElement(BashView, makeToolViewProps(tool)));

        expect(commandViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'pwd',
                stdout: '/Users/leeroy/Documents/Development/happier/dev\n',
            }),
        );
        expect(codeViewSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({
                code: expect.stringContaining('aggregatedOutput'),
            }),
        );
    });

    it('renders ACP text content arrays as command stdout', async () => {
        commandViewSpy.mockClear();
        codeViewSpy.mockClear();
        const { BashView } = await import('./BashView');

        const tool = makeToolCall({
            name: 'Bash',
            state: 'completed',
            input: { command: 'printf hello' },
            result: {
                content: [{ type: 'text', text: 'hello' }],
                details: { exit_code: 0 },
                isError: false,
            },
        });

        await renderScreen(React.createElement(BashView, makeToolViewProps(tool)));

        expect(commandViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'printf hello',
                stdout: 'hello',
            }),
        );
        expect(codeViewSpy).not.toHaveBeenCalled();
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
