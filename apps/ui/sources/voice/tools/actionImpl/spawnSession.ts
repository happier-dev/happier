import { sync } from '@/sync/sync';
import { machineSpawnNewSession } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import { isAgentId } from '@/agents/registry/registryCore';
import type { AgentId } from '@/agents/catalog/catalog';

import { normalizeNonEmptyString } from './shared';

function resolveSpawnAgentId(state: any): AgentId {
  const lastUsedAgent = normalizeNonEmptyString(state?.settings?.lastUsedAgent);
  if (lastUsedAgent && isAgentId(lastUsedAgent)) return lastUsedAgent as AgentId;
  return DEFAULT_AGENT_ID as AgentId;
}

function resolveSpawnTarget(state: any): { machineId: string; directory: string } | null {
  const sessionsObj = state?.sessions ?? {};
  const voiceTarget = useVoiceTargetStore.getState();
  const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
    .map((v) => normalizeNonEmptyString(v))
    .filter(Boolean) as string[];

  for (const sid of candidates) {
    const s = sessionsObj?.[sid] ?? null;
    const machineId = normalizeNonEmptyString(s?.metadata?.machineId);
    const directory = normalizeNonEmptyString(s?.metadata?.path);
    if (machineId && directory) return { machineId, directory };
  }

  const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
  const machineId = normalizeNonEmptyString(recent?.machineId);
  const directory = normalizeNonEmptyString(recent?.path);
  if (machineId && directory) return { machineId, directory };

  for (const s of Object.values(sessionsObj) as any[]) {
    const fallbackMachineId = normalizeNonEmptyString(s?.metadata?.machineId);
    const fallbackDirectory = normalizeNonEmptyString(s?.metadata?.path);
    if (fallbackMachineId && fallbackDirectory) return { machineId: fallbackMachineId, directory: fallbackDirectory };
  }

  return null;
}

export async function spawnSessionForVoiceTool(params: Readonly<{
  tag?: string;
  path?: string;
  host?: string;
  initialMessage?: string;
}>): Promise<unknown> {
  const state: any = storage.getState();

  const requestedHost = normalizeNonEmptyString(params.host);
  const machinesObj: any = state?.machines ?? {};
  const match = requestedHost
    ? ((Object.values(machinesObj as any).find((m: any) => normalizeNonEmptyString(m?.metadata?.host) === requestedHost) as any) ?? null)
    : null;
  const machineIdFromHost = requestedHost ? (match?.id ?? null) : null;

  const fallbackTarget = resolveSpawnTarget(state);
  const machineId = normalizeNonEmptyString(machineIdFromHost) ?? fallbackTarget?.machineId ?? null;
  const directory = normalizeNonEmptyString(params.path) ?? fallbackTarget?.directory ?? null;
  if (!machineId || !directory) {
    return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
  }

  const serverId = getActiveServerSnapshot().serverId;
  const agent = resolveSpawnAgentId(state);

  const spawned = await machineSpawnNewSession({
    machineId,
    directory,
    agent,
    serverId,
  });

  const spawnedSessionId =
    spawned && (spawned as any).type === 'success' && typeof (spawned as any).sessionId === 'string'
      ? String((spawned as any).sessionId)
      : null;

  const tag = normalizeNonEmptyString(params.tag);
  const initialMessage = normalizeNonEmptyString(params.initialMessage);

  if (spawnedSessionId) {
    if (tag) {
      try {
        await sync.refreshSessions();
        await sync.patchSessionMetadataWithRetry(spawnedSessionId, (metadata: any) => ({
          ...metadata,
          summary: { text: metadata?.summary?.text ?? `Session ${tag}`, updatedAt: Date.now() },
        }));
      } catch {
        // best-effort
      }
    }
    if (initialMessage) {
      try {
        await sync.refreshSessions();
        await sync.sendMessage(spawnedSessionId, initialMessage);
      } catch {
        // best-effort
      }
    }
  }

  return spawned;
}

