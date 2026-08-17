/**
 * The activity boundary projector.
 *
 * An activity record's `user` and `detail` bags are provider- and customer-shaped: the
 * user carries `distinct_id` and account metadata, and `detail.changes` carries the
 * before/after values of the change itself. This projector runs immediately after strict
 * envelope parsing and before any controller state, panel state, or published Action
 * result is constructed, and it is the only path by which an activity record's content
 * becomes usable.
 *
 * It is an allowlist, not a redaction pass. A reader of this plane needs to know what
 * happened, which fields it touched, who did it, and when — so those are the values it
 * copies, and the changed *values* are not among them. `distinct_id` and every other
 * account or detail property is dropped here rather than filtered later.
 *
 * It is also the one place that bounds an activity page for publication. The Action
 * aggregate rejects a result over one mebibyte outright, and a rejected page shows a
 * reader nothing at all, so a pathological but provider-valid record stays visible with
 * its content shortened and `truncated: true` set rather than being dropped.
 */

import {
    projectTriageDisplayTextV1,
    type TriageBoundedTextV1,
} from '@happier-dev/triage-protocol/v1';

import type { PosthogRawActivityRecord } from '../../api/types/activity.js';

/** The published bounds one activity page is projected against. */
export type PosthogActivityBounds = Readonly<{
    maxChangedFieldsPerRecord: number;
    identifierUtf8Bytes: number;
    activityUtf8Bytes: number;
    scopeUtf8Bytes: number;
    changedFieldUtf8Bytes: number;
    actorUtf8Bytes: number;
}>;

/**
 * The bounds a published PostHog activity page uses.
 *
 * They are derived from the one hard constraint that exists — the Action aggregate's
 * byte gate against a full page of saturated records — not from a guess about how long a
 * real field name or display name is.
 * `src/ui/detail/activityProjection.test.ts` saturates every one of them at once, at the
 * maximum page size below, and measures the encoded page against that gate.
 */
export const POSTHOG_ACTIVITY_BOUNDS_V1: PosthogActivityBounds = Object.freeze({
    maxChangedFieldsPerRecord: 8,
    identifierUtf8Bytes: 128,
    activityUtf8Bytes: 64,
    scopeUtf8Bytes: 64,
    changedFieldUtf8Bytes: 64,
    actorUtf8Bytes: 128,
});

/**
 * The page size one activity read asks for.
 *
 * The activity route is page-numbered rather than sampled, so the provider states no
 * ceiling of its own. This one is the source's: it is the largest page whose fully
 * saturated projection still clears the Action byte gate above, which is the only real
 * boundary this number protects.
 */
export const POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT = 100;

/** The complete set of activity content the source may hold or render. */
export type PosthogProjectedActivityRecord = Readonly<{
    id: string;
    /** The provider's own verb, for example `created` or `updated`. */
    activity: string;
    scope?: string;
    atMs?: number;
    /** A display label for the person who acted; absent for a system entry. */
    actor?: string;
    isSystem: boolean;
    /** Which fields the change touched. The changed values are never projected. */
    changedFields: readonly string[];
    /** Set only when this record's own content was shortened or count-bounded. */
    truncated?: true;
}>;

/**
 * Provider text becomes one bounded, single-line display value.
 *
 * The normalize-then-bound rule belongs to `@happier-dev/triage-protocol`, and an
 * activity record is as capable of carrying a newline as any other provider string: a
 * display name, a scope, or a changed field name is customer-shaped text. Restating the
 * rule here would be a second decision-maker for it.
 */
function bounded(value: string, maxUtf8Bytes: number): TriageBoundedTextV1 {
    return projectTriageDisplayTextV1(value, maxUtf8Bytes);
}

/**
 * Derives the acting person's display label.
 *
 * A name is preferred because it is what a triage reader recognizes. The account address
 * is used only when the account has no name at all, because otherwise the row would name
 * nobody; no other account property is read.
 */
function projectActor(
    rawUser: Readonly<Record<string, unknown>> | null,
    bounds: PosthogActivityBounds,
): TriageBoundedTextV1 | null {
    if (rawUser === null) {
        return null;
    }
    const first = typeof rawUser['first_name'] === 'string' ? rawUser['first_name'] : '';
    const last = typeof rawUser['last_name'] === 'string' ? rawUser['last_name'] : '';
    const name = [first, last].filter((part) => part.trim().length > 0).join(' ');
    if (name.trim().length > 0) {
        return bounded(name, bounds.actorUtf8Bytes);
    }
    const email = typeof rawUser['email'] === 'string' ? rawUser['email'] : '';
    return email.trim().length > 0 ? bounded(email, bounds.actorUtf8Bytes) : null;
}

function projectChangedFields(
    rawDetail: Readonly<Record<string, unknown>> | null,
    bounds: PosthogActivityBounds,
): Readonly<{ fields: readonly string[]; truncated: boolean }> {
    const changes = rawDetail === null ? null : rawDetail['changes'];
    if (!Array.isArray(changes)) {
        return { fields: [], truncated: false };
    }
    const fields: string[] = [];
    let truncated = changes.length > bounds.maxChangedFieldsPerRecord;
    for (const change of changes.slice(0, bounds.maxChangedFieldsPerRecord)) {
        if (typeof change !== 'object' || change === null || Array.isArray(change)) {
            continue;
        }
        const field = (change as Readonly<Record<string, unknown>>)['field'];
        if (typeof field !== 'string' || field.trim().length === 0) {
            continue;
        }
        const limited = bounded(field, bounds.changedFieldUtf8Bytes);
        truncated = truncated || limited.truncated;
        fields.push(limited.value);
    }
    return { fields, truncated };
}

export function projectPosthogActivityRecords(
    rawRecords: readonly PosthogRawActivityRecord[],
    bounds: PosthogActivityBounds,
): readonly PosthogProjectedActivityRecord[] {
    return rawRecords.map((raw) => {
        const id = bounded(raw.id, bounds.identifierUtf8Bytes);
        const activity = bounded(raw.activity, bounds.activityUtf8Bytes);
        const scope = raw.scope === undefined
            ? null
            : bounded(raw.scope, bounds.scopeUtf8Bytes);
        const actor = projectActor(raw.rawUser, bounds);
        const changed = projectChangedFields(raw.rawDetail, bounds);
        const truncated = id.truncated
            || activity.truncated
            || (scope?.truncated ?? false)
            || (actor?.truncated ?? false)
            || changed.truncated;

        return {
            id: id.value,
            activity: activity.value,
            ...(scope === null || scope.value.length === 0 ? {} : { scope: scope.value }),
            ...(raw.createdAtMs === undefined ? {} : { atMs: raw.createdAtMs }),
            ...(actor === null || actor.value.length === 0 ? {} : { actor: actor.value }),
            isSystem: raw.isSystem,
            changedFields: changed.fields,
            ...(truncated ? { truncated: true as const } : {}),
        };
    });
}
