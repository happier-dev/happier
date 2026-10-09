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
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';
import { readQualifiedConnectedAccountCredentialMaterial } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey, resolveQualifiedConnectedAccountServiceForIngressServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

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
  isCurrent?: () => Promise<boolean>;
}>): Promise<unknown | null> {
  if (params.input.next.source !== 'connected') return null;
  const assertCurrent = async () => {
    if (params.isCurrent && !await params.isCurrent()) throw new Error('requester_session_not_current');
  };
  await assertCurrent();
  const legacyServiceId =
    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
      params.input.serviceId,
    );
  const binding = params.input.normalizedBindings.bindingsByServiceId[params.input.serviceId];
  if (!binding || binding.source !== 'connected') return null;

  if (typeof params.api.getAccountEncryptionMode !== 'function') return null;
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

  let record: ConnectedServiceCredentialRecordV1 | undefined;
  let credentialRevision: ConnectedServiceCredentialRevisionV1;
  if (legacyServiceId) {
    const resolutions = await resolveConnectedServiceCredentialResolutions({
      credentials: params.credentials,
      api: params.api,
      bindings: [{ serviceId: legacyServiceId, profileId }],
    });
    const resolution = resolutions.get(legacyServiceId);
    if (resolution?.revisionSemantics !== 'revisioned') return null;
    record = resolution.record;
    credentialRevision = resolution.credentialRevision;
  } else {
    const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(params.input.serviceId);
    if (!service) return null;
    const material = await readQualifiedConnectedAccountCredentialMaterial({
      credentials: params.credentials,
      account: { service, accountId: profileId },
      getAccountEncryptionMode: async () => await params.api.getAccountEncryptionMode(),
    });
    if (!material) return null;
    credentialRevision = material.snapshot.credentialRevision;
  }
  await assertCurrent();
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
  const targetMaterializedRoot = params.activeServerDir && legacyServiceId
    ? resolveConnectedServiceMaterializedHomeRoot(params.input.agentId, {
        activeServerDir: params.activeServerDir,
        serviceId: legacyServiceId,
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
        isCurrent: params.isCurrent,
      })
    : null;

  await assertCurrent();
  return {
    ...baseSelection,
    ...(record ? { credential: record } : {}),
    applyConnectedServiceAuthGeneration: async (...args: Parameters<typeof runtimeAuthTransport.applyConnectedServiceAuthGeneration>) => {
      await assertCurrent();
      const result = await runtimeAuthTransport.applyConnectedServiceAuthGeneration(...args);
      await assertCurrent();
      return result;
    },
    ...(targetMaterializedRoot ? { targetMaterializedRoot } : {}),
    ...(nativeHome ? { nativeHome } : {}),
  };
}
