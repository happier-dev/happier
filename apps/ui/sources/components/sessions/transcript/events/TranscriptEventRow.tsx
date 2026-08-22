import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { readSessionAgentTransitionDividerV1 } from '@happier-dev/protocol';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { AgentTransitionDividerRow } from '@/components/sessions/transcript/agentTransition/AgentTransitionDividerRow';
import { Text } from '@/components/ui/text/Text';
import { resolveConnectedServiceUxDiagnosticPresentation } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import {
    isTerminalComposerDraftBlockedEvent,
    readTerminalComposerDraftBlockedStateAtMs,
} from '@/components/sessions/terminalComposer/terminalComposerDraftBlockedEvent';
import { useTerminalComposerClearAction } from '@/components/sessions/terminalComposer/useTerminalComposerClearAction';
import { useSettings } from '@/sync/store/hooks';
import type { AgentEvent } from '@/sync/typesRaw';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import type { TranscriptEventEmphasis } from './transcriptEventEmphasis';

import { buildConnectedServiceAccountSwitchMessage } from './connectedServiceAccountSwitchMessage';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const EVENT_ICON_SIZE = 18;
// Derived, not chosen: the spinner replaces the glyph in the same slot, so it must paint the same
// amount of ink. It was 20 against an 18pt glyph, i.e. larger than the checkmark it settles into.
const EVENT_SPINNER_SIZE = iconMatchedSpinnerSize(EVENT_ICON_SIZE);
const EVENT_ICON_CONTAINER_SIZE = 20;

function readEventRecord(event: AgentEvent): Record<string, unknown> {
    return event as unknown as Record<string, unknown>;
}

function readTerminalComposerDraftBlockedMessage(event: AgentEvent): string | null {
    const record = readEventRecord(event);
    return record.type === 'terminal-composer-draft-blocked'
        && typeof record.message === 'string'
        && record.message.trim().length > 0
        ? record.message
        : null;
}

function TerminalComposerClearEventAction(props: Readonly<{
    event: AgentEvent;
    sessionId: string;
}>) {
    const { theme } = useUnistyles();
    const terminalComposerClear = useTerminalComposerClearAction(props.sessionId);
    const expectedStateAtMs = readTerminalComposerDraftBlockedStateAtMs(props.event);

    return (
        <Pressable
            testID="transcriptEvent.clearTerminalComposer"
            accessibilityRole="button"
            accessibilityLabel={t('session.pendingMessages.clearComposer.action')}
            disabled={terminalComposerClear.busy}
            onPress={() => {
                void terminalComposerClear.clearTerminalComposer({ expectedStateAtMs });
            }}
            style={({ pressed }) => ([
                styles.action,
                {
                    backgroundColor: pressed ? theme.colors.surface.pressedOverlay : theme.colors.surface.base,
                    borderColor: theme.colors.border.default,
                    opacity: terminalComposerClear.busy ? 0.6 : 1,
                },
            ])}
        >
            {terminalComposerClear.busy ? (
                <ActivitySpinner
                    testID="transcriptEvent.clearTerminalComposerSpinner"
                    size={EVENT_SPINNER_SIZE}
                    color={theme.colors.text.secondary}
                />
            ) : (
                <Icon name="x-circle" size={14} color={theme.colors.state.danger.foreground} />
            )}
            <Text style={[styles.actionText, { color: theme.colors.state.danger.foreground }]}>
                {terminalComposerClear.busy
                    ? t('session.pendingMessages.clearComposer.clearing')
                    : t('session.pendingMessages.clearComposer.action')}
            </Text>
        </Pressable>
    );
}

