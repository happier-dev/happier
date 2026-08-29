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
    readTriageSourceAccountListingV1,
} from '@happier-dev/triage-sources/runtime';
import {
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
import { fitActionResultTextV1 } from '@happier-dev/triage-sources/projection/actionResultText';
import {
    fitActionResultPageV1,
    fitActionResultSequenceV1,
} from '@happier-dev/triage-sources/projection/actionResultSequence';

import {
    MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1,
    PosthogConfigurationDirectoryInputV1Schema,
    type PosthogConfigurationDirectoryResultV1,
} from '../connect/configurationContract.js';
import type { PosthogFailure } from '../api/errors.js';
import { organizationProjectsPath, organizationsListPath } from '../api/paths.js';
import {
    parsePosthogDirectoryPage,
    parsePosthogEnvironmentRow,
    parsePosthogOrganizationRow,
    type PosthogEnvironmentRow,
} from '../api/types/directory.js';
import type { PosthogIssueRow } from '../api/types/issues.js';
import { POSTHOG_ISSUE_EVENTS_INCLUDE } from '../api/types/events.js';
import {
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
import { readPosthogCodeVariables } from './detail/codeVariables.js';
import {
    PosthogCodeVariablesInputV1Schema,
    type PosthogCodeVariablesResultV1,
} from './detail/codeVariablesContract.js';
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
} from './identity.js';
import {
    POSTHOG_DRAFT_WINDOW_POLICY,
    encodePosthogConfiguration,
    resolvePosthogWindowPolicy,
    type PosthogConfigurationToken,
    type PosthogConfiguredEnvironment,
} from './instance.js';
import { createPosthogInvocationClient } from '../api/invocationClient.js';
import { runPosthogBoundedInvocation } from './invocationDeadline.js';
import { resolvePosthogInvocationScope } from './invocationScope.js';
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

/** Factory seam for tests or a caller that supplies a real external deadline. */
export type PosthogConfigurationDirectoryReader = (
    input: unknown,
    context: PluginInvocationContext,
) => Promise<PosthogConfigurationDirectoryResultV1>;

/** One explicitly requested page of the mounted PostHog configuration browser. */
export function createPosthogConfigurationDirectoryReader(
    deadlineMs?: number,
): PosthogConfigurationDirectoryReader {
  return async function readConfigurationDirectory(
    input: unknown,
    context: PluginInvocationContext,
  ): Promise<PosthogConfigurationDirectoryResultV1> {
    return await runPosthogBoundedInvocation(context, deadlineMs, async (signal) => {
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
        signal,
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
    const client = createPosthogInvocationClient(context, listed.account, origin);
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
                { signal },
            )
            : await client.followJson(
                parsed.page.next,
                (body) => parsePosthogDirectoryPage(body, parseRow),
                { signal },
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
        const projectedRows = page.rows.flatMap((row) => {
            const key = buildPosthogLocalInstanceKey(origin, row.organizationUuid);
            const displayName = projectTriageDisplayTextV1(row.name, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
            return !key.ok || displayName.value.length === 0 ? [] : [{
                organizationUuid: row.organizationUuid,
                displayName: displayName.value,
                localInstanceKey: key.value,
            }];
        });
        const rows = projectedRows.slice(0, MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1);
        return fitActionResultPageV1(
            rows,
            next ?? undefined,
            (fittedRows, omittedCount, fittedNext, continuationOmitted) => ({
                kind: 'organizations' as const,
                rows: fittedRows,
                ...(fittedNext === undefined ? {} : { next: fittedNext }),
                ...(incomplete
                    || rows.length !== page.rows.length
                    || omittedCount > 0
                    || continuationOmitted
                    ? { incomplete: true as const }
                    : {}),
            }),
        ).result;
    }
    const read = await readPage(
        organizationProjectsPath(parsed.organizationUuid),
        parsePosthogEnvironmentRow,
    );
    if (!read.result.ok) return unavailable(toTriageSourceFailure(read.result.failure));
    const page = read.result.value;
    const { next, incomplete } = pageState(page, read.requestedUrl);
    const projectedRows = page.rows.flatMap((row) => {
        if (row.organizationUuid !== parsed.organizationUuid) return [];
        const displayName = projectTriageDisplayTextV1(row.displayName, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
        return displayName.value.length === 0 ? [] : [{
            teamPathId: row.teamRouteId,
            teamUuid: row.teamUuid,
            ...(row.parentProjectId === undefined ? {} : { parentProjectId: row.parentProjectId }),
            displayName: displayName.value,
        }];
    });
    const rows = projectedRows.slice(0, MAX_POSTHOG_DIRECTORY_ROWS_PER_PAGE_V1);
    return fitActionResultPageV1(
        rows,
        next ?? undefined,
        (fittedRows, omittedCount, fittedNext, continuationOmitted) => ({
            kind: 'environments' as const,
            organizationUuid: parsed.organizationUuid,
            rows: fittedRows,
            ...(fittedNext === undefined ? {} : { next: fittedNext }),
            ...(incomplete
                || rows.length !== page.rows.length
                || omittedCount > 0
                || continuationOmitted
                ? { incomplete: true as const }
                : {}),
        }),
    ).result;
    });
  };
}

export const readPosthogConfigurationDirectory: PosthogConfigurationDirectoryReader
    = createPosthogConfigurationDirectoryReader();

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
        signal: context.signal,
    });
    if (outcome.kind === 'failed') throw outcome.error;
    const listed: ConnectedAccountMetadataList = outcome.kind === 'unbound'
        ? { status: 'complete', accounts: [] }
        : outcome.listing;

    const candidates: TriageSourceInstanceDraftV1[] = [];
    const failures: PosthogInstanceFailure[] = [];
    let bounded = false;

    const accounts = [...listed.accounts]
        .sort((left, right) => compareAccounts(left.account, right.account));

    for (const entry of accounts) {
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
        const client = createPosthogInvocationClient(context, entry.account, origin);

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

    const frozenFailures = Object.freeze([...failures]);
    if (listed.status === 'truncated') {
        return Object.freeze({
            kind: 'incomplete' as const,
            candidates: Object.freeze(candidates),
            failures: frozenFailures,
            failure: sourceFailure('unknown', POSTHOG_FAILURE_CODES.accountListTruncated),
        });
    }
    if (bounded) {
        return Object.freeze({
            kind: 'incomplete' as const,
            candidates: Object.freeze(candidates),
            failures: frozenFailures,
            failure: sourceFailure('unknown', POSTHOG_FAILURE_CODES.discoveryPageBounded),
        });
    }
    return Object.freeze({
        kind: 'complete' as const,
        candidates: Object.freeze(candidates),
        failures: frozenFailures,
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

    const client = createPosthogInvocationClient(context, parsed.instance.binding.account, origin);
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
    const scope = resolvePosthogInvocationScope(instance);
    if (!scope.ok) {
        const code = scope.reason === 'instanceKeyUnreadable'
            ? POSTHOG_FAILURE_CODES.instanceKeyUnreadable
            : scope.reason === 'originInvalid'
                ? POSTHOG_FAILURE_CODES.originInvalid
                : scope.reason === 'configurationUndecodable'
                    ? POSTHOG_FAILURE_CODES.configurationUndecodable
                    : POSTHOG_FAILURE_CODES.instanceScopeMismatch;
        return Object.freeze({
            ok: false as const,
            failure: sourceFailure('unsupportedContract', code),
        });
    }
    return Object.freeze({
        ok: true as const,
        origin: scope.origin,
        organizationUuid: scope.organizationUuid,
        configuration: scope.configuration,
    });
}

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isMountedPosthogUiRead(context: PluginInvocationContext): boolean {
    // The dispatcher stamps the handler-visible surface with the authenticated
    // invoking origin: a mounted detail-body read arrives as `ui`, while the
    // aggregate-owned get is `plugin`.
    return context.surface === 'ui'
        && context.caller?.kind === 'plugin'
        && context.caller.pluginId === POSTHOG_PLUGIN_ID;
}

/** One authoritative read of one local ref through one exact configured instance. */
async function readPosthogSourceEntry(
    input: unknown,
    context: PluginInvocationContext,
    signal: AbortSignal,
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

    // Exact get and every source-native detail plane share one admission owner. A ref
    // from another deployment/environment is refused before a request is built, never
    // re-scoped onto the invoked instance.
    const scope = resolvePosthogIssueScope(parsed.instance, parsed.localRef);
    if (!scope.ok) return unresolved(scope.failure);
    const { origin, configuration, environment } = scope;

    const client = createPosthogInvocationClient(context, parsed.instance.binding.account, origin);
    const outcome = await getPosthogIssue(
        client,
        {
            teamRouteId: environment.teamPathId,
            issueId: parsed.localRef.entryId,
            detailWindow: resolvePosthogWindowPolicy(configuration.detailWindowPolicy, Date.now()),
        },
        { signal },
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
    deadlineMs?: number,
): PosthogSourceEntryReader {
    return async (input, context) => await runPosthogBoundedInvocation(
        context,
        deadlineMs,
        async (signal) => await readPosthogSourceEntry(input, context, signal),
    );
}

export const getPosthogSourceEntry: PosthogSourceEntryReader = async (input, context) => (
    isMountedPosthogUiRead(context)
        ? await runPosthogBoundedInvocation(
            context,
            undefined,
            async (signal) => await readPosthogSourceEntry(input, context, signal),
        )
        : await readPosthogSourceEntry(input, context, context.signal)
);

/**
 * Mounted-detail sampled reads inherit the host-stamped caller lifetime.
 *
 * `listInstances`, `scan`, and aggregate-owned `get` calls use the caller's deadline
 * unchanged; a second timer over them would make two owners of one cancellation. A
 * mounted source-detail reads likewise use their Action signal. The factories below accept an
 * explicit test/external bound without creating a production latency policy.
 */
type PosthogIssueScope =
    | Readonly<{
        ok: true;
        origin: PosthogApiOrigin;
        configuration: PosthogConfigurationToken;
        environment: PosthogConfiguredEnvironment;
    }>
    | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/** One scope admission owner for aggregate get and every source-native exact-issue read. */
function resolvePosthogIssueScope(
    instance: Readonly<{
        localInstanceKey: string;
        configuration: Readonly<{ v: 1; token: string }>;
    }>,
    localRef: Readonly<{ kindId: string; collisionScope: string; entryId: string }>,
): PosthogIssueScope {
    const routed = resolveInvokedInstance(instance);
    if (!routed.ok) return routed;
    const scope = parsePosthogCollisionScope(localRef.collisionScope);
    if (
        localRef.kindId !== POSTHOG_ENTRY_KIND
        || scope === null
        || scope.origin !== (routed.origin as string)
    ) {
        return {
            ok: false,
            failure: sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.instanceScopeMismatch,
            ),
        };
    }
    const environment = routed.configuration.environments
        .find((candidate) => candidate.teamUuid === scope.teamUuid);
    if (environment === undefined) {
        return {
            ok: false,
            failure: sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.environmentNotConfigured,
            ),
        };
    }
    if (!UUID_PATTERN.test(localRef.entryId)) {
        return {
            ok: false,
            failure: sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.entryIdMalformed,
            ),
        };
    }
    return {
        ok: true,
        origin: routed.origin,
        configuration: routed.configuration,
        environment,
    };
}

