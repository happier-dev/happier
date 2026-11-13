import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { isManagedPendingInputAwaitingWake } from '@/sync/domains/pending/managedWakeProjection';
import { t, type TranslationKeyNoParams } from '@/text';
import { isPendingDeliveryProviderEffectPossibleV1, type PendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import type { SessionInputAdmissionRejectionCodeV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { followInputNeedsYou, isHostAuthoredInputMeta, isHostOnboardingInputMeta, readHostFollowInputMeta } from '@/sync/domains/session/input/hostAuthoredInput';
import { followNoticeSourceKey, groupFollowNoticesBySource } from './followNoticeGroups';
import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { presentSessionActivationFailure, presentSessionContinuationFailure, type SessionActivationFailurePresentation } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { resolveSessionStartFailureNotice } from '@/components/sessions/startFailure/sessionStartFailureNotice';
import { readLatestLocalOutboundPendingUserMessageAt } from '@/sync/domains/messages/outgoingUserMessageActivity';

export type PendingMessageVisualStateKind =
    /** A new Session's launch owns this first message and has not confirmed it. */
    | 'starting'
    /** That launch ended without the agent accepting the message. */
    | 'launch_failed'
    /** That launch's outcome is unknown: the message may already have reached the agent. */
    | 'launch_unresolved'
    | 'saving'
    | 'send_unconfirmed'
    | 'send_failed'
    | 'cancelling'
    | 'cancel_failed'
    | 'queued'
    | 'delivering'
    | 'materializing'
    | 'blocked';

export type PendingMessageVisualState = Readonly<{
    kind: PendingMessageVisualStateKind;
    showSpinner: boolean;
    iconName: 'cloud-arrow-up' | 'clock' | 'navigation-arrow' | 'warning-circle';
    deliveryBlockedPresentation?: PendingDeliveryBlockedReasonPresentation;
    deliveryMutationPolicy?: 'effect_possible';
    queuedRequestedAction?: NonNullable<PendingMessage['pendingRequestedAction']>['kind'];
    queuedReason?:
        | 'waiting_for_foreground_turn'
        | 'waiting_for_runtime_activity'
        | 'runtime_activity_unknown'
        | 'waiting_for_predecessor'
        | 'waiting_for_blocked_predecessor'
        | 'waiting_for_runtime'
        | 'unsupported_action';
}>;

export type PendingMessageQueuedStateOptions = Readonly<{
    session?: Pick<Session, 'activeAt' | 'pendingActivationAuthorization' | 'pendingActivationFailureDetails'>
        & Partial<Pick<Session, 'active' | 'lastRuntimeIssue'>> | null;
    machineAccessRemoved?: boolean;
    hasEarlierRow?: boolean;
    /** An earlier row in this queue is itself blocked, so this one waits behind it. */
    hasBlockedEarlierRow?: boolean;
    hasProviderDeliveryInFlight?: boolean;
    runtimeReachable?: boolean;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
    deliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
    runtimeActivity?: 'idle' | 'active' | 'unknown';
}>;

export type PendingDeliveryBlockedReasonPresentation = Readonly<{
    labelKey: TranslationKeyNoParams;
    isUnknown: boolean;
    /** An owner-localized cause that replaces the generic delivery label. */
    message?: string;
    /**
     * The block is the Session's account, not this message: the Session says it once with this
     * recovery (`resolveSessionDeliveryFailure`), and the row does not repeat the reason.
     */
    recovery?: 'choose_account' | 'new_session';
}>;

/**
 * Whether a pending row states its own blocked reason. The block paints it as one line of meta on the
 * row's status line ("Blocked · reason", CALM-1110), so no delivery state changes the row's height.
 * Read off the presentation the block renders the reason from, not off a list of kinds. A block the
 * Session owns (its account) is said once by the Session, never on the row.
 */
export function pendingMessageStatesBlockedReason(visualState: PendingMessageVisualState): boolean {
    return visualState.deliveryBlockedPresentation !== undefined && visualState.deliveryBlockedPresentation.recovery === undefined;
}

/** The actual pending paint, shared by the presenter, reorder binding and transcript measurement. */
export type PendingMessageContentPresentation = Readonly<{
    isHostInput: boolean;
    /** A new Bot's first-run seed: a quiet host line the person cannot copy, edit or resend; its delivery fails at the Session, not here. */
    hostOnboarding: boolean;
    followInput: SessionFollowInputV1 | null;
    followSourceKey: string | null;
    needsYou: boolean;
}>;

export type PendingMessagePresentation = PendingMessageContentPresentation & Readonly<{
    message: PendingMessage;
    index: number;
    visualState: PendingMessageVisualState;
    folded: boolean;
    aggregate: boolean;
    count: number;
    opensSourceSession: boolean;
    /** `pendingMessageStatesBlockedReason`, except a new Bot's first-run seed, which never states one. */
    statesBlockedReason: boolean;
    canMutate: boolean;
    canReorder: boolean;
    queueLength: number;
    hasEarlierRow: boolean;
    hasBlockedEarlierRow: boolean;
}>;

export type PendingMessagesPresentation = Readonly<{
    messages: readonly PendingMessage[];
    rows: readonly PendingMessagePresentation[];
    rowsById: ReadonlyMap<string, PendingMessagePresentation>;
    shownRows: readonly PendingMessagePresentation[];
    foldKey: string;
    reorderableIds: ReadonlySet<string>;
    blockedMessage: PendingMessage | null;
    hasProviderDeliveryInFlight: boolean;
    latestLocalOutboundPendingUserMessageAt: number | null;
}>;

export type PendingMessagesPresentationByRecipient = ReadonlyMap<string | undefined, PendingMessagesPresentation>;

export function resolvePendingMessageContentPresentation(message: PendingMessage): PendingMessageContentPresentation {
    const contentOpen = message.pendingDecryptFailure?.kind !== 'decrypt_failed' && message.pendingDecryption?.kind !== 'loading';
    const followInput = contentOpen ? readHostFollowInputMeta(message.rawRecord?.meta, message.pendingHostFollowInput) : null;
    const hostOnboarding = contentOpen && isHostOnboardingInputMeta(message.rawRecord?.meta);
    return {
        isHostInput: hostOnboarding || (contentOpen && isHostAuthoredInputMeta(message.rawRecord?.meta, message.pendingHostFollowInput)),
        hostOnboarding,
        followInput,
        followSourceKey: followInput ? followNoticeSourceKey(followInput) : null,
        needsYou: followInput !== null && followInputNeedsYou(followInput),
    };
}

export function resolvePendingMessagesPresentation(
    messages: readonly PendingMessage[],
    options?: Readonly<{ materializingLocalIds?: ReadonlySet<string>; visibleMessageIds?: ReadonlySet<string>;
        /** The complete queue resolved once by the transcript projection, shared across its row hosts. */
        queueContext?: PendingMessagesPresentation;
    }> & Pick<PendingMessageQueuedStateOptions, 'session' | 'machineAccessRemoved'>,
): PendingMessagesPresentation {
    if (options?.queueContext) {
        // A local action can unfold Follow notices. Recompute the containing queue only for that
        // action; ordinary row renders and measurement consume the existing record-derived result.
        const queue = options.materializingLocalIds?.size
            ? resolvePendingMessagesPresentation(messages, { ...options, queueContext: undefined, visibleMessageIds: undefined })
            : options.queueContext;
        const selectedRows = options.visibleMessageIds
            ? Array.from(options.visibleMessageIds, (id) => queue.rowsById.get(id)).filter((row): row is PendingMessagePresentation => row !== undefined)
            : queue.rows;
        const rows = selectedRows.map((row) => {
            const visualState = getPendingMessageVisualState(row.message, { ...options,
                hasProviderDeliveryInFlight: queue.hasProviderDeliveryInFlight });
            return { ...row, visualState,
                statesBlockedReason: !row.hostOnboarding && pendingMessageStatesBlockedReason(visualState) };
        });
        return { ...queue, rows, rowsById: new Map(rows.map((row) => [row.message.id, row])),
            shownRows: rows.filter((row) => !row.folded),
            foldKey: rows.map((row) => `${row.message.id}:${row.folded}:${row.count}`).join('|') };
    }
    const hasProviderDeliveryInFlight = messages.some(isPendingMessageProviderDeliveryInFlight);
    const inputs = messages.map((message, index) => {
        const visualState = getPendingMessageVisualState(message, { ...options, hasProviderDeliveryInFlight });
        return { message, index, visualState, ...resolvePendingMessageContentPresentation(message) };
    });
    const groups = groupFollowNoticesBySource(inputs.map(row => ({ id: row.message.id, followInput: row.followInput,
        foldable: row.visualState.kind === 'queued' || row.visualState.kind === 'delivering' })));
    const blockedIndex = inputs.findIndex((row) => row.visualState.kind === 'blocked');
    let hasEarlierRow = false;
    const rows = inputs.map(row => {
        const group = groups.get(row.message.id);
        const folded = group?.kind === 'folded';
        const aggregate = group?.kind === 'lead';
        const followInput = aggregate ? group.followInput : row.followInput;
        const needsYou = followInput !== null && followInputNeedsYou(followInput);
        const presentation = { ...row, followInput, folded, aggregate, hasEarlierRow, queueLength: messages.length,
            hasBlockedEarlierRow: blockedIndex >= 0 && blockedIndex < row.index,
            followSourceKey: followInput ? followNoticeSourceKey(followInput) : null,
            count: aggregate ? group.count : 1,
            needsYou,
            opensSourceSession: needsYou && followInput !== null && 'sourceSessionId' in followInput.original,
            statesBlockedReason: !row.hostOnboarding && pendingMessageStatesBlockedReason(row.visualState),
            canMutate: !folded && !aggregate,
            canReorder: !folded && !aggregate && row.visualState.deliveryMutationPolicy !== 'effect_possible'
                && !isLaunchOwnedPendingMessage(row.message) };
        hasEarlierRow ||= row.message.source !== 'local_outbound' || row.message.deliveryStatus === 'accepted';
        return presentation;
    });
    const visibleRows = options?.visibleMessageIds ? rows.filter(row => options.visibleMessageIds!.has(row.message.id)) : rows;
    return { messages, rows, rowsById: new Map(rows.map((row) => [row.message.id, row])),
        reorderableIds: new Set(rows.filter((row) => row.canReorder).map((row) => row.message.localId ?? row.message.id)),
        blockedMessage: blockedIndex >= 0 ? messages[blockedIndex]! : null,
        hasProviderDeliveryInFlight,
        latestLocalOutboundPendingUserMessageAt: readLatestLocalOutboundPendingUserMessageAt(messages),
        shownRows: visibleRows.filter(row => !row.folded),
        foldKey: visibleRows.map(row => `${row.message.id}:${row.folded}:${row.count}`).join('|') };
}

/** Main and execution-run queues have independent predecessors and reorder scopes. */
export function resolvePendingMessagesPresentationByRecipient(
    messages: readonly PendingMessage[],
): PendingMessagesPresentationByRecipient {
    const queues = new Map<string | undefined, PendingMessage[]>();
    for (const message of messages) {
        const key = message.recipient?.runId;
        const queue = queues.get(key);
        if (queue) queue.push(message);
        else queues.set(key, [message]);
    }
    return new Map(Array.from(queues, ([key, queue]) => [key, resolvePendingMessagesPresentation(queue)]));
}

/** The record-derived paint for measurement, without resolving the queue again at each slot. */
export function resolvePendingMessageRowsForTranscript(
    messages: readonly PendingMessage[],
    queueContexts?: PendingMessagesPresentationByRecipient,
): readonly PendingMessagePresentation[] {
    if (!queueContexts) return resolvePendingMessagesPresentation(messages).shownRows;
    return messages.flatMap((message) => {
        const row = queueContexts.get(message.recipient?.runId)?.rowsById.get(message.id);
        return row && !row.folded ? [row] : [];
    });
}

const blockedReasonLabelKeys = {
    autonomous_check_in: 'settingsCoordination.checkInPaused',
    terminal_composer_draft: 'session.pendingMessages.deliveryBlockedReasons.terminalComposerDraft',
    capture_style_unavailable: 'session.pendingMessages.deliveryBlockedReasons.captureStyleUnavailable',
    provider_unavailable_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance',
    ambiguous_terminal_delivery: 'session.pendingMessages.deliveryBlockedReasons.ambiguousTerminalDelivery',
    // An effect may already have started: this row must not read like the "nothing was sent" case.
    delivery_outcome_uncertain: 'session.pendingMessages.deliveryBlockedReasons.deliveryOutcomeUncertain',
    team_access_removed: 'errors.permissionDenied',
    terminal_host_unreachable: 'session.pendingMessages.deliveryBlockedReasons.terminalHostUnreachable',
    runtime_disposed_before_delivery: 'session.pendingMessages.deliveryBlockedReasons.runtimeDisposedBeforeDelivery',
    host_retired_before_dispatch: 'session.pendingMessages.deliveryBlockedReasons.runtimeDisposedBeforeDelivery',
    session_input_target_unavailable: 'session.pendingMessages.deliveryBlockedReasons.targetUnavailable',
    runtime_config_blocked: 'session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked',
    invalid_prompt_text: 'session.pendingMessages.deliveryBlockedReasons.invalidPromptText',
    manual_user_handled: 'session.pendingMessages.deliveryBlockedReasons.manualUserHandled',
    attempt_expired_before_write: 'session.pendingMessages.deliveryBlockedReasons.attemptExpiredBeforeWrite',
    provider_rejected_before_acceptance: 'session.pendingMessages.deliveryBlockedReasons.providerRejectedBeforeAcceptance',
    steering_unavailable: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    conditional_steer_unavailable: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    unsupported_action: 'session.pendingMessages.deliveryBlockedReasons.unknown',
    payload_too_large: 'session.pendingMessages.deliveryBlockedReasons.payloadTooLarge',
    unknown: 'session.pendingMessages.deliveryBlockedReasons.unknown',
} satisfies Record<NonNullable<PendingMessage['pendingDeliveryBlockedReason']>, TranslationKeyNoParams>;

/** Run-launch failures and unconfirmed submission outcomes surfaced by the draft or Start Action. */
export type ExecutionRunLaunchFailureCode =
    | 'execution_run_target_changed'
    | 'execution_run_secret_reference_overlay_update_required'
    | 'model_structured_output_unsupported'
    | 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING'
    | typeof RPC_ERROR_CODES.OUTCOME_UNKNOWN;

export type SessionInputFailureCode = SessionInputAdmissionRejectionCodeV1 | ExecutionRunLaunchFailureCode;

/**
 * The single code → copy owner for target-admission and Run-launch failures. Producers throw errors
 * carrying `code` (`sync/engine/pending/pendingQueueV2.ts`, the Run draft) and the presentation
 * boundary resolves copy here; a raw snake_case code is never user-facing text.
 */
const sessionInputFailureLabelKeys = {
    session_input_muted: 'settingsCoordination.inputMuted',
    session_input_invalid: 'session.pendingMessages.admissionRejected.invalid',
    model_not_granted: 'session.pendingMessages.admissionRejected.modelNotGranted',
    permission_mode_not_granted: 'session.pendingMessages.admissionRejected.permissionModeNotGranted',
    session_input_archived: 'session.pendingMessages.admissionRejected.archived',
    session_input_unauthorized: 'session.pendingMessages.admissionRejected.unauthorized',
    session_input_target_unavailable: 'session.pendingMessages.admissionRejected.targetUnavailable',
    session_input_storage_unavailable: 'session.pendingMessages.admissionRejected.storageUnavailable',
    session_input_target_update_required: 'session.pendingMessages.admissionRejected.targetUpdateRequired',
    session_input_cancelled: 'session.pendingMessages.admissionRejected.cancelled',
    session_input_untrusted_assertion: 'session.pendingMessages.admissionRejected.untrustedAssertion',
    session_input_idempotency_conflict: 'session.pendingMessages.admissionRejected.idempotencyConflict',
    session_input_source_authority_mismatch: 'session.pendingMessages.admissionRejected.sourceAuthorityMismatch',
    session_input_permission_ceiling_rejected: 'session.pendingMessages.admissionRejected.permissionCeilingRejected',
    session_input_encryption_mode_mismatch: 'session.pendingMessages.admissionRejected.encryptionModeMismatch',
    execution_run_target_changed: 'sessionDrafts.executionRunStart.targetChanged',
    execution_run_secret_reference_overlay_update_required: 'sessionDrafts.executionRunStart.secretReferenceOverlayUpdateRequired',
    model_structured_output_unsupported: 'walkthrough.generationFailure.modelUnavailable',
    RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING: 'session.staleRunner.banner.body',
    [RPC_ERROR_CODES.OUTCOME_UNKNOWN]: 'sessionDrafts.executionRunStart.submittedUnknown',
} satisfies Record<SessionInputFailureCode, TranslationKeyNoParams>;

function isSessionInputFailureCode(value: unknown): value is SessionInputFailureCode {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(sessionInputFailureLabelKeys, value);
}

export function createSessionInputFailureError(code: SessionInputFailureCode): Error & { code: SessionInputFailureCode } {
    return Object.assign(new Error(code), { code });
}

/** The copy key for a coded failure, or `null` when the error carries no known code. */
export function getSessionInputFailureLabelKey(error: unknown): TranslationKeyNoParams | null {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return isSessionInputFailureCode(code) ? sessionInputFailureLabelKeys[code] : null;
}

function getDeliveryMutationPolicy(
    status: PendingDeliveryStatusV1,
): PendingMessageVisualState['deliveryMutationPolicy'] {
    return isPendingDeliveryProviderEffectPossibleV1(status) ? 'effect_possible' : undefined;
}

export function getPendingDeliveryBlockedReasonPresentation(
    message: Pick<PendingMessage, 'pendingDeliveryBlockedReason' | 'pendingDeliveryBlockedReasonRaw' | 'pendingDeliveryStatusRaw'>,
    machineAccessRemoved = false,
    session?: PendingMessageQueuedStateOptions['session'],
): PendingDeliveryBlockedReasonPresentation {
    const reason = message.pendingDeliveryBlockedReason ?? 'unknown';
    const continuation = reason === 'provider_rejected_before_acceptance' && session?.active === false
        ? presentSessionContinuationFailure(session.lastRuntimeIssue) : null;
    const cause = reason === 'runtime_config_blocked' && machineAccessRemoved
        ? t('machineRequester.accessRemoved', { machine: t('common.machine') }) : null;
    return {
        labelKey: blockedReasonLabelKeys[reason] ?? blockedReasonLabelKeys.unknown,
        ...(cause ? { message: cause } : {}),
        ...(continuation ? { recovery: 'new_session' as const }
            : reason === 'runtime_config_blocked' && !machineAccessRemoved ? { recovery: 'choose_account' as const } : {}),
        isUnknown:
            reason === 'unknown'
            || typeof message.pendingDeliveryBlockedReasonRaw === 'string'
            || typeof message.pendingDeliveryStatusRaw === 'string',
    };
}

/**
 * The one Session-level delivery failure: a queued message blocked by the Session's runtime
 * configuration (its Agent account). Every surface reads this answer — the composer line says it
 * with its recovery; the row and the activation line do not add their own words for it.
 */
export function resolveSessionDeliveryFailure(
    messages: readonly PendingMessage[],
    session: PendingMessageQueuedStateOptions['session'],
    machineAccessRemoved: boolean,
): SessionActivationFailurePresentation | null {
    for (const message of messages) {
        if (message.pendingDeliveryStatus !== 'blocked') continue;
        const recovery = getPendingDeliveryBlockedReasonPresentation(message, machineAccessRemoved, session).recovery;
        if (!recovery) continue;
        if (recovery === 'new_session') return presentSessionContinuationFailure(session?.lastRuntimeIssue);
        // The typed cause belongs to this input's own failed start, never another input or a later retry.
        const activation = session?.pendingActivationAuthorization;
        const ownFailedStart = session != null && activation?.status === 'failed'
            && activation.requestId === (message.localId ?? message.id) && activation.requestedAt > session.activeAt;
        return presentSessionActivationFailure(ownFailedStart ? session?.pendingActivationFailureDetails : null);
    }
    return null;
}

/**
 * Does a pending message row paint the IN-FLOW action row under its bubble?
 *
 * `PendingMessagesTranscriptBlock` renders `isWeb ? <copy/send actions> : canReorder ? <drag
 * handle> : null` — so a pending row on native paints nothing there unless the queue is reorderable,
 * which is exactly the shape a send creates. This is the single owner of that decision because it is
 * height-bearing: the size estimate modelled the row unconditionally 20px taller than native paints
 * it, and Legend accumulates that into a gap under the tail on every send.
 *
 * `canReorderPendingMessages` is decided PER ROW here, from that row's own delivery-mutation policy,
 * because this repo gates the reorder handle per row rather than for the whole block.
 */
export function paintsPendingMessageActionRow(params: Readonly<{
    platformIsWeb: boolean;
    canReorderPendingMessages: boolean;
}>): boolean {
    return params.platformIsWeb || params.canReorderPendingMessages;
}

export function isPendingMessageProviderDeliveryInFlight(message: PendingMessage): boolean {
    return message.pendingDeliveryStatus === 'server_delivering';
}

export function getPendingMessageVisualState(
    message: PendingMessage,
    options?: Readonly<{ materializingLocalIds?: ReadonlySet<string> }> & PendingMessageQueuedStateOptions,
): PendingMessageVisualState {
    const localId = typeof message.localId === 'string' ? message.localId : message.id;
    if (options?.materializingLocalIds?.has(localId)) {
        return {
            kind: 'materializing',
            showSpinner: true,
            iconName: 'navigation-arrow',
        };
    }

    const hasDurableServerPendingTruth = message.source === 'server_pending';
    // The Session's start-failure banner is the one voice for a start that failed: the launch row stops
    // saying "starting" and carries no second cause.
    if (!hasDurableServerPendingTruth && (message.pendingLaunch?.state === 'starting' || message.pendingLaunch?.state === 'failed')
        && options?.session && resolveSessionStartFailureNotice({
            issue: options.session.lastRuntimeIssue, sessionActive: options.session.active === true }) !== null) {
        return { kind: 'launch_failed', showSpinner: false, iconName: 'warning-circle' };
    }
    if (!hasDurableServerPendingTruth && message.pendingLaunch?.state === 'starting') {
        return { kind: 'starting', showSpinner: true, iconName: 'cloud-arrow-up' };
    }
    if (!hasDurableServerPendingTruth && message.pendingLaunch?.state === 'unresolved') {
        // Said once, on the row's own status line; no notice repeats the unknown outcome.
        return { kind: 'launch_unresolved', showSpinner: false, iconName: 'warning-circle' };
    }
    if (!hasDurableServerPendingTruth && message.pendingLaunch?.state === 'failed') {
        return {
            kind: 'launch_failed',
            showSpinner: false,
            iconName: 'warning-circle',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryStatus.notStarted',
                isUnknown: false,
                message: message.pendingLaunch.message,
            },
        };
    }
    if (!hasDurableServerPendingTruth && message.pendingOutboxOperation === 'cancel') {
        return message.sendState === 'failed'
            ? { kind: 'cancel_failed', showSpinner: false, iconName: 'warning-circle' }
            : { kind: 'cancelling', showSpinner: true, iconName: 'clock' };
    }
    if (!hasDurableServerPendingTruth && message.sendState === 'failed') {
        return {
            kind: 'send_failed',
            showSpinner: false,
            iconName: 'warning-circle',
        };
    }
    if (!hasDurableServerPendingTruth && message.sendState === 'unconfirmed') {
        return {
            kind: 'send_unconfirmed',
            showSpinner: true,
            iconName: 'cloud-arrow-up',
        };
    }

    if (message.source === 'local_outbound' && message.deliveryStatus !== 'accepted') {
        return {
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-arrow-up',
        };
    }

    if (message.pendingDeliveryStatus === 'blocked') {
        const deliveryMutationPolicy = getDeliveryMutationPolicy({
            status: 'blocked',
            reason: message.pendingDeliveryBlockedReason ?? 'unknown',
        });
        return {
            kind: 'blocked',
            showSpinner: false,
            iconName: 'warning-circle',
            deliveryBlockedPresentation: getPendingDeliveryBlockedReasonPresentation(message, options?.machineAccessRemoved, options?.session),
            ...(deliveryMutationPolicy ? { deliveryMutationPolicy } : {}),
        };
    }

    if (message.pendingDeliveryStatus === 'external_handoff') {
        return {
            kind: 'delivering',
            showSpinner: false,
            iconName: 'navigation-arrow',
            deliveryMutationPolicy: getDeliveryMutationPolicy({ status: 'external_handoff' }),
        };
    }

    if (message.pendingDeliveryStatus === 'server_delivering') {
        return {
            kind: 'delivering',
            showSpinner: true,
            iconName: 'navigation-arrow',
            deliveryMutationPolicy: getDeliveryMutationPolicy({ status: 'delivering' }),
        };
    }

    const queuedRequestedAction = message.pendingRequestedAction?.kind ?? 'enqueue';
    const queuedReason = derivePendingMessageQueuedReason(message, {
        hasEarlierRow: options?.hasEarlierRow ?? false,
        hasBlockedEarlierRow: options?.hasBlockedEarlierRow ?? false,
        hasProviderDeliveryInFlight: options?.hasProviderDeliveryInFlight ?? false,
        runtimeReachable: options?.runtimeReachable ?? true,
        foregroundState: options?.foregroundState ?? 'ready',
        deliveryTiming: options?.deliveryTiming ?? 'after_foreground_ready',
        runtimeActivity: options?.runtimeActivity ?? 'unknown',
    });
    return {
        kind: 'queued',
        showSpinner: false,
        iconName:
            queuedRequestedAction === 'steer_now'
            || queuedRequestedAction === 'send_now'
                ? 'navigation-arrow'
                : queuedReason === 'unsupported_action'
                    ? 'warning-circle'
                    : 'clock',
        queuedRequestedAction,
        ...(queuedReason ? { queuedReason } : {}),
    };
}

function derivePendingMessageQueuedReason(
    message: PendingMessage,
    context: Required<Omit<PendingMessageQueuedStateOptions, 'session' | 'machineAccessRemoved'>>,
): PendingMessageVisualState['queuedReason'] {
    if (message.pendingRequestedActionMalformed === true) return 'unsupported_action';
    if (!context.runtimeReachable) return 'waiting_for_runtime';

    const action = message.pendingRequestedAction?.kind ?? 'enqueue';
    const isUrgent = action === 'send_now'
        || action === 'steer_now'
        || (action === 'steer_if_active' && context.foregroundState === 'active_steerable');
    if (context.hasProviderDeliveryInFlight) return 'waiting_for_predecessor';
    if (isUrgent) return undefined;
    if (context.hasBlockedEarlierRow) return 'waiting_for_blocked_predecessor';
    if (context.hasEarlierRow) return 'waiting_for_predecessor';
    if (context.foregroundState !== 'ready') return 'waiting_for_foreground_turn';
    if (context.deliveryTiming !== 'after_runtime_idle') return undefined;
    if (context.runtimeActivity === 'active') return 'waiting_for_runtime_activity';
    if (context.runtimeActivity !== 'idle') return 'runtime_activity_unknown';
    return undefined;
}

/**
 * A Follow update the host queued for this Session is retained until its next turn (a worker's finish
 * is told quietly, never by waking the lead): it is waiting, not on its way. A blocked or failed row
 * says its own problem instead.
 */
export function isNextTurnHostInput(message: PendingMessage): boolean {
    return message.pendingDecryption?.kind !== 'loading' && message.pendingDecryptFailure?.kind !== 'decrypt_failed'
        && message.pendingDeliveryStatus !== 'blocked' && message.sendState !== 'failed'
        && isHostAuthoredInputMeta(message.rawRecord?.meta, message.pendingHostFollowInput);
}

/** The launch of a new Session owns this row; Message writers never act on it (one writer per input). */
export function isLaunchOwnedPendingMessage(message: PendingMessage): boolean {
    return message.source !== 'server_pending' && message.pendingLaunch !== undefined;
}

export function isAcceptedLocalPendingProjection(message: PendingMessage): boolean {
    return message.deliveryStatus === 'accepted' && message.source !== 'server_pending';
}

/** Shared by row actions and the empty-composer shortcut; in-flight custody stays with its sender. */
export function canUseDirectPendingDeliveryActions(
    message: PendingMessage,
    visualState = getPendingMessageVisualState(message),
    session?: Pick<Session, 'active' | 'pendingActivationAuthorization'> | null,
): boolean {
    const deliveryState = visualState.kind === 'materializing' ? getPendingMessageVisualState(message) : visualState;
    return !isManagedPendingInputAwaitingWake(message, session)
        && !isLaunchOwnedPendingMessage(message)
        && message.source !== 'local_outbound'
        && !isAcceptedLocalPendingProjection(message)
        && message.pendingDecryptFailure?.kind !== 'decrypt_failed'
        && message.pendingDecryption?.kind !== 'loading'
        && !message.pendingOutboxOperation
        && deliveryState.kind !== 'cancelling'
        && deliveryState.kind !== 'cancel_failed'
        && deliveryState.deliveryMutationPolicy !== 'effect_possible';
}
