import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { AgentEvent } from '@/sync/typesRaw';

import { TranscriptEventRow } from './TranscriptEventRow';

const executeDefaultAction = vi.fn();
const modalConfirm = vi.fn();
const modalAlert = vi.fn();

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: (...args: unknown[]) => executeDefaultAction(...args),
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => 'server-1',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: (...args: unknown[]) => modalConfirm(...args),
            alert: (...args: unknown[]) => modalAlert(...args),
        },
    }).module;
});

describe('TranscriptEventRow', () => {
    beforeEach(() => {
        executeDefaultAction.mockReset();
        executeDefaultAction.mockResolvedValue({ ok: true, result: { ok: true, status: 'cleared', sessionId: 's1' } });
        modalConfirm.mockReset();
        modalConfirm.mockResolvedValue(true);
        modalAlert.mockReset();
    });

    it('offers to clear the terminal composer for typed terminal draft blocked events', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                sessionId="s1"
                event={{
                    type: 'terminal-composer-draft-blocked',
                    reason: 'idle_draft_guard',
                    stateAtMs: 1234,
                    message: 'Terminal draft blocked delivery.',
                } as unknown as AgentEvent}
            />,
        );

        expect(screen.findByProps({ testID: 'transcript-event-terminal-composer-draft-blocked' })).toBeTruthy();
        expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeTruthy();

        await screen.pressByTestIdAsync('transcriptEvent.clearTerminalComposer');

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(executeDefaultAction).toHaveBeenCalledWith(
            'session.terminalComposer.clear',
            { sessionId: 's1', expectedStateAtMs: 1234 },
            { defaultSessionId: 's1', surface: 'ui', placement: 'pending_messages' },
        );
        expect(modalAlert).not.toHaveBeenCalled();
    });

    it('offers to clear the terminal composer for legacy passive terminal draft notices', async () => {
        const legacyMessages = [
            "Your queued message can't steer the running turn: the terminal composer holds an unsent draft. Clear the draft in the terminal (or interrupt the turn) to deliver it.",
            'Your queued message is waiting: the terminal composer holds an unsent draft. Clear the draft in the terminal to deliver it.',
        ];

        for (const message of legacyMessages) {
            const screen = await renderScreen(
                <TranscriptEventRow
                    sessionId="s1"
                    event={{ type: 'message', message }}
                />,
            );

            expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeTruthy();
        }
    });

    it('does not offer terminal composer clearing when the transcript row has no session id', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'terminal-composer-draft-blocked',
                    reason: 'idle_draft_guard',
                    stateAtMs: 1234,
                    message: 'Terminal draft blocked delivery.',
                } as unknown as AgentEvent}
            />,
        );

        expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeNull();
    });

    it('renders structured context compaction events', async () => {
        const started = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'pi:context-compaction',
                    provider: 'pi',
                }}
            />,
        );

        expect(started.findByProps({ testID: 'transcript-event-context-compaction-started' })).toBeTruthy();

        const completed = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'pi:context-compaction',
                    provider: 'pi',
                }}
            />,
        );

        expect(completed.findByProps({ testID: 'transcript-event-context-compaction-completed' })).toBeTruthy();

        const paused = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'pi:context-compaction',
                    provider: 'pi',
                    continuation: 'paused',
                    pauseReason: 'provider-idle-after-compaction',
                }}
            />,
        );

        expect(paused.findByProps({ testID: 'transcript-event-context-compaction-paused' })).toBeTruthy();
    });

    it('renders structured connected-service account switch events', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch',
                    serviceId: 'openai-codex',
                    groupId: 'codex-main',
                    groupLabel: 'Happier',
                    fromProfileId: 'work',
                    toProfileId: 'backup',
                    fromProfileLabel: 'team@happier.dev',
                    toProfileLabel: 'leeroy.brun@gmail.com',
                    reason: 'usage_limit',
                    mode: 'hot_apply',
                    effectiveRemainingPct: 12,
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'session-event-connected-service-account-switch' })).toBeTruthy();
        expect(serialized).toContain('Switched Codex group Happier from team@happier.dev to leeroy.brun@gmail.com');
        expect(serialized).not.toContain('from group');
        expect(serialized).not.toContain('to profile');
    });

    it('renders event-carried switch selection labels instead of raw profile ids (P7 identity display)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch',
                    serviceId: 'claude-subscription',
                    groupId: 'team-pool',
                    fromProfileId: 'batiplus',
                    toProfileId: 'batiplus',
                    fromProfileLabel: 'leeroy',
                    toProfileLabel: 'leeroy',
                    reason: 'usage_limit',
                    mode: 'restart_resume',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'session-event-connected-service-account-switch' })).toBeTruthy();
        expect(serialized).toContain('leeroy');
        expect(serialized).not.toContain('batiplus');
    });

    it('renders native connected-service account switch sides without leaking null labels', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch',
                    serviceId: 'openai-codex',
                    groupId: 'happier',
                    fromProfileId: null,
                    toProfileId: 'team',
                    reason: 'manual',
                    mode: 'restart_resume',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        const nativeLabel = t('connectedServices.authChip.nativeLabel');
        expect(screen.findByProps({ testID: 'session-event-connected-service-account-switch' })).toBeTruthy();
        expect(serialized).toContain(nativeLabel);
        expect(serialized).not.toContain('from null');
    });

    it('renders structured provider quota wait and recovered events', async () => {
        const waiting = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'provider-quota-wait',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    groupId: 'codex-main',
                    resetAtMs: 1_000,
                    reason: 'usage_limit',
                }}
            />,
        );

        expect(waiting.findByProps({ testID: 'transcript-event-provider-quota-wait' })).toBeTruthy();

        const recovered = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'provider-quota-recovered',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    groupId: 'codex-main',
                    reason: 'reset_confirmed',
                }}
            />,
        );

        expect(recovered.findByProps({ testID: 'transcript-event-provider-quota-recovered' })).toBeTruthy();
    });

    it('O1: renders connected-service-account-switch-attempt events without falling back to Unknown event', async () => {
        const okRestart = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'restart_requested',
                }}
            />,
        );
        expect(okRestart.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(JSON.stringify(okRestart.tree.toJSON())).not.toContain('Unknown event');

        const failed = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'restart_requested',
                    errorCode: 'provider_session_state_unavailable_for_resume',
                }}
            />,
        );
        expect(failed.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(JSON.stringify(failed.tree.toJSON())).not.toContain('Unknown event');
    });

    it('renders direct live switch attempts without restart copy', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'hot_applied',
                    attemptedContinuityMode: 'hot_apply',
                    outcome: 'succeeded',
                    outcomeAction: 'hot_applied',
                    partialState: 'runtime_auth_applied',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain('Authentication switched in the running session');
        expect(serialized).not.toContain('Restarting session');
        expect(serialized).not.toContain('Switch authentication');
    });

    it('renders credential refresh or recycle attempts distinctly from restart-resume', async () => {
        const credentialRefresh = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'hot_applied',
                    attemptedContinuityMode: 'credential_refresh',
                    outcome: 'succeeded',
                    outcomeAction: 'credential_refreshed',
                    partialState: 'runtime_auth_applied',
                }}
            />,
        );
        const restartResume = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'restart_requested',
                    attemptedContinuityMode: 'restart',
                    outcome: 'succeeded',
                    outcomeAction: 'restarted',
                    groupGeneration: 2,
                    sessionAdoption: 'applied',
                }}
            />,
        );

        const refreshSerialized = JSON.stringify(credentialRefresh.tree.toJSON());
        const restartSerialized = JSON.stringify(restartResume.tree.toJSON());
        expect(refreshSerialized).toContain('Authentication refreshed');
        expect(refreshSerialized).not.toContain('Restarting session');
        expect(restartSerialized).toContain('Restarting session');
    });

    it('renders connected-service account switch attempt diagnostics through the shared presentation mapping', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'hot_applied',
                    errorCode: 'provider_account_adoption_mismatch',
                    diagnostic: {
                        code: 'provider_account_adoption_mismatch',
                        failurePhase: 'post_switch_verification',
                        source: 'transcript_switch_attempt',
                        serviceId: 'openai-codex',
                        agentId: 'codex',
                        retryable: true,
                        suggestedActions: ['retry', 'open_connected_accounts'],
                    },
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.diagnostics.status.provider_account_adoption_mismatch'));
        expect(serialized).not.toContain('provider_account_adoption_mismatch)');
    });

    it('falls back safely for future switch attempt diagnostics with an error code', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'hot_applied',
                    outcome: 'failed',
                    outcomeAction: 'none',
                    errorCode: 'live_hot_auth_failed',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain('Authentication could not be switched for this session. (live_hot_auth_failed)');
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders observed-only switch attempts as neutral instead of successful adoption', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: true,
                    action: 'metadata_updated',
                    attemptedContinuityMode: 'metadata_only',
                    outcome: 'observed',
                    outcomeAction: 'metadata_updated',
                    groupGeneration: 2,
                    sessionAdoption: 'observed_only',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain('information-circle-outline');
        expect(serialized).not.toContain('checkmark-circle-outline');
        expect(serialized).toContain(t('connectedServices.authSwitch.status.appliesOnNextResume'));
    });

    it('renders typed runtime-auth recovery transcript events', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-runtime-auth-recovery',
                    status: 'retry_scheduled',
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    groupId: 'team',
                    attempt: 2,
                    nextRetryAtMs: 1_700_000_010_000,
                    terminal: false,
                    diagnostic: {
                        code: 'recovery_retry_scheduled',
                        failurePhase: 'runtime_auth_recovery',
                        source: 'runtime_auth_recovery',
                        serviceId: 'openai-codex',
                        agentId: 'codex',
                        retryable: true,
                        suggestedActions: ['retry'],
                    },
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-runtime-auth-recovery' })).toBeTruthy();
        expect(serialized).toContain('time-outline');
        expect(serialized).toContain(t('connectedServices.diagnostics.status.recovery_retry_scheduled'));
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('O1: renders connected-service-account-switch-deferral events without falling back to Unknown event', async () => {
        const deferred = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral',
                    policy: 'defer_until_idle',
                    awaitingBoundary: false,
                    timeoutMs: 60_000,
                }}
            />,
        );
        expect(deferred.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral' })).toBeTruthy();
        expect(JSON.stringify(deferred.tree.toJSON())).not.toContain('Unknown event');
    });

    it('O1: renders connected-service-account-switch-deferral-completed events without falling back to Unknown event', async () => {
        const completed = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-completed',
                    policy: 'defer_until_turn_boundary',
                    reason: 'turn_boundary_reached',
                }}
            />,
        );
        expect(completed.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-completed' })).toBeTruthy();
        expect(JSON.stringify(completed.tree.toJSON())).not.toContain('Unknown event');

        const cancelled = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-completed',
                    reason: 'aborted_after_timeout',
                }}
            />,
        );
        expect(cancelled.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-completed' })).toBeTruthy();
        expect(JSON.stringify(cancelled.tree.toJSON())).not.toContain('Unknown event');
    });

    it('O1: renders connected-service-account-switch-deferral-superseded events without falling back to Unknown event', async () => {
        const superseded = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-superseded',
                }}
            />,
        );
        expect(superseded.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-superseded' })).toBeTruthy();
        expect(JSON.stringify(superseded.tree.toJSON())).not.toContain('Unknown event');
    });

    it('O1: renders provider-state-sharing-degraded events without falling back to Unknown event', async () => {
        const degraded = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'provider-state-sharing-degraded',
                    serviceId: 'pi',
                    code: 'import_partial',
                    requestedStateMode: 'full',
                    effectiveStateMode: 'partial',
                }}
            />,
        );
        expect(degraded.findByProps({ testID: 'transcript-event-provider-state-sharing-degraded' })).toBeTruthy();
        expect(JSON.stringify(degraded.tree.toJSON())).not.toContain('Unknown event');
    });
});

