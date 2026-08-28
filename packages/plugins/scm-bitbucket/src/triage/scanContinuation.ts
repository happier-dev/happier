import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
  type TriageScanContinuationV1,
} from '@happier-dev/triage-protocol/v1';

import { readBitbucketApiUrl } from './apiUrl.js';
import { readBitbucketBracedUuid } from './identity.js';
import {
  readCursorCycleProbeV1,
  type CursorCycleProbeV1,
} from '@happier-dev/triage-sources/runtime';

/**
 * The strict versioned codec for this source's own scan continuation bytes.
 *
 * The token is source-private: it exists only inside one in-memory scan invocation, and the target
 * copies it back without parsing it or granting it authority. Cancellation, a deadline, a `failed`
 * result, currentness loss, process death, or any other interruption discards it and the next
 * attempt starts again at `page: 'initial'`. It is never persisted, never handed to another
 * machine, account or configured instance, and never promoted into a checkpoint, watermark, epoch,
 * lease or scheduled resume point.
 *
 * What it carries is the invocation-local frontier and nothing else: fixed page geometry, the
 * rotation position, the walk's sticky health, the workspace-wide `authored` lane, the repository
 * enumeration cursor, and the lanes of the one repository currently being walked. It carries no
 * credential, no account ref, no viewer identity, no origin, no delivered-id history, no
 * accumulated row array, and no target timestamp.
 *
 * The bounded JSON envelope is the protocol's; the frontier record inside it and every
 * field check on the way back in stay here.
 */
const CONTINUATION_VERSION = 1;

/**
 * The walk-level facts that outlive one call.
 *
 * Splitting a walk across calls splits its health with it: a fact observed on page one has to still
 * be true of the walk on the page that settles it, or a truncated walk reports a finished one. The
 * set is closed to the reasons this forge can actually observe, and an unrecognized member on the
 * way back in is a token this source did not mint at this version rather than a dropped caveat.
 *
 * `projection-budget` and `continuation-unavailable` are deliberately absent: the first is a
 * per-call page-shape fact the continuation itself resolves, and the second ends the walk in the
 * same call it appears.
 *
 * The order is the evidence precedence a settling call reports, most decision-material first.
 * `review-evidence-unprojected` leads it because it is the one reason that changes what an
 * apparently clean review lane means: every other reason narrows a result the caller can still read
 * at face value, while this one says the lane could not see what it exists to report.
 */
export const BITBUCKET_WALK_HEALTH_REASONS = [
  'review-evidence-unprojected',
  'undecodable-items',
  'lane-unresolved',
  'lane-unavailable',
  'repository-enumeration-incomplete',
] as const;

export type BitbucketWalkHealthReason = (typeof BITBUCKET_WALK_HEALTH_REASONS)[number];

/**
 * The one repository-scoped walk this forge issues; the code is its single-character encoding.
 *
 * It is named for the route rather than for a lane because it serves both review lanes at once:
 * `review-requested` and `reviewed` are decided from the evidence its rows carry, not from which
 * request returned them.
 */
export const BITBUCKET_REPOSITORY_ROUTE_ID = 'repository-review';
const REPOSITORY_LANE_CODE = 'r';

export type BitbucketLaneFrontierRecord = Readonly<{
  /** A validated provider `next`, or `null` for a lane still sitting on the seed this source built. */
  nextUrl: string | null;
  ended: boolean;
  cycleProbe: CursorCycleProbeV1 | null;
}>;

export type BitbucketRepositoryLaneFrontierRecord = BitbucketLaneFrontierRecord & Readonly<{
  laneId: typeof BITBUCKET_REPOSITORY_ROUTE_ID;
}>;

