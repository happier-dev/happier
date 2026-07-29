import { describe, expect, it } from 'vitest';

import {
    clearSessionTranscriptDerivedCachesForSession,
    registerSessionTranscriptDerivedCacheClear,
} from './sessionTranscriptDerivedCaches';

describe('sessionTranscriptDerivedCaches', () => {
    it('fans a session release out to every registered cache clearer', () => {
        const first = new Map<string, string>([['s1', 'a'], ['s2', 'b']]);
        const second = new Map<string, string>([['s1', 'c']]);

        const unregisterFirst = registerSessionTranscriptDerivedCacheClear((sessionId) => {
            first.delete(sessionId);
        });
        const unregisterSecond = registerSessionTranscriptDerivedCacheClear((sessionId) => {
            second.delete(sessionId);
        });

        try {
            clearSessionTranscriptDerivedCachesForSession('s1');
            expect(first.has('s1')).toBe(false);
            expect(second.has('s1')).toBe(false);
            expect(first.get('s2')).toBe('b');
        } finally {
            unregisterFirst();
            unregisterSecond();
        }
    });

    it('stops invoking a clearer after it unregisters', () => {
        const cache = new Map<string, string>([['s1', 'a']]);
        const unregister = registerSessionTranscriptDerivedCacheClear((sessionId) => {
            cache.delete(sessionId);
        });
        unregister();

        clearSessionTranscriptDerivedCachesForSession('s1');
        expect(cache.get('s1')).toBe('a');
    });
});
