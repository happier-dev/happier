import { randomUUID } from 'node:crypto';

import { draftMarketplaceRegistryProfileV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import type { DaemonNpmRegistryProfileMutationResponseV1 } from '@happier-dev/protocol/rpc';

import type { PluginRegistryProfileRequirement } from '@/plugins/daemon/changeContract';
import { createNpmRegistryProfileProbe } from '@/plugins/distribution/npm/profiles/probe';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';

/** Registry profile mutations name the Home-local actor; the endpoint has no daemon machine row of its own. */
const ENDPOINT_PROFILE_ACTOR = 'runner-endpoint';

function requireSuccess(
  result: DaemonNpmRegistryProfileMutationResponseV1,
): Extract<DaemonNpmRegistryProfileMutationResponseV1, { status: 'success' }> {
  if (result.status === 'error') throw new Error(`runner_registry_profile_${result.code}`);
  return result;
}

/**
 * Applies the endpoint's explicit answer to a registry requirement in the
 * activation-local Home, through the same owners every Home uses: the npm
 * registry profile service holds the profile and its credential, and the
 * marketplace source registry binds that profile to the reviewed listing's
 * source. Nothing here is a Runner store; the endpoint is only another Home
 * making its own selection, and the creator's registry facts never reach it.
 *
 * The one profile for the registry origin is reused when it exists (a
 * profile is unique per origin), widened only so it serves this package's
 * scope, and otherwise created from the canonical draft every Home adds for a
 * registry requirement. A credential signs it in, and signing in runs the
 * profile owner's own check; `null` keeps an anonymous internal registry
 * profile, which is checked explicitly. That check records the availability
 * the listing's artifact access requires.
 */
export async function selectEndpointRegistryProfile(params: Readonly<{
  happyHomeDir: string;
  requirement: PluginRegistryProfileRequirement;
  credential: string | null;
  /** The reviewed listing's persisted marketplace source, when the listing came from one that can bind a profile. */
  marketplaceSourceId: string | null;
}>): Promise<string> {
  const service = createNpmRegistryProfileService({
    happyHomeDir: params.happyHomeDir,
    probe: createNpmRegistryProfileProbe(),
  });
  const { registryOrigin } = params.requirement;
  const draft = draftMarketplaceRegistryProfileV1(params.requirement);
  const mutationId = (action: string) => `runner-registry-${action}-${randomUUID()}`;

  let snapshot = await service.snapshot();
  const existing = snapshot.profiles.find((profile) => (
    params.requirement.registryProfileId !== null
      ? profile.profileId === params.requirement.registryProfileId
      : profile.origin === registryOrigin
  )) ?? null;
  let profileId: string;
  if (!existing) {
    profileId = `registry_${randomUUID()}`;
    snapshot = requireSuccess(await service.mutate({
      action: 'add',
      machineId: ENDPOINT_PROFILE_ACTOR,
      expectedRevision: snapshot.revision,
      mutationId: mutationId('add'),
      profileId,
      profile: { ...draft, scopes: [...draft.scopes] },
    })).snapshot;
  } else {
    profileId = existing.profileId;
    const missingScopes = draft.scopes.filter((scope) => !existing.scopes.includes(scope));
    const servesPackage = draft.useAsDefault ? existing.useAsDefault : missingScopes.length === 0;
    if (!servesPackage) {
      snapshot = requireSuccess(await service.mutate({
        action: 'update',
        machineId: ENDPOINT_PROFILE_ACTOR,
        expectedRevision: snapshot.revision,
        mutationId: mutationId('update'),
        profileId,
        profile: {
          displayName: existing.displayName,
          origin: existing.origin,
          scopes: [...existing.scopes, ...missingScopes],
          useAsDefault: existing.useAsDefault || draft.useAsDefault,
          allowPrivateNetwork: existing.allowPrivateNetwork,
        },
      })).snapshot;
    }
  }
  // A refused or unreachable check is recorded on the profile by its owner;
  // preparing again then reports exactly what is still missing.
  if (params.credential !== null) {
    const signedIn = await service.mutate({
      action: 'login',
      machineId: ENDPOINT_PROFILE_ACTOR,
      expectedRevision: snapshot.revision,
      mutationId: mutationId('login'),
      profileId,
      credential: { kind: 'bearer_token', secret: params.credential },
    });
    if (signedIn.status === 'error' && signedIn.code !== 'authentication_failed' && signedIn.code !== 'offline') {
      requireSuccess(signedIn);
    }
  } else {
    await service.mutate({
      action: 'test',
      machineId: ENDPOINT_PROFILE_ACTOR,
      expectedRevision: snapshot.revision,
      mutationId: mutationId('test'),
      profileId,
    });
  }
  if (params.marketplaceSourceId !== null) {
    const bound = await createMarketplaceSourceRegistryStore({ happyHomeDir: params.happyHomeDir })
      .setSourceRegistryProfile(params.marketplaceSourceId, profileId);
    if (!bound) throw new Error('runner_reviewed_plugin_source_unbound');
  }
  return profileId;
}
