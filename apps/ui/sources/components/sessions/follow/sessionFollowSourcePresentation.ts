import { isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';
import { supportsMachineSessionFollowContextV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { SessionFollowSourceKeyPreparationWaitingReasonV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowSourceDeliveryStateV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { resolveSessionFollowRuleOccurrenceEvaluatorV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';

import { t } from '@/text';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type SessionFollowSourceRuntimeState =
    | SessionFollowSourceDeliveryStateV1
    | 'waiting_for_runtime'
    | 'runtime_unsupported'
    | 'waiting_for_source_key'
    /**
     * Not a wait: this destination runtime holds no key material it could ever use
     * for this source, so repeating the preparation cannot change the answer.
     */
    | 'runner_key_unavailable'
    /**
     * Also not a wait: this client holds no usable encryption material for the SOURCE Session,
     * so nothing the destination Runner does can complete the preparation.
     */
    | 'source_key_unavailable'
    | 'waiting_for_authorized_device'
    | 'catch_up_pending';

/** A known pending original/progress fact, never a match inferred from a private-rule read failure. */
export type SessionFollowPersonRuleEvaluationInput = Readonly<{
    accountId: string;
    ownerAccountId: string;
    production: 'source' | 'recovery';
    hasPendingOccurrence: boolean;
    authorization: 'authorized' | 'absent' | 'locked' | 'wrong_mode';
}>;

export type SessionFollowPersonRulePendingState = 'waiting_for_authorized_device' | 'catch_up_pending';
/** Content-free projection of known pending originals; its owning Account must still match at display. */
export type SessionFollowPersonRuleEvaluationProjection = Readonly<{
    accountId: string;
    pendingBySourceSessionId: Readonly<Record<string, SessionFollowPersonRulePendingState>>;
}>;

export function resolveSessionFollowPersonRulePendingState(
    input: SessionFollowPersonRuleEvaluationInput,
): SessionFollowPersonRulePendingState | null {
    if (!input.hasPendingOccurrence || resolveSessionFollowRuleOccurrenceEvaluatorV1(input) !== 'receiver') return null;
    return input.authorization === 'authorized' ? 'catch_up_pending' : 'waiting_for_authorized_device';
}

export function listEligibleSessionFollowSourceCandidates<T extends Readonly<{ id: string }>>(input: Readonly<{
    sessions: readonly T[];
    destination: Readonly<{ serverId: string; sessionId: string }>;
    existingSourceSessionIds: readonly string[];
    resolveServerId(sessionId: string): string | null;
}>): T[] {
    const existing = new Set(input.existingSourceSessionIds);
    return input.sessions.filter((session) => (
        session.id !== input.destination.sessionId
        && !existing.has(session.id)
        && input.resolveServerId(session.id) === input.destination.serverId
    ));
}

export function resolveSessionFollowSourceRuntimeState(input: Readonly<{
    deliveryState: SessionFollowSourceDeliveryStateV1;
    accountScope?: ServerAccountScope | null;
    machine: Readonly<{
        id: string;
        kind?: 'persistent' | 'ephemeral_session_runner';
        active: boolean;
        activeAt?: number | null;
        revokedAt?: number | null;
        operationProtocolCapabilities?: unknown;
    }> | null;
    sourceEncryptionMode?: 'plain' | 'e2ee' | null;
    preparedInUiLifetime?: boolean;
    hasPendingUpdates?: boolean;
    personRuleEvaluation?: SessionFollowPersonRuleEvaluationInput;
    nowMs?: number;
}>): SessionFollowSourceRuntimeState {
    if (input.deliveryState === 'paused_archived') return 'paused_archived';
    if (input.personRuleEvaluation) return resolveSessionFollowPersonRulePendingState(input.personRuleEvaluation) ?? 'eligible';
    if (!input.machine || !isMachineReachable(input.accountScope, input.machine, input.nowMs)) return 'waiting_for_runtime';
    if (!supportsMachineSessionFollowContextV1(input.machine.operationProtocolCapabilities)) return 'runtime_unsupported';
    if (
        !isPersistentMachine(input.machine)
        && input.sourceEncryptionMode !== 'plain'
        && input.preparedInUiLifetime !== true
    ) return 'waiting_for_source_key';
    if (input.hasPendingUpdates === true) return 'catch_up_pending';
    return 'eligible';
}

/**
 * The single owner of what a Protocol waiting reason means for a source row.
 *
 * The picker and the sources editor both explain the same preparation result, so
 * the mapping lives here rather than being re-decided at each surface. A reason
 * only refines the waiting state it explains; it never overrides a settled one.
 */
export function refineSessionFollowSourceStateWithPreparationReason(
    state: SessionFollowSourceRuntimeState,
    reason: SessionFollowSourceKeyPreparationWaitingReasonV1 | undefined,
): SessionFollowSourceRuntimeState {
    if (state !== 'waiting_for_source_key' || reason === undefined) return state;
    switch (reason) {
        case 'runner_unreachable': return 'waiting_for_runtime';
        case 'unsupported': return 'runtime_unsupported';
        case 'runner_key_unavailable': return 'runner_key_unavailable';
        case 'source_key_unavailable': return 'source_key_unavailable';
    }
}

/** The one label owner for every source runtime state, picker and editor alike. */
export function sessionFollowSourceRuntimeStateLabel(state: SessionFollowSourceRuntimeState): string {
    switch (state) {
        case 'paused_archived': return t('session.follow.sources.pausedArchived');
        case 'waiting_for_runtime': return t('session.follow.sources.waitingRuntime');
        case 'runtime_unsupported': return t('session.follow.sources.unsupported');
        case 'waiting_for_source_key': return t('session.follow.sources.sourceKeyWaiting');
        case 'runner_key_unavailable': return t('session.follow.sources.sourceKeyUnavailable');
        case 'source_key_unavailable': return t('session.follow.sources.sourceSessionKeyUnavailable');
        case 'waiting_for_authorized_device': return t('session.follow.sources.waitingAuthorizedDevice');
        case 'catch_up_pending': return t('session.follow.sources.catchUpPending');
        // `eligible` is the nominal state: the source is included with the
        // destination's next turn. The Account-Follow word "Following" describes a
        // different relationship and must not reach a screen reader here.
        case 'eligible': return t('session.follow.sources.nextTurn');
    }
}
