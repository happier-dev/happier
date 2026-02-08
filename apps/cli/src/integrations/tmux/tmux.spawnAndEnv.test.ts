import { describe, expect, it, vi } from 'vitest';
import { createTmuxSession, TmuxUtilities, type TmuxCommandResult } from './index';

describe('TmuxUtilities.detectTmuxEnvironment', () => {
    const originalTmuxEnv = process.env.TMUX;
    const originalTmuxPaneEnv = process.env.TMUX_PANE;

    const withTmuxEnv = (value: string | undefined, fn: () => void, pane?: string | undefined) => {
        process.env.TMUX = value;
        if (pane !== undefined) {
            process.env.TMUX_PANE = pane;
        } else {
            delete process.env.TMUX_PANE;
        }
        try {
            fn();
        } finally {
            if (originalTmuxEnv !== undefined) process.env.TMUX = originalTmuxEnv;
            else delete process.env.TMUX;
            if (originalTmuxPaneEnv !== undefined) process.env.TMUX_PANE = originalTmuxPaneEnv;
            else delete process.env.TMUX_PANE;
        }
    };

    it('returns null when TMUX env is missing', () => {
        withTmuxEnv(undefined, () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toBeNull();
        });
    });

    it('parses valid TMUX env values', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toEqual({
                socket_path: '/tmp/tmux-1000/default',
                server_pid: 4219,
                pane: '0',
            });
        });
    });

    it('returns null for malformed TMUX server pid values', () => {
        withTmuxEnv('/tmp/tmux-1000/default,mysession.mywindow,2', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toBeNull();
        });
        withTmuxEnv('/tmp/tmux-1000/default,session123,1', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toBeNull();
        });
    });

    it('handles complex socket paths and extra parts', () => {
        withTmuxEnv('/var/run/tmux/1000/default,1234,0', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toEqual({
                socket_path: '/var/run/tmux/1000/default',
                server_pid: 1234,
                pane: '0',
            });
        });
        withTmuxEnv('/tmp/tmux-1000/default,4219,0,extra', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toEqual({
                socket_path: '/tmp/tmux-1000/default',
                server_pid: 4219,
                pane: '0',
            });
        });
    });

    it('returns null for too-few/empty/invalid values', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toBeNull();
        });
        withTmuxEnv('', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toBeNull();
        });
        withTmuxEnv('/tmp/tmux-1000/default,my.session.name.5,2', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toBeNull();
        });
    });

    it('prefers TMUX_PANE when present', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0', () => {
            const utils = new TmuxUtilities();
            expect(utils.detectTmuxEnvironment()).toEqual({
                socket_path: '/tmp/tmux-1000/default',
                server_pid: 4219,
                pane: '%0',
            });
        }, '%0');
    });
});

