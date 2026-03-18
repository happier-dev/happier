import {
  buildSystemSessionMetadataV1,
  SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import { DEFAULT_AGENT_ID, type AgentId } from '@happier-dev/agents';

import { isAgentId } from '@/agents/registry/registryCore';
import { listPreferredMachineIds } from '@/components/settings/pickers/resolvePreferredMachineId';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import { machineSpawnNewSession } from '@/sync/ops/machines';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sync } from '@/sync/sync';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import {
  matchesVoiceConversationScope,
  writeVoiceConversationScopeMetadata,
  type VoiceConversationScopeMetadata,
} from './voiceConversationScopeMetadata';
import {
  findReusableVoiceConversationRuntimeSessionId,
  findVoiceConversationSessionId,
  isVoiceConversationSystemSessionMetadata,
  VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY,
  VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';
import { persistVoiceAutoTargetMachineId, readVoiceAutoTargetMachineId } from './voiceAutoTargetMachineSettings';

export {
  findReusableVoiceConversationRuntimeSessionId,
  findVoiceConversationSessionId,
  isVoiceConversationSystemSessionMetadata,
  VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';

const VOICE_HOME_SPAWN_TARGET_WAIT_TIMEOUT_MS = 5_000;
const VOICE_HOME_SPAWN_TARGET_WAIT_INTERVAL_MS = 100;
const VOICE_CONVERSATION_LATE_SPAWN_RECOVERY_TIMEOUT_MS = 5_000;
const VOICE_CONVERSATION_LATE_SPAWN_RECOVERY_POLL_INTERVAL_MS = 100;

function buildVoiceConversationSystemSessionMetadata() {
  return buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
}

function shouldRetireLegacyVoiceConversationSession(session: any): boolean {
  if (!session || typeof session !== 'object') return false;
  return readDirectSessionLink(session.metadata ?? null) !== null;
}

function isReusableVoiceConversationRuntimeSession(session: any): boolean {
  if (!session || typeof session !== 'object') return false;
  return session.active === true;
}

function joinFsPath(base: string, child: string): string {
  const trimmedBase = String(base ?? '').trim().replace(/\/+$/g, '');
  const trimmedChild = String(child ?? '').trim().replace(/^\/+/g, '');
  if (!trimmedBase) return trimmedChild;
  if (!trimmedChild) return trimmedBase;
  return `${trimmedBase}/${trimmedChild}`;
}

function resolveVoiceHomeDirectory(state: any, machineId: string): string | null {
  const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
  const subdir = normalizeNonEmptyString(agentCfg?.voiceHomeSubdirName) ?? 'voice-agent';
  const machine = resolveMachineForActiveServerFromState(state, machineId);
  if (machine && machine.active === false) return null;
  const happyHomeDir = normalizeNonEmptyString(machine?.metadata?.happyHomeDir);
  if (happyHomeDir) return joinFsPath(happyHomeDir, subdir);

  for (const recent of state?.settings?.recentMachinePaths ?? []) {
    if (normalizeNonEmptyString(recent?.machineId) !== machineId) continue;
    const recentDirectory = normalizeNonEmptyString(recent?.path);
    if (recentDirectory) return recentDirectory;
  }

  for (const session of Object.values(state?.sessions ?? {}) as any[]) {
    const resolvedTarget = typeof session?.id === 'string' ? readMachineTargetForSession(session.id) : null;
    if (normalizeNonEmptyString(resolvedTarget?.machineId) !== machineId) continue;
    const sessionDirectory = normalizeNonEmptyString(resolvedTarget?.basePath);
    if (sessionDirectory) return sessionDirectory;
  }

  return null;
}

function resolveSpawnTarget(state: any): { machineId: string; directory: string } | null {
  const sessionsObj = state?.sessions ?? {};
  const voiceTarget = useVoiceTargetStore.getState();
  const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean) as string[];

  for (const sessionId of candidates) {
    const resolvedTarget = readMachineTargetForSession(sessionId);
    const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
    const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
    if (machineId && directory) return { machineId, directory };
  }

  const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
  const recentMachineId = normalizeNonEmptyString(recent?.machineId);
  const recentDirectory = normalizeNonEmptyString(recent?.path);
  if (recentMachineId && recentDirectory) return { machineId: recentMachineId, directory: recentDirectory };

  for (const session of Object.values(sessionsObj) as any[]) {
    const resolvedTarget = typeof session?.id === 'string' ? readMachineTargetForSession(session.id) : null;
    const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
    const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
    if (machineId && directory) return { machineId, directory };
  }

  return null;
}

function resolveVoiceHomeSpawnTarget(state: any): { machineId: string; directory: string } | null {
  const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
  const fixedMachineId = agentCfg?.machineTargetMode === 'fixed' ? normalizeNonEmptyString(agentCfg?.machineTargetId) : null;
  if (fixedMachineId) {
    const fixedDirectory = resolveVoiceHomeDirectory(state, fixedMachineId);
    if (fixedDirectory) return { machineId: fixedMachineId, directory: fixedDirectory };
  }

  const isKnownInactiveMachine = (machineId: string): boolean => {
    const machine =
      resolveMachineForActiveServerFromState(state, machineId)
      ?? state?.machines?.[machineId]
      ?? null;
    return machine?.active === false;
  };

  const stickyAutoMachineId = readVoiceAutoTargetMachineId(state);
  if (stickyAutoMachineId) {
    const stickyMachine =
      resolveMachineForActiveServerFromState(state, stickyAutoMachineId)
      ?? state?.machines?.[stickyAutoMachineId]
      ?? null;
    const stickyDirectory = resolveVoiceHomeDirectory(state, stickyAutoMachineId);
    if (stickyDirectory && stickyMachine?.active !== false) {
      return { machineId: stickyAutoMachineId, directory: stickyDirectory };
    }
  }

  const candidateMachineIds: Array<string | null | undefined> = [
    resolveSpawnTarget(state)?.machineId,
    ...(
      Array.isArray(state?.settings?.recentMachinePaths)
        ? state.settings.recentMachinePaths.map((entry: any) => normalizeNonEmptyString(entry?.machineId))
        : []
    ),
    ...resolveVisibleMachinesForActiveServerFromState(state)
      .filter((machine) => machine.active === true)
      .map((machine) => normalizeNonEmptyString(machine.id)),
    ...listPreferredMachineIds({
      machines: resolveVisibleMachinesForActiveServerFromState(state),
      recentMachinePaths: Array.isArray(state?.settings?.recentMachinePaths) ? state.settings.recentMachinePaths : [],
    }),
    ...resolveVisibleMachinesForActiveServerFromState(state).map((machine) => normalizeNonEmptyString(machine.id)),
  ];
  const seenMachineIds = new Set<string>();

  for (const candidateMachineId of candidateMachineIds) {
    const machineId = normalizeNonEmptyString(candidateMachineId);
    if (!machineId) continue;
    if (seenMachineIds.has(machineId)) continue;
    seenMachineIds.add(machineId);
    if (isKnownInactiveMachine(machineId)) continue;
    const directory = resolveVoiceHomeDirectory(state, machineId);
    if (directory) {
      return { machineId, directory };
    }
  }

  return null;
}

function resolveVoiceConversationAgentId(state: any): AgentId {
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

async function waitForVoiceHomeSpawnTarget(timeoutMs: number): Promise<{ machineId: string; directory: string } | null> {
  const startedAt = Date.now();
  let target = resolveVoiceHomeSpawnTarget(storage.getState());
  while (!target && (Date.now() - startedAt) < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, VOICE_HOME_SPAWN_TARGET_WAIT_INTERVAL_MS));
    target = resolveVoiceHomeSpawnTarget(storage.getState());
  }
  return target;
}

