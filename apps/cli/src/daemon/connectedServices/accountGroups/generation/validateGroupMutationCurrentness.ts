import type { ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import { resolveConnectedServiceCredentialResolutions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

export type ConnectedServiceGroupMutationCurrentnessInput = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
}>;

/** The incumbent generation fence, shared by native switch effects and their real boundary tests. */
export async function validateConnectedServiceGroupMutationCurrentness(params: Readonly<{
  input: ConnectedServiceGroupMutationCurrentnessInput;
  credentials: Parameters<typeof resolveConnectedServiceCredentialResolutions>[0]['credentials'];
  api: Parameters<typeof resolveConnectedServiceCredentialResolutions>[0]['api'];
  readGroup(input: Pick<ConnectedServiceGroupMutationCurrentnessInput, 'serviceId' | 'groupId'>): Promise<Readonly<{
    activeConnectedAccountId: string | null;
    generation: number;
  }> | null>;
  assertCurrent?(): Promise<void>;
}>) {
  const { input } = params;
  const currentGroup = await params.readGroup({ serviceId: input.serviceId, groupId: input.groupId }).catch(() => null);
  if (!currentGroup?.activeConnectedAccountId) {
    return { current: false as const, reason: 'shared_generation_application_superseded' };
  }
  // Released sealed-credential reads retain scalar native-record identities;
  // external qualified services verify through the current V4 group owner.
  const scalarCredentialServiceId = resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(input.serviceId);
  const currentResolutions = scalarCredentialServiceId
    ? await resolveConnectedServiceCredentialResolutions({ credentials: params.credentials, api: params.api,
        bindings: [{ serviceId: scalarCredentialServiceId, profileId: currentGroup.activeConnectedAccountId }],
      }).catch(() => null)
    : null;
  const currentResolution = scalarCredentialServiceId ? currentResolutions?.get(scalarCredentialServiceId) ?? null : null;
  const authoritativeTarget = currentResolution ? {
    profileId: currentGroup.activeConnectedAccountId,
    generation: currentGroup.generation,
    credentialRevision: currentResolution.revisionSemantics === 'revisioned' ? currentResolution.credentialRevision : null,
  } : undefined;
  if (currentGroup.activeConnectedAccountId !== input.profileId || currentGroup.generation !== input.generation) {
    return { current: false as const, reason: 'shared_generation_application_superseded',
      ...(authoritativeTarget ? { authoritativeTarget } : {}) };
  }
  const revisionIsCurrent = currentResolution?.revisionSemantics === 'revisioned'
    ? currentResolution.credentialRevision === input.credentialRevision
    : input.credentialRevision === null;
  await params.assertCurrent?.();
  return revisionIsCurrent ? { current: true as const } : {
    current: false as const, reason: 'credential_revision_superseded',
    ...(authoritativeTarget ? { authoritativeTarget } : {}),
  };
}
