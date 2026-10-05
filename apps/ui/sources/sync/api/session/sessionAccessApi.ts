import {
    ActionApprovalRequestCreatedResultSchema,
    bindSessionAccessActionHttpRequestV1,
    getActionSpec,
    isSessionAccessActionIdV1,
    SessionGrantMutationV1Schema,
    UserRecipientEnvelopeResponseSchema,
    SessionAccessGrantsListResponseV1Schema,
    SetSessionAccessGrantResponseV1Schema,
    RemoveSessionAccessGrantResponseV1Schema,
    SetSessionAccessContextResponseV1Schema,
    SessionPublicLinkGetActionResultV1Schema,
    SessionPublicLinkRemoveActionResultV1Schema,
    SessionPublicLinkCreateActionResultV1Schema,
    projectSessionPublicLinkActionResultV1,
    projectSessionPublicLinkCreateActionResultV1,
    type ActionId,
    type PrincipalRefV1,
    type SessionGrantIntentV1,
    type SessionGrantMutationV1,
    type SessionAccessAccountSummaryV1,
    ResolveSessionAccessPrincipalsRequestV1Schema,
    ResolveSessionAccessPrincipalsResponseV1Schema,
    type SessionAccessPrincipalSummaryV1,
    type SessionAccessCreationDecisionV1,
    generateStoredContentPublicShareMaterialV1,
} from '@happier-dev/protocol';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { readTransferableSessionDataKey } from '@/sync/encryption/readTransferableSessionDataKey';
import { encryptDataKeyForRecipientV0, verifyRecipientContentPublicKeyBinding } from '@/sync/encryption/directShareEncryption';
import { encryptDataKeyForPublicShare } from '@/sync/encryption/publicShareEncryption';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { searchUsersPageByUsername } from '@/sync/api/social/apiFriends';
import { readSessionAccessHttpFailureCode } from './sessionAccessHttpFailure';

export class SessionAccessApiError extends Error {
    constructor(readonly code: string, readonly status?: number) {
        super(code);
        this.name = 'SessionAccessApiError';
    }
}

/**
 * The Session-access family Action was routed to an approval Artifact instead of
 * being executed, so nothing has committed yet.
 *
 * Every leaf of this family (`session.access.grant.set/remove`,
 * `session.access.context.set`, `session.public_link.create/remove`,
 * `session.responsibility.set`) is a deferred-approval Action, and each one used
 * to hand the custody result straight to its own output schema — a `ZodError`
 * that every caller then read as an unknown transport failure while an approval
 * was open. The family answers this once here instead, carrying the Artifact
 * identity so the mounted host can hand it to the shared approval continuation
 * owner (`components/approvals/useActionApprovalContinuation`) rather than
 * inventing a second pending store.
 */
export class SessionAccessApprovalPendingError extends Error {
    constructor(readonly artifactId: string, readonly actionId: string) {
        super('session_access_approval_pending');
        this.name = 'SessionAccessApprovalPendingError';
        Object.setPrototypeOf(this, SessionAccessApprovalPendingError.prototype);
    }
}

/** Preserve the Protocol-owned typed Session-access error at every HTTP consumer. */
export function createSessionAccessApiErrorFromResponse(
    payload: unknown,
    status: number,
): SessionAccessApiError {
    return new SessionAccessApiError(readSessionAccessHttpFailureCode(payload, status), status);
}

export type SessionAccessRequestOptions = Readonly<{
    scope: ServerAccountScope;
    availability: SessionCollaborationAvailability;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    /** Optional mounted-sheet notification; the approved result also carries the full URL. */
    onPublicLinkIssued?: (material: Readonly<{ lookupId: string; secret: string }>) => void;
}>;

