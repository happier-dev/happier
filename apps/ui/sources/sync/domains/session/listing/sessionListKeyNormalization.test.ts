import { describe, expect, it } from 'vitest';

import {
    EMPTY_SESSION_LIST_SERVER_KEY,
    normalizeSessionListKeyParts,
    normalizeSessionListServerKey,
    normalizeSessionListSessionKey,
} from './sessionListKeyNormalization';

describe('sessionListKeyNormalization', () => {
    it('normalizes server and session keys from the same canonical parts helper', () => {
        const parts = normalizeSessionListKeyParts('  server-a  ', '  session-1  ');

        expect(parts).toEqual({
            serverId: 'server-a',
            sessionId: 'session-1',
            serverKey: 'server-a',
            sessionKey: 'server-a:session-1',
        });
        expect(normalizeSessionListServerKey('  server-a  ')).toBe('server-a');
        expect(normalizeSessionListSessionKey('  server-a  ', '  session-1  ')).toBe('server-a:session-1');
    });

    it('reuses the shared empty server key and omits invalid session keys', () => {
        const parts = normalizeSessionListKeyParts('   ', '   ');

        expect(parts).toEqual({
            serverId: '',
            sessionId: '',
            serverKey: EMPTY_SESSION_LIST_SERVER_KEY,
            sessionKey: null,
        });
    });
});
