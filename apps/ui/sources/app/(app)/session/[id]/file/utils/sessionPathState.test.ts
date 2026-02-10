import { describe, expect, it } from 'vitest';

import { resolveSessionPathState } from './sessionPathState';

describe('resolveSessionPathState', () => {
    it('waits for session data when sessions are not ready and path is missing', () => {
        const result = resolveSessionPathState({
            sessionId: 'session-1',
            sessionPath: null,
            sessionsReady: false,
        });

        expect(result.status).toBe('waiting');
        expect(result.error).toBeNull();
    });

    it('returns an error once sessions are ready but the path is still missing', () => {
        const result = resolveSessionPathState({
            sessionId: 'session-1',
            sessionPath: null,
            sessionsReady: true,
        });

        expect(result.status).toBe('error');
        expect(result.error).toBe('Session path is unavailable');
    });

    it('returns ready when the session path is available', () => {
        const result = resolveSessionPathState({
            sessionId: 'session-1',
            sessionPath: '/tmp/repo',
            sessionsReady: true,
        });

        expect(result.status).toBe('ready');
        expect(result.error).toBeNull();
    });
});
