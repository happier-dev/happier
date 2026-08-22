import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { isNonSteerablePromptPayload, type PendingRequestedActionV1 } from '@happier-dev/protocol';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    isVersionSupported,
    MINIMUM_CLI_PENDING_QUEUE_V2_VERSION,
} from '@/utils/system/versionUtils';
import { isSessionExclusiveLocalControl } from '@/sync/domains/session/control/sessionLocalControl';
import { deriveSessionInputReadinessState } from '@/sync/domains/session/control/deriveSessionInputReadinessState';
import {
    getAgentCore,
    isBundledAgentId,
} from '@/agents/registry/registryCore';
import type { AgentSessionComposerNonSteerableReason } from '@/agents/registry/registryUiBehavior';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type MessageSendMode = 'agent_queue' | 'interrupt' | 'server_pending';

export type BusySteerSendPolicy = 'steer_immediately' | 'server_pending';

export const DEFAULT_BUSY_STEER_SEND_POLICY: BusySteerSendPolicy = 'steer_immediately';

export type ProviderNonSteerableSendReason = AgentSessionComposerNonSteerableReason;

export type SessionMessageDeliveryIntent =
    | 'default'
    | 'explicit_pending'
    | 'explicit_immediate'
    | 'interrupt';

export type PendingQueueSubmitSupportState =
    | 'supported'
    | 'unknown_session'
    | 'unknown_pending_version'
    | 'unsupported_cli_version';

export type SessionMessageDirectBypassReason =
    | 'selected_direct'
    | 'force_immediate'
    | 'interrupt'
    | 'subagent_command'
    | 'voice_turn'
    | 'spawn_post_process';

export type SessionMessageDeliveryDecision = Readonly<{
    mode: MessageSendMode;
    intent: SessionMessageDeliveryIntent;
    reason: string;
    pendingSupportState: PendingQueueSubmitSupportState;
    requestedAction?: PendingRequestedActionV1;
    directBypassReason?: SessionMessageDirectBypassReason;
    nonSteerablePayloadReason?: string;
    sessionSteerUnavailableReason?: string;
}>;

type SessionSubmitRuntimeState = Readonly<{
    localControlBlocksDirectSubmit: boolean;
    isBusy: boolean;
    inputReadinessDisposition: 'accepts_next_turn' | 'steer_available' | 'blocked' | 'offline';
    isOnline: boolean;
    agentReady: boolean;
}>;

function getProviderInFlightSteerSupported(session: Session | null): boolean {
    const agentId = resolveAgentIdFromSessionMetadata(
        session ? readSessionOwnerMetadataView(session) : null,
    );
    if (!agentId || !isBundledAgentId(agentId)) return false;
    return getAgentCore(agentId).runtimeInput?.inFlightSteerSupported === true;
}

function deriveSubmitRuntimeState(session: Session | null, nowMs: number): SessionSubmitRuntimeState {
    const localControlBlocksDirectSubmit = isSessionExclusiveLocalControl(session);
    const capabilities = session?.agentState?.capabilities;
    const providerInFlightSteerSupported = getProviderInFlightSteerSupported(session);
    const inFlightSteerSupported = capabilities?.inFlightSteerSupported
        ?? capabilities?.inFlightSteer
        ?? providerInFlightSteerSupported;
    const inFlightSteerAvailable = capabilities?.inFlightSteerAvailable
        ?? capabilities?.inFlightSteer
        ?? providerInFlightSteerSupported;
    const inputReadiness = deriveSessionInputReadinessState({
        active: session?.active,
        activeAt: session?.activeAt,
        presence: session?.presence,
        thinking: session?.thinking,
        thinkingAt: session?.thinkingAt,
        optimisticThinkingAt: session?.optimisticThinkingAt,
        hasPendingUserMessages: typeof session?.pendingCount === 'number' && session.pendingCount > 0,
        latestTurnStatus: session?.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session?.latestTurnStatusObservedAt ?? null,
        inFlightSteerSupported,
        inFlightSteerAvailable,
    }, nowMs);
    return {
        localControlBlocksDirectSubmit,
        isBusy: inputReadiness.isInputBusy,
        inputReadinessDisposition: inputReadiness.disposition,
        isOnline: session?.presence === 'online',
        agentReady: Boolean(session && session.agentStateVersion > 0),
    };
}

function readSessionRecordValue(session: Session | null, key: string): unknown {
    return session ? (session as unknown as Record<string, unknown>)[key] : undefined;
}

