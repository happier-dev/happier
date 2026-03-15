import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string, vars?: any) => {
        if (key === 'tools.names.terminal') return 'Terminal';
        if (key === 'tools.desc.terminalCmd') return `Run ${vars?.cmd ?? ''}`.trim();
        return key;
    },
}));

describe('coreTerminalTools.Bash.title', () => {
    it('does not use the raw description when it is the generic execute marker', async () => {
        const { coreTerminalTools } = await import('./terminal');

        const title = coreTerminalTools.Bash.title({
            metadata: null,
            tool: {
                name: 'Bash',
                state: 'error',
                input: { command: ['/bin/zsh', '-lc', 'pwd'] },
                result: null,
                createdAt: Date.now(),
                startedAt: Date.now(),
                completedAt: Date.now(),
                description: 'execute',
            },
        } as any);

        expect(title).toBe('Run pwd');
    });

    it('strips a leading unset prelude (Claude auth scrub) for display', async () => {
        const { coreTerminalTools } = await import('./terminal');

        const title = coreTerminalTools.Bash.title({
            metadata: null,
            tool: {
                name: 'Bash',
                state: 'completed',
                input: { command: 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; rm -rf /tmp/x' },
                result: { stdout: '' },
                createdAt: Date.now(),
                startedAt: Date.now(),
                completedAt: Date.now(),
                description: 'execute',
            },
        } as any);

        expect(title).toBe('Run rm');
    });

    it('falls back to an explicit description when the command cannot be derived', async () => {
        const { coreTerminalTools } = await import('./terminal');

        const title = coreTerminalTools.Bash.title({
            metadata: null,
            tool: {
                name: 'Bash',
                state: 'completed',
                input: {},
                result: { stdout: '/tmp\n' },
                createdAt: Date.now(),
                startedAt: Date.now(),
                completedAt: Date.now(),
                description: 'Run something',
            },
        } as any);

        expect(title).toBe('Run something');
    });
});
