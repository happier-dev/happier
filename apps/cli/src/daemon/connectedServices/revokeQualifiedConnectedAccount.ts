import type {
  QualifiedConnectedAccountRef,
  ManagedResourceDispositionV1,
  ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';
import type {
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
  QualifiedConnectedAccountCompatibilityError,
  QualifiedConnectedAccountCredentialConflictError,
  deleteQualifiedConnectedAccountCredentialV4,
} from '@/api/client/qualifiedConnectedAccountApi';

import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from './qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountV4Support,
} from './qualifiedConnectedAccountV4Support';

type PluginConnectedAccountRevocationResult = Awaited<
  ReturnType<PluginConnectedAccountRuntime['revoke']>
>;

export type QualifiedConnectedAccountRevocationSettlementDecision =
  | Readonly<{
      status: 'delete_local';
      remoteStatus: 'remoteRevoked' | 'remoteUnsupported';
    }>
  | Readonly<{ status: 'outcome_unknown' }>;

export function decideQualifiedConnectedAccountRevocationSettlement(
  result: PluginConnectedAccountRevocationResult,
): QualifiedConnectedAccountRevocationSettlementDecision {
  return result.status === 'outcomeUnknown'
    ? Object.freeze({ status: 'outcome_unknown' as const })
    : Object.freeze({
        status: 'delete_local' as const,
        remoteStatus: result.status,
      });
}

function assertQualifiedConnectedAccountV4Support(
  resolveV4Support: () => QualifiedConnectedAccountV4Support,
): void {
  const support = resolveV4Support();
  if (support === 'advertised') return;
  throw new QualifiedConnectedAccountCompatibilityError(
    support === 'indeterminate'
      ? 'connected_account_capability_indeterminate'
      : 'connected_account_legacy_operation_unsupported',
  );
}

export async function revokeQualifiedConnectedAccount(input: Readonly<{
  account: QualifiedConnectedAccountRef;
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
  cleanupGroupReferences: boolean;
  emergencyRevoke?: boolean;
  managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
  token: string;
  signal?: AbortSignal;
  establishedRuntimeOwner: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt' | 'readCredentialRevision'
  >;
  resolveV4Support: () => QualifiedConnectedAccountV4Support;
  resolveRemovalReviewSupport?: () => QualifiedConnectedAccountV4Support;
  deleteCredential?: typeof deleteQualifiedConnectedAccountCredentialV4;
}>): Promise<
  | Readonly<{
      status: 'deleted';
      remoteStatus: 'remoteRevoked' | 'remoteUnsupported' | 'remoteNotAttempted';
    }>
  | Readonly<{ status: 'outcome_unknown' }>
> {
  const assertV4Support = () => {
    assertQualifiedConnectedAccountV4Support(input.resolveV4Support);
  };
  assertV4Support();
  const removalSupport = input.resolveRemovalReviewSupport?.() ?? 'indeterminate';
  if (removalSupport === 'indeterminate') {
    throw new QualifiedConnectedAccountCompatibilityError('connected_account_capability_indeterminate');
  }
  if (!input.emergencyRevoke && removalSupport === 'absent' && input.managedResourceDispositions?.length) {
    throw new QualifiedConnectedAccountCompatibilityError('connected_account_legacy_operation_unsupported');
  }
  const deleteCredential = input.deleteCredential ?? deleteQualifiedConnectedAccountCredentialV4;
  const currentRevision = removalSupport === 'advertised' || input.emergencyRevoke || input.expectedCredentialRevision !== undefined
    ? await input.establishedRuntimeOwner.readCredentialRevision({ account: input.account,
      ...(input.signal ? { signal: input.signal } : {}) }) : undefined;
  if (!input.emergencyRevoke && input.expectedCredentialRevision !== undefined
    && input.expectedCredentialRevision !== currentRevision) {
    throw new QualifiedConnectedAccountCredentialConflictError('connect_credential_mutation_superseded');
  }
  const reviewFields = removalSupport === 'advertised' ? {
    ...(input.managedResourceDispositions ? { managedResourceDispositions: [...input.managedResourceDispositions] } : {}),
  } : {};
  const assertRemovalAdmission = () => {
    assertV4Support();
    if ((input.resolveRemovalReviewSupport?.() ?? 'indeterminate') !== removalSupport) {
      throw new QualifiedConnectedAccountCompatibilityError('connected_account_capability_indeterminate');
    }
  };
  if (input.emergencyRevoke) {
    assertRemovalAdmission();
    await deleteCredential({ token: input.token, deletion: {
      ref: input.account, expectedCredentialRevision: currentRevision!,
      cleanupGroupReferences: removalSupport === 'advertised' ? input.cleanupGroupReferences : true,
      ...(removalSupport === 'advertised' ? { emergencyRevoke: true } : {}),
    } });
    return Object.freeze({ status: 'deleted' as const, remoteStatus: 'remoteNotAttempted' as const });
  }
  if (removalSupport === 'advertised') {
    assertRemovalAdmission();
    await deleteCredential({ token: input.token, deletion: {
      ref: input.account, expectedCredentialRevision: currentRevision!, cleanupGroupReferences: input.cleanupGroupReferences,
      reviewOnly: true, ...reviewFields,
    } });
  }
  const invocation = await input.establishedRuntimeOwner.invokeWithReceipt({
    account: input.account,
    operation: Object.freeze({ kind: 'revoke' as const }),
    ...(currentRevision ? { expectedCredentialRevision: currentRevision } : {}),
    assertEffectfulOperationAllowed: assertRemovalAdmission,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const decision =
    decideQualifiedConnectedAccountRevocationSettlement(invocation.result);
  if (decision.status === 'outcome_unknown') return decision;
  if (!invocation.basis.isCurrent()) {
    throw new Error(
      'Qualified Connected Account revoke generation is no longer current',
    );
  }
  assertRemovalAdmission();
  await deleteCredential({
    token: input.token,
    deletion: Object.freeze({
      ref: input.account,
      expectedCredentialRevision: invocation.basis.credentialRevision,
      cleanupGroupReferences: input.cleanupGroupReferences,
      ...reviewFields,
    }),
  });
  // Generation currentness protects PRE-EFFECT authorization: it is checked
  // above, before the remote revoke leaf runs and before the credential is
  // deleted. Once the delete returns success the revocation is committed, so
  // it must never be retroactively invalidated here - re-checking currentness
  // after the effect would report failure for a fully successful operation and
  // leave the caller with a retry that can only observe not-found.
  return Object.freeze({
    status: 'deleted' as const,
    remoteStatus: decision.remoteStatus,
  });
}
