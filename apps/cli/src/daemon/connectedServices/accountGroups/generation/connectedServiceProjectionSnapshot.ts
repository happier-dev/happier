import {
  AccountProfileSchema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceProjectedAuthGroup } from './reconcileConnectedServiceAuthGroupGenerations';

export type ConnectedServiceProjectionSnapshot = Readonly<{
  groups: readonly ConnectedServiceProjectedAuthGroup[];
  credentialRevisions: ReadonlyArray<Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialRevision: string;
  }>>;
  resolveCredentialRevision: (serviceId: ConnectedServiceId, profileId: string) => string | null;
  resolveCredentialPresence: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => ConnectedServiceProjectedCredentialPresence;
}>;

export type ConnectedServiceProjectedCredentialPresence =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'legacy_unfenced' }>
  | Readonly<{ status: 'present'; credentialRevision: string }>;

/**
 * Publishes server-observed credential truth before applying it to runtime consumers.
 * Application failure is reported to the caller but never rolls the observed projection back.
 */
export async function publishObservedConnectedServiceProjectionThenApply<T>(
  input: Readonly<{
    projection: ConnectedServiceProjectionSnapshot;
    publishObserved(projection: ConnectedServiceProjectionSnapshot): void;
    applyToRuntime(projection: ConnectedServiceProjectionSnapshot): Promise<T>;
  }>,
): Promise<T> {
  input.publishObserved(input.projection);
  return await input.applyToRuntime(input.projection);
}

function credentialScopeKey(serviceId: ConnectedServiceId, profileId: string): string {
  return `${serviceId}\0${profileId}`;
}

export function parseConnectedServiceProjectionSnapshot(input: Readonly<{
  connectedServicesV2: unknown;
  connectedServiceCredentialRevisionsV1: unknown;
}>): ConnectedServiceProjectionSnapshot {
  const profile = AccountProfileSchema.parse({
    id: 'connected-service-projection',
    connectedServicesV2: input.connectedServicesV2,
    connectedServiceCredentialRevisionsV1: input.connectedServiceCredentialRevisionsV1,
  });
  const revisions = new Map(profile.connectedServiceCredentialRevisionsV1.map((entry) => [
    credentialScopeKey(entry.serviceId, entry.profileId),
    entry.credentialRevision,
  ] as const));
  const presentCredentialScopes = new Set(profile.connectedServicesV2.flatMap((service) => (
    service.profiles.map((credentialProfile) => credentialScopeKey(service.serviceId, credentialProfile.profileId))
  )));
  const groups = profile.connectedServicesV2.flatMap((service) => service.groups.map((group) => ({
    serviceId: service.serviceId,
    groupId: group.groupId,
    activeProfileId: group.activeProfileId,
    generation: group.generation,
  })));
  return {
    groups,
    credentialRevisions: profile.connectedServiceCredentialRevisionsV1,
    resolveCredentialRevision: (serviceId, profileId) => revisions.get(credentialScopeKey(serviceId, profileId)) ?? null,
    resolveCredentialPresence: (serviceId, profileId) => {
      const key = credentialScopeKey(serviceId, profileId);
      if (!presentCredentialScopes.has(key)) return { status: 'absent' };
      const credentialRevision = revisions.get(key);
      return credentialRevision
        ? { status: 'present', credentialRevision }
        : { status: 'legacy_unfenced' };
    },
  };
}
