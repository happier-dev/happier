/**
 * The strict versioned codec for this source's own scan continuation bytes.
 *
 * `CONTRACT.md` §3.2/§5.1: the token is source-private, lives only inside one
 * in-memory scan walk, and is copied back by the target without being parsed or
 * granted authority. It therefore carries exactly the invocation-local frontier —
 * the page geometry, the rotation cursor, and each lane's provider-issued next URL —
 * and no credential, account ref, viewer identity, delivered-id history, accumulated
 * row array, or target timestamp. Nothing here is persisted or checkpointed: a token
 * that is dropped costs one page and loses nothing.
 *
 * Every field is re-validated on decode against the lanes THIS invocation built and
 * the origin THIS invocation was authorized against. A token that names a different
 * lane set, a different rotation, or a URL on another host is refused whole rather
 * than partially adopted, and the caller restarts at `page: 'initial'`.
 *
 * The bounded JSON envelope is the protocol's; the frontier record inside it and every
 * field check on the way back in stay here.
 */

import { admitForgeRequestUrl } from '@happier-dev/triage-sources/runtime';
import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
  type TriageScanContinuationV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GITLAB_STICKY_WALK_REASONS,
  isGitlabStickyWalkReason,
  type GitlabLaneRequest,
  type GitlabStickyWalkReason,
} from '../mapping/gitlabInvolvement.js';
import type { GitlabConfiguredOrigin } from '../origin.js';
import type { GitlabLaneFrontier, GitlabScanFrontier } from './gitlabScanFrontier.js';

const CONTINUATION_VERSION = 1;

/**
 * A lane's identity in the token. A lane id alone is ambiguous — `authored` exists
 * for merge requests and for issues — so the kind travels with it and a token whose
 * lanes do not line up key-for-key with this invocation's is rejected.
 */
function laneKey(request: GitlabLaneRequest): string {
  return `${request.kindId}:${request.laneId}`;
}

export function encodeGitlabScanContinuation(
  frontier: GitlabScanFrontier,
): TriageScanContinuationV1 | null {
  const token = encodeTriagePagingTokenV1({
    v: CONTINUATION_VERSION,
    scanLimit: frontier.scanLimit,
    nativePageSize: frontier.nativePageSize,
    nextLaneIndex: frontier.nextLaneIndex,
    // Declaration order, not insertion order, so the same walk state always encodes to
    // the same bytes.
    walkHealth: GITLAB_STICKY_WALK_REASONS.filter((reason) => frontier.walkHealth.has(reason)),
    lanes: frontier.lanes.map((lane) => ({
      key: laneKey(lane.request),
      nextUrl: lane.nextUrl,
      ended: lane.ended,
    })),
  });
  return token === null ? null : { v: 1, token };
}

export type GitlabScanContinuationDecodeInput = Readonly<{
  continuation: TriageScanContinuationV1;
  /** The origin this invocation was authorized against; every URL is re-admitted to it. */
  origin: GitlabConfiguredOrigin;
  /** The lanes this invocation built, in the order it built them. */
  lanes: readonly GitlabLaneRequest[];
}>;

export function decodeGitlabScanContinuation(
  input: GitlabScanContinuationDecodeInput,
): GitlabScanFrontier | null {
  const record = decodeTriagePagingTokenV1(input.continuation.token);
  if (record === null || record.v !== CONTINUATION_VERSION) return null;

  const scanLimit = readCount(record.scanLimit, 1);
  const nativePageSize = readCount(record.nativePageSize, 1);
  if (scanLimit === null || nativePageSize === null || nativePageSize > scanLimit) return null;

  const lanes = readLanes(record.lanes, input);
  if (lanes === null) return null;

  const nextLaneIndex = readCount(record.nextLaneIndex, 0);
  if (nextLaneIndex === null || nextLaneIndex >= lanes.length) return null;

  const walkHealth = readWalkHealth(record.walkHealth);
  if (walkHealth === null) return null;

  return {
    scanLimit,
    nativePageSize,
    nextLaneIndex,
    walkHealth,
    lanes,
  };
}

/**
 * An unrecognized reason name is a token this source did not mint at this version, so
 * the walk restarts rather than silently dropping a caveat: a dropped reason is exactly
 * how a truncated walk comes back reporting `walkFinished`.
 */
function readWalkHealth(raw: unknown): Set<GitlabStickyWalkReason> | null {
  if (!Array.isArray(raw)) return null;
  const reasons = new Set<GitlabStickyWalkReason>();
  for (const entry of raw) {
    if (!isGitlabStickyWalkReason(entry)) return null;
    reasons.add(entry);
  }
  if (reasons.size !== raw.length) return null;
  return reasons;
}

function readLanes(
  raw: unknown,
  input: GitlabScanContinuationDecodeInput,
): GitlabLaneFrontier[] | null {
  if (!Array.isArray(raw) || raw.length !== input.lanes.length) return null;
  const lanes: GitlabLaneFrontier[] = [];
  for (const [index, entry] of raw.entries()) {
    const request = input.lanes[index];
    if (request === undefined) return null;
    const record = readRecord(entry);
    if (record === null || record.key !== laneKey(request)) return null;
    if (typeof record.ended !== 'boolean') return null;
    if (typeof record.nextUrl !== 'string') return null;
    // The URL is re-admitted against the configured origin exactly as a provider
    // `Link` header would be. A token is untrusted input: without this it could aim
    // the binding's credential at another host and answer the user's list from it.
    const nextUrl = admitForgeRequestUrl(record.nextUrl, input.origin.normalized);
    if (nextUrl === null) return null;
    lanes.push({ request, nextUrl, ended: record.ended });
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
