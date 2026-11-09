import type { ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import { resolveConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { resolveQualifiedConnectedAccountServiceForIngressServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import { readQualifiedConnectedAccountCredentialMaterial } from '../../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { CONNECTED_SERVICE_CURRENTNESS_AUTHORITY_FAILURE_CODES } from './groupMutationCurrentnessFailure';

export type ConnectedServiceGroupMutationCurrentnessInput = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
}>;

function rethrowCurrentnessReadRefusal(error: unknown): void {
  // Authority/Home errors already own their typed cause. Never turn a thrown
  // requester refusal into a group or credential mismatch.
  const code = error && typeof error === 'object' && 'code' in error ? error.code
    : error instanceof Error ? error.message : null;
  if (CONNECTED_SERVICE_CURRENTNESS_AUTHORITY_FAILURE_CODES.some(candidate => candidate === code)) throw error;
}

/** The incumbent generation fence, shared by native switch effects and their real boundary tests. */
export async function validateConnectedServiceGroupMutationCurrentness(params: Readonly<{
  input: ConnectedServiceGroupMutationCurrentnessInput;
  credentials: StoredCredentials;
  api: Partial<Pick<ConnectedServiceCredentialApi, 'getAccountEncryptionMode'>>;
  readGroup(input: Pick<ConnectedServiceGroupMutationCurrentnessInput, 'serviceId' | 'groupId'>): Promise<Readonly<{
    activeConnectedAccountId: string | null;
    generation: number;
  }> | null>;
}>) {
  const { input } = params;
  let currentGroup: Awaited<ReturnType<typeof params.readGroup>>;
  try {
    currentGroup = await params.readGroup({ serviceId: input.serviceId, groupId: input.groupId });
  } catch (error) {
    rethrowCurrentnessReadRefusal(error);
    return { current: false as const, reason: 'connected_account_group_read_unavailable' as const };
  }
  if (!currentGroup?.activeConnectedAccountId) {
    return { current: false as const, reason: 'connected_account_group_unavailable' as const };
  }
  // Both first-party and external services use the same admitted V4 material.
  // Native-record projection and refresh metadata do not own revision identity.
  const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(input.serviceId);
  const currentMaterial = service
    ? await readQualifiedConnectedAccountCredentialMaterial({ credentials: params.credentials,
        account: { service, accountId: currentGroup.activeConnectedAccountId },
        requestPurpose: 'connected-accounts:auth-group',
        getAccountEncryptionMode: signal => resolveConnectedServiceAccountMode(params.api, { signal }),
      }).catch(error => { rethrowCurrentnessReadRefusal(error); return null; })
    : null;
  const authoritativeTarget = currentMaterial ? {
    profileId: currentGroup.activeConnectedAccountId,
    generation: currentGroup.generation,
    credentialRevision: currentMaterial.snapshot.credentialRevision,
  } : undefined;
  if (currentGroup.activeConnectedAccountId !== input.profileId || currentGroup.generation !== input.generation) {
    return { current: false as const, reason: 'shared_generation_application_superseded' as const,
      ...(authoritativeTarget ? { authoritativeTarget } : {}) };
  }
  if (!currentMaterial) return { current: false as const, reason: 'connected_account_credential_read_unavailable' as const };
  return currentMaterial.snapshot.credentialRevision === input.credentialRevision ? { current: true as const } : {
    current: false as const, reason: 'credential_revision_superseded' as const,
    ...(authoritativeTarget ? { authoritativeTarget } : {}),
  };
}
