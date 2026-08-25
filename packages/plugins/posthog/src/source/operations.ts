/**
 * The three bound Triage source operations.
 *
 * This module is the binding layer and nothing more. Every provider decision it needs —
 * request construction, tolerant row decoding, identity, state and fact projection,
 * failure classification, the CRUD-first read — already has an owner elsewhere in this
 * package, and each operation composes those owners rather than re-deciding anything.
 * What it does own is the seam: turning the host's invocation context into the one
 * credential-reading client, recovering the exact configured scope from the values the
 * target hands back, and shaping the result into the published contract.
 *
 * It writes no configured state. Discovery returns non-durable candidates and never
 * creates, refreshes, retires, or reactivates a lifecycle row; only an explicit user
 * intent submitted through the target's public administration Action can do that.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    ConnectedAccountMetadataList,
    ConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
    admitForgeRequestUrl,
    materializeTriageSourceAuthorizationV1,
    readTriageSourceAccountListingV1,
    type TriageSourceAuthorizationOutcomeV1,
} from '@happier-dev/triage-sources/runtime';
import {
    MAX_TRIAGE_INSTANCE_DRAFTS_V1,
    MAX_TRIAGE_ROW_FACTS_V1,
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    projectTriageDisplayTextV1,
    TriageGetInputV1Schema,
    TriageListInstancesInputV1Schema,
    TriageScanInputV1Schema,
    type TriageGetResultV1,
    type TriageListInstancesResultV1,
    type TriageScanResultV1,
    type TriageSourceFailureV1,
    type TriageSourceInstanceDraftV1,
    type TriageSourceScanEvidenceV1,
    type TriageSourceScanObservationV1,
    decodeTriagePagingTokenV1,
    encodeTriagePagingTokenV1,
} from '@happier-dev/triage-protocol/v1';

import {
    MAX_POSTHOG_DIRECTORY_NEXT_URL_UTF8_BYTES_V1,
    MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1,
    PosthogConfigurationDirectoryInputV1Schema,
    type PosthogConfigurationDirectoryResultV1,
} from '../connect/configurationContract.js';
import {
    PosthogCapabilityProbeInputV1Schema,
    type PosthogCapabilityProbeResultV1,
} from '../connect/capabilityProbe.js';
import {
    createPosthogApiClient,
    type PosthogApiClient,
    type PosthogMaterializationOutcome,
    type PosthogTransportRequest,
} from '../api/client.js';
import type { PosthogFailure } from '../api/errors.js';
import { organizationProjectsPath, organizationsListPath } from '../api/paths.js';
import {
    parsePosthogDirectoryPage,
    parsePosthogEnvironmentRow,
    parsePosthogOrganizationRow,
    type PosthogEnvironmentRow,
} from '../api/types/directory.js';
import type { PosthogIssueRow } from '../api/types/issues.js';
import {
    normalizePosthogApiOrigin,
    selectPosthogApiOrigin,
    type PosthogApiOrigin,
} from '../connect/origin.js';
import { POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../posthogContracts.js';
import { POSTHOG_PLUGIN_ID } from '../posthogContracts.js';
import {
    POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1,
    PosthogSampledEventsInputV1Schema,
    decodePosthogSampledEventsContinuation,
    encodePosthogSampledEventsContinuation,
    type PosthogSampledEventsFrontier,
    type PosthogSampledEventsResultV1,
} from './detail/issueEventsContract.js';
import { readPosthogIssueActivity } from './detail/issueActivity.js';
import {
    POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1,
    PosthogIssueActivityInputV1Schema,
    decodePosthogIssueActivityContinuation,
    encodePosthogIssueActivityContinuation,
    type PosthogIssueActivityFrontier,
    type PosthogIssueActivityResultV1,
} from './detail/issueActivityContract.js';
import { readPosthogSampledIssueEvents } from './detail/issueEvents.js';
import { getPosthogIssue } from './get.js';
import {
    buildPosthogLocalInstanceKey,
    parsePosthogCollisionScope,
    parsePosthogLocalInstanceKey,
} from './identity.js';
import {
    POSTHOG_DRAFT_WINDOW_POLICY,
    decodePosthogConfiguration,
    encodePosthogConfiguration,
    resolvePosthogWindowPolicy,
    type PosthogConfigurationToken,
    type PosthogConfiguredEnvironment,
} from './instance.js';
import type { PosthogProjectionBounds } from './map/bounds.js';
import { POSTHOG_ENTRY_KIND, buildPosthogEntrySnapshot } from './map/entrySnapshot.js';
import { buildPosthogPresentObservation } from './map/observation.js';
import { resolvePosthogNativeLimit, type PosthogResolvedWindow } from './scan/request.js';
import { scanPosthogIssuePage } from './scan/scan.js';

/** Stable source-local failure ids. They name a condition, never provider text. */
export const POSTHOG_FAILURE_CODES = {
    originUnavailable: 'posthog/account-origin-unavailable',
    originAmbiguous: 'posthog/account-origin-ambiguous',
    originInvalid: 'posthog/account-origin-invalid',
    configurationUndecodable: 'posthog/configuration-undecodable',
    instanceKeyUnreadable: 'posthog/instance-key-unreadable',
    instanceScopeMismatch: 'posthog/instance-scope-mismatch',
    continuationUnreadable: 'posthog/scan-continuation-unreadable',
    continuationUnmintable: 'posthog/scan-continuation-unmintable',
    paginationNonAdvancing: 'posthog/pagination-non-advancing',
    walkInProgress: 'posthog/walk-in-progress',
    malformedRows: 'posthog/malformed-provider-rows',
    environmentNotConfigured: 'posthog/environment-not-configured',
    noSelectableEnvironment: 'posthog/no-selectable-environment',
    discoveryPageBounded: 'posthog/discovery-page-bounded',
    accountListTruncated: 'posthog/account-list-truncated',
    instanceCapReached: 'posthog/instance-cap-reached',
    entryIdMalformed: 'posthog/entry-id-malformed',
    responseUnreadable: 'posthog/response-unreadable',
    serverError: 'posthog/server-error',
    timedOut: 'posthog/request-timed-out',
    unexpectedStatus: 'posthog/unexpected-status',
    requestInvalid: 'posthog/request-invalid',
    transport: 'posthog/transport-failed',
    cancelled: 'posthog/cancelled',
    throttled: 'posthog/rate-limited',
    unauthorized: 'posthog/account-unauthorized',
    forbidden: 'posthog/permission-denied',
    notFound: 'posthog/not-found',
    redirected: 'posthog/unexpected-redirect',
} as const;

/**
 * The shared projection bounds. One fact slot is deliberately withheld from the native
 * fact budget so the detail-only severity fact can always be appended without pushing a
 * selected native fact past the published count bound.
 */
const PROJECTION_BOUNDS: PosthogProjectionBounds = Object.freeze({
    textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    factValueUtf8Bytes: MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
    maxFacts: MAX_TRIAGE_ROW_FACTS_V1 - 1,
});

