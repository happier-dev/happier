/** The privacy-minimized boundary projector for PostHog issue activity. */

import { normalizeTriageSingleLineV1 } from '@happier-dev/triage-protocol/v1';

import type { PosthogRawActivityRecord } from '../../api/types/activity.js';

/**
 * The provider's documented default REST page geometry. Every provider continuation
 * remains reachable, so this is a per-request geometry rather than a cumulative cap.
 */
export const POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT = 100;

/** The complete allowlisted activity content the source may hold or render. */
export type PosthogProjectedActivityRecord = Readonly<{
    id: string;
    activity: string;
    scope?: string;
    atMs?: number;
    actor?: string;
    isSystem: boolean;
    changedFields: readonly string[];
}>;

function projectActor(rawUser: Readonly<Record<string, unknown>> | null): string | null {
    if (rawUser === null) return null;
    const first = typeof rawUser['first_name'] === 'string' ? rawUser['first_name'] : '';
    const last = typeof rawUser['last_name'] === 'string' ? rawUser['last_name'] : '';
    const name = [first, last].filter((part) => part.trim().length > 0).join(' ');
    if (name.trim().length > 0) return normalizeTriageSingleLineV1(name);
    const email = typeof rawUser['email'] === 'string' ? rawUser['email'] : '';
    return email.trim().length > 0 ? normalizeTriageSingleLineV1(email) : null;
}

function projectChangedFields(
    rawDetail: Readonly<Record<string, unknown>> | null,
): readonly string[] {
    const changes = rawDetail === null ? null : rawDetail['changes'];
    if (!Array.isArray(changes)) return [];
    const fields: string[] = [];
    for (const change of changes) {
        if (typeof change !== 'object' || change === null || Array.isArray(change)) continue;
        const field = (change as Readonly<Record<string, unknown>>)['field'];
        if (typeof field !== 'string' || field.trim().length === 0) continue;
        const normalized = normalizeTriageSingleLineV1(field);
        if (normalized.length > 0) fields.push(normalized);
    }
    return fields;
}

/**
 * Keeps only activity semantics useful to a reader. Changed values, distinct ids, and
 * all other account/detail properties are dropped. Text uses the shared single-line
 * normalizer but is not cut to source-invented byte or field-count budgets.
 */
export function projectPosthogActivityRecords(
    rawRecords: readonly PosthogRawActivityRecord[],
): readonly PosthogProjectedActivityRecord[] {
    return rawRecords.map((raw) => {
        const scope = raw.scope === undefined ? null : normalizeTriageSingleLineV1(raw.scope);
        const actor = projectActor(raw.rawUser);
        return {
            id: normalizeTriageSingleLineV1(raw.id),
            activity: normalizeTriageSingleLineV1(raw.activity),
            ...(scope === null || scope.length === 0 ? {} : { scope }),
            ...(raw.createdAtMs === undefined ? {} : { atMs: raw.createdAtMs }),
            ...(actor === null || actor.length === 0 ? {} : { actor }),
            isSystem: raw.isSystem,
            changedFields: projectChangedFields(raw.rawDetail),
        };
    });
}