describe('TranscriptEventRow runtime-config-outcome', () => {
    const baseEvent = {
        type: 'runtime-config-outcome' as const,
        runtime: 'claude-unified-terminal',
        message: 'Model change scheduled',
    };

    it('renders all five frozen statuses with per-status testIDs', async () => {
        for (const status of ['applied', 'requires_restart', 'requires_interactive_control', 'unsupported', 'failed'] as const) {
            const screen = await renderScreen(
                <TranscriptEventRow event={{ ...baseEvent, status }} />,
            );
            expect(screen.findByProps({ testID: `transcript-event-runtime-config-outcome-${status}` })).toBeTruthy();
        }
    });

    it('renders pending timing as a calm secondary detail line', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{ ...baseEvent, status: 'applied', timing: 'before_next_prompt' }}
            />,
        );
        const detail = screen.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' });
        expect(detail).toBeTruthy();
        expect(JSON.stringify(detail.props.children)).toContain(t('message.runtimeConfigOutcomeAppliesBeforeNextMessage'));
    });

    it('renders queued and already-set timings', async () => {
        const queued = await renderScreen(
            <TranscriptEventRow
                event={{ ...baseEvent, status: 'applied', timing: 'queued_until_safe_window' }}
            />,
        );
        expect(JSON.stringify(
            queued.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' }).props.children,
        )).toContain(t('message.runtimeConfigOutcomeQueuedUntilReady'));

        const alreadySet = await renderScreen(
            <TranscriptEventRow
                event={{ ...baseEvent, status: 'applied', timing: 'skipped_already_effective' }}
            />,
        );
        expect(JSON.stringify(
            alreadySet.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' }).props.children,
        )).toContain(t('message.runtimeConfigOutcomeAlreadySet'));
    });

    it('renders friendly per-change copy with values instead of the raw CLI message (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'applied',
                    changes: [{ key: 'reasoningEffort' as const, requested: 'medium', effective: 'medium' }],
                }}
            />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain(t('message.runtimeConfigOutcomeKeyReasoningEffort'));
        expect(body).toContain('Medium');
        expect(body).not.toContain('Model change scheduled');
    });

    it('prefixes non-applied statuses and renders boolean values as On/Off (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'requires_interactive_control',
                    changes: [{ key: 'launchOption' as const, requested: true, reason: 'ultracode' }],
                }}
            />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain(t('message.runtimeConfigOutcomeRequiresInteractiveControl'));
        expect(body).toContain(t('message.runtimeConfigOutcomeKeyLaunchOption'));
        expect(body).toContain(t('common.on'));
    });

    it('keeps model ids verbatim and humanizes enum-ish tokens (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'applied',
                    changes: [
                        { key: 'model' as const, effective: 'claude-sonnet-4-6[1m]' },
                        { key: 'permissionMode' as const, effective: 'acceptEdits' },
                    ],
                }}
            />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain('claude-sonnet-4-6[1m]');
        expect(body).toContain('Accept edits');
    });

    it('falls back to the event message when changes carry no values (L4)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={{ ...baseEvent, status: 'applied' }} />,
        );
        const body = JSON.stringify(screen.tree.toJSON());
        expect(body).toContain('Model change scheduled');
    });

    it('labels a sessionMode change as a first-class sub-state', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    ...baseEvent,
                    status: 'applied',
                    changes: [{ key: 'sessionMode' as const, requested: 'plan' }],
                }}
            />,
        );
        const detail = screen.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' });
        expect(JSON.stringify(detail.props.children)).toContain(t('message.runtimeConfigOutcomeSessionMode'));
        expect(JSON.stringify(detail.props.children)).toContain('plan');
    });
});
