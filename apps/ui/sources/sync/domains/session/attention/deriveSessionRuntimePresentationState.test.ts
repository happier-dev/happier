import { describe, expect, it } from 'vitest';

import {
    deriveSessionRuntimePresentationState,
    resolveNextSessionRuntimePresentationFreshnessAtMs,
} from './deriveSessionRuntimePresentationState';

describe('deriveSessionRuntimePresentationState', () => {
    const nowMs = 1_000_000;

    it('gives a foreground in-progress turn precedence over background activity', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 1,
            runtimeActivityRevision: 7,
        }, nowMs)).toMatchObject({
            working: true,
            backgroundActive: false,
            activityState: 'working',
        });
    });

    it('lets an unwitnessed active projection go quiet, and asks for no clock wake once it has', () => {
        // Was: "keeps runtime activity background-active through arbitrary silence". That contract
        // is what made an `active` published moments before an unwitnessed CLI death render as
        // background work forever. It goes quiet instead — and once quiet there is nothing left to
        // expire, so the calm-clock half of the original decision still holds.
        const input = {
            active: false,
            presence: 1,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: 1,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1,
            runtimeActivityRevision: 7,
        };

        expect(deriveSessionRuntimePresentationState(input, Number.MAX_SAFE_INTEGER)).toMatchObject({
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
        expect(resolveNextSessionRuntimePresentationFreshnessAtMs(input, Number.MAX_SAFE_INTEGER)).toBeNull();
    });

    it('stops attesting background activity once the runtime is no longer live', () => {
        // The unwitnessed death (SIGKILL / OOM / laptop sleep): nobody was alive to publish
        // anything, so the last `active` projection stands forever. The client is the only party
        // that can notice, and it notices by asking whether the runtime that made the claim is
        // still there — never by asserting a status the protocol has not been told.
        expect(deriveSessionRuntimePresentationState({
            active: false,
            presence: 'offline',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 5_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 7,
        }, nowMs)).toMatchObject({
            freshProviderRuntimeActivity: false,
            backgroundActive: false,
            backgroundActiveCount: 0,
            activityState: 'idle',
        });
    });

    it('stops attesting background activity once every observation of it has aged out', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 300_000,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 400_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: nowMs - 300_000,
            runtimeActivityRevision: 7,
        }, nowMs)).toMatchObject({
            freshProviderRuntimeActivity: false,
            backgroundActive: false,
            backgroundActiveCount: 0,
            activityState: 'idle',
        });
    });

    it('keeps long-running background work active while the runtime heartbeat still witnesses it', () => {
        // The projection instant is NOT a heartbeat: the server rewrites it only when the
        // (state, count) pair changes, so an hour-old `observedAt` is the normal shape of work that
        // has been running for an hour. Gating on that instant alone would mark live work dead,
        // which is worse than the bug. The session keep-alive (15 s idle cadence) is the signal
        // that proves the publisher is still there.
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 15_000,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 3_600_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: nowMs - 3_600_000,
            runtimeActivityRevision: 7,
        }, nowMs)).toMatchObject({
            freshProviderRuntimeActivity: true,
            backgroundActive: true,
            backgroundActiveCount: 2,
            activityState: 'backgroundActive',
        });
    });

    it('arms a freshness wake so a background-active session re-derives when its evidence expires', () => {
        const input = {
            active: true,
            activeAt: nowMs - 15_000,
            presence: 'online',
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: nowMs - 3_600_000,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 3_600_000,
            runtimeActivityRevision: 7,
        };

        expect(deriveSessionRuntimePresentationState(input, nowMs).backgroundActive).toBe(true);
        expect(resolveNextSessionRuntimePresentationFreshnessAtMs(input, nowMs)).toBe(nowMs - 15_000 + 120_000);
    });

    it('keeps unknown runtime activity quiet', () => {
        expect(deriveSessionRuntimePresentationState({
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 8,
        }, nowMs)).toMatchObject({
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
    });

    it('carries the attested active count through the background-active state', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 15_000,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 3,
            runtimeActivityObservedAt: nowMs - 20_000,
            runtimeActivityRevision: 7,
        }, nowMs)).toMatchObject({
            backgroundActive: true,
            backgroundActiveCount: 3,
        });
    });

    it('claims no background count while a foreground turn owns the session', () => {
        // The count is only about work running WITHOUT a turn in flight. Reporting it during a
        // foreground turn would let a surface say "2 running in background" over a working session.
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 1,
            runtimeActivityRevision: 7,
        }, nowMs)).toMatchObject({
            backgroundActive: false,
            backgroundActiveCount: 0,
        });
    });

    it('presents canonical idle as calm idle', () => {
        expect(deriveSessionRuntimePresentationState({
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 100,
            runtimeActivityRevision: 9,
        }, nowMs)).toMatchObject({
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
    });

    it('fails inconsistent downstream projection fields closed to quiet idle', () => {
        expect(deriveSessionRuntimePresentationState({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 0,
        }, nowMs).activityState).toBe('idle');
    });

    it('does not read sourceClass or let it classify runtime activity as foreground work', () => {
        const input = {
            active: true,
            activeAt: nowMs - 15_000,
            presence: 'online',
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 20_000,
            get runtimeActivitySourceClass(): never {
                throw new Error('runtime presentation must not read sourceClass');
            },
        };

        expect(deriveSessionRuntimePresentationState(input, nowMs)).toMatchObject({
            freshProviderRuntimeActivity: true,
            working: false,
            backgroundActive: true,
            activityState: 'backgroundActive',
        });
    });

    it('keeps terminal turn state authoritative over legacy thinking', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
        }, nowMs).working).toBe(false);
    });

    it('keeps pending permission attention foreground-freshness-owned', () => {
        expect(deriveSessionRuntimePresentationState({
            active: true,
            presence: 'online',
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: nowMs - 1,
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
        }, nowMs).freshPermissionRequired).toBe(true);
    });

    it('never presents archived sessions as foreground or background work', () => {
        expect(deriveSessionRuntimePresentationState({
            archivedAt: nowMs,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        }, nowMs)).toMatchObject({
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
    });
});
