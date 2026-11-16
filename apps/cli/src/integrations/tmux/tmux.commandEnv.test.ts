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
    it('retains concurrent Session environments, cwd and tmux context outside their registering scopes', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('./TmuxUtilities');
        const { runAddedHostedSession } = await import('@/agent/runtime/lifecycle/hostedSessionScope');
        const calls: TmuxSpawnCall[] = [];
        spawnMock.mockImplementation((command: string, args: readonly string[], options: SpawnOptions) => {
            calls.push({ command, args: [...args], options });
            return createTmuxMockChildProcess();
        });
        const fixtures = await Promise.all(['alpha', 'beta'].map(async (name) => {
            const utils = await runAddedHostedSession({
                environment: { NODE_ENV: 'test', SESSION_VALUE: name, TMUX: `/tmp/${name},123,0`, TMUX_PANE: `%${name}` },
                workingDirectory: `/work/${name}`,
                end: () => {},
            }, async () => {
                await Promise.resolve();
                return new TmuxUtilities(name, { EXPLICIT_VALUE: name });
            });
            return { name, utils };
        }));

        await Promise.all(fixtures.map(({ utils }) => utils.executeTmuxCommand(['list-sessions'])));

        for (const { name, utils } of fixtures) {
            const call = calls.find(call => call.options.env?.SESSION_VALUE === name);
            expect(call?.options.cwd).toBe(`/work/${name}`);
            const env = call?.options.env;
            expect(env?.SESSION_VALUE).toBe(name);
            expect(env?.EXPLICIT_VALUE).toBe(name);
            expect(env?.TMUX).toBe(`/tmp/${name},123,0`);
            expect(env?.TMUX_PANE).toBe(`%${name}`);
            expect(Object.keys(env ?? {}).sort()).toEqual(['EXPLICIT_VALUE', 'NODE_ENV', 'SESSION_VALUE', 'TMUX', 'TMUX_PANE']);
            expect(utils.detectTmuxEnvironment()).toEqual({ socket_path: `/tmp/${name}`, server_pid: 123, pane: `%${name}` });
        }
    });

    it('hides captured tmux control commands at process creation', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        await new TmuxUtilities('happy').executeTmuxCommand(['list-sessions']);

        expect(getLastSpawnCall()?.options?.windowsHide).toBe(true);
        expect(getLastSpawnCall()?.options?.shell).toBe(false);
    });

    it('can be imported when configuration is partially mocked without logsDir', async () => {
        vi.resetModules();
        vi.doMock('@/configuration', () => ({
            configuration: {
                happyHomeDir: '/tmp/happier-home',
                isDaemonProcess: false,
            },
        }));

        try {
            const { TmuxUtilities } = await import('@/integrations/tmux');
            expect(TmuxUtilities).toBeTypeOf('function');
        } finally {
            vi.doUnmock('@/configuration');
            vi.resetModules();
        }
    });

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

    it('preserves explicit send-keys targets instead of adding a second focused target', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const utils = new TmuxUtilities('happy');
        await utils.executeTmuxCommand(['send-keys', '-t', 'happy:claude.1', '-l', '--', 'queued prompt']);

        const call = getLastSpawnCall();
        expect(call).not.toBeNull();
        expect(call?.args).toEqual(['-u', 'send-keys', '-t', 'happy:claude.1', '-l', '--', 'queued prompt']);
    });
});