function readSessionMetadataValue(session: Session | null, key: string): unknown {
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    return metadata && typeof metadata === 'object'
        ? (metadata as Record<string, unknown>)[key]
        : undefined;
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function estimateActiveTurnStartedAt(session: Session | null): number | null {
    const latestTurnObservedAt = readFiniteNumber(readSessionRecordValue(session, 'latestTurnStatusObservedAt'));
    if (readSessionRecordValue(session, 'latestTurnStatus') === 'in_progress' && latestTurnObservedAt != null) {
        return latestTurnObservedAt;
    }
    return readFiniteNumber(readSessionRecordValue(session, 'thinkingAt'));
}

function classifyFreshPermissionModeChange(opts: {
    session: Session | null;
    permissionModeApplyTiming?: 'current_turn' | 'next_prompt';
}): string | null {
    if (opts.permissionModeApplyTiming === 'next_prompt') return null;
    const localPermissionMode = readSessionRecordValue(opts.session, 'permissionMode');
    const metadataPermissionMode = readSessionMetadataValue(opts.session, 'permissionMode');
    if (
        typeof localPermissionMode !== 'string'
        || typeof metadataPermissionMode !== 'string'
        || localPermissionMode === metadataPermissionMode
    ) {
        return null;
    }

    const permissionModeUpdatedAt = readFiniteNumber(readSessionRecordValue(opts.session, 'permissionModeUpdatedAt'));
    const turnStartedAt = estimateActiveTurnStartedAt(opts.session);
    if (permissionModeUpdatedAt == null || turnStartedAt == null || permissionModeUpdatedAt < turnStartedAt) {
        return null;
    }
    return 'mode_change_refused';
}

function classifyLocalNonSteerablePayload(opts: {
    session: Session | null;
    text?: string;
    nonSteerableSendPrompt?: 'on' | 'off';
    permissionModeApplyTiming?: 'current_turn' | 'next_prompt';
}): string | null {
    if (isNonSteerablePromptPayload(opts.text)) return 'special_command';
    if (opts.nonSteerableSendPrompt === 'off') return null;
    return classifyFreshPermissionModeChange({
        session: opts.session,
        permissionModeApplyTiming: opts.permissionModeApplyTiming,
    });
}

export function canApplySteerConfigInFlight(session: Session | null): boolean {
    return session?.agentState?.capabilities?.inFlightConfigApplySupported === true;
}

export function canDirectSubmitUserMessageNow(opts: {
    session: Session | null;
    nowMs?: number;
}): boolean {
    return getPendingQueueSubmitSupportState(opts.session) === 'unsupported_cli_version';
}

export function getPendingQueueSubmitSupportState(session: Session | null): PendingQueueSubmitSupportState {
    if (!session) {
        return 'unknown_session';
    }

    if (typeof session.pendingVersion !== 'number') {
        return 'unknown_pending_version';
    }

    const cliVersion = readSessionOwnerMetadataView(session)?.version;
    const trimmedCliVersion = typeof cliVersion === 'string' ? cliVersion.trim() : '';
    if (trimmedCliVersion && !isVersionSupported(trimmedCliVersion, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION)) {
        return 'unsupported_cli_version';
    }

    return 'supported';
}

export function isPendingQueueSubmitKnownUnsupported(session: Session | null): boolean {
    return getPendingQueueSubmitSupportState(session) === 'unsupported_cli_version';
}

function getDeliveryIntent(opts: {
    configuredMode: MessageSendMode;
    explicitMode?: MessageSendMode;
    forceImmediate?: boolean;
}): SessionMessageDeliveryIntent {
    const requestedMode = opts.explicitMode ?? opts.configuredMode;
    if (requestedMode === 'interrupt') {
        return 'interrupt';
    }
    if (opts.forceImmediate === true) {
        return 'explicit_immediate';
    }
    if (opts.explicitMode === 'server_pending') {
        return 'explicit_pending';
    }
    return 'default';
}

function withDirectReason(
    decision: Omit<SessionMessageDeliveryDecision, 'directBypassReason'>,
): SessionMessageDeliveryDecision {
    if (decision.mode === 'interrupt') {
        return { ...decision, directBypassReason: 'interrupt' };
    }
    if (decision.mode === 'agent_queue') {
        return {
            ...decision,
            directBypassReason: decision.intent === 'explicit_immediate' ? 'force_immediate' : 'selected_direct',
        };
    }
    return decision;
}

export function decideSessionMessageDelivery(opts: {
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    explicitMode?: MessageSendMode;
    session: Session | null;
    nowMs?: number;
    forceImmediate?: boolean;
    providerNonSteerableReason?: ProviderNonSteerableSendReason | null;
    text?: string;
    nonSteerableSendPrompt?: 'on' | 'off';
    permissionModeApplyTiming?: 'current_turn' | 'next_prompt';
    applyConfigAndSteer?: boolean;
    steerWithoutConfig?: boolean;
}): SessionMessageDeliveryDecision {
    const requestedMode = opts.explicitMode ?? opts.configuredMode;
    const intent = getDeliveryIntent(opts);
    const session = opts.session;
    const pendingSupportState = getPendingQueueSubmitSupportState(session);

    if (pendingSupportState === 'unknown_session' || pendingSupportState === 'unknown_pending_version') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'pending_support_unknown',
            pendingSupportState,
        };
    }

    if (pendingSupportState === 'unsupported_cli_version') {
        return withDirectReason({
            mode: requestedMode === 'server_pending' ? 'agent_queue' : requestedMode,
            intent,
            reason: requestedMode === 'server_pending'
                ? 'pending_unsupported_cli_fallback'
                : 'pending_unsupported_cli_preserve_request',
            pendingSupportState,
        });
    }

    if (requestedMode === 'interrupt') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'interrupt',
            pendingSupportState,
            requestedAction: { v: 1, kind: 'send_now' },
        };
    }

    if (session?.active === false) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'inactive_session',
            pendingSupportState,
            requestedAction: { v: 1, kind: 'send_now' },
        };
    }

    const runtimeState = deriveSubmitRuntimeState(session, opts.nowMs ?? Date.now());
    const busySteerSendPolicy: BusySteerSendPolicy = opts.busySteerSendPolicy ?? DEFAULT_BUSY_STEER_SEND_POLICY;
    const canSteerBusyTurnNow = runtimeState.isBusy
        && runtimeState.inputReadinessDisposition === 'steer_available';

    if (opts.forceImmediate === true) {
        return {
            mode: 'server_pending',
            intent,
            reason: canSteerBusyTurnNow ? 'force_immediate_steer' : 'force_immediate_send',
            pendingSupportState,
            requestedAction: {
                v: 1,
                kind: canSteerBusyTurnNow ? 'steer_now' : 'send_now',
            },
        };
    }

    if (opts.explicitMode === 'server_pending') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'explicit_pending',
            pendingSupportState,
            requestedAction: { v: 1, kind: 'enqueue' },
        };
    }

    if (runtimeState.isBusy) {
        const nonSteerablePayloadReason = opts.providerNonSteerableReason
            ?? classifyLocalNonSteerablePayload({
                session,
                text: opts.text,
                nonSteerableSendPrompt: opts.nonSteerableSendPrompt,
                permissionModeApplyTiming: opts.permissionModeApplyTiming,
            });
        if (nonSteerablePayloadReason) {
            // G4 explicit user choices may only ride the steer path when the steer window is
            // actually open — a flag must never inject into a turn that cannot steer right now.
            if (
                nonSteerablePayloadReason === 'mode_change_refused'
                && canSteerBusyTurnNow
                && opts.applyConfigAndSteer === true
                && canApplySteerConfigInFlight(session)
            ) {
                return {
                    mode: 'server_pending',
                    intent,
                    reason: 'busy_steer_config_apply',
                    pendingSupportState,
                    requestedAction: { v: 1, kind: 'steer_now' },
                };
            }
            if (
                nonSteerablePayloadReason === 'mode_change_refused'
                && canSteerBusyTurnNow
                && opts.steerWithoutConfig === true
            ) {
                return {
                    mode: 'server_pending',
                    intent,
                    reason: 'busy_steer_text_only',
                    pendingSupportState,
                    requestedAction: { v: 1, kind: 'steer_now' },
                };
            }
            return {
                mode: 'server_pending',
                intent,
                reason: 'busy_non_steerable_payload_pending',
                pendingSupportState,
                nonSteerablePayloadReason,
                requestedAction: { v: 1, kind: 'enqueue' },
            };
        }
    }

    if (canSteerBusyTurnNow && busySteerSendPolicy === 'steer_immediately') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'busy_steer_immediate',
            pendingSupportState,
            requestedAction: { v: 1, kind: 'steer_if_active' },
        };
    }

    const unavailableReason = session?.agentState?.capabilities?.inFlightSteerUnavailableReason;
    return {
        mode: 'server_pending',
        intent,
        reason: runtimeState.localControlBlocksDirectSubmit
            ? 'local_control_pending'
            : runtimeState.isBusy
                ? 'busy_policy_pending'
                : !runtimeState.isOnline
                    ? 'offline_pending'
                    : !runtimeState.agentReady
                        ? 'agent_not_ready_pending'
                        : 'configured_pending',
        pendingSupportState,
        requestedAction: { v: 1, kind: 'enqueue' },
        ...(typeof unavailableReason === 'string' && unavailableReason.trim().length > 0
            ? { sessionSteerUnavailableReason: unavailableReason }
            : {}),
    };
}

export function chooseSubmitMode(opts: {
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    explicitMode?: MessageSendMode;
    session: Session | null;
    nowMs?: number;
    providerNonSteerableReason?: ProviderNonSteerableSendReason | null;
    text?: string;
    nonSteerableSendPrompt?: 'on' | 'off';
    permissionModeApplyTiming?: 'current_turn' | 'next_prompt';
    applyConfigAndSteer?: boolean;
    steerWithoutConfig?: boolean;
}): MessageSendMode {
    return decideSessionMessageDelivery(opts).mode;
}

export function chooseForceImmediateSubmitMode(opts: {
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    explicitMode?: MessageSendMode;
    session: Session | null;
    nowMs?: number;
    providerNonSteerableReason?: ProviderNonSteerableSendReason | null;
    text?: string;
    nonSteerableSendPrompt?: 'on' | 'off';
    permissionModeApplyTiming?: 'current_turn' | 'next_prompt';
    applyConfigAndSteer?: boolean;
    steerWithoutConfig?: boolean;
}): MessageSendMode {
    return decideSessionMessageDelivery({ ...opts, forceImmediate: true }).mode;
}
