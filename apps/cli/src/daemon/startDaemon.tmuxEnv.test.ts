import { describe, it, expect } from 'vitest';

describe('daemon tmux env building', () => {
    it('keeps only essential daemon env keys and profile overrides for tmux windows', async () => {
        const spawnConfigModule = (await import('@/daemon/platform/tmux/spawnConfig')) as typeof import('@/daemon/platform/tmux/spawnConfig');
        const merged = spawnConfigModule.buildTmuxWindowEnv(
            { PATH: '/bin', HOME: '/home/user', TSX_TSCONFIG_PATH: '/tmp/tsconfig.json', AWS_SESSION_TOKEN: 'secret', UNDEFINED: undefined },
            { HOME: '/override', CUSTOM: 'x' }
        );

        expect(merged.PATH).toBe('/bin');
        expect(merged.HOME).toBe('/override');
        expect(merged.TSX_TSCONFIG_PATH).toBe('/tmp/tsconfig.json');
        expect(merged.CUSTOM).toBe('x');
        expect('AWS_SESSION_TOKEN' in merged).toBe(false);
        expect('UNDEFINED' in merged).toBe(false);
    }, 10000);

    it('preserves Windows Path casing for tmux windows', async () => {
        const spawnConfigModule = (await import('@/daemon/platform/tmux/spawnConfig')) as typeof import('@/daemon/platform/tmux/spawnConfig');
        const merged = spawnConfigModule.buildTmuxWindowEnv(
            { Path: 'C:\\Windows\\System32', HOME: 'C:\\Users\\tester', PATH: undefined },
            {},
            'win32',
        );

        expect(merged.Path).toBe('C:\\Windows\\System32');
        expect('PATH' in merged).toBe(false);
    }, 10000);

    it('applies case-insensitive unsets before explicit tmux window values', async () => {
        const spawnConfigModule = (await import('@/daemon/platform/tmux/spawnConfig')) as typeof import('@/daemon/platform/tmux/spawnConfig');
        const merged = spawnConfigModule.buildTmuxWindowEnv(
            { HOME: '/ambient-home', PATH: '/bin' },
            { HOME: '/explicit-home', EMPTY: '' },
            process.platform,
            ['home'],
        );

        expect(merged).toEqual({ PATH: '/bin', HOME: '/explicit-home', EMPTY: '' });
    }, 10000);
});
