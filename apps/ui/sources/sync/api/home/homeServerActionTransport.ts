import {
    readHomeDomainActionErrorV1,
    type HomeDomainActionErrorCodeV1,
} from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope, type ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import type { ServerFetch } from '@/sync/http/client';
import { invalidateHomeAccountReadJoins } from '@/sync/runtime/orchestration/homeAccountChange';
import { isLegacyHomeAccountToken, readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import {
    TEAM_DIRECTORY_PAGE_LIMIT_MAX_V1, TEAM_SUMMARIES_READ_BATCH_PATH_V1, TeamSummariesReadBatchResultV1Schema,
} from '@happier-dev/protocol/teams/projections';
import { teamErrorHttpStatusV1 } from '@happier-dev/protocol/teams';
import { createScopedBatchResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';

/**
 * The Home family's client transport.
 *
 * It carries a Home-governance or Team intent to one exact Home over the
 * existing server-Account request authority: that owner resolves the Home
 * profile, credential, carrier and Iroh lease, and it — not this module —
 * decides whether the credential authenticates the requested Account. Nothing
 * here re-decides reachability, credentials or authorization, so there is no
 * second transport or authority owner for the Home family.
 *
 * The Home is captured before any await, so focusing another Home mid-flight can
 * never retarget an in-flight request or publish its result under another Home.
 */

export type HomeDomainFailureKind =
    /** No answer was obtained: unresolved authority, carrier or network. */
    | 'unreachable'
    /** The Home rejected the credential. */
    | 'unauthorized'
    /** The Home answered that this actor may not do it. */
    | 'forbidden'
    /** This Home has no such operation — an older or feature-disabled Home. */
    | 'unsupported'
    /** The request or the answer did not satisfy the strict domain contract. */
    | 'invalid'
    /** The Home's state moved under the request; reload and resubmit. */
    | 'conflict'
    /** A mutation was dispatched, but its committed outcome could not be read. */
    | 'outcome_unknown'
    | 'unknown';

/** The exact codes accepted by the canonical Home domain and HTTP rollback readers. */
export type HomeDomainErrorCode = HomeDomainActionErrorCodeV1
    | 'credential_scope_denied'
    | NonNullable<ReturnType<typeof readHomeDomainConfirmedRollbackV1>>['code'];

export type HomeDomainFailure<TCode extends string = HomeDomainErrorCode> = Readonly<{
    kind: HomeDomainFailureKind;
    /** Whether repeating the same request unchanged could plausibly succeed. */
    retryable: boolean;
    /** The boundary's exact refusal; Action classifiers also retain pre-dispatch refusals, never inferred. */
    code: TCode | null;
    /** The strict, secret-free domain error envelope when the Home supplied one. */
    details?: unknown;
    /** The actual HTTP answer, when one was obtained; never inferred from a code. */
    httpStatus?: number;
} & Pick<ActionExecuteFailure, 'requestId' | 'effectAttempted' | 'failureCause'>>;

export type HomeDomainResult<TValue, TCode extends string = HomeDomainErrorCode> =
    | Readonly<{ ok: true; value: TValue }>
    | Readonly<{ ok: false; failure: HomeDomainFailure<TCode> }>;

/**
 * The strict domain codec. Any protocol schema satisfies it; keeping the
 * transport structural avoids binding it to one domain's schema module.
 */
type StrictDomainSchema<TValue> = Readonly<{
    safeParse: (value: unknown) => { success: true; data: TValue } | { success: false };
}>;

function failure<TCode extends string = HomeDomainErrorCode>(
    kind: HomeDomainFailureKind,
    retryable: boolean,
    code: TCode | null = null,
    details?: unknown,
    httpStatus?: number,
): HomeDomainResult<never, TCode> {
    return Object.freeze({
        ok: false as const,
        failure: Object.freeze({
            kind,
            retryable,
            code,
            ...(details === undefined ? {} : { details }),
            ...(httpStatus === undefined ? {} : { httpStatus }),
        }),
    });
}

/** Reads a bounded code for a non-family adapter. Canonical family errors use the shared parser above. */
function readAdditionalTypedErrorCode<TCode extends string>(
    body: unknown,
    schema?: StrictDomainSchema<TCode>,
): TCode | null {
    if (typeof body !== 'object' || body === null) return null;
    const raw = (body as { error?: unknown }).error;
    const domain = schema?.safeParse(raw);
    return domain?.success ? domain.data : null;
}

async function readJsonBody(response: Response): Promise<unknown> {
    try {
        const text = await response.text();
        return text.length > 0 ? JSON.parse(text) : null;
    } catch {
        // An unreadable or non-JSON body is not itself the outcome; the status
        // already classified the answer and the typed code stays absent.
        return null;
    }
}

export function homeDomainFailureKindForHttpStatus(status: number, domainCode?: string | null): HomeDomainFailureKind {
    if (status === 400) return 'invalid';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    // Typed resource refusals deliberately conceal existence from unauthorized
    // viewers. They prove the route answered, not that the Home needs an update.
    // teams_unavailable explicitly means the feature-gated route is absent.
    if (status === 404) return domainCode && domainCode !== 'teams_unavailable' ? 'forbidden' : 'unsupported';
    if (status === 409) return 'conflict';
    return 'unknown';
}

function classifyAnswer<TCode extends string>(
    status: number,
    body: unknown,
    schema?: StrictDomainSchema<TCode>,
): HomeDomainResult<never, TCode | HomeDomainErrorCode> {
    const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(status, body);
    if (scopeDenial) return failure('forbidden', false, scopeDenial.errorCode, undefined, status);
    const confirmedRollback = readHomeDomainConfirmedRollbackV1(status, body);
    if (confirmedRollback) {
        return failure(
            homeDomainFailureKindForHttpStatus(status, confirmedRollback.code),
            true,
            confirmedRollback.code,
            confirmedRollback.details,
            status,
        );
    }
    const domain = readHomeDomainActionErrorV1(body);
    if (domain) {
        // The shared Protocol parser is the sole authority for publishable
        // recovery details. Provider refusals additionally carry their own
        // validated retryability (not every retryable response is a 5xx).
        const retryable = domain.code === 'account_erasure_transition_cleanup_pending'
            || domain.code === 'account_erasure_upload_pending'
            || domain.code === 'account_erasure_deployment_cleanup_required' || status >= 500 || (
            typeof domain.details === 'object'
            && domain.details !== null
            && 'retryable' in domain.details
            && domain.details.retryable === true
        );
        return failure(
            homeDomainFailureKindForHttpStatus(status, domain.code),
            retryable,
            domain.code,
            domain.details,
            status,
        );
    }
    const code = readAdditionalTypedErrorCode(body, schema);
    return failure(homeDomainFailureKindForHttpStatus(status, code), status >= 500 || status === 408 || status === 429, code, undefined, status);
}

type TeamBatchAnswer = Readonly<{ status: number; body: unknown }>;
const teamBatchReads = createScopedBatchResolutionSingleFlight<TeamBatchAnswer | undefined>();

function readTeamSummaryBatch(readTransport: CapturedServerReadTransport, teamId: string, signal?: AbortSignal) {
    return teamBatchReads.run('team-summaries-v1', [teamId], async (ids, sharedSignal, publish) => {
        const results = new Map<string, TeamBatchAnswer | undefined>();
        if (ids.length === 1) return new Map([[ids[0]!, undefined]]);
        for (let start = 0; start < ids.length; start += TEAM_DIRECTORY_PAGE_LIMIT_MAX_V1) {
            const teamIds = ids.slice(start, start + TEAM_DIRECTORY_PAGE_LIMIT_MAX_V1);
            const chunk = await readTransport.read(TEAM_SUMMARIES_READ_BATCH_PATH_V1, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ v: 1, teamIds }), signal: sharedSignal,
            }, undefined, async response => {
                const body = await readJsonBody(response);
                const forAll = (answer: TeamBatchAnswer) => new Map(teamIds.map(id => [id, answer]));
                if (!response.ok) return forAll({ status: response.status, body });
                const batch = TeamSummariesReadBatchResultV1Schema.safeParse(body);
                const remaining = new Set(teamIds);
                const rows = new Map<string, TeamBatchAnswer>();
                for (const row of batch.success ? batch.data.results : []) {
                    const id = 'error' in row ? row.teamId : row.id;
                    if (!remaining.delete(id)) return forAll({ status: 200, body: null });
                    rows.set(id, 'error' in row ? { status: teamErrorHttpStatusV1(row.error), body: { error: row.error } }
                        : { status: 200, body: row });
                }
                return remaining.size ? forAll({ status: 200, body: null }) : rows;
            });
            for (const [id, result] of chunk) results.set(id, result);
            publish(chunk);
        }
        return results;
    }, { scope: [readTransport.scope ?? readTransport.key, readTransport.key], signal });
}

