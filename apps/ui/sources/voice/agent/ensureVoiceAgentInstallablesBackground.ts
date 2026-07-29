import type { AgentId } from '@/agents/catalog/catalog';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { isAgentId } from '@/agents/registry/registryCore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

export async function ensureVoiceAgentInstallablesBackground(params: Readonly<{
  agentId: string | null;
  sessionId: string;
}>): Promise<void> {
  const normalizedAgentId = normalizeNonEmptyString(params.agentId);
  if (!normalizedAgentId || !isAgentId(normalizedAgentId)) return;

  const state: any = storage.getState();
  const metadata = readVoiceSessionOwnerMetadataFromState(state, params.sessionId);
  const machineId = normalizeNonEmptyString(readMachineTargetForSession(params.sessionId)?.machineId)
    ?? normalizeNonEmptyString(metadata?.machineId);
  if (!machineId) return;

  await ensureAgentInstallablesBackground({
    agentId: normalizedAgentId as AgentId,
    machineId,
    serverId: getActiveServerSnapshot().serverId,
    settings: state?.settings ?? {},
    resumeSessionId: params.sessionId,
  });
}
