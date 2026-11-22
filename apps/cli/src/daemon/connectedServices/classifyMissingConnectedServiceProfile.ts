import type { ConnectedServiceBindingsV1, ConnectedServiceId } from '@happier-dev/protocol';

import { ConnectedServiceCredentialResolutionError } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';

/**
 * The profile a session or default is bound to no longer exists on the account (it was removed or
 * renamed). This is a different fact from "its credential needs reconnecting": there is nothing to
 * reconnect, so the owner has to choose another account.
 */
export class ConnectedServiceProfileMissingError extends Error {
  readonly name = 'ConnectedServiceProfileMissingError';
  readonly kind = 'profile_missing' as const;
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) {
    super(`Connected service profile no longer exists (${binding.serviceId}/${binding.profileId})`);
    this.serviceId = binding.serviceId;
    this.profileId = binding.profileId;
  }
}

type ProfilesApi = Readonly<{
  listConnectedServiceProfiles?: (input: Readonly<{ serviceId: ConnectedServiceId }>) => Promise<Readonly<{
    profiles?: ReadonlyArray<Readonly<{ profileId: string }>>;
  }>>;
}>;

/** True only when the account's profile list was read and does not contain the profile. */
export async function connectedServiceProfileIsMissing(params: Readonly<{
  api: ProfilesApi;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<boolean> {
  if (typeof params.api.listConnectedServiceProfiles !== 'function') return false;
  try {
    const result = await params.api.listConnectedServiceProfiles({ serviceId: params.serviceId });
    if (!Array.isArray(result?.profiles)) return false;
    return !result.profiles.some((profile) => profile.profileId === params.profileId);
  } catch {
    // An unreadable list is no evidence either way; never turn it into a claim that the profile is gone.
    return false;
  }
}

/**
 * Turns a "missing credential" failure into "profile missing" when the account no longer has that
 * profile. Anything else, including an unreadable profile list, is returned unchanged.
 */
export async function classifyMissingConnectedServiceProfile(params: Readonly<{
  api: ProfilesApi;
  error: unknown;
}>): Promise<unknown> {
  if (!(params.error instanceof ConnectedServiceCredentialResolutionError)) return params.error;
  const missing = await connectedServiceProfileIsMissing({
    api: params.api,
    serviceId: params.error.serviceId,
    profileId: params.error.profileId,
  });
  return missing
    ? new ConnectedServiceProfileMissingError({ serviceId: params.error.serviceId, profileId: params.error.profileId })
    : params.error;
}

/** Runs a credential lookup and reports a missing profile as such, rather than as a missing credential. */
export async function resolveCredentialsClassifyingMissingProfile<T>(params: Readonly<{
  api: ProfilesApi;
  resolve: () => Promise<T>;
}>): Promise<T> {
  try {
    return await params.resolve();
  } catch (error) {
    throw await classifyMissingConnectedServiceProfile({ api: params.api, error });
  }
}

/**
 * Replaces any single-profile binding whose profile no longer exists with native auth, and reports
 * what it replaced. Pool bindings and bindings that exist are untouched, and an unreadable profile
 * list changes nothing. Used so a default is never written onto a session when it can only fail.
 */
export async function dropConnectedBindingsToMissingProfiles(params: Readonly<{
  api: ProfilesApi;
  bindings: ConnectedServiceBindingsV1;
}>): Promise<Readonly<{
  bindings: ConnectedServiceBindingsV1;
  dropped: ReadonlyArray<Readonly<{ serviceId: string; profileId: string }>>;
}>> {
  const next: Record<string, ConnectedServiceBindingsV1['bindingsByServiceId'][string]> = {};
  const dropped: Array<{ serviceId: string; profileId: string }> = [];
  for (const [serviceId, binding] of Object.entries(params.bindings.bindingsByServiceId)) {
    if (binding.source === 'connected' && binding.selection === 'profile') {
      const missing = await connectedServiceProfileIsMissing({
        api: params.api,
        serviceId: serviceId as ConnectedServiceId,
        profileId: binding.profileId,
      });
      if (missing) {
        dropped.push({ serviceId, profileId: binding.profileId });
        next[serviceId] = { source: 'native' };
        continue;
      }
    }
    next[serviceId] = binding;
  }
  return dropped.length === 0
    ? { bindings: params.bindings, dropped }
    : { bindings: { ...params.bindings, bindingsByServiceId: next }, dropped };
}