function toVoiceConversationSpawnError(spawned: unknown): Error {
  const errorCode = normalizeNonEmptyString((spawned as any)?.errorCode);
  const errorMessage = normalizeNonEmptyString((spawned as any)?.errorMessage);
  return Object.assign(
    new Error(errorMessage ?? 'voice_conversation_spawn_failed'),
    { code: errorCode ?? 'VOICE_CONVERSATION_SPAWN_FAILED' },
  );
}

function assertTargetMachineOnline(machineId: string): void {
  const machine: any = storage.getState().machines?.[machineId] ?? null;
  if (!machine) return;
  if (isMachineOnline(machine) === true) return;
  throw Object.assign(
    new Error('Target machine daemon is offline. Start or reconnect the daemon before starting local voice.'),
    { code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' },
  );
}

function isSpawnWebhookTimeout(spawned: unknown): boolean {
  const errorCode = normalizeNonEmptyString((spawned as any)?.errorCode)?.toLowerCase();
  return errorCode === String(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT).toLowerCase();
}

function matchesLateSpawnedVoiceConversationTarget(
  session: any,
  params: Readonly<{ machineId: string; directory: string }>,
): boolean {
  return (
    normalizeNonEmptyString(session?.metadata?.machineId) === params.machineId
    && normalizeNonEmptyString(session?.metadata?.path) === params.directory
  );
}

function findLateSpawnedVoiceConversationSessionId(params: Readonly<{
  machineId: string;
  directory: string;
  knownSessionIds: ReadonlySet<string>;
}>): string | null {
  const sessions = Object.values((storage.getState() as any)?.sessions ?? {}) as any[];
  let best: { id: string; updatedAt: number } | null = null;

  for (const session of sessions) {
    if (!session || typeof session.id !== 'string') continue;
    if (params.knownSessionIds.has(session.id)) continue;
    if (session.active !== true) continue;
    if (!matchesLateSpawnedVoiceConversationTarget(session, params)) continue;

    const updatedAt = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
    if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && session.id < best.id)) {
      best = { id: session.id, updatedAt };
    }
  }

  return best?.id ?? null;
}

