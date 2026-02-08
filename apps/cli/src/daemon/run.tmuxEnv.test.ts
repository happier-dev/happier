import { describe, it, expect } from 'vitest';

describe('daemon tmux env building', () => {
    it('keeps only essential daemon env keys and profile overrides for tmux windows', async () => {
        const spawnConfigModule = (await import('@/daemon/platform/tmux/spawnConfig')) as typeof import('@/daemon/platform/tmux/spawnConfig');
        const merged = spawnConfigModule.buildTmuxWindowEnv(
            { PATH: '/bin', HOME: '/home/user', AWS_SESSION_TOKEN: 'secret', UNDEFINED: undefined },
            { HOME: '/override', CUSTOM: 'x' }
        );

        expect(merged.PATH).toBe('/bin');
        expect(merged.HOME).toBe('/override');
        expect(merged.CUSTOM).toBe('x');
        expect('AWS_SESSION_TOKEN' in merged).toBe(false);
        expect('UNDEFINED' in merged).toBe(false);
    }, 10000);
});
