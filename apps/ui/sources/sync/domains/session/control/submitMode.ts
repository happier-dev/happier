import type { Session } from '@/sync/domains/state/storageTypes';
import { isVersionSupported, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import { isSessionExclusiveLocalControl } from '@/sync/domains/session/control/sessionLocalControl';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import type { AgentSessionComposerNonSteerableReason } from '@/agents/registry/registryUiBehavior';

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
    | 'server_scoped_rpc'
    | 'spawn_post_process';

export type SessionMessageDeliveryDecision = Readonly<{
    mode: MessageSendMode;
    intent: SessionMessageDeliveryIntent;
    reason: string;
    pendingSupportState: PendingQueueSubmitSupportState;
    directBypassReason?: SessionMessageDirectBypassReason;
    nonSteerablePayloadReason?: string;
    sessionSteerUnavailableReason?: string;
}>;

type SessionSubmitRuntimeState = Readonly<{
    localControlBlocksDirectSubmit: boolean;
    isBusy: boolean;
    isOnline: boolean;
    agentReady: boolean;
    providerInFlightSteerSupported: boolean;
    inFlightSteerSupported: boolean | undefined;
    inFlightSteerAvailable: boolean | undefined;
}>;

function getProviderInFlightSteerSupported(session: Session | null): boolean {
    const sessionFlavor = typeof session?.metadata?.flavor === 'string'
        ? session.metadata.flavor
        : null;
    const agentId = resolveAgentIdFromFlavor(sessionFlavor);
    if (!agentId) return false;
    return getAgentCore(agentId).runtimeInput?.inFlightSteerSupported === true;
}

function deriveSubmitRuntimeState(session: Session | null, nowMs: number): SessionSubmitRuntimeState {
    const localControlBlocksDirectSubmit = isSessionExclusiveLocalControl(session);
    const runtimeStatus = deriveSessionRuntimePresentationState({
        active: session?.active,
        activeAt: session?.activeAt,
        presence: session?.presence,
        thinking: session?.thinking,
        thinkingAt: session?.thinkingAt,
        latestTurnStatus: session?.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session?.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: session?.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session?.lastRuntimeIssue ?? null,
        nowMs,
    });
    const capabilities = session?.agentState?.capabilities;
    const providerInFlightSteerSupported = getProviderInFlightSteerSupported(session);
    return {
        localControlBlocksDirectSubmit,
        isBusy: runtimeStatus.working,
        isOnline: session?.presence === 'online',
        agentReady: Boolean(session && session.agentStateVersion > 0),
        providerInFlightSteerSupported,
        inFlightSteerSupported: capabilities?.inFlightSteerSupported
            ?? capabilities?.inFlightSteer
            ?? providerInFlightSteerSupported,
        inFlightSteerAvailable: capabilities?.inFlightSteerAvailable
            ?? capabilities?.inFlightSteer
            ?? providerInFlightSteerSupported,
    };
}

function readSessionRecordValue(session: Session | null, key: string): unknown {
    return session ? (session as unknown as Record<string, unknown>)[key] : undefined;
}

function readSessionMetadataValue(session: Session | null, key: string): unknown {
    const metadata = session?.metadata;
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

function isSpecialSteerCommand(text: string | undefined): boolean {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    return /^\/(?:clear|compact)(?:\s|$)/.test(trimmed);
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
    if (isSpecialSteerCommand(opts.text)) return 'special_command';
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
    if (!opts.session || opts.session.active === false) {
        return false;
    }

    const runtimeState = deriveSubmitRuntimeState(opts.session, opts.nowMs ?? Date.now());
    if (
        runtimeState.localControlBlocksDirectSubmit
        || !runtimeState.isOnline
        || !runtimeState.agentReady
    ) {
        return false;
    }

    if (!runtimeState.isBusy) {
        return true;
    }

    return runtimeState.inFlightSteerSupported === true
        && runtimeState.inFlightSteerAvailable === true
        && (runtimeState.agentReady || runtimeState.providerInFlightSteerSupported);
}

export function getPendingQueueSubmitSupportState(session: Session | null): PendingQueueSubmitSupportState {
    if (!session) {
        return 'unknown_session';
    }

    if (typeof session.pendingVersion !== 'number') {
        return 'unknown_pending_version';
    }

    const cliVersion = session?.metadata?.version;
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
    const configuredMode = opts.configuredMode;
    const requestedMode = opts.explicitMode ?? configuredMode;
    const intent = getDeliveryIntent(opts);
    const session = opts.session;
    const pendingSupportState = getPendingQueueSubmitSupportState(session);

    if (requestedMode === 'interrupt') {
        return withDirectReason({
            mode: 'interrupt',
            intent,
            reason: 'interrupt',
            pendingSupportState,
        });
    }

    if (
        opts.forceImmediate === true
        && canDirectSubmitUserMessageNow({ session, nowMs: opts.nowMs })
    ) {
        return withDirectReason({
            mode: 'agent_queue',
            intent,
            reason: 'force_immediate_direct',
            pendingSupportState,
        });
    }

    // Server-side pending queue V2 support is negotiated via session summary fields.
    // A missing version is an unknown state, not permission to bypass a queueing intent.
    if (pendingSupportState === 'unknown_session' || pendingSupportState === 'unknown_pending_version') {
        return withDirectReason({
            mode: requestedMode,
            intent,
            reason: requestedMode === 'server_pending'
                ? 'pending_support_unknown'
                : 'pending_support_unknown_preserve_request',
            pendingSupportState,
        });
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

    if (opts.explicitMode === 'server_pending') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'explicit_pending',
            pendingSupportState,
        };
    }

    if (session?.active === false) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'inactive_session',
            pendingSupportState,
        };
    }

    const runtimeState = deriveSubmitRuntimeState(session, opts.nowMs ?? Date.now());
    const busySteerSendPolicy: BusySteerSendPolicy = opts.busySteerSendPolicy ?? DEFAULT_BUSY_STEER_SEND_POLICY;

    // The in-flight steer window: the running turn can accept a steered message right now.
    const canSteerBusyTurnNow = runtimeState.isBusy
        && runtimeState.inFlightSteerSupported === true
        && runtimeState.inFlightSteerAvailable === true
        && !runtimeState.localControlBlocksDirectSubmit
        && runtimeState.isOnline
        && (runtimeState.agentReady || runtimeState.providerInFlightSteerSupported)
        && busySteerSendPolicy === 'steer_immediately';

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
                return withDirectReason({
                    mode: 'agent_queue',
                    intent,
                    reason: 'busy_steer_config_apply',
                    pendingSupportState,
                });
            }
            if (
                nonSteerablePayloadReason === 'mode_change_refused'
                && canSteerBusyTurnNow
                && opts.steerWithoutConfig === true
            ) {
                return withDirectReason({
                    mode: 'agent_queue',
                    intent,
                    reason: 'busy_steer_text_only',
                    pendingSupportState,
                });
            }
            return {
                mode: 'server_pending',
                intent,
                reason: 'busy_non_steerable_payload_pending',
                pendingSupportState,
                nonSteerablePayloadReason,
            };
        }
    }

    // Prefer the metadata-backed queue when:
    // - terminal has control (can't safely inject into local stdin),
    // - the agent is busy (user may want to edit/remove before processing),
    // - the agent is not ready yet (direct sends can be missed because the agent does not replay backlog), or
    // - the machine is offline (queue gives reliable eventual processing once it reconnects).
    //
    // Exception: if the agent supports in-flight steer and is online+ready, do not auto-enqueue while busy.
    // Dev also preserves the provider-registry fallback for agents whose capability snapshot is incomplete.
    if (
        runtimeState.isBusy
        && runtimeState.inFlightSteerSupported === true
        && runtimeState.inFlightSteerAvailable === true
        && !runtimeState.localControlBlocksDirectSubmit
        && runtimeState.isOnline
        && (runtimeState.agentReady || runtimeState.providerInFlightSteerSupported)
        && busySteerSendPolicy === 'steer_immediately'
    ) {
        return withDirectReason({
            mode: 'agent_queue',
            intent,
            reason: 'busy_steer_immediate',
            pendingSupportState,
        });
    }

    if (runtimeState.localControlBlocksDirectSubmit) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'local_control_pending',
            pendingSupportState,
        };
    }

    if (runtimeState.isBusy) {
        const unavailableReason = session?.agentState?.capabilities?.inFlightSteerUnavailableReason;
        return {
            mode: 'server_pending',
            intent,
            reason: 'busy_policy_pending',
            pendingSupportState,
            ...(typeof unavailableReason === 'string' && unavailableReason.trim().length > 0
                ? { sessionSteerUnavailableReason: unavailableReason }
                : {}),
        };
    }

    if (!runtimeState.isOnline) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'offline_pending',
            pendingSupportState,
        };
    }

    if (!runtimeState.agentReady) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'agent_not_ready_pending',
            pendingSupportState,
        };
    }

    return withDirectReason({
        mode: configuredMode,
        intent,
        reason: 'configured_mode',
        pendingSupportState,
    });
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
