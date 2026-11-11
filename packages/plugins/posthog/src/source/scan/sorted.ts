import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1 } from '@happier-dev/triage-protocol/v1';
import type { PosthogApiClient } from '../../api/client.js';
import type { PosthogFailure } from '../../api/errors.js';
import { parsePosthogIssueRow, type PosthogIssueRow } from '../../api/types/issues.js';
import type { PosthogApiOrigin } from '../../connect/origin.js';
import { buildPosthogEntryLocator } from '../identity.js';
import type { PosthogConfiguredEnvironment } from '../instance.js';
import { scanPosthogIssuePage, type PosthogIssueObservation } from './scan.js';
import { resolvePosthogNativeLimit, type PosthogResolvedWindow, type PosthogFieldSort } from './request.js';
type Lane = {
    teamUuid: string;
    offset: number;
    ended: boolean;
    rows: PosthogIssueRow[];
};
type Frontier = {
    v: 1;
    scope: string;
    limit: number;
    window: PosthogResolvedWindow;
    malformed: boolean;
    nonAdvancing: boolean;
    lanes: Lane[];
};
// Retain only the provider row fields consumed by the canonical parser/projector.
function wireRow(row: PosthogIssueRow) {
    return { id: row.id, name: row.name, description: row.description, status: row.nativeStatus,
        ...(row.firstSeenMs === undefined ? {} : { first_seen: new Date(row.firstSeenMs).toISOString() }),
        ...(row.lastSeenMs === undefined ? {} : { last_seen: new Date(row.lastSeenMs).toISOString() }),
        library: row.library, source: row.source, assignee: row.assignee, aggregations: row.aggregations };
}
function decode(token: string, scope: string, environments: readonly PosthogConfiguredEnvironment[]): Frontier | null {
    const raw = decodeTriagePagingTokenV1(token);
    if (raw === null || raw.v !== 1 || raw.scope !== scope || typeof raw.limit !== 'number' || !Number.isSafeInteger(raw.limit) || raw.limit <= 0
        || typeof raw.malformed !== 'boolean' || typeof raw.nonAdvancing !== 'boolean'
        || typeof raw.window !== 'object' || raw.window === null || !('from' in raw.window) || typeof raw.window.from !== 'string'
        || !('to' in raw.window) || (raw.window.to !== null && typeof raw.window.to !== 'string') || !Array.isArray(raw.lanes))
        return null;
    const lanes: Lane[] = [];
    for (const value of raw.lanes) {
        if (typeof value !== 'object' || value === null || typeof value.teamUuid !== 'string'
            || !environments.some((environment) => environment.teamUuid === value.teamUuid)
            || lanes.some((lane) => lane.teamUuid === value.teamUuid)
            || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0
            || typeof value.ended !== 'boolean' || !Array.isArray(value.rows))
            return null;
        const rows: PosthogIssueRow[] = [];
        for (const row of value.rows) {
            const parsed = parsePosthogIssueRow(row);
            if (parsed === null)
                return null;
            rows.push(parsed);
        }
        lanes.push({ teamUuid: value.teamUuid, offset: value.offset, ended: value.ended, rows });
    }
    if (lanes.length !== environments.length)
        return null;
    return { v: 1, scope, limit: raw.limit, window: { from: raw.window.from, to: raw.window.to }, malformed: raw.malformed, nonAdvancing: raw.nonAdvancing, lanes };
}
/** Native ordered streams are merged before the source returns a page. Only unshown rows travel in the existing continuation. */
export async function scanSortedPosthogPage(input: Readonly<{
    client: PosthogApiClient;
    origin: PosthogApiOrigin;
    environments: readonly PosthogConfiguredEnvironment[];
    sourceInstanceDigest: string;
    sort: PosthogFieldSort;
    page: Readonly<{
        kind: 'initial';
        limit: number;
    }> | Readonly<{
        kind: 'continuation';
        continuation: Readonly<{
            token: string;
        }>;
    }>;
    window: PosthogResolvedWindow;
    incomplete: boolean;
    signal: AbortSignal;
}>): Promise<Readonly<{
    ok: false;
    failure?: PosthogFailure;
}> | Readonly<{
    ok: true;
    observations: readonly Readonly<{
        observation: PosthogIssueObservation;
        environment: PosthogConfiguredEnvironment;
    }>[];
    token: string | null;
    open: boolean;
    malformed: boolean;
    nonAdvancing: boolean;
}>> {
    const scope = JSON.stringify([input.sourceInstanceDigest, input.sort.field, input.sort.direction]);
    const frontier = input.page.kind === 'initial'
        ? { v: 1 as const, scope, limit: input.page.limit, window: input.window, malformed: input.incomplete, nonAdvancing: false,
            lanes: input.environments.map((environment) => ({ teamUuid: environment.teamUuid, offset: 0, ended: false, rows: [] as PosthogIssueRow[] })) }
        : decode(input.page.continuation.token, scope, input.environments);
    if (frontier === null)
        return { ok: false };
    frontier.malformed ||= input.incomplete;
    const output: {
        observation: PosthogIssueObservation;
        environment: PosthogConfiguredEnvironment;
    }[] = [];
    const nativeLimit = resolvePosthogNativeLimit(frontier.limit);
    let remaining = frontier.limit;
    const queried = new Set<Lane>();
    const key = (row: PosthogIssueRow) => (input.sort.field === 'created' ? row.firstSeenMs : row.lastSeenMs);
    // Native APIs expose one ordering field; equal-key rows keep native order within a stream.
    const compare = (left: Lane, right: Lane) => {
        const a = key(left.rows[0]!);
        const b = key(right.rows[0]!);
        const primary = a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : (a - b) * (input.sort.direction === 'asc' ? 1 : -1);
        const leftId = left.teamUuid + '/' + left.rows[0]!.id;
        const rightId = right.teamUuid + '/' + right.rows[0]!.id;
        return primary || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
    };
    while (output.length < frontier.limit) {
        // Establish every open stream's head before selecting one. A hidden environment can contain the next global row.
        for (const lane of frontier.lanes) {
            while (!lane.ended && lane.rows.length === 0) {
                if (remaining < nativeLimit || queried.has(lane)) break;
                queried.add(lane);
                const environment = input.environments.find((entry) => entry.teamUuid === lane.teamUuid)!;
                const page = await scanPosthogIssuePage(input.client, { origin: input.origin, environment: { teamRouteId: environment.teamPathId, teamUuid: environment.teamUuid }, window: frontier.window, nativeLimit, offset: lane.offset, sort: input.sort }, { signal: input.signal });
                if (!page.ok)
                    return { ok: false, failure: page.failure };
                remaining = Math.max(0, remaining - page.rawRowCount);
                frontier.malformed ||= page.malformedRowCount > 0;
                lane.rows.push(...page.observations.map((observation) => observation.row));
                const advances = page.nextOffsetCandidate !== null && Number.isSafeInteger(page.nextOffsetCandidate) && page.nextOffsetCandidate > lane.offset;
                frontier.nonAdvancing ||= page.hasMore && !advances;
                lane.ended = !page.hasMore || !advances;
                if (advances)
                    lane.offset = page.nextOffsetCandidate!;
            }
        }
        // Unknown native heads must be established by a later page before any lower buffered row is returned.
        if (frontier.lanes.some((lane) => !lane.ended && lane.rows.length === 0)) break;
        const lane = frontier.lanes.filter((entry) => entry.rows.length > 0).reduce<Lane | null>((best, entry) => best === null || compare(entry, best) < 0 ? entry : best, null);
        if (lane === null)
            break;
        const row = lane.rows.shift()!;
        const locator = buildPosthogEntryLocator(input.origin, lane.teamUuid, row.id);
        if (!locator.ok)
            return { ok: false };
        output.push({ observation: { locator: locator.value, row }, environment: input.environments.find((entry) => entry.teamUuid === lane.teamUuid)! });
    }
    const open = frontier.lanes.some((lane) => !lane.ended || lane.rows.length > 0);
    const token = open ? encodeTriagePagingTokenV1({ ...frontier, lanes: frontier.lanes.map((lane) => ({ ...lane, rows: lane.rows.map(wireRow) })) }) : null;
    return { ok: true, observations: output, token, open, malformed: frontier.malformed, nonAdvancing: frontier.nonAdvancing };
}
