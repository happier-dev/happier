import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { readCredentialAccountIdentity } from '../quotas/coordinator/support';

import type { ConnectedServiceRuntimeFailureClassification } from './types';

/** Qualify a saved quota source against current credentials independently of runner presence. */
export function isCurrentUsageLimitRecoveryCredential(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  record: ConnectedServiceCredentialRecordV1;
  credentialRevision: string | null;
}>): boolean {
  if (input.classification.kind !== 'usage_limit' || input.classification.groupId !== null) return false;
  const accountId = input.classification.sourceProviderAccountId?.trim();
  if (accountId) {
    return readCredentialAccountIdentity(input.record)?.providerAccountId === accountId;
  }
  const revision = input.classification.credentialRevision;
  return Boolean(revision && input.credentialRevision === revision);
}

export async function isCurrentUsageLimitRecoverySource(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  resolveCredential: () => Promise<Readonly<{ record: ConnectedServiceCredentialRecordV1; credentialRevision: string | null }> | null>;
  authorizeLiveSource?: () => Promise<boolean>;
  isCurrentRecovery?: () => boolean;
}>): Promise<boolean> {
  if (input.isCurrentRecovery && !input.isCurrentRecovery()) return false;
  const credential = await input.resolveCredential();
  if (!credential || !isCurrentUsageLimitRecoveryCredential({ classification: input.classification, ...credential })) return false;
  if (input.authorizeLiveSource && !(await input.authorizeLiveSource())) return false;
  return input.isCurrentRecovery?.() ?? true;
}