function listLateSpawnedVoiceConversationCandidateIds(params: Readonly<{
  knownSessionIds: ReadonlySet<string>;
}>): string[] {
  return (Object.values((storage.getState() as any)?.sessions ?? {}) as any[])
    .filter((session) =>
      session
      && typeof session.id === 'string'
      && !params.knownSessionIds.has(session.id)
      && session.active === true,
    )
    .sort((left: any, right: any) => {
      const leftUpdatedAt = typeof left?.updatedAt === 'number' && Number.isFinite(left.updatedAt) ? left.updatedAt : 0;
      const rightUpdatedAt = typeof right?.updatedAt === 'number' && Number.isFinite(right.updatedAt) ? right.updatedAt : 0;
      if (rightUpdatedAt !== leftUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
      return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
    })
    .map((session) => String(session.id));
}

async function recoverLateSpawnedVoiceConversationSessionId(params: Readonly<{
  machineId: string;
  directory: string;
  knownSessionIds: ReadonlySet<string>;
}>): Promise<string | null> {
  const startedAt = Date.now();

  while ((Date.now() - startedAt) < VOICE_CONVERSATION_LATE_SPAWN_RECOVERY_TIMEOUT_MS) {
    await sync.refreshSessions().catch(() => {});
    const recoveredSessionId = findLateSpawnedVoiceConversationSessionId(params);
    if (recoveredSessionId) return recoveredSessionId;

    for (const candidateSessionId of listLateSpawnedVoiceConversationCandidateIds(params)) {
      await sync.ensureSessionVisibleForMessageRoute(candidateSessionId, { forceRefresh: true } as any).catch(() => {});
      const candidateSession = (storage.getState() as any)?.sessions?.[candidateSessionId] ?? null;
      if (matchesLateSpawnedVoiceConversationTarget(candidateSession, params)) {
        return candidateSessionId;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, VOICE_CONVERSATION_LATE_SPAWN_RECOVERY_POLL_INTERVAL_MS));
  }

  return null;
}

async function waitForSessionMetadata(sessionId: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const session = storage.getState().sessions?.[sessionId] ?? null;
    if (session?.metadata) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('voice_conversation_session_not_ready');
}

async function resolveSessionRootTarget(sessionId: string): Promise<Readonly<{ machineId: string; directory: string }> | null> {
  const readTarget = () => {
    const resolvedTarget = readMachineTargetForSession(sessionId);
    const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
    const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
    return machineId && directory ? { machineId, directory } : null;
  };

  const existingTarget = readTarget();
  if (existingTarget) return existingTarget;

  await sync.ensureSessionVisibleForMessageRoute(sessionId).catch(() => {});
  return readTarget();
}

let ensurePromise: Promise<string> | null = null;

async function touchVoiceConversationSession(sessionId: string): Promise<void> {
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => {
    const summaryText = typeof metadata?.summary?.text === 'string' ? metadata.summary.text : 'Voice conversation (system)';
    return {
      ...metadata,
      ...buildVoiceConversationSystemSessionMetadata(),
      summary: { text: summaryText, updatedAt: Date.now() },
    };
  });
}

