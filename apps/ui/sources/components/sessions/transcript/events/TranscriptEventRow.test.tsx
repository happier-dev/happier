import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

import { TranscriptEventRow } from './TranscriptEventRow';

describe('TranscriptEventRow', () => {
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
                    fromProfileId: 'work',
                    toProfileId: 'backup',
                    reason: 'usage_limit',
                    mode: 'hot_apply',
                    effectiveRemainingPct: 12,
                }}
            />,
        );

        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'session-event-connected-service-account-switch' })).toBeTruthy();
    });

    it('renders event-carried switch endpoint labels instead of raw profile ids (P7 identity display)', async () => {
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

    it('renders native connected-service account switch endpoints without leaking null labels', async () => {
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
