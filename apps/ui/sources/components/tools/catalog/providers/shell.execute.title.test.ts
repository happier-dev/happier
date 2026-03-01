import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => {
        if (key === 'tools.names.terminal') return 'Terminal';
        return key;
    },
}));

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

        expect(title).toBe('rm -rf /tmp/x');
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
        expect(title).toBe('rm -rf /tmp/x');
    });
});
