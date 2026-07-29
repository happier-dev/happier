import type {
  QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
  PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/runtime';

import {
  QualifiedConnectedAccountCompatibilityError,
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
  cleanupGroupReferences: boolean;
  token: string;
  signal?: AbortSignal;
  establishedRuntimeOwner: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt'
  >;
  resolveV4Support: () => QualifiedConnectedAccountV4Support;
  deleteCredential?: typeof deleteQualifiedConnectedAccountCredentialV4;
}>): Promise<
  | Readonly<{
      status: 'deleted';
      remoteStatus: 'remoteRevoked' | 'remoteUnsupported';
    }>
  | Readonly<{ status: 'outcome_unknown' }>
> {
  const assertV4Support = () => {
    assertQualifiedConnectedAccountV4Support(input.resolveV4Support);
  };
  assertV4Support();
  const invocation = await input.establishedRuntimeOwner.invokeWithReceipt({
    account: input.account,
    operation: Object.freeze({ kind: 'revoke' as const }),
    assertEffectfulOperationAllowed: assertV4Support,
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
  assertV4Support();
  const deleteCredential =
    input.deleteCredential ?? deleteQualifiedConnectedAccountCredentialV4;
  await deleteCredential({
    token: input.token,
    deletion: Object.freeze({
      ref: input.account,
      expectedCredentialRevision: invocation.basis.credentialRevision,
      cleanupGroupReferences: input.cleanupGroupReferences,
    }),
  });
  if (!invocation.basis.isCurrent()) {
    throw new Error(
      'Qualified Connected Account revoke generation changed during guarded deletion',
    );
  }
  return Object.freeze({
    status: 'deleted' as const,
    remoteStatus: decision.remoteStatus,
  });
}
