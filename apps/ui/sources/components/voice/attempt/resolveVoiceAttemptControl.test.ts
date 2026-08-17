import { describe, expect, it } from 'vitest';

import { resolveVoiceAttemptControl } from './resolveVoiceAttemptControl';

const base = {
    surfaceState: 'idle' as const,
    tone: 'neutral' as const,
    status: 'disconnected' as const,
    sessionId: null as string | null,
    canStop: false,
    muted: false,
    capturing: false,
    startAdmitted: true,
    hasRecovery: false,
};

/**
 * The availability ladder decides whether a floating transport renders at all, so each rung has to
 * be distinguishable: "ready" invites a tap, "recoverable" routes it somewhere useful, and
 * "unavailable" must not put a dead control on screen.
 *
 * Admission itself is **not** decided here — `resolveVoiceStartAdmission` owns it for every
 * surface, and `useVoiceAttemptControl.test.tsx` proves the orb and the surface model reach the
 * same answer. This projection only routes it.
 */
describe('resolveVoiceAttemptControl', () => {
    it('is ready to start when the canonical owner admits a start', () => {
        expect(resolveVoiceAttemptControl(base)).toMatchObject({
            availability: 'ready',
            live: false,
            canStart: true,
            canStop: false,
            canMute: false,
        });
    });

    it('mirrors a running attempt rather than offering a second start', () => {
        const control = resolveVoiceAttemptControl({
            ...base,
            status: 'connected',
            surfaceState: 'listening',
            tone: 'active',
            sessionId: 'session-1',
            canStop: true,
        });

        expect(control).toMatchObject({
            availability: 'ready',
            live: true,
            canStart: false,
            canStop: true,
            canMute: true,
            capturing: false,
            sessionId: 'session-1',
        });
    });

    it('stays present but recoverable when starting is impossible and a recovery exists', () => {
        expect(resolveVoiceAttemptControl({
            ...base,
            startAdmitted: false,
            hasRecovery: true,
        })).toMatchObject({ availability: 'recoverable', canStart: false });
    });

    it('is terminally unavailable when nothing can be started and nothing can be recovered', () => {
        expect(resolveVoiceAttemptControl({
            ...base,
            startAdmitted: false,
            hasRecovery: false,
        })).toMatchObject({ availability: 'unavailable', canStart: false });
    });

    /**
     * The rung that was being skipped: an errored attempt is still *visually* an attempt
     * (`status: 'error'` is not `disconnected`), and reading presence as readiness published
     * `ready`. Nothing could be stopped and nothing could be started, so the surface rendered an
     * enabled transport whose press the lifecycle owner refused — §2.2's dead control, one rung
     * above the one the orb already guards.
     */
    it('does not call an errored attempt ready just because an attempt exists', () => {
        const control = resolveVoiceAttemptControl({
            ...base,
            status: 'error',
            surfaceState: 'error',
            tone: 'error',
            sessionId: 'session-1',
            canStop: false,
            startAdmitted: false,
            hasRecovery: true,
        });

        expect(control.live).toBe(true);
        expect(control).toMatchObject({
            availability: 'recoverable',
            canStart: false,
            canStop: false,
        });
    });

    it('is unavailable in an error with no recovery, rather than a live-looking no-op', () => {
        expect(resolveVoiceAttemptControl({
            ...base,
            status: 'error',
            surfaceState: 'error',
            tone: 'error',
            sessionId: 'session-1',
            canStop: false,
            startAdmitted: false,
            hasRecovery: false,
        })).toMatchObject({ availability: 'unavailable', live: true, canStop: false });
    });

    it('stays ready while an attempt is still connecting, because ending it is actionable', () => {
        // `deriveLocalVoiceSessionSnapshot` publishes `canStop: true` from `connecting` onward, so
        // the actionable ladder must not blink the transport out during the connect.
        expect(resolveVoiceAttemptControl({
            ...base,
            status: 'connecting',
            surfaceState: 'connecting',
            sessionId: 'session-1',
            canStop: true,
            startAdmitted: false,
        })).toMatchObject({ availability: 'ready', live: true, canStop: true });
    });

    it('gives every surface the same light stop for a state', () => {
        expect(resolveVoiceAttemptControl({ ...base, surfaceState: 'thinking' }).stop).toBe('violet');
        expect(resolveVoiceAttemptControl({ ...base, surfaceState: 'speaking' }).stop).toBe('warm');
        expect(resolveVoiceAttemptControl({ ...base, surfaceState: 'interrupted' }).stop).toBe('blush');
    });
});
