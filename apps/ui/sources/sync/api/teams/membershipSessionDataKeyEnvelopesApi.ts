import {
    MembershipSessionDataKeyEnvelopeErrorV1Schema,
    MembershipSessionDataKeyEnvelopePageV1Schema,
    PatchMembershipSessionDataKeyEnvelopesResultV1Schema,
} from '@happier-dev/protocol/sessions/encryption/membershipSessionDataKeyEnvelopes';

import { SessionAccessApiError, type SessionAccessRequestOptions } from '@/sync/api/session/sessionAccessApi';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import {
    prepareMembershipHistorySessionDataKeyEnvelopes,
    type MembershipHistoryPreparationOutcome,
    type MembershipSessionDataKeyEnvelopeTransport,
} from '@/sync/encryption/prepareMembershipHistorySessionDataKeyEnvelopes';
import {
    runSessionDataKeyPreparationDetached,
    type SessionDataKeyPreparationProgress,
} from '@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass';
import {
    runWithServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import {
    runWithServerAccountScopeRequestGuard,
    type ServerAccountScopeRequestGuard,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

/**
 * The exact-Account transport for one Team or Group membership's historical Session data-key
 * envelope page, and the production host that drives the canonical preparation pass over it.
 *
 * Team and Group are two addresses of the same subject — "the Sessions this membership may already
 * read but cannot yet decrypt" — so they share one transport, one pass and one outcome type. Only
 * the path differs, and it is built here rather than by the pass, which owns no route knowledge.
 *
 * The authority contract is the one the per-Session collection beside it established: a single
 * captured Home/Account authority spans discovery, the local opening of the caller's own envelopes,
 * the sealing, and every GET/PATCH of the pass. A page can therefore never be discovered under one
 * Account and committed under another, and the `recipientAccountId` the pass echoes on PATCH is the
 * target this caller actually discovered rather than whoever the membership resolves to later.
 */

export type MembershipSessionDataKeyEnvelopeTarget =
    | Readonly<{ kind: 'team'; teamMembershipId: string }>
    | Readonly<{ kind: 'group'; teamGroupId: string; accountId: string }>;

export type MembershipSessionDataKeyEnvelopeRequestOptions = SessionAccessRequestOptions & Readonly<{
    /** The exact Home-qualified Team the member-detail host resolved. */
    address: TeamAddress;
    target: MembershipSessionDataKeyEnvelopeTarget;
    /**
     * The Account the host believes this membership currently resolves to.
     *
     * It is captured before discovery and echoed on PATCH so a provider reset that keeps the
     * `teamMembershipId` while replacing its Account is rejected rather than silently written.
     */
    recipientAccountId: string;
}>;

function membershipEnvelopeCollectionPath(
    address: TeamAddress,
    target: MembershipSessionDataKeyEnvelopeTarget,
): string {
    const team = `/v2/teams/${encodeURIComponent(address.teamId)}`;
    if (target.kind === 'team') {
        return `${team}/members/${encodeURIComponent(target.teamMembershipId)}/sessions/data-key/envelopes`;
    }
    return `${team}/groups/${encodeURIComponent(target.teamGroupId)}`
        + `/members/${encodeURIComponent(target.accountId)}/sessions/data-key/envelopes`;
}

/**
 * Only the working page is requested. `limit` is deliberately omitted so the one Protocol owner of
 * the page bound stays the server-side default rather than a second copy of that measurement here.
 */
function membershipEnvelopePageQuery(cursor: string | null): string {
    const query = new URLSearchParams({ state: 'action_required' });
    if (cursor) query.set('cursor', cursor);
    return `?${query.toString()}`;
}

type BoundMembershipEnvelopeCollection = Readonly<{
    authority: ServerAccountRequestAuthority;
    guard: ServerAccountScopeRequestGuard;
    path: string;
}>;

async function requestMembershipEnvelopeCollection(
    bound: BoundMembershipEnvelopeCollection,
    init?: RequestInit,
): Promise<unknown> {
    bound.guard.check();
    const response = await bound.authority.request(bound.path, { ...init, signal: bound.guard.signal });
    bound.guard.check();
    const payload: unknown = await response.json();
    bound.guard.check();
    if (!response.ok) {
        const record = typeof payload === 'object' && payload !== null
            ? payload as Record<string, unknown>
            : {};
        const errorBody = MembershipSessionDataKeyEnvelopeErrorV1Schema.safeParse(record);
        throw new SessionAccessApiError(
            errorBody.success ? errorBody.data.error : 'membership_session_data_key_envelope_request_failed',
            response.status,
        );
    }
    return payload;
}

function createMembershipEnvelopeTransport(
    bound: BoundMembershipEnvelopeCollection,
): MembershipSessionDataKeyEnvelopeTransport {
    return {
        fetchPage: async (cursor) => MembershipSessionDataKeyEnvelopePageV1Schema.parse(
            await requestMembershipEnvelopeCollection(
                { ...bound, path: `${bound.path}${membershipEnvelopePageQuery(cursor)}` },
            ),
        ),
        patchPage: async (request) => PatchMembershipSessionDataKeyEnvelopesResultV1Schema.parse(
            await requestMembershipEnvelopeCollection(bound, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            }),
        ),
    };
}

async function runWithMembershipEnvelopeAuthority<TResult>(
    options: MembershipSessionDataKeyEnvelopeRequestOptions,
    operation: (bound: BoundMembershipEnvelopeCollection) => Promise<TResult>,
): Promise<TResult> {
    // A Home that does not share Sessions has no membership-history resource at all.
    // Failing here is the whole contract: probing for the route would invent a capability
    // the Home's own decision withholds.
    if (options.availability !== 'available') {
        throw new SessionAccessApiError('session_access_sharing_unavailable');
    }
    const path = membershipEnvelopeCollectionPath(options.address, options.target);
    return await runWithServerAccountScopeRequestGuard({
        scope: options.scope,
        isCurrent: options.isCurrent,
        signal: options.signal,
        staleError: () => new SessionAccessApiError('scope_changed'),
    }, async guard => {
        guard.check();
        return await runWithServerRequestAuthorityForServerAccountScope({
            scope: options.scope,
            activeRequest: async () => { throw new SessionAccessApiError('scope_changed'); },
        }, async authority => await operation({ authority, guard, path }));
    });
}

/**
 * The collection alone, for callers that drive their own pass. Each call captures and releases its
 * own exact authority.
 */
export function createMembershipSessionDataKeyEnvelopeClient(
    options: MembershipSessionDataKeyEnvelopeRequestOptions,
): MembershipSessionDataKeyEnvelopeTransport {
    return {
        fetchPage: async (cursor) => await runWithMembershipEnvelopeAuthority(
            options,
            async bound => await createMembershipEnvelopeTransport(bound).fetchPage(cursor),
        ),
        patchPage: async (request) => await runWithMembershipEnvelopeAuthority(
            options,
            async bound => await createMembershipEnvelopeTransport(bound).patchPage(request),
        ),
    };
}

/**
 * One membership-history preparation pass, under one captured authority.
 *
 * Everything the pass needs beyond the transport comes from that same authority: the Account
 * encryption owner that opens this caller's own envelopes and answers whether the material it
 * captured is still current, and the guard that decides whether the Home/Account the operation
 * started under is still the one on screen.
 */
export async function prepareMembershipHistoryEnvelopesForScope(
    options: MembershipSessionDataKeyEnvelopeRequestOptions & Readonly<{
        onProgress?: ((progress: SessionDataKeyPreparationProgress) => void) | undefined;
    }>,
): Promise<MembershipHistoryPreparationOutcome> {
    const scopeChangedOutcome = (): MembershipHistoryPreparationOutcome => ({
        status: 'scope_changed',
        preparedCount: 0,
        skippedCount: 0,
        repairRequiredSessions: [],
        recipientUnavailableReason: null,
        exceptions: null,
    });

    try {
        return await runWithMembershipEnvelopeAuthority(options, async bound => {
            const encryption = bound.authority.context.encryption;
            // A plain Account holds no content key at all, so it can open none of its own Session
            // envelopes. That is a stable caller-side stop, not a recipient state: reporting it as an
            // empty page would claim there is no work when the work is simply unreachable here.
            if (!encryption) throw new SessionAccessApiError('session_data_key_unavailable');
            const transport = createMembershipEnvelopeTransport(bound);
            return await prepareMembershipHistorySessionDataKeyEnvelopes({
                scope: {
                    serverId: bound.authority.scope.serverId,
                    recipientAccountId: options.recipientAccountId,
                },
                transport,
                encryption,
                isHostScopeCurrent: bound.guard.isCurrent,
                ...(options.onProgress ? { onProgress: options.onProgress } : {}),
            });
        });
    } catch (cause) {
        if (cause instanceof SessionAccessApiError) {
            if (cause.code === 'scope_changed') return scopeChangedOutcome();
            // A provider reset can race after GET and before PATCH. The server's
            // atomic recheck owns that answer; surface it as the same refreshable
            // outcome as a mismatching discovery page instead of degrading it to
            // a generic preparation failure.
            if (cause.code === 'recipient_changed') {
                return {
                    ...scopeChangedOutcome(),
                    status: 'recipient_changed',
                };
            }
            if (cause.code === 'membership_not_found') {
                return {
                    ...scopeChangedOutcome(),
                    status: 'membership_changed',
                };
            }
        }
        throw cause;
    }
}

/**
 * One exact process-local identity for membership-history preparation.
 *
 * The detached pass and its mounted auto-start guard must use the same identity.
 * In particular, a Team membership and each of that membership's Group targets
 * are distinct resources even though they resolve to the same Account.
 */
export type MembershipSessionDataKeyEnvelopeScopeIdentity = Pick<
    MembershipSessionDataKeyEnvelopeRequestOptions,
    'scope' | 'address' | 'target' | 'recipientAccountId'
>;

export function membershipHistoryPreparationScopeKey(
    options: MembershipSessionDataKeyEnvelopeScopeIdentity,
): string {
    return options.target.kind === 'team'
        ? serverAccountScopedResourceKey(
            options.scope,
            'membership-history',
            options.address.teamId,
            'team',
            options.target.teamMembershipId,
            options.recipientAccountId,
        )
        : serverAccountScopedResourceKey(
            options.scope,
            'membership-history',
            options.address.teamId,
            'group',
            options.target.teamGroupId,
            options.target.accountId,
            options.recipientAccountId,
        );
}

/**
 * Reuse one exact-scope pass and deliberately detach it from the member sheet.
 *
 * Operation lifetime is not component lifetime: closing the sheet stops that view
 * from observing progress, but the pass keeps running while its exact
 * Home/Account/membership/recipient scope and encryption generation stay current.
 * The authority guard and the encryption generation still stop the next write when
 * one of those actually changes — no durable job, lease or progress store is
 * involved, and a crash simply loses progress memory.
 */
export function prepareMembershipHistoryEnvelopesDetached(
    options: Omit<MembershipSessionDataKeyEnvelopeRequestOptions, 'isCurrent' | 'signal'> & Readonly<{
        onProgress?: ((progress: SessionDataKeyPreparationProgress) => void) | undefined;
    }>,
): Promise<MembershipHistoryPreparationOutcome> {
    const key = membershipHistoryPreparationScopeKey(options);
    // `isCurrent` and `signal` are deliberately dropped: a mounted view's lifetime
    // must not become this operation's lifetime.
    return runSessionDataKeyPreparationDetached(key, async () => await prepareMembershipHistoryEnvelopesForScope({
        scope: options.scope,
        address: options.address,
        target: options.target,
        recipientAccountId: options.recipientAccountId,
        availability: options.availability,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    }));
}
