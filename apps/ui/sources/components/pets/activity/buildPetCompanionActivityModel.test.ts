import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { createSessionFixture } from '@/dev/testkit';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';

describe('buildPetCompanionActivityModel', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses wall-clock time to expire stale activity when nowMs is omitted', () => {
        vi.spyOn(Date, 'now').mockReturnValue(4_000_000);
        const session = createSessionFixture({
            id: 'stale-failed-session',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('maps projected failed turn status to failed activity', () => {
        const session = createSessionFixture({
            id: 'turn-failed-session',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 2_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 3_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'failed',
            reason: 'failed',
            sessionId: session.id,
        });
    });

    it('does not map stale runtime issue audit data to failed activity after a non-failed turn', () => {
        const runtimeIssue: SessionRuntimeIssueV1 = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'agent_session_error',
            source: 'agent_session_error',
            occurredAt: 2_000,
        };
        const session = createSessionFixture({
            id: 'runtime-issue-session',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 2_000,
            lastRuntimeIssue: runtimeIssue,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 3_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('ignores historical transcript failure signals after the projected turn recovers', () => {
        const session = createSessionFixture({
            id: 'recovered-session',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 3_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: 4_000,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: true,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('keeps projected running activity live until a terminal projection arrives', () => {
        const signalAtMs = 1_000;
        const session = createSessionFixture({
            id: 'running-expiry-session',
            active: true,
            activeAt: signalAtMs,
            thinking: true,
            thinkingAt: signalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: signalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: signalAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1,
        });

        expect(model).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
        expect(model.trayItems[0]).toEqual(expect.objectContaining({
            status: 'running',
            expiresAtMs: null,
        }));
    });

    it('keeps projected running activity alive regardless of heartbeat freshness', () => {
        const staleSignalAtMs = 1_000;
        const activeAtMs = 50_000;
        const session = createSessionFixture({
            id: 'running-heartbeat-session',
            active: true,
            activeAt: activeAtMs,
            meaningfulActivityAt: activeAtMs + 5_000,
            thinking: true,
            thinkingAt: staleSignalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: staleSignalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: activeAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1,
        });

        expect(model).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
    });

    it('keeps projected running activity alive without meaningful activity freshness', () => {
        const nowMs = 1_000_000;
        const session = createSessionFixture({
            id: 'running-meaningful-activity-session',
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            meaningfulActivityAt: nowMs - 1_000,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs,
        });

        expect(model).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
    });

    it('does not keep waiting activity alive from active heartbeat alone', () => {
        const nowMs = 1_000_000;
        const session = createSessionFixture({
            id: 'waiting-heartbeat-only-session',
            active: true,
            activeAt: nowMs - 1_000,
            pendingPermissionRequestCount: 1,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs,
        });

        expect(model).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('keeps running tray items live across timestamp-only updates', () => {
        const signalAtMs = 10_000;
        const session = createSessionFixture({
            id: 'running-live-session',
            active: true,
            activeAt: signalAtMs,
            thinking: true,
            thinkingAt: signalAtMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: signalAtMs,
        });

        const model = buildPetCompanionActivityModel({
            sessions: [session],
            nowMs: signalAtMs + 1,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: signalAtMs,
                    latestMeaningfulActivityAtMs: signalAtMs,
                    lastMessageSubtitle: 'A live stream update',
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model.trayItems[0]).toEqual(expect.objectContaining({
            status: 'running',
            dismissKey: `running:${session.id}:live`,
            activityAtMs: null,
            subtitle: null,
        }));
    });

    it('ignores background activity while preserving foreground running behavior', () => {
        const nowMs = 1_000_000;
        const background = createSessionFixture({
            id: 'background-session',
            active: true,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        });
        const foreground = createSessionFixture({
            id: 'foreground-session',
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs - 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1,
        });

        expect(buildPetCompanionActivityModel({
            sessions: [background],
            nowMs,
        })).toMatchObject({ state: 'idle', trayItems: [] });
        expect(buildPetCompanionActivityModel({
            sessions: [foreground],
            nowMs,
        })).toMatchObject({ state: 'running', sessionId: foreground.id });
    });
});
