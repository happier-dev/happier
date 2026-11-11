import { BITBUCKET_NATIVE_SORT_FIELDS, type BitbucketFieldSort } from '../sort.js';
import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, TriageSourceScanObservationV1Schema, type TriageScanInputV1, type TriageScanResultV1, type TriageSourceScanObservationV1, } from '@happier-dev/triage-protocol/v1';
import { advanceCursorCycleWalkV1, readCursorCycleProbeV1, type CursorCycleProbeV1 } from '@happier-dev/triage-sources/runtime';
import type { BitbucketTriageApiClient } from '../apiClient.js';
import { matchesBitbucketCollectionRoute, readBitbucketApiUrl } from '../apiUrl.js';
import { decodeBitbucketPullRequestRow } from '../entries.js';
import { createBitbucketFailure, isBitbucketTerminatingScanFailure, type BitbucketTriageFailure } from '../failures.js';
import { readBitbucketBracedUuid } from '../identity.js';
import { BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH, decodeBitbucketPageEnvelope, resolveBitbucketNextPageUrl, resolveBitbucketPageGeometry, withBitbucketPageLength } from '../pagination.js';
import { BITBUCKET_TRIAGE_LANE_IDS, buildBitbucketAuthoredLaneUrl, buildBitbucketRepositoryReviewLaneUrl, readBitbucketLaneAvailability } from '../pullRequests.js';
import { createBitbucketRepositoryEnumerator } from '../repositoryFrontier.js';
import { BITBUCKET_WALK_HEALTH_REASONS, type BitbucketWalkHealthReason } from '../scanContinuation.js';
import { toTriageSourceFailure } from './failures.js';
import { toBitbucketPresentObservation } from './observations.js';
type Buffered = {
    key: number | null;
    observation: TriageSourceScanObservationV1;
};
type Lane = {
    repositoryUuid: string | null;
    url: string;
    ended: boolean;
    probe: CursorCycleProbeV1;
    rows: Buffered[];
};
type Frontier = {
    v: 1;
    scope: string;
    limit: number;
    health: BitbucketWalkHealthReason[];
    lanes: Lane[];
};
function sortedUrl(seed: string, sort: BitbucketFieldSort, nativePageSize: number): string {
    const url = new URL(withBitbucketPageLength(seed, nativePageSize));
    url.searchParams.set('sort', (sort.direction === 'desc' ? '-' : '') + BITBUCKET_NATIVE_SORT_FIELDS[sort.field]);
    return url.toString();
}
function decode(token: string, scope: string, seed: (repositoryUuid: string | null, limit: number) => string): Frontier | null {
    const raw = decodeTriagePagingTokenV1(token);
    if (raw === null || raw.v !== 1 || raw.scope !== scope || typeof raw.limit !== 'number' || !resolveBitbucketPageGeometry(raw.limit).ok
        || !Array.isArray(raw.health) || !Array.isArray(raw.lanes))
        return null;
    const health: BitbucketWalkHealthReason[] = [];
    for (const value of raw.health) {
        const reason = BITBUCKET_WALK_HEALTH_REASONS.find((candidate) => candidate === value);
        if (reason === undefined)
            return null;
        health.push(reason);
    }
    const lanes: Lane[] = [];
    for (const value of raw.lanes) {
        if (typeof value !== 'object' || value === null || typeof value.url !== 'string' || readBitbucketApiUrl(value.url) === null
            || typeof value.ended !== 'boolean' || !Array.isArray(value.rows))
            return null;
        const repositoryUuid = value.repositoryUuid === null ? null : readBitbucketBracedUuid(value.repositoryUuid);
        if ((value.repositoryUuid !== null && repositoryUuid === null) || lanes.some((lane) => lane.repositoryUuid === repositoryUuid))
            return null;
        const probe = readCursorCycleProbeV1(value.probe);
        const expected = seed(repositoryUuid, raw.limit);
        if (probe === null || !matchesBitbucketCollectionRoute(value.url, expected) || readBitbucketApiUrl(probe.cursor) === null || !matchesBitbucketCollectionRoute(probe.cursor, expected))
            return null;
        const rows: Buffered[] = [];
        for (const entry of value.rows) {
            if (typeof entry !== 'object' || entry === null || (entry.key !== null && (typeof entry.key !== 'number' || !Number.isFinite(entry.key))))
                return null;
            const parsed = TriageSourceScanObservationV1Schema.safeParse(entry.observation);
            if (!parsed.success || parsed.data.kind !== 'present')
                return null;
            rows.push({ key: entry.key, observation: parsed.data });
        }
        lanes.push({ repositoryUuid, url: value.url, ended: value.ended, probe, rows });
    }
    if (!lanes.some((lane) => lane.repositoryUuid === null))
        return null;
    return { v: 1, scope, limit: raw.limit, health, lanes };
}
/** Merge native sorted authored and repository streams, retaining each stream's unshown page in the source continuation. */
export async function scanSortedBitbucketSource(input: Readonly<{
    client: BitbucketTriageApiClient;
    scan: TriageScanInputV1;
    sort: BitbucketFieldSort;
    continuationScope: string;
    workspaceUuid: string;
    accountUuid: string;
    signal?: AbortSignal;
}>): Promise<TriageScanResultV1> {
    const failed = (failure: BitbucketTriageFailure): TriageScanResultV1 => ({ kind: 'failed', failure: toTriageSourceFailure(failure) });
    const invalid = () => failed(createBitbucketFailure('unsupportedContract', 'continuation-not-issued'));
    const scope = JSON.stringify([input.continuationScope, input.sort.field, input.sort.direction]);
    const seed = (repositoryUuid: string | null, limit: number) => sortedUrl(repositoryUuid === null
        ? buildBitbucketAuthoredLaneUrl({ workspaceUuid: input.workspaceUuid, accountUuid: input.accountUuid })
        : buildBitbucketRepositoryReviewLaneUrl({ workspaceUuid: input.workspaceUuid, repositoryUuid }), input.sort, Math.min(limit, BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH));
    let frontier: Frontier;
    if (input.scan.page.kind === 'initial') {
        const geometry = resolveBitbucketPageGeometry(input.scan.page.limit);
        if (!geometry.ok)
            return failed(geometry.failure);
        frontier = { v: 1, scope, limit: geometry.geometry.scanLimit, health: BITBUCKET_TRIAGE_LANE_IDS.some((laneId) => readBitbucketLaneAvailability(laneId).kind === 'unavailable') ? ['lane-unavailable'] : [], lanes: [] };
        const addLane = (repositoryUuid: string | null) => {
            if (frontier.lanes.some((lane) => lane.repositoryUuid === repositoryUuid))
                return;
            const url = seed(repositoryUuid, frontier.limit);
            const initialized = advanceCursorCycleWalkV1(null, url);
            if (initialized.kind !== 'advanced')
                throw new Error('an initial cursor cannot be revisited');
            frontier.lanes.push({ repositoryUuid, url, ended: false, probe: initialized.walk.probe, rows: [] });
        };
        addLane(null);
        // Repository-scoped review streams must all be discovered before the first global head is knowable.
        const repositories = createBitbucketRepositoryEnumerator({ client: input.client, workspaceUuid: input.workspaceUuid, resumeUrl: null, enteredRepositoryUuid: null, initial: true,
            ...(input.signal === undefined ? {} : { signal: input.signal }) });
        for (;;) {
            const next = await repositories.advance();
            if (next.kind === 'failed')
                return failed(next.failure);
            if (next.kind === 'repository') {
                addLane(next.repositoryUuid);
                continue;
            }
            if (next.kind === 'incomplete')
                frontier.health.push('repository-enumeration-incomplete');
            break;
        }
    }
    else {
        const decoded = decode(input.scan.page.continuation.token, scope, seed);
        if (decoded === null)
            return invalid();
        frontier = decoded;
    }
    const health = new Set(frontier.health);
    let remaining = frontier.limit;
    const queried = new Set<Lane>();
    const nativePageSize = Math.min(frontier.limit, BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH);
    const observations: TriageSourceScanObservationV1[] = [];
    // Native APIs expose one ordering field; equal-key rows keep native order within a stream.
    const compare = (left: Buffered, right: Buffered) => {
        const primary = left.key === right.key ? 0 : left.key === null ? 1 : right.key === null ? -1 : (left.key - right.key) * (input.sort.direction === 'asc' ? 1 : -1);
        const a = left.observation.localRef.collisionScope + '/' + left.observation.localRef.entryId;
        const b = right.observation.localRef.collisionScope + '/' + right.observation.localRef.entryId;
        return primary || (a < b ? -1 : a > b ? 1 : 0);
    };
    while (observations.length < frontier.limit) {
        for (const lane of frontier.lanes) {
            while (!lane.ended && lane.rows.length === 0) {
                if (remaining < nativePageSize || queried.has(lane)) break;
                queried.add(lane);
                const response = await input.client.requestJson({ url: lane.url, ...(input.signal === undefined ? {} : { signal: input.signal }) });
                if (!response.ok) {
                    if (isBitbucketTerminatingScanFailure(response.failure))
                        return failed(response.failure);
                    lane.ended = true;
                    health.add('lane-unresolved');
                    break;
                }
                const page = decodeBitbucketPageEnvelope(response.body);
                if (!page.ok) {
                    lane.ended = true;
                    health.add('lane-unresolved');
                    break;
                }
                // Native positions consume the existing scan allowance even when decoding or involvement filters omit them.
                remaining = Math.max(0, remaining - page.envelope.values.length);
                for (const raw of page.envelope.values) {
                    const decoded = decodeBitbucketPullRequestRow(raw);
                    if (!decoded.ok) {
                        health.add('undecodable-items');
                        continue;
                    }
                    const entry = decoded.entry;
                    if (lane.repositoryUuid !== null && entry.participants === null)
                        health.add('review-evidence-unprojected');
                    if (lane.repositoryUuid !== null && entry.reviewEvidenceIncomplete)
                        health.add('undecodable-items');
                    const observation = toBitbucketPresentObservation(entry, { viewerAccountUuid: input.accountUuid, ...(lane.repositoryUuid === null ? { laneInvolvement: 'author' as const } : {}) });
                    if (observation.viewer.involvement.length > 0)
                        lane.rows.push({ key: input.sort.field === 'created' ? entry.createdAtMs : entry.updatedAtMs, observation });
                    else if (entry.reviewEvidenceIncomplete)
                        health.add('undecodable-items');
                }
                const next = resolveBitbucketNextPageUrl(page.envelope);
                if (next.kind !== 'next') {
                    lane.ended = true;
                    if (next.kind === 'invalid')
                        health.add('lane-unresolved');
                    continue;
                }
                if (!matchesBitbucketCollectionRoute(next.url, seed(lane.repositoryUuid, frontier.limit))) {
                    lane.ended = true;
                    health.add('lane-unresolved');
                    continue;
                }
                const advanced = advanceCursorCycleWalkV1({ cursor: lane.url, probe: lane.probe }, next.url);
                if (advanced.kind !== 'advanced') {
                    lane.ended = true;
                    health.add('lane-unresolved');
                    continue;
                }
                lane.url = advanced.walk.cursor;
                lane.probe = advanced.walk.probe;
            }
        }
        // A stream without a known head can still precede every buffered row. Keep those rows for the next call.
        if (frontier.lanes.some((lane) => !lane.ended && lane.rows.length === 0)) break;
        const lane = frontier.lanes.filter((candidate) => candidate.rows.length > 0).reduce<Lane | null>((best, candidate) => best === null || compare(candidate.rows[0]!, best.rows[0]!) < 0 ? candidate : best, null);
        if (lane === null)
            break;
        observations.push(lane.rows.shift()!.observation);
    }
    const open = frontier.lanes.some((lane) => !lane.ended || lane.rows.length > 0);
    const token = open ? encodeTriagePagingTokenV1({ ...frontier, health: [...health] }) : null;
    const reason = open && token === null ? 'continuation-unavailable' : BITBUCKET_WALK_HEALTH_REASONS.find((candidate) => health.has(candidate));
    const evidence = reason !== undefined ? { kind: 'partial' as const, reason } : open ? { kind: 'partial' as const, reason: 'projection-budget' } : { kind: 'walkFinished' as const };
    return token === null ? { kind: 'complete', observations, evidence } : { kind: 'page', observations, evidence, continuation: { v: 1, token } };
}