function formatLimitReachedTime(timestamp: number): string {
    try {
        const date = new Date(timestamp * 1000);
        return formatWithCachedDateTimeFormatter(date, [], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return t('message.unknownTime');
    }
}

function formatQuotaResetTime(timestampMs: number): string {
    try {
        const date = new Date(timestampMs);
        return formatWithCachedDateTimeFormatter(date, [], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return t('message.unknownTime');
    }
}

function formatConnectedServiceSwitchAttemptFailureText(event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>): string {
    const diagnostic = 'diagnostic' in event ? event.diagnostic : undefined;
    const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);
    const text = diagnosticPresentation
        ? t(diagnosticPresentation.statusKey)
        : t('connectedServices.authSwitch.switchFailed');
    if (diagnosticPresentation) return text;
    return typeof event.errorCode === 'string' && event.errorCode.trim().length > 0
        ? `${text} (${event.errorCode.trim()})`
        : text;
}

function formatConnectedServiceSwitchAttemptSuccessText(event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>): string {
    const outcomeAction = event.outcomeAction;
    if (outcomeAction === 'credential_refreshed' || (!outcomeAction && event.attemptedContinuityMode === 'credential_refresh')) {
        return t('connectedServices.authSwitch.status.credentialsRefreshed');
    }
    if (outcomeAction === 'hot_applied' || (!outcomeAction && event.action === 'hot_applied')) {
        return t('connectedServices.authSwitch.status.liveApplied');
    }
    if (outcomeAction === 'restarted' || (!outcomeAction && event.action === 'restart_requested')) {
        return t('connectedServices.authSwitch.status.restarting');
    }
    if (outcomeAction === 'metadata_updated' || (!outcomeAction && event.action === 'metadata_updated')) {
        return t('connectedServices.authSwitch.status.appliesOnNextResume');
    }
    return t('connectedServices.authSwitch.confirmAction');
}

function resolveConnectedServiceSwitchAttemptOutcome(event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>):
    | 'failed'
    | 'scheduled_retry'
    | 'succeeded'
    | 'observed'
    | 'terminal' {
    return event.outcome ?? (event.ok ? 'succeeded' : 'failed');
}

function isObservedOnlyConnectedServiceSwitchAttempt(
    event: Extract<AgentEvent, { type: 'connected-service-account-switch-attempt' }>,
    outcome: ReturnType<typeof resolveConnectedServiceSwitchAttemptOutcome>,
): boolean {
    return outcome === 'observed' || event.sessionAdoption === 'observed_only';
}

function formatRuntimeAuthRecoveryText(event: Extract<AgentEvent, { type: 'connected-service-runtime-auth-recovery' }>): string {
    const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(event.diagnostic);
    if (diagnosticPresentation) return t(diagnosticPresentation.statusKey);
    switch (event.status) {
        case 'retry_scheduled':
            return t('connectedServices.diagnostics.status.recovery_retry_scheduled');
        case 'dead_lettered':
            return t('connectedServices.diagnostics.status.recovery_dead_lettered');
        case 'recovered':
            return t('message.connectedServiceRuntimeAuthRecoveryRecovered');
        case 'cancelled':
            return t('message.connectedServiceRuntimeAuthRecoveryCancelled');
    }
}

type RuntimeConfigOutcomeEvent = Extract<AgentEvent, { type: 'runtime-config-outcome' }>;

// The five public statuses are frozen. Optional `timing` carries when an already-statused
// change takes effect, and is surfaced as a calm, secondary sub-state (never a new status
// or an alarm).
function formatRuntimeConfigOutcomeTiming(timing: RuntimeConfigOutcomeEvent['timing']): string | undefined {
    switch (timing) {
        case 'scheduled_for_next_prompt':
        case 'before_next_prompt':
        case 'next_idle':
            return t('message.runtimeConfigOutcomeAppliesBeforeNextMessage');
        case 'queued_until_safe_window':
            return t('message.runtimeConfigOutcomeQueuedUntilReady');
        case 'skipped_already_effective':
            return t('message.runtimeConfigOutcomeAlreadySet');
        default:
            return undefined;
    }
}

// Pending timing means the change is not effective yet, so the row should read as a calm
// clock rather than a success checkmark.
function isPendingRuntimeConfigOutcomeTiming(timing: RuntimeConfigOutcomeEvent['timing']): boolean {
    return timing === 'scheduled_for_next_prompt'
        || timing === 'before_next_prompt'
        || timing === 'next_idle'
        || timing === 'queued_until_safe_window';
}

type RuntimeConfigOutcomeChange = NonNullable<RuntimeConfigOutcomeEvent['changes']>[number];

function runtimeConfigOutcomeKeyLabel(key: RuntimeConfigOutcomeChange['key']): string {
    switch (key) {
        case 'model':
            return t('message.runtimeConfigOutcomeKeyModel');
        case 'fallbackModel':
            return t('message.runtimeConfigOutcomeKeyFallbackModel');
        case 'permissionMode':
            return t('message.runtimeConfigOutcomeKeyPermissionMode');
        case 'reasoningEffort':
            return t('message.runtimeConfigOutcomeKeyReasoningEffort');
        case 'maxThinkingTokens':
            return t('message.runtimeConfigOutcomeKeyMaxThinkingTokens');
        case 'launchOption':
            return t('message.runtimeConfigOutcomeKeyLaunchOption');
        case 'sessionMode':
            return t('message.runtimeConfigOutcomeSessionMode');
    }
}

// Single lower/camelCase tokens (enum-ish values such as `acceptEdits`, `medium`, `ultracode`) read
// better spaced and capitalized; ids with digits/separators (model ids) must stay verbatim.
const HUMANIZABLE_OUTCOME_VALUE = /^[a-z]+(?:[A-Z][a-z]*)*$/;

function formatRuntimeConfigOutcomeValue(value: RuntimeConfigOutcomeChange['effective']): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value ? t('common.on') : t('common.off');
    if (typeof value === 'number') return String(value);
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (!HUMANIZABLE_OUTCOME_VALUE.test(trimmed)) return trimmed;
    const spaced = trimmed.replace(/([A-Z])/g, ' $1').toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function runtimeConfigOutcomeStatusPrefix(status: RuntimeConfigOutcomeEvent['status']): string | undefined {
    switch (status) {
        case 'applied':
            return undefined;
        case 'requires_restart':
            return t('message.runtimeConfigOutcomeRequiresRestart');
        case 'requires_interactive_control':
            return t('message.runtimeConfigOutcomeRequiresInteractiveControl');
        case 'unsupported':
            return t('message.runtimeConfigOutcomeUnsupported');
        case 'failed':
            return t('message.runtimeConfigOutcomeFailed');
    }
}

/**
 * Friendly per-change copy with values (L4): "Reasoning effort → Medium". Returns undefined when
 * no change carries a usable value, so the event message remains the fallback.
 */
function formatRuntimeConfigOutcomeChangesText(event: RuntimeConfigOutcomeEvent): string | undefined {
    const changes = event.changes;
    if (!changes || changes.length === 0) return undefined;
    const parts = changes.map((change) => {
        const label = runtimeConfigOutcomeKeyLabel(change.key);
        const value = formatRuntimeConfigOutcomeValue(change.effective ?? change.requested);
        return value !== undefined ? `${label} → ${value}` : undefined;
    });
    if (!parts.some((part) => part !== undefined)) return undefined;
    const list = changes
        .map((change, index) => parts[index] ?? runtimeConfigOutcomeKeyLabel(change.key))
        .join(' · ');
    const prefix = runtimeConfigOutcomeStatusPrefix(event.status);
    return prefix ? `${prefix}: ${list}` : list;
}

function formatRuntimeConfigOutcomeSessionModeChange(changes: RuntimeConfigOutcomeEvent['changes']): string | undefined {
    const change = changes?.find((entry) => entry.key === 'sessionMode');
    if (!change) return undefined;
    const label = t('message.runtimeConfigOutcomeSessionMode');
    const value = change.requested ?? change.effective;
    return typeof value === 'string' && value.trim().length > 0
        ? `${label} (${value.trim()})`
        : label;
}

export const TranscriptEventRow = React.memo(function TranscriptEventRow(props: {
    event: AgentEvent;
    /**
     * The row's local id. The Agent-transition divider is only a divider when the
     * reserved localId backs its sidecar, so this is what stops an ordinary event
     * row from rendering as a trusted Agent boundary.
     */
    localId?: string | null;
    sessionId?: string | null;
    emphasis?: TranscriptEventEmphasis;
}) {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const deemphasized = props.emphasis === 'deemphasized';
    const eventColor = deemphasized ? theme.colors.text.tertiary : theme.colors.text.secondary;
    let iconName: IconName = 'info';
    let text = t('message.unknownEvent');
    let detailText: string | undefined;
    let testID: string | undefined;
    const terminalComposerDraftBlocked = isTerminalComposerDraftBlockedEvent(props.event);
    const terminalComposerClearSessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
    const showTerminalComposerClearAction = terminalComposerDraftBlocked && terminalComposerClearSessionId.length > 0;

    // The Agent-transition divider rides the generic `type:'message'` arm so old
    // readers still render its prose. This reader understands the sidecar, and a
    // change of Agent is a boundary in the conversation, not an informational
    // aside — so it leaves the generic arm entirely rather than restyling it.
    // Recognition goes through the protocol's single divider reader; neither the
    // sidecar shape nor the reserved-localId check is repeated here.
    const agentTransitionDivider = readSessionAgentTransitionDividerV1({
        localId: props.localId ?? null,
        event: props.event,
    });
    if (agentTransitionDivider) {
        return <AgentTransitionDividerRow divider={agentTransitionDivider} sessionId={props.sessionId ?? null} />;
    }

    if (terminalComposerDraftBlocked && readEventRecord(props.event).type === 'terminal-composer-draft-blocked') {
        testID = 'transcript-event-terminal-composer-draft-blocked';
        iconName = 'pause-circle';
        text = readTerminalComposerDraftBlockedMessage(props.event)
            ?? t('session.pendingMessages.steerBlockedTerminalDraftNotice');
    } else if (props.event.type === 'switch') {
        iconName = 'arrows-left-right';
        text = t('message.switchedToMode', { mode: props.event.mode });
    } else if (props.event.type === 'message') {
        iconName = 'info';
        text = props.event.message;
    } else if (props.event.type === 'runtime-config-outcome') {
        testID = `transcript-event-runtime-config-outcome-${props.event.status}`;
        const pendingTiming = isPendingRuntimeConfigOutcomeTiming(props.event.timing);
        if (props.event.status === 'applied') {
            iconName = pendingTiming ? 'clock' : 'check-circle';
        } else if (props.event.status === 'requires_restart' || props.event.status === 'requires_interactive_control') {
            iconName = 'clock';
        } else {
            iconName = 'warning';
        }
        text = formatRuntimeConfigOutcomeChangesText(props.event) ?? props.event.message;
        const detailParts = [
            formatRuntimeConfigOutcomeSessionModeChange(props.event.changes),
            formatRuntimeConfigOutcomeTiming(props.event.timing),
        ].filter((part): part is string => Boolean(part));
        detailText = detailParts.length > 0 ? detailParts.join(' · ') : undefined;
    } else if (props.event.type === 'context-compaction') {
        const isPaused = props.event.phase === 'completed' && props.event.continuation === 'paused';
        testID = `transcript-event-context-compaction-${isPaused ? 'paused' : props.event.phase}`;
        if (props.event.phase === 'started' || props.event.phase === 'progress') {
            iconName = 'hourglass';
            text = t('message.contextCompactionStarted');
        } else if (props.event.phase === 'failed') {
            iconName = 'warning';
            text = t('message.contextCompactionFailed');
        } else if (props.event.phase === 'cancelled') {
            iconName = 'x-circle';
            text = t('message.contextCompactionCancelled');
        } else if (isPaused) {
            iconName = 'pause-circle';
            text = t('message.contextCompactionPaused');
        } else {
            iconName = 'check-circle';
            text = t('message.contextCompactionCompleted');
        }
    } else if (props.event.type === 'limit-reached') {
        iconName = 'warning';
        text = t('message.usageLimitUntil', { time: formatLimitReachedTime(props.event.endsAt) });
    } else if (props.event.type === 'connected-service-account-switch') {
        testID = 'transcript-event-connected-service-account-switch';
        iconName = 'arrows-left-right';
        text = buildConnectedServiceAccountSwitchMessage({
            event: props.event,
            labelsByKey: settings.connectedServicesProfileLabelByKey,
        });
    } else if (props.event.type === 'agent-quota-wait') {
        testID = 'transcript-event-agent-quota-wait';
        iconName = 'clock';
        text = t('message.agentQuotaWait', { time: formatQuotaResetTime(props.event.resetAtMs) });
    } else if (props.event.type === 'agent-quota-recovered') {
        testID = 'transcript-event-agent-quota-recovered';
        iconName = 'check-circle';
        text = t('message.agentQuotaRecovered');
    } else if (props.event.type === 'connected-service-account-switch-attempt') {
        testID = 'transcript-event-connected-service-account-switch-attempt';
        const outcome = resolveConnectedServiceSwitchAttemptOutcome(props.event);
        if (outcome === 'failed' || outcome === 'terminal') {
            iconName = 'warning';
            text = formatConnectedServiceSwitchAttemptFailureText(props.event);
        } else if (outcome === 'scheduled_retry') {
            iconName = 'clock';
            const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(props.event.diagnostic);
            text = diagnosticPresentation
                ? t(diagnosticPresentation.statusKey)
                : t('connectedServices.diagnostics.status.recovery_retry_scheduled');
        } else if (isObservedOnlyConnectedServiceSwitchAttempt(props.event, outcome)) {
            iconName = 'info';
            text = formatConnectedServiceSwitchAttemptSuccessText(props.event);
        } else {
            iconName = 'check-circle';
            text = formatConnectedServiceSwitchAttemptSuccessText(props.event);
        }
    } else if (props.event.type === 'connected-service-runtime-auth-recovery') {
        testID = 'transcript-event-connected-service-runtime-auth-recovery';
        if (props.event.status === 'retry_scheduled') {
            iconName = 'clock';
        } else if (props.event.status === 'dead_lettered') {
            iconName = 'warning';
        } else if (props.event.status === 'cancelled') {
            iconName = 'x-circle';
        } else {
            iconName = 'check-circle';
        }
        text = formatRuntimeAuthRecoveryText(props.event);
    } else if (props.event.type === 'connected-service-account-switch-deferral') {
        // O1: switch-deferral — policy
        testID = 'transcript-event-connected-service-account-switch-deferral';
        iconName = 'clock';
        text = props.event.policy === 'defer_until_idle'
            ? t('message.connectedServiceSwitchDeferredIdle')
            : t('message.connectedServiceSwitchDeferred');
    } else if (props.event.type === 'connected-service-account-switch-deferral-completed') {
        // O1: deferral-completed — reason distinguishes success vs cancellation
        testID = 'transcript-event-connected-service-account-switch-deferral-completed';
        const cancellationReasons = new Set(['aborted_after_timeout', 'switch_cancelled', 'session_terminated', 'daemon_shutdown']);
        if (cancellationReasons.has(props.event.reason)) {
            iconName = 'x-circle';
            text = t('message.connectedServiceSwitchDeferralCancelled');
        } else {
            iconName = 'check-circle';
            text = t('message.connectedServiceSwitchDeferralCompleted');
        }
    } else if (props.event.type === 'connected-service-account-switch-deferral-superseded') {
        // O1: deferral-superseded — a newer switch replaced this one
        testID = 'transcript-event-connected-service-account-switch-deferral-superseded';
        iconName = 'arrows-left-right';
        text = t('message.connectedServiceSwitchDeferralSuperseded');
    } else if (props.event.type === 'agent-state-sharing-degraded') {
        // O1: state-sharing degraded — partial materialization warning
        testID = 'transcript-event-agent-state-sharing-degraded';
        iconName = 'warning';
        text = t('message.agentStateSharingDegraded');
    }

    const content = (
        <>
            <View style={styles.row}>
                <View style={styles.iconContainer}>
                    <Icon name={iconName} size={EVENT_ICON_SIZE} color={eventColor} />
                </View>
                <View style={styles.textColumn} testID={testID ? `${testID}-body` : undefined}>
                    <Text selectable style={[styles.text, deemphasized ? styles.deemphasizedText : null]}>
                        {text}
                    </Text>
                    {detailText ? (
                        <Text selectable style={styles.detailText} testID={testID ? `${testID}-detail` : undefined}>
                            {detailText}
                        </Text>
                    ) : null}
                    {showTerminalComposerClearAction ? (
                        <TerminalComposerClearEventAction
                            event={props.event}
                            sessionId={terminalComposerClearSessionId}
                        />
                    ) : null}
                </View>
            </View>
        </>
    );

    return (
        <View style={[styles.container, deemphasized ? styles.deemphasizedContainer : null]} testID={testID}>
            {testID === 'transcript-event-connected-service-account-switch' ? (
                <View testID="session-event-connected-service-account-switch">
                    {content}
                </View>
            ) : content}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        paddingBottom: 22,
        alignSelf: 'stretch',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        minWidth: 0,
    },
    textColumn: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    iconContainer: {
        width: EVENT_ICON_CONTAINER_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
        flexShrink: 1,
    },
    deemphasizedText: {
        color: theme.colors.text.tertiary,
    },
    deemphasizedContainer: {
        opacity: 0.58,
    },
    detailText: {
        color: theme.colors.text.tertiary,
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '400',
        flexShrink: 1,
    },
    action: {
        marginTop: 6,
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 24,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    actionText: {
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '700',
    },
}));
