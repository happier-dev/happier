import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
  type TriageScanContinuationV1,
} from '@happier-dev/triage-protocol/v1';

import {
  AZURE_SCAN_STICKY_REASONS,
  type AzureInvolvementLaneId,
  type AzureLaneFrontier,
  type AzureScanFrontier,
  type AzureScanStickyReason,
} from './types.js';

/**
 * The strict versioned codec for this source's own scan continuation bytes.
 *
 * `CONTRACT.md` §3.2/§5.1: the token is source-private, lives only inside one in-memory scan
 * invocation, and is copied back by the target without being parsed or granted authority. It
 * therefore carries exactly the invocation-local frontier — page geometry, the provider-issued
 * project token, and the repository/lane offsets — and no credential, account ref, viewer
 * identity, delivered-id history, accumulated row array, or target timestamp.
 *
 * The bounded JSON envelope is the protocol's; the frontier record inside it and every
 * field check on the way back in stay here.
 */
const CONTINUATION_VERSION = 1;
const LANE_IDS: readonly AzureInvolvementLaneId[] = ['authored', 'reviewer'];

export function encodeAzureScanContinuation(
  frontier: AzureScanFrontier,
): TriageScanContinuationV1 | null {
  const token = encodeTriagePagingTokenV1({
    v: CONTINUATION_VERSION,
    scanLimit: frontier.scanLimit,
    nativePageSize: frontier.nativePageSize,
    projectId: frontier.projectId,
    projectNextToken: frontier.projectNextToken,
    lastCompletedRepositoryId: frontier.lastCompletedRepositoryId,
    currentRepositoryId: frontier.currentRepositoryId,
    nextLaneIndex: frontier.nextLaneIndex,
    lanes: frontier.lanes.map((lane) => ({
      laneId: lane.laneId,
      skip: lane.skip,
      ended: lane.ended,
    })),
    // §2.8b: the sticky reason set is the one walk-level fact the frontier carries. It holds
    // bounded reason names and never counts, so `omittedItemCount` stays a per-call number and
    // nothing double-counts a walk's omissions.
    walkHealth: [...frontier.walkHealth],
  });
  return token === null ? null : { v: 1, token };
}

/**
 * Decode a continuation the same source produced. Anything else — another version, an unknown
 * field, a negative offset, an unrecognized lane — is rejected, and the caller reports
 * `unsupportedContract` so the next attempt starts again at `page: 'initial'`.
 */
export function decodeAzureScanContinuation(
  continuation: TriageScanContinuationV1,
): AzureScanFrontier | null {
  const record = decodeTriagePagingTokenV1(continuation.token);
  if (record === null || record.v !== CONTINUATION_VERSION) return null;

  const scanLimit = readCount(record.scanLimit, 1);
  const nativePageSize = readCount(record.nativePageSize, 1);
  if (scanLimit === null || nativePageSize === null || nativePageSize > scanLimit) return null;

  const lanes = readLanes(record.lanes);
  if (lanes === null) return null;

  const walkHealth = readWalkHealth(record.walkHealth);
  if (walkHealth === null) return null;

  const nextLaneIndex = readCount(record.nextLaneIndex, 0);
  if (nextLaneIndex === null || nextLaneIndex >= lanes.length) return null;

  const projectId = readNullableString(record.projectId);
  const projectNextToken = readNullableString(record.projectNextToken);
  const lastCompletedRepositoryId = readNullableString(record.lastCompletedRepositoryId);
  const currentRepositoryId = readNullableString(record.currentRepositoryId);
  if (
    projectId === undefined
    || projectNextToken === undefined
    || lastCompletedRepositoryId === undefined
    || currentRepositoryId === undefined
  ) {
    return null;
  }
  // A repository frontier without its project is unroutable; refusing it is how a corrupted
  // token restarts the walk instead of silently addressing a different project.
  if (currentRepositoryId !== null && projectId === null) return null;

  return {
    scanLimit,
    nativePageSize,
    projectId,
    projectNextToken,
    lastCompletedRepositoryId,
    currentRepositoryId,
    nextLaneIndex,
    lanes,
    walkHealth,
    // The projection budget belongs to the page being built, never to the resumed token: the
    // target already bounds each page by the limit the continuation carries.
    observed: 0,
  };
}

/**
 * A sticky reason this version does not recognize is a token this source did not mint at this
 * version (§2.8b): the walk restarts rather than silently dropping a caveat it cannot read.
 */
function readWalkHealth(raw: unknown): readonly AzureScanStickyReason[] | null {
  if (!Array.isArray(raw)) return null;
  const reasons: AzureScanStickyReason[] = [];
  for (const entry of raw) {
    const reason = AZURE_SCAN_STICKY_REASONS.find((candidate) => candidate === entry);
    if (reason === undefined || reasons.includes(reason)) return null;
    reasons.push(reason);
  }
  return reasons;
}

function readLanes(raw: unknown): readonly AzureLaneFrontier[] | null {
  if (!Array.isArray(raw) || raw.length !== LANE_IDS.length) return null;
  const lanes: AzureLaneFrontier[] = [];
  for (const [index, entry] of raw.entries()) {
    const record = readRecord(entry);
    if (record === null) return null;
    if (record.laneId !== LANE_IDS[index]) return null;
    const skip = readCount(record.skip, 0);
    if (skip === null || typeof record.ended !== 'boolean') return null;
    lanes.push({ laneId: LANE_IDS[index], skip, ended: record.ended });
  }
  return lanes;
}

function readRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Readonly<Record<string, unknown>>;
}

function readCount(raw: unknown, minimum: number): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum) return null;
  return raw;
}

/** `undefined` means invalid; `null` is the legitimate absent value. */
function readNullableString(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw;
}
