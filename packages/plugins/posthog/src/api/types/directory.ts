/**
 * Strict parsers for the user-directed organization and Team/environment browsing used
 * by explicit configuration.
 *
 * These routes use the CRUD plane's DRF limit/offset paginator, whose `next` is an
 * absolute URL rather than an opaque cursor. This module parses that envelope; deciding
 * whether the URL may be followed belongs to the client's origin check, and deciding
 * whether it advances belongs to the caller.
 *
 * `ProjectBackwardCompatBasic` carries three distinct integers that are easy to
 * conflate. `id` is the Team/environment route id used in `/api/projects/{project_id}/`
 * routes, `uuid` is that Team's stable identity, and `project_id` is the parent project
 * it belongs to. The parser keeps all three separate and never substitutes one for
 * another; the ingest `api_token` is deliberately dropped.
 */

import {
    readArray,
    readNullableString,
    readObject,
    readSafeInteger,
    readString,
} from './primitives.js';

export type PosthogOrganizationRow = Readonly<{
    organizationUuid: string;
    name: string;
    slug: string;
}>;

export type PosthogEnvironmentRow = Readonly<{
    /** Team/environment id — the value that goes into an Error Tracking route. */
    teamRouteId: number;
    /** Team/environment UUID — the identity component of the source collision scope. */
    teamUuid: string;
    organizationUuid: string;
    /** Parent project id where the provider exposes it. Never routing, never identity. */
    parentProjectId?: number;
    displayName: string;
}>;

/** The DRF limit/offset envelope shared by both directory routes. */
export type PosthogPaginatedEnvelope = Readonly<{
    count: number | null;
    next: string | null;
    /**
     * The provider sent a `next` that is neither a URL string nor DRF's `null`.
     *
     * `next` is the ONLY field that says whether more pages exist, so folding an
     * unreadable one into `null` is the single reading that must never happen: it turns
     * *this parser does not know* into *this is the last page*, and the caller then
     * reports finished discovery over a walk the provider was still offering pages for.
     * The rows on the same page stay published — a malformed pagination field is not a
     * reason to discard rows this parser read perfectly well.
     */
    nextUnreadable: boolean;
    rawResults: readonly unknown[];
}>;

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function readUuid(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const lowered = value.trim().toLowerCase();
    return UUID_PATTERN.test(lowered) ? lowered : null;
}

export function parsePosthogPaginatedEnvelope(value: unknown): PosthogPaginatedEnvelope | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const rawResults = readArray(raw['results']);
    if (rawResults === null) {
        return null;
    }
    const count = readSafeInteger(raw['count']);
    const rawNext = raw['next'];
    const next = readNullableString(rawNext);
    return {
        count,
        next,
        nextUnreadable: next === null && rawNext !== null && rawNext !== undefined,
        rawResults,
    };
}

export function parsePosthogOrganizationRow(value: unknown): PosthogOrganizationRow | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const organizationUuid = readUuid(raw['id']);
    const name = readString(raw['name']);
    const slug = readString(raw['slug']);
    if (organizationUuid === null || name === null || slug === null) {
        return null;
    }
    return { organizationUuid, name, slug };
}

export function parsePosthogEnvironmentRow(value: unknown): PosthogEnvironmentRow | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const teamRouteId = readSafeInteger(raw['id']);
    const teamUuid = readUuid(raw['uuid']);
    const organizationUuid = readUuid(raw['organization']);
    const displayName = readString(raw['name']);
    if (
        teamRouteId === null
        || teamRouteId <= 0
        || teamUuid === null
        || organizationUuid === null
        || displayName === null
    ) {
        return null;
    }
    const parentProjectId = readSafeInteger(raw['project_id']);
    return {
        teamRouteId,
        teamUuid,
        organizationUuid,
        ...(parentProjectId === null || parentProjectId <= 0 ? {} : { parentProjectId }),
        displayName,
    };
}

export type PosthogDirectoryPage<T> = Readonly<{
    rows: readonly T[];
    /** Count of rows the provider returned that could not be parsed independently. */
    skippedRowCount: number;
    count: number | null;
    next: string | null;
    /** See `PosthogPaginatedEnvelope.nextUnreadable`. */
    nextUnreadable: boolean;
}>;

/**
 * Parses one directory page tolerantly: an unreadable row is counted and reported as
 * partial discovery while every valid row on the same page remains selectable.
 */
export function parsePosthogDirectoryPage<T>(
    body: unknown,
    parseRow: (value: unknown) => T | null,
): PosthogDirectoryPage<T> | null {
    const envelope = parsePosthogPaginatedEnvelope(body);
    if (envelope === null) {
        return null;
    }
    const rows: T[] = [];
    let skippedRowCount = 0;
    for (const rawRow of envelope.rawResults) {
        const row = parseRow(rawRow);
        if (row === null) {
            skippedRowCount += 1;
            continue;
        }
        rows.push(row);
    }
    return {
        rows,
        skippedRowCount,
        count: envelope.count,
        next: envelope.next,
        nextUnreadable: envelope.nextUnreadable,
    };
}
