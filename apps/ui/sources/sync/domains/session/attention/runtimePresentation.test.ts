import { describe, expect, it } from 'vitest';

import {
    deriveSessionRuntimePresentationState,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from './runtimePresentation';

describe('deriveSessionRuntimePresentationState', () => {
    it('treats a fresh in-progress turn projection as working without legacy presence evidence', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            nowMs,
            active: false,
            activeAt: 0,
            presence: 'offline',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - 1_000,
        });

        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.freshThinking).toBe(false);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.attention).toBe('working');
    });

    it('falls back to fresh legacy thinking when no turn projection is available', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
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
        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.attention).toBe('working');
    });

    it('extends stale in-progress projection from a fresh active heartbeat', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        expect(runtimeState.freshInProgress).toBe(true);
        expect(runtimeState.working).toBe(true);
        expect(runtimeState.attention).toBe('working');
    });

    it('does not extend stale in-progress projection from a stale active heartbeat', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            nowMs,
            active: true,
            activeAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            presence: 'online',
            thinking: true,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.attention).toBe('idle');
    });

    it('does not keep an in-progress turn working from newer meaningful activity alone', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
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

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.attention).toBe('idle');
    });

    it('does not refresh an in-progress turn from older transcript activity', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
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

        expect(runtimeState.freshInProgress).toBe(false);
        expect(runtimeState.working).toBe(false);
        expect(runtimeState.attention).toBe('idle');
    });

    it('does not let older legacy thinking override a newer terminal projection', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
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
        expect(runtimeState.attention).toBe('idle');
    });

    it('treats a completed turn projection as authoritative over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
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
        expect(runtimeState.attention).toBe('idle');
    });

    it('treats a failed turn projection as failed attention over newer legacy thinking', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
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
        expect(runtimeState.attention).toBe('failed');
    });

    it('keeps pending permission attention while the pending request is fresh', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: nowMs - 1_000,
        });

        expect(runtimeState.freshPermissionRequired).toBe(true);
        expect(runtimeState.attention).toBe('permission_required');
    });

    it('does not keep stale pending attention without active work', () => {
        const nowMs = 1_000_000;
        const runtimeState = deriveSessionRuntimePresentationState({
            nowMs,
            active: true,
            activeAt: nowMs - 1_000,
            presence: 'online',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: nowMs - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
        });

        expect(runtimeState.freshPermissionRequired).toBe(false);
        expect(runtimeState.freshActionRequired).toBe(false);
        expect(runtimeState.attention).toBe('idle');
    });
});
