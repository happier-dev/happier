/**
 * The sole encoder, decoder, validator and byte-measurer of the source-private
 * configured-instance token.
 *
 * The target persists this token opaquely and never parses it, so this module is the
 * only place that knows what its bytes mean. It deliberately carries no account ref and
 * no origin: the exact Connected Account binding is a separate member of the host
 * matching tuple, and the materialized connection is the only origin authority. A token
 * that could name an origin would become a second deployment authority that a
 * reconfiguration could silently disagree with.
 *
 * Byte measurement lives here for the same reason. `connect/configuration.ts` asks this
 * codec what a prospective environment set would cost before it changes a selection, so
 * capacity is discovered while the user is still choosing rather than when the public
 * administration Action rejects a save.
 */

import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import { utf8ByteLength } from './map/bounds.js';
import type { PosthogResolvedWindow } from './scan/request.js';

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * A user-approved window. `exact` freezes both ends; `relative` freezes only the
 * duration and is resolved against the clock once per requested pass, so a stored
 * configuration never silently ages into a different exact range.
 */
export type PosthogWindowPolicy =
    | Readonly<{ kind: 'exact'; from: string; to: string }>
    | Readonly<{ kind: 'relative'; durationMs: number }>;

export type PosthogConfiguredEnvironment = Readonly<{
    /** Team/environment id used in `/api/projects/{project_id}/` routes. */
    teamPathId: number;
    /** Team/environment UUID; the identity component of collision scope. */
    teamUuid: string;
    /** Provider parent project id when exposed. Never a route and never identity. */
    parentProjectId?: number;
    /** Presentation only. */
    displayName: string;
}>;

export type PosthogConfigurationToken = Readonly<{
    v: 1;
    organizationUuid: string;
    /** Non-empty; `teamUuid` unique. */
    environments: readonly PosthogConfiguredEnvironment[];
    scanWindowPolicy: PosthogWindowPolicy;
    detailWindowPolicy: PosthogWindowPolicy;
}>;

export type PosthogConfigurationRejection =
    | 'invalidOrganizationUuid'
    | 'noEnvironments'
    | 'invalidEnvironment'
    | 'duplicateEnvironment'
    | 'invalidWindowPolicy'
    | 'tokenTooLarge';

export type PosthogConfigurationEncoding =
    | Readonly<{ ok: true; token: string; utf8Bytes: number }>
    | Readonly<{ ok: false; reason: 'tokenTooLarge'; utf8Bytes: number }>
    | Readonly<{
        ok: false;
        reason: Exclude<PosthogConfigurationRejection, 'tokenTooLarge'>;
      }>;

/**
 * The draft window a discovery candidate proposes. It is a starting point for the
 * Settings form, never a durable configuration: only an explicit user-submitted
 * administration Action turns a draft into a configured instance.
 */
export const POSTHOG_DRAFT_WINDOW_POLICY: PosthogWindowPolicy = Object.freeze({
    kind: 'relative',
    durationMs: 30 * 24 * 60 * 60 * 1_000,
});

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isValidWindowPolicy(value: unknown): value is PosthogWindowPolicy {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const raw = value as Readonly<Record<string, unknown>>;
    if (raw['kind'] === 'exact') {
        return typeof raw['from'] === 'string'
            && typeof raw['to'] === 'string'
            && !Number.isNaN(Date.parse(raw['from']))
            && !Number.isNaN(Date.parse(raw['to']))
            && Object.keys(raw).length === 3;
    }
    if (raw['kind'] === 'relative') {
        const duration = raw['durationMs'];
        return typeof duration === 'number'
            && Number.isSafeInteger(duration)
            && duration > 0
            && Object.keys(raw).length === 2;
    }
    return false;
}

function readEnvironment(value: unknown): PosthogConfiguredEnvironment | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const raw = value as Readonly<Record<string, unknown>>;
    const teamPathId = raw['teamPathId'];
    const teamUuid = raw['teamUuid'];
    const displayName = raw['displayName'];
    const parentProjectId = raw['parentProjectId'];
    if (
        typeof teamPathId !== 'number'
        || !Number.isSafeInteger(teamPathId)
        || teamPathId <= 0
        || !isUuid(teamUuid)
        || typeof displayName !== 'string'
        || displayName.length === 0
    ) {
        return null;
    }
    if (parentProjectId !== undefined
        && (typeof parentProjectId !== 'number'
            || !Number.isSafeInteger(parentProjectId)
            || parentProjectId <= 0)) {
        return null;
    }
    return {
        teamPathId,
        teamUuid,
        ...(parentProjectId === undefined ? {} : { parentProjectId }),
        displayName,
    };
}

