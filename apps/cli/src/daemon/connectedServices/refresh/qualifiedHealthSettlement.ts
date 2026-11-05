import { isDeepStrictEqual } from 'node:util';
import type { ConnectedServiceCredentialHealthV1, ConnectedServiceCredentialRevisionV1, QualifiedConnectedAccountCredentialSnapshotV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { QualifiedConnectedAccountRefreshRuntime } from './ConnectedServiceRefreshCoordinator';
import { sanitizeConnectedServiceDiagnosticError } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';

export function notifyQualifiedReauth(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    previousHealth: ConnectedServiceCredentialHealthV1 | null | undefined;
    previousStatus?: ConnectedServiceCredentialHealthV1['status'];
    health: ConnectedServiceCredentialHealthV1;
}>, runtime: Pick<QualifiedConnectedAccountRefreshRuntime, 'onReauthRequired'>): void {
    if (input.health.status !== 'needs_reauth'
        || (input.previousHealth?.status ?? input.previousStatus) === 'needs_reauth'
        || !runtime.onReauthRequired) return;
    const notify = runtime.onReauthRequired;
    // Refresh can run inside the Pool's existing selection lease. Its durable
    // health commit must settle before rotation waits for that lease to finish.
    void Promise.resolve().then(() => notify({ account: input.account, credentialRevision: input.credentialRevision }))
        .catch(error => logger.warn('[DAEMON RUN] Connected Account health rotation did not settle', {
            service: input.account.service,
            error: sanitizeConnectedServiceDiagnosticError(error, { redactedValues: [input.account.accountId] }),
        }));
}

export function credentialHealthStatusFacts(health: ConnectedServiceCredentialHealthV1 | null | undefined) {
    if (!health) return null;
    const { lastRefreshAttemptAt: _attempt, lastRefreshSuccessAt: _success,
        lastRefreshFailureAt: _failure, lastRuntimeAuthFailureAt: _runtime, ...facts } = health;
    return facts;
}

export function recordCredentialHealthWrite(input: Readonly<{
    path: 'status' | 'result' | 'legacy-refresh-result' | 'materialization-failure' | 'configuration-reconnect';
    account: QualifiedConnectedAccountRef;
    credentialRevision: QualifiedConnectedAccountCredentialSnapshotV4['credentialRevision'];
    configurationRevision: QualifiedHealthSettlementInput['basis']['credentialConfigurationRevision'];
    before: ConnectedServiceCredentialHealthV1 | null | undefined;
    beforeStatus?: ConnectedServiceCredentialHealthV1['status'];
    after: ConnectedServiceCredentialHealthV1;
}>): void {
    logger.debug('[ConnectedServiceRefreshCoordinator] credential health write', {
        path: input.path, serviceKind: input.account.service.localId,
        account: input.account, credentialRevision: input.credentialRevision,
        configurationRevision: input.configurationRevision,
        beforeStatus: input.before?.status ?? input.beforeStatus ?? null, afterStatus: input.after.status,
        substantiveChanged: input.before === undefined ? null
            : !isDeepStrictEqual(credentialHealthStatusFacts(input.before), credentialHealthStatusFacts(input.after)),
    });
}

export type QualifiedHealthSettlementInput = Readonly<{
    account: QualifiedConnectedAccountRef;
    settledCredentialRevision?: ConnectedServiceCredentialRevisionV1;
    basis: Awaited<ReturnType<QualifiedConnectedAccountEstablishedRuntimeOwner['invokeWithReceipt']>>['basis'];
    health: ConnectedServiceCredentialHealthV1;
    healthWritePath?: 'status' | 'result';
}>;

export async function settleQualifiedHealth(input: QualifiedHealthSettlementInput, deps: Readonly<{
    runtime: QualifiedConnectedAccountRefreshRuntime; token: string;
}>): Promise<void> {
    const expectedConfigurationRevision =
      input.basis.credentialConfigurationRevision;
    const expectedCredentialRevision = input.settledCredentialRevision ?? input.basis.credentialRevision;
    // Status observes no new attempt/success timestamp. Keep committed history
    // intact when this admission already carries exactly the same status facts.
    // Result settlement still owns refresh effects and replacement revisions.
    if (input.healthWritePath === 'status'
      && input.settledCredentialRevision === undefined
      && isDeepStrictEqual(credentialHealthStatusFacts(input.basis.credentialHealth ?? null), input.health)) return;
    recordCredentialHealthWrite({ path: input.healthWritePath ?? 'result', account: input.account,
      credentialRevision: expectedCredentialRevision, configurationRevision: expectedConfigurationRevision,
      before: input.basis.credentialHealth, after: input.health });
    const mutation = await deps.runtime.mutateCredentialHealth({
      token: deps.token,
      patch: Object.freeze({
        ref: input.account,
        expectedCredentialRevision,
        expectedConfigurationRevision,
        health: input.health,
      }),
    });
    if (
      mutation.credentialRevision !== expectedCredentialRevision
      || mutation.configurationRevision !== expectedConfigurationRevision
      || !input.basis.isCurrent()
    ) {
      throw new Error(
        'Qualified Connected Account health mutation settled against a different invocation basis',
      );
    }
    notifyQualifiedReauth({ account: input.account, credentialRevision: expectedCredentialRevision,
      previousHealth: input.basis.credentialHealth, health: input.health }, deps.runtime);
}