function codeVariablesResult(variables: unknown): PosthogCodeVariablesResultV1 | null {
    let full: string;
    try {
        full = JSON.stringify(variables, null, 2) ?? '{}';
    } catch {
        return null;
    }
    // The shared projection owner derives the one real Action-envelope boundary and
    // preserves Unicode code points; PostHog does not invent a second byte limit.
    return fitActionResultTextV1(full, (variablesText, truncated) => Object.freeze({
        kind: 'revealed' as const,
        variablesText,
        ...(truncated ? { truncated: true as const } : {}),
    }));
}

export type PosthogCodeVariablesReader = (
    input: unknown,
    context: PluginInvocationContext,
) => Promise<PosthogCodeVariablesResultV1>;

export function createPosthogCodeVariablesReader(
    deadlineMs?: number,
): PosthogCodeVariablesReader {
    return async (input, context) => await runPosthogBoundedInvocation(
        context,
        deadlineMs,
        async (signal) => {
            const parsed = PosthogCodeVariablesInputV1Schema.parse(input);
            const unavailable = (failure: TriageSourceFailureV1): PosthogCodeVariablesResultV1 => ({
                kind: 'unavailable',
                failure,
            });
            const scope = resolvePosthogIssueScope(parsed.instance, parsed.localRef);
            if (!scope.ok) return unavailable(scope.failure);
            if (
                parsed.frozenRequest.issueId !== parsed.localRef.entryId
                || parsed.frozenRequest.include.some((value, index) => (
                    value !== POSTHOG_ISSUE_EVENTS_INCLUDE[index]
                ))
                || parsed.selectedOffset < parsed.frozenRequest.offset
                || parsed.selectedOffset >= parsed.frozenRequest.offset + parsed.frozenRequest.limit
            ) {
                return unavailable(sourceFailure(
                    'unsupportedContract',
                    POSTHOG_FAILURE_CODES.requestInvalid,
                ));
            }
            const client = createPosthogInvocationClient(
                context,
                parsed.instance.binding.account,
                scope.origin,
            );
            const read = await readPosthogCodeVariables(client, {
                teamRouteId: scope.environment.teamPathId,
                issueId: parsed.localRef.entryId,
                detailWindow: {
                    from: parsed.frozenRequest.from,
                    to: parsed.frozenRequest.to,
                },
                selectedUuid: parsed.selectedUuid,
                selectedOffset: parsed.selectedOffset,
            }, { signal });
            if (!read.ok) return unavailable(toTriageSourceFailure(read.failure));
            const result = codeVariablesResult(read.value.variables);
            return result ?? unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.responseUnreadable,
            ));
        },
    );
}

