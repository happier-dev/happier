import { describe, expect, it } from 'vitest';

import { buildPullArgs, buildPushArgs } from './remoteArgs';

describe('sapling remote args', () => {
    it('builds update pull args using branch shorthand', () => {
        expect(buildPullArgs({ remote: 'origin', branch: 'main' }, true)).toEqual({
            ok: true,
            args: ['pull', '--update', '--dest', 'origin/main', 'origin'],
        });
    });

    it('returns INVALID_REQUEST-style error when update pull has no destination', () => {
        expect(buildPullArgs({ remote: 'origin' }, true)).toEqual({
            ok: false,
            error: 'Branch is required for sapling pull updates',
        });
    });

    it('builds non-update pull args without requiring branch', () => {
        expect(buildPullArgs({ remote: 'origin' }, false)).toEqual({
            ok: true,
            args: ['pull', 'origin'],
        });
    });

    it('builds push args with destination branch', () => {
        expect(buildPushArgs({ remote: 'origin', branch: 'main' })).toEqual(['push', '--to', 'main', 'origin']);
    });
});
