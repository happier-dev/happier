import { connectedServiceUsageRequiresOrganizationId } from '@happier-dev/protocol';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { readCredentialAccountIdentity } from '../quotas/coordinator/support';
import { getConnectedAccountDescriptor } from '../descriptors/connectedAccountDescriptors';

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
    const identity = readCredentialAccountIdentity(input.record);
    if (identity?.providerAccountId !== accountId) return false;
    const organizationId = input.classification.sourceProviderOrganizationId?.trim();
    if (organizationId) return identity.providerOrganizationId === organizationId;
    // Older reports did not attest the quota organization. Keep exact credential evidence
    // usable, but do not carry that unknown context across a credential replacement.
    if (identity.providerOrganizationId || connectedServiceUsageRequiresOrganizationId(input.record.serviceId)) {
      return Boolean(input.classification.credentialRevision
        && input.classification.credentialRevision === input.credentialRevision);
    }
    return true;
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