function validate(
    configuration: PosthogConfigurationToken,
): Exclude<PosthogConfigurationRejection, 'tokenTooLarge'> | null {
    if (!isUuid(configuration.organizationUuid)) {
        return 'invalidOrganizationUuid';
    }
    if (configuration.environments.length === 0) {
        return 'noEnvironments';
    }
    const seen = new Set<string>();
    for (const environment of configuration.environments) {
        if (readEnvironment(environment) === null) {
            return 'invalidEnvironment';
        }
        if (seen.has(environment.teamUuid)) {
            return 'duplicateEnvironment';
        }
        seen.add(environment.teamUuid);
    }
    if (!isValidWindowPolicy(configuration.scanWindowPolicy)
        || !isValidWindowPolicy(configuration.detailWindowPolicy)) {
        return 'invalidWindowPolicy';
    }
    return null;
}

/**
 * Encodes one prospective configuration and reports its exact UTF-8 cost.
 *
 * The measurement is UTF-8 rather than a character count or an environment count
 * because the published limit is a byte limit: a multi-byte display name costs more
 * than its length suggests, and an approximation would either reject valid selections
 * or discover the ceiling only after the Action was already invoked.
 */
export function encodePosthogConfiguration(
    configuration: PosthogConfigurationToken,
): PosthogConfigurationEncoding {
    if (configuration.v !== 1) {
        return { ok: false, reason: 'invalidWindowPolicy' };
    }
    const rejection = validate(configuration);
    if (rejection !== null) {
        return { ok: false, reason: rejection };
    }
    const token = JSON.stringify({
        v: 1,
        organizationUuid: configuration.organizationUuid,
        environments: configuration.environments.map((environment) => ({
            teamPathId: environment.teamPathId,
            teamUuid: environment.teamUuid,
            ...(environment.parentProjectId === undefined
                ? {}
                : { parentProjectId: environment.parentProjectId }),
            displayName: environment.displayName,
        })),
        scanWindowPolicy: configuration.scanWindowPolicy,
        detailWindowPolicy: configuration.detailWindowPolicy,
    });
    const utf8Bytes = utf8ByteLength(token);
    if (utf8Bytes > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
        return { ok: false, reason: 'tokenTooLarge', utf8Bytes };
    }
    return { ok: true, token, utf8Bytes };
}

/**
 * Decodes a token the target handed back. Every rejection returns `null`: a token this
 * codec did not mint, or one that no longer parses, cannot select an environment, and
 * guessing a partial meaning would route a read at an unintended provider scope.
 */
export function decodePosthogConfiguration(
    configuration: Readonly<{ v: 1; token: string }>,
): PosthogConfigurationToken | null {
    if (configuration.v !== 1) {
        return null;
    }
    if (utf8ByteLength(configuration.token) > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
        return null;
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(configuration.token);
    } catch {
        return null;
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        return null;
    }
    const raw = decoded as Readonly<Record<string, unknown>>;
    if (raw['v'] !== 1 || !isUuid(raw['organizationUuid'])) {
        return null;
    }
    const rawEnvironments = raw['environments'];
    if (!Array.isArray(rawEnvironments) || rawEnvironments.length === 0) {
        return null;
    }
    const environments: PosthogConfiguredEnvironment[] = [];
    const seen = new Set<string>();
    for (const rawEnvironment of rawEnvironments) {
        const environment = readEnvironment(rawEnvironment);
        if (environment === null || seen.has(environment.teamUuid)) {
            return null;
        }
        seen.add(environment.teamUuid);
        environments.push(environment);
    }
    const scanWindowPolicy = raw['scanWindowPolicy'];
    const detailWindowPolicy = raw['detailWindowPolicy'];
    if (!isValidWindowPolicy(scanWindowPolicy) || !isValidWindowPolicy(detailWindowPolicy)) {
        return null;
    }
    return {
        v: 1,
        organizationUuid: raw['organizationUuid'],
        environments,
        scanWindowPolicy,
        detailWindowPolicy,
    };
}

/**
 * Freezes a policy into the one exact provider window a pass will send.
 *
 * A relative policy is resolved once per requested pass and then reused for every page
 * of that pass. Re-resolving per page would move the window under an offset walk and
 * make the accepted pages describe different result sets.
 */
export function resolvePosthogWindowPolicy(
    policy: PosthogWindowPolicy,
    nowMs: number,
): PosthogResolvedWindow {
    if (policy.kind === 'exact') {
        return { from: policy.from, to: policy.to };
    }
    return {
        from: new Date(nowMs - policy.durationMs).toISOString(),
        to: new Date(nowMs).toISOString(),
    };
}
