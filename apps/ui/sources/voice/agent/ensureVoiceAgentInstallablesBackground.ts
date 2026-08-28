import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

export async function ensureVoiceAgentInstallablesBackground(params: Readonly<{
  agentId: string | null;
  sessionId: string;
}>): Promise<void> {
  // Agent identity is open here on purpose: installable deps are contributed per Agent, and a
  // plugin-contributed Agent declares its own through the daemon projection that
  // `ensureAgentInstallablesBackground` already consults. That owner no-ops for an Agent with no
  // relevant installables, so narrowing to the bundled ids would only deny installed external
  // Agents their own dependencies.
  const normalizedAgentId = normalizeNonEmptyString(params.agentId);
  if (!normalizedAgentId) return;

  const state: any = storage.getState();
  const metadata = readVoiceSessionOwnerMetadataFromState(state, params.sessionId);
  const machineId = normalizeNonEmptyString(readMachineTargetForSession(params.sessionId)?.machineId)
    ?? normalizeNonEmptyString(metadata?.machineId);
  if (!machineId) return;

  await ensureAgentInstallablesBackground({
    agentId: normalizedAgentId,
    machineId,
    serverId: getActiveServerSnapshot().serverId,
    settings: state?.settings ?? {},
    resumeSessionId: params.sessionId,
  });
}
