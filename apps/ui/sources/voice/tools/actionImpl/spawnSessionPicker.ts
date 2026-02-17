import { machineSpawnNewSession } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { openVoiceSessionSpawnPicker } from '@/voice/pickers/openVoiceSessionSpawnPicker';
import { resolveSpawnAgentIdFromState } from './spawnSessionAgent';
import { postprocessSpawnedSession } from './spawnSessionPostProcess';
import { normalizeNonEmptyString } from './shared';
import { isAgentId } from '@/agents/registry/registryCore';

export async function spawnSessionWithPickerForVoiceTool(params: Readonly<{ tag?: string; agentId?: string; modelId?: string; initialMessage?: string }>): Promise<unknown> {
  const picked = await openVoiceSessionSpawnPicker();
  if (!picked) {
    return { ok: false, errorCode: 'user_cancelled', errorMessage: 'user_cancelled' };
  }

  const state: any = storage.getState();
  const serverId = getActiveServerSnapshot().serverId;
  const requestedAgentId = normalizeNonEmptyString(params.agentId);
  if (requestedAgentId && !isAgentId(requestedAgentId)) {
    return { ok: false, errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
  }
  const agent = requestedAgentId ? (requestedAgentId as any) : resolveSpawnAgentIdFromState(state);
  const requestedModelId = normalizeNonEmptyString(params.modelId);
  const modelId = requestedModelId && requestedModelId !== 'default' ? requestedModelId : null;
  const modelUpdatedAt = modelId ? Date.now() : null;

  const spawned = await machineSpawnNewSession({
    machineId: picked.machineId,
    directory: picked.directory,
    agent,
    serverId,
    ...(modelId ? { modelId, modelUpdatedAt: modelUpdatedAt ?? Date.now() } : {}),
  });

  const spawnedSessionId =
    spawned && (spawned as any).type === 'success' && typeof (spawned as any).sessionId === 'string'
      ? String((spawned as any).sessionId)
      : null;

  await postprocessSpawnedSession({
    sessionId: spawnedSessionId,
    tag: normalizeNonEmptyString(params.tag),
    initialMessage: normalizeNonEmptyString(params.initialMessage),
  });

  return spawned;
}