async function materializeDirectAccountEnvelope(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    check(): void;
    sessionId: string;
    mutation: SessionGrantMutationV1;
}>): Promise<Readonly<{
    mutation: SessionGrantMutationV1;
    retainedEnvelopeFallback: boolean;
    checkCurrentness: () => void;
}>> {
    if (params.mutation.subject.kind !== 'account') {
        return { mutation: params.mutation, retainedEnvelopeFallback: false, checkCurrentness: params.check };
    }
    const encryption = params.authority.context.encryption;
    const encryptionCurrentness = captureEncryptionGenerationCurrentness(encryption, {
        serverId: params.authority.scope.serverId,
    });
    const checkEncryptionScope = () => {
        params.check();
        if (!encryptionCurrentness.isCurrent()) {
            throw new SessionAccessApiError('session_access_stale_scope');
        }
    };
    const snapshot = await readSessionSnapshotForAuthority({
        authority: params.authority,
        sessionId: params.sessionId,
        isCurrent: () => { checkEncryptionScope(); return true; },
    }).catch((error: unknown) => {
        if (error instanceof SessionSnapshotReadError && error.errorCode === 'stale_response') {
            throw new SessionAccessApiError('session_access_stale_scope');
        }
        throw error;
    });
    checkEncryptionScope();
    if ((snapshot.session.encryptionMode ?? 'e2ee') === 'plain') {
        return { mutation: params.mutation, retainedEnvelopeFallback: false, checkCurrentness: checkEncryptionScope };
    }

    const response = await params.authority.request(`/v1/user/${encodeURIComponent(params.mutation.subject.accountId)}`);
    checkEncryptionScope();
    const payload: unknown = await response.json();
    checkEncryptionScope();
    if (!response.ok) throw new SessionAccessApiError(response.status === 404 ? 'session_access_subject_not_found' : 'session_access_request_failed', response.status);
    const recipientProjection = UserRecipientEnvelopeResponseSchema.safeParse(payload);
    if (!recipientProjection.success) throw new SessionAccessApiError('unsupported_action');
    const recipient = recipientProjection.data.user;
    const readiness = recipient.recipientEnvelopeReadiness;
    if (readiness.status === 'unavailable') {
        // The canonical admission permits key-free access while recipient setup
        // or repair is required. Keep that authoritative reason with its owner:
        // no key is opened/sealed here, and no unavailable Account becomes ready.
        return { mutation: params.mutation, retainedEnvelopeFallback: false, checkCurrentness: checkEncryptionScope };
    }
    if (!recipient.publicKey || !recipient.contentPublicKey || !recipient.contentPublicKeySig) {
        throw new SessionAccessApiError('recipient_key_unavailable');
    }
    if (!verifyRecipientContentPublicKeyBinding({
        signingPublicKeyHex: recipient.publicKey,
        contentPublicKeyB64: recipient.contentPublicKey,
        contentPublicKeySigB64: recipient.contentPublicKeySig,
    })) throw new SessionAccessApiError('session_access_invalid_recipient_envelope');
    const sessionDataKey = await readTransferableSessionDataKey({
        callerDataKeyEnvelope: snapshot.callerDataKeyEnvelope,
        encryption,
    });
    checkEncryptionScope();
    if (!sessionDataKey) {
        // Revocation deliberately leaves a recipient tuple inert. Only the
        // physical transaction can prove that tuple is still structurally valid
        // and reusable; a missing/invalid tuple returns recipient_envelope_required
        // and is projected back to the public host error below.
        return { mutation: params.mutation, retainedEnvelopeFallback: true, checkCurrentness: checkEncryptionScope };
    }
    const encryptedDataKey = encryptDataKeyForRecipientV0(sessionDataKey, recipient.contentPublicKey);
    checkEncryptionScope();
    return {
        mutation: {
            ...params.mutation,
            accountEnvelopeInput: {
                v: 1,
                encryptedDataKey,
            },
        },
        retainedEnvelopeFallback: false,
        checkCurrentness: checkEncryptionScope,
    };
}

/**
 * Materializes the trusted-host publication material for a new public link.
 *
 * The lookup and fragment secret are independently generated here. The Home
 * sees only the lookup and a key sealed to the fragment held by this device.
 * The public Action input stays bearer-free and key-free.
 */
