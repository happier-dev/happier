import { describe, expect, it } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import type { AgentEvent } from '@/sync/typesRaw';

import {
    deriveSessionIntentionalRestartSignals,
    resolveSessionIntentionalRestartRecoveryEvidenceAtMs,
    resolveSessionIntentionalRestartState,
} from './sessionIntentionalRestartSignal';

describe('sessionIntentionalRestartSignal', () => {
    it('treats newer active-session evidence as restart recovery evidence', () => {
        expect(resolveSessionIntentionalRestartRecoveryEvidenceAtMs({
            activeAt: 2_500,
            latestReadyEventAt: null,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_500,
            meaningfulActivityAt: 1_000,
        })).toBe(2_500);
    });

    it('does not treat generic meaningful activity as restart recovery evidence', () => {
        expect(resolveSessionIntentionalRestartRecoveryEvidenceAtMs({
            activeAt: null,
            latestReadyEventAt: null,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 1_500,
            meaningfulActivityAt: 2_500,
        })).toBeNull();
    });

    it('keeps elapsed restart signals non-terminal until positive failure evidence arrives', () => {
        expect(resolveSessionIntentionalRestartState({
            signals: [{
                status: 'restarting',
                attemptId: 'manual-auth-switch:1',
                reason: 'manual_auth_switch',
                startedAtMs: 1_000,
            }],
            nowMs: 10_000,
            failsafeMs: 1_000,
        })).toEqual({
            status: 'pending_confirmation',
            attemptId: 'manual-auth-switch:1',
            reason: 'manual_auth_switch',
            startedAtMs: 1_000,
        });
    });

    it('projects usage-limit switching into a shared restart signal', () => {
        const issue: SessionRuntimeIssueV1 = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: null,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'switch_account',
                recoveryDecision: 'switching',
            },
        };

        expect(deriveSessionIntentionalRestartSignals({
            runtimeIssue: issue,
            events: [],
        })).toEqual([{
            status: 'restarting',
            attemptId: 'usage-limit-account-switch:1000',
            reason: 'usage_limit_account_switch',
            startedAtMs: 1_000,
        }]);
    });

    it.each([
        ['usage_limit', 'usage_limit_account_switch'],
        ['soft_threshold', 'usage_limit_account_switch'],
        ['auth_expired', 'runtime_auth_recovery'],
        ['account_changed', 'runtime_auth_recovery'],
        ['refresh_failure', 'refresh_auth_update'],
        ['manual', 'manual_auth_switch'],
    ] as const)('projects restart-resume account-switch event reason %s', (eventReason, signalReason) => {
        const event: AgentEvent = {
            type: 'connected-service-account-switch',
            serviceId: 'openai-codex',
            groupId: 'primary',
            fromProfileId: 'work',
            toProfileId: 'backup',
            reason: eventReason,
            mode: 'restart_resume',
        };

        expect(deriveSessionIntentionalRestartSignals({
            runtimeIssue: null,
            events: [{ event, createdAtMs: 2_000 }],
        })).toEqual([{
            status: 'restarting',
            attemptId: `connected-service-account-switch:${eventReason}:2000`,
            reason: signalReason,
            startedAtMs: 2_000,
        }]);
    });

    it('does not keep projecting a restart-resume switch event after newer recovery evidence', () => {
        const switchEvent: AgentEvent = {
            type: 'connected-service-account-switch',
            serviceId: 'openai-codex',
            groupId: 'primary',
            fromProfileId: 'work',
            toProfileId: 'backup',
            reason: 'usage_limit',
            mode: 'restart_resume',
        };

        expect(deriveSessionIntentionalRestartSignals({
            runtimeIssue: null,
            events: [
                { event: switchEvent, createdAtMs: 2_000 },
            ],
            recoveryEvidenceAtMs: 2_500,
        })).toEqual([]);
    });
});