async function touchVoiceConversationSessionWithScope(
  sessionId: string,
  scope: VoiceConversationScopeMetadata,
): Promise<void> {
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) =>
    writeVoiceConversationScopeMetadata(
      {
        ...metadata,
        ...buildVoiceConversationSystemSessionMetadata(),
        summary: {
          text: typeof metadata?.summary?.text === 'string' ? metadata.summary.text : 'Voice conversation (system)',
          updatedAt: Date.now(),
        },
      },
      scope,
    ),
  );
}

function resolveConversationRetentionLimit(state: any): number {
  const agentCfg: any = state?.settings?.voice?.adapters?.local_conversation?.agent ?? {};
  const policy = agentCfg?.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single';
  if (policy === 'single') return 1;
  const raw = Number(agentCfg?.maxWarmRoots ?? 3);
  return Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.floor(raw))) : 3;
}

async function retireVoiceConversationSession(sessionId: string): Promise<void> {
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
    ...metadata,
    ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY, hidden: true }),
    voiceAgentRunV1: null,
  }));
}

async function applyVoiceConversationRetentionPolicy(params: Readonly<{ keepSessionId: string }>): Promise<void> {
  const keepSessionId = normalizeNonEmptyString(params.keepSessionId);
  if (!keepSessionId) return;

  const state: any = storage.getState();
  const limit = resolveConversationRetentionLimit(state);
  if (!Number.isFinite(limit) || limit <= 0) return;

  const sessions: Array<{ id: string; updatedAt: number }> = [];
  for (const session of Object.values(state?.sessions ?? {}) as any[]) {
    if (!session || typeof session.id !== 'string') continue;
    if (!isVoiceConversationSystemSessionMetadata(session.metadata ?? null)) continue;
    if (session.id === keepSessionId) continue;
    const updatedAt = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
    sessions.push({ id: session.id, updatedAt });
  }

  if (limit === 1) {
    await Promise.all(sessions.map((session) => retireVoiceConversationSession(session.id).catch(() => {})));
    return;
  }

  sessions.sort((left, right) => (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id));
  const keepCount = Math.max(0, limit - 1);
  const toRetire = sessions.slice(keepCount);
  await Promise.all(toRetire.map((session) => retireVoiceConversationSession(session.id).catch(() => {})));
}