async function materializePublicLinkCreateMaterial(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    check(): void;
    sessionId: string;
}>): Promise<Readonly<{
    lookupId: string;
    secret: string;
    encryptedDataKey?: string;
    checkCurrentness: () => void;
}>> {
    const encryption = params.authority.context.encryption;
    const encryptionCurrentness = captureEncryptionGenerationCurrentness(encryption, {
        serverId: params.authority.scope.serverId,
    });
    const checkEncryptionScope = () => {
        params.check();
        if (!encryptionCurrentness.isCurrent()) {
            throw new SessionAccessApiError('session_access_stale_scope');
        }
    };
    const snapshot = await readSessionSnapshotForAuthority({
        authority: params.authority,
        sessionId: params.sessionId,
        isCurrent: () => { checkEncryptionScope(); return true; },
    }).catch((error: unknown) => {
        if (error instanceof SessionSnapshotReadError && error.errorCode === 'stale_response') {
            throw new SessionAccessApiError('session_access_stale_scope');
        }
        throw error;
    });
    checkEncryptionScope();
    // Authority stays with the Home transaction and with the mounted host's own
    // capability check; this leaf adds no second access decision.
    const material = generateStoredContentPublicShareMaterialV1(getRandomBytes);
    if ((snapshot.session.encryptionMode ?? 'e2ee') === 'plain') {
        return { ...material, checkCurrentness: checkEncryptionScope };
    }
    const sessionDataKey = await readTransferableSessionDataKey({
        callerDataKeyEnvelope: snapshot.callerDataKeyEnvelope,
        encryption,
    });
    checkEncryptionScope();
    if (!sessionDataKey) throw new SessionAccessApiError('session_data_key_unavailable');
    const encryptedDataKey = await encryptDataKeyForPublicShare(sessionDataKey, material.secret);
    checkEncryptionScope();
    return { ...material, encryptedDataKey, checkCurrentness: checkEncryptionScope };
}

/**
 * Public links are an independently released publication boundary with their
 * own feature decision, so Session-sharing availability must not withdraw them.
 */
function isSessionPublicLinkActionId(actionId: ActionId): boolean {
    return actionId === 'session.public_link.get'
        || actionId === 'session.public_link.create'
        || actionId === 'session.public_link.remove';
}

function isSessionAccessActionAvailable(
    availability: SessionCollaborationAvailability,
    actionId: ActionId,
): boolean {
    return isSessionPublicLinkActionId(actionId) || availability === 'available';
}