/**
 * The encoded frontier.
 *
 * Its size is a function of this contract, not of the workspace inventory. Review involvement is
 * repository-scoped on this forge, so a frontier holding one entry per workspace repository would
 * grow with the account and exceed the published paging bound on exactly the large workspaces the
 * fairness rule exists to serve. Only the repository currently being walked keeps lane state; every
 * repository the enumeration has not entered yet is *pending*, costs the token nothing, and is
 * reached through `repositoryListNextUrl` in provider list order.
 *
 * | Key | Meaning |
 * |---|---|
 * | `v` | codec version |
 * | `l` | this walk's `scanLimit` |
 * | `n` | this walk's fixed `nativePageSize` |
 * | `i` | rotation position within the open lanes |
 * | `h` | the walk's sticky health reasons |
 * | `a` | the workspace-wide `authored` lane as `[providerNextUrl \| null, ended]` |
 * | `r` | the repository-listing cursor a later page continues from, or `null` |
 * | `c` | the repository being walked as `[uuid, [[laneCode, providerNextUrl \| null, ended]]]` |
 */
export type BitbucketScanFrontierRecord = Readonly<{
  scanLimit: number;
  nativePageSize: number;
  nextLaneIndex: number;
  walkHealth: readonly BitbucketWalkHealthReason[];
  authored: BitbucketLaneFrontierRecord;
  repositoryListNextUrl: string | null;
  repositoryListCycleProbe: CursorCycleProbeV1 | null;
  currentRepository: Readonly<{
    repositoryUuid: string;
    lanes: readonly BitbucketRepositoryLaneFrontierRecord[];
  }> | null;
}>;

/**
 * The two planes this walk rotates over: the workspace-wide `authored` route, and the repository
 * review route. `nextLaneIndex` names one of them.
 *
 * It is a rotation POSITION, not an offset into whatever happens to be open. A plane can be
 * momentarily closed — the repository plane before its first repository is entered, the authored
 * lane once it has run out — and the position still correctly says whose turn is next; the walk's
 * own selector scans both planes and skips a closed one, so a stale position can never make it
 * miss work. Validating the position against the open count instead refused exactly the tokens
 * that keep the two planes alternating, which is how the `authored` lane came to hold the
 * rotation for a whole walk.
 */
const BITBUCKET_WALK_PLANE_COUNT = 2;

export function encodeBitbucketScanContinuation(
  frontier: BitbucketScanFrontierRecord,
): TriageScanContinuationV1 | null {
  const token = encodeTriagePagingTokenV1({
    v: CONTINUATION_VERSION,
    l: frontier.scanLimit,
    n: frontier.nativePageSize,
    i: frontier.nextLaneIndex,
    h: [...frontier.walkHealth],
    a: [frontier.authored.nextUrl, frontier.authored.ended, frontier.authored.cycleProbe],
    r: frontier.repositoryListNextUrl === null
      ? null
      : [frontier.repositoryListNextUrl, frontier.repositoryListCycleProbe],
    c: frontier.currentRepository === null
      ? null
      : [
        frontier.currentRepository.repositoryUuid,
        frontier.currentRepository.lanes.map((lane) => (
          [REPOSITORY_LANE_CODE, lane.nextUrl, lane.ended, lane.cycleProbe]
        )),
      ],
  });
  return token === null ? null : { v: 1, token };
}

/**
 * Decodes a continuation this source produced in this process.
 *
 * Anything else — another version, an unknown lane code, an unrecognized health reason, a geometry
 * that disagrees with itself, a rotation position outside the open lane set, or a URL that is not a
 * Bitbucket API URL — is rejected, and the caller reports `unsupportedContract` so the next attempt
 * starts at `page: 'initial'` rather than guessing a frontier. A resumed URL is revalidated here
 * because a forge-supplied URL is never fetched on the strength of having been validated once
 * already.
 */
