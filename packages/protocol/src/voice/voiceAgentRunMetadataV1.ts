import { z } from 'zod';

import {
  BackendTargetRefSchema,
  type BackendTargetRefV1,
} from '../backends/targets/backendTargetRef.js';
import {
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
} from '../backends/targets/backendTargetRefV2.js';
import { ExecutionRunResumeHandleSchema, type ExecutionRunResumeHandle } from '../execution/runs/startRequest.js';
import { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION } from './voiceAgentRunMetadataContract.js';

/**
 * Canonical persisted `voiceAgentRunV1` session-metadata envelope.
 *
 * Owned by protocol so UI/CLI/server share one schema, validator, and merge logic.
 *
 * Write contract (what we persist): `v`, `runId`, `backendId` (load-bearing — required),
 * `backendTarget?`, `resumeHandle`, `updatedAtMs`, `transcriptContractVersion`, `welcomedEpoch?`.
 *
 * Legacy `streamId` is parsed tolerantly (accepted on input) but is never re-emitted.
 */
export type VoiceAgentRunMetadataV1 = Readonly<{
  v: 1;
  runId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  resumeHandle: ExecutionRunResumeHandle | null;
  updatedAtMs: number;
  transcriptContractVersion: number;
  welcomedEpoch?: number;
}>;

const NonNegativeIntSchema = z.number().int().nonnegative();

/**
 * Resume handle parsing stays tolerant: a structurally invalid handle must not
 * invalidate the whole record (it is a best-effort resume hint). Canonicalize
 * supported predecessor shapes and drop an invalid hint instead of exposing
 * unvalidated data as a typed execution-run handle.
 */
const TolerantResumeHandleSchema = z
  .unknown()
  .transform((value) => {
    if (value == null) return null;
    const parsed = ExecutionRunResumeHandleSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });

/**
 * Backend target parsing stays tolerant: an invalid stored target is dropped
 * (callers fall back to the load-bearing `backendId`) rather than invalidating
 * the whole record.
 */
const TolerantBackendTargetSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (value == null) return undefined;
    const parsed = BackendTargetRefSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });

/**
 * Tolerant parse schema. Accepts legacy/extra fields (including `streamId`) but only
 * surfaces canonical write fields. `streamId` is intentionally absent from the output.
 */
const VoiceAgentRunMetadataV1ParseSchema = z
  .object({
    v: z.literal(1),
    runId: z.string().trim().min(1),
    backendId: z.string().trim().min(1),
    backendTarget: TolerantBackendTargetSchema,
    resumeHandle: TolerantResumeHandleSchema,
    updatedAtMs: NonNegativeIntSchema,
    transcriptContractVersion: NonNegativeIntSchema.optional(),
    welcomedEpoch: NonNegativeIntSchema.optional(),
  })
  .passthrough();

function toCanonical(parsed: z.infer<typeof VoiceAgentRunMetadataV1ParseSchema>): VoiceAgentRunMetadataV1 {
  return {
    v: 1,
    runId: parsed.runId,
    backendId: parsed.backendId,
    ...(parsed.backendTarget ? { backendTarget: parsed.backendTarget } : {}),
    resumeHandle: parsed.resumeHandle ?? null,
    updatedAtMs: parsed.updatedAtMs,
    transcriptContractVersion: parsed.transcriptContractVersion ?? VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    ...(typeof parsed.welcomedEpoch === 'number' ? { welcomedEpoch: parsed.welcomedEpoch } : {}),
  };
}

/**
 * Parse an unknown value into canonical metadata, or return null when it is not a
 * valid `voiceAgentRunV1` envelope. Legacy `streamId` input is tolerated and dropped.
 */
export function parseVoiceAgentRunMetadataV1(value: unknown): VoiceAgentRunMetadataV1 | null {
  const result = VoiceAgentRunMetadataV1ParseSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  return toCanonical(result.data);
}

export function isVoiceAgentRunMetadataV1(value: unknown): value is VoiceAgentRunMetadataV1 {
  return parseVoiceAgentRunMetadataV1(value) !== null;
}

/** Concrete backend id carried by a backend target ref. */
export function resolveVoiceAgentRunBackendId(backendTarget: BackendTargetRefV1): string {
  return backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : backendTarget.backendId;
}

function backendTargetsMatch(a: BackendTargetRefV1, b: BackendTargetRefV1): boolean {
  try {
    return buildBackendTargetKeyV2(readBackendTargetRefV2(a)) === buildBackendTargetKeyV2(readBackendTargetRefV2(b));
  } catch {
    return false;
  }
}

export function doesVoiceAgentRunMetadataMatchBackendTarget(
  metadata: VoiceAgentRunMetadataV1 | null | undefined,
  backendTarget: BackendTargetRefV1,
): boolean {
  if (!metadata) return false;
  if (metadata.backendTarget) {
    return backendTargetsMatch(metadata.backendTarget, backendTarget);
  }
  return metadata.backendId === resolveVoiceAgentRunBackendId(backendTarget);
}

export type BuildVoiceAgentRunMetadataV1Params = Readonly<{
  runId: string;
  backendTarget: BackendTargetRefV1;
  resumeHandle: ExecutionRunResumeHandle | null;
  updatedAtMs: number;
  welcomedEpoch?: number;
}>;

/**
 * Build a canonical metadata envelope from a backend target. Derives `backendId`,
 * stamps the canonical transcript contract version, and never emits `streamId`.
 * Returns null when `runId` is empty.
 */
export function buildVoiceAgentRunMetadataV1(
  params: BuildVoiceAgentRunMetadataV1Params,
): VoiceAgentRunMetadataV1 | null {
  const runId = params.runId.trim();
  if (!runId) return null;
  const backendTargetParse = BackendTargetRefSchema.safeParse(params.backendTarget);
  const backendTarget = backendTargetParse.success ? backendTargetParse.data : null;
  if (!backendTarget) return null;
  const updatedAtMs =
    Number.isFinite(params.updatedAtMs) && params.updatedAtMs >= 0 ? Math.floor(params.updatedAtMs) : Date.now();
  const welcomedEpoch =
    typeof params.welcomedEpoch === 'number' && Number.isFinite(params.welcomedEpoch) && params.welcomedEpoch >= 0
      ? Math.floor(params.welcomedEpoch)
      : undefined;
  return {
    v: 1,
    runId,
    backendId: resolveVoiceAgentRunBackendId(backendTarget),
    backendTarget,
    resumeHandle: params.resumeHandle ?? null,
    updatedAtMs,
    transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
  };
}

/** Stable JSON comparison for structural metadata fields. */
function sameSerialized(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** True when two canonical envelopes carry equivalent persisted state. */
export function voiceAgentRunMetadataV1Equal(
  a: VoiceAgentRunMetadataV1,
  b: VoiceAgentRunMetadataV1,
): boolean {
  return (
    a.runId === b.runId
    && a.backendId === b.backendId
    && a.updatedAtMs === b.updatedAtMs
    && a.transcriptContractVersion === b.transcriptContractVersion
    && a.welcomedEpoch === b.welcomedEpoch
    && sameSerialized(a.backendTarget, b.backendTarget)
    && sameSerialized(a.resumeHandle, b.resumeHandle)
  );
}
