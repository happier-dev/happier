import { isDeepStrictEqual } from 'node:util';
import type { ConnectedServiceCredentialHealthEventV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import type { ConnectedServiceCredentialHealthV1, ConnectedServiceCredentialRevisionV1, QualifiedConnectedAccountCredentialSnapshotV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { QualifiedConnectedAccountRefreshRuntime } from './ConnectedServiceRefreshCoordinator';
import { sanitizeConnectedServiceDiagnosticError } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';

export type ConnectedServiceCredentialHealthTransition = Omit<ConnectedServiceCredentialHealthEventV1, 'serverId' | 'machineId'>;

export function notifyQualifiedHealthSettled(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    previousHealth: ConnectedServiceCredentialHealthV1 | null | undefined;
    previousStatus?: ConnectedServiceCredentialHealthV1['status'];
    previousReason?: ConnectedServiceCredentialHealthV1['lastRefreshFailureKind'];
    health: ConnectedServiceCredentialHealthV1;
}>, runtime: Pick<QualifiedConnectedAccountRefreshRuntime, 'onReauthRequired' | 'onCredentialHealthChanged'>): void {
    const status = input.health.status;
    const previousStatus = input.previousHealth?.status ?? input.previousStatus;
    const reason = input.health.lastRefreshFailureKind ?? null;
    const previousReason = input.previousHealth?.lastRefreshFailureKind ?? input.previousReason ?? null;
    if ((status === 'needs_reauth' || status === 'refresh_failed_retryable')
        && (previousStatus !== status || previousReason !== reason)) {
        runtime.onCredentialHealthChanged?.({ kind: 'credential_health', account: input.account,
            status, reason,
            occurredAt: input.health.lastRefreshFailureAt ?? input.health.lastRuntimeAuthFailureAt ?? Date.now() });
    }
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
    providerIdentity?: QualifiedHealthSettlementInput['basis']['credentialProviderIdentity'];
}>;

export async function settleQualifiedHealth(input: QualifiedHealthSettlementInput, deps: Readonly<{
    runtime: QualifiedConnectedAccountRefreshRuntime;
    token: string;
}>, signal?: AbortSignal): Promise<ConnectedServiceCredentialRevisionV1 | undefined> {
    signal?.throwIfAborted();
    const expectedConfigurationRevision = input.basis.credentialConfigurationRevision;
    let settledCredentialRevision = input.settledCredentialRevision;
    if (settledCredentialRevision === undefined && input.providerIdentity?.accountId
        && !input.basis.credentialProviderIdentity?.accountId) {
        const replacement = await input.basis.prepareCredentialReplacement({
            set: {}, delete: [], metadata: { providerIdentity: input.providerIdentity },
        });
        const settled = await deps.runtime.mutateCredential({ token: deps.token, ...(signal ? { signal } : {}),
            mutation: { ref: input.account, ...replacement,
                expectedCredentialRevision: input.basis.credentialRevision, expectedConfigurationRevision } });
        if (settled.configurationRevision !== expectedConfigurationRevision) {
            throw new Error('Qualified Connected Account identity settled against a different configuration');
        }
        settledCredentialRevision = settled.credentialRevision;
    }
    const expectedCredentialRevision = settledCredentialRevision ?? input.basis.credentialRevision;
    if (input.healthWritePath === 'status' && settledCredentialRevision === undefined
        && isDeepStrictEqual(credentialHealthStatusFacts(input.basis.credentialHealth), input.health)) return;
    recordCredentialHealthWrite({ path: input.healthWritePath ?? 'result', account: input.account,
        credentialRevision: expectedCredentialRevision, configurationRevision: expectedConfigurationRevision,
        before: input.basis.credentialHealth, after: input.health });
    const mutation = await deps.runtime.mutateCredentialHealth({ ...(signal ? { signal } : {}), token: deps.token,
        patch: Object.freeze({ ref: input.account, expectedCredentialRevision, expectedConfigurationRevision, health: input.health }) });
    if (mutation.credentialRevision !== expectedCredentialRevision
        || mutation.configurationRevision !== expectedConfigurationRevision
        || (settledCredentialRevision === undefined && !input.basis.isCurrent())) {
        throw new Error('Qualified Connected Account health mutation settled against a different invocation basis');
    }
    notifyQualifiedHealthSettled({ account: input.account, credentialRevision: expectedCredentialRevision,
        previousHealth: input.basis.credentialHealth, health: input.health }, deps.runtime);
    return settledCredentialRevision;
}
