import { ActivityIndicator, StyleSheet } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { rawRecordSchema, type AgentEvent } from '@/sync/typesRaw/schemas';
import { t } from '@/text';

import { TranscriptEventRow } from './TranscriptEventRow';

const eventRowMocks = vi.hoisted(() => ({
    actionExecute: vi.fn(),
    modalAlert: vi.fn(),
    modalConfirm: vi.fn(),
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: (...args: unknown[]) => eventRowMocks.actionExecute(...args),
    }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: unknown[]) => eventRowMocks.modalAlert(...args),
        confirm: (...args: unknown[]) => eventRowMocks.modalConfirm(...args),
    },
}));

function parseProtocolValidAgentEvent<T extends AgentEvent>(event: T): T {
    const parsed = rawRecordSchema.safeParse({
        role: 'agent',
        content: {
            type: 'event',
            id: `event-${event.type}`,
            data: event,
        },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected protocol-valid transcript event');
    const content = parsed.data.content;
    if (content.type !== 'event') throw new Error('expected event content');
    expect(content.data.type).toBe(event.type);
    if (content.data.type !== event.type) throw new Error('expected matching event type');
    return content.data as T;
}

describe('TranscriptEventRow', () => {
    beforeEach(() => {
        eventRowMocks.actionExecute.mockReset();
        eventRowMocks.actionExecute.mockResolvedValue({ ok: true, result: { ok: true, status: 'cleared' } });
        eventRowMocks.modalAlert.mockReset();
        eventRowMocks.modalConfirm.mockReset();
        eventRowMocks.modalConfirm.mockResolvedValue(true);
    });

    it('renders typed terminal composer draft blocked events with the clear-composer action', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'terminal-composer-draft-blocked',
            reason: 'idle_draft_guard',
            stateAtMs: 1781788925696,
            message: 'Your queued message is waiting: the terminal composer holds an unsent draft.',
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
                sessionId="session-1"
            />,
        );

        expect(screen.findByProps({ testID: 'transcript-event-terminal-composer-draft-blocked' })).toBeTruthy();
        expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeTruthy();

        await screen.pressByTestIdAsync('transcriptEvent.clearTerminalComposer');

        expect(eventRowMocks.modalConfirm).toHaveBeenCalledTimes(1);
        expect(eventRowMocks.actionExecute).toHaveBeenCalledWith(
            'session.terminalComposer.clear',
            { sessionId: 'session-1', expectedStateAtMs: 1781788925696 },
            expect.objectContaining({ defaultSessionId: 'session-1', surface: 'ui_button' }),
        );
    });

    it('renders legacy terminal composer draft session messages with the clear-composer action', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'message',
            message: 'Your queued message is waiting: the terminal composer holds an unsent draft. Clear the draft in the terminal to deliver it.',
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
                sessionId="session-1"
            />,
        );

        expect(screen.findByTestId('transcriptEvent.clearTerminalComposer')).toBeTruthy();
    });

    it('derives started context compaction loading from the phase', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'compact_1',
                    provider: 'codex',
                }}
            />,
        );

        expect(screen.findByType(ActivityIndicator)).toBeTruthy();
        expect(screen.findByProps({ testID: 'transcript-event-context-compaction-started' })).toBeTruthy();
    });

    it('renders completed context compaction events as a persisted event row', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'compact_1',
                    provider: 'codex',
                }}
            />,
        );

        expect(() => screen.findByType(ActivityIndicator)).toThrow();
        expect(screen.findByProps({ testID: 'transcript-event-context-compaction-completed' })).toBeTruthy();
    });

    it('renders paused context compaction events as a distinct persisted event row', async () => {
        const screen = await renderScreen(
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

        expect(() => screen.findByType(ActivityIndicator)).toThrow();
        expect(screen.findByProps({ testID: 'transcript-event-context-compaction-paused' })).toBeTruthy();
    });

    it('renders cancelled context compaction events without loading state', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'context-compaction',
                    phase: 'cancelled',
                    lifecycleId: 'compact_1',
                    provider: 'pi',
                    source: 'provider-event',
                }}
            />,
        );

        expect(() => screen.findByType(ActivityIndicator)).toThrow();
        expect(screen.findByProps({ testID: 'transcript-event-context-compaction-cancelled' })).toBeTruthy();
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

    it('renders runtime config outcomes as structured persisted event rows', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'requires_restart',
            reason: 'unified_terminal_launch_options_changed',
            message: 'Claude unified terminal is already running. Model changes apply when Claude restarts.',
            changes: [
                { key: 'model', requested: 'claude-opus-4-7', previous: 'claude-opus-4-6' },
            ],
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        expect(screen.findByProps({ testID: 'transcript-event-runtime-config-outcome-requires_restart' })).toBeTruthy();
        // L4: changes with values render as friendly label → value copy, not the raw CLI message.
        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(t('message.runtimeConfigOutcomeKeyModel'));
        expect(serialized).toContain('claude-opus-4-7');
        expect(serialized).toContain(t('message.runtimeConfigOutcomeRequiresRestart'));
    });

    // L4 (incident 2026-06-11): outcome copy must carry friendly per-change labels WITH values,
    // never the debug-grade "Applied … runtime controls: reasoningEffort, launchOption" string.
    it('renders applied changes as friendly label → value pairs', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'current_window',
            message: 'Applied Claude Unified runtime controls: reasoningEffort, permissionMode.',
            changes: [
                { key: 'reasoningEffort', requested: 'medium', effective: 'medium' },
                { key: 'permissionMode', requested: 'acceptEdits', effective: 'acceptEdits' },
            ],
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(`${t('message.runtimeConfigOutcomeKeyReasoningEffort')} → Medium`);
        expect(serialized).toContain(`${t('message.runtimeConfigOutcomeKeyPermissionMode')} → Accept edits`);
        expect(serialized).not.toContain('runtime controls');
    });

    it('renders failed changes with accurate failure copy and values', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'failed',
            message: 'Failed to apply Claude Unified runtime controls: reasoningEffort.',
            changes: [
                { key: 'reasoningEffort', requested: 'medium', reason: 'not_delivered' },
            ],
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(t('message.runtimeConfigOutcomeFailed'));
        expect(serialized).toContain(`${t('message.runtimeConfigOutcomeKeyReasoningEffort')} → Medium`);
        expect(serialized).toContain('warning');
    });

    it('mutes de-emphasized prior-era event rows without changing current-era failure rows', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'failed',
            message: 'Failed to apply Claude Unified runtime controls: reasoningEffort.',
            changes: [
                { key: 'reasoningEffort', requested: 'medium', reason: 'not_delivered' },
            ],
        } as AgentEvent);

        const mutedScreen = await renderScreen(<TranscriptEventRow event={event} emphasis="deemphasized" />);
        const normalScreen = await renderScreen(<TranscriptEventRow event={event} />);

        const mutedRow = mutedScreen.findByProps({ testID: 'transcript-event-runtime-config-outcome-failed' });
        const normalRow = normalScreen.findByProps({ testID: 'transcript-event-runtime-config-outcome-failed' });

        expect(StyleSheet.flatten(mutedRow.props.style)?.opacity).toBeLessThan(1);
        expect(StyleSheet.flatten(normalRow.props.style)?.opacity).toBeUndefined();
    });

    it('renders boolean and provider-echo change values readably', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'current_window',
            message: 'Applied Claude Unified runtime controls: launchOption.',
            changes: [
                { key: 'launchOption', requested: true, effective: 'ultracode' },
            ],
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(`${t('message.runtimeConfigOutcomeKeyLaunchOption')} → Ultracode`);
    });

    it('falls back to the event message when changes carry no values', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'unsupported',
            message: 'Some runtime config changes are unsupported for Claude Unified.',
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        expect(JSON.stringify(screen.tree.toJSON())).toContain('unsupported for Claude Unified');
    });

    it('renders every public runtime-config-outcome status with a status-specific test id', async () => {
        const statuses = ['applied', 'requires_restart', 'requires_interactive_control', 'unsupported', 'failed'] as const;
        for (const status of statuses) {
            const event = parseProtocolValidAgentEvent({
                type: 'runtime-config-outcome',
                provider: 'claude',
                runtime: 'claude-unified-terminal',
                status,
                message: `runtime outcome ${status}`,
            } as AgentEvent);

            const screen = await renderScreen(<TranscriptEventRow event={event} />);

            expect(screen.findByProps({ testID: `transcript-event-runtime-config-outcome-${status}` })).toBeTruthy();
            expect(JSON.stringify(screen.tree.toJSON())).toContain(`runtime outcome ${status}`);
        }
    });

    it('renders applied + scheduled timing as a non-alarming pending sub-state', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'scheduled_for_next_prompt',
            message: 'Model will change for your next message.',
            changes: [{ key: 'model', requested: 'claude-sonnet-4-5' }],
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(t('message.runtimeConfigOutcomeAppliesBeforeNextMessage'));
        // Pending timing must read as a calm time/info state, never an alarming warning.
        expect(serialized).toContain('clock');
        expect(serialized).not.toContain('warning');
        expect(screen.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' })).toBeTruthy();
    });

    it('renders applied + current window as an effective success without a pending sub-state', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'current_window',
            message: 'Permission mode is now plan.',
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain('check-circle');
        expect(serialized).not.toContain(t('message.runtimeConfigOutcomeAppliesBeforeNextMessage'));
        expect(serialized).not.toContain(t('message.runtimeConfigOutcomeQueuedUntilReady'));
    });

    it('renders applied + queued timing as a calm queued sub-state', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'queued_until_safe_window',
            message: 'Permission mode change is queued.',
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(t('message.runtimeConfigOutcomeQueuedUntilReady'));
        expect(serialized).toContain('clock');
        expect(serialized).not.toContain('warning');
    });

    it('renders applied + skipped-already-effective as an effective success', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'skipped_already_effective',
            message: 'Effort was already high.',
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(t('message.runtimeConfigOutcomeAlreadySet'));
        // Already-effective means it is set now, so keep the success checkmark, not a pending clock.
        expect(serialized).toContain('check-circle');
    });

    it('renders the sessionMode change key with a labelled sub-state', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'scheduled_for_next_prompt',
            message: 'Plan mode will apply on your next message.',
            changes: [{ key: 'sessionMode', requested: 'plan' }],
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(t('message.runtimeConfigOutcomeSessionMode'));
        expect(serialized).toContain('plan');
        expect(serialized).toContain(t('message.runtimeConfigOutcomeAppliesBeforeNextMessage'));
        expect(screen.findByProps({ testID: 'transcript-event-runtime-config-outcome-applied-detail' })).toBeTruthy();
    });

    it('keeps runtime-config-outcome text flexible so it wraps without overlapping the icon', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'runtime-config-outcome',
            provider: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied',
            timing: 'scheduled_for_next_prompt',
            message: 'A deliberately long runtime configuration outcome message that must wrap on narrow mobile widths without overlapping the status icon.',
            changes: [{ key: 'sessionMode', requested: 'plan' }],
        } as AgentEvent);

        const screen = await renderScreen(<TranscriptEventRow event={event} />);

        const body = screen.findByTestId('transcript-event-runtime-config-outcome-applied-body');
        expect(body).toBeTruthy();
        const style = body?.props?.style as Record<string, unknown> | undefined;
        // Layout-safe contract (not pixels): the text column shrinks below content width so the
        // message and detail wrap instead of overflowing into the fixed-width icon column.
        expect(style?.minWidth).toBe(0);
        expect(style?.flex === 1 || style?.flexShrink === 1).toBe(true);
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

    it('renders connected-service account switch attempt failures with error-code context', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'restart_requested',
                    errorCode: 'provider_session_state_unavailable_for_resume',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.authSwitch.switchFailed'));
        expect(serialized).toContain('provider_session_state_unavailable_for_resume');
    });

    it('renders connected-service account switch attempt diagnostics through the shared presentation mapping', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'connected-service-account-switch-attempt',
            ok: false,
            action: 'hot_applied',
            attemptedContinuityMode: 'hot_apply',
            outcome: 'failed',
            outcomeAction: 'none',
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
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.diagnostics.status.provider_account_adoption_mismatch'));
        expect(serialized).not.toContain('provider_account_adoption_mismatch)');
    });

    it('uses a precise diagnostic instead of raw unsupported-service switch failure context', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'connected-service-account-switch-attempt',
            ok: false,
            action: 'hot_applied',
            attemptedContinuityMode: 'hot_apply',
            outcome: 'failed',
            outcomeAction: 'none',
            errorCode: 'unsupported_service',
            diagnostic: {
                code: 'runtime_auth_recovery_superseded',
                failurePhase: 'runtime_auth_recovery',
                source: 'runtime_auth_recovery',
                serviceId: 'openai-codex',
                agentId: 'codex',
                retryable: false,
                suggestedActions: ['open_connected_accounts'],
                diagnostics: {
                    reason: 'generation_stale',
                },
            },
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.diagnostics.status.runtime_auth_recovery_superseded'));
        expect(serialized).not.toContain('unsupported_service');
    });

    it('uses explicit failed outcome fields before legacy successful switch-attempt actions', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'connected-service-account-switch-attempt',
            ok: false,
            action: 'hot_applied',
            attemptedContinuityMode: 'hot_apply',
            outcome: 'failed',
            outcomeAction: 'none',
            errorCode: 'hot_apply_failed',
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.authSwitch.switchFailed'));
        expect(serialized).toContain('hot_apply_failed');
        expect(serialized).not.toContain(t('connectedServices.authSwitch.confirmAction'));
    });

    it('renders direct live switch attempts as running-session auth switches, not restart or command copy', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'connected-service-account-switch-attempt',
            ok: true,
            action: 'hot_applied',
            attemptedContinuityMode: 'hot_apply',
            outcome: 'succeeded',
            outcomeAction: 'hot_applied',
            groupGeneration: 7,
            sessionAdoption: 'applied',
            sessionAdoptedGeneration: 7,
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain('Authentication switched in the running session');
        expect(serialized).not.toContain(t('connectedServices.authSwitch.status.restarting'));
        expect(serialized).not.toContain(t('connectedServices.authSwitch.confirmAction'));
    });

    it('renders credential-refresh switch attempts distinctly from restart-resume attempts', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'connected-service-account-switch-attempt',
            ok: true,
            action: 'restart_requested',
            attemptedContinuityMode: 'credential_refresh',
            outcome: 'observed',
            outcomeAction: 'credential_refreshed',
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain('Authentication refreshed');
        expect(serialized).not.toContain(t('connectedServices.authSwitch.status.restarting'));
    });

    it('renders an observed restart request as requested, not completed or a generic switch', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'connected-service-account-switch-attempt',
            ok: true,
            action: 'restart_requested',
            attemptedContinuityMode: 'restart',
            outcome: 'observed',
            outcomeAction: 'none',
            diagnostic: {
                code: 'connected_service_restart_requested',
                failurePhase: 'restart',
                source: 'transcript_switch_attempt',
                retryable: true,
                suggestedActions: [],
            },
        });

        const screen = await renderScreen(<TranscriptEventRow event={event} />);
        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain(t('connectedServices.diagnostics.status.connected_service_restart_requested'));
        expect(serialized).not.toContain(t('connectedServices.authSwitch.status.restarting'));
        expect(serialized).not.toContain(t('connectedServices.authSwitch.confirmAction'));
    });

    it('falls back safely for unknown connected-service switch diagnostics', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-attempt',
                    ok: false,
                    action: 'hot_applied',
                    attemptedContinuityMode: 'hot_apply',
                    outcome: 'failed',
                    outcomeAction: 'none',
                    errorCode: 'future_switch_phase_failed',
                    diagnostic: {
                        code: 'future_switch_phase_failed',
                        failurePhase: 'hot_apply',
                        source: 'transcript_switch_attempt',
                        serviceId: 'openai-codex',
                        agentId: 'codex',
                        retryable: false,
                        suggestedActions: ['open_connected_accounts'],
                    },
                } as unknown as AgentEvent}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.authSwitch.switchFailed'));
        expect(serialized).toContain('future_switch_phase_failed');
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders observed-only switch attempts as neutral observation, not successful adoption', async () => {
        const event = parseProtocolValidAgentEvent({
            type: 'connected-service-account-switch-attempt',
            ok: true,
            action: 'metadata_updated',
            attemptedContinuityMode: 'metadata_only',
            outcome: 'observed',
            outcomeAction: 'metadata_updated',
            groupGeneration: 12,
            sessionAdoption: 'observed_only',
        });

        const screen = await renderScreen(
            <TranscriptEventRow
                event={event}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-attempt' })).toBeTruthy();
        expect(serialized).toContain('info');
        expect(serialized).not.toContain('check-circle');
    });

    it('renders runtime-auth recovery retry events through the shared diagnostic presentation', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-runtime-auth-recovery',
                    status: 'retry_scheduled',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    attempt: 1,
                    nextRetryAtMs: 1_700_000_000_000,
                    diagnostic: {
                        code: 'recovery_retry_scheduled',
                        failurePhase: 'runtime_auth_recovery',
                        source: 'runtime_auth_recovery',
                        serviceId: 'openai-codex',
                        agentId: 'codex',
                        retryable: true,
                        suggestedActions: ['retry', 'open_connected_accounts'],
                    },
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-runtime-auth-recovery' })).toBeTruthy();
        expect(serialized).toContain(t('connectedServices.diagnostics.status.recovery_retry_scheduled'));
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders runtime-auth recovery recovered events without diagnostic data', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-runtime-auth-recovery',
                    status: 'recovered',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-runtime-auth-recovery' })).toBeTruthy();
        expect(serialized).toContain(t('message.connectedServiceRuntimeAuthRecoveryRecovered'));
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders connected-service account switch deferral events explicitly (not as unknown event)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral',
                    policy: 'defer_until_turn_boundary',
                    awaitingBoundary: true,
                    timeoutMs: 60000,
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral' })).toBeTruthy();
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders connected-service account switch deferral-completed events explicitly (not as unknown event)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-completed',
                    policy: 'defer_until_turn_boundary',
                    reason: 'completed_at_boundary',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-completed' })).toBeTruthy();
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders connected-service account switch deferral-superseded events explicitly (not as unknown event)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'connected-service-account-switch-deferral-superseded',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-connected-service-account-switch-deferral-superseded' })).toBeTruthy();
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });

    it('renders provider-state-sharing-degraded events explicitly (not as unknown event)', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                event={{
                    type: 'provider-state-sharing-degraded',
                    serviceId: 'openai-codex',
                    requestedStateMode: 'shared',
                    effectiveStateMode: 'isolated',
                    code: 'provider_state_sharing_degraded',
                    reason: 'materialize_failed',
                }}
            />,
        );

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByProps({ testID: 'transcript-event-provider-state-sharing-degraded' })).toBeTruthy();
        expect(serialized).not.toContain(t('message.unknownEvent'));
    });
});
