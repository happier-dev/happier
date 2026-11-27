import { ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { createConnectedServiceGroupMutationCurrentnessValidator } from '@/daemon/connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

import { createAgyConnectedServicesMaterializer } from './createAgyConnectedServicesMaterializer';

/**
 * Switch-time preparation of the home the next agy launch reads. The launch materializer alone owns
 * the token write and state-sharing links; running it before continuity lets the restart gate prove
 * the conversation against the selected account's materialized home (not a reconstructed root).
 */
export const materializeAgyConnectedServiceRuntimeAuthSelection: ConnectedServiceRuntimeAuthSelectionMaterializer = async (params) => {
  if (params.input.serviceId !== 'antigravity' || !params.activeServerDir) return params.baseSelection;
  const record = ConnectedServiceCredentialRecordV1Schema.safeParse(params.baseSelection.record);
  if (!record.success) return params.baseSelection;
  const home = resolveConnectedServiceHomeDir({
    activeServerDir: params.activeServerDir, serviceId: 'antigravity', profileId: params.baseSelection.profileId, agentId: 'agy',
  });
  // Preflight reports the next-launch home without publishing credentials or linking state.
  if (params.input.mode === 'preflight') {
    return { ...params.baseSelection, targetMaterializedRoot: home, targetMaterializedEnv: { GEMINI_HOME: home } };
  }
  const group = params.input.next.selection === 'group' ? params.input.groupMetadata : undefined;
  if (params.input.next.selection === 'group' && !group) throw new Error('connected_service_group_target_missing');
  const selection: ConnectedServiceResolvedSelection = group
    ? { kind: 'group', serviceId: 'antigravity', record: record.data, policy: null,
        groupId: group.groupId, activeProfileId: params.baseSelection.profileId,
        fallbackProfileId: group.fallbackProfileId, generation: group.generation,
        credentialRevision: params.baseSelection.credentialRevision }
    : { kind: 'profile', serviceId: 'antigravity', record: record.data, profileId: params.baseSelection.profileId,
        credentialRevision: params.baseSelection.credentialRevision };
  const materialized = await createAgyConnectedServicesMaterializer()({
    agentId: 'agy', activeServerDir: params.activeServerDir, rootDir: home,
    sessionDirectory: params.input.tracked?.spawnOptions?.directory ?? params.input.cwd ?? null,
    recordsByServiceId: new Map([['antigravity', record.data]]),
    selectionsByServiceId: new Map([['antigravity', selection]]),
    accountSettings: params.accountSettings, processEnv: params.processEnv,
    validateGroupMutationCurrentness: createConnectedServiceGroupMutationCurrentnessValidator({
      api: params.api, credentials: params.credentials,
    }),
    cleanupRoot: () => {},
  });
  if (!materialized) return params.baseSelection;
  return {
    ...params.baseSelection,
    targetMaterializedRoot: materialized.targetMaterializedRoot ?? home,
    targetMaterializedEnv: materialized.env,
    materializationDiagnostics: materialized.diagnostics,
  };
};