/** Descriptor-owned transport for every Session-access and publication intent. */
export async function executeSessionAccessHttpAction(params: SessionAccessRequestOptions & Readonly<{
    actionId: ActionId;
    input: unknown;
}>): Promise<unknown> {
    // Hold the narrowed family id in a const so the guard below survives into
    // the request closures, which cannot re-narrow a property of `params`.
    const actionId = params.actionId;
    if (!isSessionAccessActionAvailable(params.availability, actionId)) {
        throw new SessionAccessApiError('session_access_sharing_unavailable');
    }
    const spec = getActionSpec(actionId);
    if (!spec.serverTransport || !spec.outputSchema) throw new SessionAccessApiError('unsupported_action');
    if (!isSessionAccessActionIdV1(actionId)) throw new SessionAccessApiError('unsupported_action');
    const publicInput = spec.inputSchema.parse(params.input);
    const mutation = spec.sideEffectClass !== 'none' && spec.sideEffectClass !== 'read';
    // An already-aborted request proves this host never handed bytes to the
    // transport. After dispatch, cancellation can no longer prove that.
    if (params.signal?.aborted) throw new SessionAccessApiError('cancelled');
    // The typed family binder is the one place an Action input becomes a
    // request, so this leaf keeps no route table of its own.
    return await runWithServerAccountScopeRequestGuard({
        scope: params.scope,
        isCurrent: params.isCurrent,
        signal: params.signal,
        staleError: () => new SessionAccessApiError('session_access_stale_scope'),
    }, async ({ check, signal }) => {
        check();
        return await runWithServerRequestAuthorityForServerAccountScope({
            scope: params.scope,
            activeRequest: async () => { throw new SessionAccessApiError('session_access_stale_scope'); },
        }, async authority => {
            check();
            const publicBound = bindSessionAccessActionHttpRequestV1(actionId, publicInput);
            let physicalMutation: SessionGrantMutationV1 | null = null;
            let publicLinkMaterial: Readonly<{ lookupId: string; keyDerivation: 'fragment_v1'; encryptedDataKey?: string }> | null = null;
            let issuedPublicLink: Readonly<{ lookupId: string; secret: string }> | null = null;
            let retainedEnvelopeFallback = false;
            let checkMaterializationCurrentness = check;
            if (actionId === 'session.public_link.create') {
                const { sessionId } = publicInput as { sessionId: string };
                const materialized = await materializePublicLinkCreateMaterial({ authority, check, sessionId });
                publicLinkMaterial = materialized.encryptedDataKey === undefined
                    ? { lookupId: materialized.lookupId, keyDerivation: 'fragment_v1' }
                    : { lookupId: materialized.lookupId, keyDerivation: 'fragment_v1', encryptedDataKey: materialized.encryptedDataKey };
                checkMaterializationCurrentness = materialized.checkCurrentness;
                issuedPublicLink = { lookupId: materialized.lookupId, secret: materialized.secret };
            }
            if (actionId === 'session.access.grant.set') {
                const { sessionId, ...grant } = publicInput as Record<string, unknown> & { sessionId: string };
                const materialized = await materializeDirectAccountEnvelope({
                    authority,
                    check,
                    sessionId,
                    mutation: SessionGrantMutationV1Schema.parse(grant),
                });
                physicalMutation = materialized.mutation;
                retainedEnvelopeFallback = materialized.retainedEnvelopeFallback;
                checkMaterializationCurrentness = materialized.checkCurrentness;
            }
            // The public Action input remains key-free and bearer-free. Only this
            // trusted execution host extends the already-bound physical request
            // with recipient ciphertext or publication material.
            // Only the Account arm of the physical mutation carries recipient
            // ciphertext; Team and Group subjects have no envelope to extend.
            const accountEnvelopeInput = physicalMutation && 'accountEnvelopeInput' in physicalMutation
                ? physicalMutation.accountEnvelopeInput
                : undefined;
            const physicalExtras = accountEnvelopeInput
                ? { accountEnvelopeInput }
                : publicLinkMaterial;
            const bound = physicalExtras && publicBound.body && typeof publicBound.body === 'object'
                ? { ...publicBound, body: { ...publicBound.body, ...physicalExtras } }
                : publicBound;
            checkMaterializationCurrentness();
            const requestInit: RequestInit = {
                method: bound.method,
                ...(bound.body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bound.body),
                }),
                signal,
            };
            let requestIssued = false;
            let response: Response;
            try {
                response = await authority.request(
                    bound.path,
                    requestInit,
                    { onIssued: () => { requestIssued = true; } },
                );
            } catch (error) {
                if (actionId === 'session.public_link.create'
                    && requestIssued
                    && !signal?.aborted) {
                    try {
                        // The server's public-link owner is value-idempotent.
                        // Replay this already-materialized request once so the
                        // lookup and wrapped key remain byte-identical; never
                        // regenerate either after an ambiguous response.
                        checkMaterializationCurrentness();
                        response = await authority.request(bound.path, requestInit);
                    } catch {
                        throw new SessionAccessApiError('outcome_unknown');
                    }
                } else if (mutation && requestIssued) {
                    throw new SessionAccessApiError('outcome_unknown');
                } else {
                    if (signal?.aborted) throw new SessionAccessApiError('cancelled');
                    throw error;
                }
            }
            check();
            const payload: unknown = await response.json().catch(() => null);
            check();
            if (!response.ok) {
                if (actionId === 'session.public_link.remove'
                    && response.status === 404
                    && (payload as Readonly<Record<string, unknown>> | null)?.error === 'Share not found') {
                    // The desired state already holds; publication removal is idempotent.
                    return spec.outputSchema!.parse({ changed: false });
                }
                const responseError = createSessionAccessApiErrorFromResponse(payload, response.status);
                throw new SessionAccessApiError(
                    retainedEnvelopeFallback && responseError.code === 'recipient_envelope_required'
                        ? 'session_data_key_unavailable'
                        : responseError.code,
                    response.status,
                );
            }
            try {
                if (actionId === 'session.public_link.remove') {
                    // The released owner acknowledges removal with `success`;
                    // anything else leaves the committed outcome unproven.
                    if ((payload as Readonly<Record<string, unknown>> | null)?.success !== true) {
                        throw new SessionAccessApiError('outcome_unknown');
                    }
                    return spec.outputSchema!.parse({ changed: true });
                }
                const value = actionId === 'session.public_link.create' && issuedPublicLink
                    ? projectSessionPublicLinkCreateActionResultV1(payload, issuedPublicLink)
                    : actionId === 'session.public_link.get' ? projectSessionPublicLinkActionResultV1(payload) : payload;
                if (issuedPublicLink) params.onPublicLinkIssued?.(issuedPublicLink);
                return spec.outputSchema!.parse(value);
            } catch (error) {
                if (!mutation) throw error;
                // A 2xx status proves the Home accepted the request, but an
                // unusable acknowledgement cannot prove what it committed.
                throw new SessionAccessApiError('outcome_unknown');
            }
        });
    });
}

