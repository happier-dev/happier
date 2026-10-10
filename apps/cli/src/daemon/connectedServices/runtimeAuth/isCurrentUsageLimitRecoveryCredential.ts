import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { readCredentialAccountIdentity } from '../quotas/coordinator/support';

import type { ConnectedServiceRuntimeFailureClassification } from './types';

/** An absent runner has no live binding; qualify its saved source against current credentials. */
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
