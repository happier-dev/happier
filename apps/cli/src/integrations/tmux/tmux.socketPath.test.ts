import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { createTmuxMockChildProcess, type TmuxSpawnCall } from './tmux.spawnMock.testHelpers';

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

describe('TmuxUtilities tmux socket path', () => {
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

    it('uses -S <socketPath> by default when configured', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const socketPath = '/tmp/happier-cli-tmux-test.sock';
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        await utils.executeTmuxCommand(['list-sessions']);

        const call = getLastSpawnCall();
        expect(call).not.toBeNull();
        expect(call!.command).toBe('tmux');
        expect(call!.args).toEqual(expect.arrayContaining(['-S', socketPath]));
    });
});
