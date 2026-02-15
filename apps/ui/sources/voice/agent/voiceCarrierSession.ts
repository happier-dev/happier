import { machineSpawnNewSession } from '@/sync/ops/machines';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { DEFAULT_AGENT_ID, type AgentId } from '@happier-dev/agents';
import { isAgentId } from '@/agents/registry/registryCore';

export const VOICE_CARRIER_SYSTEM_SESSION_KEY = 'voice_carrier';

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function findVoiceCarrierSessionId(state: any): string | null {
  const sessionsObj = state?.sessions ?? {};
  let best: { id: string; updatedAt: number } | null = null;

  for (const s of Object.values(sessionsObj) as any[]) {
    if (!s || typeof s.id !== 'string') continue;
    const meta = s.metadata ?? null;
    const sys = meta?.systemSessionV1 ?? null;
    if (!sys || sys.hidden !== true || String(sys.key ?? '') !== VOICE_CARRIER_SYSTEM_SESSION_KEY) continue;

    const id = s.id;
    const updatedAt = typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
    if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && id < best.id)) {
      best = { id, updatedAt };
    }
  }

  return best?.id ?? null;
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

  // Last-ditch: any session with machine+path.
  for (const s of Object.values(sessionsObj) as any[]) {
    const fallbackMachineId = normalizeNonEmptyString(s?.metadata?.machineId);
    const fallbackDirectory = normalizeNonEmptyString(s?.metadata?.path);
    if (fallbackMachineId && fallbackDirectory) return { machineId: fallbackMachineId, directory: fallbackDirectory };
  }

  return null;
}

function resolveCarrierAgentId(state: any): AgentId {
  const agentCfg = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
  const agentSource = String(agentCfg?.agentSource ?? 'session');
  const requestedAgentId = normalizeNonEmptyString(agentCfg?.agentId);
  const lastUsedAgent = normalizeNonEmptyString(state?.settings?.lastUsedAgent);
  const fallback = isAgentId(lastUsedAgent) ? lastUsedAgent : DEFAULT_AGENT_ID;

  if (agentSource === 'agent' && isAgentId(requestedAgentId)) {
    return requestedAgentId;
  }

  return fallback;
}

async function waitForSessionMetadata(sessionId: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const s: any = storage.getState().sessions?.[sessionId] ?? null;
    if (s?.metadata) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('voice_carrier_session_not_ready');
}

let ensurePromise: Promise<string> | null = null;

/**
 * Ensure a dedicated hidden/system session exists for the global voice agent to borrow
 * a stable session-scoped encryption context for daemon RPC calls.
 */
export async function ensureVoiceCarrierSessionId(): Promise<string> {
  const existing = findVoiceCarrierSessionId(storage.getState() as any);
  if (existing) return existing;

  if (ensurePromise) return await ensurePromise;

  ensurePromise = (async () => {
    try {
      const state: any = storage.getState();
      const target = resolveSpawnTarget(state);
      if (!target) {
        throw Object.assign(new Error('voice_carrier_spawn_target_missing'), { code: 'VOICE_CARRIER_TARGET_MISSING' });
      }

      const agent = resolveCarrierAgentId(state);
      const serverId = getActiveServerSnapshot().serverId;

      const spawned = await machineSpawnNewSession({
        machineId: target.machineId,
        directory: target.directory,
        agent,
        serverId,
      });

      if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
        throw Object.assign(new Error('voice_carrier_spawn_failed'), { code: 'VOICE_CARRIER_SPAWN_FAILED' });
      }

      const sessionId = spawned.sessionId;
      await sync.refreshSessions();
      await waitForSessionMetadata(sessionId, 15_000);

      await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
        ...metadata,
        systemSessionV1: { v: 1, key: VOICE_CARRIER_SYSTEM_SESSION_KEY, hidden: true },
        summary: metadata?.summary ?? { text: 'Voice control (system)', updatedAt: Date.now() },
      }));

      return sessionId;
    } finally {
      ensurePromise = null;
    }
  })();

  return await ensurePromise;
}