const UNTITLED_ISSUE_LABEL = 'Untitled issue';

/** Statuses whose HTTP semantics forbid a body; a response must not carry one. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function sourceFailure(
    failureClass: TriageSourceFailureV1['class'],
    code: string,
): TriageSourceFailureV1 {
    return Object.freeze({ class: failureClass, code });
}

/**
 * Maps one classified provider failure onto the published closed classification.
 *
 * `retryNotBeforeMs` is carried only when the client actually derived it from provider
 * evidence; this module never invents a deadline, because a guessed reset would make the
 * aggregate defer a read the provider never asked it to defer.
 *
 * `unexpectedStatus` is the fall-through for `400`, `409`, `410` and `422` — statuses
 * PostHog's published Error Tracking contract gives no meaning to. It is `unknown`, not
 * `transient`: `transient` is the aggregate's claim that the identical request would
 * succeed on its own later, and it is what `composer/resolveForDispatch.ts` reports to
 * its caller as `retryable: true`. `unknown` is the honest answer and still paces the
 * retry, because `refresh/refreshEligibility.ts` backs the same three classes off.
 * GitHub, GitLab, Bitbucket and Sentry all settle their equivalent fall-through the same
 * way; PostHog was the one source that did not.
 *
 * The codes are four, not one. `response-unreadable` is true of a body that would not
 * parse and false of a readable `503`, a deadline that returned no body at all, and a
 * status this source simply cannot interpret — and `code`, not `class`, is the value a
 * reader keys on.
 */
export function toTriageSourceFailure(failure: PosthogFailure): TriageSourceFailureV1 {
    switch (failure.kind) {
        case 'unauthorized':
            return sourceFailure('authentication', POSTHOG_FAILURE_CODES.unauthorized);
        case 'forbidden':
            return sourceFailure('permission', POSTHOG_FAILURE_CODES.forbidden);
        case 'rateLimited':
            return Object.freeze({
                class: 'rateLimit' as const,
                code: POSTHOG_FAILURE_CODES.throttled,
                ...(failure.retryNotBeforeMs === undefined
                    ? {}
                    : { retryNotBeforeMs: failure.retryNotBeforeMs }),
            });
        case 'notFound':
            return sourceFailure('unknown', POSTHOG_FAILURE_CODES.notFound);
        case 'redirected':
            return sourceFailure('unsupportedContract', POSTHOG_FAILURE_CODES.redirected);
        case 'server':
            return sourceFailure('transient', POSTHOG_FAILURE_CODES.serverError);
        case 'timeout':
            return sourceFailure('transient', POSTHOG_FAILURE_CODES.timedOut);
        case 'unexpectedStatus':
            return sourceFailure('unknown', POSTHOG_FAILURE_CODES.unexpectedStatus);
        case 'transport':
            return sourceFailure('transient', POSTHOG_FAILURE_CODES.transport);
        case 'cancelled':
            return sourceFailure('transient', POSTHOG_FAILURE_CODES.cancelled);
        case 'malformedResponse':
            return sourceFailure('unsupportedContract', POSTHOG_FAILURE_CODES.responseUnreadable);
        case 'originMismatch':
            return sourceFailure('unsupportedContract', POSTHOG_FAILURE_CODES.originInvalid);
        case 'requestInvalid':
            return sourceFailure('unsupportedContract', POSTHOG_FAILURE_CODES.requestInvalid);
    }
}

/**
 * Projects the shared authorization owner's neutral reason into this source's own
 * request vocabulary.
 *
 * The three refusals are one condition for the reader — the account cannot authorize
 * this request — while a withdrawn materialization is the invocation ending, which the
 * client already keeps apart from a deadline. Wording the neutral reasons is exactly
 * what the shared owner leaves to each source.
 */
function toMaterializationOutcome(
    authorized: TriageSourceAuthorizationOutcomeV1,
): PosthogMaterializationOutcome {
    if (authorized.ok) {
        return { ok: true, authorization: authorized.authorization };
    }
    return authorized.reason === 'cancelled'
        ? { ok: false, failure: { kind: 'cancelled' } }
        : { ok: false, failure: { kind: 'unauthorized', status: 0 } };
}

/**
 * Builds the one client an invocation may use against one exact account and origin.
 *
 * The credential is materialized inside the request closure and reaches nothing but the
 * outbound authorization header. The host reauthorizes the declared purpose and
 * revalidates that this exact account still owns this origin around every
 * materialization, so a stale configured origin fails at the account boundary rather
 * than sending a bearer token somewhere the account never authorized.
 */
function createInvocationClient(
    context: PluginInvocationContext,
    account: ConnectedAccountRef,
    origin: PosthogApiOrigin,
): PosthogApiClient {
    return createPosthogApiClient({
        origin,
        materializeHeaders: async (request, options) => {
            // The admission rule — exact bound account, `httpHeaders`, a usable
            // `authorization`, and a withdrawn call that is a cancellation rather than a
            // refused account — is one owner for every first-party source. The local
            // version this replaced admitted an empty header bag from a materialization
            // of the wrong kind, so the read went out unauthenticated and came back as
            // the provider's `401` about an account that had never been refused.
            //
            // It receives the request's own composed boundary, not the aggregate
            // signal: a mounted-detail read has a private deadline, and a
            // materialization handed the caller's signal alone kept running against the
            // account after this source had already abandoned the request.
            const authorized = await materializeTriageSourceAuthorizationV1({
                connectedAccounts: context.services.connectedAccounts,
                purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
                account,
                origin: request.origin,
                signal: options.signal,
            });
            return toMaterializationOutcome(authorized);
        },
        transport: async (url: string, request: PosthogTransportRequest) => {
            const response = await context.services.http.request({
                url,
                method: request.method,
                headers: request.headers,
                redirect: request.redirect,
                ...(request.body === undefined
                    ? {}
                    : { body: new TextEncoder().encode(request.body) }),
            }, { signal: request.signal });
            if (!Number.isInteger(response.status)
                || response.status < 200
                || response.status > 599) {
                // A status outside the response range cannot be classified, so it is
                // surfaced as a transport failure rather than guessed into a meaning.
                throw new TypeError('PostHog response carried an uninterpretable status');
            }
            return new Response(
                NULL_BODY_STATUSES.has(response.status)
                    ? null
                    : new TextDecoder().decode(response.body),
                { status: response.status, headers: new Headers(response.headers) },
            );
        },
    });
}

type PosthogAccountBinding = Readonly<{ purpose: string; account: ConnectedAccountRef }>;

type PosthogInstanceFailure = Readonly<{
    binding: PosthogAccountBinding;
    localInstanceKey?: string;
    failure: TriageSourceFailureV1;
}>;

