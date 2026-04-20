import { describe, expect, it } from 'vitest';

import { rememberCodexRemoteSessionIdForResume } from './rememberSessionIdForResume';

describe('rememberCodexRemoteSessionIdForResume', () => {
    it('stores the current remote session id and clears terminal-mode ownership', () => {
        let storedSessionIdForResume: string | null = null;
        let storedSessionIdFromLocalControl = true;

        const updated = rememberCodexRemoteSessionIdForResume({
            getRemoteSessionId: () => 'thread-123',
            setStoredSessionIdForResume: (next: string) => {
                storedSessionIdForResume = next;
            },
            setStoredSessionIdFromLocalControl: (next: boolean) => {
                storedSessionIdFromLocalControl = next;
            },
        });

        expect(updated).toBe(true);
        expect(storedSessionIdForResume).toBe('thread-123');
        expect(storedSessionIdFromLocalControl).toBe(false);
    });

    it('leaves the existing resume state untouched when there is no remote session id', () => {
        let storedSessionIdForResume: string | null = 'resume-keep';
        let storedSessionIdFromLocalControl = true;

        const updated = rememberCodexRemoteSessionIdForResume({
            getRemoteSessionId: () => null,
            setStoredSessionIdForResume: (next: string) => {
                storedSessionIdForResume = next;
            },
            setStoredSessionIdFromLocalControl: (next: boolean) => {
                storedSessionIdFromLocalControl = next;
            },
        });

        expect(updated).toBe(false);
        expect(storedSessionIdForResume).toBe('resume-keep');
        expect(storedSessionIdFromLocalControl).toBe(true);
    });
});
