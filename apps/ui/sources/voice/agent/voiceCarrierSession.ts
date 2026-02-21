import { machineSpawnNewSession } from '@/sync/ops/machines';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { DEFAULT_AGENT_ID, type AgentId } from '@happier-dev/agents';
import { isAgentId } from '@/agents/registry/registryCore';
import { buildSystemSessionMetadataV1, readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol';

export const VOICE_CARRIER_SYSTEM_SESSION_KEY = 'voice_carrier';
const VOICE_CARRIER_RETIRED_SYSTEM_SESSION_KEY = 'voice_carrier_retired';

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isVoiceCarrierSystemSessionMetadata(metadata: unknown): boolean {
  const systemSession = readSystemSessionMetadataFromMetadata({ metadata });
  return systemSession?.hidden === true && String(systemSession.key ?? '') === VOICE_CARRIER_SYSTEM_SESSION_KEY;
}

function buildVoiceCarrierSystemSessionMetadata() {
  return buildSystemSessionMetadataV1({ key: VOICE_CARRIER_SYSTEM_SESSION_KEY, hidden: true });
}

export function findVoiceCarrierSessionId(state: any): string | null {
  const sessionsObj = state?.sessions ?? {};
  let best: { id: string; updatedAt: number } | null = null;

  for (const s of Object.values(sessionsObj) as any[]) {
    if (!s || typeof s.id !== 'string') continue;
    const meta = s.metadata ?? null;
    if (!isVoiceCarrierSystemSessionMetadata(meta)) continue;

    const id = s.id;
    const updatedAt = typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
    if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && id < best.id)) {
      best = { id, updatedAt };
    }
  }

  return best?.id ?? null;
}

function joinFsPath(base: string, child: string): string {
  const trimmedBase = String(base ?? '').trim().replace(/\/+$/g, '');
  const trimmedChild = String(child ?? '').trim().replace(/^\/+/g, '');
  if (!trimmedBase) return trimmedChild;
  if (!trimmedChild) return trimmedBase;
  return `${trimmedBase}/${trimmedChild}`;
}

function resolveVoiceHomeDirectory(state: any, machineId: string): string | null {
  const settingsVoiceAgent: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
  const subdir = normalizeNonEmptyString(settingsVoiceAgent?.voiceHomeSubdirName) ?? 'voice-agent';
  const machinesObj = state?.machines ?? {};
  const machine = machinesObj?.[machineId] ?? null;
  const happyHomeDir = normalizeNonEmptyString(machine?.metadata?.happyHomeDir);
  if (!happyHomeDir) return null;
  return joinFsPath(happyHomeDir, subdir);
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

function resolveVoiceHomeSpawnTarget(state: any): { machineId: string; directory: string } | null {
  const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
  const fixedMachineId = agentCfg?.machineTargetMode === 'fixed' ? normalizeNonEmptyString(agentCfg?.machineTargetId) : null;
  const machineId = fixedMachineId ?? resolveSpawnTarget(state)?.machineId ?? null;
  if (!machineId) return null;
  const directory = resolveVoiceHomeDirectory(state, machineId);
  if (!directory) return null;
  return { machineId, directory };
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

async function touchVoiceCarrierSession(sessionId: string): Promise<void> {
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => {
    const summaryText = typeof metadata?.summary?.text === 'string' ? metadata.summary.text : 'Voice control (system)';
    return {
      ...metadata,
      ...buildVoiceCarrierSystemSessionMetadata(),
      summary: { text: summaryText, updatedAt: Date.now() },
    };
  });
}

function resolveCarrierRetentionLimit(state: any): number {
  const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
  const policy = agentCfg?.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single';
  if (policy === 'single') return 1;
  const raw = Number(agentCfg?.maxWarmRoots ?? 3);
  const maxWarmRoots = Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.floor(raw))) : 3;
  return maxWarmRoots;
}

async function retireVoiceCarrierSession(sessionId: string): Promise<void> {
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
    ...metadata,
    ...buildSystemSessionMetadataV1({ key: VOICE_CARRIER_RETIRED_SYSTEM_SESSION_KEY, hidden: true }),
    voiceAgentRunV1: null,
  }));
}

async function applyVoiceCarrierRetentionPolicy(params: Readonly<{ keepSessionId: string }>): Promise<void> {
  const keepSessionId = normalizeNonEmptyString(params.keepSessionId);
  if (!keepSessionId) return;
  const state: any = storage.getState();
  const limit = resolveCarrierRetentionLimit(state);
  if (!Number.isFinite(limit) || limit <= 0) return;

  const sessionsObj = state?.sessions ?? {};
  const carrierSessions: Array<{ id: string; updatedAt: number }> = [];
  for (const s of Object.values(sessionsObj) as any[]) {
    if (!s || typeof s.id !== 'string') continue;
    const meta = s.metadata ?? null;
    if (!isVoiceCarrierSystemSessionMetadata(meta)) continue;
    if (s.id === keepSessionId) continue;
    const updatedAt = typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
    carrierSessions.push({ id: s.id, updatedAt });
  }

  if (limit === 1) {
    await Promise.all(carrierSessions.map((c) => retireVoiceCarrierSession(c.id).catch(() => {})));
    return;
  }

  carrierSessions.sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
  const keepCount = Math.max(0, limit - 1);
  const toRetire = carrierSessions.slice(keepCount);
  await Promise.all(toRetire.map((c) => retireVoiceCarrierSession(c.id).catch(() => {})));
}

