import type { ApiClient } from '@/api/api';
import { resolveConnectedServiceCredentialResolutions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { StoredCredentials } from '@/persistence';
import {
  type ConnectedServiceChildSelection,
  readConnectedServiceChildSelectionsFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { resolveConnectedServiceMaterializedHomeRoot } from '@/daemon/connectedServices/catalogHooks';
import { createConnectedServiceRuntimeAuthNativeHome } from '@/daemon/connectedServices/runtimeAuth/createRuntimeAuthNativeHome';
import { createSessionConnectedServiceAuthTransport } from '@/session/runtime/control/transport';
import {
  type AccountSettings,
} from '@happier-dev/protocol';

import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from './switchSessionConnectedServiceAuth';

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function materializeSessionConnectedServiceRuntimeAuthSelection(params: Readonly<{
  credentials: StoredCredentials;
  api: ApiClient;
  activeServerDir?: string;
  input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput;
  accountSettings?: AccountSettings | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<unknown | null> {
  if (params.input.next.source !== 'connected') return null;
  const binding = params.input.normalizedBindings.bindingsByServiceId[params.input.serviceId];
  if (!binding || binding.source !== 'connected') return null;

  if (typeof params.api.getAccountEncryptionMode !== 'function') return null;
  if (
    typeof params.api.getConnectedServiceCredentialPlain !== 'function'
    && typeof params.api.getConnectedServiceCredentialSealed !== 'function'
  ) {
    return null;
  }

  const previousSelections = readConnectedServiceChildSelectionsFromEnv(
    params.input.tracked.spawnOptions?.environmentVariables ?? {},
  );
  const previousSelection = previousSelections?.get(params.input.serviceId) ?? null;
  const previousGroupSelection =
    binding.selection === 'group'
    && previousSelection?.kind === 'group'
    && previousSelection.groupId === binding.groupId
      ? previousSelection
      : null;
  const groupMetadata =
    binding.selection === 'group'
    && params.input.groupMetadata?.groupId === binding.groupId
      ? params.input.groupMetadata
      : null;
  const profileId = binding.selection === 'group'
    ? readNonEmptyString(params.input.next.profileId)
      || readNonEmptyString(groupMetadata?.activeProfileId)
      || readNonEmptyString(previousGroupSelection?.activeProfileId)
      || readNonEmptyString(binding.profileId)
    : readNonEmptyString(binding.profileId);
  if (!profileId) return null;

  const resolutions = await resolveConnectedServiceCredentialResolutions({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId: params.input.serviceId, profileId }],
  });
  const resolution = resolutions.get(params.input.serviceId);
  if (resolution?.revisionSemantics !== 'revisioned') return null;
  const { record, credentialRevision } = resolution;
  const fallbackProfileId = binding.selection === 'group'
    ? readNonEmptyString(groupMetadata?.fallbackProfileId)
      || readNonEmptyString(previousGroupSelection?.fallbackProfileId)
      || profileId
    : null;
  const generation = binding.selection === 'group'
    ? typeof groupMetadata?.generation === 'number'
      ? groupMetadata.generation
      : typeof previousGroupSelection?.generation === 'number'
        ? previousGroupSelection.generation
        : 0
    : null;

  const baseSelection = {
    serviceId: params.input.serviceId,
    binding,
    profileId,
    ...(params.input.runtimeAuthApplyReason
      ? { applyReason: params.input.runtimeAuthApplyReason }
      : {}),
    ...(params.input.requireDirectLiveHotApply
      ? { requireDirectLiveHotApply: true }
      : {}),
    ...(binding.selection === 'group'
      ? {
          groupId: binding.groupId,
          activeProfileId: profileId,
          fallbackProfileId: fallbackProfileId!,
          generation: generation!,
        }
      : {}),
    credentialRevision,
  };

  const targetSelection = (binding.selection === 'group'
    ? {
        kind: 'group',
        serviceId: params.input.serviceId,
        groupId: binding.groupId,
        activeProfileId: profileId,
        fallbackProfileId: fallbackProfileId!,
        generation: generation!,
        policy: null,
        credentialRevision,
      }
    : {
        kind: 'profile',
        serviceId: params.input.serviceId,
        profileId,
        credentialRevision,
      }) satisfies ConnectedServiceChildSelection;
  const targetMaterializedRoot = params.activeServerDir
    ? resolveConnectedServiceMaterializedHomeRoot(params.input.agentId, {
        activeServerDir: params.activeServerDir,
        serviceId: params.input.serviceId,
        profileId,
        selection: targetSelection,
    })
    : null;
  const runtimeAuthTransport = createSessionConnectedServiceAuthTransport({
    credentials: params.credentials,
    sessionId: params.input.sessionId,
  });
  const nativeHome = targetMaterializedRoot
    ? await createConnectedServiceRuntimeAuthNativeHome({
        agentId: params.input.agentId,
        root: targetMaterializedRoot,
      })
    : null;

  return {
    ...baseSelection,
    credential: record,
    applyConnectedServiceAuthGeneration:
      runtimeAuthTransport.applyConnectedServiceAuthGeneration,
    ...(targetMaterializedRoot ? { targetMaterializedRoot } : {}),
    ...(nativeHome ? { nativeHome } : {}),
  };
}
