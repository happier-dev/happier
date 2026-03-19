import type { AgentId } from '@/agents/catalog/catalog';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { isAgentId } from '@/agents/registry/registryCore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export async function ensureVoiceAgentInstallablesBackground(params: Readonly<{
  agentId: string | null;
  sessionId: string;
}>): Promise<void> {
  const normalizedAgentId = normalizeNonEmptyString(params.agentId);
  if (!normalizedAgentId || !isAgentId(normalizedAgentId)) return;

  const state: any = storage.getState();
  const session = state?.sessions?.[params.sessionId] ?? null;
  const machineId = normalizeNonEmptyString(session?.metadata?.machineId);
  if (!machineId) return;

  await ensureAgentInstallablesBackground({
    agentId: normalizedAgentId as AgentId,
    machineId,
    serverId: getActiveServerSnapshot().serverId,
    settings: state?.settings ?? {},
    resumeSessionId: params.sessionId,
  });
}
