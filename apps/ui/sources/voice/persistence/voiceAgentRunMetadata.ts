import { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION } from '@happier-dev/protocol/voice/voiceAgentRunMetadataContract';
import { buildVoiceAgentRunMetadataV1, doesVoiceAgentRunMetadataMatchBackendTarget, parseVoiceAgentRunMetadataV1, type VoiceAgentRunMetadataV1 } from '@happier-dev/protocol/voice/voiceAgentRunMetadataV1';
import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import type { ExecutionRunResumeHandle } from '@happier-dev/protocol/execution/runs/index';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION };
export { doesVoiceAgentRunMetadataMatchBackendTarget };
export type { VoiceAgentRunMetadataV1 };

function readVoiceAgentRunMetadata(sessionId: string | null, serverId?: string): VoiceAgentRunMetadataV1 | null {
  if (!sessionId) return null;
  const state: any = storage.getState();
  const meta = readVoiceSessionOwnerMetadataFromState(state, serverId ? { serverId, sessionId } : sessionId);
  return parseVoiceAgentRunMetadataV1(meta?.voiceAgentRunV1 ?? null);
}

async function writeVoiceAgentRunMetadata(
  sessionId: string | null,
  params: Readonly<{
    runId: string;
    backendTarget: BackendTargetRefV1;
    resumeHandle: ExecutionRunResumeHandle | null;
    updatedAtMs: number;
    welcomedEpoch?: number;
    accountLifetime?: ServerAccountScopeLifetime;
  }>,
): Promise<void> {
  if (!sessionId) return;
  if (params.accountLifetime && !params.accountLifetime.isCurrent()) return;
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => {
    const previous = parseVoiceAgentRunMetadataV1(metadata?.voiceAgentRunV1 ?? null);
    const welcomedEpoch =
      typeof params.welcomedEpoch === 'number' && Number.isFinite(params.welcomedEpoch) && params.welcomedEpoch >= 0
        ? Math.floor(params.welcomedEpoch)
        : previous?.welcomedEpoch;
    const payload = buildVoiceAgentRunMetadataV1({
      runId: params.runId,
      backendTarget: params.backendTarget,
      resumeHandle: params.resumeHandle ?? null,
      updatedAtMs: params.updatedAtMs,
      ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
      previous,
    });
    return payload ? { ...metadata, voiceAgentRunV1: payload } : metadata;
  }, params.accountLifetime ? { serverId: params.accountLifetime.scope.serverId, accountLifetime: params.accountLifetime } : undefined);
}

async function clearVoiceAgentRunMetadata(sessionId: string | null, accountLifetime?: ServerAccountScopeLifetime): Promise<void> {
  if (!sessionId) return;
  if (accountLifetime && !accountLifetime.isCurrent()) return;
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata) => {
    const nextMetadata = { ...metadata };
    delete nextMetadata.voiceAgentRunV1;
    return nextMetadata;
  }, accountLifetime ? { serverId: accountLifetime.scope.serverId, accountLifetime } : undefined);
}

export function readVoiceAgentRunMetadataFromSession(params: Readonly<{ sessionId: string; serverId?: string }>): VoiceAgentRunMetadataV1 | null {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  return readVoiceAgentRunMetadata(sessionId, params.serverId);
}

export async function writeVoiceAgentRunMetadataToSession(
  params: Readonly<{
    sessionId: string;
    runId: string;
    backendTarget: BackendTargetRefV1;
    resumeHandle: ExecutionRunResumeHandle | null;
    updatedAtMs: number;
    welcomedEpoch?: number;
    accountLifetime?: ServerAccountScopeLifetime;
  }>,
): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  await writeVoiceAgentRunMetadata(sessionId, params);
}

export async function clearVoiceAgentRunMetadataFromSession(
  params: Readonly<{ sessionId: string; accountLifetime?: ServerAccountScopeLifetime }>,
): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  await clearVoiceAgentRunMetadata(sessionId, params.accountLifetime);
}