async function retireLegacyVoiceConversationSessions(params: Readonly<{
  machineId: string;
  directory: string;
}>): Promise<void> {
  const machineId = normalizeNonEmptyString(params.machineId);
  const directory = normalizeNonEmptyString(params.directory);
  if (!machineId || !directory) return;

  const state: any = storage.getState();
  const toRetire: string[] = [];
  for (const session of Object.values(state.sessions ?? {}) as any[]) {
    if (!session || typeof session.id !== 'string') continue;
    if (!isVoiceConversationSystemSessionMetadata(session.metadata ?? null)) continue;
    if (!shouldRetireLegacyVoiceConversationSession(session)) continue;
    if (normalizeNonEmptyString(session.metadata?.machineId) !== machineId) continue;
    if (normalizeNonEmptyString(session.metadata?.path) !== directory) continue;
    toRetire.push(session.id);
  }

  await Promise.all(toRetire.map((sessionId) => retireVoiceConversationSession(sessionId).catch(() => {})));
}

export async function ensureVoiceConversationSessionForVoiceHome(): Promise<string> {
  const target = await waitForVoiceHomeSpawnTarget(VOICE_HOME_SPAWN_TARGET_WAIT_TIMEOUT_MS);
  if (!target) {
    throw Object.assign(new Error('voice_conversation_spawn_target_missing'), { code: 'VOICE_CONVERSATION_TARGET_MISSING' });
  }

  await retireLegacyVoiceConversationSessions(target).catch(() => {});
  const state: any = storage.getState();

  let bestExisting: { id: string; updatedAt: number } | null = null;
  for (const session of Object.values(state.sessions ?? {}) as any[]) {
    if (!session || typeof session.id !== 'string') continue;
    if (!isVoiceConversationSystemSessionMetadata(session.metadata ?? null)) continue;
    if (normalizeNonEmptyString(session.metadata?.machineId) !== target.machineId) continue;
    if (normalizeNonEmptyString(session.metadata?.path) !== target.directory) continue;
    if (!matchesVoiceConversationScope(session.metadata ?? null, { kind: 'voice_home' })) continue;
    if (!isReusableVoiceConversationRuntimeSession(session)) continue;
    const updatedAt = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
    if (!bestExisting || updatedAt > bestExisting.updatedAt || (updatedAt === bestExisting.updatedAt && session.id < bestExisting.id)) {
      bestExisting = { id: session.id, updatedAt };
    }
  }

  if (bestExisting) {
    persistVoiceAutoTargetMachineId(target.machineId);
    await touchVoiceConversationSessionWithScope(bestExisting.id, { kind: 'voice_home' }).catch(() => {});
    await applyVoiceConversationRetentionPolicy({ keepSessionId: bestExisting.id }).catch(() => {});
    return bestExisting.id;
  }

  const agent = resolveVoiceConversationAgentId(state);
  const serverId = getActiveServerSnapshot().serverId;
  const knownSessionIds = new Set(Object.keys(state.sessions ?? {}));
  const spawned = await machineSpawnNewSession({
    machineId: target.machineId,
    directory: target.directory,
    transcriptStorage: 'persisted',
    approvedNewDirectoryCreation: true,
    backendTarget: { kind: 'builtInAgent', agentId: agent },
    serverId,
  });

  if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
    if (isSpawnWebhookTimeout(spawned)) {
      const recoveredSessionId = await recoverLateSpawnedVoiceConversationSessionId({
        machineId: target.machineId,
        directory: target.directory,
        knownSessionIds,
      });
      if (recoveredSessionId) {
        await touchVoiceConversationSessionWithScope(recoveredSessionId, { kind: 'voice_home' }).catch(() => {});
        await applyVoiceConversationRetentionPolicy({ keepSessionId: recoveredSessionId }).catch(() => {});
        return recoveredSessionId;
      }
    }
    throw toVoiceConversationSpawnError(spawned);
  }

  await sync.refreshSessions();
  await waitForSessionMetadata(spawned.sessionId, 15_000);
  persistVoiceAutoTargetMachineId(target.machineId);
  await touchVoiceConversationSessionWithScope(spawned.sessionId, { kind: 'voice_home' }).catch(() => {});
  await applyVoiceConversationRetentionPolicy({ keepSessionId: spawned.sessionId }).catch(() => {});
  return spawned.sessionId;
}