function compareAccounts(left: ConnectedAccountRef, right: ConnectedAccountRef): number {
    const leftKey = `${left.service.pluginId} ${left.service.localId} ${left.accountId}`;
    const rightKey = `${right.service.pluginId} ${right.service.localId} ${right.accountId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function originFailureCode(reason: string): string {
    if (reason === 'noOrigin') return POSTHOG_FAILURE_CODES.originUnavailable;
    if (reason === 'multipleOrigins') return POSTHOG_FAILURE_CODES.originAmbiguous;
    return POSTHOG_FAILURE_CODES.originInvalid;
}

function toConfiguredEnvironment(row: PosthogEnvironmentRow): PosthogConfiguredEnvironment {
    return {
        teamPathId: row.teamRouteId,
        teamUuid: row.teamUuid,
        ...(row.parentProjectId === undefined ? {} : { parentProjectId: row.parentProjectId }),
        displayName: row.displayName,
    };
}

function sameAccount(left: ConnectedAccountRef, right: ConnectedAccountRef): boolean {
    return left.accountId === right.accountId
        && left.service.pluginId === right.service.pluginId
        && left.service.localId === right.service.localId;
}

function readDirectoryOffset(url: URL): number | null {
    const raw = url.searchParams.get('offset');
    if (raw === null) return 0;
    if (!/^\d+$/.test(raw)) return null;
    const offset = Number(raw);
    return Number.isSafeInteger(offset) ? offset : null;
}

/** PostHog directory continuations are offset pages and must move that frontier forward. */
function isForwardDirectoryContinuation(requestedUrl: string, nextUrl: string): boolean {
    try {
        const requested = new URL(requestedUrl);
        const next = new URL(nextUrl);
        const requestedOffset = readDirectoryOffset(requested);
        const nextOffset = readDirectoryOffset(next);
        return requested.origin === next.origin
            && requested.pathname === next.pathname
            && requestedOffset !== null
            && nextOffset !== null
            && nextOffset > requestedOffset;
    } catch {
        return false;
    }
}

/** One source-owned deadline for independently mounted UI reads. */
export const POSTHOG_INTERACTIVE_READ_DEADLINE_MS = 20_000;

export type PosthogConfigurationDirectoryReader = (
    input: unknown,
    context: PluginInvocationContext,
) => Promise<PosthogConfigurationDirectoryResultV1>;

/** One explicitly requested page of the mounted PostHog configuration browser. */
export function createPosthogConfigurationDirectoryReader(
    privateDeadlineMs: number,
): PosthogConfigurationDirectoryReader {
  return async function readConfigurationDirectory(
    input: unknown,
    context: PluginInvocationContext,
  ): Promise<PosthogConfigurationDirectoryResultV1> {
    const parsed = PosthogConfigurationDirectoryInputV1Schema.parse(input);
    const unavailable = (failure: TriageSourceFailureV1): PosthogConfigurationDirectoryResultV1 => ({
        kind: 'unavailable',
        failure,
    });
    if (parsed.binding.purpose !== POSTHOG_CONNECTED_ACCOUNT_PURPOSE) {
        return unavailable(sourceFailure('unsupportedContract', POSTHOG_FAILURE_CODES.requestInvalid));
    }
    const accountListing = await readTriageSourceAccountListingV1({
        connectedAccounts: context.services.connectedAccounts,
        purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
        signal: context.signal,
    });
    if (accountListing.kind === 'failed') throw accountListing.error;
    if (accountListing.kind === 'unbound') {
        return unavailable(sourceFailure('authentication', POSTHOG_FAILURE_CODES.unauthorized));
    }
    const listed = accountListing.listing.accounts.find((entry) => (
        sameAccount(entry.account, parsed.binding.account)
    ));
    if (listed === undefined) {
        return unavailable(sourceFailure('authentication', POSTHOG_FAILURE_CODES.unauthorized));
    }
    const selected = selectPosthogApiOrigin(listed.connectedAccountOrigins);
    if (!selected.ok) {
        return unavailable(sourceFailure('unsupportedContract', originFailureCode(selected.reason)));
    }
    const { origin } = selected;
    const client = createInvocationClient(context, listed.account, origin);
    const readPage = async <T>(
        initialPath: string,
        parseRow: (value: unknown) => T | null,
    ) => {
        const initialUrl = new URL(initialPath, origin as string);
        initialUrl.searchParams.set('limit', String(MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1));
        const requestedUrl = parsed.page.kind === 'initial' ? initialUrl.toString() : parsed.page.next;
        const result = parsed.page.kind === 'initial'
            ? await client.requestJson(
                {
                    method: 'GET',
                    path: initialPath,
                    query: { limit: String(MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1) },
                },
                (body) => parsePosthogDirectoryPage(body, parseRow),
                { signal: context.signal, privateDeadlineMs },
            )
            : await client.followJson(
                parsed.page.next,
                (body) => parsePosthogDirectoryPage(body, parseRow),
                { signal: context.signal, privateDeadlineMs },
            );
        return { result, requestedUrl };
    };

    const pageState = <T>(
        page: Readonly<{
            next: string | null;
            nextUnreadable: boolean;
            skippedRowCount: number;
            rows: readonly T[];
        }>,
        requestedUrl: string,
    ) => {
        const admittedNext = page.next === null
            ? null
            : admitForgeRequestUrl(page.next, origin as string);
        const next = admittedNext !== null
            && isForwardDirectoryContinuation(requestedUrl, admittedNext)
            && new TextEncoder().encode(admittedNext).byteLength
                <= MAX_POSTHOG_DIRECTORY_NEXT_URL_UTF8_BYTES_V1
            ? admittedNext
            : null;
        return {
            next,
            incomplete: page.nextUnreadable
                || page.skippedRowCount > 0
                || (page.next !== null && next === null),
        };
    };

    if (parsed.kind === 'organizations') {
        const read = await readPage(organizationsListPath(), parsePosthogOrganizationRow);
        if (!read.result.ok) return unavailable(toTriageSourceFailure(read.result.failure));
        const page = read.result.value;
        const { next, incomplete } = pageState(page, read.requestedUrl);
        const rows = page.rows.flatMap((row) => {
            const key = buildPosthogLocalInstanceKey(origin, row.organizationUuid);
            const displayName = projectTriageDisplayTextV1(row.name, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
            return !key.ok || displayName.value.length === 0 ? [] : [{
                organizationUuid: row.organizationUuid,
                displayName: displayName.value,
                localInstanceKey: key.value,
            }];
        });
        return {
            kind: 'organizations',
            rows,
            ...(next === null ? {} : { next }),
            ...(incomplete || rows.length !== page.rows.length ? { incomplete: true as const } : {}),
        };
    }
    const read = await readPage(
        organizationProjectsPath(parsed.organizationUuid),
        parsePosthogEnvironmentRow,
    );
    if (!read.result.ok) return unavailable(toTriageSourceFailure(read.result.failure));
    const page = read.result.value;
    const { next, incomplete } = pageState(page, read.requestedUrl);
    const rows = page.rows.flatMap((row) => {
        if (row.organizationUuid !== parsed.organizationUuid) return [];
        const displayName = projectTriageDisplayTextV1(row.displayName, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
        return displayName.value.length === 0 ? [] : [{
            teamPathId: row.teamRouteId,
            teamUuid: row.teamUuid,
            ...(row.parentProjectId === undefined ? {} : { parentProjectId: row.parentProjectId }),
            displayName: displayName.value,
        }];
    });
    return {
        kind: 'environments',
        organizationUuid: parsed.organizationUuid,
        rows,
        ...(next === null ? {} : { next }),
        ...(incomplete || rows.length !== page.rows.length ? { incomplete: true as const } : {}),
    };
  };
}

export const readPosthogConfigurationDirectory: PosthogConfigurationDirectoryReader
    = createPosthogConfigurationDirectoryReader(POSTHOG_INTERACTIVE_READ_DEADLINE_MS);

/**
 * Automatic discovery of non-durable Settings candidates.
 *
 * It reads exactly one bounded page per provider route. Following `next` automatically
 * would be the background crawler this source does not have: paging beyond the first
 * page is a user-driven **Load more** in the configuration screen. A page that still has
 * a `next`, a row the parser could not read, or a truncated account listing therefore
 * makes the result `incomplete` — the honest statement that an instance may be
 * unrepresented — never a `complete` claim that the source cannot support.
 *
 * No arm of this operation writes a lifecycle row.
 */
export async function listPosthogInstances(
    input: unknown,
    context: PluginInvocationContext,
): Promise<TriageListInstancesResultV1> {
    TriageListInstancesInputV1Schema.parse(input);

    // A purpose with no selected account has an empty authorized set: the host
    // declines to list it, and calling that a PostHog failure would accuse a
    // provider this source never contacted while hiding the one thing the reader
    // can act on. Every other refusal keeps propagating exactly as before.
    const outcome = await readTriageSourceAccountListingV1({
        connectedAccounts: context.services.connectedAccounts,
        purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
        limit: MAX_TRIAGE_INSTANCE_DRAFTS_V1,
        signal: context.signal,
    });
    if (outcome.kind === 'failed') throw outcome.error;
    const listed: ConnectedAccountMetadataList = outcome.kind === 'unbound'
        ? { status: 'complete', accounts: [] }
        : outcome.listing;

    const candidates: TriageSourceInstanceDraftV1[] = [];
    const failures: PosthogInstanceFailure[] = [];
    let bounded = false;
    let capReached = false;

    const accounts = [...listed.accounts]
        .sort((left, right) => compareAccounts(left.account, right.account));

    for (const entry of accounts) {
        if (capReached) break;
        const binding: PosthogAccountBinding = Object.freeze({
            purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            account: entry.account,
        });
        const selected = selectPosthogApiOrigin(entry.connectedAccountOrigins);
        if (!selected.ok) {
            failures.push(Object.freeze({
                binding,
                failure: sourceFailure('unsupportedContract', originFailureCode(selected.reason)),
            }));
            continue;
        }
        const origin = selected.origin;
        const client = createInvocationClient(context, entry.account, origin);

        const organizations = await client.requestJson(
            { method: 'GET', path: organizationsListPath() },
            (body) => parsePosthogDirectoryPage(body, parsePosthogOrganizationRow),
            { signal: context.signal },
        );
        if (!organizations.ok) {
            failures.push(Object.freeze({
                binding,
                failure: toTriageSourceFailure(organizations.failure),
            }));
            continue;
        }
        if (
            organizations.value.next !== null
            || organizations.value.nextUnreadable
            || organizations.value.skippedRowCount > 0
        ) {
            bounded = true;
        }

        for (const organization of organizations.value.rows) {
            if (candidates.length >= MAX_TRIAGE_INSTANCE_DRAFTS_V1) {
                capReached = true;
                break;
            }
            const localInstanceKey = buildPosthogLocalInstanceKey(
                origin,
                organization.organizationUuid,
            );
            if (!localInstanceKey.ok) {
                failures.push(Object.freeze({
                    binding,
                    failure: sourceFailure(
                        'unsupportedContract',
                        POSTHOG_FAILURE_CODES.responseUnreadable,
                    ),
                }));
                continue;
            }

            const projects = await client.requestJson(
                { method: 'GET', path: organizationProjectsPath(organization.organizationUuid) },
                (body) => parsePosthogDirectoryPage(body, parsePosthogEnvironmentRow),
                { signal: context.signal },
            );
            if (!projects.ok) {
                failures.push(Object.freeze({
                    binding,
                    localInstanceKey: localInstanceKey.value,
                    failure: toTriageSourceFailure(projects.failure),
                }));
                continue;
            }
            if (
                projects.value.next !== null
                || projects.value.nextUnreadable
                || projects.value.skippedRowCount > 0
            ) {
                bounded = true;
            }

            // A Team row is only selectable under the organization it declares; the
            // source never re-parents a row it did not ask for.
            const environments = projects.value.rows
                .filter((row) => row.organizationUuid === organization.organizationUuid)
                .map(toConfiguredEnvironment);
            if (environments.length === 0) {
                failures.push(Object.freeze({
                    binding,
                    localInstanceKey: localInstanceKey.value,
                    failure: sourceFailure(
                        'unsupportedContract',
                        POSTHOG_FAILURE_CODES.noSelectableEnvironment,
                    ),
                }));
                continue;
            }

            const encoded = encodePosthogConfiguration({
                v: 1,
                organizationUuid: organization.organizationUuid,
                environments,
                scanWindowPolicy: POSTHOG_DRAFT_WINDOW_POLICY,
                detailWindowPolicy: POSTHOG_DRAFT_WINDOW_POLICY,
            });
            if (!encoded.ok) {
                failures.push(Object.freeze({
                    binding,
                    localInstanceKey: localInstanceKey.value,
                    failure: sourceFailure(
                        'unsupportedContract',
                        POSTHOG_FAILURE_CODES.configurationUndecodable,
                    ),
                }));
                continue;
            }

            candidates.push(Object.freeze({
                v: 1 as const,
                binding,
                localInstanceKey: localInstanceKey.value,
                // An origin change is explicit reconfiguration and a new identity, so
                // this key is locator-derived rather than immutable provider identity.
                keyStability: 'locatorDerived' as const,
                configuration: Object.freeze({ v: 1 as const, token: encoded.token }),
                locator: Object.freeze({ v: 1 as const, displayLabel: organization.name }),
            }) as TriageSourceInstanceDraftV1);
        }
    }

    const boundedFailures = Object.freeze(failures.slice(0, MAX_TRIAGE_INSTANCE_DRAFTS_V1));
    if (capReached) {
        return Object.freeze({
            kind: 'incomplete' as const,
            candidates: Object.freeze(candidates),
            failures: boundedFailures,
            failure: sourceFailure('unknown', POSTHOG_FAILURE_CODES.instanceCapReached),
        });
    }
    if (listed.status === 'truncated') {
        return Object.freeze({
            kind: 'incomplete' as const,
            candidates: Object.freeze(candidates),
            failures: boundedFailures,
            failure: sourceFailure('unknown', POSTHOG_FAILURE_CODES.accountListTruncated),
        });
    }
    if (bounded) {
        return Object.freeze({
            kind: 'incomplete' as const,
            candidates: Object.freeze(candidates),
            failures: boundedFailures,
            failure: sourceFailure('unknown', POSTHOG_FAILURE_CODES.discoveryPageBounded),
        });
    }
    return Object.freeze({
        kind: 'complete' as const,
        candidates: Object.freeze(candidates),
        failures: boundedFailures,
    });
}

/**
 * The invocation-local scan geometry.
 *
 * It exists only to carry one pass across the target's page requests: the frozen window,
 * the fixed native page size, and where the walk stands. It is never a watermark and
 * never a durable cursor — a pass that is interrupted keeps nothing, and the next
 * requested scan starts a new walk from the first environment at offset zero.
 */
type PosthogScanGeometry = Readonly<{
    v: 1;
    environmentIndex: number;
    offset: number;
    from: string;
    to: string | null;
    nativeLimit: number;
    /**
     * The caveats this walk has already established, carried across every page
     * of the same pass.
     *
     * A walk's pages are separate invocations, and this walk crosses
     * environments: environment one skipping malformed rows and environment two
     * running clean to its end settled the pass as `walkFinished`, so the
     * aggregate claimed exhaustion over a list that had silently dropped issues.
     * Names only — `omittedItemCount` belongs to the call that omitted the rows.
     */
    walkHealth: readonly PosthogScanStickyReasonV1[];
}>;

/**
 * The page facts that stay true of the whole walk, strongest first.
 *
 * Both are erasable by a later page and neither ends the walk: a non-advancing
 * offset moves to the next selected environment, and a skipped row leaves the
 * walk running. The reasons that DO end the walk are not here, because a page
 * that reports one is the last page and has nothing to be erased by.
 */
const POSTHOG_SCAN_STICKY_REASONS_V1 = Object.freeze([
    POSTHOG_FAILURE_CODES.malformedRows,
    POSTHOG_FAILURE_CODES.paginationNonAdvancing,
] as const);

type PosthogScanStickyReasonV1 = (typeof POSTHOG_SCAN_STICKY_REASONS_V1)[number];

/**
 * An unknown or repeated reason name is a token this source did not mint at this
 * version. Admitting it would erase a caveat the walk already established.
 */
function readScanWalkHealth(raw: unknown): readonly PosthogScanStickyReasonV1[] | null {
    if (!Array.isArray(raw)) return null;
    const reasons: PosthogScanStickyReasonV1[] = [];
    for (const entry of raw) {
        const reason = POSTHOG_SCAN_STICKY_REASONS_V1.find((candidate) => candidate === entry);
        if (reason === undefined || reasons.includes(reason)) return null;
        reasons.push(reason);
    }
    return Object.freeze(reasons);
}

function decodeScanGeometry(token: string, environmentCount: number): PosthogScanGeometry | null {
    // The bounded JSON envelope has one owner across every source; only the frontier
    // fields below are PostHog's, and they are still validated here.
    const raw = decodeTriagePagingTokenV1(token);
    if (raw === null) {
        return null;
    }
    const environmentIndex = raw['environmentIndex'];
    const offset = raw['offset'];
    const from = raw['from'];
    const to = raw['to'];
    const nativeLimit = raw['nativeLimit'];
    const walkHealth = readScanWalkHealth(raw['walkHealth']);
    if (
        walkHealth === null
        || raw['v'] !== 1
        || typeof environmentIndex !== 'number'
        || !Number.isSafeInteger(environmentIndex)
        || environmentIndex < 0
        || environmentIndex >= environmentCount
        || typeof offset !== 'number'
        || !Number.isSafeInteger(offset)
        || offset < 0
        || typeof from !== 'string'
        || (to !== null && typeof to !== 'string')
        || typeof nativeLimit !== 'number'
        || !Number.isSafeInteger(nativeLimit)
        || nativeLimit <= 0
    ) {
        return null;
    }
    return { v: 1, environmentIndex, offset, from, to, nativeLimit, walkHealth };
}

function scanWindow(geometry: PosthogScanGeometry): PosthogResolvedWindow {
    return { from: geometry.from, to: geometry.to };
}

/** One provider page of the requested bounded walk for one exact configured instance. */
export async function scanPosthogSource(
    input: unknown,
    context: PluginInvocationContext,
): Promise<TriageScanResultV1> {
    const parsed = TriageScanInputV1Schema.parse(input);
    const failed = (failure: TriageSourceFailureV1): TriageScanResultV1 => Object.freeze({
        kind: 'failed' as const,
        failure,
    });

    const routed = resolveInvokedInstance(parsed.instance);
    if (!routed.ok) return failed(routed.failure);
    const { origin, configuration } = routed;

    const geometry = parsed.page.kind === 'initial'
        ? ((): PosthogScanGeometry => {
            const window = resolvePosthogWindowPolicy(configuration.scanWindowPolicy, Date.now());
            return {
                v: 1,
                environmentIndex: 0,
                offset: 0,
                from: window.from,
                to: window.to,
                nativeLimit: resolvePosthogNativeLimit(parsed.page.limit),
                walkHealth: [],
            };
        })()
        : decodeScanGeometry(parsed.page.continuation.token, configuration.environments.length);
    if (geometry === null) {
        return failed(sourceFailure(
            'unsupportedContract',
            POSTHOG_FAILURE_CODES.continuationUnreadable,
        ));
    }

    const environment = configuration.environments[geometry.environmentIndex];
    if (environment === undefined) {
        return failed(sourceFailure(
            'unsupportedContract',
            POSTHOG_FAILURE_CODES.environmentNotConfigured,
        ));
    }

    const client = createInvocationClient(context, parsed.instance.binding.account, origin);
    const page = await scanPosthogIssuePage(
        client,
        {
            origin,
            environment: {
                teamRouteId: environment.teamPathId,
                teamUuid: environment.teamUuid,
            },
            window: scanWindow(geometry),
            nativeLimit: geometry.nativeLimit,
            offset: geometry.offset,
        },
        { signal: context.signal },
    );
    if (!page.ok) return failed(toTriageSourceFailure(page.failure));

    const observations: readonly TriageSourceScanObservationV1[] = Object.freeze(
        page.observations.map((observation) => buildPosthogPresentObservation({
            snapshot: buildPosthogEntrySnapshot({
                locator: observation.locator,
                row: observation.row,
                scope: {
                    displayName: environment.displayName,
                    teamRouteId: environment.teamPathId,
                },
                untitledLabel: UNTITLED_ISSUE_LABEL,
                bounds: PROJECTION_BOUNDS,
            }),
            ...(observation.row.lastSeenMs === undefined
                ? {}
                : { sourceUpdatedAtMs: observation.row.lastSeenMs }),
        })),
    );

    const nextOffset = page.hasMore ? page.nextOffsetCandidate : null;
    const advances = nextOffset !== null
        && Number.isSafeInteger(nextOffset)
        && nextOffset > geometry.offset;
    const nonAdvancing = page.hasMore && !advances;

    // This page's own erasable facts join the ones the walk arrived with, and the
    // union travels on. A stuck environment is exactly the case: the walk moves
    // to the next one and would otherwise report the pass as clean.
    const walkHealth = new Set<PosthogScanStickyReasonV1>(geometry.walkHealth);
    if (page.malformedRowCount > 0) walkHealth.add(POSTHOG_FAILURE_CODES.malformedRows);
    if (nonAdvancing) walkHealth.add(POSTHOG_FAILURE_CODES.paginationNonAdvancing);
    const carried: PosthogScanGeometry = { ...geometry, walkHealth: [...walkHealth] };

    const next: PosthogScanGeometry | null = advances && nextOffset !== null
        ? { ...carried, offset: nextOffset }
        : geometry.environmentIndex + 1 < configuration.environments.length
            // An exhausted or stuck environment moves to the next selected one at
            // offset zero inside the same frozen window.
            ? { ...carried, environmentIndex: geometry.environmentIndex + 1, offset: 0 }
            : null;

    // A token wider than the protocol admits is not a token: it is a member of a closed
    // result object, so emitting it would fail validation of the WHOLE page and discard
    // every row above. The walk therefore ends here and says why.
    const token = next === null ? null : encodeTriagePagingTokenV1(next);
    const evidence = resolvePageEvidence({
        malformedRowCount: page.malformedRowCount,
        nonAdvancing,
        unresumable: next !== null && token === null,
        finished: next === null,
        walkHealth,
    });

    if (token === null) {
        return Object.freeze({ kind: 'complete' as const, observations, evidence });
    }
    return Object.freeze({
        kind: 'page' as const,
        observations,
        evidence,
        continuation: Object.freeze({ v: 1 as const, token }),
    });
}

/**
 * Health for one accepted page.
 *
 * Only a walk that actually reached the provider-reported end of every selected
 * environment may claim `walkFinished`. A page still in flight, a skipped row, a
 * provider offset that refused to advance, or a next position too wide to travel in the
 * protocol's token is a known gap and says so; none of them is ever absence or proof
 * that the stored projection is complete.
 */
function resolvePageEvidence(input: Readonly<{
    malformedRowCount: number;
    nonAdvancing: boolean;
    unresumable: boolean;
    finished: boolean;
    /** This page's own erasable facts unioned with every earlier page's. */
    walkHealth: ReadonlySet<PosthogScanStickyReasonV1>;
}>): TriageSourceScanEvidenceV1 {
    if (input.malformedRowCount > 0) {
        return Object.freeze({
            kind: 'partial' as const,
            reason: POSTHOG_FAILURE_CODES.malformedRows,
            omittedItemCount: input.malformedRowCount,
        });
    }
    if (input.nonAdvancing) {
        return Object.freeze({
            kind: 'partial' as const,
            reason: POSTHOG_FAILURE_CODES.paginationNonAdvancing,
        });
    }
    if (input.unresumable) {
        return Object.freeze({
            kind: 'partial' as const,
            reason: POSTHOG_FAILURE_CODES.continuationUnmintable,
        });
    }
    // Nothing this page saw, but something an earlier one did. Only a walk that
    // arrives here with an empty set may finish clean.
    for (const reason of POSTHOG_SCAN_STICKY_REASONS_V1) {
        if (input.walkHealth.has(reason)) {
            return Object.freeze({ kind: 'partial' as const, reason });
        }
    }
    if (!input.finished) {
        return Object.freeze({
            kind: 'partial' as const,
            reason: POSTHOG_FAILURE_CODES.walkInProgress,
        });
    }
    return Object.freeze({ kind: 'walkFinished' as const });
}

type InvokedInstance =
    | Readonly<{
        ok: true;
        origin: PosthogApiOrigin;
        organizationUuid: string;
        configuration: PosthogConfigurationToken;
    }>
    | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/**
 * Recovers the exact scope one invocation may reach.
 *
 * The instance key supplies the deployment and organization the instance was configured
 * for and the opaque token supplies the selected environments and windows. Neither is
 * trusted as a credential authority: the account binding stays the host's, and the
 * origin is revalidated as a canonical HTTPS origin before it can route anything.
 */
function resolveInvokedInstance(
    instance: Readonly<{
        localInstanceKey: string;
        configuration: Readonly<{ v: 1; token: string }>;
    }>,
): InvokedInstance {
    const key = parsePosthogLocalInstanceKey(instance.localInstanceKey);
    if (key === null) {
        return Object.freeze({
            ok: false as const,
            failure: sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.instanceKeyUnreadable,
            ),
        });
    }
    const origin = normalizePosthogApiOrigin(key.origin);
    if (!origin.ok) {
        return Object.freeze({
            ok: false as const,
            failure: sourceFailure('unsupportedContract', POSTHOG_FAILURE_CODES.originInvalid),
        });
    }
    const configuration = decodePosthogConfiguration(instance.configuration);
    if (configuration === null) {
        return Object.freeze({
            ok: false as const,
            failure: sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.configurationUndecodable,
            ),
        });
    }
    if (configuration.organizationUuid !== key.organizationUuid) {
        return Object.freeze({
            ok: false as const,
            failure: sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.instanceScopeMismatch,
            ),
        });
    }
    return Object.freeze({
        ok: true as const,
        origin: origin.origin,
        organizationUuid: key.organizationUuid,
        configuration,
    });
}

/** One ephemeral authenticated Error Tracking read for the active Settings draft. */
export type PosthogCapabilityProbe = (
    input: unknown,
    context: PluginInvocationContext,
) => Promise<PosthogCapabilityProbeResultV1>;

export function createPosthogCapabilityProbe(
    privateDeadlineMs: number,
): PosthogCapabilityProbe {
  return async function probeCapability(
    input: unknown,
    context: PluginInvocationContext,
  ): Promise<PosthogCapabilityProbeResultV1> {
    const parsed = PosthogCapabilityProbeInputV1Schema.parse(input);
    const routed = resolveInvokedInstance(parsed.draft);
    if (!routed.ok) return { kind: 'unavailable', failure: routed.failure };
    const environment = routed.configuration.environments[0];
    if (environment === undefined) {
        return {
            kind: 'unavailable',
            failure: sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.environmentNotConfigured,
            ),
        };
    }
    const client = createInvocationClient(
        context,
        parsed.draft.binding.account,
        routed.origin,
    );
    const page = await scanPosthogIssuePage(
        client,
        {
            origin: routed.origin,
            environment: {
                teamRouteId: environment.teamPathId,
                teamUuid: environment.teamUuid,
            },
            window: resolvePosthogWindowPolicy(
                routed.configuration.scanWindowPolicy,
                Date.now(),
            ),
            nativeLimit: 1,
            offset: 0,
        },
        { signal: context.signal, privateDeadlineMs },
    );
    return page.ok
        ? { kind: 'available' }
        : { kind: 'unavailable', failure: toTriageSourceFailure(page.failure) };
  };
}

export const probePosthogCapability: PosthogCapabilityProbe
    = createPosthogCapabilityProbe(POSTHOG_INTERACTIVE_READ_DEADLINE_MS);

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isMountedPosthogUiRead(context: PluginInvocationContext): boolean {
    return context.surface === 'plugin'
        && context.caller?.kind === 'plugin'
        && context.caller.pluginId === POSTHOG_PLUGIN_ID
        && context.caller.originSurface === 'ui';
}

/** One authoritative read of one local ref through one exact configured instance. */
async function readPosthogSourceEntry(
    input: unknown,
    context: PluginInvocationContext,
    privateDeadlineMs?: number,
): Promise<TriageGetResultV1> {
    const parsed = TriageGetInputV1Schema.parse(input);
    const localRef = Object.freeze({
        kindId: parsed.localRef.kindId,
        collisionScope: parsed.localRef.collisionScope,
        entryId: parsed.localRef.entryId,
    });
    const unresolved = (failure: TriageSourceFailureV1): TriageGetResultV1 => Object.freeze({
        kind: 'unresolved' as const,
        localRef,
        failure,
    });

    const routed = resolveInvokedInstance(parsed.instance);
    if (!routed.ok) return unresolved(routed.failure);
    const { origin, configuration } = routed;

    // The requested ref must already belong to this instance's configured scope. A ref
    // from another deployment or an environment this instance does not select is
    // refused before a request is built, never re-scoped onto the invoked instance.
    const scope = parsePosthogCollisionScope(parsed.localRef.collisionScope);
    if (
        parsed.localRef.kindId !== POSTHOG_ENTRY_KIND
        || scope === null
        || scope.origin !== (origin as string)
    ) {
        return unresolved(sourceFailure(
            'unsupportedContract',
            POSTHOG_FAILURE_CODES.instanceScopeMismatch,
        ));
    }
    const environment = configuration.environments
        .find((candidate) => candidate.teamUuid === scope.teamUuid);
    if (environment === undefined) {
        return unresolved(sourceFailure(
            'unsupportedContract',
            POSTHOG_FAILURE_CODES.environmentNotConfigured,
        ));
    }
    if (!UUID_PATTERN.test(parsed.localRef.entryId)) {
        return unresolved(sourceFailure(
            'unsupportedContract',
            POSTHOG_FAILURE_CODES.entryIdMalformed,
        ));
    }

    const client = createInvocationClient(context, parsed.instance.binding.account, origin);
    const outcome = await getPosthogIssue(
        client,
        {
            teamRouteId: environment.teamPathId,
            issueId: parsed.localRef.entryId,
            detailWindow: resolvePosthogWindowPolicy(configuration.detailWindowPolicy, Date.now()),
        },
        privateDeadlineMs === undefined
            ? { signal: context.signal }
            : { signal: context.signal, privateDeadlineMs },
    );

    if (outcome.kind === 'unresolved') {
        // A plain CRUD 404 stays `unresolved`. V1 retains no fingerprint, so the
        // provider cannot name a successor and this source can conclude neither
        // absence nor a merge.
        //
        // The projection is the SAME one `scan` uses. A second switch over the
        // resolution reason stood here and had already lost the provider's own
        // `Retry-After` deadline, so one throttle response deferred a later scan and
        // told the aggregate to retry the identical `get` immediately.
        return unresolved(toTriageSourceFailure(outcome.resolution.failure));
    }

    // The query plane supplies the richer row when it answered; a failed enrichment
    // degrades the snapshot rather than downgrading a present entry.
    const row: PosthogIssueRow = outcome.queryDetail === undefined ? {
        id: outcome.crud.id,
        name: outcome.crud.name,
        description: outcome.crud.description,
        nativeStatus: outcome.crud.nativeStatus,
        ...(outcome.crud.firstSeenMs === undefined
            ? {}
            : { firstSeenMs: outcome.crud.firstSeenMs }),
        library: null,
        source: null,
        assignee: outcome.crud.assignee,
        aggregations: null,
    } : {
        ...outcome.queryDetail,
        // `impact` is the detail route's named impact aggregate. Prefer it when the
        // provider supplies it instead of paying for that plane and discarding it.
        aggregations: outcome.queryDetail.impact ?? outcome.queryDetail.aggregations,
    };

    return buildPosthogPresentObservation({
        snapshot: buildPosthogEntrySnapshot({
            locator: {
                collisionScope: parsed.localRef.collisionScope,
                entryId: parsed.localRef.entryId,
            },
            row,
            scope: {
                displayName: environment.displayName,
                teamRouteId: environment.teamPathId,
            },
            crud: outcome.crud,
            ...(outcome.queryDetail === undefined ? {} : { enrichment: outcome.queryDetail }),
            untitledLabel: UNTITLED_ISSUE_LABEL,
            bounds: PROJECTION_BOUNDS,
        }),
        ...(row.lastSeenMs === undefined ? {} : { sourceUpdatedAtMs: row.lastSeenMs }),
    });
}

export type PosthogSourceEntryReader = (
    input: unknown,
    context: PluginInvocationContext,
) => Promise<TriageGetResultV1>;

export function createPosthogSourceEntryReader(
    privateDeadlineMs: number,
): PosthogSourceEntryReader {
    return async (input, context) => await readPosthogSourceEntry(
        input,
        context,
        privateDeadlineMs,
    );
}

export const getPosthogSourceEntry: PosthogSourceEntryReader = async (input, context) => (
    await readPosthogSourceEntry(
        input,
        context,
        isMountedPosthogUiRead(context) ? POSTHOG_INTERACTIVE_READ_DEADLINE_MS : undefined,
    )
);

/**
 * The private deadline for a mounted-detail sampled read.
 *
 * `listInstances`, `scan`, and aggregate-owned `get` calls use the caller's deadline
 * unchanged; a second timer over them would make two owners of one cancellation. A
 * mounted source-detail read has no aggregate deadline of its own, so that invocation
 * and the sampled-detail paths below supply one —
 * and it is injected rather than read from a module constant at the request site, so a
 * test can prove the timeout without waiting for it.
 */
export const POSTHOG_MOUNTED_DETAIL_DEADLINE_MS = 20_000;

export type PosthogSampledEventsReader = (
    input: unknown,
    context: PluginInvocationContext,
) => Promise<PosthogSampledEventsResultV1>;

/**
 * The source-native sampled-occurrence read behind the detail body's three
 * sampled-data tabs.
 *
 * It is the only path from the mounted surface to `query/issue_events/`. The surface
 * holds no credential and constructs no request: it names the exact configured instance
 * and entry it was mounted for, and this operation resolves the environment, freezes the
 * detail window on the first page, and carries that window forward as its own opaque
 * continuation. Nothing here is persisted, and an interrupted detail session keeps
 * nothing.
 */
export function createPosthogSampledEventsReader(
    privateDeadlineMs: number,
): PosthogSampledEventsReader {
    return async function readSampledEvents(
        input: unknown,
        context: PluginInvocationContext,
    ): Promise<PosthogSampledEventsResultV1> {
        const parsed = PosthogSampledEventsInputV1Schema.parse(input);
        const unavailable = (
            failure: TriageSourceFailureV1,
        ): PosthogSampledEventsResultV1 => Object.freeze({ kind: 'unavailable' as const, failure });

        const routed = resolveInvokedInstance(parsed.instance);
        if (!routed.ok) return unavailable(routed.failure);
        const { origin, configuration } = routed;

        const scope = parsePosthogCollisionScope(parsed.localRef.collisionScope);
        if (
            parsed.localRef.kindId !== POSTHOG_ENTRY_KIND
            || scope === null
            || scope.origin !== (origin as string)
        ) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.instanceScopeMismatch,
            ));
        }
        const environment = configuration.environments
            .find((candidate) => candidate.teamUuid === scope.teamUuid);
        if (environment === undefined) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.environmentNotConfigured,
            ));
        }
        if (!UUID_PATTERN.test(parsed.localRef.entryId)) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.entryIdMalformed,
            ));
        }

        // The first page freezes the window; every later page reuses that exact frozen
        // window, because a relative policy resolved again would move the result set the
        // offset was measured in.
        const frontier = parsed.continuation === undefined
            ? ((): PosthogSampledEventsFrontier => {
                const window = resolvePosthogWindowPolicy(
                    configuration.detailWindowPolicy,
                    Date.now(),
                );
                return { v: 1, from: window.from, to: window.to, offset: 0, limit: parsed.limit };
            })()
            : decodePosthogSampledEventsContinuation(parsed.continuation);
        if (frontier === null || frontier.limit !== parsed.limit) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.continuationUnreadable,
            ));
        }

        const client = createInvocationClient(context, parsed.instance.binding.account, origin);
        const page = await readPosthogSampledIssueEvents(
            client,
            {
                teamRouteId: environment.teamPathId,
                issueId: parsed.localRef.entryId,
                detailWindow: { from: frontier.from, to: frontier.to },
                limit: frontier.limit,
                offset: frontier.offset,
            },
            { signal: context.signal, privateDeadlineMs },
        );
        if (!page.ok) {
            return unavailable(toTriageSourceFailure(page.failure));
        }

        const { walk } = page.value;
        const continuation = walk.kind === 'continues'
            ? encodePosthogSampledEventsContinuation({ ...frontier, offset: walk.position })
            : null;
        // The same two ways to have no next position the Activity page distinguishes: a
        // verified offset whose token will not fit is as much a gap as an offset that
        // refused to advance, and neither is the provider's end of the sample.
        const stoppedShort = walk.kind === 'stoppedShort'
            || (walk.kind === 'continues' && continuation === null);
        return Object.freeze({
            kind: 'sampled' as const,
            events: page.value.events,
            omittedRowCount: page.value.omittedRowCount,
            ...(continuation === null ? {} : { continuation }),
            ...(stoppedShort ? { incomplete: POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1 } : {}),
        });
    };
}

/** The bound reader the manifest declares. */
export const readPosthogSampledEvents: PosthogSampledEventsReader
    = createPosthogSampledEventsReader(POSTHOG_MOUNTED_DETAIL_DEADLINE_MS);

export type PosthogIssueActivityReader = (
    input: unknown,
    context: PluginInvocationContext,
) => Promise<PosthogIssueActivityResultV1>;

/**
 * The source-native issue-activity read behind the detail body's Activity panel.
 *
 * It is the only path from the mounted surface to `issues/{id}/activity/`. The surface
 * holds no credential and constructs no request: it names the exact configured instance
 * and entry it was mounted for, and this operation resolves the environment and carries
 * its own page position forward as an opaque continuation. The route is page-numbered,
 * so unlike the sampled read there is no window to freeze — but likewise nothing is
 * persisted, and an interrupted panel keeps nothing.
 *
 * A `403` from this route stays a visible permission failure. It is the one read here
 * that needs `activity_log:read`, and no stable missing-scope discriminator has been
 * characterized, so this operation never reinterprets that status as an empty page.
 */
export function createPosthogIssueActivityReader(
    privateDeadlineMs: number,
): PosthogIssueActivityReader {
    return async function readIssueActivity(
        input: unknown,
        context: PluginInvocationContext,
    ): Promise<PosthogIssueActivityResultV1> {
        const parsed = PosthogIssueActivityInputV1Schema.parse(input);
        const unavailable = (
            failure: TriageSourceFailureV1,
        ): PosthogIssueActivityResultV1 => Object.freeze({
            kind: 'unavailable' as const,
            failure,
        });

        const routed = resolveInvokedInstance(parsed.instance);
        if (!routed.ok) return unavailable(routed.failure);
        const { origin, configuration } = routed;

        const scope = parsePosthogCollisionScope(parsed.localRef.collisionScope);
        if (
            parsed.localRef.kindId !== POSTHOG_ENTRY_KIND
            || scope === null
            || scope.origin !== (origin as string)
        ) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.instanceScopeMismatch,
            ));
        }
        const environment = configuration.environments
            .find((candidate) => candidate.teamUuid === scope.teamUuid);
        if (environment === undefined) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.environmentNotConfigured,
            ));
        }
        if (!UUID_PATTERN.test(parsed.localRef.entryId)) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.entryIdMalformed,
            ));
        }

        const frontier: PosthogIssueActivityFrontier | null = parsed.continuation === undefined
            ? { v: 1, page: 1, limit: parsed.limit }
            : decodePosthogIssueActivityContinuation(parsed.continuation);
        if (frontier === null || frontier.limit !== parsed.limit) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.continuationUnreadable,
            ));
        }

        const client = createInvocationClient(context, parsed.instance.binding.account, origin);
        const page = await readPosthogIssueActivity(
            client,
            {
                teamRouteId: environment.teamPathId,
                issueId: parsed.localRef.entryId,
                limit: frontier.limit,
                page: frontier.page,
            },
            { signal: context.signal, privateDeadlineMs },
        );
        if (!page.ok) {
            return unavailable(toTriageSourceFailure(page.failure));
        }

        const { walk } = page.value;
        const continuation = walk.kind === 'continues'
            ? encodePosthogIssueActivityContinuation({ ...frontier, page: walk.position })
            : null;
        // Two different ways to have no next position, and only one of them is the end
        // of the collection. A verified page whose token will not fit is the same fact
        // as a `next` this source will not follow: the walk stops here, and the panel
        // must not read that as exhaustion.
        const stoppedShort = walk.kind === 'stoppedShort'
            || (walk.kind === 'continues' && continuation === null);
        return Object.freeze({
            kind: 'activity' as const,
            records: page.value.records,
            omittedRowCount: page.value.omittedRowCount,
            ...(page.value.totalCount === null ? {} : { totalCount: page.value.totalCount }),
            ...(continuation === null ? {} : { continuation }),
            ...(stoppedShort ? { incomplete: POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1 } : {}),
        });
    };
}

/** The bound reader the manifest declares. */
export const readPosthogActivity: PosthogIssueActivityReader
    = createPosthogIssueActivityReader(POSTHOG_MOUNTED_DETAIL_DEADLINE_MS);
