/**
 * Strict parser for PostHog's item-scoped issue activity page.
 *
 * The published OpenAPI document declares `200: No response body` for both activity
 * routes, so this envelope is read from PostHog's own current activity page response —
 * `results`, `next`, `previous`, `total_count` — rather than from the schema. Everything
 * this parser accepts is stated here explicitly for that reason: there is no generated
 * component to fall back on, so a provider change surfaces as a rejected body rather
 * than as a widened guess.
 *
 * An activity record's `user` and `detail` are open provider bags. `detail.changes`
 * carries the before/after values of the change itself, which is customer content this
 * source does not render. Like the sampled-event envelope, this parser therefore reads
 * only the envelope and the record's own scalars and hands both bags on untouched: the
 * boundary projector is the single module that decides what may leave the source.
 *
 * A record with no usable id cannot be keyed, deduplicated, or rendered, so it is
 * counted rather than dropped silently — a page that covered three provider rows must
 * not report that it covered two.
 */

import {
    readArray,
    readBoolean,
    readNullableString,
    readObject,
    readSafeInteger,
    readString,
    readTimestampMs,
} from './primitives.js';

/** One raw activity record, still carrying its unbounded provider bags. */
export type PosthogRawActivityRecord = Readonly<{
    id: string;
    activity: string;
    scope?: string;
    createdAtMs?: number;
    isSystem: boolean;
    rawUser: Readonly<Record<string, unknown>> | null;
    rawDetail: Readonly<Record<string, unknown>> | null;
}>;

export type PosthogIssueActivityEnvelope = Readonly<{
    rawRecords: readonly PosthogRawActivityRecord[];
    /** Provider rows this page returned but could not be read independently. */
    skippedRowCount: number;
    /** The provider's own absolute next-page URL, or `null` when this page is last. */
    next: string | null;
    /** The provider's stated total, or `null` when it stated none. */
    totalCount: number | null;
}>;

function parseRawRecord(value: unknown): PosthogRawActivityRecord | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const id = readString(raw['id']);
    const activity = readString(raw['activity']);
    if (id === null || id.trim().length === 0 || activity === null || activity.trim().length === 0) {
        return null;
    }
    const scope = readNullableString(raw['scope']);
    const createdAtMs = readTimestampMs(raw['created_at']);
    return {
        id: id.trim(),
        activity: activity.trim(),
        ...(scope === null || scope.trim().length === 0 ? {} : { scope: scope.trim() }),
        ...(createdAtMs === null ? {} : { createdAtMs }),
        isSystem: readBoolean(raw['is_system']) ?? false,
        rawUser: readObject(raw['user']),
        rawDetail: readObject(raw['detail']),
    };
}

export function parsePosthogIssueActivityEnvelope(
    value: unknown,
): PosthogIssueActivityEnvelope | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const results = readArray(raw['results']);
    if (results === null) {
        return null;
    }

    const nextRaw = raw['next'];
    if (nextRaw !== undefined && nextRaw !== null && typeof nextRaw !== 'string') {
        return null;
    }
    const totalRaw = raw['total_count'];
    const totalCount = readSafeInteger(totalRaw);
    if (totalRaw !== undefined && totalRaw !== null && (totalCount === null || totalCount < 0)) {
        return null;
    }

    const rawRecords: PosthogRawActivityRecord[] = [];
    let skippedRowCount = 0;
    for (const row of results) {
        const record = parseRawRecord(row);
        if (record === null) {
            skippedRowCount += 1;
            continue;
        }
        rawRecords.push(record);
    }

    return {
        rawRecords,
        skippedRowCount,
        next: typeof nextRaw === 'string' ? nextRaw : null,
        totalCount,
    };
}
