import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { readSessionAgentTransitionDividerV1 } from '@happier-dev/protocol/sessions/agentTransitionDivider';
import { isConnectedServiceRuntimeAuthRecoveryCancellation } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { SESSION_FOLLOW_WAKE_EVENT_MESSAGE } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { FollowDeliveryProjectionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { AgentTransitionDividerRow } from '@/components/sessions/transcript/agentTransition/AgentTransitionDividerRow';
import { Text } from '@/components/ui/text/Text';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { resolveConnectedServiceUxDiagnosticPresentation } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import {
    isTerminalComposerDraftBlockedEvent,
    readTerminalComposerDraftBlockedStateAtMs,
} from '@/components/sessions/terminalComposer/terminalComposerDraftBlockedEvent';
import { useTerminalComposerClearAction } from '@/components/sessions/terminalComposer/useTerminalComposerClearAction';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { AgentEvent } from "@happier-dev/session-core/raw";
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import type { TranscriptEventEmphasis } from './transcriptEventEmphasis';

import { buildConnectedServiceAccountSwitchMessage } from './connectedServiceAccountSwitchMessage';
import { describeSessionStopMarker } from './sessionStopMarker';
import { describeCapabilityNotice, type CapabilityNoticePresentation } from './capabilityNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readSessionStopTranscriptRecordV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { useSessionStopRecord } from './useSessionStopRecord';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

const STOP_MARKER_FRESH_MS = 30_000;
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { WorkerUpdateCard } from '@/components/sessions/work/WorkerUpdateCard';
import { useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { describeWorkKind } from '@/components/sessions/work/workerKindGlyphs';
import { describeWorkerUpdateState } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { followInputNeedsYou } from '@/sync/domains/session/input/hostAuthoredInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

const EVENT_ICON_SIZE = 18;
// Derived, not chosen: the spinner replaces the glyph in the same slot, so it must paint the same
// amount of ink. It was 20 against an 18pt glyph, i.e. larger than the checkmark it settles into.
const EVENT_SPINNER_SIZE = iconMatchedSpinnerSize(EVENT_ICON_SIZE);
export const EVENT_ICON_CONTAINER_SIZE = 20;

/** One presenter shared by original Follow inputs and their WorkerUpdate cards. */
export function TranscriptHostWakeNotice(props: Readonly<{ count: number }>) {
    const { theme } = useUnistyles();
    return <View testID="transcript-event-host-wake" style={[styles.row, styles.hostWake]}>
        <View style={styles.iconContainer}>
            <Icon name="arrow-elbow-down-right" size={EVENT_ICON_SIZE} color={theme.colors.text.tertiary} />
        </View>
        <Text style={[styles.text, styles.textColumn]}>
            {t('sessionWork.workerUpdate.wokenBy', { count: props.count })}
            <Text style={styles.hostWakeQuiet}>{` · ${t('sessionWork.workerUpdate.notFromYou')}`}</Text>
        </Text>
    </View>;
}

/**
 * Pending Follow identifies its source; the composer owns the waiting count. A worker that needs the
 * person says so with the shared worker state word, so a stopped lead is never the only place the ask hides.
 */
export function TranscriptFollowSourceNotice(props: Readonly<{
    followInput: SessionFollowInputV1;
    sessionId: string;
    serverId?: string | null;
    messageId: string;
    createdAt: number;
    /** More than one queued update from this source, shown as this one notice. */
    count?: number;
}>) {
    const { original } = props.followInput;
    const sourceSessionId = 'sourceSessionId' in original ? original.sourceSessionId : '';
    const source = useSessionDisplayNameSource(sourceSessionId, props.serverId);
    const name = 'sourceSessionId' in original
        ? sessionDisplayTitle(source, props.serverId) ?? t('message.provenanceSession')
        : describeWorkKind(original.source.kind);
    return <TranscriptEventRow event={{ type: 'message', message: t('message.provenanceFrom', { source: name }) }}
        noticeState={followInputNeedsYou(props.followInput)
            ? describeWorkerUpdateState({ workerKind: 'session', ownerState: 'needs_input', wake: 'needs_you' }) : undefined}
        noticeCount={props.count}
        messageId={props.messageId} sessionId={props.sessionId} serverId={props.serverId} createdAt={props.createdAt} />;
}

/**
 * Opens the worker a queued Follow notice says needs the person. A sibling of the notice, never inside
 * it: the pending row's press target is already a button. Nothing for a notice that asks nothing.
 */
export function TranscriptFollowSourceAction(props: Readonly<{
    followInput: SessionFollowInputV1;
    serverId?: string | null;
    testID?: string;
    style?: React.ComponentProps<typeof RoundButton>['style'];
}>) {
    const transcriptSource = useSessionTranscriptSource();
    const { original } = props.followInput;
    const href = followInputNeedsYou(props.followInput) && 'sourceSessionId' in original
        ? buildScopedSessionRouteHref({ sessionId: original.sourceSessionId, serverId: props.serverId }) : null;
    if (!href || !transcriptSource.navigate) return null;
    const navigate = transcriptSource.navigate;
    return <RoundButton testID={props.testID ?? 'transcript-follow-notice-open'} size="small" display="inverted" style={props.style}
        title={t('runs.openSession')} onPress={() => navigate(href)} />;
}

function SessionStopMarkerRow(props: Readonly<{ event: AgentEvent; sessionId?: string | null; serverId?: string | null; at: number; deemphasized: boolean }>) {
    const current = useSessionStopRecord({ serverId: props.serverId ?? null, sessionId: props.sessionId ?? null, at: props.at });
    const marker = describeSessionStopMarker(props.event, formatQuotaResetTime, current);
    const reducedMotion = useReducedMotionPreference();
    const [rises] = React.useState(() => !reducedMotion && Date.now() - props.at < STOP_MARKER_FRESH_MS);
    if (!marker) return null;
    const iconName = marker.status === 'stopped' ? 'moon' : marker.status === 'failed' ? 'warning'
        : marker.status === 'cancelled' ? 'x-circle' : 'clock';
    const content = <TranscriptSeparatorRow padding="none" chipChrome="minimal" iconName={iconName} title={marker.text}
        titleContent={<Text style={styles.stopMarkerText}>{marker.text}</Text>} />;
    const style = [styles.container, props.deemphasized ? styles.deemphasizedContainer : null];
    return rises ? <Animated.View style={style} testID="transcript-event-session-stop"
        entering={FadeInUp.duration(motionTokens.guardMoment.markerRiseMs)
            .withInitialValues({ opacity: 0, transform: [{ translateY: motionTokens.guardMoment.markerRisePx }] })}>{content}</Animated.View>
        : <View style={style} testID="transcript-event-session-stop">{content}</View>;
}

/** Where the left-out item is fixed; quiet, since the line above already says what happened. */
function CapabilityNoticeLink(props: Readonly<{ notice: CapabilityNoticePresentation }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    return (
        <Pressable
            testID="transcript-event-capability-notice-open"
            accessibilityRole="link"
            accessibilityLabel={props.notice.linkLabel}
            onPress={() => router.push(props.notice.href as never)}
            hitSlop={8}
            style={({ pressed }) => [styles.noticeLink, { opacity: pressed ? motionTokens.press.opacitySubtle : 1 }]}
        >
            <Text style={[styles.detailText, { color: theme.colors.text.secondary }]}>{props.notice.linkLabel}</Text>
            <Icon name="caret-right" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
        </Pressable>
    );
}

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
    serverId?: string | null;
}>) {
    const { theme } = useUnistyles();
    const terminalComposerClear = useTerminalComposerClearAction(props.sessionId, props.serverId);
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
            return isConnectedServiceRuntimeAuthRecoveryCancellation(event.reason)
                ? t('message.connectedServiceRuntimeAuthRecoveryCancelled')
                : t('message.connectedServiceRuntimeAuthRecoveryStopped');
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
    messageId?: string;
    event: AgentEvent;
    /**
     * The row's local id. The Agent-transition divider is only a divider when the
     * reserved localId backs its sidecar, so this is what stops an ordinary event
     * row from rendering as a trusted Agent boundary.
     */
    localId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
    emphasis?: TranscriptEventEmphasis;
    /** A failed turn or rejected input: the same row, with its glyph in the failure colour. */
    tone?: 'failure';
    /** Find ranges in the displayed primary text, supplied by the transcript row owner. */
    findSourceRanges?: readonly FindTextRange[];
    navigationEnabled?: boolean;
    /** On the worker update that opens a context-only wake: how many updates woke the session. */
    hostWakeCount?: number;
    followDeliveryProjection?: FollowDeliveryProjectionV1;
    createdAt?: number;
    /** A state word on its own line under the notice, in its tone (a queued Follow whose worker needs the person). */
    noticeState?: string;
    /** Several queued updates from one source read as this one notice: how many it stands for. */
    noticeCount?: number;
}) {
    const { theme } = useUnistyles();
    const needsConnectedLabel = props.event.type === 'connected-service-account-switch';
    const { binding } = useServerCredentialAccountScopeBinding(needsConnectedLabel ? props.serverId : null);
    const labelsByKey = useConnectedMetadataCatalog(needsConnectedLabel
        ? props.serverId ? binding?.scope ?? null : undefined : null, selectConnectedMetadataLabels);
    const deemphasized = props.emphasis === 'deemphasized';
    // Host accounting evidence is retained for Usage/Coach, not a conversation
    // notification. Keep unknown event types on the visible fallback below.
    if (props.event.type === 'mcp-binding-usage') return null;
    const eventColor = props.tone === 'failure' ? theme.colors.state.danger.foreground
        : deemphasized ? theme.colors.text.tertiary : theme.colors.text.secondary;
    let iconName: IconName = 'info';
    let text = t('message.unknownEvent');
    let detailText: string | undefined;
    let testID: string | undefined;
    let capabilityNotice: CapabilityNoticePresentation | null = null;
    /** Background work nobody asked for: its glyph and words take tertiary ink. */
    let quiet = false;
    const stopRecord = readSessionStopTranscriptRecordV1(props.event);
    const terminalComposerDraftBlocked = isTerminalComposerDraftBlockedEvent(props.event);
    const terminalComposerClearSessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
    const showTerminalComposerClearAction = terminalComposerDraftBlocked && terminalComposerClearSessionId.length > 0;
    if (stopRecord) return <SessionStopMarkerRow event={props.event} sessionId={props.sessionId} serverId={props.serverId}
        at={stopRecord.at} deemphasized={deemphasized} />;

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
    if (props.event.type === 'worker-update') {
        // A wake is the host's doing, never the user's: its first update says so in a host row
        // (ORC R-01, lab D1), and every update keeps its own card.
        return (
            <View style={styles.container}>
                {props.hostWakeCount ? <TranscriptHostWakeNotice count={props.hostWakeCount} /> : null}
                <WorkerUpdateCard update={props.event.update} followMatches={props.event.followMatches}
                    followInputLocalId={props.event.followInputLocalId} followWakeEventLocalId={props.event.followWakeEventLocalId}
                    delivery={props.followDeliveryProjection} messageId={props.messageId} serverId={props.serverId}
                    navigationEnabled={props.navigationEnabled} at={props.createdAt} />
            </View>
        );
    }

    if (terminalComposerDraftBlocked && readEventRecord(props.event).type === 'terminal-composer-draft-blocked') {
        testID = 'transcript-event-terminal-composer-draft-blocked';
        iconName = 'pause-circle';
        text = readTerminalComposerDraftBlockedMessage(props.event)
            ?? t('session.pendingMessages.steerBlockedTerminalDraftNotice');
    } else if (props.event.type === 'worker-report') {
        testID = 'transcript-event-worker-report';
        text = props.event.summary;
    } else if (props.event.type === 'goal-changed') {
        // Content-free by contract: the event says the Goal moved, never what it says now.
        testID = 'transcript-event-goal-changed';
        iconName = 'target';
        text = t('message.goalChanged');
    } else if (props.event.type === 'switch') {
        iconName = 'arrows-left-right';
        text = t('message.switchedToMode', { mode: props.event.mode });
    } else if (props.event.type === 'message') {
        iconName = props.tone === 'failure' ? 'warning' : 'info';
        if (props.tone === 'failure') testID = 'transcript-event-runtime-issue';
        capabilityNotice = describeCapabilityNotice(props.event);
        // The Follow wake commits one fixed Protocol sentence as the persisted
        // event content so every host recognises it; the reader localizes it the
        // same way it localizes the blocked-draft notice. The stored marker stays
        // untranslated and is shown verbatim on a host without the key.
        text = props.event.message === SESSION_FOLLOW_WAKE_EVENT_MESSAGE
            ? t('session.follow.wakeEventExplanation')
            : props.event.message;
        if (capabilityNotice) {
            testID = 'transcript-event-capability-notice';
            iconName = 'warning';
            text = capabilityNotice.lines.join('\n');
        }
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
    } else if (props.event.type === 'context-compaction' && props.event.trigger === 'idle') {
        // Nobody asked for it, so it stays quiet: idle words, a static glyph while it runs, and a
        // failure or cancellation in tertiary ink with nothing asked of the reader. The paused
        // continuation copy never applies; the idle words say what happened.
        const phase = props.event.phase === 'progress' ? 'started' : props.event.phase;
        testID = `transcript-event-context-compaction-${phase}`;
        if (phase === 'started') {
            iconName = 'hourglass';
            text = t('message.contextCompactionIdleStarted');
        } else if (phase === 'failed') {
            iconName = 'warning';
            text = t('message.contextCompactionIdleFailed');
            detailText = t('message.contextCompactionIdleFailedDetail');
            quiet = true;
        } else if (phase === 'cancelled') {
            iconName = 'x-circle';
            text = t('message.contextCompactionCancelled');
            quiet = true;
        } else {
            iconName = 'check-circle';
            text = t('message.contextCompactionIdleCompleted');
            // Measured counts only (C2), and only when both are present; never an estimate.
            const { tokenCountBefore: before, tokenCountAfter: after, tokenCountSource } = props.event;
            detailText = tokenCountSource === 'providerReported' && before !== undefined && after !== undefined
                ? t('message.contextCompactionIdleDetailCounts', { before: formatTokenCount(before), after: formatTokenCount(after) })
                : t('message.contextCompactionIdleDetail');
        }
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
            labelsByKey,
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

    // The guard's stop marker is a boundary in the conversation, so it is drawn by the transcript's one
    // separator (rule · glyph · words · rule), quiet, rather than as an ordinary event line.
    const content = (
        <>
            <View style={styles.row}>
                <View style={styles.iconContainer}>
                    <Icon name={iconName} size={EVENT_ICON_SIZE} color={quiet ? theme.colors.text.tertiary : eventColor} />
                </View>
                <View style={styles.textColumn} testID={testID ? `${testID}-body` : undefined}>
                    <Text selectable style={[styles.text, deemphasized || quiet ? styles.deemphasizedText : null]}>
                        {props.findSourceRanges?.length ? <FindHighlightedText text={text} ranges={props.findSourceRanges} selectable /> : text}
                        {props.noticeCount && props.noticeCount > 1
                            ? <Text style={styles.noticeCount}>{` · ${t('sessionWork.workerUpdate.updateCount', { count: props.noticeCount })}`}</Text> : null}
                    </Text>
                    {props.noticeState ? <Text style={[workStatusWordStyle('attention'), styles.noticeState]}>{props.noticeState}</Text> : null}
                    {detailText ? (
                        <Text selectable style={styles.detailText} testID={testID ? `${testID}-detail` : undefined}>
                            {detailText}
                        </Text>
                    ) : null}
                    {capabilityNotice ? <CapabilityNoticeLink notice={capabilityNotice} /> : null}
                    {showTerminalComposerClearAction ? (
                        <TerminalComposerClearEventAction
                            event={props.event}
                            sessionId={terminalComposerClearSessionId}
                            serverId={props.serverId}
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
        marginHorizontal: theme.space.s16,
        paddingBottom: 22,
        alignSelf: 'stretch',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
        minWidth: 0,
    },
    textColumn: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    iconContainer: {
        width: EVENT_ICON_CONTAINER_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    text: {
        color: theme.colors.text.secondary,
        ...Typography.variant('label'),
        flexShrink: 1,
    },
    stopMarkerText: {
        color: theme.colors.text.tertiary,
        fontSize: 12,
        lineHeight: 16,
        fontVariant: ['tabular-nums'],
        textAlign: 'center',
    },
    hostWake: {
        alignItems: 'center',
        marginBottom: theme.space.s10,
    },
    hostWakeQuiet: {
        color: theme.colors.text.tertiary,
        fontWeight: '400',
    },
    deemphasizedText: {
        color: theme.colors.text.tertiary,
    },
    deemphasizedContainer: {
        opacity: 0.58,
    },
    detailText: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('meta'),
        flexShrink: 1,
    },
    noticeState: {
        ...Typography.variant('meta', 'semiBold'),
    },
    noticeCount: {
        color: theme.colors.text.tertiary,
        fontWeight: '400',
    },
    noticeLink: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
        marginTop: theme.space.s2,
    },
    action: {
        marginTop: theme.space.s6,
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        minHeight: 24,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
    },
    actionText: {
        ...Typography.variant('meta', 'semiBold'),
    },
}));
