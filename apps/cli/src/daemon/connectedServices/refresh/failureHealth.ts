import type { ConnectedServiceCredentialHealthV1, ConnectedServiceCredentialRevisionV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { mutateQualifiedConnectedAccountCredentialHealthV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { logger } from '@/ui/logger';
import { boundConnectedServiceMaterializationDiagnosticValue } from '../diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import type { ConnectedServicesMaterializationDiagnostic } from '../materialization/materializer';
import { sanitizeConnectedServiceDiagnosticError } from '../runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import type { ConnectedServiceRefreshFailureCategory, QualifiedConnectedAccountRefreshRuntime } from './ConnectedServiceRefreshCoordinator';
import { notifyQualifiedReauth, recordCredentialHealthWrite } from './qualifiedHealthSettlement';
import type { BoundProfile } from './tick';

export function isReauthRequiredFailure(category: ConnectedServiceRefreshFailureCategory): boolean {
  return category === 'invalid_grant'
    || category === 'missing_refresh_token';
}

function providerHttpStatusForHealth(status: number | null | undefined): number | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}

function providerErrorCodeForHealth(code: string | null | undefined): string | undefined {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  return trimmed.length > 0 ? trimmed.slice(0, 128) : undefined;
}

export type ConnectedServiceMaterializationCredentialRefreshClassification = Readonly<{
  category: ConnectedServiceRefreshFailureCategory;
  providerStatus?: number;
  providerErrorCode?: string;
}>;

export function classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): ConnectedServiceMaterializationCredentialRefreshClassification {
  const refreshFailure = diagnostic.credentialRefreshFailure;
  const category = refreshFailure?.category ?? 'unknown';
  const providerStatus = providerHttpStatusForHealth(refreshFailure?.providerStatus);
  const providerErrorCode = providerErrorCodeForHealth(refreshFailure?.providerErrorCode)
    ?? providerErrorCodeForHealth(diagnostic.code);

  return {
    category,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
  };
}

/**
 * Single canonical owner for materialization-failure credential-health writes. Classifies the
 * diagnostic via the shared taxonomy. HTTP rejection alone cannot establish an invalid refresh
 * grant; every other blocking reason keeps its true category as a non-latching
 * `refresh_failed_retryable` status. Reused by the coordinator's rematerialize path AND the spawn
 * preflight path (`resolveConnectedServiceAuthForSpawn`) so no caller can fabricate an auth latch.
 */
export async function persistConnectedServiceCredentialHealthForMaterializationFailure(input: Readonly<{
  signal?: AbortSignal;
  binding: BoundProfile;
  diagnostic: ConnectedServicesMaterializationDiagnostic;
  now: number;
  qualifiedCredential?: Readonly<{
    token: string;
    ref: QualifiedConnectedAccountRef;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    expectedConfigurationRevision: string | null;
    previousHealth?: ConnectedServiceCredentialHealthV1 | null;
    previousStatus?: ConnectedServiceCredentialHealthV1['status'];
  }>;
  mutateCredentialHealth?: QualifiedConnectedAccountRefreshRuntime['mutateCredentialHealth'];
  onReauthRequired?: QualifiedConnectedAccountRefreshRuntime['onReauthRequired'];
}>): Promise<void> {
  if (!input.qualifiedCredential) return;

  const classification = classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh(input.diagnostic);
  const health = {
    v: 1,
    status: isReauthRequiredFailure(classification.category) ? 'needs_reauth' : 'refresh_failed_retryable',
    reconnectRequired: isReauthRequiredFailure(classification.category),
    lastRefreshAttemptAt: input.now,
    lastRefreshFailureAt: input.now,
    lastRefreshFailureKind: classification.category,
    ...(providerHttpStatusForHealth(classification.providerStatus) !== undefined
      ? { providerHttpStatus: providerHttpStatusForHealth(classification.providerStatus) }
      : {}),
    ...(classification.providerErrorCode ? { providerErrorCode: classification.providerErrorCode } : {}),
  } satisfies ConnectedServiceCredentialHealthV1;

  try {
    const { token, previousHealth, previousStatus, ...basis } = input.qualifiedCredential;
    recordCredentialHealthWrite({ path: 'materialization-failure', account: basis.ref,
      credentialRevision: basis.expectedCredentialRevision, configurationRevision: basis.expectedConfigurationRevision,
      before: previousHealth, beforeStatus: previousStatus, after: health });
    input.signal?.throwIfAborted();
    const settled = await (input.mutateCredentialHealth ?? mutateQualifiedConnectedAccountCredentialHealthV4)({ token, patch: { ...basis, health }, ...(input.signal ? { signal: input.signal } : {}) });
    if (settled.credentialRevision !== basis.expectedCredentialRevision
      || settled.configurationRevision !== basis.expectedConfigurationRevision) {
      throw new Error('Qualified materialization health did not settle against its exact snapshot');
    }
    notifyQualifiedReauth({ account: basis.ref, credentialRevision: basis.expectedCredentialRevision,
      previousHealth, previousStatus, health }, { onReauthRequired: input.onReauthRequired });
  } catch (error) {
    input.signal?.throwIfAborted();
    logger.warn('[DAEMON RUN] Failed to update connected-service credential health after materialization failure', {
      serviceId: input.binding.serviceId,
      materializationCode: boundConnectedServiceMaterializationDiagnosticValue(input.diagnostic.code),
      reason: boundConnectedServiceMaterializationDiagnosticValue(input.diagnostic.reason),
      error: sanitizeConnectedServiceDiagnosticError(error, {
        redactedValues: [input.binding.profileId],
      }),
    });
  }
}