/**
 * The mounted controller uses the normal Action executor with this exact
 * Account-bound family leaf, so every human Session-access and publication
 * intent honors Action availability and the user's confirmation setting and
 * reaches the Home through the one declared transport.
 */
export function createSessionAccessClient(options: SessionAccessRequestOptions & Readonly<{ sessionId: string }>) {
    async function execute(actionId: ActionId, input: unknown) {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        let requestError: unknown;
        const executor = createDefaultActionExecutor({
            sessionAccessAction: async args => {
                try {
                    return await executeSessionAccessHttpAction({ ...options, actionId: args.actionId, input: args.input, signal: args.signal ?? options.signal });
                } catch (error) {
                    requestError = error;
                    throw error;
                }
            },
        });
        const result = await executor.execute(actionId, input, {
            surface: 'ui',
            // The mounted editor is the direct human interaction. Marking that
            // admission explicitly keeps the shared approval owner able to tell
            // it apart from a UI-carried agent or plugin request; it grants no
            // authority the Home would not already check.
            authority: 'present_user',
            serverId: options.scope.serverId,
            defaultSessionId: options.sessionId,
            // The approval origin this family persists requires the invocation's
            // own identity (`ApprovalRequestV1.requestId`), exactly as the Home
            // Team client supplies it. Without it an approval-routed Action of
            // this family cannot even be recorded: it answers
            // `approval_origin_unavailable` instead of creating the Artifact.
            actionRequestId: randomUUID(),
        });
        if (!result.ok) {
            if (requestError) throw requestError;
            throw new SessionAccessApiError(result.errorCode ?? 'session_access_request_failed');
        }
        // An approval-routed Action answers with the custody result, never with
        // the leaf's own output. Report it as the one typed family outcome so no
        // caller parses approval custody as a committed change.
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success) {
            throw new SessionAccessApprovalPendingError(approval.data.artifactId, approval.data.actionId);
        }
        return result.result;
    }
    return {
        /** The family's one dispatch entry for callers that own their own typed projection. */
        execute,
        list: async () => SessionAccessGrantsListResponseV1Schema.parse(await execute('session.access.grants.list', { sessionId: options.sessionId })),
        set: async (input: SessionGrantIntentV1) => SetSessionAccessGrantResponseV1Schema.parse(await execute('session.access.grant.set', { sessionId: options.sessionId, ...input })),
        remove: async (subject: PrincipalRefV1) => RemoveSessionAccessGrantResponseV1Schema.parse(await execute('session.access.grant.remove', { sessionId: options.sessionId, subject })),
        setContext: async (primaryTeamId: string | null) => SetSessionAccessContextResponseV1Schema.parse(await execute('session.access.context.set', { sessionId: options.sessionId, primaryTeamId })),
        getPublicLink: async () => SessionPublicLinkGetActionResultV1Schema.parse(
            await execute('session.public_link.get', { sessionId: options.sessionId }),
        ),
        createPublicLink: async (input: Readonly<{ expiresAt?: number; maxUses?: number; isConsentRequired: boolean }>) =>
            SessionPublicLinkCreateActionResultV1Schema.parse(await execute('session.public_link.create', {
                sessionId: options.sessionId,
                ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
                ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
                isConsentRequired: input.isConsentRequired,
            })),
        removePublicLink: async () => SessionPublicLinkRemoveActionResultV1Schema.parse(
            await execute('session.public_link.remove', { sessionId: options.sessionId }),
        ),
    };
}

/**
 * Home-scoped Account discovery for the access editor.
 *
 * The collaboration directory request is bound to the exact Account scope, so
 * the New Session draft — which has no Session yet — uses the same owner.
 */
