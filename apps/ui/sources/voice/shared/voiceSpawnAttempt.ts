import { createUiSessionSpawnUserAttemptId } from '@/sync/domains/session/spawn/spawnSessionNonce';
import {
  completeMachineSpawnAttemptCustody,
  type MachineSpawnAttemptCustody,
} from '@/sync/ops/machines';

export type VoiceSpawnAttempt = Readonly<{
  userAttemptId: string;
  firstTurnLocalId: string;
  attachmentMessageLocalId: string;
}>;

export function createVoiceSpawnAttempt(stableUserAttemptId?: string | null): VoiceSpawnAttempt {
  const userAttemptId = typeof stableUserAttemptId === 'string' && stableUserAttemptId.trim().length > 0
    ? stableUserAttemptId.trim()
    : createUiSessionSpawnUserAttemptId();
  return {
    userAttemptId,
    firstTurnLocalId: `voice-spawn-first-turn:${userAttemptId}`,
    attachmentMessageLocalId: `voice-spawn-attachments:${userAttemptId}`,
  };
}

export function readVoiceSpawnedSessionIdForAttempt(
  spawned: unknown,
  attempt: VoiceSpawnAttempt,
): string | null {
  if (!spawned || typeof spawned !== 'object' || Array.isArray(spawned)) return null;
  const result = spawned as Record<string, unknown>;
  if (result.type !== 'success' || typeof result.sessionId !== 'string' || !result.sessionId.trim()) return null;
  const custody = result.spawnAttemptCustody;
  if (!custody || typeof custody !== 'object' || Array.isArray(custody)) return null;
  const custodyRecord = custody as Record<string, unknown>;
  if (custodyRecord.status !== 'completed' || custodyRecord.userAttemptId !== attempt.userAttemptId) return null;
  return result.sessionId.trim();
}

export async function completeVoiceSpawnAttemptCustody(params: Readonly<{
  spawned: unknown;
  attempt: VoiceSpawnAttempt;
  machineId: string;
  serverId?: string | null;
}>): Promise<boolean> {
  if (!params.spawned || typeof params.spawned !== 'object' || Array.isArray(params.spawned)) return false;
  const custody = (params.spawned as { spawnAttemptCustody?: MachineSpawnAttemptCustody }).spawnAttemptCustody;
  if (custody?.status !== 'completed' || custody.userAttemptId !== params.attempt.userAttemptId) {
    return false;
  }
  return await completeMachineSpawnAttemptCustody({
    machineId: params.machineId,
    serverId: params.serverId,
    custody,
  });
}