describe('createTmuxSession', () => {
    it('returns a trimmed session identifier', async () => {
        const spy = vi
            .spyOn(TmuxUtilities.prototype, 'executeTmuxCommand')
            .mockResolvedValue({ returncode: 0, stdout: '', stderr: '', command: [] });

        try {
            const result = await createTmuxSession('  my session  ', { windowName: 'main' });
            expect(result.success).toBe(true);
            expect(result.sessionIdentifier).toBe('my session:main');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('TmuxUtilities.spawnInTmux', () => {
    class FakeTmuxUtilities extends TmuxUtilities {
        public calls: Array<{ cmd: string[]; session?: string }> = [];

        async executeTmuxCommand(cmd: string[], session?: string): Promise<TmuxCommandResult | null> {
            this.calls.push({ cmd, session });

            if (cmd[0] === 'list-sessions') {
                if (cmd.length === 1) {
                    return { returncode: 0, stdout: 'oldSess: 1 windows\nnewSess: 2 windows\n', stderr: '', command: cmd };
                }
                if (cmd[1] === '-F' && cmd[2]?.includes('session_last_attached')) {
                    return {
                        returncode: 0,
                        stdout: 'oldSess\t0\t100\nnewSess\t0\t200\n',
                        stderr: '',
                        command: cmd,
                    };
                }
                if (cmd[1] === '-F') {
                    return { returncode: 0, stdout: 'oldSess\nnewSess\n', stderr: '', command: cmd };
                }
            }

            if (cmd[0] === 'has-session') return { returncode: 0, stdout: '', stderr: '', command: cmd };
            if (cmd[0] === 'new-session') return { returncode: 0, stdout: '', stderr: '', command: cmd };
            if (cmd[0] === 'new-window') return { returncode: 0, stdout: '4242\n', stderr: '', command: cmd };
            return { returncode: 0, stdout: '', stderr: '', command: cmd };
        }
    }

    it('builds tmux new-window args without quoting env values', async () => {
        const tmux = new FakeTmuxUtilities();

        await tmux.spawnInTmux(
            ['echo', 'hello'],
            { sessionName: 'my-session', windowName: 'my-window', cwd: '/tmp' },
            { FOO: 'a$b', BAR: 'quote"back\\tick`' },
        );

        const newWindowCall = tmux.calls.find((call) => call.cmd[0] === 'new-window');
        expect(newWindowCall).toBeDefined();
        if (!newWindowCall) return;

        const newWindowArgs = newWindowCall.cmd;
        expect(newWindowArgs).toContain('FOO=a$b');
        expect(newWindowArgs).toContain('BAR=quote"back\\tick`');
        expect(newWindowArgs.some((arg) => arg.startsWith('FOO="'))).toBe(false);
        expect(newWindowArgs.some((arg) => arg.startsWith('BAR="'))).toBe(false);

        const commandIndex = newWindowArgs.indexOf("'echo' 'hello'");
        const pIndex = newWindowArgs.indexOf('-P');
        const fIndex = newWindowArgs.indexOf('-F');
        expect(pIndex).toBeGreaterThanOrEqual(0);
        expect(fIndex).toBeGreaterThanOrEqual(0);
        expect(commandIndex).toBeGreaterThanOrEqual(0);
        expect(pIndex).toBeLessThan(commandIndex);
        expect(fIndex).toBeLessThan(commandIndex);

        const tIndex = newWindowArgs.indexOf('-t');
        expect(tIndex).toBeGreaterThanOrEqual(0);
        expect(newWindowArgs[tIndex + 1]).toBe('my-session');
        expect(tIndex).toBeLessThan(commandIndex);
    });

    it('quotes command arguments for tmux shell command safely', async () => {
        const tmux = new FakeTmuxUtilities();
        await tmux.spawnInTmux(['echo', 'a b', "c'd", '$(rm -rf /)'], { sessionName: 'my-session', windowName: 'my-window' }, {});

        const newWindowCall = tmux.calls.find((call) => call.cmd[0] === 'new-window');
        expect(newWindowCall).toBeDefined();
        if (!newWindowCall) return;
        const commandArg = newWindowCall.cmd[newWindowCall.cmd.length - 1];
        expect(commandArg).toBe("'echo' 'a b' 'c'\\''d' '$(rm -rf /)'");
    });

    it('treats empty sessionName as current/most-recent session', async () => {
        const tmux = new FakeTmuxUtilities();
        const result = await tmux.spawnInTmux(['echo', 'hello'], { sessionName: '', windowName: 'my-window' }, {});

        expect(result.success).toBe(true);
        expect(result.sessionId).toBe('newSess:my-window');
        const usedLastAttachedFormat = tmux.calls.some(
            (call) => call.cmd[0] === 'list-sessions' && call.cmd[1] === '-F' && Boolean(call.cmd[2]?.includes('session_last_attached')),
        );
        expect(usedLastAttachedFormat).toBe(true);
    });

    it('retries new-window when tmux reports a window index conflict', async () => {
        class ConflictThenSuccessTmuxUtilities extends FakeTmuxUtilities {
            private newWindowAttempts = 0;

            override async executeTmuxCommand(cmd: string[], session?: string): Promise<TmuxCommandResult | null> {
                if (cmd[0] !== 'new-window') {
                    return super.executeTmuxCommand(cmd, session);
                }
                this.newWindowAttempts += 1;
                this.calls.push({ cmd, session });
                if (this.newWindowAttempts === 1) {
                    return { returncode: 1, stdout: '', stderr: 'create window failed: index 1 in use.', command: cmd };
                }
                return { returncode: 0, stdout: '4242\n', stderr: '', command: cmd };
            }
        }

        const tmux = new ConflictThenSuccessTmuxUtilities();
        const result = await tmux.spawnInTmux(['echo', 'hello'], { sessionName: 'my-session', windowName: 'my-window' }, {});

        expect(result.success).toBe(true);
        const newWindowCalls = tmux.calls.filter((call) => call.cmd[0] === 'new-window');
        expect(newWindowCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('returns an error when tmux new-window output is not a numeric pane PID', async () => {
        class InvalidPidTmuxUtilities extends FakeTmuxUtilities {
            override async executeTmuxCommand(cmd: string[], session?: string): Promise<TmuxCommandResult | null> {
                if (cmd[0] !== 'new-window') {
                    return super.executeTmuxCommand(cmd, session);
                }
                this.calls.push({ cmd, session });
                return { returncode: 0, stdout: 'not-a-pid\n', stderr: '', command: cmd };
            }
        }

        const tmux = new InvalidPidTmuxUtilities();
        const result = await tmux.spawnInTmux(['echo', 'hello'], { sessionName: 'my-session', windowName: 'my-window' }, {});

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/PID/i);
    });
});
