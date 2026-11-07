import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { createTmuxMockChildProcess, type TmuxSpawnCall } from './tmux.spawnMock.testkit';

const { spawnMock, getLastSpawnCall, setLastSpawnCall } = vi.hoisted(() => {
    let lastSpawnCall: TmuxSpawnCall | null = null;
    return {
        spawnMock: vi.fn(),
        getLastSpawnCall: () => lastSpawnCall,
        setLastSpawnCall: (call: TmuxSpawnCall) => {
            lastSpawnCall = call;
        },
    };
});

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

describe('TmuxUtilities tmux subprocess environment', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        spawnMock.mockImplementation((command: string, args: readonly string[], options: SpawnOptions) => {
            setLastSpawnCall({
                command,
                args: [...args],
                options,
            });
            return createTmuxMockChildProcess();
        });
    });

    it('hides captured tmux control commands at process creation', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        await new TmuxUtilities('happy').executeTmuxCommand(['list-sessions']);

        expect(getLastSpawnCall()?.options?.windowsHide).toBe(true);
        expect(getLastSpawnCall()?.options?.shell).toBe(false);
    });

    it('passes TMUX_TMPDIR to tmux subprocess env when provided', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const utils = new TmuxUtilities('happy', { TMUX_TMPDIR: '/custom/tmux' });
        await utils.executeTmuxCommand(['list-sessions']);

        const call = getLastSpawnCall();
        expect(call).not.toBeNull();
        expect((call!.options.env as NodeJS.ProcessEnv | undefined)?.TMUX_TMPDIR).toBe('/custom/tmux');
    });

    it('does not forward TMUX/TMUX_PANE when TMUX_TMPDIR is configured (avoid wrong-server tmux client)', async () => {
        const originalTmux = process.env.TMUX;
        const originalPane = process.env.TMUX_PANE;
        process.env.TMUX = '/tmp/tmux-1/default,123,0';
        process.env.TMUX_PANE = '%0';
        try {
            vi.resetModules();
            const { TmuxUtilities } = await import('@/integrations/tmux');

            const utils = new TmuxUtilities('happy', { TMUX_TMPDIR: '/custom/tmux' });
            await utils.executeTmuxCommand(['list-sessions']);

            const call = getLastSpawnCall();
            expect(call).not.toBeNull();
            const env = call!.options.env as NodeJS.ProcessEnv | undefined;
            expect(env?.TMUX_TMPDIR).toBe('/custom/tmux');
            expect(env?.TMUX).toBeUndefined();
            expect(env?.TMUX_PANE).toBeUndefined();
        } finally {
            if (originalTmux === undefined) delete process.env.TMUX;
            else process.env.TMUX = originalTmux;
            if (originalPane === undefined) delete process.env.TMUX_PANE;
            else process.env.TMUX_PANE = originalPane;
        }
    });

    it('does not prepend a default send-keys target when the command already includes one', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const utils = new TmuxUtilities('happy');
        await utils.executeTmuxCommand(['send-keys', '-t', 'happy:claude.1', '-l', '--', 'queued prompt']);

        const call = getLastSpawnCall();
        expect(call).not.toBeNull();
        expect(call!.args).toEqual(['-u', 'send-keys', '-t', 'happy:claude.1', '-l', '--', 'queued prompt']);
    });
});
