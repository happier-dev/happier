import { isNonSteerablePromptPayload, type PendingRequestedActionV1 } from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';
import { getVersionSupportState, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import { getSessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';
import { deriveSessionInputReadinessState } from '@/sync/domains/session/control/deriveSessionInputReadinessState';
import {
    DEFAULT_SESSION_INACTIVE_RESUME_POLICY,
    type SessionInactiveResumePolicy,
} from '@/sync/domains/session/control/inactiveResumePolicy';

export type MessageSendMode = 'agent_queue' | 'interrupt' | 'server_pending';

export type BusySteerSendPolicy = 'steer_immediately' | 'server_pending';

export const DEFAULT_BUSY_STEER_SEND_POLICY: BusySteerSendPolicy = 'steer_immediately';

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
    | 'subagent_control_command';

/**
 * Why this specific payload cannot be steered into the active turn (lane P, O-design §2.2).
 * Computed UI-locally and synchronously — it mirrors the CLI's `bindPermissionModeQueue` steer
 * gate (mode change attached, or a `/clear`//`/compact` special command).
 */
export type NonSteerablePayloadReason =
    | 'mode_change_refused'
    | 'special_command'
    | 'provider_config_change_refused';

export type NonSteerableSendPromptSetting = 'ask' | 'queue_silently' | 'off';

export type SessionMessageDeliveryDecision = Readonly<{
    mode: MessageSendMode;
    intent: SessionMessageDeliveryIntent;
    reason: string;
    pendingSupportState: PendingQueueSubmitSupportState;
    /** Requested action frozen before this submission is durably enqueued. */
    requestedAction: PendingRequestedActionV1;
    directBypassReason?: SessionMessageDirectBypassReason;
    /** Present when a busy-steer send was demoted because the PAYLOAD is non-steerable. */
    nonSteerablePayloadReason?: NonSteerablePayloadReason;
    /** CLI-published reason (Seam A) when the SESSION cannot steer right now; absent on old CLIs. */
    sessionSteerUnavailableReason?: string | null;
}>;

type SessionSubmitRuntimeState = Readonly<{
    localControlBlocksDirectSubmit: boolean;
    isBusy: boolean;
    inputReadinessDisposition: 'accepts_next_turn' | 'steer_available' | 'blocked' | 'offline';
    isOnline: boolean;
    agentReady: boolean;
    inFlightSteerSupported: boolean | undefined;
    steerUnavailableReason: string | null;
    /** Lane Q: backend can apply a steered message's config delta (mode) to the RUNNING turn. */
    inFlightConfigApplySupported: boolean;
}>;

function deriveSubmitRuntimeState(session: Session | null, nowMs: number): SessionSubmitRuntimeState {
    const localControl = getSessionLocalControlState(session);
    const localControlBlocksDirectSubmit = localControl?.attached === true && localControl.remoteWritable !== true;
    const capabilities = session?.agentState?.capabilities;
    const inputReadiness = deriveSessionInputReadinessState({
        active: session?.active,
        activeAt: session?.activeAt,
        presence: session?.presence,
        thinking: session?.thinking,
        thinkingAt: session?.thinkingAt,
        latestTurnStatus: session?.latestTurnStatus,
        latestTurnStatusObservedAt: session?.latestTurnStatusObservedAt,
        inFlightSteerSupported: capabilities?.inFlightSteerSupported ?? capabilities?.inFlightSteer,
        inFlightSteerAvailable: capabilities?.inFlightSteerAvailable ?? capabilities?.inFlightSteer,
    }, nowMs);
    return {
        localControlBlocksDirectSubmit,
        isBusy: inputReadiness.isInputBusy,
        inputReadinessDisposition: inputReadiness.disposition,
        isOnline: session?.presence === 'online',
        agentReady: Boolean(session && session.agentStateVersion > 0),
        inFlightSteerSupported: capabilities?.inFlightSteerSupported ?? capabilities?.inFlightSteer,
        steerUnavailableReason: typeof capabilities?.inFlightSteerUnavailableReason === 'string'
            ? capabilities.inFlightSteerUnavailableReason
            : null,
        inFlightConfigApplySupported: capabilities?.inFlightConfigApplySupported === true,
    };
}

/**
 * Selects the one Queue V2 action justified by current runtime readiness.
 * Readiness facts remain owned by deriveSessionInputReadinessState; this function only maps
 * that result to the bounded row-action contract shared by UI send callers.
 */
export function selectSessionPendingRequestedAction(opts: {
    session: Session | null;
    nowMs?: number;
    firstTurn?: boolean;
    preferSteer?: boolean;
    /** How ordinary input may resume an inactive/offline runtime. */
    sessionInactiveResumePolicy?: SessionInactiveResumePolicy;
    /** Explicit user override of the pending delivery timing preference; control serviceability still applies. */
    timingOverride?: 'send_now';
}): PendingRequestedActionV1 {
    const session = opts.session;
    if (!session) return { v: 1, kind: opts.timingOverride === 'send_now' ? 'send_now' : 'enqueue' };
    if (session.active === false) {
        return {
            v: 1,
            kind: opts.firstTurn === true
                || opts.timingOverride === 'send_now'
                || (opts.sessionInactiveResumePolicy ?? DEFAULT_SESSION_INACTIVE_RESUME_POLICY) === 'when_available'
                ? 'send_now'
                : 'enqueue',
        };
    }
    if (opts.firstTurn === true) {
        return { v: 1, kind: 'send_now' };
    }

    const runtimeState = deriveSubmitRuntimeState(session, opts.nowMs ?? Date.now());
    if (!runtimeState.isOnline) {
        return {
            v: 1,
            kind: opts.timingOverride === 'send_now'
                || (opts.sessionInactiveResumePolicy ?? DEFAULT_SESSION_INACTIVE_RESUME_POLICY) === 'when_available'
                ? 'send_now'
                : 'enqueue',
        };
    }

    if (runtimeState.localControlBlocksDirectSubmit || !runtimeState.agentReady) {
        return { v: 1, kind: opts.timingOverride === 'send_now' ? 'send_now' : 'enqueue' };
    }

    if (opts.timingOverride === 'send_now') {
        return { v: 1, kind: runtimeState.inputReadinessDisposition === 'steer_available' ? 'steer_now' : 'send_now' };
    }
    if (opts.preferSteer === true && runtimeState.inFlightSteerSupported === true) {
        return { v: 1, kind: 'steer_if_active' };
    }
    return { v: 1, kind: 'enqueue' };
}

function normalizeTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Best-effort start estimate of the ACTIVE turn (lane X, X2): the `in_progress` observation
 * timestamp when present, else the thinking timestamp. Used only to distinguish a FRESH
 * user-intended mode change from standing desired≠published drift; `null` when no estimate exists
 * (then the change is treated as fresh — conservative toward the honest modal).
 */
function estimateActiveTurnStartMs(session: Session | null): number | null {
    if (!session) return null;
    const inProgressAt = normalizeTimestamp(session.latestTurnStatusObservedAt);
    if (session.latestTurnStatus === 'in_progress' && inProgressAt !== null) {
        return inProgressAt;
    }
    return session.thinking === true ? normalizeTimestamp(session.thinkingAt) : null;
}

/**
 * UI-local payload steerability check (lane P, O-design §2.2): mirrors the CLI steer gate in
 * `bindPermissionModeQueue` exactly — a message that changes the permission mode or carries a
 * special command (`/clear`, `/compact …`) is never steerable into the active turn.
 *
 * Mode-change detection compares the locally selected mode (attached to outgoing message meta by
 * `sendMessage`) with the runner's published current mode. With
 * `sessionPermissionModeApplyTiming === 'next_prompt'` the mode never applies mid-turn by
 * definition, so it is not a steer blocker.
 *
 * Fresh-change gate (lane X, X2, incident cmq8y3nlx): only a FRESH user-intended change — made at
 * or after the active turn started — counts as a mode-change payload. Standing desired≠published
 * drift (e.g. a never-converged setting from a previous turn) rides the normal steer path
 * silently; the CLI's before-prompt/in-flight controller already applies and converges it, with
 * the runtime-config-outcome event as the visible record. Drift with NO user-change timestamp is
 * standing drift by definition.
 */
export function getNonSteerablePayloadReason(opts: {
    session: Session | null;
    text?: string;
    permissionModeApplyTiming?: 'immediate' | 'next_prompt';
    providerNonSteerablePayloadReason?: Extract<NonSteerablePayloadReason, 'provider_config_change_refused'> | null;
}): NonSteerablePayloadReason | null {
    const text = (opts.text ?? '').trim();
    if (isNonSteerablePromptPayload(text)) {
        return 'special_command';
    }
    if (opts.providerNonSteerablePayloadReason === 'provider_config_change_refused') {
        return opts.providerNonSteerablePayloadReason;
    }
    if ((opts.permissionModeApplyTiming ?? 'immediate') === 'next_prompt') {
        return null;
    }
    const selectedMode = opts.session?.permissionMode ?? null;
    if (typeof selectedMode !== 'string' || selectedMode.length === 0) {
        return null;
    }
    const currentModeRaw = opts.session?.metadata?.permissionMode;
    const currentMode = typeof currentModeRaw === 'string' && currentModeRaw.length > 0 ? currentModeRaw : 'default';
    if (selectedMode === currentMode) {
        return null;
    }
    const changedAt = normalizeTimestamp(opts.session?.permissionModeUpdatedAt);
    if (changedAt === null) {
        return null;
    }
    const turnStartMs = estimateActiveTurnStartMs(opts.session ?? null);
    if (turnStartMs !== null && changedAt < turnStartMs) {
        return null;
    }
    return 'mode_change_refused';
}

/**
 * Lane Q: whether the session's backend published the in-flight config-apply capability —
 * it can apply a steered message's permission/plan mode delta to the RUNNING turn, so the
 * non-steerable-send affordance may offer "Apply setting & steer now". Fail-closed on absence.
 */
export function canApplySteerConfigInFlight(session: Session | null): boolean {
    return session?.agentState?.capabilities?.inFlightConfigApplySupported === true;
}

export function supportsInFlightSteerUserMessage(opts: {
    session: Session | null;
    nowMs?: number;
}): boolean {
    const session = opts.session;
    if (!session || session.active !== true || session.agentState?.controlledByUser === true) {
        return false;
    }

    const runtimeState = deriveSubmitRuntimeState(session, opts.nowMs ?? Date.now());
    return Boolean(
        !runtimeState.localControlBlocksDirectSubmit
        && runtimeState.isOnline
        && runtimeState.agentReady
        && runtimeState.inFlightSteerSupported === true
    );
}

export function canSteerUserMessageNow(opts: {
    session: Session | null;
    nowMs?: number;
}): boolean {
    const action = selectSessionPendingRequestedAction({ ...opts, preferSteer: true });
    return action.kind === 'steer_if_active' || action.kind === 'steer_now';
}

export function canDirectSubmitUserMessageNow(opts: {
    session: Session | null;
    nowMs?: number;
}): boolean {
    return opts.session !== null;
}

export function isPendingQueueSubmitKnownUnsupported(session: Session | null): boolean {
    return getPendingQueueSubmitSupportState(session) === 'unsupported_cli_version';
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
    if (
        trimmedCliVersion
        && getVersionSupportState(trimmedCliVersion, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION) === 'unsupported'
    ) {
        return 'unsupported_cli_version';
    }

    return 'supported';
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
    /** Account preference controlling resume behavior for ordinary inactive/offline sends. */
    sessionInactiveResumePolicy?: SessionInactiveResumePolicy;
    /** Outgoing message text — enables the payload-aware steer gate (lane P). */
    text?: string;
    /** `sessionPermissionModeApplyTiming` setting; `next_prompt` skips the mode-change gate. */
    permissionModeApplyTiming?: 'immediate' | 'next_prompt';
    /** `sessionNonSteerableSendPrompt` setting; `off` restores the legacy (silent) behavior. */
    nonSteerableSendPrompt?: NonSteerableSendPromptSetting;
    /** Provider-owned classifier output for outgoing config metadata that cannot be steered. */
    providerNonSteerablePayloadReason?: Extract<NonSteerablePayloadReason, 'provider_config_change_refused'> | null;
    /**
     * Lane Q: explicit user choice ("Apply setting & steer now") — the mode-change payload may
     * take the steer path because the backend owns the delta in-turn. Only honored when the
     * session publishes `inFlightConfigApplySupported` (fail-closed) and never for special commands.
     */
    applyConfigAndSteer?: boolean;
    /**
     * Lane X (X3 Case B): explicit user choice "Steer now without applying" — the TEXT steers the
     * running turn; the mode/setting stays desired-state and applies later via the normal path
     * (the caller sends the message with the published current mode so no delta rides it).
     * Never honored for special commands.
     */
    steerWithoutConfig?: boolean;
}): SessionMessageDeliveryDecision {
    const configuredMode = opts.configuredMode;
    const requestedMode = opts.explicitMode ?? configuredMode;
    const transportMode: MessageSendMode = requestedMode === 'interrupt' ? 'server_pending' : requestedMode;
    const intent = getDeliveryIntent(opts);
    const pendingSupportState = getPendingQueueSubmitSupportState(opts.session);

    const session = opts.session;
    const requestedAction = selectSessionPendingRequestedAction({
        session,
        nowMs: opts.nowMs,
        preferSteer: opts.explicitMode !== 'server_pending'
            && configuredMode !== 'server_pending'
            && (opts.busySteerSendPolicy ?? DEFAULT_BUSY_STEER_SEND_POLICY) === 'steer_immediately',
        ...(opts.forceImmediate === true ? { timingOverride: 'send_now' as const } : {}),
        sessionInactiveResumePolicy: opts.sessionInactiveResumePolicy,
    });
    if (
        opts.forceImmediate === true
        && requestedAction.kind !== 'enqueue'
    ) {
        return withDirectReason({
            mode: 'agent_queue',
            intent,
            reason: 'force_immediate_direct',
            pendingSupportState,
            requestedAction,
        });
    }

    // Server-side pending queue V2 support is negotiated via session summary fields.
    // Mixed-version safety: older servers won't include these fields.
    const supportsQueue = typeof session?.pendingVersion === 'number';
    if (!supportsQueue) {
        // Missing support metadata is an unknown state, not permission to bypass an
        // explicit queueing intent. Preserve server_pending so callers fail closed
        // through the queue path instead of steering directly.
        return withDirectReason({
            mode: transportMode,
            intent,
            reason: requestedMode === 'server_pending'
                ? 'pending_support_unknown'
                : requestedMode === 'interrupt'
                    ? 'pending_support_unknown_interrupt'
                    : 'pending_support_unknown_preserve_request',
            pendingSupportState,
            requestedAction,
        });
    }

    // If we have an explicit CLI version published, gate server_pending on it to avoid
    // stranded pending messages when an older agent is attached.
    const cliVersion = session?.metadata?.version;
    const trimmedCliVersion = typeof cliVersion === 'string' ? cliVersion.trim() : '';
    if (trimmedCliVersion) {
        if (getVersionSupportState(trimmedCliVersion, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION) === 'unsupported') {
            if (requestedMode === 'interrupt') {
                return {
                    mode: 'server_pending',
                    intent,
                    reason: 'pending_unsupported_cli_interrupt',
                    pendingSupportState,
                    requestedAction,
                };
            }
            return withDirectReason({
                mode: requestedMode === 'server_pending' ? 'agent_queue' : requestedMode,
                intent,
                reason: requestedMode === 'server_pending' ? 'pending_unsupported_cli_fallback' : 'pending_unsupported_cli_preserve_request',
                pendingSupportState,
                requestedAction,
            });
        }
    }

    if (opts.explicitMode === 'server_pending') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'explicit_pending',
            pendingSupportState,
            requestedAction,
        };
    }

    if (requestedMode === 'interrupt') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'interrupt_pending',
            pendingSupportState,
            requestedAction: { v: 1, kind: 'send_now' },
        };
    }

    if (
        opts.forceImmediate === true
        && session?.active === true
        && session.presence === 'online'
    ) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'force_immediate_pending_dispatch',
            pendingSupportState,
            requestedAction,
        };
    }

    if (session?.active === false) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'inactive_session',
            pendingSupportState,
            requestedAction,
        };
    }

    const runtimeState = deriveSubmitRuntimeState(session, opts.nowMs ?? Date.now());
    const busySteerSendPolicy: BusySteerSendPolicy = opts.busySteerSendPolicy ?? DEFAULT_BUSY_STEER_SEND_POLICY;

    // Prefer the metadata-backed queue when:
    // - terminal has control (can't safely inject into local stdin),
    // - the agent is busy (user may want to edit/remove before processing),
    // - the agent is not ready yet (direct sends can be missed because the agent does not replay backlog), or
    // - the machine is offline (queue gives reliable eventual processing once it reconnects).
    //
    // A steer-capable busy turn is durable-first: enqueue the exact row, then request steer-now.
    // This preserves the current turn without making provider delivery the message's first custody boundary.
    // Payload-aware steer gate (lane P, O-design §2.2): a busy send whose PAYLOAD cannot be
    // steered must never silently take the agent_queue path — it would render as delivered while
    // the CLI demotes it invisibly. The kill-switch setting restores legacy behavior.
    const nonSteerablePayloadReason = runtimeState.isBusy && (opts.nonSteerableSendPrompt ?? 'ask') !== 'off'
        ? getNonSteerablePayloadReason({
            session,
            text: opts.text,
            permissionModeApplyTiming: opts.permissionModeApplyTiming,
            providerNonSteerablePayloadReason: opts.providerNonSteerablePayloadReason,
        })
        : null;

    if (
        requestedAction.kind === 'steer_if_active'
        && busySteerSendPolicy === 'steer_immediately'
    ) {
        if (nonSteerablePayloadReason !== null) {
            if (
                nonSteerablePayloadReason === 'mode_change_refused'
                && opts.steerWithoutConfig === true
            ) {
                // Lane X (X3 Case B): the user chose to steer the text only. Keep delivery
                // durable-first; the pending pump will inject the text when the terminal can
                // safely accept it.
                return {
                    mode: 'server_pending',
                    intent,
                    reason: 'busy_steer_text_only',
                    pendingSupportState,
                    requestedAction,
                };
            }
            if (
                nonSteerablePayloadReason === 'mode_change_refused'
                && opts.applyConfigAndSteer === true
                && runtimeState.inFlightConfigApplySupported
            ) {
                // Lane Q: the backend applies the mode delta to the running turn, then steers the
                // text. The prompt itself still starts from the durable pending queue so an
                // occupied runtime slot cannot drop it.
                return {
                    mode: 'server_pending',
                    intent,
                    reason: 'busy_steer_config_apply',
                    pendingSupportState,
                    requestedAction,
                };
            }
            return {
                mode: 'server_pending',
                intent,
                reason: 'busy_non_steerable_payload_pending',
                pendingSupportState,
                requestedAction: { v: 1, kind: 'enqueue' },
                nonSteerablePayloadReason,
            };
        }
        return {
            mode: 'server_pending',
            intent,
            reason: 'busy_steer_immediate',
            pendingSupportState,
            requestedAction,
        };
    }

    if (runtimeState.localControlBlocksDirectSubmit) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'local_control_pending',
            pendingSupportState,
            requestedAction,
        };
    }

    if (runtimeState.isBusy) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'busy_policy_pending',
            pendingSupportState,
            requestedAction,
            ...(nonSteerablePayloadReason !== null ? { nonSteerablePayloadReason } : {}),
            ...(runtimeState.steerUnavailableReason !== null
                ? { sessionSteerUnavailableReason: runtimeState.steerUnavailableReason }
                : {}),
        };
    }

    if (runtimeState.inputReadinessDisposition === 'blocked') {
        return {
            mode: 'server_pending',
            intent,
            reason: 'runtime_readiness_blocked',
            pendingSupportState,
            requestedAction,
        };
    }

    if (!runtimeState.isOnline) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'offline_pending',
            pendingSupportState,
            requestedAction,
        };
    }

    if (!runtimeState.agentReady) {
        return {
            mode: 'server_pending',
            intent,
            reason: 'agent_not_ready_pending',
            pendingSupportState,
            requestedAction,
        };
    }

    return withDirectReason({
        mode: configuredMode,
        intent,
        reason: 'configured_mode',
        pendingSupportState,
        requestedAction,
    });
}

export function chooseSubmitMode(opts: {
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    explicitMode?: MessageSendMode;
    session: Session | null;
    nowMs?: number;
}): MessageSendMode {
    return decideSessionMessageDelivery(opts).mode;
}

export function chooseForceImmediateSubmitMode(opts: {
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    explicitMode?: MessageSendMode;
    session: Session | null;
    nowMs?: number;
}): MessageSendMode {
    return decideSessionMessageDelivery({ ...opts, forceImmediate: true }).mode;
}
