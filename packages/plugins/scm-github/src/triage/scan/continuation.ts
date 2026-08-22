import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
} from '@happier-dev/triage-protocol/v1';

import {
  readGithubScanStickyReason,
  type GithubScanStickyReasonV1,
} from '../types.js';

import { validateGithubSearchNextUrl } from './link.js';
import {
  githubScanMaxPagesPerLane,
  githubScanNativePageSize,
  readGithubScanWalkHealth,
  type GithubScanInvocationFrontierV1,
  type GithubScanLaneFrontierV1,
} from './frontier.js';
import { GITHUB_SCAN_LANE_ORDER_V1, type GithubScanLaneIdV1 } from './query.js';

/**
 * The strict versioned codec for this source's OWN scan continuation bytes.
 *
 * `CONTRACT.md` §5.1: the token is source-private, lives only inside one in-memory scan
 * invocation, and is copied back by the target without being parsed or granted authority.
 * It therefore carries exactly the invocation-local lane frontier — the page geometry, the
 * next round-robin lane, the walk's sticky health reason names, and each lane's validated
 * provider next URL — and no credential,
 * authorization header, account ref, viewer identity, delivered-id history, accumulated row
 * array, or target timestamp.
 *
 * It is emphatically not a durable checkpoint. Nothing reads it but this module, nothing
 * writes it but this module, and the walk it resumes claims no window, epoch, or
 * currentness: GitHub search sorts on a mutating `updated` field, so a resumed page is the
 * next page of a moving set, never a proof about what changed.
 *
 * The bounded JSON envelope is the protocol's (`encodeTriagePagingTokenV1` /
 * `decodeTriagePagingTokenV1`); what stays here is the frontier record inside it and
 * every field check that decides what this walk may resume from.
 *
 * The lane QUERY is deliberately absent from the token. It is rebuilt at decode from the
 * exact configured instance, and each stored next URL must revalidate against that rebuilt
 * query — so a token minted for one configured instance can never redirect a walk running
 * against another.
 */

const CONTINUATION_VERSION = 1;

type LaneRecord = Readonly<{
  laneId: GithubScanLaneIdV1;
  nextUrl: string | null;
  pagesConsumed: number;
  ended: boolean;
}>;

export type GithubScanResumeV1 = Readonly<{
  scanLimit: number;
  nextLaneIndex: number;
  walkHealth: readonly GithubScanStickyReasonV1[];
  lanes: readonly Readonly<{
    frontier: GithubScanLaneFrontierV1;
    pagesConsumed: number;
    ended: boolean;
  }>[];
}>;

/**
 * Projects the live frontier into its token. `null` means the walk cannot be resumed —
 * the caller then settles `complete` with `partial { continuation-unavailable }` rather
 * than presenting a truncated walk as a finished one.
 */
export function encodeGithubScanContinuation(
  frontier: GithubScanInvocationFrontierV1,
): string | null {
  const lanes: LaneRecord[] = frontier.lanes.map((lane) => ({
    laneId: lane.laneId,
    nextUrl: lane.frontier.kind === 'next' ? lane.frontier.nextUrl : null,
    pagesConsumed: lane.pagesConsumed,
    ended: lane.ended,
  }));
  return encodeTriagePagingTokenV1({
    v: CONTINUATION_VERSION,
    scanLimit: frontier.scanLimit,
    nativePageSize: frontier.nativePageSize,
    nextLaneIndex: frontier.nextLaneIndex,
    // Names only, in the one declared order, and never a count: a walk-level omission
    // total would double-count against the per-call `omittedItemCount` the target
    // checks against this page's own limit.
    walkHealth: readGithubScanWalkHealth(frontier),
    lanes,
  });
}

/**
 * Decodes a continuation this same source produced, against the exact configured
 * instance the resumed call names. Anything else — another version, an unknown field
 * shape, a geometry that does not derive from the bound limit, a reordered lane set, a
 * next URL that does not revalidate against the rebuilt lane query — is rejected, and the
 * caller reports `unsupportedContract` so the next attempt starts again at `initial`.
 */
