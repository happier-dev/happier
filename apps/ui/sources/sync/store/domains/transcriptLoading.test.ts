import { describe, expect, it } from 'vitest';

import { createTranscriptLoadingDomain, type TranscriptLoadingDomain } from './transcriptLoading';

/**
 * Minimal in-memory harness mirroring the zustand set/get contract so the domain
 * can be exercised without the full storage store. This tests the REAL domain
 * reducer/action logic (no internal mocks) per repo testing rules.
 */
function createHarness() {
    let state = {} as TranscriptLoadingDomain;
    const set = (partial: TranscriptLoadingDomain | Partial<TranscriptLoadingDomain> | ((s: TranscriptLoadingDomain) => TranscriptLoadingDomain | Partial<TranscriptLoadingDomain>)) => {
        const next = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...next };
    };
    const get = () => state;
    state = createTranscriptLoadingDomain<TranscriptLoadingDomain>({ set, get });
    return { get };
}

describe('transcriptLoading domain', () => {
    it('fails closed: unknown session is not catching up', () => {
        const { get } = createHarness();
        expect(get().isSessionCatchingUpNewer('unknown-session')).toBe(false);
        expect(get().isSessionCatchingUpNewer('')).toBe(false);
    });

    it('flips true while a catch-up is in flight and false once settled', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
    });

    it('ref-counts overlapping catch-ups so the signal only settles when all finish', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);

        // First flow settles, but a second overlapping flow is still running.
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);

        // Last flow settles -> signal clears.
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
    });

    it('keeps per-session counts isolated', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);
        expect(get().isSessionCatchingUpNewer('s2')).toBe(false);
    });

    it('never drops below zero on an unbalanced end (fail-closed, no negative counts)', () => {
        const { get } = createHarness();
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
        get().beginSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(true);
        get().endSessionCatchUpNewer('s1');
        expect(get().isSessionCatchingUpNewer('s1')).toBe(false);
    });

    it('prunes settled sessions from the in-flight map (no unbounded growth)', () => {
        const { get } = createHarness();
        get().beginSessionCatchUpNewer('s1');
        get().endSessionCatchUpNewer('s1');
        expect(Object.keys(get().sessionCatchUpNewerInFlight)).not.toContain('s1');
    });
});