export const readPosthogCodeVariablesForIssue: PosthogCodeVariablesReader
    = createPosthogCodeVariablesReader();

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
    deadlineMs?: number,
): PosthogSampledEventsReader {
    return async function readSampledEvents(
        input: unknown,
        context: PluginInvocationContext,
    ): Promise<PosthogSampledEventsResultV1> {
        return await runPosthogBoundedInvocation(context, deadlineMs, async (signal) => {
        const parsed = PosthogSampledEventsInputV1Schema.parse(input);
        const unavailable = (
            failure: TriageSourceFailureV1,
        ): PosthogSampledEventsResultV1 => Object.freeze({ kind: 'unavailable' as const, failure });

        const scope = resolvePosthogIssueScope(parsed.instance, parsed.localRef);
        if (!scope.ok) return unavailable(scope.failure);
        const { origin, configuration, environment } = scope;

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

        const client = createPosthogInvocationClient(context, parsed.instance.binding.account, origin);
        const page = await readPosthogSampledIssueEvents(
            client,
            {
                teamRouteId: environment.teamPathId,
                issueId: parsed.localRef.entryId,
                detailWindow: { from: frontier.from, to: frontier.to },
                limit: frontier.limit,
                offset: frontier.offset,
            },
            { signal },
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
        const frozenRequest = Object.freeze({
            v: 1 as const,
            issueId: page.value.request.issueId,
            from: page.value.request.dateRange.date_from,
            to: page.value.request.dateRange.date_to,
            filterTestAccounts: page.value.request.filterTestAccounts,
            onlyAppFrames: page.value.request.onlyAppFrames,
            include: page.value.request.include,
            limit: page.value.request.limit,
            offset: page.value.request.offset,
        });
        return fitActionResultSequenceV1(
            page.value.events,
            (events, envelopeOmittedCount): PosthogSampledEventsResultV1 => Object.freeze({
                kind: 'sampled' as const,
                events,
                omittedRowCount: page.value.omittedRowCount + envelopeOmittedCount,
                frozenRequest,
                ...(continuation === null ? {} : { continuation }),
                ...(stoppedShort ? { incomplete: POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1 } : {}),
            }),
        ).result;
        });
    };
}

/** The bound reader the manifest declares. */
export const readPosthogSampledEvents: PosthogSampledEventsReader
    = createPosthogSampledEventsReader();

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
    deadlineMs?: number,
): PosthogIssueActivityReader {
    return async function readIssueActivity(
        input: unknown,
        context: PluginInvocationContext,
    ): Promise<PosthogIssueActivityResultV1> {
        return await runPosthogBoundedInvocation(context, deadlineMs, async (signal) => {
        const parsed = PosthogIssueActivityInputV1Schema.parse(input);
        const unavailable = (
            failure: TriageSourceFailureV1,
        ): PosthogIssueActivityResultV1 => Object.freeze({
            kind: 'unavailable' as const,
            failure,
        });

        const scope = resolvePosthogIssueScope(parsed.instance, parsed.localRef);
        if (!scope.ok) return unavailable(scope.failure);
        const { origin, environment } = scope;

        const frontier: PosthogIssueActivityFrontier | null = parsed.continuation === undefined
            ? { v: 1, page: 1, limit: parsed.limit }
            : decodePosthogIssueActivityContinuation(parsed.continuation);
        if (frontier === null || frontier.limit !== parsed.limit) {
            return unavailable(sourceFailure(
                'unsupportedContract',
                POSTHOG_FAILURE_CODES.continuationUnreadable,
            ));
        }

        const client = createPosthogInvocationClient(context, parsed.instance.binding.account, origin);
        const page = await readPosthogIssueActivity(
            client,
            {
                teamRouteId: environment.teamPathId,
                issueId: parsed.localRef.entryId,
                limit: frontier.limit,
                page: frontier.page,
            },
            { signal },
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
        return fitActionResultSequenceV1(
            page.value.records,
            (records, envelopeOmittedCount): PosthogIssueActivityResultV1 => Object.freeze({
                kind: 'activity' as const,
                records,
                omittedRowCount: page.value.omittedRowCount + envelopeOmittedCount,
                ...(page.value.totalCount === null ? {} : { totalCount: page.value.totalCount }),
                ...(continuation === null ? {} : { continuation }),
                ...(stoppedShort ? { incomplete: POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1 } : {}),
            }),
        ).result;
        });
    };
}

/** The bound reader the manifest declares. */
export const readPosthogActivity: PosthogIssueActivityReader
    = createPosthogIssueActivityReader();
