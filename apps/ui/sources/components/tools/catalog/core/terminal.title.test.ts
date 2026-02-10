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

    it('prefers an explicit description when present', async () => {
        const { coreTerminalTools } = await import('./terminal');

        const title = coreTerminalTools.Bash.title({
            metadata: null,
            tool: {
                name: 'Bash',
                state: 'completed',
                input: { command: ['/bin/zsh', '-lc', 'pwd'] },
                result: { stdout: '/tmp\n' },
                createdAt: Date.now(),
                startedAt: Date.now(),
                completedAt: Date.now(),
                description: 'Run pwd',
            },
        } as any);

        expect(title).toBe('Run pwd');
    });
});

