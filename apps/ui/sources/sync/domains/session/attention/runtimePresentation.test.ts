import { describe, expect, it } from 'vitest';
import {
    projectUiSessionRuntimeAwareness,
    readSessionRuntimePresentationFreshnessExpirations,
    SESSION_OPTIMISTIC_PENDING_THINKING_MS,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from './runtimePresentation';

describe('projectUiSessionRuntimeAwareness', () => {
    it('keeps an online Session live without per-beat activity: the server publishes online/offline transitions', () => {
        const nowMs = 10_000_000;
        // 2026-11-04 heartbeat ruling applied to Sessions: active→active beats are
        // not delivered, so activeAt is the online transition time, not a clock.
        const input = { active: true, activeAt: nowMs - 10 * SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS, presence: 'online' as const };
        expect(projectUiSessionRuntimeAwareness({ nowMs, ...input }).freshness).toBe('live');
        expect(readSessionRuntimePresentationFreshnessExpirations(input, nowMs)).toEqual([]);
    });

    it('preserves unknown runtime evidence independently of operational activity', () => {
        const result = projectUiSessionRuntimeAwareness({ nowMs: 1_000_000 });
        expect(result).toMatchObject({ runtime: 'unknown', freshness: 'unknown' });
    });

    it('treats a fresh in-progress turn projection as working without legacy presence evidence', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: false,
            activeAt: 0,
            presence: 'offline',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
        });

        expect(runtimeState.projectedTurnInProgress).toBe(true);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('falls back to fresh legacy thinking when no turn projection is available', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
        });

        expect(runtimeState.freshThinking).toBe(true);
        expect(runtimeState.projectedTurnInProgress).toBe(false);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('treats a fresh pending outbound user turn as working while optimistic thinking is fresh', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            optimisticThinkingAt: nowMs - 1_000,
            hasPendingUserMessages: true,
        });

        expect(runtimeState.working).toBe(true);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('reports optimistic pending user turns with the optimistic freshness expiration', () => {
        const nowMs = 1_000_000;
        const optimisticThinkingAt = nowMs - 1_000;
        const expirations = readSessionRuntimePresentationFreshnessExpirations({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            optimisticThinkingAt,
            hasPendingUserMessages: true,
        }, nowMs);

        expect(expirations).toEqual([
            optimisticThinkingAt + SESSION_OPTIMISTIC_PENDING_THINKING_MS,
        ]);
    });

    it('keeps a canonical in-progress turn in the foreground over background activity', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 9,
        });

        expect(runtimeState.projectedTurnInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.backgroundActive).toBe(false);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('keeps a canonical in-progress turn working until an explicit terminal projection arrives', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        expect(runtimeState.projectedTurnInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('does not require newer meaningful activity to keep a projected turn working', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: 0,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - 1_000,
        });

        expect(runtimeState.projectedTurnInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('treats provider runtime activity as background active without foreground turn progress', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 20_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 10_000,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 7,
        });

        expect(runtimeState.projectedTurnInProgress).toBe(false);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.backgroundActive).toBe(true);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.operational.primary).toBe('none');
    });

    it('keeps foreground working precedence over provider runtime activity', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 20_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 8,
        });

        expect(runtimeState.projectedTurnInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.backgroundActive).toBe(false);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('uses canonical active state without owner-liveness or clock freshness', () => {
        const nowMs = 1_000_000;
        expect(projectUiSessionRuntimeAwareness({
            nowMs,
            active: false,
            presence: 0,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 120_000,
            runtimeActivityRevision: 9,
        }).backgroundActive).toBe(true);
    });

    it('treats canonical unknown runtime activity as inactive even while owner presence is fresh', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: nowMs - 120_000,
            runtimeActivityRevision: 10,
        });

        expect(runtimeState.backgroundActive).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.operational.primary).toBe('none');
    });

    it('does not let fresh owner presence alone create provider runtime activity', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 11,
        });

        expect(runtimeState.working).toBe(false);
        expect(runtimeState.operational.primary).toBe('none');
    });

    it('does not schedule a clock wake-up for canonical runtime activity', () => {
        const nowMs = 1_000_000;

        const expirations = readSessionRuntimePresentationFreshnessExpirations({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 120_000,
            runtimeActivityRevision: 12,
        }, nowMs);

        expect(expirations).toEqual([]);
    });

    it('does not schedule a clock wake-up to expire a canonical active turn', () => {
        const nowMs = 1_000_000;

        const expirations = readSessionRuntimePresentationFreshnessExpirations({
            nowMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
        }, nowMs);

        expect(expirations).toEqual([]);
    });

    it('keeps canonical active runtime activity with a nullable observed timestamp', () => {
        const nowMs = 1_000_000;
        expect(projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            presence: 'online',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 13,
        }).backgroundActive).toBe(true);
    });

    it('does not read sourceClass or let it classify provider activity as foreground work', () => {
        const nowMs = 1_000_000;
        const input = {
            nowMs,
            active: true,
            presence: 'online',
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 14,
        };

        expect(projectUiSessionRuntimeAwareness(input)).toMatchObject({
            working: false,
            backgroundActive: true,
            operational: { primary: 'none' },
        });
    });

    it('suppresses foreground and background runtime presentation for archived sessions', () => {
        const nowMs = 1_000_000;

        expect(projectUiSessionRuntimeAwareness({
            nowMs,
            archivedAt: nowMs - 1,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        })).toMatchObject({
            projectedTurnInProgress: false,
            working: false,
            backgroundActive: false,
            operational: { primary: 'none' },
        });
    });

    it('does not require transcript freshness to keep a projected turn working', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 2_000,
        });

        expect(runtimeState.projectedTurnInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.operational.primary).toBe('working');
    });

    it('does not let older legacy thinking override a newer terminal projection', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 2_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 1_000,
        });

        expect(runtimeState.hasTerminalPrimaryTurnProjection).toBe(true);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.operational.primary).toBe('ready');
    });

    it('treats a completed turn projection as authoritative over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        });

        expect(runtimeState.hasTerminalPrimaryTurnProjection).toBe(true);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.operational.primary).toBe('ready');
    });

    it('treats a failed turn projection as failed attention over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1_000,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: nowMs - 2_000,
        });

        expect(runtimeState.hasTerminalPrimaryTurnProjection).toBe(true);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.operational.primary).toBe('failed');
    });

    it('keeps pending permission attention while the pending request is fresh', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: nowMs - 1_000,
        });

        expect(runtimeState.freshPermissionRequired).toBe(true);
        expect(runtimeState.operational.primary).toBe('permission_required');
        expect(readSessionRuntimePresentationFreshnessExpirations({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: nowMs - 1_000,
        }, nowMs)).toEqual([]);
    });

    it('keeps permission attention while the runtime is live, however long the request has waited', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        expect(runtimeState.freshPermissionRequired).toBe(true);
        expect(runtimeState.operational.primary).toBe('permission_required');
        expect(readSessionRuntimePresentationFreshnessExpirations({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        }, nowMs)).toEqual([]);
    });

    it('keeps user-action attention while the runtime is live, however long the request has waited', () => {
        const nowMs = 1_000_000;
        const runtimeState = projectUiSessionRuntimeAwareness({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        expect(runtimeState.freshActionRequired).toBe(true);
        expect(runtimeState.operational.primary).toBe('action_required');
    });
});