export function decodeGithubScanContinuation(
  token: string,
  expected: Readonly<{
    buildLaneQuery: (laneId: GithubScanLaneIdV1) => string;
    /** The maximum page limit the published scan input admits. */
    maxScanLimit: number;
  }>,
): GithubScanResumeV1 | null {
  const record = decodeTriagePagingTokenV1(token);
  if (record === null || record.v !== CONTINUATION_VERSION) return null;

  const scanLimit = readCount(record.scanLimit, 1);
  if (scanLimit === null || scanLimit > expected.maxScanLimit) return null;
  // The geometry is DERIVED, never trusted: a token claiming a wider native page than the
  // bound limit allows would raise this walk's ceiling above the admitted page size.
  const nativePageSize = githubScanNativePageSize(scanLimit);
  if (record.nativePageSize !== nativePageSize) return null;
  const maxPagesPerLane = githubScanMaxPagesPerLane(nativePageSize);

  const nextLaneIndex = readCount(record.nextLaneIndex, 0);
  if (nextLaneIndex === null || nextLaneIndex >= GITHUB_SCAN_LANE_ORDER_V1.length) return null;

  const walkHealth = readWalkHealth(record.walkHealth);
  if (walkHealth === null) return null;

  const raw = record.lanes;
  if (!Array.isArray(raw) || raw.length !== GITHUB_SCAN_LANE_ORDER_V1.length) return null;

  const lanes: GithubScanResumeV1['lanes'][number][] = [];
  for (const [index, entry] of raw.entries()) {
    const laneId = GITHUB_SCAN_LANE_ORDER_V1[index];
    const lane = readRecord(entry);
    if (laneId === undefined || lane === null || lane.laneId !== laneId) return null;
    if (typeof lane.ended !== 'boolean') return null;
    const pagesConsumed = readCount(lane.pagesConsumed, 0);
    if (pagesConsumed === null || pagesConsumed > maxPagesPerLane) return null;
    // A lane already at GitHub's own per-query ceiling cannot be continued; a token that
    // claims it can would walk past the 1,000-result wall the ceiling exists to mark.
    if (!lane.ended && pagesConsumed >= maxPagesPerLane) return null;

    if (lane.nextUrl === null) {
      // No next URL and not ended means the lane never started. A lane that consumed
      // pages and has no next URL is a finished lane, and must say so.
      if (!lane.ended && pagesConsumed !== 0) return null;
      lanes.push({ frontier: { kind: 'initial' }, pagesConsumed, ended: lane.ended });
      continue;
    }
    if (typeof lane.nextUrl !== 'string') return null;
    const validated = validateGithubSearchNextUrl(lane.nextUrl, {
      laneQuery: expected.buildLaneQuery(laneId),
      perPage: nativePageSize,
    });
    if (validated === null) return null;
    lanes.push({
      frontier: { kind: 'next', nextUrl: validated.url },
      pagesConsumed,
      ended: lane.ended,
    });
  }

  // A continuation whose every lane has ended describes a walk that was already complete.
  // Honouring it would answer a page request with a settled walk's leftovers.
  if (lanes.every((lane) => lane.ended)) return null;

  return Object.freeze({
    scanLimit,
    nextLaneIndex,
    walkHealth,
    lanes: Object.freeze(lanes),
  });
}

/**
 * An unrecognized or repeated reason name is a token this source did not mint at this
 * version. Dropping it silently would erase a caveat the walk already established.
 */
function readWalkHealth(raw: unknown): readonly GithubScanStickyReasonV1[] | null {
  if (!Array.isArray(raw)) return null;
  const reasons: GithubScanStickyReasonV1[] = [];
  for (const entry of raw) {
    const reason = readGithubScanStickyReason(entry);
    if (reason === null || reasons.includes(reason)) return null;
    reasons.push(reason);
  }
  return Object.freeze(reasons);
}

function readRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Readonly<Record<string, unknown>>;
}

function readCount(raw: unknown, minimum: number): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum) return null;
  return raw;
}
