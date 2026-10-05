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
    it('keeps a dismissible failure reachable even without a recovery action', () => {
        expect(resolveVoiceAttemptControl({
            ...base, status: 'error', surfaceState: 'error', sessionId: 'failed-session',
            startAdmitted: false, canDismissFailedAttempt: true,
        })).toMatchObject({ availability: 'recoverable', primaryAction: null, canDismissFailedAttempt: true });
        expect(resolveVoiceAttemptControl({
            ...base, status: 'connected', canStop: true, canDismissFailedAttempt: true,
        }).canDismissFailedAttempt).toBe(false);
    });
    it('projects shared session work and attention independently of listening media', () => {
        const listening = { ...base, status: 'connected' as const, surfaceState: 'listening' as const, canStop: true };
        expect(resolveVoiceAttemptControl({ ...listening, sessionStatus: { state: 'thinking', statusText: 'Working' } }))
            .toMatchObject({ statusCell: 'working', primaryAction: 'end' });
        expect(resolveVoiceAttemptControl({ ...listening, sessionStatus: { state: 'permission_required', statusText: 'Needs you' } }))
            .toMatchObject({ statusCell: 'needs_you', primaryAction: 'end' });
        expect(resolveVoiceAttemptControl({ ...base, sessionStatus: { state: 'thinking', statusText: 'Working' } }))
            .toMatchObject({ statusCell: null });
    });
    it('projects a still mic at rest and distinct eclipse/recovery/live poses without changing End authority', () => {
        expect(resolveVoiceAttemptControl(base)).toMatchObject({ markPose: 'mic', statusCell: null });
        expect(resolveVoiceAttemptControl({ ...base, status: 'connecting', surfaceState: 'connecting', canStop: true }))
            .toMatchObject({ markPose: 'shadow', primaryAction: 'end' });
        expect(resolveVoiceAttemptControl({ ...base, status: 'connected', surfaceState: 'thinking', canStop: true, sessionId: 'session-1' }))
            .toMatchObject({ markPose: 'light', statusCell: 'thinking', primaryAction: 'end' });
        expect(resolveVoiceAttemptControl({ ...base, status: 'error', surfaceState: 'permission_required', hasRecovery: true, startAdmitted: false }))
            .toMatchObject({ markPose: 'blocked', primaryAction: 'recover' });
    });

    it.each([
        { status: 'connected' as const, sessionId: 'session-1', canCommitInput: true, expected: true },
        { status: 'connected' as const, sessionId: 'session-1', canCommitInput: false, expected: false },
        { status: 'disconnected' as const, sessionId: 'session-1', canCommitInput: true, expected: false },
        { status: 'connected' as const, sessionId: null, canCommitInput: true, expected: false },
    ])('publishes input submission only for an admitted connected attempt ($status, $canCommitInput, $sessionId)', ({ status, sessionId, canCommitInput, expected }) => {
        expect(resolveVoiceAttemptControl({
            ...base,
            status,
            sessionId,
            canStop: status === 'connected',
            canCommitInput,
        }).canCommitInput).toBe(expected);
    });

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
     * Voice is discoverable before it works: an idle Voice that is switched on but cannot start yet
     * (nothing set up, or a provider that cannot run here) still shows its rest mic, and the mic's
     * one action is to open Voice setup. Only a live attempt that can do nothing stays unavailable.
     */
    it('offers setup, not nothing, for an idle Voice that cannot start yet', () => {
        expect(resolveVoiceAttemptControl({
            ...base,
            startAdmitted: false,
            hasRecovery: false,
            setupOffered: true,
        })).toMatchObject({ availability: 'setup', primaryAction: 'setup', canStart: false, markPose: 'mic' });
        // A recovery the user can act on still wins over generic setup.
        expect(resolveVoiceAttemptControl({ ...base, startAdmitted: false, hasRecovery: true, setupOffered: true }))
            .toMatchObject({ availability: 'recoverable', primaryAction: 'recover' });
        // A live attempt with nothing to do is not a rest mic.
        expect(resolveVoiceAttemptControl({
            ...base, status: 'error', surfaceState: 'error', tone: 'error', sessionId: 'session-1',
            startAdmitted: false, hasRecovery: false, setupOffered: true,
        })).toMatchObject({ availability: 'unavailable', primaryAction: null });
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