export async function ensureVoiceConversationSessionId(): Promise<string> {
  if (ensurePromise) return await ensurePromise;

  ensurePromise = (async () => {
    try {
      return await ensureVoiceConversationSessionForVoiceHome();
    } finally {
      ensurePromise = null;
    }
  })();

  return await ensurePromise;
}

export async function ensureVoiceConversationSessionForSessionRoot(params: Readonly<{ sessionId: string }>): Promise<string> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) throw new Error('voice_conversation_session_target_missing');

  const target = await resolveSessionRootTarget(sessionId);
  const machineId = target?.machineId ?? null;
  const directory = target?.directory ?? null;
  if (!machineId || !directory) throw new Error('voice_conversation_session_target_missing');
  assertTargetMachineOnline(machineId);

  await retireLegacyVoiceConversationSessions({ machineId, directory }).catch(() => {});
  const state: any = storage.getState();

  let bestExisting: { id: string; updatedAt: number } | null = null;
  for (const existingSession of Object.values(state.sessions ?? {}) as any[]) {
    if (!existingSession || typeof existingSession.id !== 'string') continue;
    if (!isVoiceConversationSystemSessionMetadata(existingSession.metadata ?? null)) continue;
    if (normalizeNonEmptyString(existingSession.metadata?.machineId) !== machineId) continue;
    if (normalizeNonEmptyString(existingSession.metadata?.path) !== directory) continue;
    if (!matchesVoiceConversationScope(existingSession.metadata ?? null, { kind: 'session_root', sessionRootId: sessionId })) continue;
    if (!isReusableVoiceConversationRuntimeSession(existingSession)) continue;
    const updatedAt = typeof existingSession.updatedAt === 'number' && Number.isFinite(existingSession.updatedAt) ? existingSession.updatedAt : 0;
    if (!bestExisting || updatedAt > bestExisting.updatedAt || (updatedAt === bestExisting.updatedAt && existingSession.id < bestExisting.id)) {
      bestExisting = { id: existingSession.id, updatedAt };
    }
  }

  if (bestExisting) {
    await touchVoiceConversationSessionWithScope(bestExisting.id, { kind: 'session_root', sessionRootId: sessionId }).catch(() => {});
    await applyVoiceConversationRetentionPolicy({ keepSessionId: bestExisting.id }).catch(() => {});
    return bestExisting.id;
  }

  const agent = resolveVoiceConversationAgentId(state);
  const serverId = getActiveServerSnapshot().serverId;
  const knownSessionIds = new Set(Object.keys(state.sessions ?? {}));
  const spawned = await machineSpawnNewSession({
    machineId,
    directory,
    transcriptStorage: 'persisted',
    backendTarget: { kind: 'builtInAgent', agentId: agent },
    serverId,
  });

  if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
    if (isSpawnWebhookTimeout(spawned)) {
      const recoveredSessionId = await recoverLateSpawnedVoiceConversationSessionId({
        machineId,
        directory,
        knownSessionIds,
      });
      if (recoveredSessionId) {
        await touchVoiceConversationSessionWithScope(recoveredSessionId, { kind: 'session_root', sessionRootId: sessionId }).catch(() => {});
        await applyVoiceConversationRetentionPolicy({ keepSessionId: recoveredSessionId }).catch(() => {});
        return recoveredSessionId;
      }
    }
    throw toVoiceConversationSpawnError(spawned);
  }

  await sync.refreshSessions();
  await waitForSessionMetadata(spawned.sessionId, 15_000);
  await touchVoiceConversationSessionWithScope(spawned.sessionId, { kind: 'session_root', sessionRootId: sessionId }).catch(() => {});
  await applyVoiceConversationRetentionPolicy({ keepSessionId: spawned.sessionId }).catch(() => {});

  return spawned.sessionId;
}