export async function searchSessionAccessAccountPage(options: SessionAccessRequestOptions & Readonly<{
    query: string;
    cursor?: string | null;
}>) {
    const assertCurrent = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) throw new SessionAccessApiError('session_access_stale_scope');
    };
    return await runWithServerRequestAuthorityForServerAccountScope({ scope: options.scope,
        activeRequest: async () => { throw new SessionAccessApiError('session_access_stale_scope'); },
    }, async authority => {
        const credentials = authority.context.credentials;
        if (!credentials) throw new SessionAccessApiError('session_access_stale_scope');
        assertCurrent();
        const page = await searchUsersPageByUsername(credentials, options.query, {
            request: async (path, init) => {
                assertCurrent();
                return await authority.request(path, { ...init, ...(options.signal ? { signal: options.signal } : {}) });
            },
            retry: 'none',
            purpose: 'collaboration',
            ...(options.cursor ? { cursor: options.cursor } : {}),
        });
        assertCurrent();
        return {
            rows: page.users.map((profile): SessionAccessAccountSummaryV1 => ({
                kind: 'account',
                accountId: profile.id,
                username: profile.username,
                firstName: profile.firstName,
                lastName: profile.lastName,
                avatarUrl: profile.avatar?.url ?? null,
            })),
            nextCursor: page.nextCursor,
        };
    });
}

export async function resolveSessionAccessPrincipals(options: SessionAccessRequestOptions & Readonly<{
    subjects: readonly PrincipalRefV1[];
}>): Promise<readonly SessionAccessPrincipalSummaryV1[]> {
    const unique = [...new Map(options.subjects.map((subject) => [JSON.stringify(subject), subject])).values()];
    if (unique.length === 0) return [];
    const assertCurrent = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) throw new SessionAccessApiError('session_access_stale_scope');
    };
    return await runWithServerRequestAuthorityForServerAccountScope({ scope: options.scope,
        activeRequest: async () => { throw new SessionAccessApiError('session_access_stale_scope'); },
    }, async authority => {
        assertCurrent();
        const body = ResolveSessionAccessPrincipalsRequestV1Schema.parse({ v: 1, subjects: unique });
        const response = await authority.request('/v1/session-access/principals/resolve', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            ...(options.signal ? { signal: options.signal } : {}),
        });
        assertCurrent();
        if (!response.ok) throw createSessionAccessApiErrorFromResponse(await response.json().catch(() => null), response.status);
        const parsed = ResolveSessionAccessPrincipalsResponseV1Schema.parse(await response.json());
        const requested = new Set(unique.map((subject) => JSON.stringify(subject)));
        return parsed.principals.filter((principal) => {
            const ref = principal.kind === 'account' ? { kind: 'account', accountId: principal.accountId }
                : principal.kind === 'team' ? { kind: 'team', teamId: principal.teamId }
                    : { kind: 'group', teamId: principal.teamId, groupId: principal.groupId };
            return requested.has(JSON.stringify(ref));
        });
    });
}

/**
 * Resolve the one server-owned Team creation decision needed by a restored
 * New Session draft. This deliberately reuses the principal-resolution route
 * and its authorization/currentness owner; it is not a second Team policy API.
 */
export async function resolveSessionAccessCreationDecision(options: SessionAccessRequestOptions & Readonly<{
    teamId: string;
}>): Promise<SessionAccessCreationDecisionV1 | null> {
    const assertCurrent = () => {
        if (options.signal?.aborted || options.isCurrent?.() === false) throw new SessionAccessApiError('session_access_stale_scope');
    };
    return await runWithServerRequestAuthorityForServerAccountScope({ scope: options.scope,
        activeRequest: async () => { throw new SessionAccessApiError('session_access_stale_scope'); },
    }, async authority => {
        assertCurrent();
        const body = ResolveSessionAccessPrincipalsRequestV1Schema.parse({ v: 1, subjects: [], creationTeamId: options.teamId });
        const response = await authority.request('/v1/session-access/principals/resolve', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            ...(options.signal ? { signal: options.signal } : {}),
        });
        assertCurrent();
        if (!response.ok) throw createSessionAccessApiErrorFromResponse(await response.json().catch(() => null), response.status);
        const parsed = ResolveSessionAccessPrincipalsResponseV1Schema.parse(await response.json());
        return parsed.creationDecision ?? null;
    });
}
