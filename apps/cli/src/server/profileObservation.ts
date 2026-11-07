import { adoptServerProfileHomeConnectionDescriptor, getServerProfile, type ServerProfile } from './serverProfiles';

type ObservationParams = Readonly<{
  profileId: string;
  serverUrl: string;
  token: string;
  signal?: AbortSignal;
}>;

type DescriptorOutcome = 'unavailable' | 'updated' | 'unchanged' | 'stale';

export type ServerProfileHomeObservation = Readonly<{
  profile: ServerProfile;
  descriptorOutcome: DescriptorOutcome;
  /** Authenticated endpoint identity for this invocation; never saved without a descriptor. */
  serverIdentityId?: string;
}>;

/** Observes one authenticated Home, independently of optional descriptor publication. */
export async function observeServerProfileHomeConnection(params: ObservationParams): Promise<ServerProfileHomeObservation> {
  const profile = await getServerProfile(params.profileId);
  const [featuresClient, enrollment] = await Promise.all([
    import('@/features/serverFeaturesClient'),
    import('@/auth/terminalAuthEnrollmentClient'),
  ]);
  const snapshot = await featuresClient.observeServerFeaturesSnapshot({
    serverUrl: params.serverUrl, token: params.token, signal: params.signal,
  });
  const serverIdentityId = snapshot.status === 'ready' && snapshot.provenance === 'authenticated'
    ? featuresClient.readServerIdentityIdFromFeaturesSnapshot(snapshot) ?? undefined : undefined;
  const expectedIdentityId = profile.homeConnectionDescriptor?.homeServerIdentityId;
  if (serverIdentityId && expectedIdentityId && serverIdentityId !== expectedIdentityId) {
    throw new enrollment.TerminalAuthEnrollmentVerificationError(
      'HOME_AUTHORITY_MISMATCH', 'Authenticated Home identity does not match the selected Home',
    );
  }
  const observation = enrollment.resolveAuthenticatedExactHomeConnectionDescriptorObservation({
    snapshot, expectedHomeServerIdentityId: expectedIdentityId ?? serverIdentityId ?? '',
  });
  if (observation.kind !== 'available') {
    return { profile, descriptorOutcome: 'unavailable', ...(serverIdentityId ? { serverIdentityId } : {}) };
  }
  const adopted = await adoptServerProfileHomeConnectionDescriptor({
    descriptor: observation.descriptor, expectedProfileId: profile.id, observation: 'exact',
  });
  return { profile: adopted.profile, descriptorOutcome: adopted.outcome, ...(serverIdentityId ? { serverIdentityId } : {}) };
}

/** Preserves the descriptor-only refresh contract used by daemon enrollment. */
export async function refreshServerProfileHomeConnectionDescriptor(params: ObservationParams): Promise<DescriptorOutcome> {
  return (await observeServerProfileHomeConnection(params)).descriptorOutcome;
}
