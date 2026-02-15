import type { ExecutionRunResumeHandle } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

export type VoiceAgentRunMetadataV1 = Readonly<{
  v: 1;
  runId: string;
  backendId: string;
  resumeHandle: ExecutionRunResumeHandle | null;
  updatedAtMs: number;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isVoiceAgentRunMetadataV1(value: unknown): value is VoiceAgentRunMetadataV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  if (v.v !== 1) return false;
  return (
    typeof v.runId === 'string'
    && v.runId.trim().length > 0
    && typeof v.backendId === 'string'
    && v.backendId.trim().length > 0
    && typeof v.updatedAtMs === 'number'
    && Number.isFinite(v.updatedAtMs)
  );
}

export function readVoiceAgentRunMetadataFromCarrierSession(params: Readonly<{ carrierSessionId: string }>): VoiceAgentRunMetadataV1 | null {
  const carrierSessionId = normalizeNonEmptyString(params.carrierSessionId);
  if (!carrierSessionId) return null;
  const session: any = storage.getState().sessions?.[carrierSessionId] ?? null;
  const meta = session?.metadata ?? null;
  const runMeta = meta?.voiceAgentRunV1 ?? null;
  return isVoiceAgentRunMetadataV1(runMeta) ? runMeta : null;
}

export async function writeVoiceAgentRunMetadataToCarrierSession(
  params: Readonly<{
    carrierSessionId: string;
    runId: string;
    backendId: string;
    resumeHandle: ExecutionRunResumeHandle | null;
    updatedAtMs: number;
  }>,
): Promise<void> {
  const carrierSessionId = normalizeNonEmptyString(params.carrierSessionId);
  const runId = normalizeNonEmptyString(params.runId);
  const backendId = normalizeNonEmptyString(params.backendId);
  const updatedAtMs =
    typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs) && params.updatedAtMs >= 0
      ? Math.floor(params.updatedAtMs)
      : Date.now();
  if (!carrierSessionId || !runId || !backendId) return;

  const payload: VoiceAgentRunMetadataV1 = {
    v: 1,
    runId,
    backendId,
    resumeHandle: params.resumeHandle ?? null,
    updatedAtMs,
  };

  await sync.patchSessionMetadataWithRetry(carrierSessionId, (metadata: any) => ({
    ...metadata,
    voiceAgentRunV1: payload,
  }));
}

export async function clearVoiceAgentRunMetadataFromCarrierSession(
  params: Readonly<{ carrierSessionId: string }>,
): Promise<void> {
  const carrierSessionId = normalizeNonEmptyString(params.carrierSessionId);
  if (!carrierSessionId) return;
  await sync.patchSessionMetadataWithRetry(carrierSessionId, (metadata: any) => ({
    ...metadata,
    voiceAgentRunV1: null,
  }));
}

