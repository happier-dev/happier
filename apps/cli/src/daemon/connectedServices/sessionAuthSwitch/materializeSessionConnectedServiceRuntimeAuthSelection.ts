import type { ApiClient } from '@/api/api';
import { materializeConnectedServiceRuntimeAuthSelectionThroughCatalog } from '@/daemon/connectedServices/catalogHooks';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { Credentials } from '@/persistence';
import {
  readConnectedServiceChildSelectionsFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  type AccountSettings,
} from '@happier-dev/protocol';

import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from './switchSessionConnectedServiceAuth';

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function materializeSessionConnectedServiceRuntimeAuthSelection(params: Readonly<{
  credentials: Credentials;
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

  const records = await resolveConnectedServiceCredentials({
    credentials: params.credentials,
    api: params.api,
    bindings: [{ serviceId: params.input.serviceId, profileId }],
  });
  const record = records.get(params.input.serviceId);
  if (!record) return null;

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
          fallbackProfileId: readNonEmptyString(groupMetadata?.fallbackProfileId)
            || readNonEmptyString(previousGroupSelection?.fallbackProfileId)
            || profileId,
          generation: typeof groupMetadata?.generation === 'number'
            ? groupMetadata.generation
            : typeof previousGroupSelection?.generation === 'number'
              ? previousGroupSelection.generation
              : 0,
        }
      : {}),
    record,
  };

  return await materializeConnectedServiceRuntimeAuthSelectionThroughCatalog(params.input.agentId, {
    ...params,
    baseSelection,
  }) ?? baseSelection;
}
