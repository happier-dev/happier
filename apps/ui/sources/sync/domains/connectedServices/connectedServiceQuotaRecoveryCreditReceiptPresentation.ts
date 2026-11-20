import { isActionOutcomeUnknownErrorCodeV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import {
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
    ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema,
    type ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
} from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { getLegacyConnectedServiceRegistryEntry } from './connectedServiceRegistry';

export type UnconfirmedAccountUsageReset = Readonly<{ kind: 'unknown'; errorCode: string }>;

type AccountUsageResetOutcome = Readonly<{ kind: 'used' }> | UnconfirmedAccountUsageReset;

export function readConnectedServiceQuotaRecoveryCreditActionPresentation(execution: ActionExecuteResult) {
    const result = execution.ok
        ? ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.safeParse(execution.result).data
        : undefined;
    const details = execution.ok ? null : execution.details;
    const receipt = result?.receipt ?? ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema.safeParse(
        details && typeof details === 'object' && 'receipt' in details ? details.receipt : undefined,
    ).data;
    const failure = execution.ok ? result?.ok === false ? result : null : execution;
    let outcome: AccountUsageResetOutcome | null = null;
    if (receipt?.status === 'consumed' || receipt?.status === 'already_consumed') {
        // A provider receipt still settles the debit if publishing the usage snapshot failed.
        outcome = { kind: 'used' };
    } else if (receipt?.status === 'unknown_after_timeout' || (failure && failure.effectAttempted !== false
        && (isActionOutcomeUnknownErrorCodeV1(failure.errorCode) || failure.errorCode === 'machine_rpc_failed'
            || failure.errorCode === 'daemon_control_failed'))) {
        outcome = { kind: 'unknown', errorCode: failure?.errorCode ?? receipt?.status ?? 'outcome_unknown' };
    }
    return { outcome, failure, result };
}

export function getConnectedServiceQuotaRecoveryCreditCheckInput(
    legacyServiceId: ConnectedServiceId,
    accountId: string,
    machineId: string,
) {
    const service = getLegacyConnectedServiceRegistryEntry(legacyServiceId).service;
    return service ? { account: { service, accountId }, machineId } : null;
}

export function readFreshRecoveryCreditObservationTime(quota: Readonly<{
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    fetchedAt: number | null;
    staleSince: number | null;
}>): number | null {
    return quota.recoveryCredits && quota.staleSince === null ? quota.fetchedAt : null;
}

/** A newer account publication can replace the temporary UI status without proving a consume receipt. */
export function hasNewRecoveryCreditObservation(observedAtMs: number | null | undefined, previousAtMs: number | null): boolean {
    return observedAtMs != null && observedAtMs > (previousAtMs ?? 0);
}

export function resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey(
    status: ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
): 'connectedServices.quota.recoveryCreditNothingToReset' | null {
    return status === 'nothing_to_reset'
        ? 'connectedServices.quota.recoveryCreditNothingToReset'
        : null;
}