export async function ensureVoiceCarrierSessionForVoiceHome(): Promise<string> {
  const state: any = storage.getState();
  const target = resolveVoiceHomeSpawnTarget(state);
  if (!target) {
    throw Object.assign(new Error('voice_carrier_spawn_target_missing'), { code: 'VOICE_CARRIER_TARGET_MISSING' });
  }

  // Reuse an existing hidden carrier session already rooted at this machine+directory when possible.
  let bestExisting: { id: string; updatedAt: number } | null = null;
  for (const s of Object.values(state.sessions ?? {}) as any[]) {
    if (!s || typeof s.id !== 'string') continue;
    const meta = s.metadata ?? null;
    if (!isVoiceCarrierSystemSessionMetadata(meta)) continue;
    if (normalizeNonEmptyString(meta?.machineId) !== target.machineId) continue;
    if (normalizeNonEmptyString(meta?.path) !== target.directory) continue;
    const updatedAt = typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
    if (!bestExisting || updatedAt > bestExisting.updatedAt || (updatedAt === bestExisting.updatedAt && s.id < bestExisting.id)) {
      bestExisting = { id: s.id, updatedAt };
    }
  }

  if (bestExisting) {
    await touchVoiceCarrierSession(bestExisting.id).catch(() => {});
    await applyVoiceCarrierRetentionPolicy({ keepSessionId: bestExisting.id }).catch(() => {});
    return bestExisting.id;
  }

  const agent = resolveCarrierAgentId(state);
  const serverId = getActiveServerSnapshot().serverId;

  const spawned = await machineSpawnNewSession({
    machineId: target.machineId,
    directory: target.directory,
    approvedNewDirectoryCreation: true,
    agent,
    serverId,
  });

  if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
    throw Object.assign(new Error('voice_carrier_spawn_failed'), { code: 'VOICE_CARRIER_SPAWN_FAILED' });
  }

  const sessionId = spawned.sessionId;
  await sync.refreshSessions();
  await waitForSessionMetadata(sessionId, 15_000);
  await touchVoiceCarrierSession(sessionId).catch(() => {});
  await applyVoiceCarrierRetentionPolicy({ keepSessionId: sessionId }).catch(() => {});
  return sessionId;
}

/**
 * Ensure a dedicated hidden/system session exists for the global voice agent to borrow
 * a stable session-scoped encryption context for daemon RPC calls.
 */
export async function ensureVoiceCarrierSessionId(): Promise<string> {
  if (ensurePromise) return await ensurePromise;

  ensurePromise = (async () => {
    try {
      return await ensureVoiceCarrierSessionForVoiceHome();
    } finally {
      ensurePromise = null;
    }
  })();

  return await ensurePromise;
}

export async function ensureVoiceCarrierSessionForSessionRoot(params: Readonly<{ sessionId: string }>): Promise<string> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) throw new Error('voice_carrier_session_target_missing');

  const state: any = storage.getState();
  const session: any = state.sessions?.[sessionId] ?? null;
  const machineId = normalizeNonEmptyString(session?.metadata?.machineId);
  const directory = normalizeNonEmptyString(session?.metadata?.path);
  if (!machineId || !directory) throw new Error('voice_carrier_session_target_missing');

  // Reuse an existing hidden carrier session already rooted at this machine+directory when possible.
  let bestExisting: { id: string; updatedAt: number } | null = null;
  for (const s of Object.values(state.sessions ?? {}) as any[]) {
    if (!s || typeof s.id !== 'string') continue;
    const meta = s.metadata ?? null;
    if (!isVoiceCarrierSystemSessionMetadata(meta)) continue;
    if (normalizeNonEmptyString(meta?.machineId) !== machineId) continue;
    if (normalizeNonEmptyString(meta?.path) !== directory) continue;
    const updatedAt = typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
    if (!bestExisting || updatedAt > bestExisting.updatedAt || (updatedAt === bestExisting.updatedAt && s.id < bestExisting.id)) {
      bestExisting = { id: s.id, updatedAt };
    }
  }
  if (bestExisting) {
    await touchVoiceCarrierSession(bestExisting.id).catch(() => {});
    await applyVoiceCarrierRetentionPolicy({ keepSessionId: bestExisting.id }).catch(() => {});
    return bestExisting.id;
  }

  const agent = resolveCarrierAgentId(state);
  const serverId = getActiveServerSnapshot().serverId;

  const spawned = await machineSpawnNewSession({
    machineId,
    directory,
    agent,
    serverId,
  });

  if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
    throw Object.assign(new Error('voice_carrier_spawn_failed'), { code: 'VOICE_CARRIER_SPAWN_FAILED' });
  }

  const spawnedId = spawned.sessionId;
  await sync.refreshSessions();
  await waitForSessionMetadata(spawnedId, 15_000);
  await touchVoiceCarrierSession(spawnedId).catch(() => {});
  await applyVoiceCarrierRetentionPolicy({ keepSessionId: spawnedId }).catch(() => {});

  return spawnedId;
}
