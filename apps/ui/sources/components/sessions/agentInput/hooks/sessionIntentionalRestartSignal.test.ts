import { describe, expect, it } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { AgentEvent } from "@happier-dev/session-core/raw";

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

    it('keeps unresolved restart signals non-terminal until positive failure evidence arrives', () => {
        expect(resolveSessionIntentionalRestartState({
            signals: [{
                status: 'restarting',
                attemptId: 'manual-auth-switch:1',
                reason: 'manual_auth_switch',
                startedAtMs: 1_000,
            }],
        })).toEqual({
            status: 'restarting',
            attemptId: 'manual-auth-switch:1',
            reason: 'manual_auth_switch',
            startedAtMs: 1_000,
        });
    });

    it.each(['failed', 'terminal'] as const)('projects a typed %s attempt over an older usage-limit restart', (outcome) => {
        const signals = deriveSessionIntentionalRestartSignals({
            runtimeIssue: {
                v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
                occurredAt: 1_000, agentId: 'codex',
                usageLimit: { v: 1, resetAtMs: null, retryAfterMs: null, quotaScope: 'account', recoverability: 'switch_account', recoveryDecision: 'switching' },
            },
            events: [{ createdAtMs: 2_000, event: {
                type: 'connected-service-account-switch-attempt', ok: false, action: 'restart_requested',
                attemptedContinuityMode: 'restart', outcome,
            } }],
        });
        expect(resolveSessionIntentionalRestartState({ signals })?.status).toBe('failed');
    });

    it.each([
        { activeAt: 2_500 },
        { latestReadyEventAt: 2_500 },
        { latestTurnStatus: 'completed', latestTurnStatusObservedAt: 2_500 },
    ])('clears failed restart state only on newer recovery evidence: %j', (evidence) => {
        const signal = { status: 'failed', attemptId: 'switch:failed', reason: 'manual_auth_switch', startedAtMs: 2_000 } as const;
        expect(resolveSessionIntentionalRestartState({
            signals: [signal], recoveryEvidenceAtMs: resolveSessionIntentionalRestartRecoveryEvidenceAtMs(evidence),
        })).toBeNull();
        expect(resolveSessionIntentionalRestartState({ signals: [signal], recoveryEvidenceAtMs: 1_999 })).toBe(signal);
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

    it('retains restart intent through a scheduled retry instead of interpreting it as failure', () => {
        expect(deriveSessionIntentionalRestartSignals({ runtimeIssue: null, events: [
            { createdAtMs: 1_000, event: {
                type: 'connected-service-account-switch', serviceId: 'openai-codex', groupId: null,
                fromProfileId: null, toProfileId: 'backup', reason: 'manual', mode: 'restart_resume',
            } },
            { createdAtMs: 2_000, event: {
                type: 'connected-service-account-switch-attempt', ok: false, action: 'restart_requested', outcome: 'scheduled_retry',
            } },
        ] })).toEqual([expect.objectContaining({ status: 'restarting', startedAtMs: 1_000 })]);
    });

    it('does not turn a failed hot apply into a restart failure', () => {
        expect(deriveSessionIntentionalRestartSignals({ runtimeIssue: null, events: [{ createdAtMs: 2_000, event: {
            type: 'connected-service-account-switch-attempt', ok: false, action: 'hot_applied',
            attemptedContinuityMode: 'hot_apply', outcome: 'failed',
        } }] })).toEqual([]);
    });

    it('allows a new manual restart after an older failed attempt', () => {
        const newerManual = { status: 'restarting', attemptId: 'manual:2', reason: 'manual_auth_switch', startedAtMs: 3_000 } as const;
        expect(resolveSessionIntentionalRestartState({ signals: [newerManual, {
            status: 'failed', attemptId: 'old:1', reason: 'runtime_auth_recovery', startedAtMs: 2_000,
        }] })).toBe(newerManual);
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

        expect(resolveSessionIntentionalRestartState({
            signals: deriveSessionIntentionalRestartSignals({
                runtimeIssue: null,
                events: [{ event: switchEvent, createdAtMs: 2_000 }],
            }),
            recoveryEvidenceAtMs: 2_500,
        })).toBeNull();
    });
});
