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

    it('uses explicit window index on retry after conflict', async () => {
        // This test verifies that on retry, we query for available indices
        // and use an explicit target like "session:index"
        class ConflictThenExplicitIndexTmuxUtilities extends FakeTmuxUtilities {
            private newWindowAttempts = 0;
            public readonly targetArguments: string[] = [];

            override async executeTmuxCommand(cmd: string[], session?: string): Promise<TmuxCommandResult | null> {
                // Track list-windows calls for window indices
                if (cmd[0] === 'list-windows' && cmd.includes('#{window_index}')) {
                    // Return indices 0, 1, 2 (so next available is 3)
                    return { returncode: 0, stdout: '0\n1\n2\n', stderr: '', command: cmd };
                }

                if (cmd[0] !== 'new-window') {
                    return super.executeTmuxCommand(cmd, session);
                }

                this.newWindowAttempts += 1;
                this.calls.push({ cmd, session });

                // Track the -t argument
                const tIndex = cmd.indexOf('-t');
                if (tIndex >= 0 && tIndex + 1 < cmd.length) {
                    this.targetArguments.push(cmd[tIndex + 1]!);
                }

                if (this.newWindowAttempts === 1) {
                    // First attempt fails with index 0 in use
                    return { returncode: 1, stdout: '', stderr: 'create window failed: index 0 in use.', command: cmd };
                }
                // Second attempt succeeds
                return { returncode: 0, stdout: '4242\n', stderr: '', command: cmd };
            }
        }

        const tmux = new ConflictThenExplicitIndexTmuxUtilities();
        const result = await tmux.spawnInTmux(['echo', 'hello'], { sessionName: 'my-session', windowName: 'my-window' }, {});

        expect(result.success).toBe(true);
        expect(tmux.targetArguments.length).toBe(2);
        // First attempt: just session name (let tmux auto-assign)
        expect(tmux.targetArguments[0]).toBe('my-session');
        // Second attempt: explicit session:index
        expect(tmux.targetArguments[1]).toBe('my-session:3');
    });

    it('does not kill the bootstrap window when another process created the session first', async () => {
        class ConcurrentCreatorTmuxUtilities extends TmuxUtilities {
            public readonly killWindowTargets: string[] = [];
            private hasSessionCalls = 0;

            override async executeTmuxCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
                if (cmd[0] === 'has-session') {
                    this.hasSessionCalls += 1;
                    return {
                        returncode: this.hasSessionCalls === 1 ? 1 : 0,
                        stdout: '',
                        stderr: '',
                        command: cmd,
                    };
                }

                if (cmd[0] === 'new-window') {
                    return { returncode: 0, stdout: '4242\n', stderr: '', command: cmd };
                }

                if (cmd[0] === 'new-session') {
                    return { returncode: 1, stdout: '', stderr: 'duplicate session', command: cmd };
                }

                if (cmd[0] === 'kill-window') {
                    const targetIndex = cmd.indexOf('-t');
                    if (targetIndex >= 0 && targetIndex + 1 < cmd.length) {
                        this.killWindowTargets.push(cmd[targetIndex + 1]!);
                    }
                }

                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
        }

        const tmux = new ConcurrentCreatorTmuxUtilities();
        const result = await tmux.spawnInTmux(['echo', 'hello'], { sessionName: 'my-session', windowName: 'my-window' }, {});

        expect(result.success).toBe(true);
        expect(tmux.killWindowTargets).toEqual([]);
    });

    it('uses tmux base-index for retry targets and bootstrap cleanup', async () => {
        class BaseIndexOneTmuxUtilities extends TmuxUtilities {
            public readonly killWindowTargets: string[] = [];
            public readonly newWindowTargets: string[] = [];
            private newWindowAttempts = 0;

            override async executeTmuxCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
                if (cmd[0] === 'has-session') {
                    return { returncode: 1, stdout: '', stderr: '', command: cmd };
                }

                if (cmd[0] === 'new-session') {
                    return { returncode: 0, stdout: '', stderr: '', command: cmd };
                }

                if (cmd[0] === 'show-options' && cmd.includes('base-index')) {
                    return { returncode: 0, stdout: '1\n', stderr: '', command: cmd };
                }

                if (cmd[0] === 'list-windows' && cmd.includes('#{window_index}')) {
                    return { returncode: 0, stdout: '1\n2\n3\n', stderr: '', command: cmd };
                }

                if (cmd[0] === 'new-window') {
                    this.newWindowAttempts += 1;
                    const targetIndex = cmd.indexOf('-t');
                    if (targetIndex >= 0 && targetIndex + 1 < cmd.length) {
                        this.newWindowTargets.push(cmd[targetIndex + 1]!);
                    }

                    if (this.newWindowAttempts === 1) {
                        return { returncode: 1, stdout: '', stderr: 'create window failed: index 1 in use.', command: cmd };
                    }

                    return { returncode: 0, stdout: '4242\n', stderr: '', command: cmd };
                }

                if (cmd[0] === 'kill-window') {
                    const targetIndex = cmd.indexOf('-t');
                    if (targetIndex >= 0 && targetIndex + 1 < cmd.length) {
                        this.killWindowTargets.push(cmd[targetIndex + 1]!);
                    }
                }

                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
        }

        const tmux = new BaseIndexOneTmuxUtilities();
        const result = await tmux.spawnInTmux(['echo', 'hello'], { sessionName: 'my-session', windowName: 'my-window' }, {});

        expect(result.success).toBe(true);
        expect(tmux.newWindowTargets).toEqual(['my-session', 'my-session:4']);
        expect(tmux.killWindowTargets).toEqual(['my-session:1']);
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

describe('TmuxUtilities.getWindowIndices', () => {
    class FakeTmuxWithWindowIndices extends TmuxUtilities {
        public override async executeTmuxCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
            if (cmd[0] === 'list-windows') {
                return { returncode: 0, stdout: '0\n2\n5\n', stderr: '', command: cmd };
            }
            return { returncode: 0, stdout: '', stderr: '', command: cmd };
        }
    }

    it('returns a set of window indices', async () => {
        const tmux = new FakeTmuxWithWindowIndices();
        const indices = await tmux.getWindowIndices('my-session');
        expect(indices).toEqual(new Set([0, 2, 5]));
    });
});

describe('TmuxUtilities.findAvailableWindowIndex', () => {
    class FakeTmuxWithNoWindows extends TmuxUtilities {
        public override async executeTmuxCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
            if (cmd[0] === 'list-windows') {
                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
            return { returncode: 0, stdout: '', stderr: '', command: cmd };
        }
    }

    class FakeTmuxWithWindows extends TmuxUtilities {
        private windowIndices: number[];

        constructor(indices: number[]) {
            super('test');
            this.windowIndices = indices;
        }

        public override async executeTmuxCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
            if (cmd[0] === 'list-windows') {
                const stdout = this.windowIndices.join('\n');
                return { returncode: 0, stdout, stderr: '', command: cmd };
            }
            return { returncode: 0, stdout: '', stderr: '', command: cmd };
        }
    }

    it('returns 0 when session has no windows', async () => {
        const tmux = new FakeTmuxWithNoWindows();
        const index = await tmux.findAvailableWindowIndex('my-session');
        expect(index).toBe(0);
    });

    it('finds first gap in window indices', async () => {
        const tmux = new FakeTmuxWithWindows([0, 1, 3]); // gap at 2
        const index = await tmux.findAvailableWindowIndex('my-session');
        expect(index).toBe(2);
    });

    it('returns next index when no gaps', async () => {
        const tmux = new FakeTmuxWithWindows([0, 1, 2]);
        const index = await tmux.findAvailableWindowIndex('my-session');
        expect(index).toBe(3);
    });

    it('finds gap at start when index 0 is missing', async () => {
        const tmux = new FakeTmuxWithWindows([1, 2, 3]);
        const index = await tmux.findAvailableWindowIndex('my-session');
        expect(index).toBe(0);
    });

    it('starts from tmux base-index when configured above zero', async () => {
        class BaseIndexOneNoWindowsTmux extends TmuxUtilities {
            public override async executeTmuxCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
                if (cmd[0] === 'show-options' && cmd.includes('base-index')) {
                    return { returncode: 0, stdout: '1\n', stderr: '', command: cmd };
                }

                if (cmd[0] === 'list-windows') {
                    return { returncode: 0, stdout: '1\n2\n3\n', stderr: '', command: cmd };
                }

                return { returncode: 0, stdout: '', stderr: '', command: cmd };
            }
        }

        const tmux = new BaseIndexOneNoWindowsTmux();
        const index = await tmux.findAvailableWindowIndex('my-session');
        expect(index).toBe(4);
    });
});
