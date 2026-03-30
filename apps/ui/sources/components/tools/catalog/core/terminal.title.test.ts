import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, vars?: any) => {
        if (key === 'tools.names.terminal') return 'Terminal';
        if (key === 'tools.desc.terminalCmd') return `Run ${vars?.cmd ?? ''}`.trim();
        return key;
    },
    });
});

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

    it('shows a structured Happier-tool title for shell-bridge commands', async () => {
        const { coreTerminalTools } = await import('./terminal');

        const title = coreTerminalTools.Bash.title({
            metadata: null,
            tool: {
                name: 'Bash',
                state: 'completed',
                input: {
                    command: `happier tools call --source playwright --tool open_page --args-json '{"url":"https://example.com"}' --json`,
                },
                result: { stdout: '' },
                createdAt: Date.now(),
                startedAt: Date.now(),
                completedAt: Date.now(),
                description: 'execute',
            },
        } as any);

        expect(title).toBe('Run open_page');
        expect(
            coreTerminalTools.Bash.extractDescription?.({
                metadata: null,
                tool: {
                    name: 'Bash',
                    state: 'completed',
                    input: {
                        command: `happier tools call --source playwright --tool open_page --args-json '{"url":"https://example.com"}' --json`,
                    },
                    result: { stdout: '' },
                    createdAt: Date.now(),
                    startedAt: Date.now(),
                    completedAt: Date.now(),
                    description: 'execute',
                },
            } as any),
        ).toBe('playwright.open_page');
    });

    it('shows a structured Happier-tools title for shell-bridge list commands', async () => {
        const { coreTerminalTools } = await import('./terminal');

        const tool = {
            name: 'Bash',
            state: 'completed',
            input: {
                command: `'${process.execPath}' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'list' '--session-id' '3cf9c95b-aeee-4f50-bdac-620be56bef15' '--directory' '/tmp/workspace' '--json'`,
                happierToolsShellBridge: {
                    kind: 'list',
                    rawCommand: `'${process.execPath}' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'list' '--session-id' '3cf9c95b-aeee-4f50-bdac-620be56bef15' '--directory' '/tmp/workspace' '--json'`,
                    sessionId: '3cf9c95b-aeee-4f50-bdac-620be56bef15',
                    directory: '/tmp/workspace',
                    json: true,
                },
            },
            result: { stdout: '' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: 'execute',
        } as any;

        expect(coreTerminalTools.Bash.title({ metadata: null, tool })).toBe('Run list');
        expect(coreTerminalTools.Bash.extractDescription?.({ metadata: null, tool })).toBe('happier.tools');
        expect(coreTerminalTools.Bash.extractSubtitle?.({ metadata: null, tool })).toBe('happier.tools.list');
    });
});
