import { describe, expect, it } from 'vitest';

import { normalizeSessionListServerScope } from './normalizeSessionListServerScope';

describe('normalizeSessionListServerScope', () => {
    it('trims the server fields and collapses blank ids to null', () => {
        const first = normalizeSessionListServerScope('  server-a  ', '  Server A  ');
        const second = normalizeSessionListServerScope('server-a', 'Server A');

        expect(first).toBe(second);
        expect(first).toEqual({
            serverId: 'server-a',
            serverName: 'Server A',
        });

        const blankFirst = normalizeSessionListServerScope('   ', '   ');
        const blankSecond = normalizeSessionListServerScope('', null);

        expect(blankFirst).toBe(blankSecond);
        expect(blankFirst).toEqual({
            serverId: null,
            serverName: null,
        });
    });
});
