import {
  applySessionConfigOptionOverrideRules,
  areSameAgentRoutingIdentity,
  computeSessionConfigOptionControls,
  computeSessionConfigOptionControlsFromOverride,
  findModelOptionForEffectiveModelId,
  getAgentStaticModels,
  parseSessionModelsState,
  readMetadataAliasValue,
  resolveAgentIdFromSessionMetadata,
  resolveSessionConfigOptionChoices,
  resolveSessionConfigOptionOverridesFromMetadata,
  SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  type SessionConfigOptionInput,
} from '@happier-dev/agents';
import { applyAcpConfigOptionIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { resolveSessionModelSelectionFromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { buildBackendTargetKeyV2, convertBackendTargetRefV2ToV1, PersistedBackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isNativeAutomaticModelSelectionInputV1 } from '@happier-dev/protocol/providers/model-selection';
import { isSessionModelRefSourceBound, readSessionModelRefProviderConnectionId, SessionActiveModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { readAuthoredSessionModelSelection, SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { RpcError } from '@happier-dev/protocol/rpc/errors';
import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import {
  SESSION_CONTEXT_USAGE_REFRESH_OPTION_ID, SESSION_CONTEXT_USAGE_REFRESH_VALUE_ID,
  type SessionConfigOptionChoices, type SessionConfigOptionRequest, type SessionConfigOptionWriteReceipt,
} from '@happier-dev/protocol/sessions/control/sessionConfigOptionV1';

import type { StoredCredentials } from '@/persistence';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { probeAgentModelsBestEffort } from '@/session/actions/cliActionDeps/resolveAgentProbeInventoryDeps';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';

type ModelDescriptor = Readonly<{
  id: string;
  extendedContextModelId?: string;
  modelOptions?: readonly SessionConfigOptionInput[];
}>;
type ControlEnvironment = Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  signal?: AbortSignal;
  readProviderModels?: (request: DaemonProviderModelProjectionRequestV1) => Promise<DaemonProviderModelProjectionResponseV1>;
}>;

async function readEffectiveConfigChoices(metadata: Record<string, unknown>, env: ControlEnvironment): Promise<SessionConfigOptionChoices> {
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  if (!agentId) return { options: [] };
  const target = resolveBackendTargetFromSessionMetadata(metadata);
  const persistedTarget = PersistedBackendTargetRefV2Schema.safeParse(metadata.backendTarget);
  const bindings = SessionTeamCredentialBindingIntentsV1Schema.safeParse(metadata.teamCredentialBindings);
  const selection = readAuthoredSessionModelSelection({
    modelSelection: target ? resolveSessionModelSelectionFromMetadata(metadata, buildBackendTargetKeyV2(target)) : null,
    agentTarget: persistedTarget.success ? persistedTarget.data : null,
    ...(bindings.success ? { teamCredentialBindings: bindings.data } : {}),
  });
  const ref = selection?.ref;
  const rawModels = readMetadataAliasValue(metadata, SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY);
  const sessionModels = parseSessionModelsState(rawModels);
  const observed = sessionModels && areSameAgentRoutingIdentity(sessionModels.agentId, agentId) ? sessionModels : null;
  const active = SessionActiveModelSelectionSchema.safeParse(observed && rawModels && typeof rawModels === 'object'
    && 'activeSelectionV1' in rawModels ? rawModels.activeSelectionV1 : undefined).data;
  const binding = readSessionProviderBindingMetadataV1(metadata);
  let model: ModelDescriptor | null | undefined;
  if (ref && isSessionModelRefSourceBound(ref)) {
    const connectionId = readSessionModelRefProviderConnectionId(ref);
    const team = active?.v === 2 ? active.teamCredentialModel : null;
    const exactTeam = team && 'source' in ref && ref.source === 'team_resource'
      && team.teamId === ref.teamId && team.resourceId === ref.resourceId
      && team.expectedResourceRevision === ref.expectedResourceRevision && team.deliveryMode === ref.deliveryMode
      && team.agentTargetKey === ref.agentTargetKey && team.modelId === ref.modelId;
    if (binding?.model?.id === ref.modelId && (connectionId ? connectionId === binding.connectionId : exactTeam)) {
      model = binding.model;
    } else if (exactTeam) {
      model = observed?.availableModels.find(candidate => candidate.id === ref.modelId);
    } else if (connectionId && env.readProviderModels) {
      const projection = await env.readProviderModels({
        machineId: env.machineId, agentTargetKey: ref.agentTargetKey,
        currentSelection: { agentTargetKey: ref.agentTargetKey, providerConnectionId: connectionId, modelId: ref.modelId },
        sourceConnectionId: connectionId, refreshPolicy: 'current_only',
      });
      if (projection.status === 'error') throw new RpcError(projection.error.code, projection.error.code);
      model = projection.groups.find(group => group.connectionId === connectionId)
        ?.rows.find(row => row.ref.modelId === ref.modelId)?.descriptor;
    }
  } else if (!ref && active && (active.v === 2 || active.selection.providerConnectionId !== null)) {
    model = binding?.model?.id === active.selection.modelId
      ? binding.model
      : observed?.availableModels.find(candidate => candidate.id === active.selection.modelId);
  } else {
    const selectedModelId = ref && !isNativeAutomaticModelSelectionInputV1(ref) ? ref.modelId : null;
    const modelId = selectedModelId ?? observed?.currentModelId ?? 'default';
    // Transition publishes the exact bound descriptor into the same catalog.
    // A bound row with the same name cannot describe the native route.
    const nativeModels = observed?.availableModels.filter(candidate => binding?.model?.id !== candidate.id) ?? [];
    model = findModelOptionForEffectiveModelId(nativeModels, modelId, candidate => candidate.id);
    if (!model && selectedModelId && target && typeof metadata.path === 'string') {
      const catalog = await probeAgentModelsBestEffort({
        agentId, backendTarget: convertBackendTargetRefV2ToV1(target),
        runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(metadata) ?? undefined,
        cwd: metadata.path, credentials: env.credentials, signal: env.signal, modelId,
        accountSettings: await resolveAvailableAccountSettings({ credentials: env.credentials }),
      });
      if (catalog.source !== 'unavailable') {
        model = findModelOptionForEffectiveModelId(catalog.availableModels, modelId, candidate => candidate.id);
      }
    }
    model ??= findModelOptionForEffectiveModelId(getAgentStaticModels(agentId, { catalogOnly: true }), modelId, candidate => candidate.id);
  }
  const sessionControls = computeSessionConfigOptionControls({ agentId, metadata }) ?? [];
  const modelControls = computeSessionConfigOptionControlsFromOverride({
    agentId,
    configOptions: model?.modelOptions,
    overrides: resolveSessionConfigOptionOverridesFromMetadata({ metadata, configOptions: model?.modelOptions }),
  }) ?? [];
  const controls = applySessionConfigOptionOverrideRules(
    [...modelControls, ...sessionControls.filter(control => !modelControls.some(modelControl => modelControl.option.id === control.option.id))],
    [...sessionControls, ...modelControls],
  );
  const options = controls.filter(control => !control.disabled && control.option.id !== SESSION_CONTEXT_USAGE_REFRESH_OPTION_ID)
    .map(({ option }) => ({
      id: option.id,
      label: option.name,
      values: resolveSessionConfigOptionChoices(option).map(choice => ({ id: choice.value, label: choice.name })),
    }));
  if (areSameAgentRoutingIdentity(agentId, 'claude')) options.push({
    id: SESSION_CONTEXT_USAGE_REFRESH_OPTION_ID, label: 'Context usage',
    values: [{ id: SESSION_CONTEXT_USAGE_REFRESH_VALUE_ID, label: 'Refresh' }],
  });
  return { options };
}

export async function readSessionConfigOptionChoicesForTarget(sessionId: string, env: ControlEnvironment): Promise<SessionConfigOptionChoices> {
  const transport = await resolveSessionTransportContext({
    credentials: env.credentials, idOrPrefix: sessionId, exact: true, reason: 'waitForMetadataUpdate', usage: 'read', signal: env.signal,
  });
  if (!transport.ok) throw new RpcError(transport.code, transport.code);
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: env.credentials, rawSession: transport.rawSession, accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
  });
  if (!metadata) throw new RpcError('session_metadata_unavailable', 'session_metadata_unavailable');
  return await readEffectiveConfigChoices(metadata, env);
}

export async function writeSessionConfigOptionForTarget(
  request: SessionConfigOptionRequest, env: ControlEnvironment,
): Promise<SessionConfigOptionWriteReceipt> {
  const { sessionId, configId, valueId } = request;
  const updatedAt = Date.now();
  const result = await updateSessionMetadataForTarget({
    credentials: env.credentials, idOrPrefix: sessionId, expectedSessionId: sessionId, currentness: { signal: env.signal },
    updater: async metadata => {
      if (valueId !== null) {
        const { options } = await readEffectiveConfigChoices(metadata, env);
        if (!options.find(option => option.id === configId)?.values.some(value => value.id === valueId)) {
          throw new RpcError('invalid_parameters', 'invalid_parameters');
        }
      }
      // The Claude runtime consumes a changing metadata value for each refresh.
      const value = configId === SESSION_CONTEXT_USAGE_REFRESH_OPTION_ID && valueId !== null ? String(updatedAt) : valueId;
      return applyAcpConfigOptionIntentSessionMetadata(metadata, { v: 1, configId, value, updatedAt });
    },
  });
  if (!result.ok) throw new RpcError(result.code, result.code);
  return { sessionId, configId, valueId, metadataVersion: result.version };
}
