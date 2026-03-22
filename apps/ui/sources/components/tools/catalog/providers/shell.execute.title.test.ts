import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, vars?: any) => {
        if (key === 'tools.names.terminal') return 'Terminal';
        if (key === 'tools.desc.terminalCmd') return `Run ${String(vars?.cmd ?? '')}`.trim();
        return key;
    },
    });
});

describe('providerShellTools.execute', () => {
    it('strips a leading unset prelude for title/subtitle display', async () => {
        const { providerShellTools } = await import('./shell');

        const tool = {
            name: 'execute',
            state: 'running',
            input: { command: 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; rm -rf /tmp/x' },
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
        } as any;

        const title = providerShellTools.execute.title({ metadata: null, tool });
        const subtitle = providerShellTools.execute.extractSubtitle?.({ metadata: null, tool });

        expect(title).toBe('Run rm');
        expect(subtitle).toBe('rm -rf /tmp/x');
    });

    it('strips a leading unset prelude from ACP titles', async () => {
        const { providerShellTools } = await import('./shell');

        const tool = {
            name: 'execute',
            state: 'running',
            input: {
                _acp: { title: 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; rm -rf /tmp/x [cwd /tmp]' },
            },
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
        } as any;

        const title = providerShellTools.execute.title({ metadata: null, tool });
        expect(title).toBe('Run rm');
    });

    it('shows a structured Happier-tools title for shell-bridge list commands', async () => {
        const { providerShellTools } = await import('./shell');

        const tool = {
            name: 'execute',
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
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
        } as any;

        expect(providerShellTools.execute.title({ metadata: null, tool })).toBe('Run list');
        expect(providerShellTools.execute.extractSubtitle?.({ metadata: null, tool })).toBe('happier.tools.list');
    });
});