export function decodeBitbucketScanContinuation(
  continuation: TriageScanContinuationV1,
): BitbucketScanFrontierRecord | null {
  const record = decodeTriagePagingTokenV1(continuation.token);
  if (record === null || record.v !== CONTINUATION_VERSION) return null;

  const scanLimit = readCount(record.l, 1);
  const nativePageSize = readCount(record.n, 1);
  if (scanLimit === null || nativePageSize === null || nativePageSize > scanLimit) return null;

  const walkHealth = readWalkHealth(record.h);
  if (walkHealth === null) return null;

  const authored = readLane(record.a);
  if (authored === null) return null;

  const repositoryList = readRepositoryList(record.r);
  if (repositoryList === undefined) return null;

  const currentRepository = readCurrentRepository(record.c);
  if (currentRepository === undefined) return null;

  const nextLaneIndex = readCount(record.i, 0);
  if (nextLaneIndex === null || nextLaneIndex >= BITBUCKET_WALK_PLANE_COUNT) return null;

  const frontier: BitbucketScanFrontierRecord = {
    scanLimit,
    nativePageSize,
    nextLaneIndex,
    walkHealth,
    authored,
    repositoryListNextUrl: repositoryList.url,
    repositoryListCycleProbe: repositoryList.probe,
    currentRepository,
  };
  return frontier;
}

function readWalkHealth(raw: unknown): readonly BitbucketWalkHealthReason[] | null {
  if (!Array.isArray(raw)) return null;
  const reasons: BitbucketWalkHealthReason[] = [];
  for (const entry of raw) {
    const reason = BITBUCKET_WALK_HEALTH_REASONS.find((candidate) => candidate === entry);
    if (reason === undefined || reasons.includes(reason)) return null;
    reasons.push(reason);
  }
  return reasons;
}

function readLane(raw: unknown): BitbucketLaneFrontierRecord | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [nextUrl, ended, rawProbe] = raw as readonly unknown[];
  if (typeof ended !== 'boolean') return null;
  const url = readNullableApiUrl(nextUrl);
  if (url === undefined) return null;
  const cycleProbe = readProbe(rawProbe);
  if (cycleProbe === undefined) return null;
  if (url !== null && cycleProbe === null) return null;
  return { nextUrl: url, ended, cycleProbe };
}

/** `undefined` means invalid; `null` is the legitimate absent value. */
function readCurrentRepository(
  raw: unknown,
): BitbucketScanFrontierRecord['currentRepository'] | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [uuid, rawLanes] = raw as readonly unknown[];
  // A repository frontier without a routable repository is unroutable, and refusing it is how a
  // corrupted token restarts the walk instead of silently addressing a different repository.
  const repositoryUuid = readBitbucketBracedUuid(uuid);
  if (repositoryUuid === null) return undefined;
  if (!Array.isArray(rawLanes) || rawLanes.length === 0) return undefined;

  const lanes: BitbucketRepositoryLaneFrontierRecord[] = [];
  for (const entry of rawLanes) {
    if (!Array.isArray(entry) || entry.length !== 4) return undefined;
    const [code, nextUrl, ended, probe] = entry as readonly unknown[];
    if (code !== REPOSITORY_LANE_CODE) return undefined;
    const lane = readLane([nextUrl, ended, probe]);
    if (lane === null) return undefined;
    lanes.push({ laneId: BITBUCKET_REPOSITORY_ROUTE_ID, ...lane });
  }
  return { repositoryUuid, lanes };
}

function readRepositoryList(
  raw: unknown,
): Readonly<{ url: string | null; probe: CursorCycleProbeV1 | null }> | undefined {
  if (raw === null) return { url: null, probe: null };
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const url = readNullableApiUrl(raw[0]);
  if (url === undefined || url === null) return undefined;
  const probe = readProbe(raw[1]);
  if (probe === undefined || probe === null) return undefined;
  return { url, probe };
}

function readProbe(raw: unknown): CursorCycleProbeV1 | null | undefined {
  if (raw === null) return null;
  const probe = readCursorCycleProbeV1(raw);
  if (probe === null || readBitbucketApiUrl(probe.cursor) === null) return undefined;
  return probe;
}

function readCount(raw: unknown, minimum: number): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum) return null;
  return raw;
}

/** `undefined` means invalid; `null` is the legitimate absent value. */
function readNullableApiUrl(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  return readBitbucketApiUrl(raw) ?? undefined;
}
