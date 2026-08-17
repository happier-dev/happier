/**
 * Source identity: what makes two PostHog issue observations the same entry.
 *
 * Collision scope is the normalized materialized Connected Account origin plus the
 * Team/environment UUID. Origin is deliberately part of identity because two
 * deployments can mint the same integer Team id and even the same issue UUID space;
 * organization UUID, account ref, Team route id, parent project id, and display names
 * are routing, configuration, or presentation facts and never participate.
 *
 * The numeric Team `id` exists only to build a provider route under PostHog's
 * backward-compatible `/api/projects/{project_id}/` spelling. The separately exposed
 * `project_id` is the parent project and is never substituted into either a route or an
 * identity.
 */

import type { PosthogApiOrigin } from '../connect/origin.js';

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type PosthogEntryLocator = Readonly<{
    collisionScope: string;
    entryId: string;
}>;

export type PosthogIdentityFailureReason =
    | 'invalidTeamUuid'
    | 'invalidIssueUuid';

export type PosthogIdentityResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; reason: PosthogIdentityFailureReason }>;

function normalizeUuid(value: string): string | null {
    const lowered = value.trim().toLowerCase();
    return UUID_PATTERN.test(lowered) ? lowered : null;
}

/**
 * Builds the collision scope for one selected environment. A missing, malformed, or
 * non-UUID Team UUID fails closed: the source never mints an origin-plus-integer
 * substitute, because a Team route id is not stable identity.
 */
export function buildPosthogCollisionScope(
    origin: PosthogApiOrigin,
    teamUuid: string,
): PosthogIdentityResult<string> {
    const normalized = normalizeUuid(teamUuid);
    if (normalized === null) {
        return { ok: false, reason: 'invalidTeamUuid' };
    }
    return { ok: true, value: `posthog:${origin as string}:${normalized}` };
}

export function buildPosthogEntryLocator(
    origin: PosthogApiOrigin,
    teamUuid: string,
    issueUuid: string,
): PosthogIdentityResult<PosthogEntryLocator> {
    const collisionScope = buildPosthogCollisionScope(origin, teamUuid);
    if (!collisionScope.ok) {
        return collisionScope;
    }
    const entryId = normalizeUuid(issueUuid);
    if (entryId === null) {
        return { ok: false, reason: 'invalidIssueUuid' };
    }
    return { ok: true, value: { collisionScope: collisionScope.value, entryId } };
}

export type PosthogParsedCollisionScope = Readonly<{
    origin: string;
    teamUuid: string;
}>;

/**
 * Recovers the origin and Team UUID a read must target. It is intentionally strict:
 * a scope this source did not mint cannot select an environment.
 */
export function parsePosthogCollisionScope(
    collisionScope: string,
): PosthogParsedCollisionScope | null {
    const withoutPrefix = collisionScope.startsWith('posthog:')
        ? collisionScope.slice('posthog:'.length)
        : null;
    if (withoutPrefix === null) {
        return null;
    }
    const separator = withoutPrefix.lastIndexOf(':');
    if (separator <= 0) {
        return null;
    }
    const origin = withoutPrefix.slice(0, separator);
    const teamUuid = normalizeUuid(withoutPrefix.slice(separator + 1));
    if (origin.length === 0 || teamUuid === null) {
        return null;
    }
    return { origin, teamUuid };
}

/**
 * The bounded local instance key for one binding/organization pair. It deliberately
 * omits the account ref, because the host matching tuple already carries that exact
 * binding separately.
 */
export function buildPosthogLocalInstanceKey(
    origin: PosthogApiOrigin,
    organizationUuid: string,
): PosthogIdentityResult<string> {
    const normalized = normalizeUuid(organizationUuid);
    if (normalized === null) {
        return { ok: false, reason: 'invalidTeamUuid' };
    }
    return { ok: true, value: `posthog-org:${origin as string}:${normalized}` };
}

export type PosthogParsedLocalInstanceKey = Readonly<{
    origin: string;
    organizationUuid: string;
}>;

/**
 * Recovers the deployment and organization a configured instance was created for.
 *
 * The origin recovered here is the one that was normalized from the materialized
 * connection when the instance was configured; it is a routing candidate, not a new
 * authority. Every request built from it still materializes the exact account, and the
 * host revalidates that the account currently owns that origin. A key this source did
 * not mint recovers nothing.
 */
export function parsePosthogLocalInstanceKey(
    localInstanceKey: string,
): PosthogParsedLocalInstanceKey | null {
    if (!localInstanceKey.startsWith('posthog-org:')) {
        return null;
    }
    const withoutPrefix = localInstanceKey.slice('posthog-org:'.length);
    const separator = withoutPrefix.lastIndexOf(':');
    if (separator <= 0) {
        return null;
    }
    const origin = withoutPrefix.slice(0, separator);
    const organizationUuid = normalizeUuid(withoutPrefix.slice(separator + 1));
    if (origin.length === 0 || organizationUuid === null) {
        return null;
    }
    return { origin, organizationUuid };
}