export async function requestHomeDomain<TValue, TCode extends string = HomeDomainErrorCode>(params: Readonly<{
    /** The exact Home and Account this intent belongs to, captured by the caller. */
    scope: ServerAccountScope;
    /** The Home-local domain path declared by this operation's Action row. */
    path: string;
    /** Exact method declared by the Action row; defaults preserve direct callers. */
    method?: string;
    /** The strict domain input. Home-local ids only; never a client Home id. */
    input: unknown;
    schema: StrictDomainSchema<TValue>;
    /** Additional bounded codes owned by the called domain family. */
    errorSchema?: StrictDomainSchema<TCode>;
    /** The row/domain's side-effect class; required so response loss is never guessed. */
    effect: 'read' | 'write';
    /** An admitted UI teams.get read eligible for a negotiated physical batch. */
    batchableTeamId?: string;
    signal?: AbortSignal;
    /** An Agent, plugin or caller-authored document's invocation: the Home must not treat it as the person. */
    authorityCeiling?: 'account_automation';
    /** Borrows an already admitted Account lifetime; never captures another authority. */
    requestAuthority?: Readonly<{ request: ServerFetch; assertCurrent: () => void }>;
}>): Promise<HomeDomainResult<TValue, TCode | HomeDomainErrorCode>> {
    let issued = false;
    try {
        const carry = async (authority: Readonly<{ request: ServerFetch }>
            & Partial<Pick<ServerAccountRequestAuthority, 'context' | 'readTransport'>>) => {
            params.requestAuthority?.assertCurrent();
            const credentials = authority.context?.credentials;
            if (params.batchableTeamId && authority.readTransport && credentials
                && readCredentialAuthorityKind(credentials.token) === 'account' && !isLegacyHomeAccountToken(credentials.token)) {
                const batch = await readTeamSummaryBatch(authority.readTransport, params.batchableTeamId, params.signal);
                const answer = batch.get(params.batchableTeamId);
                if (answer) {
                    if (answer.status !== 200) return classifyAnswer<TCode>(answer.status, answer.body, params.errorSchema);
                    const parsed = params.schema.safeParse(answer.body);
                    return parsed.success ? { ok: true as const, value: parsed.data } : failure('invalid', false);
                }
            }
            const ceilingHeader = params.authorityCeiling ? { [AUTHORITY_CEILING_HEADER_V1]: params.authorityCeiling } : null;
            const response = await authority.request(params.path, {
                method: params.method ?? 'POST',
                ...(params.input === undefined ? (ceilingHeader ? { headers: ceilingHeader } : {}) : {
                    headers: { 'content-type': 'application/json', ...ceilingHeader },
                    body: JSON.stringify(params.input),
                }),
                ...(params.signal ? { signal: params.signal } : {}),
            }, { recoveryRead: params.effect === 'read' ? 'unbounded' : false, onIssued: () => {
                issued = true;
                if (params.effect === 'write') invalidateHomeAccountReadJoins(params.scope.serverId);
            } });
            const body = await readJsonBody(response);
            params.requestAuthority?.assertCurrent();
            if (!response.ok) return classifyAnswer<TCode>(response.status, body, params.errorSchema);
            const parsed = params.schema.safeParse(body);
            if (!parsed.success) return failure<TCode | HomeDomainErrorCode>('invalid', false, null, undefined, response.status);
            return Object.freeze({ ok: true as const, value: parsed.data });
        };
        if (params.requestAuthority) return await carry(params.requestAuthority);
        return await runWithServerRequestAuthorityForServerAccountScope({
            scope: params.scope,
            // A Home-family intent is always explicitly addressed. Falling back
            // to the focused Home would silently retarget it.
            activeRequest: async () => {
                throw new Error('Home domain requests require an explicit Home target');
            },
        }, carry);
    } catch (error) {
        // Cancellation is the caller's own supersession, not a Home failure.
        if (params.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        // Before `onIssued`, authority/carrier failure proves no mutation was
        // accepted. After dispatch, a write may have committed even if its
        // response was lost; reads remain safe to repeat. The account-match
        // decision itself stays with the request-authority owner.
        return params.effect === 'write' && classifyHttpMutationRequestFailure({ error, issued, signal: params.signal }) === 'outcome_unknown'
            ? failure('outcome_unknown', false)
            : failure('unreachable', true);
    } finally {
        // A read begun during an issued write cannot serve later demand, even
        // when its acknowledgement was lost. This asserts no committed event.
        if (issued && params.effect === 'write') invalidateHomeAccountReadJoins(params.scope.serverId);
    }
}
